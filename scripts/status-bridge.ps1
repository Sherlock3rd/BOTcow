$ErrorActionPreference = "Stop"

$ProjectRoot = Split-Path -Parent $PSScriptRoot
node.exe (Join-Path $PSScriptRoot "bridge-queue.mjs") status
