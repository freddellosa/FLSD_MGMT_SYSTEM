#requires -Version 5.1
[CmdletBinding()]
param([switch]$Rehearse)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) { throw 'Wrong workspace' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$db = 'flsd_main_adapter_test'
$schema = 'flsd_batch7_upgrade_review'
$owner = 'flsd_test_owner_b813e7439f4c'
$proof = Read-MainCreationProof $root
if ($proof.runId -cne 'b813e743-9f4c-4121-b8ab-b01ca51b9335' -or $proof.adminUser -cne 'postgres' -or
    $proof.expectedOwner -cne $owner -or ($proof.verifiedDatabases | Where-Object name -CEQ $db).oid -cne '16394' -or
    ($proof.verifiedRoles | Where-Object name -CEQ $owner).oid -cne '16392') { throw 'Creation proof mismatch' }
$pins = [ordered]@{
    'prisma\migrations\20261114_001_foundation\migration.sql' = '333895DEBE54F052FB3345B38584942F825F75C7793332EE4A6FABC5A096C747'
    'prisma\migration-review\batch7-upgrade-foundation-fixture.sql' = '7B3C471822F807B3F3941B886A717DE52523C5FBCA18781B33DD6A06A2A116FA'
    'prisma\migration-review\batch7-upgrade-receipt-fixture.sql' = '74B595CB06E9D412FA78EDCA54D86C0634880DE68814FA8647816437292F8B96'
    'prisma\migration-review\batch7-upgrade-v1.sql' = '999BC7B0E7972B1BE92A29F0F4C1625A8F015A2BBA7A579679D38851E2614845'
}
$paths = @()
$streams = @()
try {
    foreach ($name in $pins.Keys) {
        $path = Assert-MainLocalPath (Join-Path $root $name)
        $stream = [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $streams += $stream
        if ((Get-FileHash -InputStream $stream -Algorithm SHA256).Hash -cne $pins[$name]) { throw 'Batch 7 review hash mismatch' }
        $paths += $path
    }
    if (!$Rehearse) {
        @{status='BATCH7_UPGRADE_PINS_VERIFIED_OFFLINE';databaseCommandsExecuted=0;sqlSha256=$pins} |
            ConvertTo-Json -Depth 3 -Compress
        return
    }
    $guard = Get-MainIdentityGuardSql $proof $db $false
    $setup = @"
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL search_path TO pg_catalog;
$guard
SELECT pg_advisory_xact_lock(176661,1);
DO `$target`$ BEGIN
 IF current_setting('server_version_num')<>'180007'
    OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='$schema')
 THEN RAISE EXCEPTION 'Batch 7 upgrade rehearsal target refused'; END IF;
END `$target`$;
SET LOCAL ROLE $owner;
CREATE SCHEMA $schema;
COMMENT ON SCHEMA $schema IS 'FLSD_SYNTHETIC_BATCH7_UPGRADE_V1';
SET LOCAL search_path TO $schema, pg_catalog;
"@
    $snapshot = @"
SET LOCAL search_path TO pg_catalog;
CREATE TEMP TABLE batch7_before AS SELECT
 (SELECT jsonb_agg(to_jsonb(c) ORDER BY id) FROM $schema."Customer" c) AS customers,
 (SELECT jsonb_agg(to_jsonb(p) ORDER BY id) FROM $schema."Payment" p) AS payments,
 (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM $schema."Trip" t) AS trips,
 (SELECT jsonb_agg(to_jsonb(i) ORDER BY id) FROM $schema."OfficialInvoice" i) AS invoices,
 (SELECT jsonb_agg(to_jsonb(a) ORDER BY "paymentId","invoiceId") FROM $schema."PaymentAllocation" a) AS allocations;
"@
    $verify = @"
DO `$verified`$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_temp.batch7_before b WHERE
   b.customers=(SELECT jsonb_agg(to_jsonb(c)-'batch7_revision' ORDER BY id) FROM $schema."Customer" c)
   AND b.payments=(SELECT jsonb_agg(to_jsonb(p)-'batch7_revision' ORDER BY id) FROM $schema."Payment" p)
   AND b.trips=(SELECT jsonb_agg(to_jsonb(t)-'batch7_revision' ORDER BY id) FROM $schema."Trip" t)
   AND b.invoices=(SELECT jsonb_agg(to_jsonb(i)-'batch7_revision' ORDER BY id) FROM $schema."OfficialInvoice" i)
   AND b.allocations=(SELECT jsonb_agg(to_jsonb(a) ORDER BY "paymentId","invoiceId") FROM $schema."PaymentAllocation" a))
 OR EXISTS(SELECT 1 FROM $schema.staff_session)
 OR EXISTS(SELECT 1 FROM $schema.operation_scope)
 OR EXISTS(SELECT 1 FROM $schema.invoice_reservation)
 OR EXISTS(SELECT 1 FROM $schema.payment_scope)
 OR EXISTS(SELECT 1 FROM $schema.invoice_attribution)
 OR EXISTS(SELECT 1 FROM $schema.receivable)
 THEN RAISE EXCEPTION 'Batch 7 upgrade preservation mismatch'; END IF;
END `$verified`$;
"@
    $snapshotReceipt = @"
CREATE TEMP TABLE batch7_receipts_before AS SELECT
 (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM $schema."FinancialOperation" o) AS receipts,
 (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM $schema."PaymentAllocationEvent" e) AS events;
"@
    $verifyReceipt = @"
DO `$receipt`$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_temp.batch7_receipts_before b WHERE
   b.receipts=(SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM $schema."FinancialOperation" o)
   AND b.events=(SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM $schema."PaymentAllocationEvent" e))
 THEN RAISE EXCEPTION 'Batch 7 receipt history preservation mismatch'; END IF;
END `$receipt`$;
"@
    foreach ($baseline in @('FOUNDATION','RECEIPT_BEARING')) {
        $commands = @('-qAt','-c',($setup -replace '[\r\n]+',' '),'-f',$paths[0],'-f',$paths[1],
            '-c',($snapshot -replace '[\r\n]+',' '))
        if ($baseline -eq 'RECEIPT_BEARING') {
            $commands += @('-f',$paths[2],'-c',($snapshotReceipt -replace '[\r\n]+',' '))
        }
        $commands += @('-f',$paths[3],'-c',($verify -replace '[\r\n]+',' '))
        if ($baseline -eq 'RECEIPT_BEARING') {
            $commands += @('-c',($verifyReceipt -replace '[\r\n]+',' '))
        } else {
            $commands += @('-c',"DO `$empty`$ BEGIN IF EXISTS(SELECT 1 FROM $schema.`"FinancialOperation`") THEN RAISE EXCEPTION 'Unexpected foundation receipt'; END IF; END `$empty`$;")
        }
        $commands += @('-c','ROLLBACK;','-c',"SELECT '$baseline' WHERE to_regnamespace('$schema') IS NULL;")
        $result = Invoke-MainPg -Tool psql -User postgres -Database $db -Interactive -Extra $commands
        if ($result.ExitCode -ne 0 -or $result.Output.Trim() -cne $baseline) {
            throw ('Batch 7 rollback rehearsal failed or evidence is uncertain for ' + $baseline)
        }
    }
    @{status='BATCH7_UPGRADE_ROLLBACK_REHEARSAL_VERIFIED';databaseOid='16394';baselines=2;rawOutputIncluded=$false} |
        ConvertTo-Json -Compress
} finally {
    foreach ($stream in $streams) { $stream.Dispose() }
}
