# 20 服务端模块逐个（第四层 · server/src）

> 不变量与生命周期背景在 [10-architecture.md](10-architecture.md)；本文只讲模块本身。引用一律"文件 + 函数名"。测试位置给出文件与用例名（用 `grep` 定位）。每个模块末尾是"改这里之前先看什么"。

## 模块总览与依赖方向

```
index.ts → app.ts → { config.ts, db.ts, scheduler.ts, sse.ts, api.ts, platform/types.ts }
scheduler.ts → { mirror.ts, refDiff.ts, sync.ts, config.ts }
mirror.ts / sync.ts / analyzer.ts / crossrepo.ts / refDiff.ts → gitRunner.ts
crossrepo.ts → patchid.ts；sync.ts → parse.ts；config.ts → util/glob.ts
```

依赖规则：git 执行一律收敛到 `gitRunner.ts`；DB 写入一律收敛到 `sync.ts` / `api.ts` 的显式 SQL；配置语义唯一裁决在 `config.ts`。

---

## index.ts（进程入口，21 行）

- **职责**：env 解析（`GSM_CONFIG`/`GSM_DATA`，缺省 `~/.git-sync-monitor/`）→ `buildApp` → `schedulers.forEach(start)` → `app.listen` → SIGINT/SIGTERM 优雅退出。
- **关键契约**：close 失败必须 `process.exit(1)`——以 0 退出会骗过进程管理器（文件头注释即此教训）。
- **测试位置**：`server/test/smoke.test.ts`（ping 冒烟）；退出语义无直测，靠 `graceful-shutdown.test.ts` 覆盖 close 本体。
- **改前先看**：`app.ts` 的 close 顺序注释；不要在这里加业务逻辑，它是唯一允许顶层 await 的文件。

## app.ts（装配根，AppHandle）

- **职责**：`buildApp(options)` 组装 config/db/schedulers/sse/api/静态托管，返回 `AppHandle{ app, config, configPath, schedulers, sse, close }`。`AppOptions.adapter` 注入平台适配器（缺省 `nullAdapter`），`configOverride` 供测试注入内存配置。
- **关键函数**：`buildApp`；`makeHandlers`（三类 SSE 事件：`commits.new` 带 repoId/branch/count/subjects、`branches.updated`、`status.changed`）；`addScheduler`（API 挂新仓：构造+入列+一次 start）；`removeScheduler`（按 `repoId` stop+出列，幂等）；`close`。
- **契约要点**：装配循环里每仓先 repos 表 upsert（FK 宿主登记，`ON CONFLICT` 更新 url/default_branch、保留 created_at）再构造 Scheduler；启动期只构造不 start（index 统一 start，测试手动 runOnce）；web/dist 存在才静态托管 + SPA fallback（`/api/` 404 JSON，其余回 index.html）。
- **测试位置**：`server/test/api.test.ts`（'buildApp 幂等登记 repos：同 id 改 URL 走 upsert 且 created_at 保留'）；`server/test/graceful-shutdown.test.ts`（SSE 存在时 close 3s 内完成）；`server/test/multirepo.test.ts`（SSE 三事件 repoId 契约）。
- **改前先看**：close 的顺序注释（sse.closeAll 必须先于 app.close）；upsert 语句与 `api.ts` POST 保持同形。

## config.ts（配置唯一裁决）

- **职责**：repoSchema/configSchema（zod）、`loadConfig`、`writeConfig`（原子回写）、`isBranchExcluded`、`updateRepoFields`（原位变更）。
- **关键函数/常量**：`MAX_POLL_INTERVAL_SECONDS = 604800`（7 天上界；>2^31-1ms 的 setTimeout 被 Node 钳成 1ms 会变成紧循环打爆远端）；`repoSchema`（id 白名单 `^[A-Za-z0-9._-]+$` + '.'/'..' refine 防镜像目录逃逸；defaultBranch 默认 master；pollIntervalSeconds 默认 30；bypassGitConfig 默认 false；httpProxy/gitConfigPath optional）+ schema 级 refine（双设互斥，消息含"互斥"）；`writeConfig`（同目录 tmp + renameSync，失败清理 tmp 不掩盖原错误）；`updateRepoFields`（Object.assign 字段级赋值；`httpProxy: null`/`gitConfigPath: null` = delete 显式 unset；不校验值——调用方负责）。
- **契约要点**：未设 = undefined 省键；'.'/'..' 能过正则但会令 `mirrorDirFor('..')` 指向数据目录本身被 rmSync 清空，必须在 schema 封死。
- **测试位置**：`server/test/config.test.ts`（默认值/白名单/'..' refine/604801 超界/三分支缺省/双设互斥）；`server/test/util` 无——glob 在 config.test 的 isBranchExcluded 用例覆盖。
- **改前先看**：文件头与 repoSchema 各字段的行内注释（每条约束都写明历史事故）；`api.ts` PATCH 的值校验必须与本 schema 同阈值。

