# 30 约束红线与已知坑（第五层 · 全集）

> 前四层的红线速查只有名字，本层是唯一细则源：每条含语义、代码依据（文件 + 函数名）、违反后果。评审流程与工程史教训也在本层。

## 一、红线全集

### R1 spawn 参数数组，禁 shell
- **语义**：所有 git 调用经 `server/src/gitRunner.ts` 的 `runGit`/`pipeRunGit`，`spawn(bin, args)` 参数数组；分支名/SHA/路径一律作为独立 argv。
- **依据**：gitRunner.ts 两个函数体；测试 `server/test/gitRunner.test.ts`。
- **后果**：shell 拼接会把分支名里的 glob/分号解释为命令；且 git 自身的 pathspec 语义会被 shell 引号搅乱。

### R2 对远端只读
- **语义**：与远端的全部交互是 `clone --mirror`（`mirror.ts` 的 `ensureMirror`）和 `fetch --prune origin`（`fetchMirror`）。永不 push、永不在远端建引用。
- **后果**：监控工具写远端即事故。本地镜像目录可以整删（自愈），远端不行。

### R3 fixture 不 mock git 语义
- **语义**：集成测试用 `server/test/fixture.ts` 的 `createOriginRepo` 造**真实 git 仓**，spawn 真实 git 断言真实行为（如劫持探针直接改全局配置验证 bypass 生效）。mock git 会让"分支语义/配置覆盖"这类被测物本身失真。
- **依据**：fixture.ts；`mirror.test.ts` 的真实劫持用例族；`patchid.test.ts` 的流式等价性回归锁。
- **边界**：单元测试对**纯函数**（transportArgs/transportOptsEnv/diffRefs/parseRevList/mergePatchMaps）直接断言，无需 git；web 测试 mock 的是 **fetch 层**（api.ts 契约），不是 git。

### R4 同秒 SHA 碰撞——fixture 必须区分提交
- **语义**：同一秒内、作者/时间戳/内容/信息全同的提交对象**字节级相同 → SHA 相同**。两个独立 init 的仓的首提交、同秒 amend 无变更、同秒 cherry-pick 到原父提交，都会产生"看起来该不同却相同"的 SHA。
- **修法（先例）**：给每仓补一个不同内容的提交（`server/test/patchid.test.ts`、`crossrepo.test.ts`、`reposapi.test.ts` 注释"同秒碰撞规避"）；amend 用 `--date` 固定作者日期改变对象字节（`server/test/refDiff.test.ts`、`sync.test.ts`、`analyzer.test.ts` 的"固定 author 日期"注释）。
- **后果**：SHA 不变 → "历史重写未发生"/"cherry-pick 产生了新 sha"的前提崩塌，测试假绿或假红。

### R5 传输三分支与互斥语义
- **语义**（`mirror.ts` 的 `transportArgs`/`transportOptsEnv`）：
  - `httpProxy: undefined` = 跟随系统 git 配置，**不注入任何参数**（存量仓行为逐字节不变）；`''` = 强制无代理（http/https 两对空值 -c，压过全局配置与 env 代理）；非空 = 显式代理（http+https 两对 -c）。组合优先级：`-c http.proxy` 的显式值/空串均压过 `GIT_CONFIG_GLOBAL` 档案内 proxy——命令行优先级高于全局档案。三者不可混用：`default('')` 曾被明确否决——会让存量仓升级即静默断连。
  - `bypassGitConfig` → env `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`；`gitConfigPath` → 仅 `GIT_CONFIG_GLOBAL=<path>`（机器级配置保留）；bypass **defensive 优先**（schema refine 已禁双设，mirror 层仍以防万一）。
  - 互斥在三层拦：`config.ts` repoSchema refine（启动 + POST 400 invalid）、`api.ts` PATCH 生效态判定（400 mutually_exclusive）、mirror 层 defensive。前端 `Repos.vue` 的 `transportFields` 补先行拦截。
