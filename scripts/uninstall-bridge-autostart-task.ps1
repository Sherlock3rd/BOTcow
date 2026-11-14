$ErrorActionPreference = "Stop"

$TaskName = "botCow-FeishuBridge"
$Task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($null -eq $Task) {
    [pscustomobject]@{
        ok = $true
        task_name = $TaskName
        removed = $false
        reason = "not_found"
    } | ConvertTo-Json
    exit 0
}

Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
[pscustomobject]@{
    ok = $true
    task_name = $TaskName
    removed = $true
} | ConvertTo-Json
