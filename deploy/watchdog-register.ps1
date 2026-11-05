# =====================================================================
# ㉖v108 看门狗计划任务注册（管理员运行一次即可）
# 效果：任务计划程序每 5 分钟以 SYSTEM 身份跑 watchdog.ps1（判活+自动重启服务）
# 卸载：powershell -File watchdog-register.ps1 -Uninstall
# =====================================================================
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$taskName = 'HSWmasWatchdog'
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$script = Join-Path $dir 'watchdog.ps1'

$__admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $__admin) {
  Write-Host '需要管理员权限（注册计划任务），请在弹出的授权窗口点「是」...' -ForegroundColor Yellow
  try {
    $p = Start-Process powershell -Verb RunAs -Wait -PassThru -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $PSCommandPath
    exit $p.ExitCode
  } catch { Write-Host '[失败] 未获得管理员权限' -ForegroundColor Red; Read-Host '按回车关闭'; exit 1 }
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($Uninstall) {
  if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false; Write-Host '[已卸载] 看门狗计划任务已移除' -ForegroundColor Green }
  else { Write-Host '[无需卸载] 任务不存在' }
  exit 0
}
if (-not (Test-Path $script)) { throw '找不到 watchdog.ps1（应与本脚本同目录）' }

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ('-NoProfile -ExecutionPolicy Bypass -File "' + $script + '"')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 9999)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 3) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId 'SYSTEM' -LogonType ServiceAccount -RunLevel Highest
if ($existing) { Unregister-ScheduledTask -TaskName $taskName -Confirm:$false }
Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'WMAS服务看门狗：每5分钟判活（HTTP应答+循环心跳），连续3次异常自动重启 HSAuthServer' | Out-Null
Write-Host '[完成] 看门狗已注册：每 5 分钟检查，日志见 ' + (Join-Path $dir 'watchdog.log') -ForegroundColor Green
Write-Host '       手动测试：powershell -File watchdog.ps1（立即跑一轮）'
Write-Host '       卸载：powershell -File watchdog-register.ps1 -Uninstall'
