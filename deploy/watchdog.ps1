# =====================================================================
# ㉖v108 WMAS 服务看门狗（不靠 AI、不靠人守的最后一层）
# 职责：每 5 分钟由任务计划程序调起。双重判活——
#   ① HTTP 应答：/api/health-ping 10 秒内答否（进程挂死/端口不通）
#   ② 循环心跳：应答了但 RCS 轮询心跳超阈值 = 进程假死（HTTP 活着、调度死了）
# 连续异常达阈值 → 重启 HSAuthServer 并留日志。单实例互斥：上一轮没跑完本轮直接退出。
# 阈值来源：优先用服务器 /api/health-ping 下发的面板现值（wdHbStaleSec/wdFailThreshold），
#   服务不通时回退本地默认——"活着时可调，死了仍有底线"，不破坏独立兜底定位。
# 安全阀：①心跳阈值实际=max(面板值, pollSec*2+60) 防轮询调大误杀；②重启硬限速 1 小时最多 2 次防无限循环；
#   ③判死/重启事件先写本地 pending，服务恢复后自动补报进「系统错误」页（服务死时上报不出去=延迟闭环）。
# 用法（注册一次，管理员 PowerShell）：powershell -File watchdog-register.ps1
# 手动跑一轮（测试/应急）：powershell -File watchdog.ps1 [-Port 8099]
# =====================================================================
param(
  [string]$Port = '8099',
  [string]$SvcName = 'HSAuthServer',
  [int]$HbStaleSec = 180,      # 本地默认心跳阈值（服务器面板值优先）
  [int]$FailThreshold = 3      # 本地默认重启阈值（服务器面板值优先）
)
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {} # 中文日志经 stdout 传出必须 UTF-8（否则被按 GBK 码页读出乱码）
$dir = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $dir 'watchdog.log'
$failFile = Join-Path $dir 'watchdog-fail.count'
$pendingFile = Join-Path $dir 'watchdog-pending.jsonl'
$restartFile = Join-Path $dir 'watchdog-restarts.json'