- **警示**：`httpProxy: ''` 是"静默强制无代理"——误解即断连（README 传输兜底节有显式警示）。`gitConfigPath` 空串被 repoSchema `min(1)` 拒（400 invalid，空串收口——不落 api 层 `existsSync('')` 的空路径文案），不存在"空路径=清除"语义；清除用 `null`。
- **凭据面副作用**：bypass 清空全局/系统配置 → credential.helper 一并失效，私有 https 仓需令牌内嵌 URL 或匿名可达（mirror.ts 头注释）。

### R6 PATCH 原位变更，禁整体替换
- **语义**：`config.repos[i]` 与 `Scheduler.deps.repo` 是同一对象引用（`app.ts` 装配）。PATCH 必须经 `config.ts` 的 `updateRepoFields`（Object.assign 字段级）；splice/新对象替换后调度器仍持旧对象，运行时调整**静默失效**。
- **依据**：config.ts 的 updateRepoFields 头注释；`server/test/reposapi.test.ts`（'PATCH 合法 → … config.repos 中仍是原对象（原位变更锁）'、'引用语义锁'）。
- **回滚也必须原位**：PATCH 失败回滚用快照 `updateRepoFields(repo, snapshot)`，快照中 `httpProxy`/`gitConfigPath` 用 **null 哨兵**表示"原值未设"——直接存 undefined 无法区分"不动"与"还原为未设"（`api.ts` PATCH 的 snapshot 注释）。

### R7 写序：writeConfig 先于 DB upsert，失败回滚内存
- **语义**：三个变更端点的共同纪律——先改内存 `config.repos` → `writeConfig`（tmp+renameSync 原子，`config.ts`）成功 → DB upsert → 调度器增删。writeConfig 抛错：POST `pop()` 回滚、DELETE splice 回插、PATCH 快照 assign；统一 500 `config_write_failed`，内存与磁盘保持一致。
- **依据**：`api.ts` 的 POST/DELETE/PATCH 三个端点；`reposapi.test.ts` 的回滚锁用例。
- **顺序含义**：DB upsert 放在写盘成功之后，保证"磁盘已持久"才动外键宿主行与调度器。

### R8 rev-list --format 头行剥离
- **语义**：`rev-list --format=...` 每条记录先输出 `commit <sha>` 头行（`git log` 无此行为）。`parse.ts` 的 `parseRevList` 先剥头行再按 \x1f 拆字段，并兼容"sha 单独一行"布局；body 含换行时用 `\n` 拼回保证完整。
- **后果**：漏剥离 → 所有提交 sha/字段整体错位一格。

### R9 Buffer 拼接解码（分块 UTF-8）
- **语义**：子进程输出按 chunk 收集 Buffer，最终 `Buffer.concat(chunks).toString('utf8')`（`gitRunner.ts`）。禁止在 data 事件里直接 `chunk.toString()` 累加字符串。
- **依据**：`server/test/gitRunner.test.ts`（'大体积多字节输出跨 chunk 边界不损坏'）。
- **后果**：多字节字符跨 chunk 边界被截断成 U+FFFD，中文 subject 乱码。

### R10 超时销毁流，防孙进程持管道挂起
- **语义**：`runGit` 超时：SIGKILL 直接子进程 + destroy 我方 stdout/stderr/stdin；`pipeRunGit` 超时：双 SIGKILL + 五流 destroy（`destroyPipes`）。**只 kill 直接子进程不够**：孙进程（git fetch → git remote-https）继承管道写端，Node 的 `close` 事件要等所有持 fd 者退出才触发 → Promise 永不 settle → fetch_events 永久 running、调度器互斥锁卡死、后续轮询全 skipped。
- **依据**：gitRunner.ts 超时回调注释（"fix round 2 线上实证"）；`gitRunner.test.ts` 两个"孙进程持管道也必须 settle"用例。
- **附带**：错误 message 一律过 `sanitize`（内嵌凭据 `***@`）才进日志/DB（fetch_events.last_error 是持久化传播面）；pipeRunGit 的 settle 幂等、错误归因先到先得、end 所有权单一（A close(0) 后 `b.stdin.end()`）。

