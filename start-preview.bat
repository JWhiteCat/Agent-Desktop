@echo off
cd /d "%~dp0"
call npm run build
if errorlevel 1 (
  pause
  exit /b 1
)
call npm run preview -- --skipBuild
if errorlevel 1 pause
