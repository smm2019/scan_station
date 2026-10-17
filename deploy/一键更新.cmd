@echo off
rem WMAS 一键更新：双击即可，脚本自动提权，结果窗口会停留等你看完
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update.ps1"
if errorlevel 1 (
  echo.
  echo  [更新未成功] 请查看上方报错；数据备份在 data\backups\pre-update-* 目录
  pause
)