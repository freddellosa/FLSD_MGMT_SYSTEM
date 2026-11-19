#requires -Version 5.1
param([switch]$InstallFirst)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) {
    throw 'Run from the authorized validation workspace'
}
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')

$proof = Read-MainCreationProof $root
$run = '75435c87-0a31-42b7-9761-738db6c5c866'
$database = 'flsd_main_adapter_test'
$receiptPath = Assert-MainLocalPath (Join-Path $root "artifacts\main-adapter-isolated-installed-$run.json")
$fixtureIntent = Assert-MainLocalPath (Join-Path $root "artifacts\main-adapter-isolated-fixture-$run.json")
if (Test-Path -LiteralPath $fixtureIntent) { throw 'Isolated fixture attempt exists; stop for inspection' }
if ($InstallFirst) { & (Join-Path $PSScriptRoot 'invoke-main-isolated-preflight.ps1') -Install -Interactive }

$attemptPath = Assert-MainLocalPath (Join-Path $root "artifacts\main-adapter-isolated-$run-install-attempt.json")
$attempt = Get-Content -LiteralPath $attemptPath -Raw | ConvertFrom-Json
if ($attempt.status -cne 'INSTALLATION_ATTEMPT_STARTED' -or $attempt.runId -cne $run -or
    $attempt.database -cne $database -or $attempt.databaseOid -cne '16394' -or
    $attempt.sqlSha256 -cne 'C7B996379842F9CA46B2D5F816394135C0DC93B9EB0AB111528A891BF18F2748') {
    throw 'Verified installation attempt identity missing'
}
$receiptFile = [IO.File]::Open($receiptPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    $target = Get-Content -LiteralPath $receiptPath -Raw | ConvertFrom-Json
    $suffix = $run.Replace('-','')
    if ((($target.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'appOid,appRole,parentRunId,runId,schema,schemaOid' -or
        $target.runId -cne $run -or $target.parentRunId -cne $proof.runId -or
        $target.schema -cne "flsd_iso_$suffix" -or $target.appRole -cne "flsd_iso_app_$suffix") {
        throw 'Installation provenance mismatch'
    }
    foreach ($oid in @($target.schemaOid, $target.appOid)) {
        if ($oid -isnot [string] -or $oid -cnotmatch '^[1-9][0-9]{0,9}$' -or [uint64]$oid -gt [uint32]::MaxValue) {
            throw 'Installation receipt OID invalid'
        }
    }

    $guard = Get-MainIdentityGuardSql $proof $database $false
    $before = @"
BEGIN;
SET LOCAL search_path TO pg_catalog;
SET LOCAL password_encryption TO 'scram-sha-256';
$guard
DO `$isolated_password`$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_authid r
        WHERE r.oid=$($target.appOid)::oid AND r.rolname='$($target.appRole)'
          AND r.rolcanlogin AND r.rolpassword IS NULL
          AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
          AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
          AND shobj_description(r.oid,'pg_authid')='FLSD_ISOLATED_APP:$($target.parentRunId):$run'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_namespace n
        WHERE n.oid=$($target.schemaOid)::oid AND n.nspname='$($target.schema)'
          AND n.nspowner='$($proof.expectedOwner)'::regrole
          AND obj_description(n.oid,'pg_namespace')='FLSD_ISOLATED:$($target.parentRunId):${run}:$($target.schema)'
    ) THEN RAISE EXCEPTION 'Isolated identity or password state mismatch'; END IF;
END `$isolated_password`$;
"@
    $after = @"
DO `$password_set`$ BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_authid r WHERE r.oid=$($target.appOid)::oid
          AND r.rolname='$($target.appRole)' AND r.rolpassword IS NOT NULL
    ) THEN RAISE EXCEPTION 'Isolated password was not set'; END IF;
END `$password_set`$;
COMMIT;
SELECT 'ISOLATED_PASSWORD_CONFIGURED';
"@
    $result = Invoke-MainPg -Tool psql -User $proof.adminUser -Database $database -Interactive `
        -Extra @('-qAt', '-c', ($before -replace '[\r\n]+', ' '),
            '-c', ('\password ' + $target.appRole), '-c', ($after -replace '[\r\n]+', ' '))
    if ($result.ExitCode -ne 0 -or $result.Output.Trim() -cne 'ISOLATED_PASSWORD_CONFIGURED') {
        throw 'Password setup failed or outcome is uncertain; stop for inspection'
    }
    Write-Output 'ISOLATED_PASSWORD_CONFIGURED'
    & (Join-Path $PSScriptRoot 'run-main-adapter-tests.ps1') -IsolatedSchema -IsolatedRunId $run
} finally {
    $receiptFile.Dispose()
}
