#requires -Version 5.1
[CmdletBinding(DefaultParameterSetName='Capture')]
param(
    [Parameter(ParameterSetName='Capture')][switch]$ConnectReadOnly,
    [Parameter(Mandatory=$true,ParameterSetName='Backup')][switch]$Backup,
    [Parameter(ParameterSetName='Backup')][switch]$RetryInterruptedSnapshot,
    [Parameter(Mandatory=$true,ParameterSetName='PostAcceptance')][switch]$PostAcceptanceBackup,
    [Parameter(ParameterSetName='PostAcceptance')][switch]$PlanOnly,
    [Parameter(Mandatory=$true,ParameterSetName='Upgrade')][switch]$CommitUpgrade,
    [Parameter(Mandatory=$true,ParameterSetName='After')][switch]$CaptureAfter
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) { throw 'Wrong workspace' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$proof = Read-MainCreationProof $root
$db = 'flsd_main_adapter_test'
$schema = 'flsd_batch7_commit_rehearsal'
$run = 'b813e743-9f4c-4121-b8ab-b01ca51b9335'
$schemaOid = '19396'
if ($proof.runId -cne $run -or $proof.adminUser -cne 'postgres' -or $proof.expectedOwner -cne 'flsd_test_owner_b813e7439f4c' -or
    ($proof.verifiedDatabases | Where-Object name -CEQ $db).oid -cne '16394' -or
    ($proof.verifiedRoles | Where-Object name -CEQ $proof.expectedOwner).oid -cne '16392') { throw 'Creation proof mismatch' }
$identity = @{creationRunId=$run;database=$db;databaseOid='16394';ownerOid='16392';schema=$schema}
$installed = Get-Content -LiteralPath (Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-installed.json')) -Raw | ConvertFrom-Json
$attempt = Get-Content -LiteralPath (Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-install-attempt.json')) -Raw | ConvertFrom-Json
if ($installed.status -cne 'BATCH7_CANDIDATE_INSTALLED' -or $installed.schemaOid -cne $schemaOid -or
    $attempt.status -cne 'BATCH7_CANDIDATE_INSTALL_ATTEMPT_STARTED') { throw 'Installation receipt mismatch' }
foreach ($name in $identity.Keys) {
    if ($installed.$name -cne $identity[$name] -or $attempt.$name -cne $identity[$name]) { throw 'Installation scope mismatch' }
}
$pins = @{
    'batch7-committed-candidate-baseline.sql' = 'A62571006C3690A38B252A6882A587532B8C43EC99AEA88E43A6CC2A07A913B8'
    'batch7-committed-foundation-controls.sql' = '07CF85469556153A2C96B711EE1395D236C45C3CD5A93AC50980F050AFF8EE14'
    'batch7-committed-candidate-seed.sql' = '043FE1BC811E3950B2CA4A0D9671183030BA347A9DCCD43F5F3B52840F66CAEB'
    'batch7-committed-candidate-assertions.sql' = '4CDE1CCB1DF048A193C670E5E267159B5CA56B6708154E85BBB6A56BAB716373'
    'batch7-committed-catalog-capture.sql' = 'F34F30C939D34E190A0B6BB41C8F387760E7E23CF7B2316C9B98C2F64671A980'
}
$captureFile = 'batch7-committed-catalog-capture.sql'
$catalog = $null
foreach ($name in $pins.Keys) {
    $path = Assert-MainLocalPath (Join-Path $root "prisma\migration-review\$name")
    if ($installed.sqlSha256.$name -cne $pins[$name] -or $attempt.sqlSha256.$name -cne $pins[$name]) { throw 'Receipt pin mismatch' }
    $bytes = [IO.File]::ReadAllBytes($path)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $actual = [BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-','') }
    finally { $sha.Dispose() }
    if ($actual -cne $pins[$name]) { throw 'Candidate input hash mismatch' }
    if ($name -eq $captureFile) { $catalog = [Text.Encoding]::UTF8.GetString($bytes) }
}
if (!$ConnectReadOnly -and !$Backup -and !$PostAcceptanceBackup -and !$CommitUpgrade -and !$CaptureAfter) { Write-Output 'BATCH7_CANDIDATE_CAPTURE_PLAN_VERIFIED_OFFLINE'; return }
$outputPath = Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-before.json')
if ($ConnectReadOnly -and (Test-Path -LiteralPath $outputPath)) { throw 'Baseline capture already exists' }

$envelope = '(?s)\ABEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;\s*(?<body>.*)\s*ROLLBACK;\s*\z'
$catalog = ($catalog -replace '(?m)^--[^\r\n]*\r?\n','') -replace '(?m)^\\set ON_ERROR_STOP on\r?\n',''
$parsed = [regex]::Match($catalog,$envelope)
if (!$parsed.Success) { throw 'Pinned capture SQL envelope mismatch' }
$guard = Get-MainIdentityGuardSql $proof $db $false
$setup = @"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog;
SET LOCAL TimeZone TO 'UTC';
$guard
DO `$scope`$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='$schema' AND oid=$schemaOid::oid AND nspowner=16392::oid
   AND obj_description(oid,'pg_namespace')='FLSD_SYNTHETIC_BATCH7_COMMITTED_V1')
 THEN RAISE EXCEPTION 'Candidate capture schema identity refused'; END IF;
END `$scope`$;
"@
$tables = @('AuditEvent','Customer','Driver','FinancialOperation','ImportBatch','InvoiceSerialBatch','OfficialInvoice',
    'Payment','PaymentAllocation','PaymentAllocationEvent','PaymentAttachment','PaymentRefund','SoaTrip','StaffUser',
    'StatementOfAccount','Trip','UnmatchedPaymentCase','Vehicle')
if ($PostAcceptanceBackup) {
    $tables += @('staff_authorization','staff_session','payment_scope','receivable','invoice_attribution','operation_scope','invoice_reservation')
}
$parts = foreach ($table in $tables) {
    $relation = $schema + '."' + $table + '"'
    "'$table',(SELECT jsonb_build_array(count(*),encode(sha256(convert_to(COALESCE(jsonb_agg(v ORDER BY v::text COLLATE `"C`")::text,'[]'),'UTF8')),'hex')) FROM (SELECT to_jsonb(t) v FROM $relation t) normalized)"
}
$data = @"
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
SELECT jsonb_build_object('status','BATCH7_CANDIDATE_DATA_CAPTURED_READ_ONLY',
 'dataSha256',encode(sha256(convert_to(body::text,'UTF8')),'hex'),'data',body) FROM manifest;
"@
if ($CommitUpgrade -or $CaptureAfter) {
    $prefix = 'artifacts\main-batch7-candidate'
    $backupPath = Assert-MainLocalPath (Join-Path $root "$prefix-backup.json")
    $backupReceipt = Get-Content -LiteralPath $backupPath -Raw | ConvertFrom-Json
    $before = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
    $catalogHash = '7ffaf2802df724b7c590237123adfe27230ce32d54990adb82fb900d874b8a84'
    $dataHash = '4643dfd32fc66aadb667922f9d096a5303ab0ceb0c95c42a4e76e4fbf631891e'
    $archiveHash = '62FE4C6ADEB5AA9C24255A49F29A8E6ACC143E8D5055CB817A826C22B0F51D0B'
    $tocHash = 'A105B7778852B3FE2AC1AB83895CBEB5803CBF42C17985AD94677FA723120FC2'
    foreach ($receipt in @($backupReceipt,$before)) {
        if ($receipt.creationRunId -cne $run -or $receipt.databaseOid -cne '16394' -or $receipt.schema -cne $schema -or
            $receipt.schemaOid -cne $schemaOid -or $receipt.catalogSha256 -cne $catalogHash -or
            $receipt.dataSha256 -cne $dataHash) { throw 'Upgrade baseline evidence mismatch' }
    }
    if ($before.status -cne 'BATCH7_CANDIDATE_BASELINE_CAPTURED' -or $before.phase -cne 'BEFORE' -or
        $backupReceipt.status -cne 'BATCH7_CANDIDATE_BACKUP_VERIFIED' -or $backupReceipt.tables -ne 18 -or
        $backupReceipt.archiveSha256 -cne $archiveHash -or $backupReceipt.tocSha256 -cne $tocHash) { throw 'Backup receipt refused' }
    foreach ($name in $pins.Keys) {
        if ($before.sqlSha256.$name -cne $pins[$name]) { throw 'Captured baseline pin mismatch' }
    }
    foreach ($entry in @(@{suffix='before.dump';hash=$archiveHash},@{suffix='before.toc';hash=$tocHash})) {
        $path = Assert-MainLocalPath (Join-Path $root "$prefix-$($entry.suffix)")
        if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $entry.hash) { throw 'Backup file hash mismatch' }
    }
    $upgradePins = [ordered]@{
        'batch7-committed-upgrade-v1.sql' = 'EAE179BDB1D7BD0449747F1343A3E78E6C94568ED504410826FFF050AB247E38'
        'batch7-committed-upgrade-evidence.sql' = 'FEEA6EAFBDCE0E3078940E54FF42A86739A6AD838D5F273809945B52F0C048CC'
    }
    $upgradeAttempt = Assert-MainLocalPath (Join-Path $root "$prefix-upgrade-attempt.json")
    $upgradeReceipt = Assert-MainLocalPath (Join-Path $root "$prefix-upgraded.json")
    $afterPath = Assert-MainLocalPath (Join-Path $root "$prefix-after-upgrade.json")
    $streams = @()
    $paths = @()
    try {
        foreach ($name in $upgradePins.Keys) {
            $path = Assert-MainLocalPath (Join-Path $root "prisma\migration-review\$name")
            $stream = [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
            $streams += $stream
            if ((Get-FileHash -InputStream $stream -Algorithm SHA256).Hash -cne $upgradePins[$name]) { throw 'Upgrade SQL hash mismatch' }
            $paths += $path
        }
        $unchangedData = $data.Replace('to_jsonb(t) v',"(to_jsonb(t)-'batch7_revision') v")
        $shape = @"
DO `$check`$ BEGIN
 IF (SELECT count(*) FROM pg_class WHERE relnamespace='$schema'::regnamespace AND relkind='r')<>25
 OR (SELECT count(*) FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
   WHERE c.relnamespace='$schema'::regnamespace AND a.attname='batch7_revision' AND a.attnotnull AND NOT a.attisdropped
   AND c.relname IN ('Customer','Payment','Trip','OfficialInvoice'))<>4
 OR EXISTS(SELECT 1 FROM $schema.staff_session)
 OR (SELECT count(*) FROM $schema.staff_authorization)<>1
 OR (SELECT count(*) FROM $schema.payment_scope)<>1
 OR (SELECT count(*) FROM $schema.receivable WHERE payable=70.00)<>1
 OR (SELECT count(*) FROM $schema.invoice_attribution)<>1
 OR (SELECT count(*) FROM $schema.operation_scope)<>1
 OR (SELECT count(*) FROM $schema.invoice_reservation)<>1
 OR NOT EXISTS(SELECT 1 FROM $schema.operation_scope s JOIN $schema."FinancialOperation" o ON o.id=s.operation_id
   JOIN $schema.invoice_reservation r ON r.operation_id=o.id
   JOIN $schema.receivable v ON (v.id,v.customer_id)=(r.receivable_id,r.customer_id)
   JOIN $schema.staff_authorization a ON a.staff_id=o."actorId"
   WHERE o."idempotencyKey"='candidate-bound' AND a.revision=1 AND v.revision=1
   AND v.trip_id='70000000-0000-4000-8000-000000000003'
   AND r.invoice_id='70000000-0000-4000-8000-000000000005'
   AND s.payment_id='70000000-0000-4000-8000-000000000006')
 THEN RAISE EXCEPTION 'Upgraded catalog or evidence mismatch'; END IF;
END `$check`$;
"@
        $catalogBody = $parsed.Groups['body'].Value
        $evidence = [ordered]@{
            status='BATCH7_CANDIDATE_UPGRADE_ATTEMPT_STARTED';creationRunId=$run;databaseOid='16394';schema=$schema;schemaOid=$schemaOid
            beforeCatalogSha256=$catalogHash;beforeDataSha256=$dataHash;archiveSha256=$archiveHash;upgradeSqlSha256=$upgradePins
        }
        if ($CommitUpgrade) {
            foreach ($path in @($upgradeAttempt,$upgradeReceipt,$afterPath)) {
                if (Test-Path -LiteralPath $path) { throw 'Prior candidate upgrade evidence exists' }
            }
            $writeSetup = $setup.Replace('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;','BEGIN ISOLATION LEVEL READ COMMITTED;')
            $relations = ($tables | ForEach-Object { $schema + '."' + $_ + '"' }) -join ','
            $writeSetup += "`nSELECT pg_advisory_xact_lock(176661,1);`nLOCK TABLE $relations IN ACCESS EXCLUSIVE MODE NOWAIT;"
            $baselineCatalog = $catalogBody.Replace('WITH scope AS (','CREATE TEMP TABLE candidate_before_catalog AS WITH scope AS (').
                Replace('FROM contract;','AS receipt FROM contract;')
            $baselineData = $data.Replace('WITH manifest AS (','CREATE TEMP TABLE candidate_before_data AS WITH manifest AS (').
                Replace('FROM manifest;','AS receipt FROM manifest;')
            $afterData = $unchangedData.Replace('WITH manifest AS (','CREATE TEMP TABLE candidate_after_data AS WITH manifest AS (').
                Replace('FROM manifest;','AS receipt FROM manifest;')
            $verifyBefore = @"
DO `$baseline`$ BEGIN
 IF (SELECT receipt->>'catalogSha256' FROM pg_temp.candidate_before_catalog) IS DISTINCT FROM '$catalogHash'
 OR (SELECT receipt->>'dataSha256' FROM pg_temp.candidate_before_data) IS DISTINCT FROM '$dataHash'
 THEN RAISE EXCEPTION 'Candidate baseline drift'; END IF;
END `$baseline`$;
"@
            $verifyAfter = @"
DO `$preserve`$ BEGIN
 IF (SELECT receipt->>'dataSha256' FROM pg_temp.candidate_after_data) IS DISTINCT FROM '$dataHash'
 THEN RAISE EXCEPTION 'Candidate historical data changed'; END IF;
END `$preserve`$;
"@
            $commands = @('-qAt','-c',($writeSetup -replace '[\r\n]+',' '),
                '-c',($baselineCatalog -replace '[\r\n]+',' '),'-c',($baselineData -replace '[\r\n]+',' '),
                '-c',($verifyBefore -replace '[\r\n]+',' '),'-c',"SET LOCAL ROLE $($proof.expectedOwner);",
                '-f',$paths[0],'-f',$paths[1],'-c','RESET ROLE;',
                '-c',($shape -replace '[\r\n]+',' '),'-c',($afterData -replace '[\r\n]+',' '),
                '-c',($verifyAfter -replace '[\r\n]+',' '),'-c','COMMIT;',
                '-c',"SELECT 'BATCH7_CANDIDATE_UPGRADED' FROM pg_namespace WHERE nspname='$schema' AND oid=$schemaOid::oid;")
            $commandLength = (($commands | ForEach-Object { ConvertTo-MainNativeArgument $_ }) -join ' ').Length
            if ($commandLength -gt 30000) { throw 'Upgrade command exceeds reviewed Windows argument limit' }
            Write-MainExclusiveJson $upgradeAttempt $evidence
            $result = Invoke-MainPg -Tool psql -User postgres -Database $db -Interactive -Extra $commands
            if ($result.ExitCode -ne 0 -or $result.Output.Trim() -cne 'BATCH7_CANDIDATE_UPGRADED') {
                throw 'Candidate upgrade failed or outcome is uncertain; preserve evidence'
            }
            $evidence.status = 'BATCH7_CANDIDATE_UPGRADED'
            Write-MainExclusiveJson $upgradeReceipt $evidence
            $evidence | ConvertTo-Json -Depth 5 -Compress
            return
        }
        $verified = Get-Content -LiteralPath $upgradeReceipt -Raw | ConvertFrom-Json
        if ($verified.status -cne 'BATCH7_CANDIDATE_UPGRADED' -or (Test-Path -LiteralPath $afterPath)) {
            throw 'Upgrade receipt or prior reconciliation refused'
        }
        foreach ($key in @('creationRunId','databaseOid','schema','schemaOid','beforeCatalogSha256','beforeDataSha256','archiveSha256')) {
            if ($verified.$key -cne $evidence[$key]) { throw 'Upgrade receipt identity mismatch' }
        }
        foreach ($name in $upgradePins.Keys) {
            if ($verified.upgradeSqlSha256.$name -cne $upgradePins[$name]) { throw 'Upgrade receipt pin mismatch' }
        }
        $commands = @('-qAt','-c',($setup -replace '[\r\n]+',' '),'-c',($shape -replace '[\r\n]+',' '),
            '-c',($catalogBody -replace '[\r\n]+',' '),'-c',($unchangedData -replace '[\r\n]+',' '),'-c','ROLLBACK;')
        $result = Invoke-MainPg -Tool psql -User postgres -Database $db -Interactive -ReadOnly -Extra $commands
        $rows = @($result.Output -split '\r?\n' | Where-Object { $_.Trim() })
        if ($result.ExitCode -ne 0 -or $rows.Count -ne 2) { throw 'Independent upgrade capture failed' }
        $afterCatalog = ConvertFrom-Json -InputObject $rows[0]
        $afterData = ConvertFrom-Json -InputObject $rows[1]
        if ($afterCatalog.status -cne 'BATCH7_COMMITTED_CATALOG_CAPTURED_READ_ONLY' -or
            $afterCatalog.databaseOid -cne '16394' -or $afterCatalog.schemaOid -cne $schemaOid -or
            $afterCatalog.catalogSha256 -cnotmatch '^[a-f0-9]{64}$' -or $afterCatalog.catalogSha256 -ceq $catalogHash -or
            $null -ne $afterCatalog.catalog.externalForeignKeys -or
            $afterData.status -cne 'BATCH7_CANDIDATE_DATA_CAPTURED_READ_ONLY' -or $afterData.dataSha256 -cne $dataHash) {
            throw 'Independent upgrade evidence mismatch'
        }
        $evidence.status = 'BATCH7_CANDIDATE_UPGRADE_RECONCILED'
        $evidence.catalogSha256 = $afterCatalog.catalogSha256
        $evidence.preservedDataSha256 = $afterData.dataSha256
        Write-MainExclusiveJson $afterPath ($evidence + @{catalog=$afterCatalog.catalog;preservedData=$afterData.data})
        $evidence | ConvertTo-Json -Depth 5 -Compress
        return
    } finally {
        foreach ($stream in $streams) { $stream.Dispose() }
    }
}
if ($Backup -or $PostAcceptanceBackup) {
    $before = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
    if ($before.status -cne 'BATCH7_CANDIDATE_BASELINE_CAPTURED' -or $before.phase -cne 'BEFORE' -or
        $before.creationRunId -cne $run -or $before.databaseOid -cne '16394' -or $before.schema -cne $schema -or
        $before.schemaOid -cne $schemaOid -or
        $before.catalogSha256 -cne '7ffaf2802df724b7c590237123adfe27230ce32d54990adb82fb900d874b8a84' -or
        $before.dataSha256 -cne '4643dfd32fc66aadb667922f9d096a5303ab0ceb0c95c42a4e76e4fbf631891e') {
        throw 'Captured baseline identity or digest refused'
    }
    foreach ($name in $pins.Keys) {
        if ($before.sqlSha256.$name -cne $pins[$name]) { throw 'Captured baseline pin mismatch' }
    }
    $attemptPath = Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-backup-attempt.json')
    $archive = Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-before.dump')
    $toc = Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-before.toc')
    $backupPath = Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-backup.json')
    $retryPath = Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-backup-retry-attempt.json')
    $snapshotOutput = Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-backup-snapshot.txt')
    if ($PostAcceptanceBackup) {
        $afterPath = Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-after-upgrade.json')
        if ((Get-FileHash -LiteralPath $afterPath -Algorithm SHA256).Hash -cne '6E9828A3CDC3C7F3A7543708ECF50BD14D2D65296EED1C4C09A4AF273707850E') {
            throw 'Post-upgrade evidence hash mismatch'
        }
        $operationId = 'df8dac6e-fe10-4a56-b377-11ba5abbe71d'
        $prefix = 'artifacts\main-batch7-candidate-post-acceptance'
        $attemptPath = Assert-MainLocalPath (Join-Path $root "$prefix-attempt.json")
        $archive = Assert-MainLocalPath (Join-Path $root "$prefix.dump")
        $toc = Assert-MainLocalPath (Join-Path $root "$prefix.toc")
        $backupPath = Assert-MainLocalPath (Join-Path $root "$prefix.json")
        $snapshotOutput = Assert-MainLocalPath (Join-Path $root "$prefix-snapshot.txt")
        $setup += @"

DO `$accepted`$ BEGIN
 IF NOT EXISTS (
   SELECT 1 FROM pg_roles w WHERE w.oid=20051 AND w.rolname='flsd_batch7_candidate_writer'
     AND NOT w.rolcanlogin AND shobj_description(w.oid,'pg_authid')='FLSD_SYNTHETIC_BATCH7_ACCEPTANCE_V1'
 ) OR NOT EXISTS (
   SELECT 1 FROM $schema."FinancialOperation" o
   JOIN $schema.operation_scope s ON (s.operation_id,s.payment_id)=(o.id,o."paymentId")
   JOIN $schema."PaymentAllocationEvent" e ON
     (e."operationId",e."paymentId",e."invoiceId",e."actorId")=(o.id,s.payment_id,s.invoice_id,o."actorId")
   JOIN $schema."AuditEvent" a ON a.after=o.receipt AND a."actorId"=o."actorId" AND a."entityId"=s.payment_id::text
   JOIN $schema.invoice_reservation v ON (v.invoice_id,v.customer_id,v.receivable_id)=(s.invoice_id,s.customer_id,s.receivable_id)
   JOIN $schema."PaymentAllocation" p ON (p."paymentId",p."invoiceId")=(s.payment_id,s.invoice_id)
   WHERE o.id='$operationId' AND o."idempotencyKey"='candidate-acceptance-allocation' AND o."operationType"='ALLOCATE_PAYMENT'
     AND o."allocatedCash"=20.01 AND e."cashDelta"=20.01 AND p.amount=30.02 AND p."withheldTax"=0
     AND e.action='ALLOCATE' AND e."withheldTaxDelta"=0 AND a.action='PAYMENT_ALLOCATION_CONFIRMED'
     AND v.operation_id='70000000-0000-4000-8000-000000000007'
 ) THEN RAISE EXCEPTION 'Accepted operation or retired role mismatch'; END IF;
END `$accepted`$;
"@
    }
    if ($RetryInterruptedSnapshot) {
      foreach ($priorPath in @($attemptPath,$retryPath)) {
        $prior = Get-Content -LiteralPath $priorPath -Raw | ConvertFrom-Json
        if ($prior.status -cne 'BATCH7_CANDIDATE_BACKUP_ATTEMPT_STARTED' -or $prior.creationRunId -cne $run -or
            $prior.databaseOid -cne '16394' -or $prior.schema -cne $schema -or $prior.schemaOid -cne $schemaOid -or
            $prior.catalogSha256 -cne $before.catalogSha256 -or $prior.dataSha256 -cne $before.dataSha256) {
            throw 'Prior snapshot attempt identity refused'
        }
      }
      $attemptPath = Assert-MainLocalPath (Join-Path $root 'artifacts\main-batch7-candidate-backup-file-attempt.json')
    }
    foreach ($path in @($attemptPath,$archive,$toc,$backupPath,$snapshotOutput)) {
        if (Test-Path -LiteralPath $path) { throw 'Prior candidate backup evidence exists' }
    }
    $bin = 'C:\Program Files\PostgreSQL\18\bin'
    $versions = @{}
    foreach ($tool in @('psql','pg_dump','pg_restore')) {
        $version = & (Join-Path $bin "$tool.exe") --version
        if ($LASTEXITCODE -ne 0 -or $version -cne "$tool (PostgreSQL) 18.7") { throw 'Pinned PostgreSQL tool version refused' }
        $versions[$tool] = $version
    }
    if ($PlanOnly) {
        [ordered]@{status='POST_ACCEPTANCE_BACKUP_PLAN_VERIFIED_OFFLINE';operationId=$operationId;tables=$tables.Count;databaseCommands=0} |
            ConvertTo-Json -Compress
        return
    }
    $evidence = [ordered]@{
        status='BATCH7_CANDIDATE_BACKUP_ATTEMPT_STARTED';creationRunId=$run;databaseOid='16394';schema=$schema
        schemaOid=$schemaOid;catalogSha256=$before.catalogSha256;dataSha256=$before.dataSha256;toolVersions=$versions
    }
    if ($PostAcceptanceBackup) { $evidence.operationId=$operationId }
    Write-MainExclusiveJson $attemptPath $evidence
    $reservation = [IO.File]::Open($snapshotOutput,[IO.FileMode]::CreateNew)
    $reservation.Dispose()
    $info = New-MainPgProcessInfo (Join-Path $bin 'psql.exe') @(
        '-X','-qAt','-w','-v','ON_ERROR_STOP=on','-h','127.0.0.1','-p','5432','-U','postgres','-d',$db,
        '-o',$snapshotOutput,'-c',($setup -replace '[\r\n]+',' '),
        '-c',($parsed.Groups['body'].Value -replace '[\r\n]+',' '),'-c',($data -replace '[\r\n]+',' '),
        '-c','SELECT pg_export_snapshot();','-c','\o',
        '-c',"SET LOCAL statement_timeout='250s'; SELECT pg_sleep(240);",'-c','ROLLBACK;'
    ) -ReadOnly
    $info.EnvironmentVariables['PGOPTIONS'] += ' -c idle_in_transaction_session_timeout=300000'
    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $info
    $started = $false
    $secret = Read-Host 'Local postgres password for the read-only snapshot connection' -AsSecureString
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
        $timer = [Diagnostics.Stopwatch]::StartNew()
        $lines = @()
        Write-Host 'Checking candidate catalog and data in the read-only snapshot.'
        while ($timer.ElapsedMilliseconds -lt 30000 -and !$process.HasExited) {
            try { $lines = @([IO.File]::ReadAllLines($snapshotOutput,[Text.Encoding]::UTF8)) }
            catch [IO.IOException] { $lines = @() }
            if ($lines.Count -eq 3 -and $lines[2] -cmatch '^[0-9A-F]+-[0-9A-F]+-[0-9]+$') { break }
            Start-Sleep -Milliseconds 150
        }
        if ($process.HasExited -or $lines.Count -ne 3 -or $lines[2] -cnotmatch '^[0-9A-F]+-[0-9A-F]+-[0-9]+$') {
            throw 'Exported snapshot unavailable; preserve attempt'
        }
        $liveCatalog = ConvertFrom-Json -InputObject $lines[0]
        $liveData = ConvertFrom-Json -InputObject $lines[1]
        if ($liveCatalog.status -cne 'BATCH7_COMMITTED_CATALOG_CAPTURED_READ_ONLY' -or
            $liveCatalog.databaseOid -cne '16394' -or $liveCatalog.schemaOid -cne $schemaOid -or
            $liveCatalog.catalogSha256 -cnotmatch '^[a-f0-9]{64}$' -or
            $liveData.status -cne 'BATCH7_CANDIDATE_DATA_CAPTURED_READ_ONLY' -or
            $liveData.dataSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Live snapshot identity or digest refused' }
        if ($PostAcceptanceBackup) {
            $expected = @{AuditEvent=2;Customer=1;FinancialOperation=3;OfficialInvoice=1;Payment=1;
                PaymentAllocation=1;PaymentAllocationEvent=3;PaymentRefund=2;SoaTrip=1;StaffUser=1;StatementOfAccount=1;Trip=1;
                staff_authorization=1;payment_scope=1;receivable=1;invoice_attribution=1;operation_scope=2;invoice_reservation=1}
            foreach ($table in $tables) {
                $entry = $liveData.data.tables.$table
                $expectedCount = if ($expected.ContainsKey($table)) { $expected[$table] } else { 0 }
                if ($entry.Count -ne 2 -or $entry[1] -cnotmatch '^[a-f0-9]{64}$' -or
                    ($table -ceq 'staff_session' -and $entry[0] -lt 1) -or
                    ($table -cne 'staff_session' -and $entry[0] -ne $expectedCount)) { throw 'Accepted table inventory mismatch' }
            }
            $money = @($liveData.data.financial)
            if ($money.Count -ne 1 -or $money[0].paymentId -cne '70000000-0000-4000-8000-000000000006' -or
                $money[0].receivedCentavos -cne '10001' -or $money[0].allocatedCentavos -cne '3002' -or
                $money[0].refundCentavos -cne '3000' -or $null -ne $liveCatalog.catalog.externalForeignKeys) {
                throw 'Accepted financial or dependency reconciliation mismatch'
            }
            $evidence.catalogSha256 = $liveCatalog.catalogSha256
            $evidence.dataSha256 = $liveData.dataSha256
        } elseif ($liveCatalog.catalogSha256 -cne $before.catalogSha256 -or $liveData.dataSha256 -cne $before.dataSha256) {
            throw 'Live baseline drift detected'
        }
        $snapshot = $lines[2]
        $reserved = [IO.File]::Open($archive,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
        try {
            $dumpArgs = @(
                '-Fc','--encoding=UTF8','--no-statistics','--strict-names',"--schema=$schema","--snapshot=$snapshot",'-f',$archive
            )
            if ($PostAcceptanceBackup) {
                Write-Host 'Snapshot reconciled. Archiving the candidate schema.'
                $dumpInfo = New-MainPgProcessInfo (Join-Path $bin 'pg_dump.exe') (
                    @('-w','-h','127.0.0.1','-p','5432','-U','postgres','-d',$db) + $dumpArgs
                ) -ReadOnly
                $dumpProcess = [Diagnostics.Process]::new()
                $dumpProcess.StartInfo = $dumpInfo
                $dumpStarted = $false
                $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
                try {
                    $dumpInfo.EnvironmentVariables['PGPASSWORD'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer)
                    try { $dumpStarted = $dumpProcess.Start() }
                    finally {
                        $dumpInfo.EnvironmentVariables.Remove('PGPASSWORD')
                        [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
                        $pointer = [IntPtr]::Zero
                    }
                    $dumpOutput = $dumpProcess.StandardOutput.ReadToEndAsync()
                    if (!$dumpProcess.WaitForExit(90000)) { throw 'Snapshot dump timed out' }
                    $null = $dumpOutput.GetAwaiter().GetResult()
                    $dumpExit = $dumpProcess.ExitCode
                } finally {
                    if ($dumpStarted -and !$dumpProcess.HasExited) { $dumpProcess.Kill(); $dumpProcess.WaitForExit() }
                    $dumpProcess.Dispose()
                }
            } else {
                Write-Host 'Snapshot reconciled. Enter the local postgres password for pg_dump when prompted.'
                $dumpExit = (Invoke-MainPg -Tool pg_dump -User postgres -Database $db -Interactive -ReadOnly -Extra $dumpArgs).ExitCode
            }
            if ($dumpExit -ne 0 -or $process.HasExited -or $reserved.Length -eq 0) { throw 'Snapshot backup failed' }
        } finally { $reserved.Dispose() }
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
        $secret.Dispose()
        if ($started -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
    $reader = [IO.File]::Open($archive,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
    $tocStream = $null
    try {
        $tocStream = [IO.File]::Open($toc,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::ReadWrite)
        $list = Invoke-MainPg -Tool pg_restore -User postgres -Database $db -LocalArchiveOnly -Extra @('-l','-f',$toc,$archive)
        if ($list.ExitCode -ne 0 -or $tocStream.Length -eq 0) { throw 'Archive listing failed' }
        $entries = @(Get-Content -LiteralPath $toc | Where-Object { $_ -match '^\d+;' })
        $quotedSchema = [regex]::Escape($schema)
        $schemaEntries = @($entries | Where-Object { $_ -match "\bSCHEMA - $quotedSchema " })
        $tableEntries = @($entries | Where-Object { $_ -match "\bTABLE $quotedSchema " })
        $dataEntries = @($entries | Where-Object { $_ -match "\bTABLE DATA $quotedSchema " })
        $sequenceEntries = @($entries | Where-Object { $_ -match "\bSEQUENCE(?: SET)? $quotedSchema flsd_soa_number_seq " })
        foreach ($table in $tables) {
            $name = [regex]::Escape($table)
            if (@($tableEntries | Where-Object { $_ -cmatch "\bTABLE $quotedSchema $name " }).Count -ne 1 -or
                @($dataEntries | Where-Object { $_ -cmatch "\bTABLE DATA $quotedSchema $name " }).Count -ne 1) {
                throw 'Archive table inventory mismatch'
            }
        }
        $owner = 'flsd_test_owner_b813e7439f4c'
        $entryScope = "^\d+; \d+ \d+ (?:(?:SCHEMA -|COMMENT - SCHEMA|ACL - SCHEMA) $quotedSchema|(?:TYPE|TABLE|TABLE DATA|SEQUENCE|SEQUENCE SET|CONSTRAINT|FK CONSTRAINT|INDEX|ACL) $quotedSchema .+) $owner$"
        if ($schemaEntries.Count -ne 1 -or $tableEntries.Count -ne $tables.Count -or $dataEntries.Count -ne $tables.Count -or
            $sequenceEntries.Count -ne 2 -or @($entries | Where-Object { $_ -cnotmatch $entryScope }).Count) {
            throw 'Archive namespace or sequence inventory mismatch'
        }
        $evidence.status = if ($PostAcceptanceBackup) { 'BATCH7_CANDIDATE_POST_ACCEPTANCE_BACKUP_VERIFIED' } else { 'BATCH7_CANDIDATE_BACKUP_VERIFIED' }
        $evidence.archiveSha256 = (Get-FileHash -InputStream $reader -Algorithm SHA256).Hash
        $evidence.tocSha256 = (Get-FileHash -InputStream $tocStream -Algorithm SHA256).Hash
        $evidence.tables = $tableEntries.Count
        if ($PostAcceptanceBackup) {
            Write-MainExclusiveJson $backupPath ($evidence + @{catalog=$liveCatalog.catalog;data=$liveData.data})
        } else {
            Write-MainExclusiveJson $backupPath $evidence
        }
        $evidence | ConvertTo-Json -Depth 5 -Compress
    } finally {
        if ($tocStream) { $tocStream.Dispose() }
        $reader.Dispose()
    }
    return
}
$commands = @('-qAt','-c',($setup -replace '[\r\n]+',' '),'-c',($parsed.Groups['body'].Value -replace '[\r\n]+',' '),
    '-c',($data -replace '[\r\n]+',' '),'-c','ROLLBACK;')
$result = Invoke-MainPg -Tool psql -User postgres -Database $db -ReadOnly -Interactive -Extra $commands
$rows = @($result.Output -split '\r?\n' | Where-Object { $_.Trim() })
if ($result.ExitCode -ne 0 -or $rows.Count -ne 2) { throw 'Read-only baseline capture failed' }
$catalogReceipt = ConvertFrom-Json -InputObject $rows[0]
$dataReceipt = ConvertFrom-Json -InputObject $rows[1]
if ($catalogReceipt.status -cne 'BATCH7_COMMITTED_CATALOG_CAPTURED_READ_ONLY' -or
    $catalogReceipt.databaseOid -cne '16394' -or $catalogReceipt.schemaOid -cne $schemaOid -or
    $catalogReceipt.catalogSha256 -cnotmatch '^[a-f0-9]{64}$' -or
    $dataReceipt.status -cne 'BATCH7_CANDIDATE_DATA_CAPTURED_READ_ONLY' -or
    $dataReceipt.dataSha256 -cnotmatch '^[a-f0-9]{64}$') { throw 'Baseline capture result refused' }
$expectedCounts = @{AuditEvent=1;Customer=1;FinancialOperation=2;OfficialInvoice=1;Payment=1;
    PaymentAllocation=1;PaymentAllocationEvent=2;PaymentRefund=2;SoaTrip=1;StaffUser=1;StatementOfAccount=1;Trip=1}
foreach ($table in $tables) {
    $expectedCount = if ($expectedCounts.ContainsKey($table)) { $expectedCounts[$table] } else { 0 }
    $entry = $dataReceipt.data.tables.$table
    if ($entry.Count -ne 2 -or $entry[0] -ne $expectedCount -or $entry[1] -cnotmatch '^[a-f0-9]{64}$') {
        throw 'Baseline row inventory mismatch'
    }
}
$money = @($dataReceipt.data.financial)
if ($money.Count -ne 1 -or $money[0].paymentId -cne '70000000-0000-4000-8000-000000000006' -or
    $money[0].receivedCentavos -cne '10001' -or $money[0].allocatedCentavos -cne '1001' -or
    $money[0].refundCentavos -cne '3000' -or $null -ne $catalogReceipt.catalog.externalForeignKeys) {
    throw 'Baseline reconciliation mismatch'
}
$manifest = [ordered]@{status='BATCH7_CANDIDATE_BASELINE_CAPTURED';phase='BEFORE';creationRunId=$run;databaseOid='16394'
    schema=$schema;schemaOid=$schemaOid;sqlSha256=$pins;catalogSha256=$catalogReceipt.catalogSha256;dataSha256=$dataReceipt.dataSha256}
Write-MainExclusiveJson $outputPath ($manifest + @{catalog=$catalogReceipt.catalog;data=$dataReceipt.data})
$manifest | ConvertTo-Json -Depth 5 -Compress
