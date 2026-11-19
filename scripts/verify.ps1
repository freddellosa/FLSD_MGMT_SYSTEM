$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $PSScriptRoot)
$commands = @('lint','typecheck','test','build')
foreach ($task in $commands) {
 Write-Host "Running $task ..."
 & npm.cmd run $task
 if ($LASTEXITCODE -ne 0) { throw "FAILED: $task" }
}
Write-Host 'Foundation verification complete.'
