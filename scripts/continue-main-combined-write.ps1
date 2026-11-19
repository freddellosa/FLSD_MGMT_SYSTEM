#requires -Version 5.1
[CmdletBinding()]
param([switch]$Execute)
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $root) { throw 'Wrong workspace' }
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$verified = & (Join-Path $PSScriptRoot 'inspect-main-combined-write.ps1')
if ($verified -cne 'COMBINED_WRITE_INSPECTION_RECEIPTS_VERIFIED_OFFLINE') { throw 'Original receipts refused' }
if (!$Execute) { Write-Output 'COMBINED_WRITE_CONTINUATION_VERIFIED_OFFLINE'; return }

function Invoke-CombinedWriteWorker([string]$Payload) {
    $info = [Diagnostics.ProcessStartInfo]::new()
    $info.FileName = (Get-Command node -CommandType Application -ErrorAction Stop).Source
    $info.Arguments = "node_modules/vite-node/vite-node.mjs tests/main-combined-write/runner.ts continue-revocation"
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

$attempt = Assert-MainLocalPath (Join-Path $root 'artifacts\main-combined-write-continuation-attempt.json')
$resultPath = Assert-MainLocalPath (Join-Path $root 'artifacts\main-combined-write-continuation-result.json')
if ((Test-Path -LiteralPath $attempt) -or (Test-Path -LiteralPath $resultPath)) {
    throw 'Prior continuation evidence exists; stop for inspection'
}
$evidence = @{status='COMBINED_WRITE_CONTINUATION_STARTED';databaseOid='16394';schemaOid='17643';roleOid='17642';rawOutputIncluded=$false}
$admin = Read-Host 'Local PostgreSQL administrator password for the disposable control connection' -AsSecureString
$writer = $null
$adminPtr = [IntPtr]::Zero
$writerPtr = [IntPtr]::Zero
try {
    $writer = Read-Host 'Existing password for flsd_combined_write_runner_75435c870a31' -AsSecureString
    if ($admin.Length -eq 0 -or $writer.Length -eq 0 -or $admin.Length -gt 1024 -or $writer.Length -gt 1024) { throw 'Invalid password input' }
    Write-MainExclusiveJson $attempt $evidence
    $adminPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($admin)
    $writerPtr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($writer)
    $checked = Invoke-CombinedWriteWorker (@{
        adminPassword=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($adminPtr)
        password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($writerPtr)
        schemaOid='17643';roleOid='17642'
    } | ConvertTo-Json -Compress)
    $safe = $checked.Result
    if ($checked.ExitCode -eq 0 -and $safe.status -ceq 'COMBINED_WRITE_REVOCATION_CONTINUATION_VERIFIED') {
        $evidence.status = $safe.status
    } elseif ($checked.ExitCode -ne 0 -and $safe.status -ceq 'COMBINED_WRITE_CONNECTED_FAILED' -and
        $safe.phase -cin @('INPUT','CONTINUATION_SESSION','COMMIT_AND_REPLAY','REVOCATION','RECONCILIATION')) {
        $evidence.status = 'COMBINED_WRITE_CONTINUATION_FAILED'
        $evidence.phase = $safe.phase
    } else { throw 'Continuation result refused; preserve evidence' }
    Write-MainExclusiveJson $resultPath $evidence
    $evidence | ConvertTo-Json -Compress
    if ($checked.ExitCode -ne 0) { throw 'Continuation failed; preserve evidence' }
} finally {
    if ($adminPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($adminPtr) }
    if ($writerPtr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($writerPtr) }
    $admin.Dispose()
    if ($writer) { $writer.Dispose() }
}