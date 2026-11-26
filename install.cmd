@echo off
rem 双击安装：写进 ~/.workbuddy/mcp.json
setlocal
cd /d "%~dp0"
node install.mjs %*
echo.
pause
