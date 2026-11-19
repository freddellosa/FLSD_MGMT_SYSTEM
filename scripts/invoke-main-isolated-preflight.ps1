#requires -Version 5.1
[CmdletBinding(DefaultParameterSetName='Validate')]
param(
    [Parameter(ParameterSetName='Validate')][switch]$ValidateOnly,
    [Parameter(Mandatory=$true,ParameterSetName='Preflight')][switch]$Preflight,
    [Parameter(ParameterSetName='Preflight')][switch]$CatalogReview,
    [Parameter(Mandatory=$true,ParameterSetName='Install')][switch]$Install,
    [Parameter(ParameterSetName='Preflight')]
    [Parameter(ParameterSetName='Install')][switch]$Interactive
)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) {
    throw 'Run from the authorized validation workspace'
}
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')

$run = '75435c87-0a31-42b7-9761-738db6c5c866'
$database = 'flsd_main_adapter_test'
$prefix = "artifacts\main-adapter-isolated-$run"
$planPath = Assert-MainLocalPath (Join-Path $root "$prefix.json")
$installPath = Assert-MainLocalPath (Join-Path $root "$prefix.sql")
$preflightPath = Assert-MainLocalPath (Join-Path $root "$prefix-preflight.sql")
$migrationPath = Assert-MainLocalPath (Join-Path $root 'prisma\disposable-main-adapter.sql')
$proof = Read-MainCreationProof $root
$jsonHash = '35AC7780AAD8B2C757817A136CF08DFB687707B4E774DFBD8AC382E013B1D66F'
$sqlHash = 'C7B996379842F9CA46B2D5F816394135C0DC93B9EB0AB111528A891BF18F2748'
$preflightHash = '209DBE85DA16D45D740A87145352368BA06296509DB3F4887727885599677B1C'

