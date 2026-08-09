@echo off
chcp 65001 >nul
rem 启动 kakuyomub2-genshin（Vue 3 + Vite + GenshinUI）
cd /d "%~dp0"

if not exist node_modules (
  echo 首次运行，正在安装依赖，请稍候...
  call npm install
)

echo 正在启动开发服务器...
start "" "http://localhost:5173"
call npm run dev
