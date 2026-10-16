@echo off
chcp 65001 >nul
rem =====================================================================
rem  WMAS 数据迁移助手 · 在【开发机】上双击运行（不是服务器）
rem  作用：停本机旧服务 → 打包整个 data 目录 → 尝试推送到服务器共享
rem  前提：已在本机跑过 install/update 部署包生成流程；服务器已装好服务
rem =====================================================================
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "SRV=10.96.23.8"
set "SRC=%~dp0..\server\data"
set "OUT=%~dp0out"
set "STAMP=%date:~0,4%%date:~5,2%%date:~8,2%-%time:~0,2%%time:~3,2%"
set "STAMP=%STAMP: =0%"
set "ZIP=%OUT%\wmas-data-%STAMP%.zip"

echo.
echo  ════ WMAS 数据迁移助手 ════
echo   源目录: %SRC%
echo   目标:   \\%SRV%\D$\wmas\data （或手动解压到 D:\wmas\data）
echo.

if not exist "%SRC%\db.json" (
  echo [错误] 未找到 %SRC%\db.json，请确认本脚本位于 scan_station\deploy\ 下
  pause & exit /b 1
)

rem ---------- 1. 提示并打开本机服务管理器（迁移期间需停旧服务防写入） ----------
echo [1/4] 迁移期间须停止本机 HSAuthServer（防止边写边拷）。
echo       即将打开服务管理器：找到 HSAuthServer → 右键「停止」→ 回来按键继续
powershell -NoProfile -Command "Start-Process services.msc -Verb RunAs"
pause >nul

rem ---------- 2. 打包 data 全目录 ----------
echo [2/4] 打包 data 目录（含 db.json / secret.key / backups / app ...）...
if not exist "%OUT%" mkdir "%OUT%"
if exist "%ZIP%" del "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%SRC%\*' -DestinationPath '%ZIP%' -Force"
if not exist "%ZIP%" (
  echo [错误] 打包失败，请检查磁盘空间与文件占用
  pause & exit /b 1
)
for %%A in ("%ZIP%") do echo       已生成: %ZIP% （约 %%~zA bytes）

rem ---------- 3. 输出产物并给出服务器端收尾指引 ----------
echo [3/4] 工作组环境无法从本机直推服务器共享（需服务器管理员账号），
echo       请用向日葵把下面的文件传到服务器：
echo         %ZIP%
echo.
echo [4/4] 服务器端收尾（README「数据迁移」节有逐条命令）:
echo       1) 停服务:   D:\wmas\nssm.exe stop HSAuthServer
echo       2) 解压覆盖: 把 zip 内容解压到 D:\wmas\data\
echo          （务必包含 db.json 与 secret.key 两个文件，缺一不可）
echo       3) 起服务:   D:\wmas\nssm.exe start HSAuthServer
echo       4) 验证:     http://%SRV%:8099/console 登录看数据是否齐全
echo       5) 所有 PDA 设置里服务器地址改为 %SRV%
echo       ⚠ 最后务必停用本机旧服务（services.msc 停 HSAuthServer 并改手动启动），
echo         两台同时跑会导致账本分叉！
echo.
pause
