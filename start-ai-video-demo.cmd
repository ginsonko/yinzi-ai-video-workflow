@echo off
chcp 65001 >nul
setlocal

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-ai-video-demo.ps1" %*
if errorlevel 1 (
  echo.
  echo AI video demo failed to start. Review the error above.
  pause
  exit /b 1
)

echo.
echo AI video demo is ready. This window can be closed.
