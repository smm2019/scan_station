$files = @('一键安装.cmd','一键更新.cmd','迁移数据.cmd','打更新包.cmd')
$gbk = [System.Text.Encoding]::GetEncoding(936)
$utf8nobom = New-Object System.Text.UTF8Encoding($false)
foreach ($f in $files) {
  $c = [System.IO.File]::ReadAllText((Join-Path (Get-Location) $f), (New-Object System.Text.UTF8Encoding($false)))
  # 去掉 chcp 65001 行（65001下cmd解析多字节会截断命令）
  $c = ($c -split "`r?`n" | Where-Object { $_ -notmatch '^\s*chcp 65001' }) -join "`r`n"
  [System.IO.File]::WriteAllText((Join-Path (Get-Location) $f), $c, $gbk)
  $b = [System.IO.File]::ReadAllBytes((Join-Path (Get-Location) $f))
  Write-Host ($f + ' → GBK, 无chcp行, 首行=' + $gbk.GetString($b).Split("`n")[0].Trim())
}
