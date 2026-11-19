#requires -Version 5.1
[CmdletBinding()]
param([Parameter(Mandatory=$true)][switch]$Execute)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if (!$Execute -or $root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) { throw 'Shared-write execution refused' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$plan = .\scripts\check-main-shared-write-plan.ps1 | ConvertFrom-Json
$installed = Assert-MainLocalPath (Join-Path $root 'artifacts\main-shared-write-installed.json')
$attempt = Assert-MainLocalPath (Join-Path $root 'artifacts\main-shared-write-test-attempt.json')
$report = Assert-MainLocalPath (Join-Path $root 'artifacts\main-shared-write-test-result.json')
$receipt = Get-Content -LiteralPath $installed -Raw | ConvertFrom-Json
if ($receipt.status -cne 'SHARED_WRITE_INSTALLED' -or $plan.status -cne 'SHARED_WRITE_PLAN_VERIFIED_OFFLINE') {
    throw 'Shared-write installation evidence invalid'
}
foreach ($name in @('creationRunId','database','databaseOid','schema','appRole')) {
    if ($receipt.$name -cne $plan.$name) { throw 'Shared-write installation scope mismatch' }
}
foreach ($pin in $plan.sqlSha256.PSObject.Properties) {
    if ($receipt.sqlSha256.($pin.Name) -cne $pin.Value) { throw 'Shared-write installation hash mismatch' }
}
foreach ($oid in @($receipt.schemaOid,$receipt.roleOid)) {
    if ($oid -isnot [string] -or $oid -cnotmatch '^[1-9][0-9]{0,9}$' -or [uint64]$oid -gt [uint32]::MaxValue) {
        throw 'Shared-write installation OID invalid'
    }
}
if ((Test-Path -LiteralPath $attempt) -or (Test-Path -LiteralPath $report)) { throw 'Prior shared-write test evidence exists; stop for inspection' }
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$info.Arguments = 'node_modules/vite-node/vite-node.mjs tests/main-shared-write/runner.ts'
$info.WorkingDirectory = $root
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
foreach ($name in @($info.EnvironmentVariables.Keys)) {
    if ($name -like 'PG*' -or $name -eq 'DATABASE_URL' -or $name -like 'FLSD_*' -or $name -eq 'NODE_OPTIONS') {
        $info.EnvironmentVariables.Remove($name)
    }
}
$info.EnvironmentVariables['FLSD_SYNTHETIC_SHARED_WRITE'] = 'VERIFIED_LOCAL_RUN'
$secret = Read-Host "Local password for $($receipt.appRole)" -AsSecureString
$pointer = [IntPtr]::Zero
$bytes = $null
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
$started = $false
try {
    if ($secret.Length -eq 0 -or $secret.Length -gt 1024) { throw 'Invalid shared-write password input' }
    Write-MainExclusiveJson $attempt @{status='SHARED_WRITE_TEST_ATTEMPT_STARTED';schemaOid=$receipt.schemaOid;roleOid=$receipt.roleOid}
    $pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secret)
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes((@{
        password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer);schemaOid=$receipt.schemaOid;roleOid=$receipt.roleOid
    } | ConvertTo-Json -Compress))
    $started = $process.Start()
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
    $process.StandardInput.BaseStream.Close()
    if (!$process.WaitForExit(120000)) { throw 'Shared-write worker timed out; preserve attempt' }
    $null = $errors.GetAwaiter().GetResult()
    try { $safe = ConvertFrom-Json -InputObject $output.GetAwaiter().GetResult() } catch { throw 'Shared-write worker evidence invalid' }
    if ($process.ExitCode -eq 0 -and $safe.status -ceq 'SHARED_WRITE_CONNECTED_VERIFIED' -and $safe.passed -eq 6 -and $safe.failed -eq 0) {
        $summary = @{status=$safe.status;passed=6;failed=0;rawOutputIncluded=$false}
    } elseif ($safe.status -ceq 'SHARED_WRITE_CONNECTED_FAILED' -and $safe.phase -cin @(
        'INPUT','CROSS_CUSTOMER','ROLLBACK','DUPLICATE_SUBMISSION','COMPETING_RESERVATION','REPLAY_DIGEST','RECONCILIATION')) {
        $summary = @{status=$safe.status;phase=$safe.phase;rawOutputIncluded=$false}
    } else { throw 'Shared-write worker evidence invalid; preserve attempt' }
    Write-MainExclusiveJson $report $summary
    $summary | ConvertTo-Json -Compress
    if ($process.ExitCode -ne 0) { throw 'Shared-write connected rehearsal failed; preserve fixture' }
} finally {
    if ($bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
    if ($pointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer) }
    $secret.Dispose()
    if ($started -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
}
