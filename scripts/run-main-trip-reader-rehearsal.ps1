#requires -Version 5.1
[CmdletBinding(DefaultParameterSetName='Validate')]
param(
    [Parameter(ParameterSetName='Validate')][switch]$ValidateOnly,
    [Parameter(Mandatory=$true,ParameterSetName='Execute')][switch]$Execute
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) { throw 'Wrong workspace' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')

$database = 'flsd_main_adapter_test'
$role = 'flsd_trip_review_reader_75435c870a31'
$authority = 'flsd-synthetic-trip-review'
$schema = 'flsd_operational'
$marker = 'FLSD_SYNTHETIC_TRIP_READER_V1:b813e743-9f4c-4121-b8ab-b01ca51b9335'
$hash = 'CE73D62673F7ADFE4E3C3D412147A90A4763B838522A89BE199EDD9CBA442150'
$proof = Read-MainCreationProof $root
$dbOid = ($proof.verifiedDatabases | Where-Object name -CEQ $database).oid
$ownerOid = ($proof.verifiedRoles | Where-Object name -CEQ $proof.expectedOwner).oid
if ($proof.runId -cne 'b813e743-9f4c-4121-b8ab-b01ca51b9335' -or $dbOid -cne '16394' -or $ownerOid -cne '16392' -or
    $proof.expectedOwner -cne 'flsd_test_owner_b813e7439f4c' -or $proof.adminUser -cne 'postgres') {
    throw 'Trip-reader proof mismatch'
}
$ddl = Assert-MainLocalPath (Join-Path $root 'prisma\production-review\trip-reader-disposable-v1.sql')
$attempt = Assert-MainLocalPath (Join-Path $root 'artifacts\main-trip-reader-rehearsal-attempt.json')
$installed = Assert-MainLocalPath (Join-Path $root 'artifacts\main-trip-reader-rehearsal-installed.json')
$report = Assert-MainLocalPath (Join-Path $root 'artifacts\main-trip-reader-rehearsal-result.json')
$node = (Get-Command node -ErrorAction Stop).Source
$guard = Get-MainIdentityGuardSql $proof $database $false

function Invoke-TripReaderNode([ValidateSet('fixture','verify')][string]$Mode,[string]$Payload) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = $node
    $info.Arguments = "node_modules/vite-node/vite-node.mjs tests/main-trip-reader/runner.ts $Mode"
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($name in @($info.EnvironmentVariables.Keys)) {
        if ($name -like 'PG*' -or $name -eq 'DATABASE_URL' -or $name -like 'FLSD_*') { $info.EnvironmentVariables.Remove($name) }
    }
    if ($Mode -eq 'verify') { $info.EnvironmentVariables['FLSD_SYNTHETIC_TRIP_READER']='VERIFIED_LOCAL_RUN' }
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $started = $false
    $bytes = $null
    try {
        $started = $process.Start()
        $output = $process.StandardOutput.ReadToEndAsync()
        $errors = $process.StandardError.ReadToEndAsync()
        $bytes = [Text.UTF8Encoding]::new($false).GetBytes($Payload)
        $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
        $process.StandardInput.BaseStream.Close()
        if (!$process.WaitForExit(120000)) { throw 'Synthetic trip-reader worker timed out' }
        $null = $errors.GetAwaiter().GetResult()
        [pscustomobject]@{exitCode=$process.ExitCode;output=$output.GetAwaiter().GetResult()}
    } finally {
        if ($bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
        if ($started -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}

$file = [IO.File]::Open($ddl,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
    if ((Get-FileHash -InputStream $file -Algorithm SHA256).Hash -cne $hash) { throw 'Reviewed trip-reader DDL hash mismatch' }
    if ($Execute -and ((Test-Path -LiteralPath $attempt) -or (Test-Path -LiteralPath $installed) -or (Test-Path -LiteralPath $report))) {
        throw 'Prior trip-reader rehearsal evidence exists; stop for inspection'
    }
    $generated = Invoke-TripReaderNode fixture ''
    if ($generated.exitCode -ne 0) { throw 'Synthetic fixture generation failed' }
    $fixture = ConvertFrom-Json -InputObject $generated.output
    $generated = $null
    if ($fixture.sql -isnot [string] -or !$fixture.sql.Length -or $fixture.sql.Length -gt 12000 -or
        (($fixture.tokens.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'expired,inactive,revoked,valid,viewer') {
        throw 'Synthetic fixture output invalid'
    }
    foreach ($item in $fixture.tokens.PSObject.Properties) {
        if ($item.Value -cnotmatch '^[a-f0-9]{64}$' -or $fixture.sql.Contains($item.Value)) { throw 'Synthetic fixture credential boundary failed' }
    }
    if (!$Execute) {
        Write-Output 'TRIP_READER_OFFLINE_VALIDATED'
        return
    }

    $preflight = @"
BEGIN READ ONLY;
SET LOCAL search_path TO pg_catalog;
$guard
DO `$names`$ BEGIN
 IF current_setting('server_version_num')::int<>180007
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='$schema')
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='$role')
 THEN RAISE EXCEPTION 'Trip-reader version or name preflight refused'; END IF;
END `$names`$;
SELECT 'TRIP_READER_NAMES_UNUSED_READ_ONLY';
ROLLBACK;
"@
    $seed = @"
BEGIN;
SET LOCAL search_path TO pg_catalog;
SET LOCAL password_encryption TO 'scram-sha-256';
$guard
SELECT pg_advisory_xact_lock(176661,1);
DO `$seed_guard`$ BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_namespace n WHERE n.nspname='$schema' AND n.nspowner=16392::oid
   AND obj_description(n.oid,'pg_namespace')='$marker'
 ) OR NOT EXISTS (
   SELECT 1 FROM pg_authid r WHERE r.rolname='$role' AND r.rolcanlogin AND r.rolpassword IS NULL
   AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
   AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
   AND shobj_description(r.oid,'pg_authid')='$marker'
 ) OR NOT EXISTS (
   SELECT 1 FROM $schema.authority_meta WHERE authority_id='$authority' AND contract_version=1
 ) OR EXISTS(SELECT 1 FROM $schema.staff_user) OR EXISTS(SELECT 1 FROM $schema.staff_authorization)
   OR EXISTS(SELECT 1 FROM $schema.staff_session) OR EXISTS(SELECT 1 FROM $schema.customer)
   OR EXISTS(SELECT 1 FROM $schema.vehicle) OR EXISTS(SELECT 1 FROM $schema.driver)
   OR EXISTS(SELECT 1 FROM $schema.trip) OR EXISTS(SELECT 1 FROM $schema.operational_receipt)
 THEN RAISE EXCEPTION 'Trip-reader installation drift or nonempty fixture'; END IF;
END `$seed_guard`$;
SET LOCAL ROLE $($proof.expectedOwner);
$($fixture.sql)
RESET ROLE;
"@
    $finish = @"
DO `$password_guard`$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_authid WHERE rolname='$role' AND rolpassword IS NOT NULL)
 THEN RAISE EXCEPTION 'Trip-reader password was not set'; END IF;
END `$password_guard`$;
COMMIT;
SELECT json_build_object('status','TRIP_READER_FIXTURE_COMMITTED','databaseOid','$dbOid',
  'schemaOid',(SELECT oid::text FROM pg_namespace WHERE nspname='$schema'),
  'roleOid',(SELECT oid::text FROM pg_roles WHERE rolname='$role'));
"@
    Write-MainExclusiveJson $attempt @{status='TRIP_READER_REHEARSAL_ATTEMPT_STARTED';database=$database;databaseOid=$dbOid;schema=$schema;role=$role;ddlSha256=$hash}
    $result = Invoke-MainPg -Tool psql -User $proof.adminUser -Database $database -Interactive `
        -Extra @('-qAt','-c',($preflight -replace '[\r\n]+',' '),'-f',$ddl,
            '-c',($seed -replace '[\r\n]+',' '),'-c',("\password $role"),'-c',($finish -replace '[\r\n]+',' '))
    $rows = @($result.Output -split '\r?\n' | Where-Object { $_.Trim() })
    if ($result.ExitCode -ne 0 -or $rows.Count -ne 2 -or $rows[0] -cne 'TRIP_READER_NAMES_UNUSED_READ_ONLY') {
        throw 'Trip-reader install, seed or password step failed or is uncertain; preserve attempt'
    }
    $receipt = ConvertFrom-Json -InputObject $rows[1]
    if ($receipt.status -cne 'TRIP_READER_FIXTURE_COMMITTED' -or $receipt.databaseOid -cne $dbOid) { throw 'Trip-reader receipt mismatch' }
    foreach ($oid in @($receipt.schemaOid,$receipt.roleOid)) {
        if ($oid -isnot [string] -or $oid -cnotmatch '^[1-9][0-9]{0,9}$' -or [uint64]$oid -gt [uint32]::MaxValue) { throw 'Trip-reader receipt OID invalid' }
    }
    Write-MainExclusiveJson $installed @{status=$receipt.status;database=$database;databaseOid=$dbOid;
        schema=$schema;schemaOid=$receipt.schemaOid;role=$role;roleOid=$receipt.roleOid;ddlSha256=$hash}

    $secret = Read-Host "Local password just set for $role" -AsSecureString
    $pointer = [IntPtr]::Zero
    $payload = $null
    try {
        $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
        $payload = @{password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer);tokens=$fixture.tokens;
            schemaOid=$receipt.schemaOid;roleOid=$receipt.roleOid} | ConvertTo-Json -Depth 5 -Compress
        $checked = Invoke-TripReaderNode verify $payload
        $safe = ConvertFrom-Json -InputObject $checked.output
        if ($checked.exitCode -eq 0 -and $safe.status -ceq 'TRIP_READER_CONNECTED_VERIFIED' -and $safe.passed -eq 10 -and $safe.failed -eq 0) {
            $summary = [ordered]@{status=$safe.status;passed=10;failed=0;schemaOid=$receipt.schemaOid;roleOid=$receipt.roleOid;rawOutputIncluded=$false}
        } elseif ($safe.status -ceq 'TRIP_READER_STAGE_FAILED' -and $safe.phase -cin @(
            'INPUT','CATALOG_AND_ROLE','VALID_REVIEW','BOUND_REPLAY','SESSION_AND_ROLE_REFUSALS','INACTIVE_MASTER','EXACT_VERSION_AND_AUTHORITY'
        )) {
            $summary = [ordered]@{status='TRIP_READER_STAGE_FAILED';phase=$safe.phase;rawOutputIncluded=$false}
        } else { throw 'Trip-reader test evidence invalid; preserve attempt' }
        Write-MainExclusiveJson $report $summary
        $summary | ConvertTo-Json -Compress
        if ($summary.status -cne 'TRIP_READER_CONNECTED_VERIFIED') { throw 'Trip-reader connected validation failed; preserve fixture' }
    } finally {
        $payload = $null
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $secret.Dispose()
    }
} finally {
    $fixture = $null
    $file.Dispose()
}
