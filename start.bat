@echo off
setlocal
title LiteForeFlow
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo   LiteForeFlow needs Node.js, which is not installed on this computer yet.
  echo.
  echo   1. A download page is opening - click the green "LTS" button and run the installer
  echo      ^(just keep clicking Next^).
  echo   2. Close this window, then double-click start.bat again.
  echo.
  start "" https://nodejs.org/en/download
  pause
  exit /b 1
)

node scripts\preflight.cjs
if errorlevel 1 (
  pause
  exit /b 1
)

if not exist node_modules\express (
  echo.
  echo   First start: installing LiteForeFlow. This takes about a minute, needs internet,
  echo   and only happens once.
  echo.
  call npm install --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo.
    echo   The install did not finish. Check your internet connection and double-click start.bat again.
    pause
    exit /b 1
  )
)

if not defined LITEFOREFLOW_OPEN set LITEFOREFLOW_OPEN=1
node --max-semi-space-size=2 --max-old-space-size=192 server\src\index.js
echo.
echo   LiteForeFlow has stopped. You can close this window.
pause
