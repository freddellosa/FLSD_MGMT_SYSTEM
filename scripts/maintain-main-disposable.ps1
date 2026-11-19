#requires -Version 5.1
param([Parameter(Mandatory=$true)][ValidateSet('VerifyPreMigration','Migrate','SetAppPassword','Backup','Restore')][string]$Action,[switch]$Interactive)
$ErrorActionPreference='Stop'
$taskRoot=[IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if($taskRoot -cne 'D:\FLSD-Batch7-Validation'){throw 'Wrong workspace'}
. (Join-Path $PSScriptRoot 'main-disposable-safety.ps1')
$taskRecord=Read-MainCreationProof $taskRoot
$taskDump=Assert-MainLocalPath (Join-Path $taskRoot 'artifacts\main-adapter-synthetic.dump')
$taskProof=Assert-MainLocalPath (Join-Path $taskRoot 'artifacts\main-adapter-backup-proof.json')
function Write-StageSql([string]$Text){
 $path=Assert-MainLocalPath (Join-Path $taskRoot ('artifacts\main-adapter-stage-'+[guid]::NewGuid().ToString()+'.sql'))
 $stream=[IO.File]::Open($path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write)
 try{$bytes=[Text.UTF8Encoding]::new($false).GetBytes($Text);$stream.Write($bytes,0,$bytes.Length);$stream.Flush($true)}finally{$stream.Dispose()}
 return $path
}
function Invoke-TargetSql([string]$Database,[string]$Sql,[bool]$ReadOnly){
 $path=Write-StageSql $Sql
 $result=Invoke-MainPg -Tool psql -User $taskRecord.adminUser -Database $Database -Extra @('-qAt','-f',$path) -Interactive:$Interactive -ReadOnly:$ReadOnly
 if($result.ExitCode -ne 0){throw 'Guarded SQL failed; preserve stage files, no automatic retry/cleanup'}
 return $result.Output
}
function Read-Fingerprint([string]$Database){
 $guard=Get-MainIdentityGuardSql $taskRecord $Database $false
 $sql=@"
BEGIN READ ONLY;
$guard
SELECT json_build_object('run',(SELECT run_id FROM flsd_adapter_test.meta WHERE id=1),'workspace',(SELECT md5(coalesce(jsonb_agg(to_jsonb(w) ORDER BY id)::text,'')) FROM flsd_adapter_test.workspace w),'records',(SELECT md5(coalesce(jsonb_agg(to_jsonb(r) ORDER BY kind,id)::text,'')) FROM flsd_adapter_test.records r),'operations',(SELECT md5(coalesce(jsonb_agg(to_jsonb(o) ORDER BY operation_id)::text,'')) FROM flsd_adapter_test.operations o),'audit',(SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY operation_id)::text,'')) FROM flsd_adapter_test.audit a),'history',(SELECT md5(coalesce(jsonb_agg(to_jsonb(h) ORDER BY operation_id)::text,'')) FROM flsd_adapter_test.history h),'actors',(SELECT md5(coalesce(jsonb_agg(to_jsonb(a) ORDER BY id)::text,'')) FROM flsd_adapter_test.actors a),'sessions',(SELECT md5(coalesce(jsonb_agg(to_jsonb(s) ORDER BY token_hash)::text,'')) FROM flsd_adapter_test.sessions s));
ROLLBACK;
"@
 $output=Invoke-TargetSql $Database $sql $true
 $json=@($output -split "`n" | Where-Object {$_.StartsWith('{')})
 if($json.Count -ne 1){throw 'Fingerprint response missing'}
 return $json[0].Trim()
}
if($Action -eq 'VerifyPreMigration'){
 $guard=Get-MainIdentityGuardSql $taskRecord 'flsd_main_adapter_test' $true
 $sql="BEGIN READ ONLY;`r`n"+$guard+@'

SELECT json_build_object('database',current_database(),'oid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),'owner',(SELECT pg_get_userbyid(datdba) FROM pg_database WHERE datname=current_database()),'read_only',current_setting('transaction_read_only'),'adapter_schema_count',(SELECT count(*) FROM pg_namespace WHERE nspname='flsd_adapter_test'),'public_objects',(SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public'),'status','PRE_MIGRATION_STATE_VERIFIED');
ROLLBACK;
'@
 $output=Invoke-TargetSql 'flsd_main_adapter_test' $sql $true
 $json=@($output -split "`n" | Where-Object {$_.StartsWith('{')})
 if($json.Count -ne 1){throw 'Read-only verification response missing'}
 $verified=$json[0] | ConvertFrom-Json
 if($verified.read_only -cne 'on' -or $verified.adapter_schema_count -ne 0 -or $verified.public_objects -ne 0){throw 'Unexpected pre-migration state; no repair attempted'}
 Write-Output $json[0].Trim()
}elseif($Action -eq 'Migrate'){
 $source=Assert-MainLocalPath (Join-Path $taskRoot 'prisma\disposable-main-adapter.sql')
 if((Get-FileHash -LiteralPath $source -Algorithm SHA256).Hash -cne $taskRecord.migrationSha256){throw 'Reviewed migration changed; stop for review'}
 $migration=[IO.File]::ReadAllText($source)
 # Insert same-session OID/role/pristine guard INSIDE the migration's own transaction.
 $boundary=[regex]::Match($migration,'(?m)^BEGIN;\r?$')
 if(-not $boundary.Success){throw 'Expected migration transaction boundary missing'}
 $guard=Get-MainIdentityGuardSql $taskRecord 'flsd_main_adapter_test' $true
 $migration=$migration.Insert($boundary.Index+$boundary.Length,("`r`n"+$guard))
 $path=Write-StageSql $migration
 $result=Invoke-MainPg -Tool psql -User $taskRecord.adminUser -Database flsd_main_adapter_test -Extra @('-f',$path,'-v',('run_id='+$taskRecord.runId),'-v',('owner_role='+$taskRecord.expectedOwner),'-v',('app_role='+$taskRecord.user)) -Interactive:$Interactive
 if($result.ExitCode -ne 0){throw 'Migration failed; no automatic rerun or cleanup'}
}elseif($Action -eq 'SetAppPassword'){
 if(-not $Interactive){throw 'Manual native hidden-input mode required; no password argument'}
 $guard=Get-MainIdentityGuardSql $taskRecord 'flsd_main_adapter_test' $false
 # Guard and native psql password command execute in the SAME connection.
 $sql=$guard+"`r`n\password "+$taskRecord.user+"`r`n"
 $null=Invoke-TargetSql 'flsd_main_adapter_test' $sql $false
}elseif($Action -eq 'Backup'){
 if((Test-Path -LiteralPath $taskDump) -or (Test-Path -LiteralPath $taskProof)){throw 'Backup artifacts exist; no overwrite'}
 $before=Read-Fingerprint 'flsd_main_adapter_test'
 if(($before | ConvertFrom-Json).run -cne $taskRecord.runId){throw 'Schema run mismatch'}
 $result=Invoke-MainPg -Tool pg_dump -User $taskRecord.adminUser -Database flsd_main_adapter_test -Extra @('-Fc','--no-owner','--no-acl','-f',$taskDump) -Interactive:$Interactive -ReadOnly
 if($result.ExitCode -ne 0){throw 'Backup failed; preserve partial file, no cleanup'}
 $after=Read-Fingerprint 'flsd_main_adapter_test'
 if($before -cne $after){throw 'Source changed during backup; archive not approved'}
 Write-MainExclusiveJson $taskProof @{proofVersion=2;runId=$taskRecord.runId;sha256=(Get-FileHash -LiteralPath $taskDump -Algorithm SHA256).Hash;fingerprint=$after}
}else{
 if(-not(Test-Path -LiteralPath $taskDump) -or -not(Test-Path -LiteralPath $taskProof)){throw 'Backup artifacts missing'}
 $backup=Get-Content -LiteralPath $taskProof -Raw | ConvertFrom-Json
 if($backup.proofVersion -ne 2 -or $backup.runId -cne $taskRecord.runId -or $backup.sha256 -cne (Get-FileHash -LiteralPath $taskDump -Algorithm SHA256).Hash){throw 'Backup provenance/hash mismatch'}
 $guard=Get-MainIdentityGuardSql $taskRecord 'flsd_main_restore_test' $true
 # Decode locally, then execute a guarded single transaction. pg_restore never connects.
 $decoded=Assert-MainLocalPath (Join-Path $taskRoot ('artifacts\main-adapter-restore-'+[guid]::NewGuid().ToString()+'.sql'))
 if(Test-Path -LiteralPath $decoded){throw 'Restore plan exists'}
 $result=Invoke-MainPg -Tool pg_restore -User $taskRecord.adminUser -Database flsd_main_restore_test -Extra @('--no-owner','--no-privileges','-f',$decoded,$taskDump) -LocalArchiveOnly
 if($result.ExitCode -ne 0){throw 'Archive decode failed; no database restore attempted'}
 $text=[IO.File]::ReadAllText($decoded)
 if($text -match '(?im)^\s*(\\connect\b|CREATE\s+DATABASE\b|ALTER\s+DATABASE\b|BEGIN\s*;|COMMIT\s*;|SET\s+SESSION\s+AUTHORIZATION\b)'){throw 'Archive contains forbidden connection/transaction/database commands'}
 $sql=$guard+"`r`nSET LOCAL ROLE "+$taskRecord.expectedOwner+";`r`n"+$text
 $path=Write-StageSql $sql
 $result=Invoke-MainPg -Tool psql -User $taskRecord.adminUser -Database flsd_main_restore_test -Extra @('--single-transaction','-f',$path) -Interactive:$Interactive
 if($result.ExitCode -ne 0){throw 'Restore failed or commit outcome uncertain; no automatic retry/cleanup'}
 if((Read-Fingerprint 'flsd_main_restore_test') -cne $backup.fingerprint){throw 'Restored evidence mismatch'}
}
Write-Output ($Action+' completed only within matching newly created disposable provenance.')
