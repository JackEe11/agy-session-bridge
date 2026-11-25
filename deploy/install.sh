#!/usr/bin/env bash
# 简单安装脚本：把仓库装到 /opt 并注册 systemd 实例服务
# 用法： sudo bash deploy/install.sh <运行用户>
set -euo pipefail

USER_NAME="${1:-}"
if [[ -z "$USER_NAME" ]]; then
  echo "用法: sudo bash deploy/install.sh <运行用户>" >&2
  exit 1
fi

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET=/opt/agy-session-bridge
UNIT=agy-bridge@.service

echo "==> 检查 Node 版本"
node -v | grep -qE '^v(1[89]|2[0-9])' || { echo "需要 Node 18+"; exit 1; }

echo "==> 复制到 $TARGET"
install -d -o "$USER_NAME" -g "$USER_NAME" "$TARGET"
cp -r "$REPO_DIR/src" "$TARGET/"
install -d -o "$USER_NAME" -g "$USER_NAME" "/home/$USER_NAME/.agy-bridge"

echo "==> 安装 systemd 单元"
install -m 0644 "$REPO_DIR/deploy/$UNIT" "/etc/systemd/system/$UNIT"
systemctl daemon-reload
systemctl enable --now "agy-bridge@$USER_NAME"

sleep 2
systemctl --no-pager status "agy-bridge@$USER_NAME" | head -n 12
echo
echo "==> 自检"
curl -s --max-time 5 http://127.0.0.1:8787/health || echo "（健康检查失败，看 journalctl -u agy-bridge@$USER_NAME）"
