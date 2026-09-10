@echo off
setlocal
cd /d "%~dp0"

if not exist "node_modules\vue" (
  echo Installing dependencies...
  call npm install
  if errorlevel 1 goto :failed
)

if not exist "dist\index.html" (
  echo Building frontend...
  call npm run build
  if errorlevel 1 goto :failed
)

echo Starting server at http://localhost:5174
echo Keep this window open. Press Ctrl+C to stop.
start "" "http://localhost:5174"
node server.js
if errorlevel 1 goto :failed
goto :eof

:failed
echo.
echo Startup failed. Read the error above.
pause
