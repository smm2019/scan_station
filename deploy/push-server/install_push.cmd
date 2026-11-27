@echo off
rem =====================================================================
rem ㉖v291 WMAS 消息推送中心 一键部署（管理员运行）
rem 用法：把 push_server.js 和本脚本放同一目录（如 C:\wmas-push\），右键"以管理员身份运行"。
rem 动作：①校验 Node ②防火墙放行 8100 ③有 nssm 则注册常驻服务 WmasPushHub（自启+崩溃自拉起），
rem       无 nssm 则只加防火墙并提示手动前台运行（测试够用）。
rem 密钥：如需启用鉴权，先 setx PUSH_KEY 你的密钥 /M（或 nssm set 环境变量），并与 scan_station
rem       参数面板「消息推送密钥」填同值；不设则留空两端也通。
rem =====================================================================
setlocal
set PORT=8100
set DIR=%~dp0
set JS=%DIR%push_server.js

where node >nul 2>nul
if errorlevel 1 (
  echo [X] 未检测到 Node.js。请先安装：winget install OpenJS.NodeJS.LTS 或官网 LTS 包。
  pause & exit /b 1
)
if not exist "%JS%" (
  echo [X] 同目录缺少 push_server.js： %DIR%
  pause & exit /b 1
)

echo [1/3] 防火墙放行 TCP %PORT% ...
netsh advfirewall firewall delete rule name="WmasPushHub %PORT%" >nul 2>nul
netsh advfirewall firewall add rule name="WmasPushHub %PORT%" dir=in action=allow protocol=TCP localport=%PORT% >nul
if errorlevel 1 (echo    [!] 防火墙规则添加失败，请手动放行 TCP %PORT%) else (echo    [OK] 已放行)

where nssm >nul 2>nul
if errorlevel 1 (
  echo.
  echo [2/3] 未检测到 nssm，跳过服务注册（测试可直接前台运行）。
  echo    前台运行：  node "%JS%"
  echo    常驻建议：  下载 nssm 后重跑本脚本，或：
  echo       nssm install WmasPushHub node "%JS%"
  echo       nssm set WmasPushHub AppDirectory "%DIR%"
  echo       nssm set WmasPushHub Start SERVICE_AUTO_START
  echo       nssm set WmasPushHub AppRestartDelay 2000
  echo.
  echo [3/3] 验证：浏览器打开 http://本机IP:%PORT%/health
  pause & exit /b 0
)

echo [2/3] 用 nssm 注册服务 WmasPushHub ...
nssm stop WmasPushHub >nul 2>nul
nssm remove WmasPushHub confirm >nul 2>nul
nssm install WmasPushHub node "%JS%"
nssm set WmasPushHub AppDirectory "%DIR%"
nssm set WmasPushHub DisplayName "WMAS Message Push Hub"
nssm set WmasPushHub Description "scan_station 局域网消息推送中心（SSE 扇出）"
nssm set WmasPushHub Start SERVICE_AUTO_START
nssm set WmasPushHub AppRestartDelay 2000
nssm set WmasPushHub AppStdout "%DIR%push.log"
nssm set WmasPushHub AppStderr "%DIR%push.log"
nssm set WmasPushHub AppRotateFiles 1
nssm set WmasPushHub AppRotateBytes 10485760
net start WmasPushHub
if errorlevel 1 (echo    [X] 服务启动失败，查看 %DIR%push.log) else (echo    [OK] 服务已启动)

echo [3/3] 验证：浏览器打开 http://本机IP:%PORT%/health
pause
endlocal
