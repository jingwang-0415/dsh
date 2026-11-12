# 21 前端模块逐个（第四层 · web/src）

> 服务端契约的完整版在 [20-modules-server.md](20-modules-server.md)；前端只是契约的消费方——DTO 形状、错误码、SSE 载荷以 server 为准。引用一律"文件 + 函数名"。

## api.ts（DTO + fetch 封装，前端唯一网络层）

- **职责**：全部 REST 调用、DTO 类型、SSE 连接、时间格式化。视图不直接 fetch。
- **关键函数/类型**：
  - `getJson` / `sendJson`：非 2xx 时抛 `Error(payload.message ?? payload.code ?? HTTP 状态)`——message 优先、code 兜底的统一错误通道，视图横幅直接展示该 message。
  - `withRepo`：repo 作用域查询串拼装（已带 query 时用 `&` 续接），与 server 的 `resolveRepo` 缺省第一仓语义一致。
  - `api` 对象：`status` / `repos` / `branches` / `branchCommits` / `commitInclusion` / `compare` / `crossBranches` / `crossCompare` / `addRepo` / `removeRepo`（id 进路径，`encodeURIComponent` 纪律）/ `updateRepo` / `syncRepo`。
  - DTO：`RepoDto`（GET 行：`bypassGitConfig?`/`httpProxy?` optional——未设省键，读侧必须兜底；**注意 v1.5 的 `gitConfigPath` 尚未加入前端 DTO**，后端已回显、前端未展示，属已知待办）；`RepoConfigDto`（POST 体）；`RepoPatchDto`（PATCH 白名单键，`httpProxy?: string | null` 四值语义：键缺省=不改动 / null=显式 unset / ''=强制无代理 / 非空=显式代理）；`SyncResultDto`（手动同步：ok/skipped/newCommits/error/message）；`StatusDto` / `BranchRow` / `CommitRow` / `CompareDto` / `CrossBranchesDto` / `CrossCompareDto`。
  - SSE：`connectEvents(handlers)` 绑定 `commits.new` / `branches.updated` / `status.changed` 三类事件；`StatusChangedEvent` 是 StatusDto 的 Pick + repoId（无 mirrorDir/lastFetch——推送不含镜像路径）。
  - `formatRelative` / `formatFuture`：相对时间分级（对偶：过去/未来）。
- **测试位置**：`web/test/api.test.ts`（时间分级 / repo 拼装 / syncRepo 载荷与错误通道 / SSE 映射）。
- **改前先看**：`server/src/api.ts` 对应端点的错误码族与响应形状；改 DTO 必须两侧同动（形状漂移由 typecheck 门兜住一部分，语义漂移兜不住）。

## router.ts + App.vue + main.ts（骨架）

- `routes`：`/`→Overview、`/commit/:sha`→CommitDetail、`/compare`、`/crossrepo`、`/repos`（`createAppRouter`，history 模式）。
- `App.vue`：nav 四链接 + RouterView；`main.ts`：createApp + router + `style.css`。
- 生产模式 SPA fallback 由 server 提供（`app.ts` 的 notFoundHandler），前端无需处理 404 路由。
- **改前先看**：新增路由时同步 App.vue 导航与 server SPA fallback（无需改，但要知道它存在）。

## 视图通用约定

- **URL 即状态**：仓/分支/对比目标等选择都回写 query（`router.replace`），刷新可复现；分支/仓为空时键不落 URL（避免 `branchA=&branchB=` 空参形态，CrossRepo 的 `syncQuery` 注释）。
- **SSE 合并非整体替换**：Overview 只认当前仓的 status 推送，且合并进现有 status（直接替换会抹掉 mirrorDir/lastFetch，横幅判断失效）。
- **前端先行校验 + 服务端唯一裁决**：视图按 server 同阈值先拦必败请求（id 白名单、'.'/'..'、间隔 5–604800），但 400/409/500 的 message/code 原样上横幅。

## views/Overview.vue（总览）

- **职责**：仓下拉 + 监听状态横幅 + 立即同步按钮 + 分支表（默认徽标/历史重写徽标/落后默认分支黄色按钮→对比页/24h 新提交红色计数）+ 已删除分支折叠区。
- **关键函数**：`refresh`（status+branches+repos 三拉）；`bannerClass`/`bannerText`（backoff→黄、lastFetch failed→红）；`onSyncNow`（POST sync；**在飞切仓守卫**：发起前捕获 targetRepo，横幅落笔前比对——旧仓迟到结果不落新仓语境）；`onRepoChange`（回写 query + 清横幅 + refresh）。
- **测试位置**：`web/test/Overview.test.ts`（同步按钮各态：检出绿横幅+refresh、请求期 disabled 防连点、skipped 灰横幅、ok:false 红、网络错红、零检出灰，及在飞切仓守卫不回写）。
- **改前先看**：onStatus 合并注释与切仓守卫注释——两者都是线上行为修正，别"简化"掉。

