# 10 架构：数据流 · 不变量 · 生命周期（第三层）

> 上一层的全局图景见 [00-overview.md](00-overview.md)。本层回答"一轮轮询怎么走、哪些关系不能破坏、进程和子进程怎么生灭"。逐模块函数细节在 [20-modules-server.md](20-modules-server.md)。

## 数据流（一轮 fetch 的完整链路）

```
远端 origin（只读）
  │  ensureMirror / fetchMirror —— TransportOpts → spawn args(-c 代理) + env(GIT_CONFIG_*)
  ▼
repos/<id>/ 裸镜像                                    server/src/mirror.ts
  │  snapshotRefs（before / after 各一次，for-each-ref refs/heads）
  ▼
diffRefs → RawChange（added/updated/deleted）          server/src/refDiff.ts
  │  classifyChanges：updated 逐个 merge-base --is-ancestor
  ▼
RefChange（added/fast-forward/force-push/deleted）
  │  applyChanges：增量入库 / 首轮回填 backfillRepo     server/src/sync.ts
  ▼
SQLite monitor.db（commits / branches / fetch_events）
  │  handlers：onCommitsNew / onBranchesUpdated / onStatus   （server/src/app.ts 的 makeHandlers）
  ▼
SseHub.publish → /api/events 广播                      server/src/sse.ts
  ▼
web connectEvents 回调 → 视图 refresh()                web/src/api.ts + views
```

**首次运行与自愈是旁路**：`Scheduler.runOnce` 里 `branchCount()===0`（首跑，设计文档 §5.4）或 `mirrorState==='cloned'`（镜像损坏自愈重克隆，spec §11）时，不做 diff，直接以克隆后快照 `backfillRepo` 全量回填——`INSERT OR IGNORE` 幂等，且**不产生新提交事件**。

**读路径**（无调度器参与）：`api.ts` 各查询端点 → DB（branches/commits/fetch_events）或直接对镜像跑 git（`listCommits`/`aheadBehind`/`inclusionForCommit`/`compareBranches`）。`/api/commits` 列表取自**镜像侧 rev-list** 而非 DB，所以分页参数直接变成 git 参数——这是 limit/offset 严格校验与 ≤500 钳制的原因。

## 关键不变量（破坏任何一条都会静默腐化）

1. **repo 对象引用原位共享**：`app.ts` 装配把 `config.repos` 中的仓对象直接传给 `Scheduler({ repo })`，两侧是同一引用。PATCH 必须经 `config.ts` 的 `updateRepoFields`（Object.assign 只改字段）；任何 splice / 新对象整体替换都会让调度器继续持旧对象，运行时调整静默失效。
2. **传输三分支省键语义**（`mirror.ts` 的 `transportArgs` / `transportOptsEnv`）：
   - `httpProxy: undefined` = 跟随系统 git 配置——**不注入任何代理参数**，spawn 行为与未传时逐字节一致；
   - `httpProxy: ''` = 强制无代理（`-c http.proxy=` 空 -c 对）；非空 = 显式代理（http/https 两对 -c）。
   - `bypassGitConfig` → env `GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`（defensive 优先于 gitConfigPath）；`gitConfigPath` → 仅 `GIT_CONFIG_GLOBAL=<path>`；均未设 → env 覆盖对象为空，调用方按空判断不加 `env` 键。bypass 与 gitConfigPath 互斥：config schema refine 挡输入，PATCH 按生效态挡，mirror 层再 defensive。
