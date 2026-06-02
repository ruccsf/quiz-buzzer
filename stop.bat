@echo off
title Stop Quiz Buzzer
echo Stopping Quiz Buzzer...
taskkill /f /im node.exe >nul 2>nul
if errorlevel 1 (
  echo No running node process found.
) else (
  echo Server stopped.
)
echo.
pause
