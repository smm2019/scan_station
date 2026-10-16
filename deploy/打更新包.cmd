@echo off
chcp 65001 >nul
rem =====================================================================
rem  WMAS 打更新包 · 在【开发机】双击
rem  作用：把最新代码打成 wmas-update-时间戳.zip，并打开所在文件夹
rem  下一步：向日葵把该 zip 拖到服务器 → 服务器上双击「一键更新.cmd」
rem =====================================================================
setlocal
cd /d "%~dp0"
echo.
echo  ════ 打更新包 ════
echo.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0打包更新.ps1"
if errorlevel 1 (
  echo.
  echo [失败] 打包中断，请查看上方错误（常见=server.js 语法自检未过）
  pause & exit /b 1
)
echo.
echo 正在打开 out 目录，请把最新的 wmas-update-*.zip 拖进向日葵传到服务器...
start "" explorer "%~dp0out"
pause
