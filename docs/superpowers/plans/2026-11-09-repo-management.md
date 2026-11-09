# v1.3 仓库管理界面 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 界面上直接配置仓库：新增 /repos 管理视图（列表/添加/删除）+ 后端 POST/DELETE /api/repos（原子回写 config.json、免重启启动/停止监控）。

**Architecture:** config.json 仍是唯一真源（原子写 tmp+rename）；API 变更运行时生效（构建 Scheduler / stop+移除）；DB `repos` 行与历史保留（同 id 重挂自动接续，INSERT OR IGNORE 去重）。repo id 加字符集白名单（顺带消除 mirrorDir `../` 逃逸遗留）。

**Tech Stack:** 沿用（Fastify/zod/Vue 3/vue-tsc 门）。

**Spec:** 本文档 §1-§2 即需求与设计（用户 2026-11-09 提出"界面上提供仓库配置入口"，设计决策由用户授权控制器定夺）。

## Global Constraints

沿 v1.2 全部约束（TS strict、ESM .js、conventional commits、server 90/90 + web 12/12 + typecheck 门全绿基线）。⚠️ `pnpm add` 不可用→编辑 package.json + install。

## File Structure

```
server/src/config.ts     [改] repoSchema 导出 + id 正则白名单 + writeConfig 原子写
server/src/app.ts        [改] AppHandle 增 configPath；addScheduler/removeScheduler；handlers 抽取复用
server/src/api.ts        [改] POST /api/repos、DELETE /api/repos/:id（含校验/冲突/回写/生命周期）
server/src/scheduler.ts  [改] 暴露 repoId 只读访问器（供 removeScheduler 定位）
server/test/reposapi.test.ts [新] 生命周期契约（真实 fixture）
web/src/api.ts           [改] addRepo/removeRepo + RepoConfigDto
web/src/views/Repos.vue  [新] 仓库管理视图（列表/添加表单/删除确认/状态徽标）
web/src/router.ts / App.vue [改] /repos 路由与导航
web/src/views/Overview.vue   [改] "仓库管理"入口按钮
web/test/Repos.test.ts   [新] 组件测试（提交 POST 载荷/删除确认/列表刷新）
README.md                [改] 界面配置仓库用法
```

---

### Task 1: 后端仓库生命周期 API

**Files:**
- Modify: `server/src/config.ts`、`server/src/app.ts`、`server/src/api.ts`、`server/src/scheduler.ts`
- Test: `server/test/reposapi.test.ts`（新）、`server/test/config.test.ts`（追加 id 白名单用例）

**Interfaces:**
- Consumes: Scheduler（含 stop）、config loadConfig、db upsert
- Produces:
  - config.ts：`export const repoSchema`（id 规则 `^[A-Za-z0-9._-]+$` 消息"id 仅允许字母数字与 . _ -"）；`export function writeConfig(path: string, cfg: AppConfig): void`（tmp+renameSync 原子写，JSON.stringify(cfg,null,2)+'\n'）
  - `POST /api/repos` body={id,url,defaultBranch?,branchExclude?,pollIntervalSeconds?} → 201 返回 repo；400 invalid（zod 失败，message 透传）；409 repo_exists（id 冲突，含与 DB repos 表比对外的 config 比对即可）；写配置失败 → 500 config_write_failed（并回滚内存 config.repos.push）
  - `DELETE /api/repos/:id` → `{ok:true}`；未知 id → 404 repo_not_found；删除 = config.repos 移除 + writeConfig + scheduler.stop + 从数组移除（DB repos 行与历史**保留**，注释说明同 id 重挂接续语义）
  - AppHandle 增 `configPath: string`；api.ts 经 deps 获得调用 writeConfig 的路径

