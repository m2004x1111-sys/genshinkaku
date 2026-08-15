@echo off
chcp 65001 >nul
rem 启动 kakuyomub2-genshin（本地中转模式：抓取无需公共代理，任何浏览器均可放 MP3）
cd /d "%~dp0"

if not exist node_modules (
  echo 首次运行，正在安装依赖，请稍候...
  call npm install
)

if not exist dist (
  echo 正在构建前端...
  call npm run build
)

echo 正在启动本地服务（Ctrl+C 停止）...
start "" "http://localhost:5174"
call node server.js
