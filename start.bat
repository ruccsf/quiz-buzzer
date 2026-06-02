@echo off
setlocal enabledelayedexpansion
title Quiz Buzzer
cd /d "%~dp0"

echo ========================================
echo    Quiz Buzzer - Starting...
echo ========================================
echo.

set "NODE_CMD=node"
where node >nul 2>nul
if errorlevel 1 (
  if exist "C:\Program Files\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files\nodejs\node.exe"
  ) else if exist "C:\Program Files (x86)\nodejs\node.exe" (
    set "NODE_CMD=C:\Program Files (x86)\nodejs\node.exe"
  ) else (
    echo [ERROR] Node.js not found
    pause
    exit /b 1
  )
)

echo Node: !NODE_CMD!
echo.

set "PORT=3000"
set "PID="

for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":3000.*LISTENING"') do set "PID=%%a"

if "!PID!"=="" (
  echo Port !PORT! is free.
  goto start
)

echo Port !PORT! in use by PID !PID!.
wmic process where ProcessId=!PID! get CommandLine 2>nul | find "server.js" >nul 2>nul
if errorlevel 1 (
  echo Another program is using the port.
  set /p "CHOICE=Kill it? (y/n): "
  if /i not "!CHOICE!"=="y" (
    echo Aborted.
    pause
    exit /b 1
  )
)

echo Stopping PID !PID!...
taskkill /f /pid !PID! >nul 2>nul
timeout /t 2 /nobreak >nul

:start
echo.
echo Starting server...
echo ========================================
!NODE_CMD! server.js
pause