- [ ] **Step 1: 写失败测试 `server/test/reposapi.test.ts`**——自建 fixture/两仓 config → buildApp → 用例：POST 合法仓 → 201 且 /api/repos 含之且 schedulers 数 +1 且 /api/status?repo=新仓 可查且 config 文件被回写（读原路径 JSON 断言含新仓）；POST 重复 id → 409；POST 非法 id（含 `../`）→ 400 且消息含白名单文案；POST 非法 url（空）→ 400；DELETE 已知 → ok 且 /api/repos 不含且 schedulers 数 -1 且 config 文件已移除；DELETE 未知 → 404。GET /api/repos 契约不变。
- [ ] **Step 2: RED**（POST/DELETE 404 路由不存在）
- [ ] **Step 3: 实现**——config.ts（repoSchema 导出 + id 正则 + writeConfig）；scheduler.ts 增 `get repoId(): string`；app.ts：configPath 解析提前保存、addScheduler/removeScheduler（removeScheduler 按 repoId findIndex → stop → splice）、handlers 构造抽 `makeHandlers(repo)` 复用；api.ts POST/DELETE（POST body 用导出 repoSchema.safeParse；先查 config.repos id 冲突 409；push → try writeConfig catch → pop + 500；db upsert repos 行；addScheduler；201；DELETE：findIndex → splice → writeConfig（try/catch 回滚 splice+500）→ removeScheduler → ok）
- [ ] **Step 4: config.test.ts 追加** id 白名单用例（`../demo`、`a b` → 报错含"id 仅允许"）
- [ ] **Step 5: 全绿**（server 90 + 新增 ≈6 = 96）+ 提交 `git add server && git commit -m "feat: 仓库生命周期 API（POST/DELETE + 原子回写 + 免重启调度）"`

---

### Task 2: 前端仓库管理视图

**Files:**
- Modify: `web/src/api.ts`、`web/src/router.ts`、`web/src/App.vue`、`web/src/views/Overview.vue`、`README.md`
- Create: `web/src/views/Repos.vue`
- Test: `web/test/Repos.test.ts`（新）

**Interfaces:**
- Produces:
  - `api.addRepo(body)` → POST；`api.removeRepo(id)` → DELETE；`RepoConfigDto`
  - 路由 `/repos`（导航"仓库管理"）；Overview 顶部"仓库管理"入口
  - Repos 视图：仓库表（id/url/默认分支/轮询间隔/状态徽标/删除按钮带 confirm("确定停止监控并移除该仓库？历史数据将保留")）；添加表单（id/url 必填 + 默认分支/轮询/排除 glob 可选）+ 错误横幅 + 成功后刷新列表与状态
- [ ] **Step 1: 写失败组件测试**——mock fetch：POST 载荷断言（id/url/defaultBranch）；删除按钮触发 DELETE 且 window.confirm 被 stub 为 true；POST 409 → 横幅显示冲突文案；成功 → 列表刷新调用
- [ ] **Step 2: RED**
- [ ] **Step 3: 实现**——api.ts 类型与两函数；Repos.vue（表单校验前端先行：id 白名单同款正则、url 非空）；router/App/Overview 入口；README
- [ ] **Step 4: 全绿**（web test 12+2、typecheck、build；server 无回归）
- [ ] **Step 5: 提交** `git add web README.md && git commit -m "feat: 仓库管理视图（界面添加/删除仓库，免重启生效）"`

---

### Task 3（控制器主导）: 真实端到端验收

- 重启单实例（新构建）→ 界面添加第三仓（Gitee dsh2 或新 fixture 仓）→ 观察 10s 内自动检出 → 删除 → 确认停止且 /tmp 卫生
- `pnpm test` + 双构建全绿 → 合并 main → 推双远端 → 收官报告（含 v1.2/v1.3 裁定汇总）

## 需求覆盖映射

| 用户诉求 | 任务 |
|---------|------|
| 界面上提供仓库配置入口 | T2（/repos 视图 + Overview 入口） |
| 添加仓库免重启生效 | T1（Scheduler 运行时构建启动） |
| 删除仓库停止监控且历史保留 | T1（DB 保留语义） |
| 配置持久化（重启不丢） | T1（config.json 原子回写） |
