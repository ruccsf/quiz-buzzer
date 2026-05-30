@echo off
chcp 65001 > nul
echo 🛑 正在停止抢答系统...
taskkill /f /im node.exe 2>nul
echo ✅ 已停止
pause
