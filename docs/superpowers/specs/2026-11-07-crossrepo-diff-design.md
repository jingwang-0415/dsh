# v1.1 跨仓库差异统计 · 设计文档

- 日期：2026-11-07
- 状态：需求已由用户确认（三条），设计决策由用户授权控制器定夺
- 前置：v1.0 已合并 main 并在 GitHub/Gitee 双仓实测通过

## 1. 需求（用户原文三条）

1. 从**源码层级**确定两个仓库之间的差异
2. 考虑每个代码仓**多分支**的情况
3. 支持**排除指定文件/文件夹**不对比，或**只对比特定文件夹**

背景事实：两仓 = GitHub `jingwang-0415/dsh` + Gitee `wj160415/dsh2`，同一项目双托管；提交历史将独立演化（SHA 不保证相同）。

## 2. 核心决策

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 源码级匹配算法 | `git log -p --no-merges --pretty=format:%H -- <pathspecs> | git patch-id --stable` 批量指纹，按 (mirror, branch) 一次进程算全分支 | patch-id 对补丁文本做归一化（行号/空白偏移不敏感），指纹相同 = 源码改动内容确定一致；单进程算千级提交 |
| 匹配语义 | 指纹精确相等 = "同一改动"；无模糊猜测 | 确定性内容匹配。已知边界如实呈现：merge 提交无指纹（天然排除）；冲突解决/上下文大漂移会漏配（界面提示"上下文漂移可能漏配"） |
| 分支配对 | 同名直接配对；未配对分支单独列出 | 用户已确认 |
| 路径过滤 | 请求级 include/exclude glob（gitignore 风格），编译为 git pathspec `:(glob)p` / `:(exclude,glob)p`；include 为空 = 全部路径减排除 | 在 git 层过滤，指纹只算相关源码；复用 v1.0 util/glob 语义 |
| 多仓调度 | app.ts 为 config.repos 每项各建一个 Scheduler（独立镜像/退避/锁）；SSE 载荷增加 repoId | 数据模型 repo_id 早已预留；v1.0 单仓是 UI/API 限制不是模型限制 |
| API 作用域 | /api/branches、/api/commits、/api/commits/:sha、/api/compare 增加可选 `repo` 参数（缺省 = 第一个仓库，向后兼容） | 渐进式多仓 |
| 跨仓对比入口 | `GET /api/crossrepo/compare?repoA&repoB&branchA&branchB&include=&exclude=`（include/exclude 逗号分隔多值） | 单端点聚合，前端一个视图 |

## 3. 跨仓对比算法

```
输入: repoA, repoB, branchA, branchB, include[], exclude[]
1. 校验: 两仓库均在配置中；branchA/B 在各自镜像中存在（否则 404 branch_not_found）
2. 指纹: 对 repoA 镜像跑 git log refs/heads/branchA -p --no-merges
     --pretty=format:%H -- <pathspecs> | git patch-id --stable
   → 行 "patchId sha"；repoB 同理（branchB）
3. 归并（纯函数 mergePatchMaps）:
   onlyInA  = A 中 patchId ∉ B指纹集 的提交（含元数据）
   onlyInB  = 对称
   matched  = 交集 → [{patchId, shaA, shaB, subject}] 按 patchId 排序
4. 提交元数据（subject/author/time）: git show -s --format='%H%x1f%an%x1f%ct%x1f%s' sha... 批量补齐
5. 响应:
   { branchPair: {repoA, branchA, repoB, branchB},
     onlyInA: CommitInfo[], onlyInB: CommitInfo[],
     matchedPairs: [{patchId, shaA, shaB, subjectA}],
     unpairedBranches: { repoA: [...], repoB: [...] },   // 两仓同名配对后各自落单的分支
     stats: { aTotal, bTotal, matched, onlyA, onlyB } }
```

