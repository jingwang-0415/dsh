#!/usr/bin/env bash
# 用法: scripts/make-fixture.sh /tmp/gsm-demo-origin
# 创建一个带 master 与 release/1.0 的演示仓库，供监控站本地验收使用。
set -euo pipefail
DIR="${1:?用法: make-fixture.sh <目标目录>}"
case "$DIR" in
  /|"$HOME"|"$HOME"/|.|..) echo "拒绝危险目标目录: $DIR" >&2; exit 1 ;;
esac
rm -rf "$DIR"
git init --initial-branch=master "$DIR"
git -C "$DIR" config user.name "Demo"
git -C "$DIR" config user.email "demo@example.com"
echo "# demo" > "$DIR/README.md"
git -C "$DIR" add README.md && git -C "$DIR" commit -m "init: 项目骨架"
git -C "$DIR" checkout -b release/1.0
echo "rel" > "$DIR/rel.txt" && git -C "$DIR" add rel.txt && git -C "$DIR" commit -m "feat: release 专用配置"
git -C "$DIR" checkout master
echo "fix" > "$DIR/fix.txt" && git -C "$DIR" add fix.txt && git -C "$DIR" commit -m "fix: 严重崩溃修复（仅 master，release 未包含）"
echo "演示仓库已创建: $DIR"
echo "master 与 release/1.0 已分叉；在监控页打开 fix 提交应看到 release/1.0 标红。"
