# Offline executable regression tests. NO psql, database, credential prompts or HR access.
$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$taskCases=0
function Check([bool]$Condition,[string]$Message){if(-not $Condition){throw ('Offline safety failure: '+$Message)};$script:taskCases++}
function Must-Fail([scriptblock]$Action,[string]$Message){$failed=$false;try{$null=& $Action}catch{$failed=$true};Check $failed $Message}
$taskTestRoot=Join-Path 'D:\FLSD-Batch7-Validation\artifacts' ('main-hardening-offline-'+[guid]::NewGuid().ToString())
$null=New-Item -ItemType Directory -Path $taskTestRoot
function New-Case{
 $root=Join-Path $taskTestRoot ([guid]::NewGuid().ToString());$artifacts=Join-Path $root 'artifacts';$null=New-Item -ItemType Directory -Path $artifacts
 $state=@{reads=0;writes=0;existing=@();host='127.0.0.1';port=5432;authFailure=$false;failure='';missingProof=$false;privilege=$true}
 $runner={param($tool,$user,$database,$extra,$interactive,$readOnly)
  if($readOnly){
   $state.reads++
   if($state.authFailure){return [pscustomobject]@{ExitCode=2;Output=''}}
   $body=@{user='postgres';database='postgres';host=$state.host;port=$state.port;version=180007;readOnly='on';recovery=$false;createdb=$state.privilege;createrole=$state.privilege;existing=$state.existing}
   return [pscustomobject]@{ExitCode=0;Output=($body|ConvertTo-Json -Compress)}
  }
  $state.writes++
  if($state.failure -eq 'interrupt'){throw 'Synthetic connection interruption'}
  if($state.failure){return [pscustomobject]@{ExitCode=3;Output=('FLSD_STAGE:'+$state.failure)}}
  if($state.missingProof){return [pscustomobject]@{ExitCode=0;Output='FLSD_STAGE:PRIMARY_CREATED'}}
  $run=(@($extra | Where-Object {$_ -like 'run_id=*'})[0]).Substring(7)
  $owner=(@($extra | Where-Object {$_ -like 'owner_role=*'})[0]).Substring(11)
  $app=(@($extra | Where-Object {$_ -like 'app_role=*'})[0]).Substring(9)
  $proof=@{runId=$run;serverVersion='18.7';verifiedDatabases=@(@{name='flsd_main_adapter_test';oid='40001'},@{name='flsd_main_restore_test';oid='40002'});verifiedRoles=@(@{name=$owner;oid='40003'},@{name=$app;oid='40004'})}
  return [pscustomobject]@{ExitCode=0;Output=('FLSD_STAGE:POSTCONDITIONS_VERIFIED'+"`nFLSD_RESULT:"+($proof|ConvertTo-Json -Depth 5 -Compress))}
 }.GetNewClosure()
 return @{root=$root;artifacts=$artifacts;state=$state;runner=$runner}
}
function Run-Case($Case,[bool]$Create=$true){Invoke-MainCreationSequence -DatabaseUser postgres -Create $Create -Interactive $false -ArtifactDirectory $Case.artifacts -Runner $Case.runner}
# Authentication and identity failures cannot reach the simulated creation callback.
$c=New-Case;$c.state.authFailure=$true;Must-Fail {Run-Case $c} 'auth fails closed';Check ($c.state.writes -eq 0) 'no writes after auth failure'
foreach($database in @('flsd_main_adapter_test','flsd_main_restore_test')){$c=New-Case;$c.state.existing=@($database);Must-Fail {Run-Case $c} 'either existing target stops';Check ($c.state.writes -eq 0) 'no writes for existing target'}
$c=New-Case;$c.state.port=55432;Must-Fail {Run-Case $c} 'HR port refused';Check ($c.state.writes -eq 0) 'no HR creation'
$c=New-Case;$c.state.host='192.0.2.1';Must-Fail {Run-Case $c} 'foreign host refused'
$c=New-Case;$c.state.privilege=$false;Must-Fail {Run-Case $c} 'no privilege no elevation';Check ($c.state.writes -eq 0) 'no creation without privilege'
$c=New-Case;$r=Run-Case $c $false;Check ($r.status -eq 'ABSENCE_VERIFIED_READ_ONLY' -and $c.state.writes -eq 0) 'inspection is read only'
# Partial roles, first DB, second DB, transport uncertainty and missing post-proof all persist a block.
foreach($stage in @('OWNER_CREATED','APP_CREATED','PRIMARY_CREATED','RESTORE_CREATED','interrupt')){
 $c=New-Case;$c.state.failure=$stage;Must-Fail {Run-Case $c} ('partial failure '+$stage)
 Check (-not(Test-Path -LiteralPath (Join-Path $c.artifacts 'main-adapter-creation.json'))) 'no successful receipt after failure'
 $lines=@(Get-Content -LiteralPath (Join-Path $c.artifacts 'main-adapter-attempt.jsonl'));Check (($lines[-1]|ConvertFrom-Json).status -eq 'FAILED_OR_UNCERTAIN_NO_CLEANUP') 'uncertainty documented'
 $before=$c.state.reads+$c.state.writes;Must-Fail {Run-Case $c} 'rerun blocked';Check (($c.state.reads+$c.state.writes) -eq $before) 'rerun cannot reach server'
}
$c=New-Case;$c.state.missingProof=$true;Must-Fail {Run-Case $c} 'missing postcondition proof blocks continuation'
$c=New-Case;$r=Run-Case $c;Check ($r.status -eq 'CREATED_AND_VERIFIED') 'successful simulated flow';$proof=Read-MainCreationProof $c.root
Check ($proof.proofVersion -eq 2 -and $proof.verifiedDatabases.Count -eq 2) 'OID provenance is mandatory'
$guard=Get-MainIdentityGuardSql $proof 'flsd_main_restore_test' $true
Check ($guard.Contains('40002::oid') -and $guard.Contains("n.nspname='public'")) 'same-session restore identity and public objects guard'
Check ($guard.Contains("r.rolname<>(CASE WHEN r.oid=40003::oid THEN")) 'role CASE is parenthesized before its THEN token'
Check ($guard.Contains("ELSE 'flsd_test_app_" ) -and $guard.Contains("END) OR r.rolcanlogin")) 'role CASE closes before the remaining IF predicate'
Must-Fail {Get-MainIdentityGuardSql $proof 'unrelated' $true} 'foreign database guard generation refused'
Must-Fail {Assert-MainLocalPath 'D:\FLSD-HR-Development\test.sql'} 'HR filesystem outside workspace refused'
Must-Fail {Assert-MainLocalPath 'D:\FLSD-Batch7-Validation\..\other\test.sql'} 'path escape refused'
# Poisoning a child environment never changes the parent's inherited settings.
if(Test-Path Env:PGFLSD_OFFLINE_SENTINEL){throw 'Reserved offline sentinel already set; no parent environment change'}
$env:PGFLSD_OFFLINE_SENTINEL='nonsecret-sentinel'
try{
 $node=(Get-Command node).Source;$arguments=@('-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','space value','quote"here','C:\path with spaces\end\','; not shell code')
 $info=New-MainPgProcessInfo $node $arguments
 Check (-not $info.EnvironmentVariables.ContainsKey('PGFLSD_OFFLINE_SENTINEL')) 'inherited libpq environment removed'
 Check ($env:PGFLSD_OFFLINE_SENTINEL -eq 'nonsecret-sentinel') 'parent environment unchanged'
 Check ($info.EnvironmentVariables['PGHOSTADDR'] -eq '127.0.0.1') 'child hostaddr pinned'
 Check ($info.EnvironmentVariables['PGOPTIONS'].Contains('default_transaction_read_only=off')) 'creation write mode explicit'
 $p=[Diagnostics.Process]::new();$p.StartInfo=$info;$null=$p.Start();$output=$p.StandardOutput.ReadToEnd();$p.WaitForExit()
 Check ($p.ExitCode -eq 0 -and ($output -ceq (ConvertTo-Json -InputObject @($arguments[2..5]) -Compress))) 'Windows argv round-trip with spaces/quotes/backslashes'
 $p.Dispose()
}finally{Remove-Item Env:PGFLSD_OFFLINE_SENTINEL -ErrorAction SilentlyContinue}
foreach($file in @('inspect-create-main-disposable.ps1','main-disposable-safety.ps1','maintain-main-disposable.ps1','run-main-adapter-tests.ps1','test-main-disposable-safety.ps1')){
 $tokens=$null;$errors=$null;$null=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot $file),[ref]$tokens,[ref]$errors);Check ($errors.Count -eq 0) ('PowerShell syntax '+$file)
}
[pscustomobject]@{offlineChecks=$taskCases;powerShellVersion=$PSVersionTable.PSVersion.ToString();databaseCommandsExecuted=0;nativeArgvChecked=$true;artifacts=$taskTestRoot}|ConvertTo-Json -Compress
