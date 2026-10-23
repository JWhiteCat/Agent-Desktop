@echo off
setlocal EnableExtensions
pushd "%~dp0"
if errorlevel 1 (
  echo [ERROR] Cannot open the project directory.
  pause
  exit /b 1
)

if "%~1"=="" goto :usage
where node.exe >nul 2>&1
if errorlevel 1 goto :missing_node
where git.exe >nul 2>&1
if errorlevel 1 goto :missing_git
where npm.cmd >nul 2>&1
if errorlevel 1 goto :missing_node

node scripts\release.mjs %*
if errorlevel 1 goto :failed
popd
exit /b 0

:usage
echo Usage: release.bat 0.2.0
echo Write the changes under "## [Unreleased]" in CHANGELOG.md first.
goto :failed

:missing_node
echo [ERROR] Node.js and npm are required.
goto :failed

:missing_git
echo [ERROR] Git is required.
goto :failed

:failed
echo.
echo [ERROR] Release stopped. See the error above.
popd
pause
exit /b 1