## views/Repos.vue（仓库管理）

- **职责**：添加表单、列表（调度状态徽标 + 传输四态列）、行内编辑（一次一行）、删除确认。
- **关键函数**：
  - `transportFields(bypass, mode, proxyRaw, target)`——**三态载荷构造核心**：custom→`httpProxy:<值>`；none→`httpProxy:''`；system 态按目标分——PATCH→`httpProxy:null`（显式 unset，省键承载不了"还原跟随系统"）、POST→省键；`bypassGitConfig` 恒带 boolean（与代理三态正交）。POST 与 PATCH 共用此函数。
  - 读侧兜底 `bypassOf`/`proxyOf`/`proxyModeOf`：省键→system、''→none、非空→custom；表格传输列四态（直连/代理/无代理/—）与编辑预填共用。
  - `validate`/`validateEdit`：id 白名单与 '.'/'..' 拦截、url 非空、间隔 5–604800（`MAX_POLL_INTERVAL_SECONDS` 常量与 server 同值——防 setTimeout 钳 1ms 紧循环）。
  - `startEdit`/`onSave`/`onRemove`：url/id 编辑态只读展示（身份键不可改）；失败留在编辑态；删除经 `window.confirm`。
- **测试位置**：`web/test/Repos.test.ts`（添加/删除/409 横幅/先行校验/行内编辑/PATCH 400 留编辑态/间隔上下界/网络连接方式三态载荷与四态展示十余例）。
- **改前先看**：`transportFields` 的注释（PATCH system 态为什么必须发 null）；gitConfigPath 若入 UI，须与 bypass checkbox 互斥联动（server refine/PATCH 生效态互斥已在，前端补先行拦截）。

## views/Compare.vue（分支对比）

- **职责**：仓/基准/目标三下拉 + ahead/behind 摘要 + 双向独有提交列表。
- **关键函数**：`loadBranches`（分支下拉随仓联动，base/target 缺省取前两个 active 分支）；`syncQuery` + `watch([base, target])`；`onRepoChange`（清空分支名再联动——旧分支名不适用新仓）。
- **测试位置**：间接覆盖于 `web/test/api.test.ts`（compare 拼参）；视图行为无专测（重组件薄逻辑）。
- **改前先看**：ahead/behind 方向语义在 `server/src/analyzer.ts` 的 `aheadBehind`——base 独有=ahead，勿在前后端各造一份解释。

## views/CrossRepo.vue（跨仓对比）

- **职责**：双仓双分支 + include/exclude glob 输入 + 同补丁配对/双向独有分区。
- **关键函数**：`options(side)`（本侧全部分支，**未配对标注并禁选**——避免必然 404 的对比请求）；`loadBranches`（paired[0] 优先派生默认分支）；`syncQuery`（空分支键不落 URL）；`onRepoChange`（先派生新默认分支再回写 URL）；RouterLink 用**对象式 `:to`**（query 交 vue-router 统一编码——串拼接会被 repo id 中保留字符劈开）。
- **测试位置**：`web/test/CrossRepo.test.ts`（matched 展示 / 参数携带 / 对象式 :to 编码 / 切仓 URL 回写两例）。
- **改前先看**：server 契约 `crossrepo.ts` 的 stats 与 unpaired 语义；"同补丁"的边界（merge 不参与、上下文漂移漏配）如实呈现原则。

## views/CommitDetail.vue（提交详情）

- **职责**：提交头（subject/author/body）+ 三分区：未包含（红，置顶，复制 cherry-pick）/ 已包含（绿）/ 已删除/异常折叠区。
- **关键函数**：`missing`/`present`/`other` computed（按 contains × status 划分）；`copyCherryPick`（剪贴板 + 1.5s 已复制提示）；repo 作用域经 `?repo=` 透传。
- **测试位置**：`web/test/CommitDetail.test.ts`（三分区 / 复制命令 / repo query 透传）。
- **改前先看**：'未包含'语义边界（README 已知语义节 + `analyzer.ts`）——不要尝试在前端"修正"cherry-pick 误报。

## style.css（样式体系）

- **职责**：全局视觉语言：横幅四色（`banner-green/yellow/red/gray`）、徽标五色（`badge-*`）、行三态（`row-miss/ok/other`）、`.btn`/`.tbl`/`.pick`/`.cols` 等。
- **关键约定**：深色模式用 `@media (prefers-color-scheme: dark)` 集中覆盖；视图局部新控件用 **scoped 样式就近补齐**（Repos.vue/CrossRepo.vue 尾部先例），并显式补深色配色（防"浅底继承浅字"不可读——v1.3.2 修复的同类问题）。
- **改前先看**：类名语义已被多视图复用（横幅/徽标），改全局类前 grep 全部使用点。
