#requires -Version 5.1
[CmdletBinding()]
param([switch]$ConnectReadOnly)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) { throw 'Wrong workspace' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$proof = Read-MainCreationProof $root
$db = 'flsd_main_adapter_test'
$schema = 'flsd_combined_write_rehearsal'
$role = 'flsd_combined_write_runner_75435c870a31'
$run = 'b813e743-9f4c-4121-b8ab-b01ca51b9335'
if ($proof.runId -cne $run -or $proof.adminUser -cne 'postgres' -or
    ($proof.verifiedDatabases | Where-Object name -CEQ $db).oid -cne '16394' -or
    ($proof.verifiedRoles | Where-Object name -CEQ $proof.expectedOwner).oid -cne '16392') { throw 'Creation proof mismatch' }
$pins = @{
    'combined-write-disposable-v1.sql' = 'D2304EC5554962ABD3956032EE472BEBEAF70A035D778B1D3ECF9E64716E62E4'
    'combined-write-disposable-fixture-v1.sql' = '946BA2B249FA5A6A34FBDC5A16E921E04A11A3C6D33DE3C44E17EFBE9A58DE28'
}
$expected = @{creationRunId=$run;database=$db;databaseOid='16394';schema=$schema;appRole=$role}
$stages = @{
    'install-attempt' = 'COMBINED_WRITE_INSTALL_ATTEMPT_STARTED'
    'installed' = 'COMBINED_WRITE_INSTALLED'
    'result' = 'COMBINED_WRITE_CONNECTED_FAILED'
}
foreach ($stage in $stages.Keys) {
    $path = Assert-MainLocalPath (Join-Path $root "artifacts\main-combined-write-$stage.json")
    $receipt = Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
    if ($receipt.status -cne $stages[$stage]) { throw 'Receipt status mismatch' }
    foreach ($key in $expected.Keys) {
        if ($receipt.$key -cne $expected[$key]) { throw 'Receipt identity mismatch' }
    }
    foreach ($name in $pins.Keys) {
        if ($receipt.sqlSha256.$name -cne $pins[$name]) { throw 'Receipt SQL hash mismatch' }
    }
    if ($stage -ne 'install-attempt' -and ($receipt.schemaOid -cne '17643' -or $receipt.roleOid -cne '17642')) {
        throw 'Installed OID mismatch'
    }
    if ($stage -eq 'result' -and ($receipt.phase -cne 'REVOCATION' -or $receipt.rawOutputIncluded -ne $false)) {
        throw 'Unexpected result phase'
    }
}
foreach ($name in $pins.Keys) {
    $path = Assert-MainLocalPath (Join-Path $root "prisma\production-review\$name")
    if ((Get-FileHash -LiteralPath $path -Algorithm SHA256).Hash -cne $pins[$name]) { throw 'Reviewed SQL hash mismatch' }
}
if (!$ConnectReadOnly) { Write-Output 'COMBINED_WRITE_INSPECTION_RECEIPTS_VERIFIED_OFFLINE'; return }

$guard = Get-MainIdentityGuardSql $proof $db $false
$marker = "FLSD_SYNTHETIC_COMBINED_WRITE_V1:$run"
$sql = @"
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog;
$guard
DO `$inspect`$ BEGIN
 IF current_setting('server_version_num')<>'180007' OR current_setting('transaction_read_only')<>'on'
 OR NOT EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN pg_roles r
  WHERE n.nspname='$schema' AND n.oid=17643::oid AND n.nspowner=16392::oid AND obj_description(n.oid,'pg_namespace')='$marker'
   AND r.rolname='$role' AND r.oid=17642::oid AND shobj_description(r.oid,'pg_authid')='$marker')
 THEN RAISE EXCEPTION 'Combined-write inspection identity refused'; END IF;
END `$inspect`$;
SELECT json_build_object(
 'status','COMBINED_WRITE_INSPECTED_READ_ONLY','databaseOid','16394','schemaOid','17643','roleOid','17642',
 'operations',(SELECT count(*) FROM $schema.financial_operation),
 'reservations',(SELECT count(*) FROM $schema.invoice_reservation),
 'events',(SELECT count(*) FROM $schema.allocation_event),
 'audits',(SELECT count(*) FROM $schema.allocation_audit),
 'allocationMatches',EXISTS(
   SELECT 1 FROM $schema.financial_operation o
   JOIN $schema.allocation_event e USING (authority_id,operation_id)
   JOIN $schema.allocation_audit a USING (authority_id,operation_id)
   JOIN $schema.invoice_reservation i ON (i.authority_id,i.created_by_operation,i.invoice_id,i.receivable_id,i.customer_id)
     =(o.authority_id,o.operation_id,o.invoice_id,o.receivable_id,o.customer_id)
   JOIN $schema.payment p ON (p.authority_id,p.id,p.customer_id)=(o.authority_id,o.payment_id,o.customer_id)
   JOIN $schema.trip_receivable r ON (r.authority_id,r.id,r.customer_id)=(o.authority_id,o.receivable_id,o.customer_id)
   JOIN $schema.customer c ON (c.authority_id,c.id)=(o.authority_id,o.customer_id)
   WHERE o.operation_key='synthetic-combined-primary' AND o.cash=60.01 AND e.cash_delta=o.cash
     AND a.actor_id=o.actor_id AND a.reason='Disposable combined allocation' AND p.allocated=o.cash
     AND r.outstanding=9.99 AND c.revision=2 AND p.revision=2 AND r.revision=2),
 'sessionState',COALESCE((SELECT CASE WHEN s.revoked_at IS NOT NULL THEN 'REVOKED'
   WHEN s.expires_at<=clock_timestamp() THEN 'EXPIRED' ELSE 'UNREVOKED' END
   FROM $schema.staff_session s WHERE s.authority_id='flsd-synthetic-combined-write'
     AND s.session_id='10000000-0000-4000-8000-000000000002'),'MISSING'),
 'staffRevision',(SELECT a.revision FROM $schema.staff_authorization a
   WHERE a.authority_id='flsd-synthetic-combined-write' AND a.staff_id='10000000-0000-4000-8000-000000000001'));
"@
$commands = @('-qAt','-c',($sql -replace '[\r\n]+',' '),'-c','ROLLBACK;')
$result = Invoke-MainPg -Tool psql -User postgres -Database $db -ReadOnly -Interactive -Extra $commands
if ($result.ExitCode -ne 0) { throw 'Read-only inspection failed' }
$summary = ConvertFrom-Json -InputObject $result.Output
if ($summary.status -cne 'COMBINED_WRITE_INSPECTED_READ_ONLY') { throw 'Inspection output refused' }
$summary | ConvertTo-Json -Compress
