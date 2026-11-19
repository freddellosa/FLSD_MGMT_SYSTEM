#requires -Version 5.1
[CmdletBinding()]
param([switch]$Install)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation') { throw 'Wrong workspace' }
$backup = 'D:\FLSD-Invoicing-Backups'
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$worker = Join-Path $PSScriptRoot 'invoicing-postgres-backup.cjs'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
$sid = $identity.User.Value
$today = [DateTimeOffset]::UtcNow.ToOffset([TimeSpan]::FromHours(8)).ToString('yyyy-MM-dd')
$tasks = [ordered]@{ 'FLSD-Invoicing-Backup-Midnight'='midnight'; 'FLSD-Invoicing-Backup-Noon'='noon' }
function Get-TaskXml($Slot,[string]$ProbeId='') {
    $time = if ($Slot -eq 'midnight') { '00:00:00' } else { '12:00:00' }
    $start = "${today}T${time}+08:00"
    $exe = [Security.SecurityElement]::Escape($node)
    $action = if ($ProbeId) { 'probe ' + $ProbeId } else { 'scheduled ' + $Slot }
    $args = [Security.SecurityElement]::Escape('"' + $worker + '" ' + $action)
    $working = [Security.SecurityElement]::Escape($backup)
    $trigger = if ($ProbeId) { '' } else {
        $catchupDelay = if ($Slot -eq 'midnight') { 'PT2M' } else { 'PT4M' }
        "<Triggers><CalendarTrigger><StartBoundary>$start</StartBoundary><EndBoundary>2099-01-01T00:00:00+08:00</EndBoundary><Enabled>true</Enabled><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger><LogonTrigger><Enabled>true</Enabled><UserId>$sid</UserId><Delay>$catchupDelay</Delay></LogonTrigger></Triggers>"
    }
    $enabled = if ($ProbeId) { 'true' } else { 'false' }
    return @"
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
 <RegistrationInfo><Description>FLSD isolated invoicing pilot backup ($Slot, Asia/Manila)</Description></RegistrationInfo>
 $trigger
 <Principals><Principal id="BackupUser"><UserId>$sid</UserId><LogonType>S4U</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals>
 <Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
  <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable>
  <AllowStartOnDemand>true</AllowStartOnDemand><Enabled>$enabled</Enabled><ExecutionTimeLimit>PT35M</ExecutionTimeLimit>
  <RestartOnFailure><Interval>PT5M</Interval><Count>2</Count></RestartOnFailure></Settings>
 <Actions Context="BackupUser"><Exec><Command>$exe</Command><Arguments>$args</Arguments><WorkingDirectory>$working</WorkingDirectory></Exec></Actions>
</Task>
"@
}
if (!$Install) {
    foreach ($name in $tasks.Keys) {
        $existing = Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue
        [pscustomobject]@{TaskName=$name;ObservedState=if ($existing) {$existing.State} else {'NotFoundOrUnreadable'};
            ProposedXml=(Get-TaskXml $tasks[$name])}
    }
    return
}
foreach ($name in $tasks.Keys) {
    if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw "Task already exists: $name" }
}
# Permit private local account, SYSTEM and Administrators access only. No ACL changes are made here.
foreach ($item in @($backup,(Join-Path $backup 'pgpass.conf'))) {
    $acl = Get-Acl -LiteralPath $item
    $rules = $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])
    $allowed = @($sid,'S-1-5-18','S-1-5-32-544')
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed) {
            throw 'Backup destination or credential has a broader ACL than allowed'
        }
    }
}
$gate = & $node $worker gate
if ($LASTEXITCODE -ne 0 -or $gate -cne 'BACKUP_RECOVERY_GATE_OK') { throw 'Controlled backup and recovery gate failed' }
$probeId = [guid]::NewGuid().ToString('N')
$probeName = 'FLSD-Invoicing-Backup-Probe-' + $probeId
$probePath = Join-Path $backup "probe-$probeId.json"
$probeRegistered = $false
try {
    Register-ScheduledTask -TaskName $probeName -Xml (Get-TaskXml 'probe' $probeId) -ErrorAction Stop | Out-Null
    $probeRegistered = $true
    Start-ScheduledTask -TaskName $probeName -ErrorAction Stop
    $deadline = [DateTime]::UtcNow.AddSeconds(50)
    while (!(Test-Path -LiteralPath $probePath -PathType Leaf) -and [DateTime]::UtcNow -lt $deadline) {
        Start-Sleep -Milliseconds 500
    }
    if (!(Test-Path -LiteralPath $probePath -PathType Leaf) -or
        (Get-Content -LiteralPath $probePath -Raw | ConvertFrom-Json).status -cne 'SCHEDULER_ACCOUNT_VERIFIED') {
        throw 'Scheduler account could not authenticate and write under its task identity'
    }
} finally {
    if ($probeRegistered) { Unregister-ScheduledTask -TaskName $probeName -Confirm:$false -ErrorAction Stop }
}
$registered = @()
try {
    foreach ($name in $tasks.Keys) {
        Register-ScheduledTask -TaskName $name -Xml (Get-TaskXml $tasks[$name]) -ErrorAction Stop | Out-Null
        $registered += $name
    }
    $activatedAt = [DateTimeOffset]::UtcNow
    foreach ($name in $registered) { Enable-ScheduledTask -TaskName $name -ErrorAction Stop | Out-Null }
    $runs = foreach ($name in $registered) {
        $slot = $tasks[$name]
        $taskBefore = Get-ScheduledTaskInfo -TaskName $name -ErrorAction Stop
        Start-ScheduledTask -TaskName $name -ErrorAction Stop
        $deadline = [DateTimeOffset]::UtcNow.AddMinutes(13)
        $result = $null
        do {
            Start-Sleep -Seconds 2
            $current = Get-ScheduledTask -TaskName $name -ErrorAction Stop
            $info = Get-ScheduledTaskInfo -TaskName $name -ErrorAction Stop
            if ($current.State -eq 'Running' -or $info.LastRunTime -le $taskBefore.LastRunTime -or $info.LastTaskResult -ne 0) { continue }
            $inventoryText = & $node $worker status
            if (!$inventoryText) { continue }
            $inventory = ConvertFrom-Json -InputObject $inventoryText
            $bundle = $inventory.items | Where-Object {
                $_.status -eq 'AVAILABLE' -and $_.slot -eq $slot -and [DateTimeOffset]::Parse($_.completedAt) -ge $activatedAt
            } | Select-Object -First 1
            if ($bundle) {
                $result = [pscustomobject]@{task=$name;lastTaskResult=$info.LastTaskResult;bundle=$bundle.bundle;nextRun=$info.NextRunTime}
            }
        } until ($result -or [DateTimeOffset]::UtcNow -ge $deadline)
        if (!$result) { throw "Actual scheduled backup did not verify: $name" }
        $result
    }
    $runs
} catch {
    foreach ($name in $registered) { Disable-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue | Out-Null }
    throw
}
