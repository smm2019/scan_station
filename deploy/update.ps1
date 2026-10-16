#Requires -RunAsAdministrator
# =====================================================================
#  WMAS 日常更新：本地改好代码 → 打更新包 → 拷到服务器 → 双击本脚本
#  只覆盖代码（server.js + public），绝不动 data（数据库/备份/APK/日志）
#  用法：把 update.zip 解压到任意目录，右键本文件「以管理员身份运行」
#  可选参数：-InstallDir D:\wmas（与 install.ps1 保持一致）
# =====================================================================
param(
  [string]$InstallDir = 'D:\wmas',
  [int]$Port = 8099
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$svcName = 'HSAuthServer'
if (-not (Test-Path "$InstallDir\server.js")) { throw "未找到 $InstallDir\server.js——首次部署请先运行 install.ps1" }
if (-not (Test-Path "$root\code\server.js")) { throw '缺少 code\server.js，请确认更新包解压完整' }

# 1. 更新前自动备份数据库（双保险：db.json + secret.key 一起备）
$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$bakDir = "$InstallDir\data\backups\pre-update-$stamp"
New-Item -ItemType Directory -Path $bakDir -Force | Out-Null
Copy-Item "$InstallDir\data\db.json" "$bakDir\db.json" -Force -ErrorAction SilentlyContinue
Copy-Item "$InstallDir\data\secret.key" "$bakDir\secret.key" -Force -ErrorAction SilentlyContinue
Write-Host "[1/4] 已备份数据到 $bakDir" -ForegroundColor Green

# 2. 停服务
& "$InstallDir\nssm.exe" stop $svcName 2>$null
$svc = Get-Service $svcName -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -ne 'Stopped') { Start-Sleep -Seconds 3 }
Write-Host '[2/4] 服务已停止' -ForegroundColor Green

# 3. 覆盖代码（public 先清后拷，防旧文件残留）
Copy-Item "$root\code\server.js" "$InstallDir\server.js" -Force
Remove-Item "$InstallDir\public\*" -Recurse -Force -ErrorAction SilentlyContinue
Copy-Item "$root\code\public\*" "$InstallDir\public\" -Recurse -Force
Write-Host '[3/4] 代码已覆盖（data 未动）' -ForegroundColor Green

# 4. 起服务 + 健康检查
& "$InstallDir\nssm.exe" start $svcName | Out-Null
$ok = $false
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 2
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 5 -UseBasicParsing
    if ($r.StatusCode -eq 200) { $ok = $true; break }
  } catch { }
}
if (-not $ok) {
  Write-Host "[4/4] 健康检查失败！正在回滚到备份数据（代码请自行回退）..." -ForegroundColor Red
  Write-Host "      日志: $InstallDir\data\logs\service-error.log" -ForegroundColor Red
  throw '更新后服务未响应；数据备份在 ' + $bakDir
}
Write-Host "[4/4] 更新完成，服务健康 ✓  http://127.0.0.1:$port/console" -ForegroundColor Green
