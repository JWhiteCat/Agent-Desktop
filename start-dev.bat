@echo off
setlocal EnableExtensions DisableDelayedExpansion
rem Let Electron downloads use the configured HTTP_PROXY / HTTPS_PROXY.
set "ELECTRON_GET_USE_PROXY=1"
pushd "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot open the project directory.
  pause
  exit /b 1
)

set "FORCE_INSTALL=0"
:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--install" (
  set "FORCE_INSTALL=1"
  shift
  goto :parse_args
)
if /I "%~1"=="-h" goto :usage
if /I "%~1"=="--help" goto :usage
echo [ERROR] Unknown argument: %~1
goto :usage_error

:usage
echo Usage: start-dev.bat [--install]
echo Start Agent Desktop in development mode on Windows.
echo   --install  Refresh dependencies with npm install.
popd
exit /b 0

:usage_error
echo Usage: start-dev.bat [--install]
goto :failed

:args_done
echo [1/3] Checking Node.js and environment...
where node.exe >nul 2>&1
if errorlevel 1 goto :missing_node
where npm.cmd >nul 2>&1
if errorlevel 1 goto :missing_node

set "LAUNCHER_NODE_OK=0"
set "LAUNCHER_NEED_INSTALL=1"
set "LAUNCHER_ELECTRON_EXE="
for /f "usebackq tokens=1,* delims==" %%A in (`node "scripts\win-launcher-state.mjs" preflight dev`) do set "%%A=%%B"
if not "%LAUNCHER_NODE_OK%"=="1" goto :missing_node

if "%FORCE_INSTALL%"=="1" set "LAUNCHER_NEED_INSTALL=1"
if "%LAUNCHER_NEED_INSTALL%"=="1" (
  echo [2/3] Installing project dependencies...
  call npm.cmd install --include=dev --include=optional --no-audit --no-fund
  if errorlevel 1 goto :failed
  node "scripts\win-launcher-state.mjs" mark-installed
  set "LAUNCHER_ELECTRON_EXE="
  for /f "usebackq tokens=1,* delims==" %%A in (`node "scripts\win-launcher-state.mjs" preflight dev`) do set "%%A=%%B"
) else (
  echo [2/3] Dependencies up to date ^(skipping npm install^).
)

rem Electron 44 downloads its binary on demand; electron-vite needs it beforehand.
if not defined LAUNCHER_ELECTRON_EXE (
  echo [3/3] Installing the Electron runtime...
  node "node_modules\electron\install.js"
  if errorlevel 1 goto :electron_failed
  for /f "usebackq delims=" %%I in (`node "scripts\win-launcher-state.mjs" electron-exe 2^>nul`) do set "LAUNCHER_ELECTRON_EXE=%%I"
  if not defined LAUNCHER_ELECTRON_EXE goto :electron_failed
) else (
  echo [3/3] Electron runtime ready.
)

rem A desktop app must not inherit Electron's Node-only mode from a parent tool.
set "ELECTRON_RUN_AS_NODE="
set "NODE_ENV=development"
echo Starting Agent Desktop in development mode...
call "node_modules\.bin\electron-vite.cmd" dev
if errorlevel 1 goto :failed
popd
exit /b 0

:missing_node
echo [ERROR] Node.js 24 LTS ^(or 22.12+ / 26+^), including npm, is required.
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
