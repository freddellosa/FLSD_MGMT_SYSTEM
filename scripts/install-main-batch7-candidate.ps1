#requires -Version 5.1
[CmdletBinding()]
param([switch]$Install)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) { throw 'Wrong workspace' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$db = 'flsd_main_adapter_test'
$schema = 'flsd_batch7_commit_rehearsal'
$owner = 'flsd_test_owner_b813e7439f4c'
$run = 'b813e743-9f4c-4121-b8ab-b01ca51b9335'
$marker = 'FLSD_SYNTHETIC_BATCH7_COMMITTED_V1'
$proof = Read-MainCreationProof $root
if ($proof.runId -cne $run -or $proof.adminUser -cne 'postgres' -or $proof.expectedOwner -cne $owner -or
    ($proof.verifiedDatabases | Where-Object name -CEQ $db).oid -cne '16394' -or
    ($proof.verifiedRoles | Where-Object name -CEQ $owner).oid -cne '16392') { throw 'Creation proof mismatch' }

$pins = [ordered]@{
    'batch7-committed-candidate-baseline.sql' = 'A62571006C3690A38B252A6882A587532B8C43EC99AEA88E43A6CC2A07A913B8'
    'batch7-committed-foundation-controls.sql' = '07CF85469556153A2C96B711EE1395D236C45C3CD5A93AC50980F050AFF8EE14'
    'batch7-committed-candidate-seed.sql' = '043FE1BC811E3950B2CA4A0D9671183030BA347A9DCCD43F5F3B52840F66CAEB'
    'batch7-committed-candidate-assertions.sql' = '4CDE1CCB1DF048A193C670E5E267159B5CA56B6708154E85BBB6A56BAB716373'
    'batch7-committed-catalog-capture.sql' = 'F34F30C939D34E190A0B6BB41C8F387760E7E23CF7B2316C9B98C2F64671A980'
}
$paths = @{}
$streams = @()
try {
    foreach ($name in $pins.Keys) {
        $path = Assert-MainLocalPath (Join-Path $root "prisma\migration-review\$name")
        $stream = [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $streams += $stream
        if ((Get-FileHash -InputStream $stream -Algorithm SHA256).Hash -cne $pins[$name]) { throw 'Candidate SQL hash mismatch' }
        $paths[$name] = $path
    }
    if (!$Install) {
        @{status='BATCH7_CANDIDATE_PLAN_VERIFIED_OFFLINE';databaseCommandsExecuted=0;sqlSha256=$pins} |
            ConvertTo-Json -Depth 4 -Compress
        return
    }
    $attempt = Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-install-attempt.json')
    $installed = Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-installed.json')
    if ((Test-Path -LiteralPath $attempt) -or (Test-Path -LiteralPath $installed)) { throw 'Prior candidate attempt exists; preserve evidence' }
    $guard = Get-MainIdentityGuardSql $proof $db $false
    $setup = @"
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL search_path TO pg_catalog;
$guard
SELECT pg_advisory_xact_lock(176661,1);
DO `$target`$ BEGIN
 IF current_setting('server_version_num')<>'180007' OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='$schema')
 THEN RAISE EXCEPTION 'Candidate install target refused'; END IF;
END `$target`$;
SET LOCAL ROLE $owner;
CREATE SCHEMA $schema;
COMMENT ON SCHEMA $schema IS '$marker';
REVOKE ALL ON SCHEMA $schema FROM PUBLIC;
SET LOCAL search_path TO $schema, pg_catalog;
"@
    $verify = "SELECT oid::text FROM pg_namespace WHERE nspname='$schema' AND nspowner=16392::oid AND obj_description(oid,'pg_namespace')='$marker';"
    $evidence = [ordered]@{
        status='BATCH7_CANDIDATE_INSTALL_ATTEMPT_STARTED';creationRunId=$run;database=$db;databaseOid='16394'
        schema=$schema;ownerOid='16392';sqlSha256=$pins
    }
    Write-MainExclusiveJson $attempt $evidence
    $commands = @('-qAt','-c',($setup -replace '[\r\n]+',' '),
        '-f',$paths['batch7-committed-candidate-baseline.sql'],
        '-f',$paths['batch7-committed-foundation-controls.sql'],
        '-f',$paths['batch7-committed-candidate-seed.sql'],
        '-c','SET LOCAL search_path TO pg_catalog;',
        '-f',$paths['batch7-committed-candidate-assertions.sql'],
        '-c','COMMIT;','-c',$verify)
    $result = Invoke-MainPg -Tool psql -User postgres -Database $db -Interactive -Extra $commands
    $oid = $result.Output.Trim()
    if ($result.ExitCode -ne 0 -or $oid -cnotmatch '^[1-9][0-9]{0,9}$' -or [uint64]$oid -gt [uint32]::MaxValue) {
        throw 'Candidate installation failed or outcome is uncertain; preserve attempt'
    }
    $evidence.status = 'BATCH7_CANDIDATE_INSTALLED'
    $evidence.schemaOid = $oid
    Write-MainExclusiveJson $installed $evidence
    $evidence | ConvertTo-Json -Depth 5 -Compress
} finally {
    foreach ($stream in $streams) { $stream.Dispose() }
}