function Log($msg) {
  $line = (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + ' ' + $msg
  Add-Content -Path $log -Value $line -Encoding UTF8
  Write-Host $line
}
function NowMs { return [DateTimeOffset]::Now.ToUnixTimeMilliseconds() }

# ---- 上报：服务在→直发；服务不在→入 pending 队列，下轮恢复后补报 ----
function Send-Report($act, $detail) {
  $body = @{ act = $act; detail = $detail } | ConvertTo-Json -Compress
  try {
    Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/api/watchdog/report') -Method Post -ContentType 'application/json; charset=utf-8' -Body ([System.Text.Encoding]::UTF8.GetBytes($body)) -TimeoutSec 3 | Out-Null
    return $true
  } catch { return $false }
}
function Write-Pending($act, $detail) {
  $line = @{ act = $act; detail = $detail; ts = (NowMs) } | ConvertTo-Json -Compress
  Add-Content -Path $pendingFile -Value $line -Encoding UTF8
}
function Flush-Pending {
  if (-not (Test-Path $pendingFile)) { return }
  $lines = @(Get-Content -LiteralPath $pendingFile -Encoding UTF8 | Where-Object { $_.Trim() -ne '' })
  if (-not $lines.Count) { Remove-Item -LiteralPath $pendingFile -Force; return }
  $remain = @()
  foreach ($l in $lines) {
    $o = $null
    try { $o = $l | ConvertFrom-Json } catch { continue } # 坏行丢弃
    if (-not (Send-Report $o.act $o.detail)) { $remain += $l } # 仍失败留待下轮
  }
  if ($remain.Count) { Set-Content -LiteralPath $pendingFile -Value $remain -Encoding UTF8 }
  else { Remove-Item -LiteralPath $pendingFile -Force }
}

# ---- 重启限速：1 小时窗口内最多 2 次，超限拒绝并记 restart_limit ----
function Test-RateLimit {
  $now = NowMs
  $arr = @()
  if (Test-Path $restartFile) {
    try { $raw = (Get-Content -LiteralPath $restartFile -Raw).Trim(); if ($raw) { $arr = @($raw | ConvertFrom-Json) } } catch { $arr = @() }
  }
  $arr = @($arr | Where-Object { $_ -and (($now - [int64]$_) -lt 3600000) })
  if ($arr.Count -ge 2) {
    if ($arr.Count) { Set-Content -LiteralPath $restartFile -Value ($arr | ConvertTo-Json -Compress) -Encoding ASCII } else { Set-Content -LiteralPath $restartFile -Value '[]' -Encoding ASCII }
    return $false
  }
  $arr += $now
  Set-Content -LiteralPath $restartFile -Value ($arr | ConvertTo-Json -Compress) -Encoding ASCII
  return $true
}

# ---- 单实例互斥（防任务计划重叠执行） ----
$mtx = New-Object System.Threading.Mutex($false, 'Global\HSWmasWatchdog')
if (-not $mtx.WaitOne(0)) { Log '[跳过] 上一轮看门狗仍在运行'; exit 0 }
try {
  $prevFail = 0
  if (Test-Path $failFile) { [int]::TryParse((Get-Content $failFile -Raw).Trim(), [ref]$prevFail) | Out-Null }

  $bad = $false; $why = ''; $act = ''
  $hbStale = $HbStaleSec; $failTh = $FailThreshold
  try {
    $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/api/health-ping') -TimeoutSec 10
    # 服务应答正常 → 先补报积压事件（这是"系统错误页可见"的关键：只有服务活着才报得出去）
    Flush-Pending
    $poll = 20; if ($r.pollSec) { $poll = [int]$r.pollSec }
    if ($r.wd) {
      if ($r.wd.hbStaleSec) { $hbStale = [int]$r.wd.hbStaleSec }
      if ($r.wd.failThreshold) { $failTh = [int]$r.wd.failThreshold }
    }
    $effHb = [Math]::Max($hbStale, ($poll * 2 + 60)) # 防轮询间隔被调大后误杀正常服务
    $rcsAge = [int]$r.hb.rcsAgeS
    $inspAge = [int]$r.hb.inspAgeS
    if ($r.uptime -gt 300) {
      if ($rcsAge -lt 0 -or $rcsAge -gt $effHb) { $bad = $true; $act = 'hb_stale'; $why = 'RCS轮询心跳异常（' + $rcsAge + '秒>阈值' + $effHb + '）' }
      elseif ($inspAge -lt 0 -or $inspAge -gt 90) { $bad = $true; $act = 'hb_stale'; $why = '检验状态机心跳异常（' + $inspAge + '秒>90）' }
    }
    if (-not $bad) { Log ('[OK] 应答正常 · RCS心跳' + $rcsAge + 's · 检验心跳' + $inspAge + 's · 近1分' + $r.req1m + '请求 · 阈值' + $effHb + 's/重启' + $failTh + '次') }
  } catch {
    $bad = $true; $act = 'no_http'; $why = 'HTTP无应答：' + $_.Exception.Message.Split("`n")[0]
  }

  if (-not $bad) {
    if ($prevFail -gt 0) { Set-Content -Path $failFile -Value '0' -Encoding ASCII; Log '[恢复] 异常计数清零' }
    exit 0
  }

  $fails = $prevFail + 1
  Set-Content -Path $failFile -Value ([string]$fails) -Encoding ASCII
  Log ('[异常 ' + $fails + '/' + $failTh + '] ' + $why)
  if ($fails -lt $failTh) { exit 0 } # 未达阈值：只记录不动手

  # ---- 达阈值：记触发原因，判限速，重启 ----
  Write-Pending $act ($why + '（连续' + $fails + '次，触发重启）')
  if (-not (Test-RateLimit)) {
    Write-Pending 'restart_limit' ($why + ' · 1小时内已重启2次仍异常，停止自动救援')
    Log '[限速] 1小时内已重启2次仍持续异常，不再自动重启 → 需人工介入：services.msc → ' + $SvcName + ' · 日志 data\logs\service-error.log'
    exit 0
  }
  Log ('[重启] 连续' + $fails + '次异常，重启服务 ' + $SvcName)
  try {
    Restart-Service -Name $SvcName -Force -ErrorAction Stop
    Start-Sleep -Seconds 8
    $ok = $false
    for ($i = 0; $i -lt 10; $i++) {
      try { Invoke-RestMethod -Uri ('http://127.0.0.1:' + $Port + '/api/health') -TimeoutSec 5 | Out-Null; $ok = $true; break } catch { Start-Sleep -Seconds 3 }
    }
    if ($ok) {
      Set-Content -Path $failFile -Value '0' -Encoding ASCII
      Log '[重启成功] 服务已恢复应答'
      Write-Pending 'restart_ok' ($why + ' → 已自动重启并恢复应答，异常计数清零')
      Flush-Pending # 服务刚活，立即补报本轮全部事件
    } else {
      Log '[重启存疑] 服务已执行重启但 38 秒内无应答，请人工查看：services.msc → ' + $SvcName + ' · 日志 data\logs\service-error.log'
      Write-Pending 'restart_fail' ($why + ' → 已执行重启但服务仍无应答，需人工核查')
    }
  } catch {
    Log '[重启失败] ' + $_.Exception.Message + ' → 需人工处理：以管理员身份在 services.msc 重启 ' + $SvcName
    Write-Pending 'restart_fail' ('重启命令执行失败：' + $_.Exception.Message.Split("`n")[0] + '（触发原因：' + $why + '）')
  }
} finally {
  $mtx.ReleaseMutex(); $mtx.Dispose()
}
