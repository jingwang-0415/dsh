# v1.1 Backlog 与携带项（v1.0 合并时固化）

- 日期：2026-11-07
- 来源：最终全分支审查 triage + 12 个任务 gate 的 deferred minors
- 说明：本文件替代已删除的 SDD 工作区 ledger，作为下一批工作的输入

## v1.1 主线：跨仓库差异统计（已确认需求）

- 两个仓库对应同一个项目：GitHub `jingwang-0415/dsh` + Gitee `wj160415/dsh2`
- 两仓提交历史**独立**（SHA 对不上）→ 需 **patch-id 补丁指纹**匹配，产物是"疑似同一改动"语义（灰色标注），非确证
- 分支对应：**同名直接配对**（main↔main）
- 核心视图：跨仓库对比——同名分支的双向独有提交数/列表 + patch-id 疑似配对统计
- 需要多仓库 UI（v1.0 仅服务 repos[0]；数据模型 repo_id 已预留）
- merge 提交无补丁指纹、冲突解决差异会导致漏配——界面语义必须如实
- 已知 demo 脚本：两仓同历史起步 → 制造双向受控分叉 → 验证识别

## 修复批（carry，优先级从高到低）

1. classifyChange 仅 exitCode===1 判"非祖先"，基础设施故障（超时/ENOENT）应传播为失败（refDiff.ts:30-32 现把一切归为 force-push → 误标 rewritten 且漏收提交，下轮无 diff 不纠正）
2. SSE 心跳：加 25s comment ping 防中间层空闲超时（retry: 3000 已有，浏览器自动重连兜底）
3. /api/commits limit 加上限封顶（如 500，防 limit=100000 重查询）
4. 损坏窗口期上游删分支：重克隆回填路径对"DB 有 vs 快照有"做差集补 markBranchDeleted（现永久 active+陈旧 head）
5. spec §8 两处偏差回写：503 {code,message} 未落地；`since` 参数被 offset 分页替代（另：路由为 /api/commits?branch= 而非 /api/branches/:name/commits，已有文档）
6. gitRunner GitCommandError/超时消息对 args 做凭证脱敏（url 内嵌 token 会进 fetch_events 并上 UI）
7. /api/branches 串行 spawn 算 behindDefault（100 分支秒级）+ recentCommits 无索引——接真实大仓后观察，必要时并行化/加索引
8. 测试卫生：mkdtemp 统一清理钩子；api.test compare 用例与 inclusion 用例的声明顺序耦合；smoke close try/finally；analyzer.test 死代码
9. scheduler stop→start 双 timer 链（需 epoch 令牌；现状仅节奏抖动）；start() 不幂等
10. handler 抛错丢该轮事件（提交已入库、下轮 diff 空不补发）——设计如此，文档化

## 已裁决不变的语义（防止未来误"修"）

- cherry-pick ≠ 包含（SHA 祖先判定），如如实标注；patch-id 疑似匹配是 v1.1 的增强不是修正
- first_seen_at 24h 红徽标随时间过期，不依赖已读状态
- behindDefault = defaultBranch 独有提交数（analyzer base 视角），api.ts:69 取 .ahead 正确

## v1.1 执行后新增 carry（最终 scoped 审查裁定）

- vue-tsc 类型门（v1.2 第一件事；StatusChangedEvent 失真、api.test 旧形状 SSE fixture 均因无门无人察觉）
- Compare 视图 repo 作用域成套接通 + Overview 徽标跳转带 repo + 跨仓行 CommitDetail 直链（detail API 需 repo 作用域先行）——v1.2 成套做
- showCommits 分批（ARG_MAX）+ git log -p 补丁文本流式化（大仓化）
- SSE 心跳 25s comment ping；spec §8 503/since 回写
- multirepo.test publish.mockRestore 移入 afterEach（当前为文件末位测试无泄漏面）

## v1.1 裁定存档（摘要）

- patch-id 空匹配=合法空集；同秒 SHA 碰撞先例贯穿 v1.1 三处测试；include 行为测试与 HTTP→引擎缝断言 uplift 合并前必修（已完成）；matchedPairs 排序回写 spec（时间倒序）；文档字面三处回写随修复批落地

---

# v1.2 收官附录（2026-11-09，main@fcb0feb）

## v1.3 池（最终 scoped 审查裁定，按优先级）

1. **classifyChange exitCode 区分**（v1.3 首位，两个周期 carry 已够）：refDiff.ts 把基础设施故障（超时/ENOENT）归为 force-push，且 force-push 路径不插入提交 → 这些提交在 head 再次前进前永久漏报
2. /api/commits limit 上限 clamp（一行）
3. gitRunner 凭证脱敏（url 内嵌 token 会进 fetch_events/UI，两行）
4. sse.ts publish/sweep 尾部补 stopHeartbeatIfIdle（两行，闭环心跳停表）
5. RouterLink 改对象式 `:to`（顺带补 api.test toContain 子串弱断言）；Compare 切仓 requestId 时序守卫；SHOW_BATCH 导出；afterAll try/finally；vue-tsc 门翻出的 branches.updated fixture 补齐
6. spec §8 503/since 回写

## 流程备注（下批修正）

- task-brief 预生成漏了两次（T2/T4）——派发步骤加"简报生成"固定动作
- review-package 的"squash 包含"表述与多提交历史不符——打包脚本注明实际提交数
- 需求映射表应显式处置未决的 v1.0 carry（勿静默滚存）

## 已解决标注

- ✅ "Compare 视图 repo 作用域成套接通"——v1.2-T1 已解决（合并时验证：Compare 下拉/作用域调用/查询持久化/徽标带 repo/跨仓直链/CommitDetail 读 ?repo= 全部落地并受测试锁定）
- ✅ 测试临时目录卫生——v1.2-T4 trackTmp/cleanupTracked 全覆盖（53/53 调用点，零残留探针通过）
- ✅ SSE 心跳——v1.2-T4 惰性 25s（真实实例 31s 探针实测 1 次）