- unpairedBranches 单独提供：`GET /api/crossrepo/branches?repoA&repoB` → `{ repoA: BranchRow[], repoB: BranchRow[], paired: [name...] }`（供前端分支下拉与"未配对"提示）

## 4. 多仓调度改造

- app.ts：`config.repos.map(repo => new Scheduler({...repo, mirrorDir: mirrorDirFor(repo.id), handlers: 带 repoId 的同款三事件}))`；SSE `commits.new`/`status.changed` 载荷加 `repoId`；`branches.updated` 加 `{ repoId }`
- close()：停止并关闭全部 scheduler
- /api/status：增加 `repo` 参数返回该仓的 scheduler 状态与 lastFetch（缺省第一个）
- 首轮回填/自气回填逻辑不变（每仓独立走 §5.4/§11）

## 5. 前端

- 新视图 `/crossrepo`（导航"跨仓对比"）：
  - 仓库 A/B 下拉（来自 /api/repos）、分支 A/B 下拉（来自 /api/crossrepo/branches，未配对分支标记）
  - 路径过滤输入（排除框 + 仅对比框，逗号分隔 glob）
  - 结果区：统计卡（A 独有/B 独有/已同步配对）+ 三组列表；matchedPairs 以灰色"疑似/源码一致"呈现并排显示 shaA↔shaB
- Overview：仓库下拉选择器（切仓库刷新全部数据），其余不变
- 样式复用既有 badge/rows 体系

## 6. 错误处理

- 未知 repo → 404 repo_not_found；分支不存在 → 404 branch_not_found；include/exclude 全被排除导致空 pathspec → 400
- patch-id 管道失败（如对象损坏）→ 503 语义从简：500 + {code:'git_error'}（v1.1 不实现 spec §8 的 503 改造，记 backlog）
- 空分支（无提交）→ 正常返回空集

## 7. 测试策略

- 单元：pathspec 构建器（include/exclude → git pathspec 参数数组）；mergePatchMaps 归并纯函数（交集/单向/空集）
- 集成（真实 git，不 mock）：
  - 两个独立 fixture 仓（各自 init，无共同祖先）：同一补丁分别应用到两仓 → SHA 不同、patch-id 相同 → matched 命中
  - A 仓多一个不同内容的补丁 → onlyInA；对称 onlyInB
  - include/exclude：改动位于排除目录 → 不进指纹；include 指定 src/ → 只算 src/
  - 多分支：A 仓有 main+dev、B 仓只有 main → unpairedBranches.repoA 含 dev
  - 多仓调度：两个 origin、两个 scheduler 各自检出各自事件带正确 repoId
- API：crossrepo/compare 契约（含 400 空 pathspec、404 repo/branch）；branches?repo= 作用域
- 前端：CrossRepo 视图组件测试（mock fetch：matched 灰色呈现、过滤输入传参）

## 8. 不做（v1.1 范围外）

- 跨仓 cherry-pick 自动执行；两仓历史合并（rewritten 检测跨仓语义）；跨仓 inclusion（"提交 X 是否在对方仓"在独立历史下无意义，由本对比替代）
- Overview 多仓聚合仪表盘（仅加仓库选择器）

## 9. 验收标准

1. 双独立历史仓：同补丁不同 SHA → matched 命中且并排展示 shaA↔shaB
2. 单向独有提交 → onlyInA/onlyInB 正确，计数与列表一致
3. exclude 掉的目录里的改动不出现在任何差异中
4. A 仓独有分支出现在 unpairedBranches 且不参与配对
5. 多仓调度：两仓各自的推送在 ≤各自 pollInterval+1s 内被对应实例（同一进程内两个 scheduler）检出，SSE 事件带正确 repoId
6. 真实双仓（GitHub dsh + Gitee dsh2）演示：用 15639d6（Gitee 独有）的补丁在 GitHub 侧重放 → matched 命中；GitHub 侧新改动 → onlyInA；exclude README.md 后差异列表相应收缩
