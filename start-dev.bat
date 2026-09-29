@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot open the project directory.
  pause
  exit /b 1
)

echo [1/3] Checking Node.js and npm...
where node.exe >nul 2>&1
if errorlevel 1 goto :missing_node
where npm.cmd >nul 2>&1
if errorlevel 1 goto :missing_node
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
if errorlevel 1 goto :missing_node

echo [2/3] Installing project dependencies...
call npm.cmd install --include=dev --include=optional --no-audit --no-fund
if errorlevel 1 goto :failed

rem Electron 44 downloads its binary on demand; electron-vite needs it beforehand.
echo [3/3] Checking and installing the Electron runtime...
node "node_modules\electron\install.js"
if errorlevel 1 goto :electron_failed
node -e "const fs = require('node:fs'); const path = require('node:path'); const root = path.dirname(require.resolve('electron/package.json')); const exe = fs.readFileSync(path.join(root, 'path.txt'), 'utf8').trim(); if (!exe || !fs.existsSync(path.join(root, 'dist', exe))) process.exit(1)"
if errorlevel 1 goto :electron_failed

rem A desktop app must not inherit Electron's Node-only mode from a parent tool.
set "ELECTRON_RUN_AS_NODE="
set "NODE_ENV=development"
echo Starting Agent Desktop in development mode...
call npm.cmd run dev
if errorlevel 1 goto :failed
popd
exit /b 0

:missing_node
echo [ERROR] Node.js 22.12 or newer, including npm, is required.
echo Install Node.js from https://nodejs.org/ and run this file again.
goto :failed

:electron_failed
echo [ERROR] Electron runtime installation failed.
echo Check your network, proxy or ELECTRON_MIRROR setting, then run this file again.

:failed
echo.
echo [ERROR] Startup stopped. See the error above.
popd
pause
exit /b 1