## db.ts（SQLite 打开与迁移）

- **职责**：`openDb(dbPath)`——建目录、WAL、foreign_keys ON、`migrate`（user_version 幂等创建 SCHEMA_V1 四表）。
- **契约要点**：`branches` UNIQUE(repo_id,name)、`commits` UNIQUE(repo_id,sha) 是幂等入库的根基；repos 行是 branches/commits/fetch_events 的 FK 宿主。
- **测试位置**：`server/test/db.test.ts`（建表/唯一约束/重开幂等）。
- **改前先看**：schema 变更必须走新版本 migrate 分支（user_version 递增），禁止改 SCHEMA_V1 原文。

## scheduler.ts（每仓轮询循环）

- **职责**：`Scheduler` 类——自排程 loop、`runOnce` 一轮 fetch、互斥、退避、回填、损坏自愈、状态上报。
- **关键函数/类型**：`nextBackoffMs`（5s 起 2 倍指数封顶 300s）；`SchedulerStatus`（starting/running/idle/backoff + lastRunAt/nextRunAt/consecutiveFailures/lastError/lastNewCommits）；`runOnce`（`running` 互斥 → `startFetchEvent` → **每轮从共享 repo 对象直取** `{bypassGitConfig, httpProxy, gitConfigPath}` → ensureMirror → snapshotRefs before → fetchMirror → after → 三路分支：首跑回填 / 重克隆自愈回填 / diff+classify+apply → `finishFetchEvent('ok')`；catch：CORRUPT_RE 匹配则 rmSync 镜像目录自愈、fetch_events 记 failed、退避计数+1；finally 释放互斥）；`backfillFromSnapshot`（过滤 excluded 后 `backfillRepo`）；`repoId` getter（API 定位用，不外泄可变 deps）。
- **契约要点**：stop 后 loop 早退不排程；onStatus 回调抛错不得变成 unhandledRejection 也不得影响已排程 timer（loop 内 try/catch 包裹）；重克隆后 before===after，diff 恒空，必须回填补齐损坏窗口缺口（spec §11）。
- **测试位置**：`server/test/scheduler.test.ts`（首跑回填无事件 / 增量+onCommitsNew / 退避+fetch_events=failed / 自愈重克隆 / 损坏窗口补齐 / 重入 skip / stop 早退 / onStatus 抛错不 reject）；`server/test/multirepo.test.ts`（每仓各自检出）。
- **改前先看**：`runOnce` 的 transport 直取注释（PATCH 下一周期生效语义）；`refDiff.ts` 的 classifyChange 归因分级——scheduler 的 catch 依赖"基础设施错误会重抛"这一前提。

## mirror.ts（镜像与传输兜底）

- **职责**：克隆/拉取裸镜像、引用快照、TransportOpts → spawn args/env 的纯函数映射。
- **关键函数/类型**：`TransportOpts`；`transportArgs`（httpProxy undefined→[]；''→空 -c 对；非空→http/https 两对 -c）；`transportOptsEnv`（bypass→`{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null'}`，defensive 优先；否则 gitConfigPath→仅 `GIT_CONFIG_GLOBAL=<path>`；均未设→`{}`）；`ensureMirror`（目录存在即复用，否则 `clone --mirror`）；`fetchMirror`（`fetch --prune origin`）；`snapshotRefs`（`for-each-ref refs/heads --format=%(refname:short)%09%(objectname)` → `{branch: sha}`）。
- **契约要点**：bypass 走 env 而非 args——git 无法用 -c 关闭"读取配置文件"本身，/dev/null 是官方等价手法；env 覆盖按 `{...process.env, ...env}` 合并（PATH 必须继承）；两个纯函数存在的原因就是让 env/args 三分支可独立断言。bypass 的凭据副作用：credential.helper 一并失效（文件头注释）。
- **测试位置**：`server/test/mirror.test.ts`（克隆复用/快照/transportArgs 两例/transportOptsEnv 三例/真实劫持探针：全局代理劫持下 bypass 与 httpProxy '' 直连成功、gitConfigPath 覆盖劫持、存量配置不变性=无 -c 无 env 键、spawn 透传 env 断言）。
- **改前先看**：`transportOptsEnv` 的三分支注释与"存量仓行为逐字节不变"红线——任何改动都要保住"均未设→不加 env 键"。