### R11 undefined 省键 / null unset / 键缺省不改动
- **语义**：optional 字段（httpProxy/gitConfigPath）未设 = GET/POST/PATCH 响应行**省键**；PATCH **键缺省 = 不改动**；PATCH **null = 显式 unset**（JSON Merge Patch 风格，`config.ts` 的 `updateRepoFields` delete 分支）。三者语义互异，缺一不可。
- **依据**：`reposapi.test.ts`（httpProxy null unset、gitConfigPath null unset、'键缺省不复活旧值'）；前端读侧兜底 `Repos.vue` 的 `proxyOf`/`proxyModeOf`（`'httpProxy' in r`）。
- **后果**：把省键当 null（或反之）会让"跟随系统"与"强制无代理"互相窜态。

### R12 分支名 refs/heads/ 前缀、单 argv
- **语义**：任何把分支名拼进 git 参数的地方都以 `refs/heads/<branch>` **单个 argv** 传递（`analyzer.ts` 的 `aheadBehind`/`compareBranches`、`patchid.ts` 的 `branchFingerprints`、`api.ts` 的 commits 端点 range、`sync.ts` 的 `oldSha..newSha` range 也是单 argv）。不拆散、不经 shell、不带通配。
- **后果**：分支名含 `*`、`..`、`-` 开头字符时，拆散或拼接会被 git 解释成 glob/选项/extra args。

### R13 gitConfigPath 存在性校验（创建/变更时点）
- **语义**：POST/PATCH 提供字符串路径时 `existsSync` 校验，不存在 → 400 `git_config_not_found`（`api.ts`）。运行中被删不拦——由 git 报错如实呈现（fetch_events 可见）。config 层不做 IO。
- **后果**：放行不存在路径 = 每轮 fetch 以无效 GIT_CONFIG_GLOBAL 运行，兜底静默失效。

### R14 引用纪律（文档与注释）
- 引用代码一律"文件 + 函数名"，禁用行号（随演进失真）。文档分层不越级重复（AGENTS.md 红线只有名字，细则在本层）。

## 二、已知坑（工程史教训，全部真实发生过）

### P1 同秒 SHA 碰撞
见 R4。测试写作时的固定动作：新 fixture 先确认"每个需要不同的对象都字节可区分"。

### P2 分块 UTF-8 / 孙进程管道
见 R9/R10。两者的共同教训：Node 子进程的 `close` 语义 = exit + **全部 stdio 关闭**；任何"只 kill 进程"的清理都不完整。

### P3 proxy env 遮蔽
- **语义**：runGit/mirror 系用例 spawn 真实 git 且继承本进程 env——导出 `http_proxy`/`HTTPS_PROXY` 且 `no_proxy` 未豁免目标主机时，git 走代理转发，黑洞超时/劫持用例的预期路径被改写（快速失败为 GitCommandError，复现不了超时）。
- **修法**：`server/test/fixture.ts` 的 `withProxyEnvCleared`（保存→清空→执行→原样恢复，原本未设的键不留痕）。
- **依据**：fixture.ts 头注释；`gitRunner.test.ts`/`mirror.test.ts` 超时与劫持用例的套用。

### P4 setTimeout 2^31-1 钳制
- **语义**：Node 把 >2^31-1ms 的 setTimeout 钳为 1ms——`pollIntervalSeconds ≥ 2,147,484` 秒会让调度器变成"每轮 fetch 完立刻 1ms 重排"的连续循环打爆远端。上界 604800（7 天）在 `config.ts` 的 `MAX_POLL_INTERVAL_SECONDS`，repoSchema 与 `api.ts` PATCH 共享同阈值，前端 `Repos.vue` 的 `validateEdit` 同值拦截。

### P5 hijack SSE 与优雅退出
- **语义**：`reply.hijack()` 的 SSE 连接对 Fastify **非 idle**，`app.close()` 只清 idle 连接 → 永久悬挂。必须先 `sse.closeAll()` 同步销毁（`app.ts` 的 close 顺序）。心跳定时器 `unref()` + 三路停表闭环（`sse.ts`）保证不阻退出、不空转。
- **依据**：`server/test/graceful-shutdown.test.ts`；`sse.test.ts` 心跳起停族。