# Keep the verified preflight file open with read sharing only until psql exits.
$preflightFile = [IO.File]::Open($preflightPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
try {
    if ((Get-FileHash -LiteralPath $planPath -Algorithm SHA256).Hash -cne $jsonHash -or
        (Get-FileHash -LiteralPath $installPath -Algorithm SHA256).Hash -cne $sqlHash -or
        (Get-FileHash -InputStream $preflightFile -Algorithm SHA256).Hash -cne $preflightHash) {
        throw 'Reviewed isolated bundle hash mismatch'
    }
    $plan = Get-Content -LiteralPath $planPath -Raw | ConvertFrom-Json
    $target = $proof.verifiedDatabases | Where-Object { $_.name -ceq $database }
    $migrationHash = (Get-FileHash -LiteralPath $migrationPath -Algorithm SHA256).Hash
    if ($plan.version -ne 3 -or $plan.status -cne 'PREPARED_OFFLINE_NOT_EXECUTED' -or
        $plan.runId -cne $run -or $plan.parentRunId -cne $proof.runId -or
        $plan.host -cne $proof.host -or $plan.port -ne $proof.port -or
        $plan.database -cne $database -or $plan.databaseOid -cne $target.oid -or
        $plan.sqlSha256 -cne $sqlHash -or $plan.preflightSha256 -cne $preflightHash -or
        $plan.sourceMigrationSha256 -cne $migrationHash -or $proof.migrationSha256 -cne $migrationHash) {
        throw 'Reviewed isolated bundle provenance mismatch'
    }

    if ($Install) {
        if (-not $Interactive) { throw 'Installation requires the local native password prompt' }
        $attemptPath = Assert-MainLocalPath (Join-Path $root "$prefix-install-attempt.json")
        $receiptPath = Assert-MainLocalPath (Join-Path $root "artifacts\main-adapter-isolated-installed-$run.json")
        if ((Test-Path -LiteralPath $attemptPath) -or (Test-Path -LiteralPath $receiptPath)) {
            throw 'Installation attempt or receipt exists; stop for inspection'
        }
    }

    $status = 'BUNDLE_VERIFIED_OFFLINE'
    $catalog = $null
    if ($Preflight) {
        $extra = @('-qAt', '-f', $preflightPath)
        if ($CatalogReview) {
            $guard = Get-MainIdentityGuardSql $proof $database $false
            $catalogSql = @"
BEGIN READ ONLY;
SET LOCAL search_path TO pg_catalog;
$guard
WITH public_relation_grants AS (
    SELECT c.oid, c.relkind, a.privilege_type
    FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
    WHERE a.grantee=0
), stock_view AS (
    SELECT 'pg_catalog.pg_settings'::regclass::oid AS oid
)
SELECT json_build_object(
    'serverVersion',current_setting('server_version_num'),
    'pgSettingsPublicUpdate',EXISTS(
        SELECT 1 FROM public_relation_grants g, stock_view v
        WHERE g.oid=v.oid AND g.relkind='v' AND g.privilege_type='UPDATE'
    ),
    'otherRelationWriteGrants',(SELECT count(*) FROM public_relation_grants g, stock_view v
        WHERE g.relkind IN('r','p','v','m','f')
          AND g.privilege_type IN('INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN')
          AND NOT (g.oid=v.oid AND g.privilege_type='UPDATE')),
    'columnWriteGrants',(SELECT count(*) FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
        WHERE a.grantee=0 AND c.attnum>0 AND NOT c.attisdropped
          AND a.privilege_type IN('INSERT','UPDATE','REFERENCES')),
    'schemaCreateGrants',(SELECT count(*) FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
        WHERE a.grantee=0 AND a.privilege_type='CREATE'),
    'sequenceWriteGrants',(SELECT count(*) FROM public_relation_grants g
        WHERE g.relkind='S' AND g.privilege_type IN('USAGE','UPDATE')),
    'largeObjectWriteGrants',(SELECT count(*) FROM pg_largeobject_metadata l CROSS JOIN LATERAL aclexplode(l.lomacl) a
        WHERE a.grantee=0 AND a.privilege_type='UPDATE')
);
ROLLBACK;
"@
            $extra += @('-c', ($catalogSql -replace '[\r\n]+', ' '))
        }
        $result = Invoke-MainPg -Tool psql -User $proof.adminUser -Database $database `
            -Extra $extra -Interactive:$Interactive -ReadOnly
        $rows = @($result.Output -split '\r?\n' | Where-Object { $_.Trim() })
        $expectedRows = if ($CatalogReview) { 2 } else { 1 }
        if ($result.ExitCode -ne 0 -or $rows.Count -ne $expectedRows -or $rows[0] -cne 'ISOLATED_NAMES_UNUSED_READ_ONLY') {
            throw 'Read-only preflight did not return a verified result'
        }
        $status = 'ISOLATED_NAMES_UNUSED_READ_ONLY'
        if ($CatalogReview) { $catalog = ConvertFrom-Json -InputObject $rows[1] }
    }
    $installed = $null
    if ($Install) {
        $installFile = [IO.File]::Open($installPath, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
        try {
            if ((Get-FileHash -InputStream $installFile -Algorithm SHA256).Hash -cne $sqlHash) {
                throw 'Reviewed installation SQL changed'
            }
            Write-MainExclusiveJson $attemptPath ([ordered]@{
                status = 'INSTALLATION_ATTEMPT_STARTED'
                runId = $run
                database = $database
                databaseOid = $plan.databaseOid
                sqlSha256 = $sqlHash
                startedAt = [DateTime]::UtcNow.ToString('o')
            })
            # ON_ERROR_STOP halts before the second file if the first, read-only transaction fails.
            # The installation transaction checks identity and collisions again before DDL.
            $result = Invoke-MainPg -Tool psql -User $proof.adminUser -Database $database `
                -Extra @('-qAt', '-f', $preflightPath, '-f', $installPath) -Interactive
            if ($result.ExitCode -ne 0) { throw 'Installation failed or commit is uncertain; preserve attempt' }

            $rows = @($result.Output -split '\r?\n' | Where-Object { $_.Trim() })
            if ($rows.Count -ne 3 -or $rows[0] -cne 'ISOLATED_NAMES_UNUSED_READ_ONLY' -or $rows[1] -cne $run) {
                throw 'Installation response missing; preserve attempt for inspection'
            }
            $installed = ConvertFrom-Json -InputObject $rows[2]
            if ((($installed.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'appOid,appRole,parentRunId,runId,schema,schemaOid' -or
                $installed.runId -cne $run -or $installed.parentRunId -cne $proof.runId -or
                $installed.schema -cne $plan.schema -or $installed.appRole -cne $plan.appRole) {
                throw 'Installation response identity mismatch; preserve attempt for inspection'
            }
            foreach ($oid in @($installed.schemaOid, $installed.appOid)) {
                if ($oid -isnot [string] -or $oid -cnotmatch '^[1-9][0-9]{0,9}$' -or [uint64]$oid -gt [uint32]::MaxValue) {
                    throw 'Installation response OID invalid; preserve attempt for inspection'
                }
            }
            Write-MainExclusiveJson $receiptPath $installed
            $status = 'ISOLATED_INSTALLATION_VERIFIED'
        } finally {
            $installFile.Dispose()
        }
    }
    $summary = [ordered]@{
        status = $status
        runId = $run
        database = $database
        databaseOid = $plan.databaseOid
        schema = $plan.schema
        appRole = $plan.appRole
        preflightSha256 = $preflightHash
    }
    if ($installed) {
        $summary['schemaOid'] = $installed.schemaOid
        $summary['appOid'] = $installed.appOid
    }
    if ($catalog) { $summary['catalog'] = $catalog }
    $summary | ConvertTo-Json -Compress
} finally {
    $preflightFile.Dispose()
}
