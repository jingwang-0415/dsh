# v1.3.2 传输兜底 + 深色模式对比度 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development (recommended) or executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** ① 按仓传输兜底：`bypassGitConfig`（绕过系统/全局 git 配置直连）与 `httpProxy`（显式代理覆盖/空串强制无代理），解决"内源代理劫持 git → clone 只达内网、GitHub HTTPS 可达"的场景；② 深色模式下按钮/输入控件对比度修复（当前 .btn 无暗色覆盖 → 浅底浅字不可读）。

**Architecture:** TransportOpts { bypassGitConfig?, httpProxy? } 由 repo 配置透传至 mirror 层：bypass → spawn env `GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null`（git 2.32+，本机 2.50）；httpProxy → args 前缀 `-c http.proxy=<v>` `-c https.proxy=<v>`（v 为空串即强制无代理）。PATCH/POST 白名单扩两字段（共享对象原位语义 → 运行时可调同 v1.3.1）。前端 Repos 表单/行内编辑加"传输"高级区。深色模式：style.css 暗色媒体块补齐交互控件显式配色。

**Tech Stack:** 沿用。

**Spec:** 需求源 = 用户 2026-11-09 两条消息（"git clone 不可达但网络可达需兜底" + 场景澄清"内源代理劫持 git，GitHub HTTPS 可达"；"深色模式按钮对比度低"）。设计决策由授权定夺：L1 传输回退与 L3 API 兜底顺延（本场景 L2 代理覆盖 + 配置绕过即解），记录于 backlog。

## Global Constraints

沿 v1.3.1 全部约束；基线 server 110/110 + web 20/20 + typecheck 门全绿；HEAD=feat/v1.3.2-transport@main 顶。

## File Structure

```
server/src/gitRunner.ts   [改] runGit opts 增 env?: Record<string,string>（合并 process.env）
server/src/mirror.ts      [改] TransportOpts 类型 + transportArgs 纯函数 + ensureMirror/fetchMirror 增 opts 参
server/src/config.ts      [改] repoSchema 增 bypassGitConfig/httpProxy（default false/''）
server/src/app.ts         [改] runOnce→mirror 调用透传 transport opts（scheduler deps.repo 原位共享→scheduler 读 repo 字段传入）
server/src/scheduler.ts   [改] runOnce 内 ensureMirror/fetchMirror 调用点透传（从 this.deps.repo 取）
server/src/api.ts         [改] PATCH 键白名单扩两字段；GET /api/repos 行增两字段
server/test/{mirror,patchid,config,reposapi}.test.ts [改/追加]
web/src/api.ts            [改] RepoConfigDto/RepoPatchDto 增两字段
web/src/views/Repos.vue   [改] 表单与行内编辑增"传输"高级区（直连 checkbox + 代理输入）；表格传输标记
web/src/style.css         [改] 暗色块补 .btn/select/input/badge 显式配色
web/test/Repos.test.ts    [改/追加] 传输字段透传断言
README.md                 [改] 传输兜底用法段
```

---

### Task 1: 后端传输兜底

**Files:**
- Modify: `server/src/gitRunner.ts`、`server/src/mirror.ts`、`server/src/config.ts`、`server/src/app.ts`、`server/src/scheduler.ts`、`server/src/api.ts`
- Test: `server/test/mirror.test.ts`（transportArgs 纯函数 + 功能集成）、`server/test/config.test.ts`、`server/test/reposapi.test.ts`（PATCH/POST/GET 往返）

**Interfaces:**
- Produces:
  - `runGit` opts 增 `env?: Record<string, string>`（spawn env = { ...process.env, ...env }）
  - `type TransportOpts = { bypassGitConfig?: boolean; httpProxy?: string }`
  - `transportArgs(opts: TransportOpts): string[]`——httpProxy 非空 → ['http.proxy='+v, 'https.proxy='+v] 形态的 `-c` 对（`['-c', 'http.proxy='+v, '-c', 'https.proxy='+v]`）；空串 → 同形态空值（强制无代理）；仅 bypass → []（bypass 走 env）
  - `ensureMirror(url, dir, transport?: TransportOpts)` / `fetchMirror(dir, transport?)`：bypass → spawn env GIT_CONFIG_GLOBAL=/dev/null + GIT_CONFIG_SYSTEM=/dev/null；httpProxy !== undefined → args 前缀 transportArgs；既有调用点不传 → 行为不变
  - repoSchema 增 `bypassGitConfig: z.boolean().default(false)`、`httpProxy: z.string().default('')`
  - PATCH 三键白名单扩为五键（+bypassGitConfig/httpProxy）；GET/POST/PATCH 行含两新字段
  - scheduler runOnce：`const t = { bypassGitConfig: this.deps.repo.bypassGitConfig, httpProxy: this.deps.repo.httpProxy }` 透传（原位共享对象 → PATCH 传输字段亦运行时生效）
  - 既有不传 transport 的调用点行为逐字节不变

