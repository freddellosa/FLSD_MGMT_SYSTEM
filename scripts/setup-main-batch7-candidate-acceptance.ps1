# Run in a local PowerShell terminal with the operator present for the psql password prompt.
$flsdSetupSql = Join-Path $PSScriptRoot '..\prisma\migration-review\batch7-candidate-acceptance-setup.sql'
$flsdPsql = 'C:\Program Files\PostgreSQL\18\bin\psql.exe'
if (!(Test-Path -LiteralPath $flsdPsql -PathType Leaf)) { throw 'PostgreSQL 18 psql.exe missing' }
$flsdRng = [Security.Cryptography.RandomNumberGenerator]::Create()
$flsdSha = [Security.Cryptography.SHA256]::Create()
try {
    $flsdBytes = New-Object byte[] 32
    $flsdRng.GetBytes($flsdBytes)
    $flsdToken = [BitConverter]::ToString($flsdBytes).Replace('-', '').ToLowerInvariant()
    $flsdDigest = [BitConverter]::ToString($flsdSha.ComputeHash([Text.Encoding]::ASCII.GetBytes($flsdToken))).Replace('-', '').ToLowerInvariant()
} finally {
    $flsdRng.Dispose()
    $flsdSha.Dispose()
}
$flsdSessionId = [guid]::NewGuid().ToString()
& $flsdPsql -X -h 127.0.0.1 -p 5432 -U postgres -d flsd_main_adapter_test -W -v ON_ERROR_STOP=1 -v "session_id=$flsdSessionId" -v "session_digest=$flsdDigest" -f $flsdSetupSql
if ($LASTEXITCODE -ne 0) { throw 'Candidate setup failed. Preserve the output and stop.' }
$global:flsdAcceptanceToken = $flsdToken
Write-Output 'Setup committed. Keep this PowerShell window open to retain the synthetic token in memory.'
