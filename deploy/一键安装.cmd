@echo off
rem WMAS 一键安装启动器：双击即可，脚本自动提权，结果窗口会停留等你看完
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0install.ps1"
if errorlevel 1 (
  echo.
  echo  [安装未成功] 请查看上方报错；常见原因：未通过 UAC 授权、端口被占、Node 安装失败
  pause
)