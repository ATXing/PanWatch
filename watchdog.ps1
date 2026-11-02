# PanWatch watchdog - run by Windows Task Scheduler ("PanWatch" task).
# Behaviour: if port 8123 is already listening, exit at once. Otherwise run
# uvicorn in the foreground so the scheduled task stays "Running" while the
# service is alive; when the service dies the task ends and the next 3-minute
# trigger relaunches it. Keep this file ASCII-only (PowerShell 5.1 reads
# non-BOM UTF-8 as ANSI).
#
# Manual controls:
#   Get-ScheduledTask PanWatch | Stop-ScheduledTask      # stop the service
#   Disable-ScheduledTask -TaskName PanWatch             # stop the keeper
#   Start-ScheduledTask -TaskName PanWatch               # start now
# Logs: logs\watchdog.log (keeper actions), logs\service.log (uvicorn output)

$ErrorActionPreference = "Continue"
$base   = "D:\Projects\PanWatch"
$logDir = Join-Path $base "logs"
$log    = Join-Path $logDir "watchdog.log"
$svcLog = Join-Path $logDir "service.log"
$utf8   = New-Object System.Text.UTF8Encoding($false)

if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

function Write-Log([string]$msg) {
    $line = "[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg + "`r`n"
    [System.IO.File]::AppendAllText($log, $line, $utf8)
}

function Trim-Log([string]$path, [int]$keep) {
    try {
        if (Test-Path $path) {
            $fi = Get-Item $path
            if ($fi.Length -gt 5MB) {
                $lines = [System.IO.File]::ReadAllLines($path, [System.Text.Encoding]::UTF8)
                if ($lines.Length -gt $keep) { $lines = $lines[($lines.Length - $keep)..($lines.Length - 1)] }
                [System.IO.File]::WriteAllLines($path, $lines, $utf8)
            }
        }
    } catch { }
}

# --- 1. already running? nothing to do -------------------------------------
$listen = $null
try {
    $listen = Get-NetTCPConnection -LocalPort 8123 -State Listen -ErrorAction SilentlyContinue
} catch {
    $listen = $null
}
if ($null -ne $listen) {
    Write-Log ("skip: 8123 already listening (pid " + (($listen | ForEach-Object { $_.OwningProcess }) -join ',') + ")")
    exit 0
}

# --- 2. prepare environment -------------------------------------------------
# Proxy env vars are cleared ON PURPOSE: domestic data sources (eastmoney /
# tencent / sina / baostock) must go direct -- routing them through a foreign
# node is slower and far more likely to be rate limited.
# yfinance is the single exception: requests does NOT read the Windows system
# proxy, and Yahoo answers direct (CN) requests with HTTP 403 -- which yfinance
# mislabels as YFRateLimitError. So the tradingagents adapter attaches the
# proxy to yfinance only: runtime_support.configure_yfinance_proxy() sets
# yf.config.network.proxy (override via PANWATCH_YF_PROXY).
# Do NOT "unify" this by exporting HTTP_PROXY here.
Set-Location $base
$env:http_proxy  = ""
$env:https_proxy = ""
$env:HTTP_PROXY  = ""
$env:HTTPS_PROXY = ""
$env:ALL_PROXY   = ""
$env:all_proxy   = ""
$env:NO_PROXY    = "localhost,127.0.0.1"
# GTK3 runtime for WeasyPrint PDF export (pango / cairo / gobject DLLs)
$env:PATH = (Join-Path $base ".gtk3\bin") + ";" + $env:PATH
$env:PYTHONIOENCODING = "utf-8"
$env:PYTHONUTF8 = "1"

$py = Join-Path $base ".venv\Scripts\python.exe"
if (-not (Test-Path $py)) {
    Write-Log ("error: python not found at " + $py)
    exit 2
}

if (-not (Test-Path $svcLog)) {
    [System.IO.File]::WriteAllText($svcLog, "", $utf8)
}
Trim-Log $log 2000
Trim-Log $svcLog 5000

# --- 3. start (foreground, so the task tracks the service lifetime) --------
Write-Log ("start: launching uvicorn on 127.0.0.1:8123, pid owner will be this task")
Write-Log ("boot marker written to " + $svcLog)

# cmd handles the redirection, so the child keeps its own byte encoding (UTF-8)
$cli = "`"$py`" -m uvicorn server:app --host 0.0.0.0 --port 8123 >> `"$svcLog`" 2>&1"
[System.IO.File]::AppendAllText($svcLog, ("===== " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " boot =====`r`n"), $utf8)

try {
    & cmd.exe /c $cli
    $code = $LASTEXITCODE
} catch {
    Write-Log ("error: launch failed - " + $_.Exception.Message)
    [System.IO.File]::AppendAllText($svcLog, ("[" + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] launch failed: " + $_.Exception.Message + "`r`n"), $utf8)
    exit 3
}

Write-Log ("exit: uvicorn returned code " + $code)
[System.IO.File]::AppendAllText($svcLog, ("===== " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + " exited, code " + $code + " =====`r`n"), $utf8)
exit $code
