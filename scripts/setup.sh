#!/usr/bin/env bash
# 一键装配：doctor 体检 → 依赖安装 → 构建 → 数据目录与 config.json 样例（仅在缺时生成，不覆盖已有）→ 启动命令提示（不代启，保持显式）。
# 用法: bash scripts/setup.sh（或仓库根 pnpm setup）；幂等，可重复执行。
# 配置位置可用环境变量覆盖: GSM_DATA=<数据目录> GSM_CONFIG=<config.json 路径> bash scripts/setup.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
step() { printf '\n== %s ==\n' "$1"; }

step "1/5 依赖体检（doctor，不过则不继续）"
bash scripts/doctor.sh

step "2/5 安装依赖（pnpm install）"
if ! pnpm install; then
  echo "pnpm install 失败：多为 better-sqlite3 原生编译问题，按 README《环境要求与排障：better-sqlite3 原生模块（Electron Node 运行时）》三步重装后重跑 bash scripts/setup.sh" >&2
  exit 1
fi

step "3/5 构建（pnpm build：web + server）"
pnpm build

step "4/5 配置样例（数据目录 + config.json 仅在缺时生成，绝不覆盖已有配置）"
DATA_DIR="${GSM_DATA:-$HOME/.git-sync-monitor}"
CONFIG_PATH="${GSM_CONFIG:-$HOME/.git-sync-monitor/config.json}"
mkdir -p "$DATA_DIR"
echo "数据目录: ${DATA_DIR}（可用 GSM_DATA 覆盖，内含镜像、SQLite 与审计事件）"
if [ -e "$CONFIG_PATH" ]; then
  echo "已存在 ${CONFIG_PATH}，跳过生成（不覆盖已有配置）"
else
  mkdir -p "$(dirname "$CONFIG_PATH")"
  cat > "$CONFIG_PATH" <<'EOF'
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
  echo "已生成 ${CONFIG_PATH}（样例，可用 GSM_CONFIG 覆盖路径）"
fi
echo "样例指向演示仓 /tmp/gsm-demo-origin：不存在时先执行 scripts/make-fixture.sh /tmp/gsm-demo-origin；"
echo "真实仓库在网页『仓库管理』页添加（免重启生效，改动自动回写 config.json）。"

step "5/5 装配完成 — 启动命令（显式执行，本脚本不代启）"
echo "开发模式: pnpm dev                              # 前端 http://127.0.0.1:5173 / 后端 43900"
echo "生产模式: pnpm start（依赖上面的 build 产物）    # 后端 43900 同时托管前端构建产物"
