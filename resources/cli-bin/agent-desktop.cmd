@echo off
setlocal
set "ELECTRON_RUN_AS_NODE=1"
set "BIN_DIR=%~dp0"
"%BIN_DIR%..\..\Agent Desktop.exe" "%BIN_DIR%..\cli\cli.cjs" %*
exit /b %ERRORLEVEL%
