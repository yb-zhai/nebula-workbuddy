@echo off
rem 双击卸载：从 ~/.workbuddy/mcp.json 移除本 server（记忆库目录保留）
setlocal
cd /d "%~dp0"
node install.mjs --uninstall
echo.
pause
