#requires -Version 5.1
[CmdletBinding()]
param([switch]$Execute)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) { throw 'Wrong workspace' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$proof = Read-MainCreationProof $root
$database = 'flsd_main_adapter_test'
$owner = 'flsd_test_owner_b813e7439f4c'
$runId = 'b813e743-9f4c-4121-b8ab-b01ca51b9335'
$schema = 'flsd_write_auth_rehearsal'
$role = 'flsd_write_auth_runner_75435c870a31'
$marker = 'FLSD_SYNTHETIC_WRITE_AUTH_V1:' + $runId
$hash = 'BD18298DB8F43F3164C2BAC7685E0319E636584530AE9512D03CBDA10431812D'
if ($proof.runId -cne $runId -or $proof.adminUser -cne 'postgres' -or $proof.expectedOwner -cne $owner -or
    ($proof.verifiedDatabases | Where-Object name -CEQ $database).oid -cne '16394' -or
    ($proof.verifiedRoles | Where-Object name -CEQ $owner).oid -cne '16392') { throw 'Creation proof mismatch' }
$ddl = Assert-MainLocalPath (Join-Path $root 'prisma\production-review\write-authorization-fixture-v1.sql')
$attempt = Assert-MainLocalPath (Join-Path $root 'artifacts\main-write-authorization-attempt.json')
$installed = Assert-MainLocalPath (Join-Path $root 'artifacts\main-write-authorization-installed.json')
$report = Assert-MainLocalPath (Join-Path $root 'artifacts\main-write-authorization-result.json')

function Invoke-AuthorizationWorker([ValidateSet('fixture','verify')][string]$Mode,[string]$Payload) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $info.Arguments = "node_modules/vite-node/vite-node.mjs tests/main-write-authorization/runner.ts $Mode"
    $info.WorkingDirectory = $root
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardInput = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    foreach ($key in @($info.EnvironmentVariables.Keys)) {
        if ($key -like 'PG*' -or $key -eq 'DATABASE_URL' -or $key -like 'FLSD_*' -or $key -eq 'NODE_OPTIONS') {
            $info.EnvironmentVariables.Remove($key)
        }
    }
    if ($Mode -eq 'verify') { $info.EnvironmentVariables['FLSD_SYNTHETIC_WRITE_AUTH'] = 'VERIFIED_LOCAL_RUN' }
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
        if (!$process.WaitForExit(90000)) { throw 'Authorization worker timed out' }
        $null = $errors.GetAwaiter().GetResult()
        if ($process.ExitCode -ne 0) { throw 'Authorization worker refused or failed' }
        try { ConvertFrom-Json -InputObject ($output.GetAwaiter().GetResult()) }
        catch { throw 'Authorization worker output invalid' }
    } finally {
        if ($bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
        if ($started -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}

$stream = [IO.File]::Open($ddl,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
try {
    if ((Get-FileHash -InputStream $stream -Algorithm SHA256).Hash -cne $hash) { throw 'Fixture DDL hash mismatch' }
    if (!$Execute) { Write-Output 'WRITE_AUTHORIZATION_PLAN_VERIFIED_OFFLINE'; return }
    foreach ($path in @($attempt,$installed,$report)) {
        if (Test-Path -LiteralPath $path) { throw 'Prior authorization rehearsal evidence exists; stop for inspection' }
    }
    $fixture = Invoke-AuthorizationWorker fixture ''
    if ($fixture.sql -isnot [string] -or $fixture.sql.Length -gt 8000 -or !$fixture.sql.Length) { throw 'Invalid fixture SQL' }
    foreach ($name in @('revocation','downgrade','commandFirst')) {
        $token = $fixture.fixtures.$name.token
        if ($token -cnotmatch '^[a-f0-9]{64}$' -or $fixture.sql.Contains($token)) { throw 'Invalid fixture token boundary' }
    }
    $guard = Get-MainIdentityGuardSql $proof $database $false
    $setup = @"
SET LOCAL search_path TO pg_catalog;
$guard
SELECT pg_advisory_xact_lock(176661,1);
DO `$guard`$ BEGIN
 IF current_setting('server_version_num')<>'180007'
 OR EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='$schema')
 OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='$role') THEN RAISE EXCEPTION 'Authorization install refused'; END IF;
END `$guard`$;
CREATE ROLE $role LOGIN NOSUPERUSER NOCREATEROLE NOCREATEDB NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
COMMENT ON ROLE $role IS '$marker';
GRANT CONNECT ON DATABASE $database TO $role;
ALTER ROLE $role IN DATABASE $database SET search_path TO pg_catalog;
SET LOCAL ROLE $owner;
CREATE SCHEMA $schema;
COMMENT ON SCHEMA $schema IS '$marker';
"@
    $grant = @"
REVOKE ALL ON SCHEMA $schema FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA $schema FROM PUBLIC;
GRANT USAGE ON SCHEMA $schema TO $role;
GRANT SELECT ON ALL TABLES IN SCHEMA $schema TO $role;
GRANT UPDATE(lock_guard) ON $schema.staff_authorization TO $role;
GRANT UPDATE(revision) ON $schema.customer TO $role;
GRANT INSERT ON $schema.receipt TO $role;
RESET ROLE;
SET LOCAL password_encryption TO 'scram-sha-256';
"@
    $access = @"
DO `$access`$ DECLARE r oid := '$role'::regrole; s oid := '$schema'::regnamespace; BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_authid WHERE oid=r AND rolpassword LIKE 'SCRAM-SHA-256%')
 OR has_database_privilege(r,current_database(),'CREATE,TEMPORARY')
 OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r)
 OR EXISTS (SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(r,n.oid,'CREATE'))
 OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname LIKE 'flsd_%' AND n.oid<>s
   AND has_schema_privilege(r,n.oid,'USAGE'))
 OR EXISTS (SELECT 1 FROM pg_proc p WHERE p.prosecdef AND has_schema_privilege(r,p.pronamespace,'USAGE') AND has_function_privilege(r,p.oid,'EXECUTE'))
 OR EXISTS (SELECT 1 FROM pg_largeobject_metadata l WHERE has_largeobject_privilege(r,l.oid,'UPDATE'))
 OR EXISTS (
   SELECT 1 FROM pg_class c WHERE c.relnamespace<>s AND CASE
    WHEN c.oid='pg_catalog.pg_settings'::regclass THEN
      has_table_privilege(r,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR has_any_column_privilege(r,c.oid,'INSERT,REFERENCES')
      OR EXISTS (SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a
         WHERE col.attrelid=c.oid AND a.grantee IN (0,r) AND a.privilege_type='UPDATE')
    WHEN c.relkind IN ('r','p','v','m','f') THEN
      has_table_privilege(r,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
      OR has_any_column_privilege(r,c.oid,'INSERT,UPDATE,REFERENCES')
    WHEN c.relkind='S' THEN has_sequence_privilege(r,c.oid,'USAGE,UPDATE')
    ELSE false END)
 OR EXISTS (
   SELECT 1 FROM pg_class c LEFT JOIN LATERAL aclexplode(c.relacl) a ON true
   WHERE c.relnamespace=s AND (c.relowner<>16392::oid OR (a.grantee<>16392::oid
     AND (a.grantee<>r OR a.is_grantable OR NOT (a.privilege_type='SELECT' OR (a.privilege_type='INSERT' AND c.relname='receipt'))))))
 OR EXISTS (
   SELECT 1 FROM pg_class c JOIN pg_attribute col ON col.attrelid=c.oid CROSS JOIN LATERAL aclexplode(col.attacl) a
   WHERE c.relnamespace=s AND a.grantee<>16392::oid AND (a.grantee<>r OR a.is_grantable OR a.privilege_type<>'UPDATE'
      OR (c.relname,col.attname) NOT IN (('customer','revision'),('staff_authorization','lock_guard'))))
 OR EXISTS (SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
   WHERE n.oid=s AND (n.nspowner<>16392::oid OR (a.grantee<>16392::oid AND (a.grantee<>r OR a.is_grantable OR a.privilege_type<>'USAGE'))))
 THEN RAISE EXCEPTION 'Authorization rehearsal ACL refused'; END IF;
END `$access`$;
"@
    $identity = "SELECT json_build_object('schemaOid',n.oid::text,'roleOid',r.oid::text) FROM pg_namespace n CROSS JOIN pg_roles r WHERE n.nspname='$schema' AND n.nspowner=16392::oid AND obj_description(n.oid,'pg_namespace')='$marker' AND r.rolname='$role' AND shobj_description(r.oid,'pg_authid')='$marker';"
    $evidence = @{status='WRITE_AUTHORIZATION_ATTEMPT_STARTED';database=$database;databaseOid='16394';schema=$schema;role=$role;ddlSha256=$hash}
    Write-MainExclusiveJson $attempt $evidence
    $result = Invoke-MainPg -Tool psql -User postgres -Database $database -Interactive -Extra @(
        '-qAt','-c','BEGIN;','-c',($setup -replace '[\r\n]+',' '),'-f',$ddl,
        '-c',$fixture.sql,'-c',($grant -replace '[\r\n]+',' '),'-c',("\password $role"),
        '-c',($access -replace '[\r\n]+',' '),'-c','COMMIT;','-c',$identity
    )
    $rows = @($result.Output -split '\r?\n' | Where-Object { $_.Trim() })
    if ($result.ExitCode -ne 0 -or $rows.Count -ne 1) { throw 'Installation failed or outcome is uncertain; preserve attempt' }
    $receipt = ConvertFrom-Json -InputObject $rows[0]
    foreach ($oid in @($receipt.schemaOid,$receipt.roleOid)) {
        if ($oid -isnot [string] -or $oid -cnotmatch '^[1-9][0-9]{0,9}$' -or [uint64]$oid -gt [uint32]::MaxValue) { throw 'Installation OID refused' }
    }
    $evidence.status = 'WRITE_AUTHORIZATION_INSTALLED'
    $evidence.schemaOid = $receipt.schemaOid
    $evidence.roleOid = $receipt.roleOid
    Write-MainExclusiveJson $installed $evidence
    $admin = Read-Host 'Local PostgreSQL administrator password for the disposable control connection' -AsSecureString
    $writer = $null
    $adminPtr = [IntPtr]::Zero
    $writerPtr = [IntPtr]::Zero
    try {
        $writer = Read-Host "Local password just set for $role" -AsSecureString
        $adminPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($admin)
        $writerPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($writer)
        $checked = Invoke-AuthorizationWorker verify (@{
            adminPassword=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminPtr)
            rolePassword=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($writerPtr)
            fixtures=$fixture.fixtures;schemaOid=$receipt.schemaOid;roleOid=$receipt.roleOid
        } | ConvertTo-Json -Depth 6 -Compress)
        if ($checked.status -cne 'WRITE_AUTHORIZATION_CONNECTED_VERIFIED') { throw 'Invalid verification result' }
        $evidence.status = $checked.status
        $evidence.rawOutputIncluded = $false
        Write-MainExclusiveJson $report $evidence
        $evidence | ConvertTo-Json -Compress
    } finally {
        if ($adminPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPtr) }
        if ($writerPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($writerPtr) }
        $admin.Dispose()
        if ($writer) { $writer.Dispose() }
    }
} finally {
    $fixture = $null
    $stream.Dispose()
}