- [ ] **Step 1: 写失败测试**
  - mirror.test：`transportArgs({httpProxy:'http://p:1'})` → `['-c','http.proxy=http://p:1','-c','https.proxy=http://p:1']`；`transportArgs({httpProxy:''})` → 空值形态；`transportArgs({})` → []；bypass 不产生 args
  - mirror.test 功能集成：fetchMirror(dir, {bypassGitConfig:true}) 真实跑通（fixture 远端）——证明 env 变换不破坏功能
  - reposapi.test：POST 带 bypassGitConfig:true + httpProxy:'/x' → GET 回显两字段；PATCH 仅改 httpProxy → GET 反映
  - config.test：默认值 false/'' 断言
- [ ] **Step 2: RED**
- [ ] **Step 3: 实现**（gitRunner env 合并；mirror TransportOpts/transportArgs/透传；config schema；app/scheduler/api 白名单与透传链——scheduler 从 this.deps.repo 直取两字段传入 ensure/fetch）
- [ ] **Step 4: 全绿**（server 110 + 新增 ≈7-8 = 117-118）
- [ ] **Step 5: 提交** `git add server && git commit -m "feat: 按仓传输兜底（bypassGitConfig 直连 / httpProxy 显式覆盖）"`

---

### Task 2: 前端传输设置 UI

**Files:**
- Modify: `web/src/api.ts`、`web/src/views/Repos.vue`
- Test: `web/test/Repos.test.ts`（追加）

**Interfaces:**
- Produces:
  - RepoConfigDto/RepoPatchDto 增 bypassGitConfig/httpProxy
  - 添加表单与行内编辑增"传输（高级）"区：直连 checkbox（绕过系统/全局 git 配置——适用于系统 git 配置了内源代理的场景）+ HTTP 代理输入（留空=跟随或直连视 checkbox；说明文案）
  - 表格加传输标记列（直连/代理标记，缺省显示"—"）
  - PATCH 载含两新键（与其他可编辑字段一致）

- [ ] **Step 1: 写失败测试**——表单提交载荷含 bypassGitConfig/httpProxy；行内编辑 PATCH 同；表格传输标记渲染
- [ ] **Step 2: RED**
- [ ] **Step 3: 实现**
- [ ] **Step 4: 全绿**（web test/typecheck/build；server 无回归）
- [ ] **Step 5: 提交** `git add web && git commit -m "feat: 仓库传输设置 UI（直连绕过/代理覆盖）"`

---

### Task 3: 深色模式对比度修复

**Files:**
- Modify: `web/src/style.css`
- Test: 无自动视觉测试（typecheck/build 回归）；视觉验收由用户切换系统外观确认

**Interfaces:**
- Produces: 深色媒体块内交互控件显式配色——`.btn`（背景 #21262d / 文字 #e6edf3 / 边框 #30363d / hover #30363d）、`.pick select` 与所有表单 input/textarea（背景 #0d1117 / 文字 #e6edf3 / 边框 #30363d）、`.badge` 系与 `.banner` 系核对（已自配色，仅需确认暗色下可读）；grep 全部类名确保无遗漏的"继承浅色文字落浅底"元素
- [ ] **Step 1: 审视 style.css 现状并列出所有"未在暗色块显式配色"的交互类**
- [ ] **Step 2: 扩展暗色媒体块**（.btn/.btn:hover/select/input/textarea + 必要的 .badge 调整）
- [ ] **Step 3: 回归**（web typecheck/test/build 全绿；server 无回归）
- [ ] **Step 4: 提交** `git add web/src/style.css && git commit -m "fix: 深色模式交互控件显式配色（按钮/输入对比度）"`

---

### Task 5（控制器主导）: 真实双仓验收 + 合并

- 重启统一实例（新构建）→ 验证：双仓调度正常、dsh-github 设 bypassGitConfig=true 后 fetch 正常（直连 GitHub 实证不破坏）、PATCH 传输字段运行时生效、SSE 心跳不受影响、深色模式样式交付（用户视觉确认）
- `pnpm test` 全绿 → 合并 main → 推双远端 → 收官报告

## 需求覆盖映射

| 用户诉求 | 任务 |
|---------|------|
| git clone 不可达（内源代理劫持）但网络可达的兜底 | T1（后端 bypass/proxy 传输层）+ T2（UI 入口）|
| 深色模式按钮对比度低无法看清 | T3 |

---

### 追加需求（2026-11-09 用户）：手动同步按钮

**Interfaces:**
- Produces:
  - `POST /api/repos/:id/sync` → 触发该仓 scheduler.runOnce()（互斥安全：自动轮询在飞时 `{skipped:true}`）；始终 200，载荷 `{ok: boolean, skipped?: boolean, newCommits?: number, error?: string}`
  - Overview：状态条旁/每仓行"立即同步"按钮 → POST → 结果横幅（"手动同步完成：检出 N 个新提交"/"已有同步在进行中"/"同步失败：<err>"）+ refresh()
- 实现：api.ts 端点（resolveRepo → schedulers 按 repoId 定位 → await runOnce）；前端 Overview 按钮
- 验收：真实仓上手动触发检出；自动轮询在飞时按钮返回 skipped 且不炸
