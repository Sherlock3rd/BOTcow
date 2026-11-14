$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$WScript = (Get-Command wscript.exe -ErrorAction Stop).Source
$HiddenLauncher = Join-Path $PSScriptRoot "run-bridge-watchdog-hidden.vbs"
$TaskName = "botCow-FeishuBridge"

$Action = New-ScheduledTaskAction `
    -Execute $WScript `
    -Argument ('//B //NoLogo "{0}"' -f $HiddenLauncher) `
    -WorkingDirectory $Root
$LogonTrigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
$WatchdogTrigger = New-ScheduledTaskTrigger `
    -Once `
    -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
$Settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 2) `
    -MultipleInstances IgnoreNew `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries
$Principal = New-ScheduledTaskPrincipal `
    -UserId $env:USERNAME `
    -LogonType Interactive `
    -RunLevel Limited

Register-ScheduledTask `
    -TaskName $TaskName `
    -Action $Action `
    -Trigger @($LogonTrigger, $WatchdogTrigger) `
    -Settings $Settings `
    -Principal $Principal `
    -Description "botCow Feishu bridge hidden watchdog; starts at logon and checks the local listener every minute without invoking Codex or showing a console window." `
    -Force | Out-Null

$Task = Get-ScheduledTask -TaskName $TaskName
$Info = Get-ScheduledTaskInfo -TaskName $TaskName
[pscustomobject]@{
    ok = $true
    task_name = $Task.TaskName
    state = [string]$Task.State
    last_run_time = $Info.LastRunTime
    next_run_time = $Info.NextRunTime
    triggers = @("AtLogOn", "Local watchdog every 1 minute")
    user = $env:USERNAME
    watchdog_interval_minutes = 1
    invokes_codex_when_healthy = $false
    console_window = $false
} | ConvertTo-Json
