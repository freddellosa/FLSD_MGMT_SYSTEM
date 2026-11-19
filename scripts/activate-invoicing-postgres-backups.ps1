#requires -Version 5.1
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$workspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($workspace -cne 'D:\FLSD-Batch7-Validation') { throw 'Wrong validation workspace' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$root = 'D:\FLSD-Invoicing-Backups'
$bin = 'C:\Program Files\PostgreSQL\18\bin'
$node = (Get-Command node.exe -CommandType Application -ErrorAction Stop).Source
$worker = Join-Path $PSScriptRoot 'invoicing-postgres-backup.cjs'
$activationReceipt = Assert-MainLocalPath (Join-Path $workspace 'artifacts\invoicing-backup-activation.json')
$cluster = Assert-MainLocalPath (Join-Path $workspace '.pilot\pgdata')
$pilot = 'flsd_pilot_validation'
$recovery = 'flsd_pilot_backup_recovery'
$lf = [string][char]10
if (!(Test-Path -LiteralPath (Join-Path $workspace '.pilot\setup-complete') -PathType Leaf) -or
    !(Test-Path -LiteralPath (Join-Path $workspace '.next-pilot\BUILD_ID') -PathType Leaf)) { throw 'Existing pilot cluster or build evidence missing' }
if ((Test-Path -LiteralPath $root) -or (Test-Path -LiteralPath $activationReceipt)) {
    throw 'Backup root or activation evidence already exists. Preserve it and reconcile before resuming.'
}
foreach ($task in @('FLSD-Invoicing-Backup-Midnight','FLSD-Invoicing-Backup-Noon')) {
    if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { throw "Backup task already exists: $task" }
}
function Read-Setting([string]$Name) {
    $value = & "$bin\postgres.exe" -D $cluster -C $Name
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing pilot configuration' }
    return $value
}
if ((Read-Setting 'port') -cne '55437' -or (Read-Setting 'listen_addresses') -cne '127.0.0.1' -or
    (Read-Setting 'data_directory').Replace('/','\') -ine $cluster) { throw 'Existing pilot cluster configuration mismatch' }
& "$bin\pg_ctl.exe" status -D $cluster | Out-Null
$clusterStatus = $LASTEXITCODE
& "$bin\pg_isready.exe" -q -h 127.0.0.1 -p 55437 -t 4
$ready = $LASTEXITCODE
if ($clusterStatus -eq 3 -and $ready -eq 2) {
    & "$bin\pg_ctl.exe" -D $cluster -l (Join-Path $workspace '.pilot\postgres.log') -w -t 20 start
    if ($LASTEXITCODE -ne 0) { throw 'Existing pilot failed to start; preserve its files and Windows error' }
} elseif ($clusterStatus -ne 0 -or $ready -ne 0) {
    throw 'Pilot PID and listener disagree; preserve the existing process and files'
}
try {
    $maintenancePath = Assert-MainLocalPath (Join-Path $workspace '.pilot\maintenance.json')
    $maintenance = [IO.File]::ReadAllText($maintenancePath) | ConvertFrom-Json
} catch {
    if ($_.Exception -isnot [UnauthorizedAccessException] -and $_.CategoryInfo.Category -ne 'PermissionDenied' -and
        $_.FullyQualifiedErrorId -notlike 'ItemExistsUnauthorizedAccessError*') { throw }
    $maintenance = $null
}
if ($maintenance) {
    if ($maintenance.marker -cne 'FLSD_ISOLATED_PILOT_ONLY' -or $maintenance.host -cne '127.0.0.1' -or
        $maintenance.port -ne 55437 -or $maintenance.database -cne $pilot -or $maintenance.user -cne 'flsd_pilot_admin' -or
        $maintenance.password -isnot [string] -or !$maintenance.password) { throw 'Private pilot maintenance identity mismatch' }
    $adminSecret = ConvertTo-SecureString $maintenance.password -AsPlainText -Force
    $maintenance = $null
} else {
    $adminSecret = Read-Host 'Password for the isolated 55437 flsd_pilot_admin account only' -AsSecureString
}
function Invoke-PilotAdmin([string]$Sql) {
    $info = New-MainPgProcessInfo "$bin\psql.exe" @('-X','-qAt','-w','-v','ON_ERROR_STOP=on',
        '-h','127.0.0.1','-p','55437','-U','flsd_pilot_admin','-d',$pilot,'-f','-')
    $info.RedirectStandardInput = $true
    $info.RedirectStandardError = $true
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $started = $false
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminSecret)
    try {
        $info.EnvironmentVariables['PGPASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        try { $started = $process.Start() }
        finally { $info.EnvironmentVariables.Remove('PGPASSWORD'); [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $out = $process.StandardOutput.ReadToEndAsync()
        $err = $process.StandardError.ReadToEndAsync()
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Sql+$lf)
        $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
        $process.StandardInput.Close()
        if (!$process.WaitForExit(30000)) { throw 'Pilot administration timed out; reconcile before retry' }
        $null = $err.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Pilot administration failed; preserve existing role and recovery evidence' }
        return $out.GetAwaiter().GetResult().Trim()
    } finally {
        if ($started -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}
$pilotGuard = @'
SET search_path=pg_catalog;
DO $scope$ BEGIN
 IF current_database()<>'flsd_pilot_validation' OR current_user<>'flsd_pilot_admin' OR current_user<>session_user
   OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet OR inet_server_port() IS DISTINCT FROM 55437
   OR pg_is_in_recovery() OR current_setting('server_version_num')::int/10000<>18
   OR NOT EXISTS(SELECT 1 FROM public.pilot_meta WHERE id=1 AND marker='FLSD_ISOLATED_PILOT_ONLY' AND schema_version=3)
 THEN RAISE EXCEPTION 'Pilot identity refused'; END IF;
END $scope$;
'@
function New-PrivateFolder([string]$Folder) {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $acl = [Security.AccessControl.DirectorySecurity]::new()
    $acl.SetOwner($identity.User)
    $acl.SetAccessRuleProtection($true,$false)
    foreach ($value in @($identity.User.Value,'S-1-5-18')) {
        $sid = [Security.Principal.SecurityIdentifier]::new($value)
        $rule = [Security.AccessControl.FileSystemAccessRule]::new($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
        $acl.AddAccessRule($rule)
    }
    [void][IO.Directory]::CreateDirectory($Folder,$acl)
}
function Write-PrivateNew([string]$File,[string]$Value) {
    $stream = [IO.File]::Open($File,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
    try {
        $data = [Text.UTF8Encoding]::new($false).GetBytes($Value)
        $stream.Write($data,0,$data.Length)
        $stream.Flush($true)
    } finally { $stream.Dispose() }
}
$recoveryPass = $null
try {
    $preflight = @'
SELECT jsonb_build_object('databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
 'roleExists',EXISTS(SELECT 1 FROM pg_roles WHERE rolname='flsd_pilot_backup'),
 'databaseExists',EXISTS(SELECT 1 FROM pg_database WHERE datname='flsd_pilot_backup_recovery'));
'@
    $before = Invoke-PilotAdmin ($pilotGuard+$lf+$preflight) | ConvertFrom-Json
    if ($before.roleExists -or $before.databaseExists -or $before.databaseOid -cnotmatch '^[1-9][0-9]{0,9}$') {
        throw 'Pilot backup role or recovery database already exists; refusing adoption'
    }
    New-PrivateFolder $root
    $salt = New-Object byte[] 16
    $random = New-Object byte[] 32
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    try { $rng.GetBytes($salt); $rng.GetBytes($random) } finally { $rng.Dispose() }
    $backupPassword = [BitConverter]::ToString($random).Replace('-','').ToLowerInvariant()
    $pbkdf = [Security.Cryptography.Rfc2898DeriveBytes]::new($backupPassword,$salt,4096,[Security.Cryptography.HashAlgorithmName]::SHA256)
    try { $salted = $pbkdf.GetBytes(32) } finally { $pbkdf.Dispose() }
    $hmac = [Security.Cryptography.HMACSHA256]::new($salted)
    $sha = [Security.Cryptography.SHA256]::Create()
    try {
        $storedKey = [Convert]::ToBase64String($sha.ComputeHash($hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes('Client Key'))))
        $serverKey = [Convert]::ToBase64String($hmac.ComputeHash([Text.Encoding]::ASCII.GetBytes('Server Key')))
    } finally { $hmac.Dispose(); $sha.Dispose() }
    $verifier = 'SCRAM-SHA-256$4096:' + [Convert]::ToBase64String($salt) + '$' + $storedKey + ':' + $serverKey
    $roleSql = [IO.File]::ReadAllText((Assert-MainLocalPath (Join-Path $PSScriptRoot 'sql\pilot-backup-role.sql')))
    if ($roleSql -notmatch '(?m)^COMMIT;\r?$') { throw 'Role setup transaction boundary missing' }
    $roleSql = $roleSql -replace '(?m)^COMMIT;\r?$', ("ALTER ROLE flsd_pilot_backup LOGIN PASSWORD '$verifier';"+$lf+'COMMIT;').Replace('$','$$')
    Write-PrivateNew (Join-Path $root 'pgpass.conf') ("127.0.0.1:55437:"+$pilot+":flsd_pilot_backup:"+$backupPassword+$lf)
    $backupPassword = $null
    $null = Invoke-PilotAdmin ($pilotGuard+$lf+$roleSql)
    $createRecovery = @'
SELECT pg_advisory_lock(55437,8043);
DO $new$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_database WHERE datname='flsd_pilot_backup_recovery') THEN
  RAISE EXCEPTION 'Recovery target already exists';
 END IF;
END $new$;
CREATE DATABASE flsd_pilot_backup_recovery TEMPLATE template0 ALLOW_CONNECTIONS false;
REVOKE CONNECT, TEMPORARY ON DATABASE flsd_pilot_backup_recovery FROM PUBLIC;
COMMENT ON DATABASE flsd_pilot_backup_recovery IS 'FLSD_PILOT_BACKUP_RECOVERY_ONLY';
ALTER DATABASE flsd_pilot_backup_recovery ALLOW_CONNECTIONS true;
SELECT jsonb_build_object('roleOid',(SELECT oid::text FROM pg_roles WHERE rolname='flsd_pilot_backup'),
 'recoveryOid',(SELECT oid::text FROM pg_database WHERE datname='flsd_pilot_backup_recovery'));
'@
    $destination = Invoke-PilotAdmin ($pilotGuard+$lf+$createRecovery)
    $metadata = @($destination -split '\r?\n' | Where-Object { $_ -match '^\{' })
    if ($metadata.Count -ne 1) { throw 'Recovery provenance output missing' }
    $ids = ConvertFrom-Json -InputObject $metadata[0]
    Write-PrivateNew (Join-Path $root 'pilot-config.json') (@{databaseOid=$before.databaseOid;roleOid=$ids.roleOid;recoveryOid=$ids.recoveryOid} | ConvertTo-Json -Compress)
    $controlled = & $node $worker controlled
    if ($LASTEXITCODE -ne 0) { throw 'Controlled backup failed; preserve evidence' }
    $bundle = (ConvertFrom-Json -InputObject $controlled).bundle

    $privateDirectory = Join-Path $root ('recovery-auth-' + [guid]::NewGuid().ToString('N'))
    New-PrivateFolder $privateDirectory
    $recoveryPass = Join-Path $privateDirectory 'pgpass.conf'
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminSecret)
    try {
        $password = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
        if ($password -match '[\r\n]') { throw 'Pilot admin password cannot be represented in a passfile' }
        $escaped = $password.Replace('\','\\').Replace(':','\:')
        Write-PrivateNew $recoveryPass ("127.0.0.1:55437:"+$recovery+":flsd_pilot_admin:"+$escaped+$lf)
    } finally {
        $password = $null
        $escaped = $null
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    }
    & $node $worker verify-recovery $bundle $recoveryPass
    if ($LASTEXITCODE -ne 0) { throw 'Controlled restore did not reconcile; task installation skipped' }
    Remove-Item -LiteralPath $recoveryPass -ErrorAction Stop
    $recoveryPass = $null

    $verifiedTasks = @(& (Join-Path $PSScriptRoot 'register-invoicing-backup-tasks.ps1') -Install)
    if ($verifiedTasks.Count -ne 2) { throw 'Expected two verified task execution receipts' }
    $qaUri = 'http://127.0.0.1:3001/pilot'
    try { $qa = Invoke-WebRequest -Uri $qaUri -UseBasicParsing -TimeoutSec 3 } catch { $qa = $null }
    if (!$qa) {
        $start = @{FilePath=$node;WorkingDirectory=$workspace;ArgumentList=@('scripts/run-pilot.cjs','start');
            WindowStyle='Hidden';RedirectStandardOutput=(Join-Path $root 'qa-preview.stdout.log');
            RedirectStandardError=(Join-Path $root 'qa-preview.stderr.log')}
        Start-Process @start
        $deadline = [DateTime]::UtcNow.AddSeconds(30)
        do {
            Start-Sleep -Seconds 1
            try { $qa = Invoke-WebRequest -Uri $qaUri -UseBasicParsing -TimeoutSec 3 } catch { $qa = $null }
        } until ($qa -or [DateTime]::UtcNow -ge $deadline)
    }
    $recovered = Get-Content -LiteralPath (Join-Path $root 'recovery-verified.json') -Raw | ConvertFrom-Json
    $receipt = [ordered]@{status='BACKUP_ACTIVATION_COMPLETE';at=[DateTimeOffset]::UtcNow.ToString('o');
        backupRoot=$root;controlledBundle=$bundle;recovery=$recovered;tasks=$verifiedTasks;qaUrl=$qaUri;qaReachable=[bool]$qa}
    Write-MainExclusiveJson $activationReceipt $receipt
    $receipt | ConvertTo-Json -Depth 5 -Compress
} finally {
    if ($recoveryPass -and (Test-Path -LiteralPath $recoveryPass -PathType Leaf)) {
        Remove-Item -LiteralPath $recoveryPass -ErrorAction Stop
    }
    $adminSecret.Dispose()
}