## gitRunner.ts（git 执行底座）

- **职责**：spawn git 的唯一通道：`runGit` 单进程、`pipeRunGit` 双进程管道、`sanitize` 凭证脱敏、`GitCommandError`。
- **关键契约**：spawn 参数数组、无 shell；env 覆盖合并不整体替换；timeout 默认 60s/120s——**SIGKILL + destroy 我方管道端**（孙进程持管道写端会让 `close` 永不触发，Promise 不 settle → fetch_events 永久 running、互斥卡死）；输出 `Buffer.concat(chunks).toString('utf8')`（分块多字节 UTF-8 安全）；`GitCommandError` message 双处脱敏（args+stderr），`.stderr` 字段保持原样；超时路径的 plain Error 同样脱敏；pipeRunGit 的 settle 幂等 + 错误归因先到先得 + end 所有权单一（A close(0) 后 `b.stdin.end()`）。
- **测试位置**：`server/test/gitRunner.test.ts`（超时 kill / 超时消息脱敏 / 孙进程持管道 settle / 大体积多字节跨 chunk / 凭据脱敏 / 双进程管道七例：直连、A/B 非 0、双 kill、孙进程、spawn 失败不悬挂）。
- **改前先看**：runGit 超时回调与 pipeRunGit 的 `destroyPipes` 注释（线上事故的修复点）；任何新的 spawn 都必须复用本模块，不得绕开。

## refDiff.ts（引用 diff 与归类）

- **职责**：`diffRefs(before, after)` 纯函数产出 RawChange（added/updated/deleted）；`classifyChange`/`classifyChanges` 把 updated 经 `merge-base --is-ancestor` 归类为 fast-forward 或 force-push。
- **关键契约**：归因分级——`GitCommandError`（退出码 1=非祖先、128=镜像缺对象瞬态，语义等价）才算"git 给出答案"归 force-push；spawn ENOENT/超时等 plain Error **必须重抛**（scheduler 靠它走退避，不得静默吞成 force-push）。
- **测试位置**：`server/test/refDiff.test.ts`（diffRefs 四例 / fast-forward / force-push / 镜像目录不存在 rejects 不误标）。
- **改前先看**：classifyChange 的 catch 注释；改动 diff 语义会连带 `scheduler.ts` 三路分支与 `sync.ts` applyChanges。

## parse.ts（rev-list 输出解析）

- **职责**：`REVLIST_FORMAT`（`--format=%H%x1f%an%x1f%ae%x1f%ct%x1f%s%x1f%b%x1e` 记录分隔）与 `parseRevList` → `CommitInfo[]`。
- **关键契约**：`rev-list --format` 每条记录先输出 `commit <sha>` 头行（`git log` 无此行为），**必须剥离**；支持两种布局（头行同行走 \x1f 分隔、sha 单独一行兼容布局）；body 可能含换行，用 `\n` 拼回再 split 保证完整。
- **测试位置**：`server/test/parse.test.ts`（\x1f/\x1e 解析 / 空输出）；真实输出比对在 `server/test/sync.test.ts`（'listCommits 解析真实 rev-list 输出并与 git 真值一致'）。
- **改前先看**：parseRevList 内两条布局分支的注释——头行剥离缺失会让所有提交的 sha/字段整体错位。

## sync.ts（变更落库）

