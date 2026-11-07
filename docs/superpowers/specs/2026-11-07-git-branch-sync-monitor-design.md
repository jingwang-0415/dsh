# Git 分支同步监控站 · 设计文档

- 日期：2026-11-07
- 状态：待用户审阅
- 项目：git-sync-monitor（全新项目，本机部署）

## 1. 背景与目标

团队在内部代码平台上维护同一仓库的多个分支。当一个分支合入 MR（产生新提交）后，需要人工确认其他分支是否也已经拥有这个提交；遗漏时需要被明确提醒。

本项目提供一个运行在开发机（macOS）上的本地 Web 服务：

1. 通过本地镜像克隆 + 定时 `git fetch` **监听**仓库变更（不依赖平台 API）；
2. 对任意提交，自动判定**其他每个分支是否包含该提交**，未包含的**标红置顶**；
3. 提供分支间 ahead/behind 差异总览；
4. 页面通过 SSE 实时刷新，无需手动重载。

## 2. 术语

| 术语 | 含义 |
|------|------|
| 镜像（mirror） | `git clone --mirror` 得到的裸仓库副本，仅用于读取引用与对象，永不改写 |
| 包含（contains） | 分支 head 可达某提交，即 `git merge-base --is-ancestor <commit> <branch>` 成立 |
| 标注（未包含标红） | 提交详情页中，未包含该提交的分支以红色条目置顶展示 |
| 平台适配器 | 对内部代码平台 API/MCP/webhook 的可选封装接口，v1 为空实现 |

## 3. 需求

### 3.1 功能需求

- FR1 监听：以可配置间隔（默认 30 秒）对镜像执行 `git fetch --prune`，识别新提交、新分支、被删分支、force-push。
- FR2 包含判定：对任意提交给出"每个分支是否包含"的判定结果；未包含的分支标红置顶，并附可复制的 cherry-pick 参考命令。
- FR3 分支总览：列出所有受监控分支的最新提交（作者、相对时间、主题）；落后于默认分支的分支给黄色徽标。
- FR4 分支对比：任选两个分支，展示双向 ahead/behind 提交列表。
- FR5 实时刷新：服务端检测到变更后通过 SSE 推送，前端免刷新更新。
- FR6 多仓库预留：数据模型与配置文件支持多个仓库；v1 界面与流程只服务第一个仓库。
- FR7 韧性：网络中断时指数退避重试并展示连接状态；恢复后自动补齐漏掉的变更，不重复入库。

### 3.2 非功能需求

- NFR1 全部 git 分析基于本地引用运算，只读镜像，绝不 push/reset 工作区。
- NFR2 单次包含判定（全部分支）P95 < 500ms（分支数 ≤ 100 场景）。
- NFR3 从提交到达服务端到页面呈现 ≤ 轮询间隔 + 1 秒。
- NFR4 单进程即可运行：`pnpm dev` 一条命令启动后端与前端；`pnpm build && pnpm start` 用于常驻运行。

### 3.3 语义与已知限制（重要）

包含判定基于提交 SHA 的可达性。**若某分支是通过 cherry-pick 同步的改动，SHA 不同，判定结果为"未包含"**——这是 git 语义的固有结果，v1 如实标注，不做猜测。未来增强（不在 v1 范围）：用 `git patch-id` 对未包含提交做"疑似同一改动"的灰色提示。用户最初的 cherry-pick 同步场景若占主导，应依赖该未来增强；v1 面向的是"以合并/同 SHA 方式流动"的分支关系与一般差异监控。

## 4. 总体架构

```
┌────────────────────────── 单进程 Fastify 服务 ──────────────────────────┐
│  Scheduler(轮询循环) → Mirror(git fetch --prune) → Sync(ref diff → 入库) │
│         │                                    │                          │
│         ▼                                    ▼                          │
│  GitRunner(spawn git)                    SQLite(better-sqlite3)         │
│                                                                          │
│  REST API + SSE  ◄── Analyzer(包含判定/ahead-behind，按需实时计算)        │
│         │                                                                │
│  静态托管 web/ 构建产物      PlatformAdapter(接口，v1=NullAdapter)         │
└──────────────────────────────────────────────────────────────────────────┘
        ▲                                            ▲
   浏览器(Vue 3 SPA)                    内部代码平台(git 远端，唯一硬依赖)
```

