# Git 分支同步监控站

实时监控同一 Git 仓库多个分支之间的差异；对任意提交判定其他分支是否包含，未包含的标红置顶提醒。

## 依赖清单

| 依赖 | 版本要求 | 说明 |
|------|---------|------|
| Node | ≥ 22 | 本机（DSH 桌面端）PATH 无裸 `node`，pnpm 经 `pnpm exec node` 提供 **Electron 44 内嵌 Node（v24）**，等效满足；`pnpm doctor` 会自动按此方式解析并输出版本 |
| pnpm | ≥ 9 | 工作区包管理与脚本编排（`pnpm-workspace.yaml` 的 `minimumReleaseAge: 0` 与 `allowBuilds` 勿删） |
| git | ≥ 2.32 | 镜像监听与分支判定的核心；「按仓指定 git 配置文件」依赖 `GIT_CONFIG_GLOBAL` 环境变量映射（git ≥ 2.31 才支持） |
| better-sqlite3 | ^13 | **原生模块**，必须与运行时 Node ABI 匹配——Electron 内嵌运行时（ABI 149）在 registry 无预编译包，需按源码编译配方安装，见下方[排障节](#环境要求与排障better-sqlite3-原生模块electron-node-运行时) |

环境不齐或装不上时先跑 `pnpm doctor`：逐项体检并给出可执行的修复提示。

## 一键跑通

```bash
pnpm setup && pnpm dev
```

`pnpm setup` 幂等、可重复执行，依次完成：依赖体检（doctor，不过则中止）→ `pnpm install` → `pnpm build` → 生成数据目录与 `config.json` 样例（**仅在缺时生成，绝不覆盖已有配置**）→ 打印启动命令（不代启，保持显式）。样例配置指向演示仓 `/tmp/gsm-demo-origin`，首次体验先执行 `scripts/make-fixture.sh /tmp/gsm-demo-origin`；真实仓库随后在网页「仓库管理」页添加（免重启生效，自动回写 config.json）。

- 生产模式：`pnpm setup && pnpm start`（setup 已完成 build，后端 43900 同时托管前端构建产物）。
- 自定义数据/配置位置：`GSM_DATA=/path/to/data GSM_CONFIG=/path/to/config.json pnpm setup`（doctor 的目录可写项也按这两个变量探测）。
- `pnpm install` 若在 better-sqlite3 编译处失败，按下方排障节三步重装后重跑 `pnpm setup` 即可。

## 快速开始（手动分步，等价于 `pnpm setup` 的内部步骤）


```bash
pnpm install

# 1. 生成演示仓库（或跳过，直接用真实仓库地址）
scripts/make-fixture.sh /tmp/gsm-demo-origin

# 2. 写配置
mkdir -p ~/.git-sync-monitor
cat > ~/.git-sync-monitor/config.json <<'EOF'
{
  "repos": [
    {
      "id": "demo",
      "url": "/tmp/gsm-demo-origin",
      "defaultBranch": "master",
      "branchExclude": [],
      "pollIntervalSeconds": 30
    }
  ],
  "server": { "host": "127.0.0.1", "port": 43900 }
}
EOF

# 3. 启动（开发模式，前端 5173 / 后端 43900）
pnpm dev
# 或生产模式（后端 43900 同时托管前端构建产物）
pnpm build && pnpm start
```

打开 http://127.0.0.1:5173（开发）或 http://127.0.0.1:43900（生产）。

## 配置说明

| 字段 | 说明 |
|------|------|
| `repos[].url` | 任意 git 可达地址（ssh/https/本地路径）；网站通过 `git clone --mirror` 只读监听 |
| `repos[].defaultBranch` | 总览页"落后默认分支"徽标的基准 |
| `repos[].branchExclude` | 不监控的分支 glob（支持 `*`、`**`），如 `["tmp/*"]` |
| `repos[].pollIntervalSeconds` | 轮询间隔，默认 30，最小 5 |
| `server.host/port` | 监听地址，默认 127.0.0.1:43900（仅本机访问） |

环境变量：`GSM_CONFIG` 覆盖配置路径，`GSM_DATA` 覆盖数据目录（默认 `~/.git-sync-monitor/`，内含镜像、SQLite 与审计事件）。

## 使用

- **总览**：分支列表 + 监听状态条；"落后默认分支"黄色徽标点击直达对比；24h 内新提交计数红色徽标。
- **提交详情**：点任意提交进入；未包含该提交的活跃分支红色置顶，一键复制 `git cherry-pick <sha>`。
- **分支对比**：任选两分支查看双向独有提交。
- **跨仓对比**（v1.1）：导航"跨仓对比"→ 选两仓库与同名分支 → 可选填排除/仅对比的 glob（如 `vendor/**`、`src/**`）→ 查看双向独有提交与"源码一致（同补丁）"配对。merge 提交不参与指纹；上下文大漂移可能漏配，界面以"源码一致"如实呈现。
- **仓库管理**（v1.3）：导航"仓库管理"或总览页顶部"仓库管理"按钮进入。列表展示各仓 id/url/默认分支/轮询间隔/调度状态徽标（监听中/空闲/重试中/启动中）；添加表单填 id、url（必填）与默认分支、轮询间隔秒、排除 glob（可选，缺省 master/30s/不过滤），id 仅允许字母数字与 `.` `_` `-`，且不能为 `.` 或 `..`（会令镜像目录逃逸出 repos/ 根）。添加免重启生效（立即开始同步），删除需确认——停止监控并移出 config.json，数据库历史保留，同 id 重挂自动接续；至少保留一个仓库（删最后一个仓返回 409）。界面改动实时回写 config.json，重启不丢。
- **轮询间隔运行时可调**（v1.3.1）：仓库管理页每行"编辑"可改轮询间隔/默认分支/排除 glob，保存后下一轮询周期即时生效（无需重启）；取值范围 5–604800 秒（上限 7 天）。
- **传输兜底**（v1.3.2）：仓库管理页添加表单与每行"编辑"态的"传输（高级）"区可按仓配置，保存后下一 fetch 周期即时生效并实时回写 config.json：
  - **绕过系统 git 配置（直连）**：勾选后 clone/fetch 以纯净配置运行（`GIT_CONFIG_GLOBAL/SYSTEM=/dev/null`），适用于系统 git 配置了内源代理导致外部仓不可达的场景。注意：绕过会同时使 `credential.helper` 失效，私有 https 仓需确认认证方式；且不清除环境变量代理（`http_proxy`/`no_proxy` 等仍生效）。
  - **HTTP 代理**：留空 = 跟随系统 git 配置；填 `http://…` = 显式代理；勾选直连且代理留空时界面自动按 `""`（强制无代理）提交。**警示：`httpProxy: ""` 会静默强制无代理，误解即断连**。列表"传输"列以"直连/代理"徽标标记已配置兜底的仓，缺省显示"—"。
- **手动同步**（v1.3.2）：总览页状态条右侧"立即同步"按钮随时触发即时检出（自动轮询进行中会提示"已有同步在进行中"）；结果横幅显示检出数量或错误。

## 已知语义（重要）

包含判定基于提交 SHA 祖先关系：cherry-pick 产生的不同 SHA 会被判为"未包含"，这是 git 固有语义，工具如实标注不做猜测。

## 文档

- AI 协作与改造入口：[docs/ai/AGENTS.md](docs/ai/AGENTS.md)（渐进式披露五层：入口速查 → 概览 → 架构 → 服务端/前端模块 → 约束红线与已知坑）。

## 测试

```bash
pnpm test        # server + web 全部单元/集成测试（集成测试用真实 git fixture）
```

## 环境要求与排障：better-sqlite3 原生模块（Electron Node 运行时）

本仓库的 SQLite 驱动 better-sqlite3 是原生模块，必须与运行它的 Node ABI 匹配。本机（DSH 桌面端）的 pnpm 运行时是 **Electron 44 内嵌 Node**（`process.versions`：`electron 44.0.0`、`modules ABI 149`、`node v24.18.1`），registry 上没有对应 ABI 的预编译包，因此安装走**源码编译**。`node_modules` 清空、换机或 DSH 升级后，按下面三步重装（务必在仓库根执行）：

### 1) 准备 CXX wrapper（绕开残缺的 Xcode CLT libc++）

Xcode CLT 的 `/Library/Developer/CommandLineTools/usr/include/c++/v1` 是残缺旧 libc++（缺 `climits` 等），系统 `clang++` 编译任何 C++ 都失败（连 `-isysroot SDK` 都救不了——Apple clang 21 强制该目录优先）。用 wrapper 把 C++ 头改指 SDK 内的完整 libc++：

```sh
mkdir -p node_modules/.gsm-bin
printf '#!/bin/sh\nexec /usr/bin/clang++ -nostdinc++ -isystem /Library/Developer/CommandLineTools/SDKs/MacOSX.sdk/usr/include/c++/v1 "$@"\n' \
  > node_modules/.gsm-bin/clang++-sdk && chmod +x node_modules/.gsm-bin/clang++-sdk
```

### 2) 重建并定位 node-gyp（DSH 打包的 pnpm 缺自带 node-gyp）

DSH 打包的 pnpm 没有内置 node-gyp（`dist/node_modules/node-gyp/bin/node-gyp.js` 不存在），用 `pnpm dlx` 缓存里的 node-gyp 并以环境变量指路；若缓存被清掉，先跑一次 `pnpm dlx node-gyp --version` 重建：

```sh
pnpm dlx node-gyp --version
NODEGYP="$(ls -d "$HOME"/Library/pnpm/store/v11/links/@/node-gyp/*/p*-*/node_modules/node-gyp/bin/node-gyp.js | head -1)"
: "${NODEGYP:?未找到 pnpm 内置 node-gyp，先执行第 2 步}"
```

### 3) 带 Electron headers 源码编译安装

`npm_config_disturl/runtime/target` 让 node-gyp 下载 **Electron 44 的头文件**（而非 Node 官方头）并按 `ABI 149` 编译，产物才能被运行时加载；`allowBuilds` 已在 `pnpm-workspace.yaml` 中允许 better-sqlite3 跑安装脚本：

```sh
CXX="$PWD/node_modules/.gsm-bin/clang++-sdk" CC=/usr/bin/clang \
npm_config_node_gyp="$NODEGYP" \
npm_config_disturl=https://electronjs.org/headers \
npm_config_runtime=electron npm_config_target=44.0.0 \
pnpm install
```

编译成功的标志是日志出现 `gyp info ok`；装完自检（应在 server 包内跑，node 不在部分 shell 的 PATH 上）：

```sh
cd server && pnpm exec node -e "const D=require('better-sqlite3');new D(':memory:');console.log('sqlite OK, node',process.versions.node,'abi',process.versions.modules)"
```

### pnpm 注意事项

- 本机 `pnpm add` 有 bug（`spawn bash ENOENT`）：改依赖一律**直接编辑 package.json 后 `pnpm install`**，不要用 `pnpm add`。
- `pnpm-workspace.yaml` 里的 `minimumReleaseAge: 0` 不能删：pnpm ≥11 默认的 24h 供应链年龄策略会拒绝 lockfile 中刚发布不久的包。
- 仓库外（/tmp、$HOME 散目录）的 shell 写入不保证跨命令持久，实验性脚本放仓库内的 gitignore 区域更稳妥。

## 验收清单（对应设计文档 §14）

1. [ ] 对 fixture 仓库 master 新提交后 ≤ pollIntervalSeconds+1 秒，总览页免刷新出现红色计数徽标
2. [ ] 提交详情页：release/1.0 红色置顶显示于"未包含"区，master 在"已包含"区；复制按钮可用
3. [ ] 断网（改坏 url）后恢复，漏掉提交补齐且无重复（集成测试 `scheduler.test.ts` 覆盖，UI 层复验一次）
4. [ ] force-push 后分支出现"历史重写"徽标；删除分支进入折叠区
5. [ ] `pnpm test` 全绿；`pnpm build && pnpm start` 后按上述配置可对真实内部仓库运行