### P6 镜像目录逃逸（'.' / '..'）
- **语义**：id 白名单正则会放行 `.` 与 `..`，而 `mirrorDirFor('..') = dataDir` 本身——ensureMirror 见目录存在报 corrupt → rmSync 递归强删 = **清掉整个数据目录**。在 `config.ts` repoSchema 用 refine 显式拒绝（`config.test.ts`、`reposapi.test.ts` 各有"数据目录原封不动"用例）。

### P7 NaN 绕过 --max-count
- **语义**：`/api/commits` 的 limit/offset 直接变成 git argv（镜像侧 rev-list）。非整数 limit 若放行，`--max-count NaN` 被 git 忽略 → 整分支全量 rev-list 反复打满 CPU。`api.ts` 前置整数校验（400）+ 1..500 钳制（200）。同理 `crossrepo.ts` 的 `SHOW_BATCH=200` 分批防 ARG_MAX。

### P8 better-sqlite3 原生模块 ABI
- **语义**：Electron 运行时（ABI 149）无预编译包，需源码编译；Xcode CLT 残缺 libc++ 需 CXX wrapper 指向 SDK；DSH 打包的 pnpm 缺 node-gyp 需 `pnpm dlx` 指路。**完整三步配方在 README「环境要求与排障」节**，换机/升级后照抄即可。另：本机 `pnpm add` 有 bug——改依赖直接编辑 package.json 后 `pnpm install`。

### P9 PATCH 生效态互斥（对角场景）
- **语义**：只查 PATCH body 的双设会漏"存量 bypass=true + 仅 PATCH path"对角场景；放行则双真 config.json 落盘，重启 `loadConfig` 直接崩溃。`api.ts` PATCH 用 body 覆盖后的生效组合判定（`reposapi.test.ts` 互斥三场景）。

### P10 前端 DTO 滞后于服务端字段（当前态）
- **语义**：v1.5 服务端已回显 `gitConfigPath`，但 `web/src/api.ts` 的 `RepoDto`/`RepoConfigDto`/`RepoPatchDto` 尚未含该字段，UI 未展示（Task 1 有意收窄契约：DTO/前端后续任务同步）。改造前端传输区时先把三处 DTO 补齐，再复用 `transportFields` 模式（互斥联动：bypass checkbox 与 gitConfigPath 输入互斥）。

## 三、评审流程（gate → scoped review → fix round）

1. **Gate**：每个任务完成即跑 `pnpm test` + `pnpm build`（web 构建含 vue-tsc 门）；server/web 全绿才允许提交。测试先行的证据链：RED（新用例按特性缺失失败）→ 实现 → GREEN，报告中附两态输出。
2. **Scoped review**：控制者在 `.superpowers/sdd/<iteration>/` 留存 diff（`review-<a>..<b>.diff`），审查者只看本次变更范围（scope 外问题记 backlog 不当场改）。历史上两类高发回归：契约注释与实现漂移（注释写 A 代码做 B）、边界值（'.'/'..'、limit=0/abc、604800、同秒碰撞）。
3. **Fix round**：审查发现的问题在同一迭代内修复并补回归锁测试（问题 → 测试 → 修复，不允许"只修不加锁"）。工程史先例：v1.3.2 fix round 1 定稿三分支语义（transportArgs 抽纯函数），fix round 2 修复孙进程持管道挂起（runGit/pipeRunGit destroy 流）。fix 的注释必须在代码原地写明"线上实证"与后果（本文件多条红线即来自 fix round 注释）。
4. **回滚纪律**：审查拒收的值不得落内存（400 先于任何状态变更）；写失败必须精确回滚（R6/R7）。

## 四、收尾检查单（改完代码自问）

- [ ] 新 spawn 走 gitRunner？参数数组？超时与流销毁语义保持？
- [ ] 远端只读未被破坏？
- [ ] 新测试用了真实 git fixture？同秒对象已区分？代理 env 已清（withProxyEnvCleared）？
- [ ] optional 字段三态（省键/null/缺省）语义保持？响应行与 GET/POST/PATCH 五处同步？
- [ ] config 变更走 writeConfig→DB 写序？回滚路径精确？
- [ ] PATCH 仍是原位变更？互斥按生效态判定？
- [ ] `pnpm test` + `pnpm build` 全绿？
