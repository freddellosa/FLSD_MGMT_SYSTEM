#requires -Version 5.1
$ErrorActionPreference = 'Stop'
$root = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($root -cne 'D:\FLSD-Batch7-Validation') { throw 'Wrong validation workspace' }
$info = [Diagnostics.ProcessStartInfo]::new()
$info.FileName = (Get-Command node -CommandType Application -ErrorAction Stop).Source
$info.Arguments = 'node_modules/vite-node/vite-node.mjs tests/main-candidate-allocation/runner.ts'
$info.WorkingDirectory = $root
$info.UseShellExecute = $false
$info.CreateNoWindow = $true
$info.RedirectStandardInput = $true
$info.RedirectStandardOutput = $true
$info.RedirectStandardError = $true
foreach ($key in @($info.EnvironmentVariables.Keys)) {
    if ($key -match '^(PG|FLSD_|PRISMA_)' -or $key -in @('DATABASE_URL','NODE_OPTIONS','DEBUG')) {
        $info.EnvironmentVariables.Remove($key)
    }
}
$info.EnvironmentVariables['FLSD_CANDIDATE_ACCEPTANCE'] = 'PINNED_LOCAL_ONLY'
$secure = Read-Host 'Password for postgres on the pinned disposable database' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure)
$process = [Diagnostics.Process]::new()
$process.StartInfo = $info
$started = $false
$bytes = $null
try {
    $setupToken = Get-Variable flsdAcceptanceToken -Scope Global -ValueOnly -ErrorAction SilentlyContinue
    $payload = @{password=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($pointer); setupToken=$setupToken}
    $bytes = [Text.UTF8Encoding]::new($false).GetBytes(($payload | ConvertTo-Json -Compress))
    $payload = $null
    $started = $process.Start()
    $output = $process.StandardOutput.ReadToEndAsync()
    $errors = $process.StandardError.ReadToEndAsync()
    $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length)
    $process.StandardInput.BaseStream.Close()
    if (!$process.WaitForExit(100000)) { throw 'Worker timeout. Reconcile the role and financial state before any retry.' }
    $null = $errors.GetAwaiter().GetResult()
    $result = ConvertFrom-Json -InputObject ($output.GetAwaiter().GetResult())
    $result | ConvertTo-Json -Compress
    if ($process.ExitCode -ne 0) { throw 'Candidate acceptance stopped. Preserve the result and reconcile before retrying.' }
} finally {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($pointer)
    $secure.Dispose()
    if ($bytes) { [Array]::Clear($bytes,0,$bytes.Length) }
    if ($started -and !$process.HasExited) { $process.Kill(); $process.WaitForExit() }
    $process.Dispose()
}
