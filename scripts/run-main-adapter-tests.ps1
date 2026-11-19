#requires -Version 5.1
# MANUAL ONLY. DiagnosticOnly never collects or executes the connected suite.
param([switch]$DiagnosticOnly,[switch]$ResumeFixture,[switch]$CheckFixtureResume,[switch]$IsolatedSchema,[string]$IsolatedRunId)
$ErrorActionPreference='Stop'
if(($ResumeFixture -and $DiagnosticOnly) -or ($CheckFixtureResume -and -not $DiagnosticOnly)){throw 'Use ResumeFixture for tests OR DiagnosticOnly with CheckFixtureResume for read-only review'}
if($IsolatedSchema -and ($DiagnosticOnly -or $ResumeFixture -or $CheckFixtureResume)){throw 'IsolatedSchema cannot run legacy diagnostic or resume modes'}
if($PSBoundParameters.ContainsKey('IsolatedRunId') -and (-not $IsolatedSchema -or $IsolatedRunId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')){throw 'An explicit isolated run requires IsolatedSchema mode and a run UUID'}
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if($taskRoot -cne 'D:\FLSD-Batch7-Validation'){throw 'Wrong workspace'}
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$taskReceipt=Read-MainCreationProof $taskRoot
$taskLogin=$taskReceipt.user
if($IsolatedSchema){
 $taskInstalledName=if($IsolatedRunId){"main-adapter-isolated-installed-$IsolatedRunId.json"}else{'main-adapter-isolated-installed.json'}
 $taskInstalled=Get-Content -LiteralPath (Assert-MainLocalPath (Join-Path $taskRoot "artifacts\$taskInstalledName")) -Raw | ConvertFrom-Json
 if($taskInstalled.runId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or $taskInstalled.parentRunId -cne $taskReceipt.runId -or $taskInstalled.appRole -cne ('flsd_iso_app_'+$taskInstalled.runId.Replace('-','')) -or $taskInstalled.schema -cne ('flsd_iso_'+$taskInstalled.runId.Replace('-',''))){throw 'Isolated installation identity missing or invalid'}
 $taskLogin=$taskInstalled.appRole
 if($IsolatedRunId -and $taskInstalled.runId -cne $IsolatedRunId){throw 'Isolated installation receipt run mismatch'}
 if(Test-Path -LiteralPath (Assert-MainLocalPath (Join-Path $taskRoot "artifacts\main-adapter-isolated-fixture-$($taskInstalled.runId).json"))){throw 'Isolated fixture attempt exists; stop for inspection'}
}
function Invoke-MainLocalNodePipe([string]$Arguments,[string]$Payload,[bool]$UseAdapterFlags){
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=(Get-Command node -ErrorAction Stop).Source
 $info.Arguments=$Arguments;$info.WorkingDirectory=$taskRoot;$info.UseShellExecute=$false;$info.CreateNoWindow=$true
 $info.RedirectStandardInput=$true;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$true
 foreach($name in @($info.EnvironmentVariables.Keys)){if($name -like 'PG*' -or $name -eq 'DATABASE_URL' -or $name -like 'FLSD_*'){$info.EnvironmentVariables.Remove($name)}}
 $info.EnvironmentVariables['NO_COLOR']='1'
 if($UseAdapterFlags){
  $info.EnvironmentVariables['FLSD_RUN_MAIN_ADAPTER']=$(if($DiagnosticOnly){'READ_ONLY_DIAGNOSTIC'}else{'SYNTHETIC_ONLY'})
  $info.EnvironmentVariables['FLSD_MAIN_ADAPTER_CREDENTIAL_STDIN']='1'
  if($ResumeFixture){$info.EnvironmentVariables['FLSD_MAIN_ADAPTER_FIXTURE_MODE']='RESUME_PRISTINE'}
  if($CheckFixtureResume){$info.EnvironmentVariables['FLSD_MAIN_ADAPTER_CHECK_RESUME']='1'}
  if($IsolatedSchema){$info.EnvironmentVariables['FLSD_MAIN_ADAPTER_SUITE']='ISOLATED_SCHEMA'}
  if($IsolatedRunId){$info.EnvironmentVariables['FLSD_MAIN_ISOLATED_RUN_ID']=$IsolatedRunId}
 }
 $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$started=$false;$bytes=$null
 try{
  $null=$process.Start();$started=$true
  $stdout=$process.StandardOutput.ReadToEndAsync();$stderr=$process.StandardError.ReadToEndAsync()
  # .NET Framework Process.StandardInput uses the console code page (often IBM437).
  # Write BOM-free UTF-8 bytes directly, not the default StreamWriter encoding.
  $bytes=[Text.UTF8Encoding]::new($false).GetBytes($Payload)
  $process.StandardInput.BaseStream.Write($bytes,0,$bytes.Length);$process.StandardInput.BaseStream.Flush();$process.StandardInput.BaseStream.Close()
  $process.WaitForExit()
  return [pscustomobject]@{exitCode=$process.ExitCode;stdout=$stdout.GetAwaiter().GetResult();stderr=$stderr.GetAwaiter().GetResult()}
 }finally{
  if($bytes){[Array]::Clear($bytes,0,$bytes.Length)}
  if($started -and -not $process.HasExited){try{$process.Kill();$process.WaitForExit()}catch{}}
  $process.Dispose()
 }
}
$taskSecret=$null;$taskPtr=[IntPtr]::Zero;$taskPlain=$null;$taskRaw=$null;$taskReportInput=$null
try{
 $taskSecret=Read-Host ('Local password for disposable application role '+$taskLogin+' (never postgres)') -AsSecureString
 $taskPtr=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($taskSecret)
 $taskPlain=[Runtime.InteropServices.Marshal]::PtrToStringBSTR($taskPtr)
 if([string]::IsNullOrEmpty($taskPlain) -or $taskPlain.Length -gt 1024){throw 'Invalid local test credential length'}
 $taskArguments=if($DiagnosticOnly){'scripts/diagnose-main-adapter.cjs'}else{'node_modules/vitest/vitest.mjs run --config vitest.main-adapter.config.ts --reporter=dot'}
 $taskRaw=Invoke-MainLocalNodePipe $taskArguments (@{testPassword=$taskPlain}|ConvertTo-Json -Compress) $true
 $taskPlain=$null
 # Raw stdout/stderr stays in memory. Only a fixed allowlist report can be displayed/saved.
 $taskMode=if($DiagnosticOnly){'DIAGNOSTIC_READ_ONLY'}else{'CONNECTED_TESTS'}
 $taskReportInput=@{stdout=$taskRaw.stdout;stderr=$taskRaw.stderr;exitCode=$taskRaw.exitCode;mode=$taskMode}|ConvertTo-Json -Compress
 $taskFormatted=Invoke-MainLocalNodePipe 'scripts/format-main-adapter-result.cjs' $taskReportInput $false
 if($taskFormatted.exitCode -ne 0){throw 'Sanitized reporting unavailable; raw output remains withheld'}
 $taskSafe=$taskFormatted.stdout|ConvertFrom-Json
 if($taskSafe.kind -cne 'SANITIZED_MAIN_ADAPTER_RESULT' -or $taskSafe.rawOutputIncluded -ne $false){throw 'Unsafe diagnostic report refused'}
 $taskReportPath=Join-Path $taskRoot ('artifacts\main-adapter-diagnostic-'+[guid]::NewGuid().ToString()+'.json')
 Write-MainExclusiveJson $taskReportPath $taskSafe
 Write-Output ($taskSafe|ConvertTo-Json -Depth 6 -Compress)
 Write-Output ('Sanitized report: '+$taskReportPath)
 if($taskRaw.exitCode -ne 0){throw ('Adapter '+$taskMode+' failed; category='+$taskSafe.category+'. No automatic reset/retry.')}
 if($DiagnosticOnly){Write-Output 'Read-only diagnostics completed. No connected tests, fixtures or database writes were executed.'}
 elseif($IsolatedSchema -and ($taskSafe.tests.passed -ne 12 -or $taskSafe.tests.skipped -ne 0 -or $taskSafe.tests.failed -ne 0)){throw 'Expected all 12 isolated connected tests to pass; no automatic reset/retry.'}
 elseif($taskSafe.tests.passed -lt 1 -or $taskSafe.tests.failed -gt 0){throw 'No successful connected suite confirmed; no automatic reset/retry.'}
 else{Write-Output 'Connected synthetic suite passed as the dedicated limited role.'}
}finally{
 $taskPlain=$null;$taskRaw=$null;$taskReportInput=$null
 if($taskPtr -ne [IntPtr]::Zero){[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($taskPtr)}
 if($taskSecret){$taskSecret.Dispose()}
}
