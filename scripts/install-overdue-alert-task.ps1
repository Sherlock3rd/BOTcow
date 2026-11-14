$ErrorActionPreference = "Stop"

$Root = Split-Path -Parent $PSScriptRoot
$Node = (Get-Command node -ErrorAction Stop).Source
$Runner = Join-Path $Root "scripts\run-daily-overdue-alert.mjs"
$TaskName = "botCow-DailyOverdueAlert"

$Action = New-ScheduledTaskAction -Execute $Node -Argument ('"{0}"' -f $Runner) -WorkingDirectory $Root
$Trigger = New-ScheduledTaskTrigger -Weekly -WeeksInterval 1 -DaysOfWeek Monday,Tuesday,Wednesday,Thursday,Friday -At "10:00"
$Settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Minutes 10) -MultipleInstances IgnoreNew
$Principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $Action -Trigger $Trigger -Settings $Settings -Principal $Principal -Description "botCow weekday overdue requirement alert; holiday filtering is performed by the runner." -Force | Out-Null

$Task = Get-ScheduledTask -TaskName $TaskName
[pscustomobject]@{
    ok = $true
    task_name = $Task.TaskName
    state = [string]$Task.State
    next_run_time = (Get-ScheduledTaskInfo -TaskName $TaskName).NextRunTime
} | ConvertTo-Json
