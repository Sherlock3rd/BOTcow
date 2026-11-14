$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $ProjectRoot "runtime"
$PidPath = Join-Path $RuntimeDir "listener.pid"
$StatusPath = Join-Path $RuntimeDir "listener-status.json"
$ListenerPath = Join-Path $PSScriptRoot "lark-event-listener.mjs"

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

function Test-ListenerProcess {
    param([int]$ProcessId)

    if ($ProcessId -le 0) { return $false }
    $Process = Get-CimInstance Win32_Process -Filter "ProcessId=$ProcessId" -ErrorAction SilentlyContinue
    if ($null -eq $Process) { return $false }
    return $Process.Name -eq "node.exe" -and $Process.CommandLine -like "*$ListenerPath*"
}

if (Test-Path -LiteralPath $PidPath) {
    $ExistingPid = [int](Get-Content -LiteralPath $PidPath -Raw)
    if (Test-ListenerProcess -ProcessId $ExistingPid) {
        Write-Output "Bridge already running (PID $ExistingPid)."
        exit 0
    }
    Remove-Item -LiteralPath $PidPath -Force -ErrorAction SilentlyContinue
}

# A previous crash can leave a ready snapshot behind. It must not satisfy the
# readiness check for the new process.
Remove-Item -LiteralPath $StatusPath -Force -ErrorAction SilentlyContinue

$Process = Start-Process `
    -FilePath "node.exe" `
    -ArgumentList @("`"$ListenerPath`"") `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -PassThru

for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {
    Start-Sleep -Milliseconds 200
    if (Test-Path -LiteralPath $StatusPath) {
        $Status = Get-Content -LiteralPath $StatusPath -Raw | ConvertFrom-Json
        if ($Status.status -eq "ready" -and [int]$Status.pid -eq $Process.Id -and -not $Process.HasExited) {
            Write-Output "Bridge ready (PID $($Process.Id))."
            exit 0
        }
        if ($Status.status -eq "error") {
            throw "Bridge failed: $($Status.error)"
        }
    }
}

if (-not $Process.HasExited) {
    Stop-Process -Id $Process.Id -Force -ErrorAction SilentlyContinue
}
throw "Bridge did not become ready within 10 seconds."