- **职责**：`listCommits`（rev-list + REVLIST_FORMAT，maxCount/skip）、`insertCommits`（INSERT OR IGNORE + 事务，返回**实际新插入**列表）、`upsertBranch`、`markBranchDeleted`、`backfillRepo`（全量回填）、`applyChanges`（四类 RefChange 分派）、`startFetchEvent`/`finishFetchEvent`。
- **关键契约**：fast-forward 用 `oldSha..newSha` 增量 rev-list；added 用 newSha 全量；force-push 只 UPDATE branches（head_sha/rewritten_at）不拉提交历史；deleted 置 status='deleted' 不删行。insertCommits 的返回值（新插入子集）是 onCommitsNew 事件载荷的来源。
- **测试位置**：`server/test/sync.test.ts`（回填建行 / 增量只插新提交 / force-push 标记 rewritten / maxCount-skip 幂等 / 真值比对）。
- **改前先看**：`INSERT OR IGNORE` + UNIQUE(repo_id,sha) 的幂等前提；applyChanges 的分派顺序与 scheduler 的事件触发对应关系。

## analyzer.ts（包含判定与对比）

- **职责**：`inclusionForCommit`（`branch --contains <sha> --format=%(refname:short)` + 集合比对）、`aheadBehind`（`rev-list --left-right --count refs/heads/<base>...refs/heads/<target>`，ahead=base 独有）、`compareBranches`（Promise.all 三命令并集）。
- **契约要点**：分支名一律 `refs/heads/` 前缀单 argv（防 glob/option 注入，也保证全名匹配）；语义边界=SHA 祖先关系，cherry-pick 不同 SHA 判"未包含"是 git 固有语义。
- **测试位置**：`server/test/analyzer.test.ts`（合并传播 vs cherry-pick 未包含 / 未知 sha GitCommandError / ahead-behind 方向）。
- **改前先看**：同秒 cherry-pick 会产生字节相同对象（analyzer.test 头部注释的 --date 修法）；`api.ts` 的 inclusion 端点排序契约（未包含在前）。

## patchid.ts（补丁指纹）

- **职责**：`buildPathspecs`（include→`:(glob)`、exclude→`:(exclude,glob)`）、`parsePatchIds`（"patchId sha" 行解析，lastIndexOf 空格）、`branchFingerprints`（`log refs/heads/<branch> -p --no-merges --pretty=format:%H <pathspecs>` 经 `pipeRunGit` 直连 `patch-id --stable`）。
- **契约要点**：流式管道让补丁文本不整段驻留内存（大仓化）；merge 提交不参与指纹；上下文大漂移可能漏配，如实呈现不猜测。
- **测试位置**：`server/test/patchid.test.ts`（解析 / pathspec / 同补丁跨仓指纹相同 / include-exclude 过滤 / 流式与两段式等价性回归锁）。
- **改前先看**：`branchFingerprints` 的注释与 pipeRunGit 生命周期裁定（end 所有权/归因/超时）。

## crossrepo.ts（跨仓对比编排）

- **职责**：`mergePatchMaps`（纯函数：patchId 交集/单向）、`parseShow`、`showCommits`（`show -s --format=%H%x1f%an%x1f%ct%x1f%s` 按 `SHOW_BATCH=200` 分批，规避 ARG_MAX）、`crossCompare`（双仓指纹 → 合并 → 元数据回填）。
- **契约要点**：stats 字段（aTotal/bTotal/matched/onlyA/onlyB）与 `api.ts` 响应行直接对应；matchedPairs 的 subject 取 A 侧。
- **测试位置**：`server/test/crossrepo.test.ts`（mergePatchMaps / 真实双仓命中 / exclude 过滤 / 201 个 sha 跨批边界不丢不重）。
- **改前先看**：SHOW_BATCH 注释；分批语义改动需连带 `api.ts` 的 crossrepo compare 端点。

## api.ts（REST 端点全集）

