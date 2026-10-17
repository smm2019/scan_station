@echo off
setlocal
cd /d "%~dp0"
echo.
echo  ==== 打更新包（开发机） ====
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0打包更新.ps1"
if errorlevel 1 (
  echo.
  echo  [失败] 打包中断，请查看上方错误（常见=server.js 语法自检未过）
  pause & exit /b 1
)
echo.
echo  正在打开 out 文件夹，请把最新 wmas-update-*.zip 拖进向日葵传到服务器...
start "" explorer "%~dp0out"
pause