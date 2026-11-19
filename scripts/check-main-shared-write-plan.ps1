#requires -Version 5.1
[CmdletBinding()]
param([switch]$Install)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) { throw 'Wrong workspace' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')

$database = 'flsd_main_adapter_test'
$owner = 'flsd_test_owner_b813e7439f4c'
$runId = 'b813e743-9f4c-4121-b8ab-b01ca51b9335'
$proof = Read-MainCreationProof $root
$databaseOid = ($proof.verifiedDatabases | Where-Object name -CEQ $database).oid
$ownerOid = ($proof.verifiedRoles | Where-Object name -CEQ $owner).oid
if ($proof.runId -cne $runId -or $databaseOid -cne '16394' -or $ownerOid -cne '16392' -or
    $proof.expectedOwner -cne $owner -or $proof.adminUser -cne 'postgres') {
    throw 'Shared-write creation proof mismatch'
}

$pins = [ordered]@{
    'shared-write-disposable-v1.sql' = '857763A89D1EC3FAEEC23E7F910928C6CCFF4A6EA79CC9CD7E864BD5D861BCE3'
    'shared-write-disposable-fixture-v1.sql' = '090B894BB098614725938BCC144E1C839389DEDC435B73B11612D8AD2A3BB9A6'
}
$schema = 'flsd_shared_write_rehearsal'
$role = 'flsd_shared_write_runner_75435c870a31'
$marker = 'FLSD_SYNTHETIC_SHARED_WRITE_V1:' + $runId
$paths = @{}
$streams = @()
try {
    foreach ($name in $pins.Keys) {
        $path = Assert-MainLocalPath (Join-Path $root ('prisma\production-review\' + $name))
        $stream = [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $streams += $stream
        if ((Get-FileHash -InputStream $stream -Algorithm SHA256).Hash -cne $pins[$name]) {
            throw ('Shared-write plan hash mismatch for ' + $name)
        }
        $paths[$name] = $path
    }

    $report = [ordered]@{
        status = 'SHARED_WRITE_PLAN_VERIFIED_OFFLINE'
        creationRunId = $runId
        database = $database
        databaseOid = $databaseOid
        schema = $schema
        appRole = $role
        sqlSha256 = $pins
    }
    if (!$Install) {
        $report.databaseCommandsExecuted = 0
        $report | ConvertTo-Json -Depth 4 -Compress
        return
    }

    $attempt = Assert-MainLocalPath (Join-Path $root 'artifacts\main-shared-write-install-attempt.json')
    $installed = Assert-MainLocalPath (Join-Path $root 'artifacts\main-shared-write-installed.json')
    if ((Test-Path -LiteralPath $attempt) -or (Test-Path -LiteralPath $installed)) {
        throw 'Prior shared-write installation evidence exists; stop for inspection'
    }
    $guard = Get-MainIdentityGuardSql $proof $database $false
    $preflight = @"
BEGIN READ ONLY;
SET LOCAL search_path TO pg_catalog;
$guard
DO `$names`$ BEGIN
 IF current_setting('server_version_num')<>'180007'
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='$schema')
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='$role')
 THEN RAISE EXCEPTION 'Shared-write preflight refused'; END IF;
END `$names`$;
ROLLBACK;
SELECT 'SHARED_WRITE_NAMES_UNUSED_READ_ONLY';
"@
    $finish = @"
DO `$credential`$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_authid WHERE rolname='$role' AND rolpassword LIKE 'SCRAM-SHA-256%')
 THEN RAISE EXCEPTION 'Shared-write password setup refused'; END IF;
END `$credential`$;
"@
    $verify = @"
SELECT json_build_object('schemaOid',n.oid::text,'roleOid',r.oid::text)
FROM pg_namespace n CROSS JOIN pg_roles r
WHERE n.nspname='$schema' AND n.nspowner=16392::oid AND obj_description(n.oid,'pg_namespace')='$marker'
  AND r.rolname='$role' AND shobj_description(r.oid,'pg_authid')='$marker';
"@
    $report.status = 'SHARED_WRITE_INSTALL_ATTEMPT_STARTED'
    Write-MainExclusiveJson $attempt $report
    $result = Invoke-MainPg -Tool psql -User $proof.adminUser -Database $database -Interactive -Extra @(
        '-qAt','-c',($preflight -replace '[\r\n]+',' '),
        '-f',$paths['shared-write-disposable-v1.sql'],
        '-c',"SET LOCAL ROLE $owner;",
        '-f',$paths['shared-write-disposable-fixture-v1.sql'],
        '-c',"RESET ROLE; SET LOCAL password_encryption TO 'scram-sha-256';",
        '-c',("\password $role"),
        '-c',($finish -replace '[\r\n]+',' '),'-c','COMMIT;',
        '-c',($verify -replace '[\r\n]+',' ')
    )
    $rows = @($result.Output -split '\r?\n' | Where-Object { $_.Trim() })
    if ($result.ExitCode -ne 0 -or $rows.Count -ne 2 -or $rows[0] -cne 'SHARED_WRITE_NAMES_UNUSED_READ_ONLY') {
        throw 'Shared-write installation failed or outcome is uncertain; preserve attempt'
    }
    $receipt = ConvertFrom-Json -InputObject $rows[1]
    foreach ($oid in @($receipt.schemaOid,$receipt.roleOid)) {
        if ($oid -isnot [string] -or $oid -cnotmatch '^[1-9][0-9]{0,9}$' -or [uint64]$oid -gt [uint32]::MaxValue) {
            throw 'Shared-write receipt OID invalid'
        }
    }
    $report.status = 'SHARED_WRITE_INSTALLED'
    $report.schemaOid = $receipt.schemaOid
    $report.roleOid = $receipt.roleOid
    Write-MainExclusiveJson $installed $report
    $report | ConvertTo-Json -Depth 4 -Compress
} finally {
    foreach ($stream in $streams) { $stream.Dispose() }
}
