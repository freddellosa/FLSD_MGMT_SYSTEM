#requires -Version 5.1
[CmdletBinding(DefaultParameterSetName='Plan')]
param(
    [Parameter(Mandatory=$true,ParameterSetName='Restore')][switch]$Restore,
    [Parameter(Mandatory=$true,ParameterSetName='Verify')][switch]$VerifyCommitted
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) { throw 'Wrong workspace' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')

$destination = 'flsd_main_restore_test'
$schema = 'flsd_batch7_commit_rehearsal'
$operation = 'df8dac6e-fe10-4a56-b377-11ba5abbe71d'
$prefix = 'artifacts\main-batch7-candidate-post-acceptance'
$archive = Assert-MainLocalPath (Join-Path $root "$prefix.dump")
$listing = Assert-MainLocalPath (Join-Path $root "$prefix.toc")
$backup = Assert-MainLocalPath (Join-Path $root "$prefix.json")
$attempt = Assert-MainLocalPath (Join-Path $root "$prefix-restore-attempt.json")
$receipt = Assert-MainLocalPath (Join-Path $root "$prefix-restored.json")
if ((Test-Path -LiteralPath $receipt) -or (!$VerifyCommitted -and (Test-Path -LiteralPath $attempt))) {
    throw 'Prior restore evidence exists; reconcile before retrying'
}
$catalogPath = Assert-MainLocalPath (Join-Path $root 'prisma\migration-review\batch7-committed-catalog-capture.sql')
$proof = Read-MainCreationProof $root
$run = 'b813e743-9f4c-4121-b8ab-b01ca51b9335'
if ($proof.runId -cne $run -or $proof.adminUser -cne 'postgres' -or $proof.expectedOwner -cne 'flsd_test_owner_b813e7439f4c' -or
    ($proof.verifiedDatabases | Where-Object name -CEQ 'flsd_main_adapter_test').oid -cne '16394' -or
    ($proof.verifiedDatabases | Where-Object name -CEQ $destination).oid -cne '16395' -or
    ($proof.verifiedRoles | Where-Object name -CEQ $proof.expectedOwner).oid -cne '16392') { throw 'Restore database provenance mismatch' }
$bin = 'C:\Program Files\PostgreSQL\18\bin'
foreach ($tool in @('psql','pg_restore')) {
    $version = & (Join-Path $bin "$tool.exe") --version
    if ($LASTEXITCODE -ne 0 -or $version -cne "$tool (PostgreSQL) 18.7") { throw 'Restore client version mismatch' }
}
$saved = Get-Content -LiteralPath $backup -Raw | ConvertFrom-Json
$archiveHash = '26723FD954BA3AB62ABEC90225FB47BDDD6AF39C50797FCBF1DBB90E1AC644C2'
$tocHash = '11B5334B228A4A739184F87C2974E590D80913E39BAAA201B4E4F0E8A956A519'
$catalogHash = '695e37a42301f962a2317f3369516796811f5a55c8fad3f0244e23a510fcdbbb'
$dataHash = 'e5736cbee1bd1105538da4a89b337a01cbfd177dfccfb5bc86b53a8746a725dd'
if ((Get-FileHash -LiteralPath $backup).Hash -cne '711CB07520A516A0445201B121239C940B1B11C8BC3D7F180E14E0CDB5B9EDB9' -or
    (Get-FileHash -LiteralPath $listing).Hash -cne $tocHash -or
    (Get-FileHash -LiteralPath $catalogPath).Hash -cne 'F34F30C939D34E190A0B6BB41C8F387760E7E23CF7B2316C9B98C2F64671A980' -or
    $saved.status -cne 'BATCH7_CANDIDATE_POST_ACCEPTANCE_BACKUP_VERIFIED' -or $saved.creationRunId -cne $run -or
    $saved.databaseOid -cne '16394' -or $saved.schemaOid -cne '19396' -or $saved.schema -cne $schema -or
    $saved.operationId -cne $operation -or $saved.tables -ne 25 -or $saved.archiveSha256 -cne $archiveHash -or
    $saved.tocSha256 -cne $tocHash -or $saved.catalogSha256 -cne $catalogHash -or $saved.dataSha256 -cne $dataHash) {
    throw 'Post-acceptance archive evidence mismatch'
}

$lockedArchive = [IO.File]::Open($archive,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
    if ((Get-FileHash -InputStream $lockedArchive).Hash -cne $archiveHash) { throw 'Archive hash mismatch' }
    $decoded = Invoke-MainPg -Tool pg_restore -User postgres -Database $destination -LocalArchiveOnly -Extra @('--file=-',$archive)
    if ($decoded.ExitCode -ne 0 -or !$decoded.Output -or $decoded.Output.Length -gt 1048576) { throw 'Archive SQL decode failed' }
} finally { $lockedArchive.Dispose() }
$decodedLines = $decoded.Output -split '\r?\n'
$meta = @($decodedLines | Where-Object { $_.StartsWith('\') })
if (@($meta | Where-Object { $_ -cnotmatch '^\\(?:restrict|unrestrict) [A-Za-z0-9]+$|^\\\.$' }).Count -ne 0 -or
    @($meta | Where-Object { $_ -cmatch '^\\\.$' }).Count -ne 25 -or
    $decoded.Output -cmatch '(?m)^\s*(?:COMMIT|ROLLBACK|BEGIN|CREATE DATABASE|ALTER DATABASE|DROP)\b' -or
    @($decodedLines | Where-Object { $_ -ceq 'CREATE SCHEMA flsd_batch7_commit_rehearsal;' }).Count -ne 1) {
    throw 'Archive SQL contains unexpected commands'
}

$catalog = [IO.File]::ReadAllText($catalogPath)
$match = [regex]::Match($catalog,'(?s)(?<query>WITH scope AS \(.*?FROM contract;)\s*ROLLBACK;\s*\z')
if (!$match.Success) { throw 'Catalog capture envelope mismatch' }
$catalogQuery = $match.Groups['query'].Value.Replace('WITH scope AS (','CREATE TEMP TABLE restored_catalog ON COMMIT DROP AS WITH scope AS (').
    Replace('FROM contract;', 'AS receipt FROM contract;')
$parts = foreach ($table in $saved.data.tables.PSObject.Properties.Name) {
    if ($table -cnotmatch '^[A-Za-z][A-Za-z0-9_]+$') { throw 'Invalid archived table name' }
    $relation = $schema + '."' + $table + '"'
    "'$table',(SELECT jsonb_build_array(count(*),encode(sha256(convert_to(COALESCE(jsonb_agg(v ORDER BY v::text COLLATE `"C`")::text,'[]'),'UTF8')),'hex')) FROM (SELECT to_jsonb(t) v FROM $relation t) normalized)"
}
$dataQuery = @"
CREATE TEMP TABLE restored_data ON COMMIT DROP AS
WITH manifest AS (
 SELECT jsonb_build_object(
  'tables',$('jsonb_build_object('+($parts -join ',')+')'),
  'sequence',(SELECT jsonb_build_array(last_value,is_called) FROM $schema.flsd_soa_number_seq),
  'financial',(SELECT jsonb_agg(jsonb_build_object('paymentId',p.id,'receivedCentavos',(p.amount*100)::bigint::text,
   'allocatedCentavos',((SELECT COALESCE(sum(a.amount),0) FROM $schema."PaymentAllocation" a WHERE a."paymentId"=p.id)*100)::bigint::text,
   'refundCentavos',((SELECT COALESCE(sum(r.amount),0) FROM $schema."PaymentRefund" r WHERE r."paymentId"=p.id)*100)::bigint::text)
   ORDER BY p.id) FROM $schema."Payment" p)
 ) AS body
)
SELECT encode(sha256(convert_to(body::text,'UTF8')),'hex') AS digest FROM manifest;
"@
$target = Get-MainIdentityGuardSql $proof $destination $false
$before = @"
SET LOCAL search_path TO pg_catalog;
SET LOCAL timezone TO 'UTC';
SET LOCAL datestyle TO 'ISO, YMD';
$target
DO `$pre`$ BEGIN
 PERFORM pg_advisory_xact_lock(176661,2);
 IF current_setting('server_version_num')<>'180007' OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='$schema')
   OR NOT EXISTS (
     SELECT 1 FROM pg_roles w WHERE w.oid=20051 AND w.rolname='flsd_batch7_candidate_writer'
       AND NOT (w.rolcanlogin OR w.rolinherit OR w.rolsuper OR w.rolcreatedb OR w.rolcreaterole OR w.rolbypassrls OR w.rolreplication)
       AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid=w.oid OR m.member=w.oid)
       AND shobj_description(w.oid,'pg_authid')='FLSD_SYNTHETIC_BATCH7_ACCEPTANCE_V1'
       AND NOT has_database_privilege(w.oid,current_database(),'CONNECT,TEMPORARY')
   ) THEN RAISE EXCEPTION 'Candidate restore scope or role mismatch'; END IF;
END `$pre`$;
"@
$after = @"
SET LOCAL search_path TO pg_catalog;
SET LOCAL timezone TO 'UTC';
SET LOCAL datestyle TO 'ISO, YMD';
$target
$catalogQuery
$dataQuery
DO `$reconcile`$ BEGIN
 IF (SELECT receipt->>'databaseOid' FROM pg_temp.restored_catalog) IS DISTINCT FROM '16395'
   OR (SELECT receipt->>'catalogSha256' FROM pg_temp.restored_catalog) IS DISTINCT FROM '$catalogHash'
   OR (SELECT digest FROM pg_temp.restored_data) IS DISTINCT FROM '$dataHash'
 THEN RAISE EXCEPTION 'Restored catalog or data does not match the archive'; END IF;
END `$reconcile`$;
SELECT jsonb_build_object('status','BATCH7_CANDIDATE_RESTORE_RECONCILED','databaseOid','16395',
 'schemaOid',receipt->>'schemaOid','catalogSha256','$catalogHash','dataSha256','$dataHash',
 'operationId','$operation','tables',25) FROM pg_temp.restored_catalog;
"@
if (!$Restore -and !$VerifyCommitted) {
    Write-Output 'BATCH7_CANDIDATE_RESTORE_PLAN_VERIFIED_OFFLINE'
    return
}

$verificationSql = $null
if ($VerifyCommitted) {
    $prior = Get-Content -LiteralPath $attempt -Raw | ConvertFrom-Json
    if ($prior.status -cne 'CANDIDATE_RESTORE_ATTEMPT_STARTED' -or $prior.databaseOid -cne '16395' -or
        $prior.archiveSha256 -cne $archiveHash -or $prior.operationId -cne $operation) { throw 'Restore attempt evidence mismatch' }
    $readData = $dataQuery.Replace('CREATE TEMP TABLE restored_data ON COMMIT DROP AS','').
        Replace("SELECT encode(sha256(convert_to(body::text,'UTF8')),'hex') AS digest FROM manifest;",
            "SELECT jsonb_build_object('dataSha256',encode(sha256(convert_to(body::text,'UTF8')),'hex')) FROM manifest;")
    $verificationSql = @"
SET LOCAL search_path TO pg_catalog;
SET LOCAL timezone TO 'UTC';
SET LOCAL datestyle TO 'ISO, YMD';
$target
DO `$verify`$ BEGIN
 IF current_setting('transaction_read_only')<>'on' OR NOT EXISTS (
   SELECT 1 FROM pg_namespace WHERE nspname='$schema' AND oid=20055 AND nspowner=16392
     AND obj_description(oid,'pg_namespace')='FLSD_SYNTHETIC_BATCH7_COMMITTED_V1'
 ) OR NOT EXISTS (
   SELECT 1 FROM pg_roles w WHERE w.oid=20051 AND w.rolname='flsd_batch7_candidate_writer'
     AND NOT w.rolcanlogin AND NOT has_database_privilege(w.oid,current_database(),'CONNECT,TEMPORARY')
 ) THEN RAISE EXCEPTION 'Committed restore identity or role mismatch'; END IF;
END `$verify`$;
$($match.Groups['query'].Value)
$readData
"@
} else {
    Write-MainExclusiveJson $attempt @{status='CANDIDATE_RESTORE_ATTEMPT_STARTED';databaseOid='16395';archiveSha256=$archiveHash;operationId=$operation}
}
$info = New-MainPgProcessInfo (Join-Path $bin 'psql.exe') @(
    '-X','-qAt','-w','-1','-v','ON_ERROR_STOP=on','-h','127.0.0.1','-p','5432','-U','postgres','-d',$destination,'-f','-'
) -ReadOnly:$VerifyCommitted
$info.RedirectStandardInput = $true
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
$started = $false
$secret = Read-Host 'Local postgres password for the pinned disposable restore database' -AsSecureString
$pointer = [IntPtr]::Zero
try {
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $info.EnvironmentVariables['PGPASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
    try { $started = $process.Start() }
    finally {
        $info.EnvironmentVariables.Remove('PGPASSWORD')
        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
        $pointer = [IntPtr]::Zero
    }
    $output = $process.StandardOutput.ReadToEndAsync()
    $sql = if ($VerifyCommitted) { $verificationSql } else { "$before`n$($decoded.Output)`n$after`n" }
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes($sql)
    $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
    $process.StandardInput.Close()
    if (!$process.WaitForExit(90000) -or $process.ExitCode -ne 0) { throw 'Restore failed or commit uncertain; preserve attempt evidence' }
    $rows = @($output.GetAwaiter().GetResult() -split '\r?\n' | Where-Object { $_ -match '^\s*\{.*\}\s*$' })
    if ($VerifyCommitted) {
        if ($rows.Count -ne 2) { throw 'Expected catalog and data verification rows' }
        $catalogResult = ConvertFrom-Json -InputObject $rows[0]
        $dataResult = ConvertFrom-Json -InputObject $rows[1]
        if ($catalogResult.status -cne 'BATCH7_COMMITTED_CATALOG_CAPTURED_READ_ONLY') { throw 'Unexpected catalog verification status' }
        $result = [pscustomobject]@{status='BATCH7_CANDIDATE_RESTORE_RECONCILED';databaseOid=$catalogResult.databaseOid;
            schemaOid=$catalogResult.schemaOid;catalogSha256=$catalogResult.catalogSha256;dataSha256=$dataResult.dataSha256;
            operationId=$operation;tables=25;verifiedAfterCommit=$true}
    } else {
        if ($rows.Count -ne 1) { throw 'Expected one restore reconciliation row; preserve attempt evidence' }
        $result = ConvertFrom-Json -InputObject $rows[0]
    }
    if ($result.status -cne 'BATCH7_CANDIDATE_RESTORE_RECONCILED' -or $result.databaseOid -cne '16395' -or
        $result.schemaOid -cnotmatch '^[1-9][0-9]+$' -or $result.catalogSha256 -cne $catalogHash -or
        $result.dataSha256 -cne $dataHash -or $result.operationId -cne $operation -or $result.tables -ne 25) {
        throw 'Restore result mismatch; preserve attempt evidence'
    }
    Write-MainExclusiveJson $receipt $result
    $result | ConvertTo-Json -Compress
} finally {
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $secret.Dispose()
    if ($started -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
}
