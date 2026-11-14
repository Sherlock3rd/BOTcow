$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$RuntimeDir = Join-Path $ProjectRoot "runtime"
$LogPath = Join-Path $RuntimeDir "bridge-watchdog.log"
$StartScript = Join-Path $PSScriptRoot "start-bridge.ps1"

New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null

function Write-WatchdogLog {
    param([string]$Message)
    Add-Content -LiteralPath $LogPath -Encoding UTF8 -Value ("[{0:o}] {1}" -f (Get-Date), $Message)
}

try {
    $Output = & $StartScript 2>&1
    Write-WatchdogLog (($Output | ForEach-Object { $_.ToString() }) -join " ")
    exit 0
} catch {
    Write-WatchdogLog ("ERROR: {0}" -f $_.Exception.Message)
    throw
}
