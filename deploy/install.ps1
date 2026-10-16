#Requires -RunAsAdministrator
# =====================================================================
#  WMAS 仓库管理系统 · 一键安装（Windows Server 2016+ / PowerShell 5.1）
#  用法：解压部署包后，右键本文件「以管理员身份运行」
#  可选参数：-InstallDir D:\wmas  -Port 8099
#  重复运行 = 重装服务注册（不动 data 数据目录）
# =====================================================================
param(
  [string]$InstallDir = 'D:\wmas',
  [int]$Port = 8099
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$svcName = 'HSAuthServer'

Write-Host ''
Write-Host '════ WMAS 一键安装 ════' -ForegroundColor Cyan
Write-Host "安装目录: $InstallDir   端口: $Port"

# ---------- 1. 检查/安装 Node.js ----------
$node = $null
$cmd = Get-Command node.exe -ErrorAction SilentlyContinue
if ($cmd) { $node = $cmd.Source }
if (-not $node -and (Test-Path 'C:\Program Files\nodejs\node.exe')) { $node = 'C:\Program Files\nodejs\node.exe' }
if (-not $node) {
  Write-Host '[1/6] 未检测到 Node.js，尝试用 winget 安装 LTS...' -ForegroundColor Yellow
  winget install OpenJS.NodeJS.LTS --accept-package-agreements --accept-source-agreements --silent
  if (Test-Path 'C:\Program Files\nodejs\node.exe') { $node = 'C:\Program Files\nodejs\node.exe' }
}
if (-not $node) { throw 'Node.js 安装失败：请手动安装 Node 18+ (https://nodejs.org) 后重新运行本脚本' }
Write-Host "[1/6] Node.js: $node  $(& $node -v)" -ForegroundColor Green

# ---------- 2. 检查部署包内容 ----------
if (-not (Test-Path "$root\code\server.js")) { throw "缺少 code\server.js，请确认部署包解压完整（本脚本应与 code\、nssm.exe 同目录）" }
if (-not (Test-Path "$root\nssm.exe")) { throw "缺少 nssm.exe" }
Write-Host '[2/6] 部署包内容完整' -ForegroundColor Green

# ---------- 3. 铺代码（绝不触碰 data） ----------
New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
Copy-Item "$root\code\server.js" "$InstallDir\server.js" -Force
if (-not (Test-Path "$InstallDir\public")) { New-Item -ItemType Directory -Path "$InstallDir\public" -Force | Out-Null }
Copy-Item "$root\code\public\*" "$InstallDir\public\" -Recurse -Force
Copy-Item "$root\nssm.exe" "$InstallDir\nssm.exe" -Force
New-Item -ItemType Directory -Path "$InstallDir\data\logs" -Force | Out-Null
Write-Host "[3/6] 代码已复制到 $InstallDir（data 目录未改动）" -ForegroundColor Green

# ---------- 4. 注册/重装 NSSM 服务 ----------
$svc = Get-Service $svcName -ErrorAction SilentlyContinue
if ($svc) {
  Write-Host "[4/6] 服务 $svcName 已存在，先移除旧注册（数据不受影响）..." -ForegroundColor Yellow
  & "$InstallDir\nssm.exe" stop $svcName 2>$null
  Start-Sleep -Seconds 1
  & "$InstallDir\nssm.exe" remove $svcName confirm | Out-Null
}
& "$InstallDir\nssm.exe" install $svcName "$node" "$InstallDir\server.js" | Out-Null
& "$InstallDir\nssm.exe" set $svcName AppDirectory "$InstallDir" | Out-Null
& "$InstallDir\nssm.exe" set $svcName AppStdout "$InstallDir\data\logs\service.log" | Out-Null
& "$InstallDir\nssm.exe" set $svcName AppStderr "$InstallDir\data\logs\service-error.log" | Out-Null
& "$InstallDir\nssm.exe" set $svcName AppRotateFiles 1 | Out-Null
& "$InstallDir\nssm.exe" set $svcName AppRotateBytes 10485760 | Out-Null
& "$InstallDir\nssm.exe" set $svcName AppRotateOnline 1 | Out-Null
& "$InstallDir\nssm.exe" set $svcName AppRestartDelay 2000 | Out-Null
& "$InstallDir\nssm.exe" set $svcName Start SERVICE_AUTO_START | Out-Null
& "$InstallDir\nssm.exe" set $svcName AppEnvironmentExtra "PORT=$Port" | Out-Null
Write-Host "[4/6] 服务 $svcName 注册完成（自动启动 + 崩溃 2 秒自愈 + 日志轮转 10MB）" -ForegroundColor Green

# ---------- 5. 防火墙放行 ----------
if (-not (Get-NetFirewallRule -DisplayName 'HS-Auth-8099' -ErrorAction SilentlyContinue)) {
  New-NetFirewallRule -DisplayName 'HS-Auth-8099' -Direction Inbound -Action Allow -Protocol TCP -LocalPort $Port | Out-Null
  Write-Host "[5/6] 防火墙已放行 TCP/$Port" -ForegroundColor Green
} else {
  Write-Host "[5/6] 防火墙规则 HS-Auth-8099 已存在，跳过" -ForegroundColor Green
}

# ---------- 6. 启动 + 健康检查 ----------
& "$InstallDir\nssm.exe" start $svcName | Out-Null
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/api/health" -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
if (-not $ok) {
  Write-Host "[6/6] 健康检查失败！查看日志: $InstallDir\data\logs\service-error.log" -ForegroundColor Red
  throw '服务未能正常响应，请检查日志后重试'
}
Write-Host '[6/6] 健康检查通过 ✓' -ForegroundColor Green

$ips = (Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.*' }).IPAddress -join ', '
Write-Host ''
Write-Host '════ 安装完成 ════' -ForegroundColor Cyan
Write-Host "本机访问:   http://127.0.0.1:$Port/console"
Write-Host "局域网访问: http://<本机IP>:$Port/console   (本机IP: $ips)"
Write-Host '首次使用：系统会自举默认数据（admin 账号见 README），RCS/WMAS 对接在「设置」页重新配置。'
Write-Host '若要迁移旧机器数据：停服务后把旧 data 目录整体覆盖过来（必须含 db.json 与 secret.key 两个文件），再启动服务。'
