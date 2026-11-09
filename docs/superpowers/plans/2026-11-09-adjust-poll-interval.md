# v1.3.1 轮询间隔运行时可调 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 仓库管理视图（/repos）行内编辑仓库属性——轮询间隔（以及默认分支/排除 glob）运行时即时生效（下一轮询周期按新值跑），原子回写 config.json，URL 不可改（明示走"先加后删"）。

**Architecture:** `PATCH /api/repos/:id` 部分更新（三字段白名单）；**原位变更** config.repos 中该仓对象（Scheduler.deps.repo 持有同一引用，下一 loop 读取新值——引用语义即运行时生效机制，禁止整体替换对象）；原子回写 + DB repos 行同步；404/400/url_immutable 契约。

**Tech Stack:** 沿用 v1.3。

**Spec:** 本文档 §设计决策即需求与设计（用户 2026-11-09："轮询间隔我希望可以自由调整"，设计决策由授权定夺）。

## Global Constraints

沿 v1.3 全部约束；当前基线 server 100/100 + web 16/16 + typecheck/build 全绿；HEAD=main@cd33a10。

## File Structure

```
server/src/api.ts      [改] PATCH /api/repos/:id
server/src/config.ts   [改] 导出 updateRepoFields 助手（原位变更，供 api 复用并保证引用语义）
server/test/reposapi.test.ts [改/追加] PATCH 契约用例
web/src/api.ts         [改] api.updateRepo(id, patch)
web/src/views/Repos.vue [改] 行内编辑（编辑态切换/保存/取消）+ url 不可编辑明示
web/test/Repos.test.ts [改/追加] 编辑流用例
README.md              [改] 轮询间隔运行时可调说明
```

---

### Task 1: 后端 PATCH 端点（原位变更语义）

**Files:**
- Modify: `server/src/config.ts`、`server/src/api.ts`
- Test: `server/test/reposapi.test.ts`（追加）

**Interfaces:**
- Consumes: config.repos 数组（Scheduler.deps.repo 持同引用）、writeConfig、db upsert
- Produces:
  - `PATCH /api/repos/:id` body 仅允许 `{ pollIntervalSeconds?, defaultBranch?, branchExclude? }` 三键 → 200 返回更新后的 repo 四字段 + branchExclude；未知 id → 404 repo_not_found；body 含 `url` 或 `id` → 400 url_immutable（message:"url 不可修改，请删除后重新添加以更换地址"）；字段值非法（pollInterval <5 非整数等）→ 400 invalid；**空 body/无有效键 → 400 no_fields**
  - 语义：**原位变更** config.repos 中该对象（Object.assign 不可替换引用）——Scheduler.deps.repo 同引用，下一轮询周期按新 pollIntervalSeconds 调度；defaultBranch/branchExclude 下一 fetch 周期生效
  - 持久化：Object.assign 后 writeConfig 原子回写（失败 → 500 config_write_failed，内存保留新值并附警示注释？——裁定：写失败回滚内存（重新 assign 旧值）+ 500，保持与 POST/DELETE 相同的回滚纪律）
  - DB repos 行同步（default_branch/branchExclude UPDATE）
  - GET /api/repos 与 GET /api/crossrepo/* 天然反映新值（读 config/DB）

- [ ] **Step 1: 写失败测试（reposapi.test.ts 追加）**
  - PATCH 未知 id → 404 repo_not_found
  - PATCH body 含 url → 400 url_immutable（message 断言）
  - PATCH body 含 id → 400 url_immutable（同族）或 400 invalid——按实现二选一，断言与实现一致
  - PATCH 空 body → 400 no_fields
  - PATCH pollIntervalSeconds=0 → 400 invalid；PATCH pollIntervalSeconds="abc" → 400
  - PATCH 合法（pollIntervalSeconds=7, branchExclude=["tmp/**"]）→ 200 返回新值；config 文件 JSON 断言 pollIntervalSeconds===7 且 branchExclude===["tmp/**"] 且 url 未变；DB repos 行 default_branch/branchExclude 同步（readonly 断言）
  - **引用语义锁**：PATCH 后对同一仓再次 PATCH 不同合法值 → 仍 200（防"整体替换断引用"回归——若实现错误，第二次 PATCH 写的是 config 但 scheduler 读旧对象；本断言在文件/DB 层面锁行为，引用语义由实现注释+代码评审保证）
- [ ] **Step 2: RED**（PATCH 404 路由不存在）
- [ ] **Step 3: 实现**——config.ts 增 `export function updateRepoFields(repo: RepoConfig, patch: {pollIntervalSeconds?: number; defaultBranch?: string; branchExclude?: string[]}): void`（Object.assign 逐字段，仅赋提供的键，调用方先做值校验）；api.ts PATCH：resolveRepo → 404；body 键检查（url/id 出现 → 400 url_immutable；三键全无 → 400 no_fields）；逐字段值校验（pollIntervalSeconds Number.isInteger ≥5；defaultBranch 非空字符串；branchExclude 字符串数组）→ 400 invalid；snapshot 旧值 → updateRepoFields 原位变更 → db upsert（default_branch/branchExclude）→ try writeConfig catch → 回滚（updateRepoFields 旧值）+ 500 config_write_failed → 200 返回四字段+branchExclude
- [ ] **Step 4: 全绿**（server 100 + 新增 ≈7）
- [ ] **Step 5: 提交** `git add server && git commit -m "feat: PATCH /api/repos/:id 运行时调整轮询间隔与分支属性（原位变更即时生效）"`

---

### Task 2: 前端行内编辑

**Files:**
- Modify: `web/src/api.ts`、`web/src/views/Repos.vue`
- Test: `web/test/Repos.test.ts`（追加）

**Interfaces:**
- Produces:
  - `api.updateRepo(id, patch)` → PATCH（非 GET 通道复用 sendJson 错误处理）
  - Repos 视图每行"编辑"按钮 → 行进入编辑态（轮询间隔数字输入 + 默认分支文本 + 排除 glob 文本 + 保存/取消）；URL 列显示只读并有 title 提示"url 不可修改，更换地址请删除后重新添加"；保存成功 → 退出编辑态 + 刷新列表/状态；400 消息进错误横幅
  - 前端先行校验同后端（≥5 整数等）

- [ ] **Step 1: 写失败测试**——Repos.test.ts 追加：点编辑 → 出现编辑控件（URL 无输入框/只读标识）；保存触发 PATCH 且 URL 为 `/api/repos/<id>`、载荷仅含可编辑字段（无 url/id 键）；PATCH 400 → 横幅 message；取消 → 退出编辑态且无请求
- [ ] **Step 2: RED**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全绿**（web test 16+2-3、typecheck、build；server 无回归）
- [ ] **Step 5: 提交** `git add web && git commit -m "feat: 仓库管理视图行内编辑（轮询间隔等运行时调整）"`

---

### Task 3（控制器主导）: 真实端到端验收

- 重启实例（新构建）→ PATCH 轮询间隔 30→5 → 观察 fetch_events 间隔收缩（sqlite 时间戳实证运行时生效）→ PATCH 回 30 → /repos UI 截图说明 → 合并 main → 推双远端 → 收官报告

## 需求覆盖映射

| 用户诉求 | 任务 |
|---------|------|
| 轮询间隔自由调整 | T1（PATCH 原位变更即时生效）+ T2（行内编辑入口）|
