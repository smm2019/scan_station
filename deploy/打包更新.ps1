# =====================================================================
#  【已废弃 2026-10-17】本目录工具链已并入 D:\work_app\deploy（唯一部署根目录）
#  请改用 D:\work_app\deploy\pack_server.ps1 打包、那里的一键安装/一键更新/迁移数据.cmd
#  本脚本保留仅为历史兼容，不再维护。
# =====================================================================
$ErrorActionPreference = 'Stop'
$proj = Split-Path -Parent $MyInvocation.MyCommand.Path   # ...\scan_station\deploy
# 清理历史 out（防 zip 套娃）
if (Test-Path (Join-Path $proj 'out')) { Remove-Item (Join-Path $proj 'out\*') -Recurse -Force -ErrorAction SilentlyContinue }
$serverDir = Join-Path (Split-Path -Parent $proj) 'server' # ...\scan_station\server
$stamp = Get-Date -Format 'yyyyMMdd-HHmm'
$out = Join-Path $proj "out"
New-Item -ItemType Directory -Path $out -Force | Out-Null

# 组装 code 暂存区
$stage = Join-Path $out 'stage'
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path "$stage\code\public" -Force | Out-Null
Copy-Item "$serverDir\server.js" "$stage\code\server.js" -Force
Copy-Item "$serverDir\public\*" "$stage\code\public\" -Recurse -Force
Copy-Item (Join-Path $proj 'install.ps1') "$stage\install.ps1" -Force
Copy-Item (Join-Path $proj '一键安装.cmd') "$stage\一键安装.cmd" -Force
Copy-Item (Join-Path $proj '一键更新.cmd') "$stage\一键更新.cmd" -Force
Copy-Item (Join-Path $proj '迁移数据.cmd') "$stage\迁移数据.cmd" -Force
Copy-Item (Join-Path $proj 'update.ps1') "$stage\update.ps1" -Force
Copy-Item (Join-Path $proj 'README.md') "$stage\README.md" -Force
# 语法自检：server.js 必须能过 node --check
node --check "$stage\code\server.js"
if ($LASTEXITCODE -ne 0) { throw 'server.js 语法自检失败，中止打包' }

# 内嵌 Node 运行时（server.js 零依赖，单 node.exe 即可跑；服务器无winget/无外网也能装）
New-Item -ItemType Directory -Path "$stage\runtime" -Force | Out-Null
$nodeSrc = 'D:\nodejs\node.exe'
if (Test-Path $nodeSrc) { Copy-Item $nodeSrc "$stage\runtime\node.exe" -Force } else { Write-Warning '未找到 D:\nodejs\node.exe，安装包将不含内嵌运行时（服务器需已装 Node）' }
# 完整安装包（含 nssm）
$nssmSrc = 'C:\Users\周小亚\AppData\Local\Microsoft\WinGet\Packages\NSSM.NSSM_Microsoft.Winget.Source_8wekyb3d8bbwe\nssm-2.24-101-g897c7ad\win64\nssm.exe'
if (Test-Path $nssmSrc) { Copy-Item $nssmSrc "$stage\nssm.exe" -Force } else { Write-Warning '未找到 nssm.exe，安装包将不含服务注册器' }
$deployZip = Join-Path $out "wmas-deploy-$stamp.zip"
Compress-Archive -Path "$stage\*" -DestinationPath $deployZip -Force

# 日常更新包（不含 nssm/install）
$uStage = Join-Path $out 'stage_upd'
Remove-Item $uStage -Recurse -Force -ErrorAction SilentlyContinue
New-Item -ItemType Directory -Path $uStage -Force | Out-Null
Copy-Item "$stage\update.ps1" "$uStage\update.ps1" -Force
Copy-Item (Join-Path $proj '一键更新.cmd') "$uStage\一键更新.cmd" -Force
Copy-Item "$stage\code" "$uStage\code" -Recurse -Force
$updZip = Join-Path $out "wmas-update-$stamp.zip"
Compress-Archive -Path "$uStage\*" -DestinationPath $updZip -Force

$kb = [math]::Round((Get-Item $deployZip).Length / 1KB)
$kb2 = [math]::Round((Get-Item $updZip).Length / 1KB)
Write-Host ''
Write-Host "打包完成 ✓" -ForegroundColor Green
Write-Host "首次安装包: $deployZip  ($kb KB)"
Write-Host "日常更新包: $updZip  ($kb2 KB)"
Write-Host '把 zip 拷到服务器解压，右键对应 ps1 以管理员身份运行即可。'
