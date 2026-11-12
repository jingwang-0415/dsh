#!/usr/bin/env bash
# 依赖体检：node ≥22 / pnpm ≥9 / git ≥2.32 / better-sqlite3 可加载 / 数据·配置目录可写。
# 用法: bash scripts/doctor.sh（或仓库根 pnpm doctor）。
# 全部通过输出 OK 并退出 0；任一失败打印可执行修复提示并退出 1。只读探测（目录可写项仅做 mkdir/探针文件即删）。
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
[ -f server/package.json ] || { echo "未找到 server/package.json：请在 git-sync-monitor 仓库内运行" >&2; exit 1; }

FAILS=0
ok()   { printf '  [OK]   %s\n' "$1"; }
fail() { printf '  [FAIL] %s\n' "$1"; FAILS=$((FAILS + 1)); }
hint() { printf '         ↳ 修复: %s\n' "$1"; }
# 版本号取主/次段（BSD sort 无 -V，手写比较；+0 兜底空段）
major() { printf '%s' "$1" | awk -F. '{print $1 + 0}'; }
minor() { printf '%s' "$1" | awk -F. '{print ($2 == "" ? 0 : $2) + 0}'; }

echo "== git-sync-monitor 依赖体检 =="
echo "仓库根: $ROOT"

# ---- 1) node ≥22：PATH 无裸 node 时回退 pnpm exec node（DSH Electron 内嵌运行时）----
echo "[1/5] node ≥ 22"
node_ver="$(node --version 2>/dev/null || true)"
node_via="PATH"
if [ -z "$node_ver" ]; then
  node_ver="$(pnpm exec node --version 2>/dev/null || true)"
  node_via="pnpm exec node（PATH 无裸 node，DSH pnpm 的 Electron 内嵌 Node 运行时）"
fi
if [ -n "$node_ver" ] && [ "$(major "${node_ver#v}")" -ge 22 ]; then
  ok "node ${node_ver}（解析方式: ${node_via}）"
elif [ -n "$node_ver" ]; then
  fail "node 版本过低: ${node_ver}（要求 ≥22）"
  hint "升级 Node ≥22（https://nodejs.org 或系统包管理器）"
else
  fail "未找到可用的 node"
  hint "安装 Node ≥22；或先安装 pnpm（其内嵌 Node 可经 pnpm exec node 使用，本机即此形态，见 README 依赖清单节）"
fi

# ---- 2) pnpm ≥9 ----
echo "[2/5] pnpm ≥ 9"
pnpm_ver="$(pnpm --version 2>/dev/null || true)"
if [ -n "$pnpm_ver" ] && [ "$(major "$pnpm_ver")" -ge 9 ]; then
  ok "pnpm ${pnpm_ver}"
elif [ -n "$pnpm_ver" ]; then
  fail "pnpm 版本过低: ${pnpm_ver}（要求 ≥9）"
  hint "升级 pnpm: npm i -g pnpm@latest 或 corepack enable"
else
  fail "未找到 pnpm"
  hint "安装 pnpm ≥9: npm i -g pnpm 或 corepack enable（Node 22+ 自带 corepack）"
fi

# ---- 3) git ≥2.32（GIT_CONFIG_GLOBAL 环境变量映射需 ≥2.31）----
echo "[3/5] git ≥ 2.32（按仓指定 git 配置文件依赖 GIT_CONFIG_GLOBAL 支持，需 ≥2.31）"
git_ver="$(git --version 2>/dev/null | awk '{print $3}' || true)"
if [ -n "$git_ver" ] && { [ "$(major "$git_ver")" -gt 2 ] || { [ "$(major "$git_ver")" -eq 2 ] && [ "$(minor "$git_ver")" -ge 32 ]; }; }; then
  ok "git ${git_ver}"
elif [ -n "$git_ver" ]; then
  fail "git 版本过低: ${git_ver}（要求 ≥2.32）"
  hint "升级 git: brew install git 或 https://git-scm.com（v1.5 按仓指定 git 配置文件依赖 GIT_CONFIG_GLOBAL 环境变量，git ≥2.31 才支持）"
else
  fail "未找到 git"
  hint "安装 git: brew install git 或 https://git-scm.com"
fi

# ---- 4) better-sqlite3 原生模块可加载（在 server 包内 require + 内存库实例化探针）----
echo "[4/5] better-sqlite3 原生模块可加载"
sqlite_err="$(cd server && pnpm exec node -e "const D=require('better-sqlite3');new D(':memory:');console.log('abi '+process.versions.modules)" 2>&1 || true)"
if [ -n "$sqlite_err" ] && printf '%s' "$sqlite_err" | grep -q '^abi '; then
  ok "better-sqlite3 加载成功（$(printf '%s' "$sqlite_err" | tail -1)，与运行时 ABI 匹配）"
else
  fail "better-sqlite3 无法加载（$(printf '%s' "${sqlite_err##*$'\n'}")）"
  hint "原生模块与运行时 ABI 不匹配或未编译：按 README《环境要求与排障：better-sqlite3 原生模块（Electron Node 运行时）》一节三步重装（CXX wrapper → node-gyp 定位 → Electron headers 源码编译），完成后重跑 bash scripts/doctor.sh"
fi

# ---- 5) 数据目录与配置文件路径可写（GSM_DATA / GSM_CONFIG 生效探针）----
echo "[5/5] 数据目录与配置路径可写（GSM_DATA / GSM_CONFIG）"
data_dir="${GSM_DATA:-$HOME/.git-sync-monitor}"
config_path="${GSM_CONFIG:-$HOME/.git-sync-monitor/config.json}"
writable() {
  mkdir -p "$1" 2>/dev/null || return 1
  local probe="$1/.gsm-doctor-probe-$$"
  : > "$probe" 2>/dev/null || return 1
  rm -f "$probe"
}
d_src="默认值"; [ -n "${GSM_DATA:-}" ] && d_src="GSM_DATA"
c_src="默认值"; [ -n "${GSM_CONFIG:-}" ] && c_src="GSM_CONFIG"
if writable "$data_dir" && writable "$(dirname "$config_path")"; then
  ok "数据目录可写: ${data_dir}（${d_src}）；配置路径可写: ${config_path}（${c_src}）"
else
  fail "数据目录或配置路径不可写: ${data_dir} / ${config_path}"
  hint "检查目录权限与磁盘空间；或将环境变量 GSM_DATA / GSM_CONFIG 指到可写位置后重跑"
fi

echo
if [ "$FAILS" -eq 0 ]; then
  echo "体检结果: OK（5/5 通过）"
else
  echo "体检结果: ${FAILS} 项未通过；按上方修复提示处理后重跑 bash scripts/doctor.sh"
  exit 1
fi
