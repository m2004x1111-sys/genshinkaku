#!/usr/bin/env bash
# kakuyomub2-genshin 服务器一键启动（Linux）
# 用法: ./start.sh   或  PORT=5174 ./start.sh
set -e
cd "$(dirname "$0")"

if [ ! -d node_modules ]; then
  echo "[1/3] 安装依赖..."
  npm install
fi

if [ ! -d dist ]; then
  echo "[2/3] 构建前端..."
  npm run build
fi

echo "[3/3] 启动服务: http://0.0.0.0:${PORT:-5174}"
exec node server.js
