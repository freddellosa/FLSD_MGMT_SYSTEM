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
    throw 'Combined-write creation proof mismatch'
}

$pins = [ordered]@{
    'combined-write-disposable-v1.sql' = 'D2304EC5554962ABD3956032EE472BEBEAF70A035D778B1D3ECF9E64716E62E4'
    'combined-write-disposable-fixture-v1.sql' = '946BA2B249FA5A6A34FBDC5A16E921E04A11A3C6D33DE3C44E17EFBE9A58DE28'
}
$schema = 'flsd_combined_write_rehearsal'
$role = 'flsd_combined_write_runner_75435c870a31'
$marker = 'FLSD_SYNTHETIC_COMBINED_WRITE_V1:' + $runId
function Invoke-CombinedWriteWorker([string]$Payload) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $info.Arguments = "node_modules/vite-node/vite-node.mjs tests/main-combined-write/runner.ts"
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
    $info.EnvironmentVariables['FLSD_SYNTHETIC_COMBINED_WRITE'] = 'VERIFIED_LOCAL_RUN'
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
        if (!$process.WaitForExit(90000)) { throw 'Combined-write worker timed out' }
        $null = $errors.GetAwaiter().GetResult()
        try { $safe = ConvertFrom-Json -InputObject ($output.GetAwaiter().GetResult()) }
        catch { throw 'Combined-write worker output invalid' }
        [pscustomobject]@{ExitCode=$process.ExitCode;Result=$safe}
    } finally {
        if ($bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
        if ($started -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
        $process.Dispose()
    }
}

$paths = @{}
$streams = @()
try {
    foreach ($name in $pins.Keys) {
        $path = Assert-MainLocalPath (Join-Path $root ('prisma\production-review\' + $name))
        $stream = [IO.File]::Open($path,[IO.FileMode]::Open,[IO.FileAccess]::Read,[IO.FileShare]::Read)
        $streams += $stream
        if ((Get-FileHash -InputStream $stream -Algorithm SHA256).Hash -cne $pins[$name]) {
            throw ('Combined-write plan hash mismatch for ' + $name)
        }
        $paths[$name] = $path
    }

    $report = [ordered]@{
        status = 'COMBINED_WRITE_PLAN_VERIFIED_OFFLINE'
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

    $attempt = Assert-MainLocalPath (Join-Path $root 'artifacts\main-combined-write-install-attempt.json')
    $installed = Assert-MainLocalPath (Join-Path $root 'artifacts\main-combined-write-installed.json')
    $resultPath = Assert-MainLocalPath (Join-Path $root 'artifacts\main-combined-write-result.json')
    if ((Test-Path -LiteralPath $attempt) -or (Test-Path -LiteralPath $installed) -or (Test-Path -LiteralPath $resultPath)) {
        throw 'Prior combined-write installation evidence exists; stop for inspection'
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
 THEN RAISE EXCEPTION 'Combined-write preflight refused'; END IF;
END `$names`$;
ROLLBACK;
SELECT 'COMBINED_WRITE_NAMES_UNUSED_READ_ONLY';
"@
    $finish = @"
DO `$credential`$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM pg_authid WHERE rolname='$role' AND rolpassword LIKE 'SCRAM-SHA-256%')
 THEN RAISE EXCEPTION 'Combined-write password setup refused'; END IF;
END `$credential`$;
"@
    $verify = @"
SELECT json_build_object('schemaOid',n.oid::text,'roleOid',r.oid::text)
FROM pg_namespace n CROSS JOIN pg_roles r
WHERE n.nspname='$schema' AND n.nspowner=16392::oid AND obj_description(n.oid,'pg_namespace')='$marker'
  AND r.rolname='$role' AND shobj_description(r.oid,'pg_authid')='$marker';
"@
    $report.status = 'COMBINED_WRITE_INSTALL_ATTEMPT_STARTED'
    $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
    $sha = [Security.Cryptography.SHA256]::Create()
    $entropy = [byte[]]::new(32)
    try {
        $rng.GetBytes($entropy)
        $token = [BitConverter]::ToString($entropy).Replace('-','').ToLowerInvariant()
        $digest = [BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::ASCII.GetBytes($token))).Replace('-','').ToLowerInvariant()
    } finally {
        [Array]::Clear($entropy,0,$entropy.Length)
        $rng.Dispose()
        $sha.Dispose()
    }
    Write-MainExclusiveJson $attempt $report
    $result = Invoke-MainPg -Tool psql -User $proof.adminUser -Database $database -Interactive -Extra @(
        '-qAt','-v',("fixture_digest=$digest"),'-c',($preflight -replace '[\r\n]+',' '),
        '-f',$paths['combined-write-disposable-v1.sql'],
        '-c',"SET LOCAL ROLE $owner;",
        '-f',$paths['combined-write-disposable-fixture-v1.sql'],
        '-c',"RESET ROLE; SET LOCAL password_encryption TO 'scram-sha-256';",
        '-c',("\password $role"),
        '-c',($finish -replace '[\r\n]+',' '),'-c','COMMIT;',
        '-c',($verify -replace '[\r\n]+',' ')
    )
    $rows = @($result.Output -split '\r?\n' | Where-Object { $_.Trim() })
    if ($result.ExitCode -ne 0 -or $rows.Count -ne 2 -or $rows[0] -cne 'COMBINED_WRITE_NAMES_UNUSED_READ_ONLY') {
        throw 'Combined-write installation failed or outcome is uncertain; preserve attempt'
    }
    $receipt = ConvertFrom-Json -InputObject $rows[1]
    foreach ($oid in @($receipt.schemaOid,$receipt.roleOid)) {
        if ($oid -isnot [string] -or $oid -cnotmatch '^[1-9][0-9]{0,9}$' -or [uint64]$oid -gt [uint32]::MaxValue) {
            throw 'Combined-write receipt OID invalid'
        }
    }
    $report.status = 'COMBINED_WRITE_INSTALLED'
    $report.schemaOid = $receipt.schemaOid
    $report.roleOid = $receipt.roleOid
    Write-MainExclusiveJson $installed $report
    $report | ConvertTo-Json -Depth 4 -Compress
    $admin = Read-Host 'Local PostgreSQL administrator password for the disposable control connection' -AsSecureString
    $writer = $null
    $adminPtr = [IntPtr]::Zero
    $writerPtr = [IntPtr]::Zero
    try {
        $writer = Read-Host "Local password just set for $role" -AsSecureString
        $adminPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($admin)
        $writerPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($writer)
        $checked = Invoke-CombinedWriteWorker (@{
            adminPassword=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminPtr)
            password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($writerPtr)
            token=$token;schemaOid=$receipt.schemaOid;roleOid=$receipt.roleOid
        } | ConvertTo-Json -Compress)
        $safe = $checked.Result
        if ($checked.ExitCode -eq 0 -and $safe.status -ceq 'COMBINED_WRITE_CONNECTED_VERIFIED' -and $safe.passed -eq 5) {
            $report.status = $safe.status
            $report.passed = 5
        } elseif ($checked.ExitCode -ne 0 -and $safe.status -ceq 'COMBINED_WRITE_CONNECTED_FAILED' -and
            $safe.phase -cin @('INPUT','SCOPE','COMMIT_AND_REPLAY','COMPETING_RESERVATION','REVOCATION','RECONCILIATION')) {
            $report.status = $safe.status
            $report.phase = $safe.phase
        } else { throw 'Combined-write verification evidence refused' }
        $report.rawOutputIncluded = $false
        Write-MainExclusiveJson $resultPath $report
        $report | ConvertTo-Json -Depth 4 -Compress
        if ($checked.ExitCode -ne 0) { throw 'Combined-write rehearsal failed; preserve evidence' }
    } finally {
        if ($adminPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPtr) }
        if ($writerPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($writerPtr) }
        $admin.Dispose()
        if ($writer) { $writer.Dispose() }
    }
} finally {
    $token = $null
    foreach ($stream in $streams) { $stream.Dispose() }
}