3. **undefined 省键**：GET/POST/PATCH 返回行中未设的 `httpProxy`/`gitConfigPath` 直接省略（JSON 序列化行为）。前端读取一律 `?? false` / `'httpProxy' in r` 兜底（`web/src/views/Repos.vue` 的 `bypassOf`/`proxyOf`/`proxyModeOf`）。省键≠null：PATCH 里**键缺省=不改动**，`null`=显式 unset（JSON Merge Patch 风格，`config.ts` 的 `updateRepoFields`）。
4. **写序与回滚纪律**：内存 `config.repos` 变更 → `writeConfig`（tmp + renameSync 原子落盘）成功 → DB upsert → `addScheduler`。writeConfig 失败必须把内存精确回滚（POST pop、DELETE splice 回插、PATCH 快照 assign——快照用 **null 哨兵**记录"原值未设"，否则回滚无法区分"不动"与"还原为未设"）。
5. **repos 行是外键宿主**：`repos` 表行必须先于调度器首跑登记（`app.ts` 装配 upsert、`api.ts` POST upsert 同一句 `ON CONFLICT` 语句），否则首次回填因 FK 失败。DELETE 只摘调度与配置，**DB 历史有意保留**，同 id 重挂经 upsert 自动接续。
6. **至少一仓保底**：configSchema `repos.min(1)` 之外，DELETE 最后一个仓被运行时 409 `last_repo` 拦截——否则落盘 `repos:[]` 会让重启 `loadConfig` 崩溃。
7. **归因分级**：`refDiff.ts` 的 `classifyChange` 只把 `GitCommandError`（git 给出答案）判为 force-push 证据；spawn ENOENT / 超时等基础设施错误必须原样重抛，交由调度器按失败退避，不得静默吞成 force-push（历史归因污染）。
8. **互斥按"生效态"判定**：PATCH 的 bypass/gitConfigPath 互斥检查用 body 覆盖后的生效组合（存量值 × patch 值），不是只看 body 同时出现——对角场景（存量 bypass=true + 仅 PATCH path）漏判会让双真 config.json 落盘，重启即崩。
9. **url/id 是身份键**：镜像目录名 / 调度器标识 / `?repo=` 取值三方引用。PATCH 见到 `url`/`id` 键一票拒绝（`url_immutable`），换地址唯一途径是删除重加。

## 生命周期

**启动**（`server/src/index.ts` → `buildApp`）

1. env 解析 `GSM_CONFIG`/`GSM_DATA` → `loadConfig`（zod 校验失败即启动失败，消息含字段路径）。
2. `openDb`：建目录 → 打开 SQLite → WAL + foreign_keys → `migrate`（user_version 幂等）。
3. 每仓：repos 表 upsert（FK 宿主登记）+ `new Scheduler(...)` ——**只构造不 start**，由 index.ts 统一 `forEach start`（测试因此可手动 `runOnce` 控节奏）。
4. `registerApi` 挂载全部端点 → `web/dist` 存在则注册 @fastify/static + SPA fallback（`/api/` 前缀 404 返回 JSON，其余回 index.html）。
5. `app.listen`；SIGINT/SIGTERM 注册 → `close()`，close 失败以 exit(1) 退出（不得骗过进程管理器）。

**关闭**（`app.ts` 的 close，顺序不可换）

`schedulers.forEach(stop)`（清 timer）→ `sse.closeAll()`（**必须先于 app.close**：hijack 的 SSE 流对 Fastify 非 idle，不先销毁会永久悬挂）→ `await app.close()` → `db.close()`。

**调度循环**（`scheduler.ts`）

- `loop` → `runOnce`（`running` 标志互斥，重入返回 `skipped`）→ 成功则 delay = `pollIntervalSeconds*1000`，失败则 `nextBackoffMs`（5s 起 2 倍指数，封顶 5 分钟）→ setTimeout 自排程；每一步 stop 后早退，不再排程。
- 失败轮：错误消息匹配 `CORRUPT_RE`（corrupt / not a git repository）→ `rmSync` 整个镜像目录，下一轮自动重克隆自愈；`fetch_events` 记 failed + 退避计数 +1。
- PATCH 的 `pollIntervalSeconds` / 传输字段在**下一轮循环取 delay / 下一轮 fetch** 生效（每轮从共享 repo 对象直取）。

**git 子进程**（`gitRunner.ts`）

- `runGit` 默认超时 60s：SIGKILL 直接子进程 + **destroy 我方 stdout/stderr/stdin 管道端**——孙进程（如 git fetch → git remote-https）继承管道写端会让 `close` 事件永不触发，销毁我方流强制 settle。
- `pipeRunGit`（A.stdout → B.stdin，用于 `log -p | patch-id --stable`）默认超时 120s：错误归因先到先得；超时双 SIGKILL + 五流 destroy；end 所有权单一（A 正常 close(0) 后才 `b.stdin.end()`）。
- 输出统一 `Buffer.concat(chunks).toString('utf8')`——跨 chunk 的多字节 UTF-8 不损坏；错误 message 经 `sanitize` 脱敏内嵌凭据后才进日志/DB。

**SSE**（`sse.ts`）

- `add`：reply.hijack + 直写 SSE 头与 `retry: 3000`；`publish` 广播时跳过/摘除已销毁连接。
- **惰性心跳**：有客户端才起 25s `:ping` 定时器（`timer.unref()` 不阻退出）；最后一个客户端断开即停表，防反向代理掐空闲连接。
- 客户端摘除三路对称：close 事件 / error 事件 / publish 或心跳 sweep 中的 destroyed 与同步抛错，摘除后检查停表。
