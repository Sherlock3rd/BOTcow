$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $ProjectRoot "runtime"
$PidPath = Join-Path $RuntimeDir "listener.pid"
$StopPath = Join-Path $RuntimeDir "stop.requested"

if (-not (Test-Path -LiteralPath $PidPath)) {
    Write-Output "Bridge is not running."
    exit 0
}

$ListenerPid = [int](Get-Content -LiteralPath $PidPath -Raw)
Set-Content -LiteralPath $StopPath -Value "stop" -Encoding ASCII

for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {
    Start-Sleep -Milliseconds 200
    if (-not (Get-Process -Id $ListenerPid -ErrorAction SilentlyContinue)) {
        Write-Output "Bridge stopped."
        exit 0
    }
}

throw "Bridge did not stop gracefully within 10 seconds."
