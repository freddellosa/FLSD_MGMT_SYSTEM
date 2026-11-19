#requires -Version 5.1
# OFFLINE ONLY: no creation, migration, authentication or PostgreSQL process.
param()
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if($taskRoot -cne 'D:\FLSD-Batch7-Validation' -or (Get-Location).Path -cne $taskRoot){throw 'Run from the authorized validation workspace'}
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$taskProof=Read-MainCreationProof $taskRoot
$taskGuard=Get-MainIdentityGuardSql $taskProof 'flsd_main_adapter_test' $false
$taskInfo=[Diagnostics.ProcessStartInfo]::new();$taskInfo.FileName=(Get-Command node -ErrorAction Stop).Source
$taskInfo.Arguments='scripts/prepare-main-isolated-schema.cjs';$taskInfo.WorkingDirectory=$taskRoot
$taskInfo.UseShellExecute=$false;$taskInfo.CreateNoWindow=$true;$taskInfo.RedirectStandardInput=$true;$taskInfo.RedirectStandardOutput=$true;$taskInfo.RedirectStandardError=$true
foreach($taskName in @($taskInfo.EnvironmentVariables.Keys)){if($taskName -like 'PG*' -or $taskName -eq 'DATABASE_URL' -or $taskName -like 'FLSD_*'){$taskInfo.EnvironmentVariables.Remove($taskName)}}
$taskProcess=[Diagnostics.Process]::new();$taskProcess.StartInfo=$taskInfo;$taskStarted=$false
try{
 $null=$taskProcess.Start();$taskStarted=$true;$taskOut=$taskProcess.StandardOutput.ReadToEndAsync();$taskErr=$taskProcess.StandardError.ReadToEndAsync()
 $taskBytes=[Text.UTF8Encoding]::new($false).GetBytes((@{proof=$taskProof;guard=$taskGuard}|ConvertTo-Json -Depth 14 -Compress))
 $taskProcess.StandardInput.BaseStream.Write($taskBytes,0,$taskBytes.Length);$taskProcess.StandardInput.BaseStream.Close();$taskProcess.WaitForExit()
 if($taskProcess.ExitCode -ne 0){throw 'Offline plan preparation failed; preserve artifacts, no automatic retry'}
 Write-Output $taskOut.GetAwaiter().GetResult()
}finally{if($taskStarted -and -not $taskProcess.HasExited){try{$taskProcess.Kill();$taskProcess.WaitForExit()}catch{}};$taskProcess.Dispose()}
