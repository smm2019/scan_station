@echo off
rem WMAS 一键安装启动器：双击即可，自动弹出管理员授权窗口
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0install.ps1' -Wait"