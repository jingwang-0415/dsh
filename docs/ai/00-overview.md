# 00 概览（第二层）

> 入口在 [AGENTS.md](AGENTS.md)。本层建立全局图景：定位边界、技术栈、进程模型、目录树。数据流与生命周期在 [10-architecture.md](10-architecture.md)，模块细节在第四层，红线细则在第五层。

## 定位与边界

**做什么**

- 轮询监控任意 git 可达地址（ssh / https / 本地路径）：检出新提交、识别 fast-forward / force-push / 分支增删。
- 判定任意提交被哪些分支包含：未包含的活跃分支红色置顶，一键复制 `git cherry-pick <sha>`。
- 双分支对比（ahead/behind + 双向独有提交）；跨仓"同补丁"对比（`git patch-id --stable` 指纹，识别 cherry-pick 复制）。
- 仓库生命周期界面化管理：添加 / 删除 / 行内编辑 / 手动同步，免重启生效，实时回写 config.json。

**不做什么**

- 不写远端：只有 `clone --mirror` 与 `fetch --prune`，永不 push（见 10-architecture 不变量、30-conventions 红线）。
- 不消解 git 固有语义：cherry-pick / 变基后 SHA 不同会被如实判为"未包含"，不做猜测（README「已知语义」节）。
- 不做鉴权与多租户：默认监听 `127.0.0.1:43900`，定位为本机工具。

**持久化三处**（均在数据目录 `~/.git-sync-monitor/`，env `GSM_DATA` 可覆盖）

| 位置 | 内容 | 特点 |
|------|------|------|
| `config.json` | 仓配置唯一真源 | zod 校验；tmp + rename 原子回写（`config.ts` 的 `writeConfig`） |
| `monitor.db` | SQLite：repos / branches / commits / fetch_events | WAL；外键开启；v1 schema 由 `user_version` 迁移 |
| `repos/<id>/` | 每仓一个 bare 镜像 | 损坏可整目录删除，下一轮自动重克隆自愈 |

配置路径 env `GSM_CONFIG` 可覆盖（默认 `~/.git-sync-monitor/config.json`）。

## 技术栈

| 层 | 选型 | 约束备注 |
|----|------|----------|
| 运行时 | Node ≥22 | engines 固定；本仓 README 排障节有 Electron ABI 下的 better-sqlite3 编译配方 |
| 服务端 | Fastify 5 + zod 3 | 单进程；`logger: false`；SSE 用 reply.hijack 直写 |
| 数据库 | better-sqlite3 | 原生模块，必须与运行时 ABI 匹配 |
| git 交互 | `node:child_process` spawn | 无 shell；默认超时 60s（管道 120s）；git ≥2.32（`GIT_CONFIG_GLOBAL` env 支持，v1.5 `gitConfigPath` 依赖） |
| 前端 | Vue 3.5 + vue-router 4 | `<script setup>`；无全局状态库，SSE + 重拉取 |
| 构建 | Vite 6 / tsc strict | web 构建含 `vue-tsc --noEmit` 门 |
| 测试 | vitest 3 | server 集成测试用真实 git fixture |

## 进程模型

- **生产**：单个 Node 进程 = Fastify HTTP 服务（REST API + SSE `/api/events` + 托管 `web/dist` + SPA fallback），入口 `server/src/index.ts`，`buildApp`（`server/src/app.ts`）装配。
- **调度**：同进程内每仓一个 `Scheduler` 实例（`server/src/scheduler.ts`），setTimeout 链自排程循环，失败按指数退避重试；互斥由 `running` 标志保证。
- **数据库**：better-sqlite3 同步驱动，仅在 server 进程内访问。
- **开发**：`pnpm dev`（根 package.json）并发起 server（tsx watch）与 web（vite 5173）；vite 的 `/api` 代理指向 `http://127.0.0.1:43900`（`web/vite.config.ts`）。
- **git 子进程**：全部经 `server/src/gitRunner.ts` 的 `runGit` / `pipeRunGit` spawn，继承 process.env 并可按仓覆盖 env。

## 目录树

```
git-sync-monitor/
├── package.json              # 根脚本：dev/build/start/test（pnpm workspace 分发）
├── pnpm-workspace.yaml       # server + web 两包
├── scripts/make-fixture.sh   # 演示仓库生成器（README 快速开始用）
├── server/
│   ├── src/
│   │   ├── index.ts          # 进程入口：env→buildApp→start→listen→信号处理
│   │   ├── app.ts            # 装配：config/db/schedulers/sse/api/静态托管/close
│   │   ├── config.ts         # config.json schema + 读写 + 仓对象原位变更
│   │   ├── db.ts             # SQLite 打开/迁移（repos/branches/commits/fetch_events）
│   │   ├── scheduler.ts      # 每仓轮询循环：互斥/退避/回填/自愈
│   │   ├── mirror.ts         # 镜像克隆/拉取/引用快照 + 传输兜底（args/env 纯函数）
│   │   ├── gitRunner.ts      # spawn 执行 git：超时/脱敏/双进程管道
│   │   ├── refDiff.ts        # 引用快照 diff + fast-forward/force-push 归类
│   │   ├── parse.ts          # rev-list --format 输出解析（CommitInfo）
│   │   ├── sync.ts           # 变更落库 + 首次/自愈全量回填 + fetch_events
│   │   ├── analyzer.ts       # 包含判定 / ahead-behind / 分支对比
│   │   ├── patchid.ts        # 补丁指纹（log -p | patch-id）+ pathspec 构造
│   │   ├── crossrepo.ts      # 跨仓对比编排（指纹合并 + 元数据回填）
│   │   ├── api.ts            # 全部 REST 端点注册（含仓库生命周期/PATCH 白名单）
│   │   ├── sse.ts            # SSE hub：hijack/广播/惰性心跳/closeAll
│   │   ├── platform/types.ts # 平台适配器接口（nullAdapter 缺省）
│   │   └── util/glob.ts      # 分支排除 glob（* / **）编译
│   └── test/                 # 17 个 vitest 文件 + fixture.ts（真实 git fixture）
├── web/
│   ├── src/
│   │   ├── main.ts / App.vue / router.ts   # 装配 + 导航 + 五条路由
│   │   ├── api.ts            # DTO + fetch 封装 + SSE 连接 + 时间格式化
│   │   ├── style.css         # 全局视觉语言（横幅/徽标/行/按钮 + 深色模式）
│   │   └── views/            # Overview / Repos / Compare / CrossRepo / CommitDetail
│   └── test/                 # 5 个 vitest 文件（jsdom + @vue/test-utils）
└── docs/
    ├── ai/                   # 本文档集（五层渐进式披露）
    └── superpowers/          # 历代设计文档与实施计划（需求史/决策史）
```

## 测试布局

- server：`server/test/*.test.ts` 17 个文件 + 共享 `fixture.ts`（`createOriginRepo` 造真实 git 仓；`trackTmp`/`cleanupTracked` 临时目录；`withProxyEnvCleared` 代理 env 确定性）。
- web：`web/test/*.test.ts` 5 个文件，vitest jsdom 环境（`web/vite.config.ts` 配置）。
- 根 `pnpm test` = `pnpm -C server test && pnpm -C web test`。测试与文档的对应关系在第四层各模块"测试位置"给出。
