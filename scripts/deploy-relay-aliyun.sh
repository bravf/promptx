#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVER_HOST="${SERVER_HOST:-8.130.37.52}"
SERVER_USER="${SERVER_USER:-root}"
REMOTE_NODE_BIN="${REMOTE_NODE_BIN:-/root/.nvm/versions/node/v22.22.1/bin}"
RELAY_SERVICE="${RELAY_SERVICE:-promptx-relay.service}"
RELAY_PUBLIC_URL="${RELAY_PUBLIC_URL:-https://px.mushayu.com}"
REMOTE="${SERVER_USER}@${SERVER_HOST}"
TMP_DIR="$(mktemp -d /tmp/promptx-relay-deploy.XXXXXX)"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "缺少本地命令: $1"
    exit 1
  fi
}

require_cmd curl
require_cmd npm
require_cmd pnpm
require_cmd scp
require_cmd shasum
require_cmd ssh

echo "构建 PromptX Relay 发布包..."
cd "$ROOT_DIR"
pnpm build

PACKAGE_NAME="$(npm pack --ignore-scripts --pack-destination "$TMP_DIR" | tail -n 1)"
PACKAGE_PATH="$TMP_DIR/$PACKAGE_NAME"
if [ ! -f "$PACKAGE_PATH" ]; then
  echo "发布包生成失败: $PACKAGE_PATH"
  exit 1
fi

REMOTE_PACKAGE="/tmp/promptx-relay-deploy-$(date +%Y%m%d%H%M%S).tgz"
echo "上传发布包到 $REMOTE..."
scp "$PACKAGE_PATH" "$REMOTE:$REMOTE_PACKAGE"

echo "更新并重启 $RELAY_SERVICE..."
ssh "$REMOTE" \
  "REMOTE_PACKAGE='$REMOTE_PACKAGE' REMOTE_NPM='$REMOTE_NODE_BIN/npm' RELAY_SERVICE='$RELAY_SERVICE' bash -s" <<'REMOTE_SCRIPT'
set -euo pipefail

cleanup() {
  rm -f "$REMOTE_PACKAGE"
}
trap cleanup EXIT

if [ ! -x "$REMOTE_NPM" ]; then
  echo "服务器 npm 不存在: $REMOTE_NPM"
  exit 1
fi

"$REMOTE_NPM" install -g "$REMOTE_PACKAGE"
systemctl restart "$RELAY_SERVICE"
sleep 2
systemctl is-active --quiet "$RELAY_SERVICE"
systemctl status "$RELAY_SERVICE" --no-pager -l | head -n 18
REMOTE_SCRIPT

echo "校验公网构建产物..."
LOCAL_HASH="$(shasum -a 256 "$ROOT_DIR/apps/web/dist/index.html" | awk '{print $1}')"
REMOTE_INDEX="$TMP_DIR/remote-index.html"
curl -fsS --max-time 20 -H 'Cache-Control: no-cache' \
  "$RELAY_PUBLIC_URL/?deploy=$(date +%s)" -o "$REMOTE_INDEX"
REMOTE_HASH="$(shasum -a 256 "$REMOTE_INDEX" | awk '{print $1}')"

if [ "$LOCAL_HASH" != "$REMOTE_HASH" ]; then
  echo "公网首页与本地构建不一致。"
  echo "local:  $LOCAL_HASH"
  echo "remote: $REMOTE_HASH"
  exit 1
fi

echo "Relay 发布完成: $RELAY_PUBLIC_URL"
echo "构建哈希: $LOCAL_HASH"