- 目录结构：
  - `server/`：TypeScript 后端（Fastify），模块：`scheduler`、`mirror`、`sync`、`analyzer`、`api`、`db`、`platform/`
  - `web/`：Vue 3 + Vite 前端，构建产物由 Fastify 静态托管
  - `docs/`：本设计文档与后续实施计划
- 运行数据目录（不入项目仓库）：`~/.git-sync-monitor/`
  - `config.json`（仓库与轮询配置）
  - `repos/<repo-id>/`（镜像裸仓库）
  - `monitor.db`（SQLite）

### 4.1 技术栈

| 层 | 选型 | 理由 |
|----|------|------|
| 运行时 | Node.js 20 + TypeScript | 单语言全栈；spawn 系统 git 最稳（镜像、merge-base 等能力完整） |
| HTTP | Fastify | 轻量、内建静态托管与日志 |
| 存储 | SQLite（better-sqlite3，同步 API） | 零运维，单机够用 |
| 前端 | Vue 3 + Vite，原生 fetch + EventSource | 视图少，不引入大型 UI 框架 |
| 测试 | vitest | 单元与集成统一 |
| git | 系统 git（spawn，禁用 shell 解释） | 真实语义；参数数组传递避免注入 |

## 5. 核心机制

### 5.1 监听循环（Scheduler）

1. 启动时确保镜像存在，缺失则 `git clone --mirror <url> <dir>`。
2. 每轮：取进程级互斥锁（防重入）→ 读取当前 `refs/heads/*` 快照（`git for-each-ref`）→ `git fetch --prune origin` → 再取快照。
3. 对比两份快照，产出变更集（见 5.2），入库并发出 SSE 事件。
4. 失败时按指数退避（5s → 10s → 20s … 上限 5min）安排下一轮，并广播 `status.changed`；成功后恢复常规间隔。
5. `pollIntervalSeconds` 按仓库配置，默认 30。

### 5.2 变更检测（ref diff）

对每个 `refs/heads/<name>` 比较 fetch 前后 SHA：

| 情形 | 判定 | 动作 |
|------|------|------|
| 前无后有 | 新分支 | 建分支记录；`git rev-list` 全量入库其提交；SSE `branches.updated` |
| 前是后的祖先（前非空，且 `merge-base --is-ancestor <old> <new>` 成立） | fast-forward | `git rev-list <old>..<new>` 增量入库；更新 head；SSE `commits.new` |
| 前后无祖先关系（且前非空） | force-push | 更新 head；置 `rewritten_at=now`；SSE `branches.updated`（含重写标记） |
| 前有后无 | 分支删除 | `status='deleted'`，保留历史记录；SSE `branches.updated` |

（"前为 null"指分支首次出现，等同新分支情形。）

### 5.3 包含判定（Analyzer，按需实时计算）

- 单提交 vs 全部分支：`git branch --contains <sha> --format=%(refname:short)`（镜像上列出包含该提交的所有本地分支），未命中的活跃分支即"未包含"。
- 单提交 vs 单分支：`git merge-base --is-ancestor <sha> refs/heads/<branch>`，退出码 0 即包含。
- 分支对比：`git rev-list --left-right --count refs/heads/<A>...refs/heads/<B>` 得 ahead/behind；两侧明细各一条 `git rev-list`。
- 不预计算包含矩阵：一条 `--contains` 已是全分支批量判定，本地引用遍历毫秒级；结果随请求实时返回，无缓存失效问题。

### 5.4 首次启动与历史回填

首次 clone 后视为"初始快照"：所有现存提交批量入库（`git rev-list --all` + 逐分支 head），但不视为"新提交"，不触发标红提醒之外的 SSE 噪音；此后才开始增量监听。

## 6. 数据模型（SQLite，全部预留 repo_id）