- **职责**：`registerApi(app, deps)` 挂载全部端点；仓库生命周期；PATCH 白名单与回滚；错误码契约。
- **端点清单**：GET `/api/status`（?repo= 作用域，缺省第一仓）；GET `/api/repos`（8 字段行，未设省键）；POST `/api/repos`（`repoSchema.safeParse` → 400 invalid → gitConfigPath `existsSync` 400 `git_config_not_found` → 409 `repo_exists` → push + `writeConfig` → DB upsert → `addScheduler` → 201）；DELETE `/api/repos/:id`（最后一仓 409 `last_repo`；写失败 splice 回插回滚；DB 历史保留）；PATCH `/api/repos/:id`（url/id 拒 `url_immutable`；逐字段校验；`httpProxy`/`gitConfigPath` 支持 null；空 patch 400 `no_fields`；**生效态互斥** 400 `mutually_exclusive`；gitConfigPath 存在性校验；**null 哨兵快照回滚**；成功后 DB default_branch upsert）；POST `/api/repos/:id/sync`（始终 200，结果经载荷：skipped/error/newCommits）；GET `/api/branches`（head 提交 join + behindDefault 失败降级 null + 24h recentCommits）；GET `/api/commits`（branch 必填；limit/offset 整数校验 + **钳制 ≤500**；镜像侧 rev-list）；GET `/api/commits/:sha`（DB + adapter.enrichCommit → meta）；GET `/api/commits/:sha/inclusion`（未包含在前排序）；GET `/api/compare`；GET `/api/events`（SSE）；GET `/api/crossrepo/branches`（active 配对）；GET `/api/crossrepo/compare`。
- **错误码族**：invalid / no_fields / url_immutable / mutually_exclusive / git_config_not_found / repo_exists(409) / last_repo(409) / repo_not_found / branch_not_found / commit_not_found / bad_request / config_write_failed / not_found（SPA fallback）。
- **测试位置**：`server/test/api.test.ts`（查询端点+limit 防线+装配幂等）；`server/test/reposapi.test.ts`（生命周期/PATCH 全契约/回滚锁/互斥三场景/null unset/手动同步四例）；`server/test/multirepo.test.ts`（repo 作用域 404）。
- **改前先看**：PATCH 端点头部的原位变更注释与 `config.ts` 的 `updateRepoFields`；写序红线（writeConfig→DB→addScheduler）；新增字段要同时进 GET 行映射、POST 白名单（safeParse 自动收）、PATCH 校验/白名单/回滚快照/返回行——五处缺一即漂移。

## sse.ts（SSE hub）

- **职责**：`createSseHub()` 返回 `SseHub{ add, publish, clientCount, closeAll }`。
- **关键契约**：add 用 `reply.hijack()` 直写头与 `retry: 3000`；首帧写失败不纳入广播集；**惰性心跳** 25s（首客户端加入才起表，`unref()` 不阻退出；最后一个客户端断开/摘除即停表）；publish 对 destroyed 跳过摘除、同步抛错摘除；error 事件摘除（无 listener 的 ERR_STREAM_DESTROYED/EPIPE 会升级成 uncaughtException 杀进程）；closeAll 同步 destroy 全部——hijack 流对 Fastify 非 idle，不先销毁 app.close 永久悬挂。
- **测试位置**：`server/test/sse.test.ts`（广播/destroyed/同步抛错/error 清理/closeAll/心跳起停五例）；`server/test/graceful-shutdown.test.ts`（SSE 存在时 close 完成）。
- **改前先看**：三条"停表闭环"路径必须对称（close/error/sweep）；任何新的清理分支都要接 `stopHeartbeatIfIdle`。

## platform/types.ts（平台适配器扩展点）

- **职责**：`PlatformAdapter`（可选 `enrichCommit(sha)` / `subscribe(onEvent)`）与 `nullAdapter` 空实现；`app.ts` 的 `AppOptions.adapter` 注入，`api.ts` 的 `/api/commits/:sha` 用 enrichCommit 产 meta。
- **测试位置**：`server/test/api.test.ts`（'GET /api/commits/:sha 返回详情与空 meta'——nullAdapter 下 meta 为空对象）。
- **改前先看**：保持接口可选方法（能力探测），不要让 nullAdapter 之外的平台实现进入核心路径。

## util/glob.ts（排除 glob）

- **职责**：`globToRegExp`（正则元字符转义；`**`→`.*`、`*`→`[^/]*`）与 `matchesGlob`；被 `config.ts` 的 `isBranchExcluded` 用于 branchExclude 过滤。
- **测试位置**：`server/test/config.test.ts`（'支持 * 与 ** glob'）。
- **改前先看**：语义保持"整串锚定"（^...$）；改动会同时影响调度器过滤与回填过滤两处调用点。
