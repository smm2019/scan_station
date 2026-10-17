$gbk = [System.Text.Encoding]::GetEncoding(936)
$files = @{}
$files['一键安装.cmd'] = @"
@echo off
rem WMAS 一键安装启动器：双击即可，自动弹出管理员授权窗口
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0install.ps1' -Wait"
"@
$files['一键更新.cmd'] = @"
@echo off
rem WMAS 一键更新：双击即可，自动弹 UAC 管理员授权运行 update.ps1
cd /d "%~dp0"
powershell -NoProfile -Command "Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File','%~dp0update.ps1' -Wait"
"@
$files['打更新包.cmd'] = @"
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
"@
$files['迁移数据.cmd'] = @"
@echo off
setlocal EnableDelayedExpansion
cd /d "%~dp0"

set "SRV=10.96.23.8"
set "SRC=%~dp0..\server\data"
set "OUT=%~dp0out"
for /f %%i in ('powershell -NoProfile -Command "Get-Date -Format yyyyMMdd-HHmm"') do set "STAMP=%%i"
set "ZIP=%OUT%\wmas-data-%STAMP%.zip"

echo.
echo  ==== WMAS 数据迁移助手（在开发机运行） ====
echo   源目录: %SRC%
echo   输出:   %ZIP%
echo.

if not exist "%SRC%\db.json" (
  echo  [错误] 未找到 %SRC%\db.json，请确认本脚本位于 scan_station\deploy\ 下
  pause & exit /b 1
)

echo  [1/4] 迁移期间须停止本机 HSAuthServer（防止边写边拷）。
echo        即将打开服务管理器：找到 HSAuthServer - 右键「停止」- 回此窗口按任意键继续
powershell -NoProfile -Command "Start-Process services.msc -Verb RunAs"
pause >nul

echo  [2/4] 打包 data 目录（含 db.json / secret.key / backups / app ...）...
if not exist "%OUT%" mkdir "%OUT%"
if exist "%ZIP%" del "%ZIP%"
powershell -NoProfile -Command "Compress-Archive -Path '%SRC%\*' -DestinationPath '%ZIP%' -Force"
if not exist "%ZIP%" (
  echo  [错误] 打包失败，请检查磁盘空间与文件占用
  pause & exit /b 1
)
for %%A in ("%ZIP%") do echo        已生成: %ZIP% （约 %%~zA bytes）

echo  [3/4] 工作组环境无法从本机直推服务器共享（需服务器管理员账号），
echo        请用向日葵把下面的文件传到服务器：
echo          %ZIP%
echo.
echo  [4/4] 服务器端收尾（README「数据迁移」节有逐条命令）:
echo        1) 停服务:   D:\wmas\nssm.exe stop HSAuthServer
echo        2) 解压覆盖: 把 zip 内容解压到 D:\wmas\data\
echo           （必须包含 db.json 与 secret.key 两个文件，缺一不可）
echo        3) 起服务:   D:\wmas\nssm.exe start HSAuthServer
echo        4) 验证:     http://%SRV%:8099/console 登录看数据是否齐全
echo        5) 所有 PDA 设置里服务器地址改为 %SRV%
echo        [!] 最后务必停用本机旧服务（services.msc 停 HSAuthServer 并改手动启动），
echo            两台同时跑会导致账本分叉！
echo.
pause
"@
foreach ($f in $files.Keys) { [System.IO.File]::WriteAllText((Join-Path (Get-Location) $f), ($files[$f] -replace "`n", "`r`n"), $gbk) }
# 校验：GBK 回读无替换符、无 chcp 行
foreach ($f in $files.Keys) { $t = [System.IO.File]::ReadAllText((Join-Path (Get-Location) $f), $gbk); Write-Host ($f + ' 回读OK=' + (-not $t.Contains('?')) + ' 含chcp=' + $t.Contains('chcp') + ' 行数=' + ($t -split "`r`n").Count) }