```sql
repos        (id TEXT PK, url TEXT NOT NULL, default_branch TEXT,
              created_at INTEGER NOT NULL)

branches     (id INTEGER PK, repo_id TEXT NOT NULL REFERENCES repos(id),
              name TEXT NOT NULL, head_sha TEXT, status TEXT NOT NULL DEFAULT 'active',
              rewritten_at INTEGER, last_commit_at INTEGER,
              created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
              UNIQUE(repo_id, name))

commits      (id INTEGER PK, repo_id TEXT NOT NULL REFERENCES repos(id),
              sha TEXT NOT NULL, author_name TEXT, author_email TEXT,
              committed_at INTEGER NOT NULL, subject TEXT, body TEXT,
              first_seen_branch TEXT, first_seen_at INTEGER NOT NULL,
              UNIQUE(repo_id, sha))

fetch_events (id INTEGER PK, repo_id TEXT NOT NULL REFERENCES repos(id),
              started_at INTEGER NOT NULL, finished_at INTEGER,
              status TEXT NOT NULL,              -- running|ok|failed
              new_commits INTEGER NOT NULL DEFAULT 0, error TEXT)
```

- `commits` 仅增量累积；包含判定不落库（实时算）。
- `first_seen_branch` 记录提交首次被监听到时所在分支，用于总览页"新提交来自哪条分支"。

## 7. 平台适配器（可选增强层）

```ts
interface PlatformAdapter {
  /** 为提交补充平台元数据（如 MR 标题/链接/审核人）；无能力则返回空 */
  enrichCommit?(sha: string): Promise<PlatformMeta | null>;
  /** 订阅平台推送；有 webhook/MCP 时可把轮询间隔降为兜底值 */
  subscribe?(onEvent: (e: PlatformEvent) => void): () => void;
}
```

- v1 只注册 `NullAdapter`（两方法均可选，直接无操作）。
- 核心模块（scheduler/sync/analyzer/api）只依赖该接口，不 import 任何平台 SDK。
- 未来实现 `GitlabAdapter` / `McpAdapter` 时新增文件 + 配置项 `platform.adapter`，核心零改动。

## 8. 后端 API

| 方法/路径 | 说明 |
|-----------|------|
| GET `/api/status` | fetch 循环状态：上次/下次时间、连续失败数、最近错误、镜像路径 |
| GET `/api/branches` | 活跃分支列表（含 head、最新提交、落后默认分支计数、rewritten/deleted 标记） |
| GET `/api/branches/:name/commits?limit=50&since=` | 分支提交分页 |
| GET `/api/commits/:sha` | 提交详情（含 adapter 元数据，v1 为空对象） |
| GET `/api/commits/:sha/inclusion` | 核心接口：`{ commit, results: [{ branch, contains: 0/1 }] }`，未包含在前 |
| GET `/api/compare?base=A&target=B` | ahead/behind 计数与双向提交列表 |
| GET `/api/events` | SSE：`commits.new` / `branches.updated` / `status.changed` |

错误约定：镜像/仓库级故障返回 503 + `{ code, message }`；参数错误 400。无鉴权（本机监听 `127.0.0.1`）。

## 9. 前端设计（3 视图，Vue 3 单页）

1. **仓库总览（首页）**
   - 顶部状态条：监听状态（正常绿色 / 重试中橙色显示剩余退避 / 镜像错误红色），上次同步时间。
   - 分支表：分支名、最新提交主题、作者、相对时间、落后默认分支数（>0 黄色徽标，点击进入对比视图）、"历史重写"小标、已删除分支折叠区。
   - 新提交红点：分支行显示最近 24 小时内被监听到（`commits.first_seen_at`）的提交计数徽标，红色；点开为该分支新提交列表。徽标随时间自然过期，不依赖"是否已读"。
2. **提交详情（核心视图）**
   - 头部：SHA（可复制）、作者、时间、subject/body；adapter 有 MR 元数据时展示链接（v1 隐藏）。
   - 分支包含列表：**未包含的分支红色置顶**，每行附"复制 cherry-pick 命令"按钮（`git cherry-pick <sha>`）；已包含的分支绿色；删除/重写分支灰显。
3. **分支对比**
   - 两个分支选择器 + 方向说明（A 领先 B n 个提交 / 落后 m 个），两列提交清单。

交互细节：SSE 到达后仅刷新受影响区域；EventSource 断线由浏览器自动重连；所有相对时间悬浮显示绝对时间。

