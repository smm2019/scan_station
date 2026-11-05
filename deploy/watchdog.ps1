# =====================================================================
# ㉖v108 WMAS 服务看门狗（不靠 AI、不靠人守的最后一层）
# 职责：每 5 分钟由任务计划程序调起。双重判活——
#   ① HTTP 应答：/api/health-ping 10 秒内答否（进程挂死/端口不通）
#   ② 循环心跳：应答了但 RCS 轮询心跳 > 180 秒 = 进程假死（HTTP 活着、调度死了）
# 连续 3 次异常 → 重启 HSAuthServer 服务并留日志。单实例互斥：上一轮没跑完本轮直接退出。
# 用法（注册一次，管理员 PowerShell）：powershell -File watchdog-register.ps1
# 手动跑一次（测试/应急）：powershell -File watchdog.ps1
# =====================================================================
param(
  [string]$Port = '8099',
  [string]$SvcName = 'HSAuthServer',
  [int]$HbStaleSec = 180,      # 心跳超此秒数判假死（RCS 节拍 20 秒 × 9 轮未跳 = 必有问题）
  [int]$FailThreshold = 3      # 连续异常达此次数才重启（防单次网络抖动误杀）
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {} # 中文日志经 stdout 传出必须 UTF-8（否则被按 GBK 码页读出乱码）
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir 'watchdog.log'
$failFile = Join-Path $dir 'watchdog-fail.count'

function Log($msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line
}

# ---- 单实例互斥（防任务计划重叠执行） ----
$mtx = New-Object System.Threading.Mutex($false, 'Global\HSWmasWatchdog')
if (-not $mtx.WaitOne(0)) { Log '[跳过] 上一轮看门狗仍在运行'; exit 0 }
try {
  $prevFail = 0
  if (Test-Path $failFile) { [int]::TryParse((Get-Content $failFile -Raw).Trim(), [ref]$prevFail) | Out-Null }

  $bad = $false; $why = ''
  try {
    $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/api/health-ping') -TimeoutSec 10
    $rcsAge = [int]$r.hb.rcsAgeS
    $inspAge = [int]$r.hb.inspAgeS
    if ($r.uptime -gt 300) {
      # 启动 5 分钟宽限期后：首轮心跳必须已建立（-1=从未跑过），且不得停跳
      if ($rcsAge -lt 0 -or $rcsAge -gt $HbStaleSec) { $bad = $true; $why = 'RCS轮询心跳异常（' + $rcsAge + '秒）' }
      elseif ($inspAge -lt 0 -or $inspAge -gt 90) { $bad = $true; $why = '检验状态机心跳异常（' + $inspAge + '秒）' }
    }
    if (-not $bad) { Log ('[OK] 应答正常 · RCS心跳' + $rcsAge + 's · 检验心跳' + $inspAge + 's · 近1分' + $r.req1m + '请求') }
  } catch {
    $bad = $true; $why = 'HTTP无应答：' + $_.Exception.Message.Split("`n")[0]
  }

  if (-not $bad) {
    if ($prevFail -gt 0) { Set-Content -Path $failFile -Value '0' -Encoding ASCII; Log '[恢复] 异常计数清零' }
    exit 0
  }

  $fails = $prevFail + 1
  Set-Content -Path $failFile -Value ([string]$fails) -Encoding ASCII
  Log ('[异常 ' + $fails + '/' + $FailThreshold + '] ' + $why)

  if ($fails -lt $FailThreshold) { exit 0 } # 未达阈值：只记录不动手

  # ---- 达阈值：重启服务 ----
  Log ('[重启] 连续' + $fails + '次异常，重启服务 ' + $SvcName)
  try {
    Restart-Service -Name $SvcName -Force -ErrorAction Stop
    Start-Sleep -Seconds 8
    $ok = $false
    for ($i = 0; $i -lt 10; $i++) {
      try { Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/api/health') -TimeoutSec 5 | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 3 }
    }
    if ($ok) { Set-Content -Path $failFile -Value '0' -Encoding ASCII; Log '[重启成功] 服务已恢复应答' }
    else { Log '[重启存疑] 服务已执行重启但 38 秒内无应答，请人工查看：services.msc → ' + $SvcName + ' · 日志 data\logs\service-error.log' }
  } catch {
    Log '[重启失败] ' + $_.Exception.Message + ' → 需人工处理：以管理员身份在 services.msc 重启 ' + $SvcName
  }
} finally {
  $mtx.ReleaseMutex(); $mtx.Dispose()
}
