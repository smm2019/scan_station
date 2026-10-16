@echo off
chcp 65001 >nul
rem WMAS 一键更新：双击即可，自动弹 UAC 管理员授权运行 update.ps1
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0update.ps1' -Wait"