## 10. 配置（`~/.git-sync-monitor/config.json`）

```json
{
  "repos": [
    {
      "id": "my-project",
      "url": "ssh://git@internal-platform/group/my-project.git",
      "defaultBranch": "master",
      "branchExclude": [],
      "pollIntervalSeconds": 30
    }
  ],
  "server": { "host": "127.0.0.1", "port": 43900 }
}
```

- `branchExclude`：gitignore 风格 glob，过滤不需要监控的分支（如 `refs/heads/tmp/*`）。
- v1 仓库列表只读自配置文件，重启生效；API 修改仓库留待多仓库版本。

## 11. 错误处理

| 故障 | 处理 |
|------|------|
| clone 失败 / fetch 网络错误 | 指数退避重试；SSE 广播 `status.changed`；前端状态条转橙并展示最近错误与下次重试时间 |
| git 命令异常退出 | stderr 全量捕获入 `fetch_events.error` 与日志；单命令 60s 超时 kill |
| 镜像损坏（fetch 报 corrupt） | 删除镜像目录重新 clone，随后执行 5.4 全量回填 |
| force-push | 按 5.2 处理：head 更新 + `rewritten_at` 标记，UI 灰黄提示"该分支历史被重写" |
| 分支被删 | `status='deleted'`，历史与统计保留，默认视图隐藏 |
| 配置缺失/非法 | 启动时校验并给出明确报错（缺 url、非法 glob 等），拒绝启动而非带病运行 |
| 并发 fetch | 进程内互斥锁，后到轮次直接跳过并顺延 |
| 数据库 | WAL 模式；启动时跑 migrations（版本号表），失败即退出 |

## 12. 测试策略

- **单元（vitest）**：ref diff 四情形分类、commit `--format` 解析、glob 过滤、退避计算、配置校验。git 调用层抽象为 `GitRunner` 接口以便注入假实现。
- **集成（真实 git，不 mock git 语义）**：每个用例在 `os.tmpdir()` 搭建 origin 裸仓库并制造提交/分支，服务进程指向它，完整跑 clone → 多轮 fetch → ref diff → 入库 → API 断言：
  - fast-forward 增量正确且不重复；
  - 新分支/删分支/force-push 三类事件的状态与标记；
  - 包含判定：B 分支合入 A 的提交后 `contains=1`；cherry-pick 同改动到 B 后 `contains=0`（锁定 3.3 语义）；
  - 中断模拟：把镜像 origin 所指的 fixture 远端目录临时改名（fetch 即失败）触发退避，改回原名后自动补齐且 commits 无重复（不修改配置文件，符合"重启生效"约定）。
- **验收口径**：见 §14，实施计划中逐条映射为可执行检查。

## 13. 明确不做（v1 范围外）

- 用户登录/鉴权、HTTPS（仅 127.0.0.1）
- 多仓库的 UI 与 API 写操作（模型预留）
- cherry-pick 自动执行、webhook 反向注册
- 平台 API/MCP 真实适配器（接口就绪，等能力确认）
- patch-id "疑似同一改动" 灰色提示（列为后续增强候选）
- 移动端适配

## 14. 验收标准

1. fixture 仓库 A 分支产生新提交后，≤ `pollIntervalSeconds + 1s` 页面免刷新出现对应分支红点与新提交。
2. 提交详情页正确列出每个分支的包含状态；未包含的红色置顶且能一键复制 cherry-pick 命令。
3. 断网 5 分钟后恢复，漏掉的提交全部补齐，`commits` 表无重复 SHA。
4. force-push 与删除分支后，总览页标记与折叠区表现符合 §9。
5. `pnpm test` 全绿；`pnpm build && pnpm start` 后按 §10 配置可对真实内部仓库运行。

## 15. 开放问题

1. 内部平台是否提供 API/MCP 或 webhook——待用户向平台方确认；确认后补适配器实现（不影响 v1）。
2. v1.1 是否引入 patch-id 疑似匹配，取决于团队 cherry-pick 同步占比。
3. 真实仓库规模（分支数/日提交量）待接入后观察，超预期再谈缓存策略。
