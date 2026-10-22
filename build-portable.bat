@echo off
setlocal EnableExtensions DisableDelayedExpansion
pushd "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot open the project directory.
  pause
  exit /b 1
)

echo [1/4] Checking Node.js and npm...
where node.exe >nul 2>&1
if errorlevel 1 goto :missing_node
where npm.cmd >nul 2>&1
if errorlevel 1 goto :missing_node
node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
if errorlevel 1 goto :missing_node

echo [2/4] Installing project dependencies...
call npm.cmd install --include=dev --include=optional --no-audit --no-fund
if errorlevel 1 goto :failed

rem Electron 44 downloads its binary on demand; electron-builder needs it beforehand.
echo [3/4] Checking and installing the Electron runtime...
node "node_modules\electron\install.js"
if errorlevel 1 goto :electron_failed
node -e "const fs = require('node:fs'); const path = require('node:path'); const root = path.dirname(require.resolve('electron/package.json')); const exe = fs.readFileSync(path.join(root, 'path.txt'), 'utf8').trim(); if (!exe || !fs.existsSync(path.join(root, 'dist', exe))) process.exit(1)"
if errorlevel 1 goto :electron_failed

rem Packaging must not inherit Electron's Node-only mode or look for a signing certificate.
set "ELECTRON_RUN_AS_NODE="
set "NODE_ENV=production"
set "CSC_IDENTITY_AUTO_DISCOVERY=false"
echo [4/4] Building the Windows x64 portable executable...
call npm.cmd run dist:win:portable
if errorlevel 1 goto :failed

echo.
echo Portable executable:
dir /b "release\*-win-*-portable.exe"
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
echo [ERROR] Portable build stopped. See the error above.
popd
pause
exit /b 1
