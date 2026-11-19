#requires -Version 5.1
param([Parameter(Mandatory=$true)][ValidateSet('Backup','Restore')][string]$Action)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) { throw 'Wrong workspace' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')

$run = '75435c87-0a31-42b7-9761-738db6c5c866'
$source = 'flsd_main_adapter_test'
$destination = 'flsd_main_restore_test'
$schema = 'flsd_iso_' + $run.Replace('-','')
$appRole = 'flsd_iso_app_' + $run.Replace('-','')
$prefix = "artifacts\main-adapter-recovery-$run"
$creation = Read-MainCreationProof $root
$sourceReceipt = Assert-MainLocalPath (Join-Path $root "artifacts\main-adapter-isolated-installed-$run.json")
$report = Assert-MainLocalPath (Join-Path $root 'artifacts\main-adapter-diagnostic-0204fdea-fecd-4ad3-be21-725e2cd104ae.json')
$migration = Assert-MainLocalPath (Join-Path $root 'prisma\disposable-main-adapter.sql')
$archive = Assert-MainLocalPath (Join-Path $root "$prefix.dump")
$backup = Assert-MainLocalPath (Join-Path $root "$prefix-backup.json")
$node = (Get-Command node -ErrorAction Stop).Source
$cli = 'scripts/prepare-main-isolated-recovery.cjs'
$toolVersions = @{}
foreach ($tool in @('psql','pg_dump','pg_restore')) {
    $version = (& "C:\Program Files\PostgreSQL\18\bin\$tool.exe" --version) -join ''
    if ($LASTEXITCODE -ne 0 -or $version -notmatch '\(PostgreSQL\) 18\.7(?:\s|$)') { throw 'Recovery PostgreSQL client version mismatch' }
    $toolVersions[$tool] = $version
}

$installed = Get-Content -LiteralPath $sourceReceipt -Raw | ConvertFrom-Json
$connected = Get-Content -LiteralPath $report -Raw | ConvertFrom-Json
$sourceOid = ($creation.verifiedDatabases | Where-Object name -CEQ $source).oid
$destinationOid = ($creation.verifiedDatabases | Where-Object name -CEQ $destination).oid
if ($creation.runId -cne 'b813e743-9f4c-4121-b8ab-b01ca51b9335' -or $sourceOid -cne '16394' -or $destinationOid -cne '16395' -or
    $installed.runId -cne $run -or $installed.parentRunId -cne $creation.runId -or $installed.schema -cne $schema -or
    $installed.appRole -cne $appRole -or $installed.schemaOid -cne '16783' -or $installed.appOid -cne '16782' -or
    $connected.kind -cne 'SANITIZED_MAIN_ADAPTER_RESULT' -or $connected.mode -cne 'CONNECTED_TESTS' -or $connected.exitCode -ne 0 -or
    $connected.tests.passed -ne 12 -or $connected.tests.failed -ne 0 -or $connected.tests.skipped -ne 0 -or
    $creation.migrationSha256 -cne '0B73853CB8A5D82651785FF35C9C9F9DC898205429C3AAE50708A1A7E8426FDC' -or
    (Get-FileHash -LiteralPath $migration).Hash -cne $creation.migrationSha256) { throw 'Recovery provenance mismatch' }

$manifestSql = (& $node $cli manifest) -join "`n"
if ($LASTEXITCODE -ne 0 -or !$manifestSql) { throw 'Manifest SQL preparation failed' }
$sessionSettings = @'
SET LOCAL search_path TO pg_catalog;
SET LOCAL timezone TO 'UTC';
SET LOCAL datestyle TO 'ISO, YMD';
'@
$targetGuard = @"
IF current_setting('server_version_num')::int<>180007 OR NOT EXISTS(
 SELECT 1 FROM pg_roles r WHERE r.rolname='$appRole' AND r.oid=16782::oid AND r.rolcanlogin
  AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
  AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
  AND shobj_description(r.oid,'pg_authid')='FLSD_ISOLATED_APP:$($creation.runId):$run'
) THEN RAISE EXCEPTION 'Recovery server or application role mismatch'; END IF;
"@
$sourceGuard = (Get-MainIdentityGuardSql $creation $source $false) + @"

DO `$recovery`$ BEGIN
$targetGuard
IF NOT EXISTS (
 SELECT 1 FROM pg_namespace n WHERE n.nspname='$schema' AND n.oid=16783::oid
  AND n.nspowner='$($creation.expectedOwner)'::regrole
  AND obj_description(n.oid,'pg_namespace')='FLSD_ISOLATED:$($creation.runId):${run}:$schema'
) THEN RAISE EXCEPTION 'Recovery source schema mismatch'; END IF;
END `$recovery`$;
"@
$destinationRestriction = @"
IF has_database_privilege('$appRole',current_database(),'CONNECT,TEMPORARY') THEN
 RAISE EXCEPTION 'Source application role can access restore database';
END IF;
"@
function Get-DestinationGuard([bool]$Pristine) {
    $absence = if ($Pristine) { "IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='$schema') THEN RAISE EXCEPTION 'Recovery schema already exists'; END IF;" }
    (Get-MainIdentityGuardSql $creation $destination $Pristine) + @"

DO `$recovery`$ BEGIN
$targetGuard
$destinationRestriction
$absence
END `$recovery`$;
"@
}
function Invoke-RecoveryRead([string]$Database,[string]$Sql) {
    $result = Invoke-MainPg -Tool psql -User $creation.adminUser -Database $Database -Interactive -ReadOnly `
        -Extra @('-qAt','-c',($Sql -replace '[\r\n]+',' '))
    if ($result.ExitCode -ne 0) { throw 'Recovery read-only check failed' }
    $result.Output.Trim()
}
function Assert-Manifest([string]$Text) {
    $value = ConvertFrom-Json -InputObject $Text
    if ($value.integrity -ne $true -or $value.revision -notmatch '^[0-9]+$' -or $value.catalogSha256 -cnotmatch '^[0-9a-f]{64}$' -or
        (($value.data.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'actors,audit,history,meta,operations,records,sessions,workspace') {
        throw 'Recovery source manifest failed validation'
    }
    foreach ($table in $value.data.PSObject.Properties) {
        $entry = $table.Value
        if ($entry -isnot [array] -or $entry.Count -ne 2 -or $entry[0] -notmatch '^[0-9]+$' -or $entry[1] -cnotmatch '^[0-9a-f]{64}$') {
            throw 'Recovery table manifest failed validation'
        }
    }
}
function Write-RecoverySql([string]$Path,[string]$Sql) {
    $file = [IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
    try {
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Sql)
        $file.Write($bytes,0,$bytes.Length)
        $file.Flush($true)
    } finally { $file.Dispose() }
}

if ($Action -eq 'Backup') {
    $attempt = Assert-MainLocalPath (Join-Path $root "$prefix-backup-attempt.json")
    foreach ($path in @($attempt,$archive,$backup)) { if (Test-Path -LiteralPath $path) { throw 'Prior backup evidence exists; stop' } }
    $pristine = Get-DestinationGuard $true
    $null = Invoke-RecoveryRead $destination "BEGIN READ ONLY; $sessionSettings $pristine ROLLBACK;"
    Write-MainExclusiveJson $attempt @{runId=$run;sourceOid=$sourceOid;status='BACKUP_ATTEMPT_STARTED'}

    $psql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
    $info = New-MainPgProcessInfo $psql @('-X','-qAt','-W','-v','ON_ERROR_STOP=on','-h','127.0.0.1','-p','5432','-U',$creation.adminUser,'-d',$source,'-f','-') -ReadOnly
    $info.RedirectStandardInput = $true
    $info.EnvironmentVariables['PGOPTIONS'] += ' -c idle_in_transaction_session_timeout=300000'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $timer = [Diagnostics.Stopwatch]::StartNew()
    $started = $false
    try {
        $started = $process.Start()
        $snapshotSql = "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;`n$sessionSettings`n$sourceGuard`n$manifestSql;`nSELECT pg_export_snapshot();`n"
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($snapshotSql)
        $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
        $process.StandardInput.BaseStream.Flush()
        $line = $process.StandardOutput.ReadLineAsync()
        if (!$line.Wait(120000) -or !$line.Result) { throw 'Source manifest unavailable' }
        $manifest = $line.Result
        Assert-Manifest $manifest
        $line = $process.StandardOutput.ReadLineAsync()
        if (!$line.Wait(10000) -or $line.Result -cnotmatch '^[0-9A-F]+-[0-9A-F]+-[0-9]+$') { throw 'Exported snapshot unavailable' }
        $snapshot = $line.Result
        $reserved = [IO.File]::Open($archive,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
        try {
            $dump = Invoke-MainPg -Tool pg_dump -User $creation.adminUser -Database $source -Interactive -ReadOnly `
                -Extra @('-Fc','--encoding=UTF8','--no-acl','--no-statistics','--strict-names',"--schema=$schema","--snapshot=$snapshot",'-f',$archive)
            if ($dump.ExitCode -ne 0 -or $process.HasExited -or $reserved.Length -eq 0) { throw 'Snapshot backup failed' }
        } finally { $reserved.Dispose() }
        $finish = [Text.Encoding]::ASCII.GetBytes("ROLLBACK;`n")
        $process.StandardInput.BaseStream.Write($finish,0,$finish.Length)
        $process.StandardInput.BaseStream.Flush()
        $process.StandardInput.Close()
        if (!$process.WaitForExit(10000) -or $process.ExitCode -ne 0) { throw 'Source session did not close cleanly' }
    } finally {
        if ($started -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
    $timer.Stop()
    Write-MainExclusiveJson $backup @{runId=$run;sourceOid=$sourceOid;destinationOid=$destinationOid;schema=$schema;
        archiveSha256=(Get-FileHash -LiteralPath $archive).Hash;manifest=$manifest;backupMilliseconds=$timer.ElapsedMilliseconds;
        serverVersion='18.7';toolVersions=$toolVersions}
    Write-Output 'ISOLATED_RECOVERY_BACKUP_VERIFIED'
    return
}

$receipt = Assert-MainLocalPath (Join-Path $root "$prefix-restored.json")
$restoreAttempt = Assert-MainLocalPath (Join-Path $root "$prefix-restore-attempt.json")
$archiveList = Assert-MainLocalPath (Join-Path $root "$prefix.toc")
$archiveData = Assert-MainLocalPath (Join-Path $root "$prefix.data.sql")
$bodyPath = Assert-MainLocalPath (Join-Path $root "$prefix.body.sql")
$beforePath = Assert-MainLocalPath (Join-Path $root "$prefix.before.sql")
$afterPath = Assert-MainLocalPath (Join-Path $root "$prefix.after.sql")
foreach ($path in @($receipt,$restoreAttempt,$archiveList,$archiveData,$bodyPath,$beforePath,$afterPath)) {
    if (Test-Path -LiteralPath $path) { throw 'Prior restore evidence exists; stop' }
}
$saved = Get-Content -LiteralPath $backup -Raw | ConvertFrom-Json
if ($saved.runId -cne $run -or $saved.sourceOid -cne $sourceOid -or $saved.destinationOid -cne $destinationOid -or
    $saved.schema -cne $schema -or $saved.archiveSha256 -cnotmatch '^[A-F0-9]{64}$') { throw 'Backup evidence mismatch' }
Assert-Manifest $saved.manifest
$lockedArchive = [IO.File]::Open($archive,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
    if ((Get-FileHash -InputStream $lockedArchive).Hash -cne $saved.archiveSha256) { throw 'Archive hash mismatch' }
    Write-MainExclusiveJson $restoreAttempt @{runId=$run;destinationOid=$destinationOid;archiveSha256=$saved.archiveSha256;status='RESTORE_ATTEMPT_STARTED'}
    $list = Invoke-MainPg -Tool pg_restore -User $creation.adminUser -Database $destination -LocalArchiveOnly -Extra @('-l','-f',$archiveList,$archive)
    if ($list.ExitCode -ne 0) { throw 'Archive listing failed' }
    $decode = Invoke-MainPg -Tool pg_restore -User $creation.adminUser -Database $destination -LocalArchiveOnly `
        -Extra @('--data-only','--no-owner','--no-acl','--no-statistics','-f',$archiveData,$archive)
    if ($decode.ExitCode -ne 0) { throw 'Archive data decode failed' }
    & $node $cli restore-body "$prefix.toc" "$prefix.data.sql" $creation.expectedOwner
    if ($LASTEXITCODE -ne 0) { throw 'Archive validation failed' }
} finally { $lockedArchive.Dispose() }

$preRestore = Get-DestinationGuard $true
$postRestore = Get-DestinationGuard $false
$schemaVerification = @"
DO `$restored_schema`$ BEGIN
IF NOT EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname='$schema'
 AND n.nspowner='$($creation.expectedOwner)'::regrole
 AND obj_description(n.oid,'pg_namespace')='FLSD_ISOLATED:$($creation.runId):${run}:$schema')
 OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a WHERE n.nspname='$schema' AND a.grantee<>n.nspowner)
 OR EXISTS(SELECT 1 FROM pg_class c LEFT JOIN LATERAL aclexplode(c.relacl) a ON true WHERE c.relnamespace='$schema'::regnamespace
   AND (c.relowner<>'$($creation.expectedOwner)'::regrole OR a.grantee<>c.relowner))
 OR EXISTS(SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
   WHERE p.pronamespace='$schema'::regnamespace AND (p.proowner<>'$($creation.expectedOwner)'::regrole OR a.grantee<>p.proowner))
THEN RAISE EXCEPTION 'Restored owner or ACL mismatch'; END IF;
END `$restored_schema`$;
"@
$manifestHex = [BitConverter]::ToString([Text.UTF8Encoding]::new($false).GetBytes($saved.manifest)).Replace('-','')
Write-RecoverySql $beforePath "$sessionSettings`n$preRestore`nSELECT pg_advisory_xact_lock(176661,2);`n$preRestore`nSET LOCAL ROLE $($creation.expectedOwner);`n"
Write-RecoverySql $afterPath @"
RESET ROLE;
$postRestore
$schemaVerification
DO `$compare`$ BEGIN
IF ($manifestSql) IS DISTINCT FROM convert_from(decode('$manifestHex','hex'),'UTF8')::jsonb THEN
 RAISE EXCEPTION 'Recovered data does not match backup manifest';
END IF;
END `$compare`$;
"@
$verifiedHashes = @{}
$locks = @()
$timer = [Diagnostics.Stopwatch]::StartNew()
try {
    foreach ($path in @($beforePath,$bodyPath,$afterPath)) {
        $lock = [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $locks += $lock
        $verifiedHashes[[IO.Path]::GetFileName($path)] = (Get-FileHash -InputStream $lock).Hash
    }
    $restore = Invoke-MainPg -Tool psql -User $creation.adminUser -Database $destination -Interactive `
        -Extra @('-qAt','--single-transaction','-f',$beforePath,'-f',$bodyPath,'-f',$afterPath)
    if ($restore.ExitCode -ne 0) { throw 'Restore failed or commit uncertain; preserve evidence' }
} finally { foreach ($lock in $locks) { $lock.Dispose() } }
$timer.Stop()
$restoreMs = $timer.ElapsedMilliseconds
$timer.Restart()
$actual = Invoke-RecoveryRead $destination "BEGIN READ ONLY; $sessionSettings $postRestore $schemaVerification $manifestSql; SELECT '$schema'::regnamespace::oid; ROLLBACK;"
$lines = @($actual -split '\r?\n')
if ($lines.Count -ne 2 -or $lines[0] -cne $saved.manifest -or $lines[1] -cnotmatch '^[1-9][0-9]{0,9}$' -or $lines[1] -ceq '16783') {
    throw 'Committed restore manifest or identity mismatch; preserve evidence'
}
$null = Invoke-RecoveryRead $source "BEGIN READ ONLY; $sessionSettings $sourceGuard ROLLBACK;"
$timer.Stop()
$result = [ordered]@{status='ISOLATED_RECOVERY_REHEARSAL_VERIFIED';runId=$run;sourceOid=$sourceOid;destinationOid=$destinationOid;
    restoredSchemaOid=$lines[1];archiveSha256=$saved.archiveSha256;sqlSha256=$verifiedHashes;manifest=$lines[0];
    backupMilliseconds=$saved.backupMilliseconds;restoreMilliseconds=$restoreMs;verificationMilliseconds=$timer.ElapsedMilliseconds;toolVersions=$toolVersions}
Write-MainExclusiveJson $receipt $result
$result | ConvertTo-Json -Depth 8 -Compress
