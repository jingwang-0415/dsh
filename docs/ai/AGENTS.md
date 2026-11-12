# AGENTS.md — git-sync-monitor AI 协作入口（第一层）

> 一句话定位：对本机可达的 git 仓库做**只读镜像轮询**，实时监控多分支差异（新提交 / fast-forward / force-push / 分支增删）、判定任意提交被哪些分支包含，经 Fastify(REST+SSE)+Vue3 界面呈现，并支持双分支与跨仓"同补丁"对比。

## 一键命令

```bash
pnpm setup                 # 体检+装配（doctor/setup 已落地：pnpm setup 一键、pnpm doctor 单独体检；手动分步保留为兜底，见 README「快速开始」）
pnpm install               # 依赖安装（better-sqlite3 需源码编译，排障见 README「环境要求与排障」节）
pnpm dev                   # 开发：web 5173（/api 代理）+ server 43900
pnpm test                  # server + web 全部 vitest（真实 git fixture，不 mock git 语义）
pnpm build && pnpm start   # 生产：server 43900 同时托管 web/dist
```

配置文件：`~/.git-sync-monitor/config.json`（env `GSM_CONFIG` / `GSM_DATA` 可覆盖）。

## 文档地图（渐进式披露：读到够用即止，勿越层背诵）

| 层 | 文档 | 回答什么问题 |
|----|------|--------------|
| 1 | 本文 | 这是什么、怎么跑、红线叫什么名字 |
| 2 | [00-overview.md](00-overview.md) | 定位与边界、技术栈、进程模型、目录树、测试布局 |
| 3 | [10-architecture.md](10-architecture.md) | 一轮轮询的数据流、关键不变量、进程与 git 子进程生命周期 |
| 4 | [20-modules-server.md](20-modules-server.md) | 服务端每个模块：职责 / 关键函数 / 契约 / 测试位置 / 改前先看什么 |
| 4 | [21-modules-web.md](21-modules-web.md) | 前端 api.ts / 五个视图 / 路由 / 样式体系 |
| 5 | [30-conventions-pitfalls.md](30-conventions-pitfalls.md) | 红线细则全集（含代码依据）、已知坑、评审流程 |

## 红线速查（只有名字；语义、代码依据、违反后果全部在第五层 30-conventions-pitfalls.md）

1. git 子进程一律 spawn **参数数组**，禁 shell 拼接。
2. 对远端**只读**：仅 `clone --mirror` / `fetch --prune`，永不 push。
3. 测试 fixture 用**真实 git**，不 mock git 语义。
4. 同秒创建的相同内容提交 **SHA 字节级相同**——fixture 必须区分提交。
5. 传输兜底三分支：`httpProxy` undefined / `''` / 非空语义互异；`bypassGitConfig` 与 `gitConfigPath` 互斥。
6. `config.repos` 的仓对象被 Scheduler 持同引用——PATCH 只能**原位变更**，禁止整体替换。
7. 持久化**写序**：`writeConfig` 成功后再 DB upsert；失败必须回滚内存。
8. `rev-list --format` 输出先剥离 `commit <sha>` 头行再解析。
9. 分支名进 git argv 必须带 `refs/heads/` 前缀、作为单个参数。
10. 未设字段（`httpProxy`/`gitConfigPath`）undefined **省键**——"缺省"语义是跟随系统，不是空值。

改代码前：先读对应层文档再动手；引用代码一律写"文件 + 函数名"（行号随演进失漂移，文档禁用行号）。
