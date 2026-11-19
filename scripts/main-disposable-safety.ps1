# Windows PowerShell 5.1 compatible helpers. Dot-sourcing performs NO database work.
Set-StrictMode -Version 2.0
function Assert-MainLocalPath([string]$Path){
 $root='D:\FLSD-Batch7-Validation';$full=[IO.Path]::GetFullPath($Path)
 if($full -ne $root -and -not $full.StartsWith($root+'\',[StringComparison]::OrdinalIgnoreCase)){throw 'Path outside validation workspace'}
 $cursor=$full
 while($cursor.Length -ge $root.Length){
  if(Test-Path -LiteralPath $cursor){if(([IO.File]::GetAttributes($cursor) -band [IO.FileAttributes]::ReparsePoint) -ne 0){throw 'Reparse-point path refused'}}
  if($cursor -eq $root){break};$cursor=[IO.Path]::GetDirectoryName($cursor)
 }
 return $full
}
function ConvertTo-MainNativeArgument([string]$Value){
 if($Value.IndexOf([char]0) -ge 0 -or $Value.Contains("`r") -or $Value.Contains("`n")){throw 'Invalid native argument'}
 $escaped=[regex]::Replace($Value,'(\\*)"','$1$1\"')
 $escaped=[regex]::Replace($escaped,'(\\+)$','$1$1')
 return '"'+$escaped+'"'
}
function New-MainPgProcessInfo([string]$Executable,[string[]]$Arguments,[switch]$ReadOnly){
 $info=[Diagnostics.ProcessStartInfo]::new();$info.FileName=$Executable
 $info.Arguments=($Arguments | ForEach-Object {ConvertTo-MainNativeArgument $_}) -join ' '
 $info.UseShellExecute=$false;$info.CreateNoWindow=$false
 $info.WorkingDirectory='D:\FLSD-Batch7-Validation'
 $info.RedirectStandardInput=$false;$info.RedirectStandardOutput=$true;$info.RedirectStandardError=$false
 $info.StandardOutputEncoding=[Text.UTF8Encoding]::new($false)
 # Remove ALL libpq settings in the CHILD only; never read/log their values or mutate the parent.
 foreach($name in @($info.EnvironmentVariables.Keys)){if($name -like 'PG*'){$info.EnvironmentVariables.Remove($name)}}
 $info.EnvironmentVariables['PGHOSTADDR']='127.0.0.1'
 $info.EnvironmentVariables['PGPASSFILE']='D:\FLSD-Batch7-Validation\artifacts\absent-pgpass-'+[guid]::NewGuid().ToString()
 $info.EnvironmentVariables['PGSSLMODE']='disable'
 $info.EnvironmentVariables['PGCONNECT_TIMEOUT']='5'
 $info.EnvironmentVariables['PGCLIENTENCODING']='UTF8'
 $mode=if($ReadOnly){'on'}else{'off'}
 $info.EnvironmentVariables['PGOPTIONS']='-c default_transaction_read_only='+$mode+' -c statement_timeout=120000 -c lock_timeout=10000 -c idle_session_timeout=60000 -c transaction_timeout=0 -c search_path=pg_catalog -c application_name=flsd_disposable_guard'
 return $info
}
function Invoke-MainPg([ValidateSet('psql','pg_dump','pg_restore')][string]$Tool,[string]$User,[ValidateSet('postgres','flsd_main_adapter_test','flsd_main_restore_test')][string]$Database,[string[]]$Extra,[switch]$Interactive,[switch]$ReadOnly,[switch]$LocalArchiveOnly){
 if($User -notmatch '^[a-z_][a-z0-9_]{0,62}$'){throw 'Invalid role'}
 $exe='C:\Program Files\PostgreSQL\18\bin\'+$Tool+'.exe'
 if(-not(Test-Path -LiteralPath $exe)){throw 'Approved PostgreSQL 18 client unavailable'}
 $auth=if($Interactive){'-W'}else{'-w'}
 $nativeArgs=@($auth,'-h','127.0.0.1','-p','5432','-U',$User,'-d',$Database)
 if($Tool -eq 'psql'){$nativeArgs=@('-X','-v','ON_ERROR_STOP=on','-v','AUTOCOMMIT=on','-v','ECHO=none','-v','ECHO_HIDDEN=off')+$nativeArgs}
 if($LocalArchiveOnly){if($Tool -ne 'pg_restore'){throw 'Invalid archive-only mode'};$nativeArgs=@()}
 $info=New-MainPgProcessInfo $exe ($nativeArgs+$Extra) -ReadOnly:$ReadOnly
 $process=[Diagnostics.Process]::new();$process.StartInfo=$info;$started=$false
 try{
  $null=$process.Start();$started=$true;$output=$process.StandardOutput.ReadToEndAsync();$process.WaitForExit()
  return [pscustomobject]@{ExitCode=$process.ExitCode;Output=$output.GetAwaiter().GetResult()}
 }finally{
  # Closing/killing this owned client closes its session; no pg_terminate_backend or cleanup SQL.
  if($started -and -not $process.HasExited){try{$process.Kill();$process.WaitForExit()}catch{}}
  $process.Dispose()
 }
}
function Write-MainExclusiveJson([string]$Path,$Value,[switch]$Compact){
 $path=Assert-MainLocalPath $Path;$stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
 try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes(($Value | ConvertTo-Json -Depth 12 -Compress:$Compact));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Add-MainAttemptEvent([string]$Path,[string]$Status){
 $path=Assert-MainLocalPath $Path
 $stream=[IO.File]::Open($path,[IO.FileMode]::Append,[IO.FileAccess]::Write)
 try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes("`r`n"+([ordered]@{at=[DateTime]::UtcNow.ToString('o');status=$Status}|ConvertTo-Json -Compress));$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
}
function Read-MainCreationProof([string]$Root){
 $path=Assert-MainLocalPath (Join-Path $Root 'artifacts\main-adapter-creation.json')
 $record=Get-Content -LiteralPath $path -Raw | ConvertFrom-Json
 if($record.proofVersion -ne 2 -or $record.createdByThisRun -ne $true -or $record.host -ne '127.0.0.1' -or $record.port -ne 5432 -or $record.runId -cnotmatch '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' -or ($record.databases -join ',') -cne 'flsd_main_adapter_test,flsd_main_restore_test'){throw 'Invalid exclusive creation proof'}
 $suffix=$record.runId.Replace('-','').Substring(0,12)
 if($record.user -cne ('flsd_test_app_'+$suffix) -or $record.expectedOwner -cne ('flsd_test_owner_'+$suffix) -or $record.adminUser -cnotmatch '^[a-z_][a-z0-9_]{0,62}$'){throw 'Role provenance mismatch'}
 foreach($name in $record.databases){$entries=@($record.verifiedDatabases | Where-Object {$_.name -ceq $name});if($entries.Count -ne 1 -or [string]$entries[0].oid -notmatch '^[1-9][0-9]*$'){throw 'Database OID proof missing'}}
 if(@($record.verifiedDatabases).Count -ne 2){throw 'Unexpected database proof'}
 foreach($name in @($record.expectedOwner,$record.user)){$entries=@($record.verifiedRoles | Where-Object {$_.name -ceq $name});if($entries.Count -ne 1 -or [string]$entries[0].oid -notmatch '^[1-9][0-9]*$'){throw 'Role OID proof missing'}}
 if(@($record.verifiedRoles).Count -ne 2){throw 'Unexpected role proof'}
 $plan=Assert-MainLocalPath $record.plan
 if((Get-FileHash -LiteralPath $plan -Algorithm SHA256).Hash -cne $record.planSha256){throw 'Creation plan hash mismatch'}
 $attempt=Assert-MainLocalPath (Join-Path $Root 'artifacts\main-adapter-attempt.jsonl')
 $lines=@(Get-Content -LiteralPath $attempt)
 $first=$lines[0] | ConvertFrom-Json
 if($first.runId -cne $record.runId -or $first.plan -cne $record.plan -or $first.planSha256 -cne $record.planSha256){throw 'Attempt run/plan identity mismatch'}
 if(($lines[-1] | ConvertFrom-Json).status -ne 'COMPLETED_PROOF_WRITTEN'){throw 'Attempt incomplete; no automatic continuation'}
 return $record
}
function Get-MainIdentityGuardSql($Record,[string]$Database,[bool]$Pristine){
 if($Database -cnotin @('flsd_main_adapter_test','flsd_main_restore_test')){throw 'Database outside allowed scope'}
 $oid=@($Record.verifiedDatabases | Where-Object {$_.name -ceq $Database})[0].oid
 $ownerOid=@($Record.verifiedRoles | Where-Object {$_.name -ceq $Record.expectedOwner})[0].oid
 $appOid=@($Record.verifiedRoles | Where-Object {$_.name -ceq $Record.user})[0].oid
 foreach($value in @($oid,$ownerOid,$appOid)){if([string]$value -notmatch '^[1-9][0-9]*$'){throw 'Invalid proven OID'}}
 $sql=@'
DO $flsd_guard$ DECLARE d record;r record; BEGIN
 SELECT * INTO d FROM pg_database WHERE datname=current_database();
 IF current_database()<>'__DATABASE__' OR d.oid<>__OID__::oid OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR inet_server_port() IS DISTINCT FROM 5432 OR current_user<>'__ADMIN__' OR pg_is_in_recovery() OR current_setting('server_version_num')::int/10000<>18 OR d.datdba<>__OWNER_OID__::oid OR shobj_description(d.oid,'pg_database') IS DISTINCT FROM 'FLSD_DISPOSABLE:__RUN__:__DATABASE__' THEN RAISE EXCEPTION 'Disposable target/provenance mismatch'; END IF;
 FOR r IN SELECT * FROM pg_roles WHERE oid IN(__OWNER_OID__::oid,__APP_OID__::oid) LOOP
  IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolbypassrls OR r.rolreplication OR r.rolinherit OR r.rolname<>(CASE WHEN r.oid=__OWNER_OID__::oid THEN '__OWNER__' ELSE '__APP__' END) OR r.rolcanlogin<>(r.oid=__APP_OID__::oid) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) OR shobj_description(r.oid,'pg_authid') IS DISTINCT FROM ('FLSD_DISPOSABLE_ROLE:__RUN__:'||CASE WHEN r.oid=__OWNER_OID__::oid THEN 'OWNER' ELSE 'APP' END) THEN RAISE EXCEPTION 'Disposable role identity/privilege mismatch'; END IF;
 END LOOP;
 IF (SELECT count(*) FROM pg_roles WHERE oid IN(__OWNER_OID__::oid,__APP_OID__::oid))<>2 THEN RAISE EXCEPTION 'Proven role missing'; END IF;
 IF __PRISTINE__ AND (EXISTS(SELECT 1 FROM pg_namespace WHERE nspname NOT IN('public','information_schema') AND nspname NOT LIKE 'pg_%') OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public') OR EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public') OR EXISTS(SELECT 1 FROM pg_type t JOIN pg_namespace n ON n.oid=t.typnamespace WHERE n.nspname='public')) THEN RAISE EXCEPTION 'Target is not pristine; no overwrite allowed'; END IF;
END $flsd_guard$;
'@
 return $sql.Replace('__DATABASE__',$Database).Replace('__OID__',[string]$oid).Replace('__OWNER_OID__',[string]$ownerOid).Replace('__APP_OID__',[string]$appOid).Replace('__ADMIN__',$Record.adminUser).Replace('__OWNER__',$Record.expectedOwner).Replace('__APP__',$Record.user).Replace('__RUN__',$Record.runId).Replace('__PRISTINE__',$(if($Pristine){'true'}else{'false'}))
}
function Invoke-MainCreationSequence([string]$DatabaseUser,[bool]$Create,[bool]$Interactive,[string]$ArtifactDirectory,[scriptblock]$Runner){
 if($DatabaseUser -cnotmatch '^[a-z_][a-z0-9_]{0,62}$'){throw 'Invalid administrator role'}
 $artifacts=Assert-MainLocalPath $ArtifactDirectory
 $receipt=Join-Path $artifacts 'main-adapter-creation.json';$attempt=Join-Path $artifacts 'main-adapter-attempt.jsonl'
 if($Create -and ((Test-Path -LiteralPath $receipt) -or (Test-Path -LiteralPath $attempt))){throw 'Prior attempt/proof exists: STOP; no rerun, cleanup or overwrite'}
 $query="BEGIN READ ONLY; SELECT json_build_object('user',current_user,'database',current_database(),'host',host(inet_server_addr()),'port',inet_server_port(),'version',current_setting('server_version_num')::int,'readOnly',current_setting('transaction_read_only'),'recovery',pg_is_in_recovery(),'createdb',(SELECT rolcreatedb OR rolsuper FROM pg_roles WHERE rolname=current_user),'createrole',(SELECT rolcreaterole OR rolsuper FROM pg_roles WHERE rolname=current_user),'existing',(SELECT coalesce(json_agg(datname),'[]'::json) FROM pg_database WHERE datname IN ('flsd_main_adapter_test','flsd_main_restore_test'))); ROLLBACK;"
 $reply=& $Runner 'psql' $DatabaseUser 'postgres' @('-qAt','-c',$query) $Interactive $true
 if($reply.ExitCode -ne 0){throw 'Read-only authentication/inspection failed; no creation attempted'}
 $json=@($reply.Output -split "`n" | Where-Object {$_.StartsWith('{')})
 if($json.Count -ne 1){throw 'Invalid inspection response'}
 $inspection=$json[0] | ConvertFrom-Json
 if($inspection.host -cne '127.0.0.1' -or $inspection.port -ne 5432 -or $inspection.database -cne 'postgres' -or $inspection.user -cne $DatabaseUser -or [math]::Floor($inspection.version/10000) -ne 18 -or $inspection.readOnly -cne 'on' -or $inspection.recovery -ne $false){throw 'Server/identity/version/read-only mismatch'}
 if(@($inspection.existing).Count -ne 0){throw 'A proposed database exists: STOP and request different names'}
 if(-not $Create){return [pscustomobject]@{status='ABSENCE_VERIFIED_READ_ONLY'}}
 if($inspection.createdb -ne $true -or $inspection.createrole -ne $true){throw 'Required creation privileges unavailable; no elevation'}
 $run=[guid]::NewGuid().ToString();$suffix=$run.Replace('-','').Substring(0,12);$owner='flsd_test_owner_'+$suffix;$app='flsd_test_app_'+$suffix
 $source=Assert-MainLocalPath 'D:\FLSD-Batch7-Validation\scripts\create-main-disposable.sql'
 $migration=Assert-MainLocalPath 'D:\FLSD-Batch7-Validation\prisma\disposable-main-adapter.sql'
 $plan=Join-Path $artifacts ('main-adapter-plan-'+$run+'.sql');$planHash=(Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash
 $migrationHash=(Get-FileHash -LiteralPath $migration -Algorithm SHA256).Hash
 $initial=[ordered]@{runId=$run;at=[DateTime]::UtcNow.ToString('o');status='PENDING_CREATION_NOT_STARTED';adminUser=$DatabaseUser;owner=$owner;app=$app;plan=$plan;planSha256=$planHash;migrationSha256=$migrationHash;databases=@('flsd_main_adapter_test','flsd_main_restore_test')}
 Write-MainExclusiveJson $attempt $initial -Compact
 try{
  $sourceBytes=[IO.File]::ReadAllBytes($source);$stream=[IO.File]::Open((Assert-MainLocalPath $plan),[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
  try{$stream.Write($sourceBytes,0,$sourceBytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
  if((Get-FileHash -LiteralPath $plan -Algorithm SHA256).Hash -cne $planHash){throw 'Creation plan changed'}
  Add-MainAttemptEvent $attempt 'STARTING_SERVER_SEQUENCE'
  $extra=@('-qAt','-v',('run_id='+$run),'-v',('owner_role='+$owner),'-v',('app_role='+$app),'-v',('admin_role='+$DatabaseUser),'-f',$plan)
  $reply=& $Runner 'psql' $DatabaseUser 'postgres' $extra $Interactive $false
  foreach($line in ($reply.Output -split "`n")){if($line.Trim() -cmatch '^FLSD_STAGE:(LOCKED_ABSENCE_VERIFIED|OWNER_CREATED|APP_CREATED|PRIMARY_CREATED|RESTORE_CREATED|POSTCONDITIONS_VERIFIED)$'){Add-MainAttemptEvent $attempt $line.Trim()}}
  if($reply.ExitCode -ne 0){throw 'Server creation stopped; partial or uncertain state'}
  $resultLines=@($reply.Output -split "`n" | Where-Object {$_.StartsWith('FLSD_RESULT:')})
  if($resultLines.Count -ne 1){throw 'Post-creation proof unavailable'}
  $proof=$resultLines[0].Substring(12) | ConvertFrom-Json
  if($proof.runId -cne $run -or @($proof.verifiedDatabases).Count -ne 2 -or @($proof.verifiedRoles).Count -ne 2){throw 'Invalid server postconditions'}
  foreach($name in @('flsd_main_adapter_test','flsd_main_restore_test')){$found=@($proof.verifiedDatabases | Where-Object {$_.name -ceq $name});if($found.Count -ne 1 -or [string]$found[0].oid -notmatch '^[1-9][0-9]*$'){throw 'Database OID proof missing'}}
  foreach($name in @($owner,$app)){$found=@($proof.verifiedRoles | Where-Object {$_.name -ceq $name});if($found.Count -ne 1 -or [string]$found[0].oid -notmatch '^[1-9][0-9]*$'){throw 'Role OID proof missing'}}
  if((Get-FileHash -LiteralPath $migration -Algorithm SHA256).Hash -cne $migrationHash){throw 'Migration source changed during creation'}
  $record=[ordered]@{proofVersion=2;createdByThisRun=$true;runId=$run;host='127.0.0.1';port=5432;adminUser=$DatabaseUser;user=$app;expectedOwner=$owner;databases=@('flsd_main_adapter_test','flsd_main_restore_test');verifiedDatabases=$proof.verifiedDatabases;verifiedRoles=$proof.verifiedRoles;serverVersion=$proof.serverVersion;plan=$plan;planSha256=$planHash;migrationSha256=$migrationHash}
  Write-MainExclusiveJson $receipt $record
  Add-MainAttemptEvent $attempt 'COMPLETED_PROOF_WRITTEN'
  return [pscustomobject]@{status='CREATED_AND_VERIFIED';runId=$run;user=$app}
 }catch{
  try{Add-MainAttemptEvent $attempt 'FAILED_OR_UNCERTAIN_NO_CLEANUP'}catch{}
  throw 'Creation failed or is uncertain. STOP. Preserve attempt/plan; no automatic cleanup, overwrite or rerun.'
 }
}
