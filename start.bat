@echo off
chcp 65001 > nul
echo 🎯 正在启动知识竞赛抢答系统...

:: 尝试自动查找 node.exe
set NODE_CMD=node
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set NODE_CMD="C:\Program Files\nodejs\node.exe"
  ) else (
    echo ❹ 未找到 Node.js，请确认已安装。
    pause
    exit /b 1
  )
)

%NODE_CMD% server.js
pause
