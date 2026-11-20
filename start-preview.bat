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
set "FORCE_REBUILD=0"
:parse_args
if "%~1"=="" goto :args_done
if /I "%~1"=="--install" (
  set "FORCE_INSTALL=1"
  shift
  goto :parse_args
)
if /I "%~1"=="--rebuild" (
  set "FORCE_REBUILD=1"
  shift
  goto :parse_args
)
if /I "%~1"=="-h" goto :usage
if /I "%~1"=="--help" goto :usage
echo [ERROR] Unknown argument: %~1
goto :usage_error

:usage
echo Usage: start-preview.bat [--install] [--rebuild]
echo Start Agent Desktop production preview on Windows.
echo   --install  Refresh dependencies with npm install.
echo   --rebuild  Force a fresh production build before launching.
popd
exit /b 0

:usage_error
echo Usage: start-preview.bat [--install] [--rebuild]
goto :failed

:args_done
echo [1/4] Checking Node.js and environment...
where node.exe >nul 2>&1
if errorlevel 1 goto :missing_node
where npm.cmd >nul 2>&1
if errorlevel 1 goto :missing_node

set "LAUNCHER_NODE_OK=0"
set "LAUNCHER_NEED_INSTALL=1"
set "LAUNCHER_ELECTRON_EXE="
set "LAUNCHER_NEED_BUILD=1"
for /f "usebackq tokens=1,* delims==" %%A in (`node "scripts\win-launcher-state.mjs" preflight preview`) do set "%%A=%%B"
if not "%LAUNCHER_NODE_OK%"=="1" goto :missing_node

if "%FORCE_INSTALL%"=="1" set "LAUNCHER_NEED_INSTALL=1"
if "%LAUNCHER_NEED_INSTALL%"=="1" (
  echo [2/4] Installing project dependencies...
  call npm.cmd install --include=dev --include=optional --no-audit --no-fund
  if errorlevel 1 goto :failed
  node "scripts\win-launcher-state.mjs" mark-installed
  set "LAUNCHER_ELECTRON_EXE="
  set "LAUNCHER_NEED_BUILD=1"
  for /f "usebackq tokens=1,* delims==" %%A in (`node "scripts\win-launcher-state.mjs" preflight preview`) do set "%%A=%%B"
) else (
  echo [2/4] Dependencies up to date ^(skipping npm install^).
)

rem Electron 44 downloads its binary on demand; ensure it is ready before launching.
if not defined LAUNCHER_ELECTRON_EXE (
  echo [3/4] Installing the Electron runtime...
  node "node_modules\electron\install.js"
  if errorlevel 1 goto :electron_failed
  for /f "usebackq delims=" %%I in (`node "scripts\win-launcher-state.mjs" electron-exe 2^>nul`) do set "LAUNCHER_ELECTRON_EXE=%%I"
  if not defined LAUNCHER_ELECTRON_EXE goto :electron_failed
) else (
  echo [3/4] Electron runtime ready.
)

rem A desktop app must not inherit Electron's Node-only mode from a parent tool.
set "ELECTRON_RUN_AS_NODE="
set "NODE_ENV=production"

if "%FORCE_REBUILD%"=="1" set "LAUNCHER_NEED_BUILD=1"
if "%LAUNCHER_NEED_BUILD%"=="1" (
  echo [4/4] Building the production app...
  call "node_modules\.bin\electron-vite.cmd" build
  if errorlevel 1 goto :failed
  node "scripts\win-launcher-state.mjs" mark-built
) else (
  echo [4/4] Production build is up to date ^(skipping build^).
)

echo Starting Agent Desktop...
"%LAUNCHER_ELECTRON_EXE%" .
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
