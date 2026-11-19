'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {spawn, spawnSync, execFileSync} = require('node:child_process');
const readline = require('node:readline');

const database = 'flsd_pilot_validation';
const recovery = 'flsd_pilot_backup_recovery';
const role = 'flsd_pilot_backup';
const host = '127.0.0.1';
const port = '55437';
const root = 'D:\\FLSD-Invoicing-Backups';
const tools = 'C:\\Program Files\\PostgreSQL\\18\\bin';
const tables = ('allocations attachments audit customer_formats customers document_trips documents drivers import_batches ' +
  'invoice_formats login_attempts meta operations receipts refunds remittances sessions settings trips users vehicles workspace')
  .split(' ').map(name => 'pilot_'+name);
const bundlePattern = /^flsd_pilot_validation-\d{8}T\d{9}Z-[a-f0-9]{8}$/;
const day = 86400000;
const hour = 3600000;
const marker = 'FLSD_ISOLATED_PILOT_ONLY';

function bail(code) { throw Object.assign(new Error(code), {backupCode:code}); }
function identityOid(value) {
  if (!/^[1-9][0-9]{0,9}$/.test(String(value)) || Number(value)>4294967295) bail('INVALID_OID');
  return String(value);
}
function checkedPath(file, directory=false) {
  const stat=fs.lstatSync(file);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile()) ||
      path.resolve(fs.realpathSync(file)).toLowerCase()!==path.resolve(file).toLowerCase()) bail('UNSAFE_PATH');
  return stat;
}
function readJson(file) {
  checkedPath(file);
  return JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
}
function hashFile(file) {
  checkedPath(file);
  const hash=crypto.createHash('sha256');
  const fd=fs.openSync(file,'r');
  try {
    const buffer=Buffer.alloc(65536);
    for (let size; (size=fs.readSync(fd,buffer,0,buffer.length,null))!==0;) hash.update(buffer.subarray(0,size));
    return hash.digest('hex');
  } finally { fs.closeSync(fd); }
}
function writeJson(file, value) {
  fs.writeFileSync(file,JSON.stringify(value,null,2)+'\n',{flag:'wx',mode:0o600});
}
function manifestSql() {
  const rows=tables.map(table=>`SELECT '${table}' AS name,count(*) AS row_count,
    encode(sha256(convert_to(coalesce(string_agg(encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex'), ''
       ORDER BY encode(sha256(convert_to(to_jsonb(t)::text,'UTF8')),'hex') COLLATE "C"),''),'UTF8')),'hex') AS sha256
    FROM public.${table} t`).join(' UNION ALL ');
  return `SELECT jsonb_object_agg(name,jsonb_build_array(row_count,sha256))::text FROM (${rows}) evidence;`;
}
function identitySql(config) {
  return `SELECT jsonb_build_object('verified',
   current_database()='${database}' AND (SELECT oid FROM pg_database WHERE datname=current_database())=${config.databaseOid}::oid
   AND inet_server_addr()='${host}'::inet AND inet_server_port()=${port}
   AND current_user='${role}' AND current_user=session_user AND NOT pg_is_in_recovery()
   AND current_setting('server_version_num')::int/10000=18
   AND (SELECT count(*) FROM public.pilot_meta WHERE id=1 AND marker='${marker}' AND schema_version=3)=1
   AND (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE c.relkind IN ('r','p','S','v','m','f') AND n.nspname NOT IN ('pg_catalog','information_schema')
        AND n.nspname !~ '^pg_toast' AND n.nspname !~ '^pg_temp')=${tables.length}
   AND NOT EXISTS (SELECT 1 FROM pg_roles r WHERE r.rolname=current_user AND
     (r.oid<>${config.roleOid}::oid OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolinherit OR r.rolbypassrls
      OR shobj_description(r.oid,'pg_authid') IS DISTINCT FROM 'FLSD_PILOT_BACKUP_ONLY'
      OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)))
   AND NOT has_database_privilege(current_user,current_database(),'CREATE')
   AND NOT has_schema_privilege(current_user,'public','CREATE')
   AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace)
   AND NOT EXISTS (SELECT 1 FROM unnest(ARRAY[${tables.map(t=>`'public.${t}'`).join(',')}]) AS target(name)
      WHERE NOT has_table_privilege(current_user,name,'SELECT')
        OR has_table_privilege(current_user,name,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,REFERENCES')
        OR has_any_column_privilege(current_user,name,'INSERT,UPDATE,REFERENCES')
        OR row_security_active(name)),
   'databaseBytes',pg_database_size(current_database())::text)::text;`;
}
function checkManifest(manifest) {
  if (!manifest || Object.keys(manifest).length!==tables.length ||
      tables.some(t=>!Array.isArray(manifest[t]) || manifest[t].length!==2 ||
        !Number.isSafeInteger(manifest[t][0]) || manifest[t][0]<0 || !/^[a-f0-9]{64}$/.test(manifest[t][1]))) bail('TABLE_MANIFEST_INVALID');
  return manifest;
}
function sameManifest(a,b) {
  checkManifest(a);
  checkManifest(b);
  return tables.every(t=>a[t][0]===b[t][0] && a[t][1]===b[t][1]);
}
function checkToc(toc) {
  const lines=toc.split(/\r?\n/).filter(line=>/^\d+;/.test(line));
  for (const type of ['TABLE','TABLE DATA']) {
    const entries=lines.map(line=>new RegExp(`^\\d+; \\d+ \\d+ ${type} public (pilot_\\w+) `).exec(line)?.[1]).filter(Boolean);
    if (entries.length!==tables.length || tables.some(t=>entries.filter(x=>x===t).length!==1)) bail('ARCHIVE_INVENTORY_INVALID');
  }
  if (lines.some(line=>/^\d+; \d+ \d+ (?:TABLE(?: DATA)?|SEQUENCE|BLOB|MATERIALIZED VIEW|FOREIGN TABLE) /.test(line) &&
      !/^\d+; \d+ \d+ TABLE(?: DATA)? public pilot_\w+ /.test(line))) bail('ARCHIVE_SCOPE_INVALID');
}
function envFor(passfile) {
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG/i.test(key)));
  Object.assign(env,{PGHOSTADDR:host,PGPASSFILE:passfile,PGCONNECT_TIMEOUT:'5',PGSSLMODE:'disable',
    PGCLIENTENCODING:'UTF8',PGOPTIONS:'-c statement_timeout=120000 -c lock_timeout=10000 -c idle_in_transaction_session_timeout=1200000'});
  return env;
}
function connect(user, target) { return ['-w','-h',host,'-p',port,'-U',user,'-d',target]; }
function run(tool,args,env,stage,input,timeout=600000) {
  try {
    return execFileSync(path.join(tools,tool+'.exe'),args,{env,input,windowsHide:true,timeout,
      stdio:['pipe','pipe','pipe'],encoding:'utf8',maxBuffer:32*1024*1024});
  } catch { bail(stage); }
}
function log(directory,slot,status,detail={}) {
  const now=new Date();
  const file=path.join(directory,'runs-'+now.toISOString().slice(0,10)+'.jsonl');
  if (fs.existsSync(file)) checkedPath(file);
  fs.appendFileSync(file,JSON.stringify({at:now.toISOString(),slot,status,...detail})+'\n',{mode:0o600});
}
function alertPath(directory, slot) { return path.join(directory,'ALERT-'+slot+'.json'); }
function assertPrivateDestination() {
  const command = "$ErrorActionPreference='Stop'; "+
    "$sid=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value; "+
    "$allowed=@($sid,'S-1-5-18','S-1-5-32-544'); "+
    "foreach($path in @('D:\\FLSD-Invoicing-Backups','D:\\FLSD-Invoicing-Backups\\pgpass.conf')){"+
    "$acl=Get-Acl -LiteralPath $path; foreach($rule in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])){"+
    "if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -notin $allowed){exit 1}}}; exit 0";
  try {
    execFileSync('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      ['-NoProfile','-NonInteractive','-Command',command],{stdio:'ignore',windowsHide:true,timeout:15000});
  } catch { bail('BACKUP_DESTINATION_ACL_REFUSED'); }
}
function inventory(directory) {
  return fs.readdirSync(directory,{withFileTypes:true}).filter(e=>e.isDirectory()&&bundlePattern.test(e.name)).map(e=>{
    try {
      const bundle=path.join(directory,e.name);
      checkedPath(bundle,true);
      const manifest=readJson(path.join(bundle,'manifest.json'));
      const size=checkedPath(path.join(bundle,'database.dump')).size;
      if (manifest.job!=='flsd-pilot-backup-v1'||manifest.database!==database||manifest.bundle!==e.name||
          !/^\d{4}-\d\d-\d\dT/.test(manifest.completedAt)||!Number.isFinite(Date.parse(manifest.completedAt))||
          size!==manifest.archiveBytes||!/^[a-f0-9]{64}$/.test(manifest.sha256)) bail('INVALID_BUNDLE');
      return {bundle:e.name,slot:manifest.slot,completedAt:manifest.completedAt,archiveBytes:size,status:'AVAILABLE'};
    } catch { return {bundle:e.name,status:'UNVERIFIED'}; }
  }).sort((a,b)=>(b.completedAt??'').localeCompare(a.completedAt??''));
}
function retain(directory, now=Date.now()) {
  const available=inventory(directory).filter(entry=>entry.status==='AVAILABLE');
  for (const item of available.slice(2)) {
    if (Date.parse(item.completedAt)>=now-30*day) continue;
    const bundle=path.join(directory,item.bundle);
    if (fs.readdirSync(bundle).sort().join(',')!=='archive.toc,database.dump,manifest.json') continue;
    checkedPath(path.join(bundle,'archive.toc'));
    const manifest=readJson(path.join(bundle,'manifest.json'));
    if (manifest.protect===true || manifest.sha256!==hashFile(path.join(bundle,'database.dump'))) continue;
    for (const file of ['archive.toc','database.dump','manifest.json']) fs.unlinkSync(path.join(bundle,file));
    fs.rmdirSync(bundle);
  }
}
function dueAt(slot, now=Date.now()) {
  const manila = now+8*hour;
  const boundary = Math.floor(manila/day)*day+(slot==='noon'?12*hour:0);
  return boundary-8*hour-(manila<boundary?day:0);
}
async function backup(directory,config,slot,options={}) {
  const env=envFor(path.join(directory,'pgpass.conf'));
  const client=spawn(path.join(tools,'psql.exe'),['-X','-qAt','-v','ON_ERROR_STOP=on',...connect(role,database)],{
    env,windowsHide:true,stdio:['pipe','pipe','ignore'],
  });
  client.on('error',()=>{});
  client.stdin.on('error',()=>{});
  const lines=readline.createInterface({input:client.stdout});
  const stream=lines[Symbol.asyncIterator]();
  async function query(sql) {
    client.stdin.write(sql+'\n');
    let timeout;
    try {
      const line=await Promise.race([stream.next(),new Promise((_,reject)=>{
        timeout=setTimeout(()=>reject(Object.assign(new Error(),{backupCode:'SNAPSHOT_TIMEOUT'})),130000);
      })]);
      if (line.done) bail('SNAPSHOT_CONNECTION_OR_QUERY_FAILED');
      return line.value;
    } finally { clearTimeout(timeout); }
  }
  try {
    const lock=await query('SELECT pg_catalog.pg_try_advisory_lock(55437,8042);');
    if (lock!=='t') bail('OVERLAPPING_BACKUP');
    const raw=await query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY; SET LOCAL search_path=pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD'; "+identitySql(config));
    const identity=JSON.parse(raw);
    if (identity.verified!==true) bail('DATABASE_IDENTITY_OR_PERMISSIONS_REFUSED');
    if (!options.protect && inventory(directory).some(item=>item.status==='AVAILABLE'&&item.slot===slot&&
        Date.parse(item.completedAt)>=dueAt(slot))) return null;
    const disk=fs.statfsSync(directory,{bigint:true});
    if (disk.bavail*disk.bsize<BigInt(identity.databaseBytes)*2n+268435456n) bail('INSUFFICIENT_DISK_SPACE');
    const evidence=checkManifest(JSON.parse(await query(manifestSql())));
    const snapshot=await query('SELECT pg_export_snapshot();');
    if (!/^[0-9A-F]+-[0-9A-F]+-\d+$/.test(snapshot)) bail('INVALID_EXPORTED_SNAPSHOT');
    const stamp=new Date().toISOString().replace(/[-:.]/g,'');
    const name=`${database}-${stamp}-${crypto.randomBytes(4).toString('hex')}`;
    const partial=path.join(directory,'.pending-'+name);
    fs.mkdirSync(partial,{mode:0o700});
    const archive=path.join(partial,'database.dump');
    run('pg_dump',[...connect(role,database),'-Fc','--no-owner','--no-acl','--no-statistics',
      '--schema=public','--strict-names','--snapshot='+snapshot,'-f',archive],env,'PG_DUMP_FAILED');
    const toc=run('pg_restore',['--list',archive],env,'PG_RESTORE_LIST_FAILED');
    checkToc(toc);
    run('pg_restore',['--file=NUL',archive],env,'PG_RESTORE_DECODE_FAILED');
    fs.writeFileSync(path.join(partial,'archive.toc'),toc,{flag:'wx',mode:0o600});
    const manifest={job:'flsd-pilot-backup-v1',database,databaseOid:config.databaseOid,roleOid:config.roleOid,
      bundle:name,slot,completedAt:new Date().toISOString(),archiveBytes:checkedPath(archive).size,
      sha256:hashFile(archive),tables:evidence,protect:options.protect===true};
    if (!manifest.archiveBytes) bail('EMPTY_ARCHIVE');
    writeJson(path.join(partial,'manifest.json'),manifest);
    if (await query("SELECT 'SNAPSHOT_ACTIVE';")!=='SNAPSHOT_ACTIVE') bail('SNAPSHOT_LOST');
    fs.renameSync(partial,path.join(directory,name));
    if (!options.protect) retain(directory);
    return manifest;
  } finally {
    client.stdin.end();
    lines.close();
    client.kill();
  }
}

function verifyRecovery(directory,config,bundle,temporaryPassfile,scopedAdminPassword) {
  if (!bundlePattern.test(bundle)) bail('INVALID_CONTROLLED_BUNDLE');
  const folder=path.join(directory,bundle);
  checkedPath(folder,true);
  const manifest=readJson(path.join(folder,'manifest.json'));
  const archive=path.join(folder,'database.dump');
  if (manifest.job!=='flsd-pilot-backup-v1'||manifest.databaseOid!==config.databaseOid||manifest.database!==database||
      manifest.bundle!==bundle||manifest.protect!==true||hashFile(archive)!==manifest.sha256) bail('CONTROLLED_ARCHIVE_REFUSED');
  checkManifest(manifest.tables);
  if (!temporaryPassfile && !scopedAdminPassword && !process.env.APPDATA) bail('RECOVERY_CREDENTIAL_NOT_CONFIGURED');
  const recoveryPassfile=temporaryPassfile??(scopedAdminPassword
    ? path.join(directory,'.unused-recovery-passfile')
    : path.join(process.env.APPDATA,'postgresql','flsd-recovery-pgpass.conf'));
  if (temporaryPassfile &&
      (path.dirname(path.dirname(path.resolve(temporaryPassfile))).toLowerCase()!==path.resolve(directory).toLowerCase() ||
       !/^recovery-auth-[a-f0-9]{32}$/.test(path.basename(path.dirname(temporaryPassfile))) ||
       path.basename(temporaryPassfile)!=='pgpass.conf')) bail('RECOVERY_CREDENTIAL_PATH_REFUSED');
  if (!scopedAdminPassword) checkedPath(recoveryPassfile);
  const env=envFor(recoveryPassfile);
  if (scopedAdminPassword) env.PGPASSWORD=scopedAdminPassword;
  const oid=identityOid(config.recoveryOid);
  if (oid===config.databaseOid) bail('RECOVERY_DATABASE_OID_COLLISION');
  const decoded=run('pg_restore',['--no-owner','--no-acl','--no-statistics','--file=-',archive],env,'RECOVERY_ARCHIVE_DECODE_FAILED');
  if (/^\s*(?:CREATE DATABASE|ALTER DATABASE|DROP|BEGIN;|COMMIT;|ROLLBACK;|\\connect\b)/mi.test(decoded) ||
      /^CREATE SCHEMA (?!public;\r?$)/mi.test(decoded)) bail('RECOVERY_ARCHIVE_SCOPE_REFUSED');
  // The target guard requires the default public schema to exist and be empty.
  const dump=decoded.replace(/^CREATE SCHEMA public;\r?$/gm,'');
  const guard=`SET LOCAL search_path=pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD';
DO $guard$ BEGIN
 PERFORM pg_advisory_xact_lock(55437,8043);
 IF current_user<>'flsd_pilot_admin' OR current_user<>session_user OR current_database()<>'${recovery}'
   OR inet_server_addr() IS DISTINCT FROM '${host}'::inet OR inet_server_port() IS DISTINCT FROM ${port}
   OR pg_is_in_recovery() OR NOT EXISTS(SELECT 1 FROM pg_database d WHERE d.datname=current_database() AND d.oid=${oid}::oid
      AND shobj_description(d.oid,'pg_database')='FLSD_PILOT_BACKUP_RECOVERY_ONLY')
   OR EXISTS(SELECT 1 FROM pg_namespace n WHERE n.nspname NOT IN ('public','pg_catalog','information_schema')
      AND n.nspname !~ '^pg_')
   OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace='public'::regnamespace)
   OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace='public'::regnamespace)
   OR EXISTS(SELECT 1 FROM pg_type t WHERE t.typnamespace='public'::regnamespace)
 THEN RAISE EXCEPTION 'Recovery database identity or emptiness refused'; END IF;
END $guard$;`;
  const expected=Buffer.from(JSON.stringify(manifest.tables),'utf8').toString('hex');
  const compare=manifestSql().replace('SELECT jsonb_object_agg(name,jsonb_build_array(row_count,sha256))::text',
    'SELECT jsonb_object_agg(name,jsonb_build_array(row_count,sha256))').replace(/;$/,'');
  const reconcile=`SET LOCAL search_path=pg_catalog; SET LOCAL timezone='UTC'; SET LOCAL datestyle='ISO, YMD';
DO $compare$ BEGIN
 IF (${compare}) IS DISTINCT FROM convert_from(decode('${expected}','hex'),'UTF8')::jsonb
 THEN RAISE EXCEPTION 'Recovery row digest mismatch'; END IF;
END $compare$;
SELECT 'RESTORE_RECONCILED';`;
  const attempt=path.join(directory,'recovery-attempt-'+bundle+'.json');
  writeJson(attempt,{bundle,database:recovery,oid,sha256:manifest.sha256});
  const receipt=run('psql',['-X','-qAt','-1','-v','ON_ERROR_STOP=on',...connect('flsd_pilot_admin',recovery),'-f','-'],
    env,'RECOVERY_FAILED_OR_COMMIT_UNCERTAIN',`${guard}\n${dump}\n${reconcile}`);
  if (!receipt.split(/\r?\n/).includes('RESTORE_RECONCILED')) bail('RECOVERY_RECEIPT_MISSING');
  writeJson(path.join(directory,'recovery-verified.json'),{status:'RESTORE_RECONCILED',bundle,sourceOid:config.databaseOid,
    roleOid:config.roleOid,recoveryOid:oid,sha256:manifest.sha256,tables:tables.length,verifiedAt:new Date().toISOString()});
}
function verifyGate(directory,config) {
  const receipt=readJson(path.join(directory,'recovery-verified.json'));
  if (receipt.status!=='RESTORE_RECONCILED'||receipt.sourceOid!==config.databaseOid||receipt.roleOid!==config.roleOid||
      receipt.recoveryOid!==String(config.recoveryOid)||receipt.tables!==tables.length||!bundlePattern.test(receipt.bundle)) bail('VERIFIED_RECOVERY_REQUIRED');
  const bundle=path.join(directory,receipt.bundle);
  const manifest=readJson(path.join(bundle,'manifest.json'));
  if (manifest.protect!==true||manifest.sha256!==receipt.sha256||hashFile(path.join(bundle,'database.dump'))!==receipt.sha256) bail('VERIFIED_RECOVERY_ARCHIVE_MISMATCH');
}
async function main() {
  const [mode,argument,temporaryPassfile]=process.argv.slice(2);
  checkedPath(root,true);
  if (mode==='status') {
    const items=inventory(root);
    const latest=items.find(x=>x.status==='AVAILABLE');
    const alerts=['midnight','noon','manual'].filter(slot=>fs.existsSync(alertPath(root,slot)));
    const schedule=Object.fromEntries(['midnight','noon'].map(slot=>{
      const last=items.find(item=>item.status==='AVAILABLE'&&item.slot===slot)?.completedAt??null;
      return [slot,{last,stale:!last||Date.now()-Date.parse(last)>26*3600000}];
    }));
    const stale=!latest||Date.now()-Date.parse(latest.completedAt)>14*3600000;
    console.log(JSON.stringify({database,latest,items,alerts,stale,schedule}));
    if (alerts.length||stale||Object.values(schedule).some(slot=>slot.stale)) process.exitCode=1;
    return;
  }
  if (!['controlled','verify-recovery','gate','probe','scheduled'].includes(mode)) bail('INVALID_MODE');
  const raw=readJson(path.join(root,'pilot-config.json'));
  const config={databaseOid:identityOid(raw.databaseOid),roleOid:identityOid(raw.roleOid),recoveryOid:raw.recoveryOid};
  checkedPath(path.join(root,'pgpass.conf'));
  assertPrivateDestination();
  if (mode!=='controlled') identityOid(config.recoveryOid);
  if (mode==='gate') {verifyGate(root,config); console.log('BACKUP_RECOVERY_GATE_OK'); return;}
  if (mode==='probe') {
    if (!/^[a-f0-9]{32}$/.test(argument)) bail('INVALID_PROBE_ID');
    verifyGate(root,config);
    const env=envFor(path.join(root,'pgpass.conf'));
    const identity=JSON.parse(run('psql',['-X','-qAt','-v','ON_ERROR_STOP=on',...connect(role,database),'-c',
      'BEGIN READ ONLY; SET LOCAL search_path=pg_catalog; '+identitySql(config)+' ROLLBACK;'],env,'SCHEDULED_AUTH_PROBE_FAILED').trim());
    if (identity.verified!==true) bail('DATABASE_IDENTITY_OR_PERMISSIONS_REFUSED');
    const disk=fs.statfsSync(root,{bigint:true});
    if (disk.bavail*disk.bsize<BigInt(identity.databaseBytes)*2n+268435456n) bail('INSUFFICIENT_DISK_SPACE');
    writeJson(path.join(root,'probe-'+argument+'.json'),{status:'SCHEDULER_ACCOUNT_VERIFIED',databaseOid:config.databaseOid,roleOid:config.roleOid});
    return;
  }
  if (mode==='verify-recovery') {verifyRecovery(root,config,argument,temporaryPassfile); console.log('RESTORE_RECONCILED'); return;}
  const slot=mode==='controlled'?'controlled':argument;
  if (!['controlled','midnight','noon'].includes(slot)) bail('INVALID_SLOT');
  if (mode==='scheduled') {
    verifyGate(root,config);
    ensureScheduledPilotRunning();
  }
  const result=await backup(root,config,slot,{protect:mode==='controlled'});
  log(root,slot,result?'SUCCESS':'SLOT_ALREADY_COVERED',result?{bundle:result.bundle,sha256:result.sha256}:{});
  const alert=alertPath(root,mode==='scheduled'?slot:'manual');
  if (fs.existsSync(alert)) {checkedPath(alert);fs.unlinkSync(alert);}
  console.log(JSON.stringify(result?{status:'BACKUP_VERIFIED',bundle:result.bundle,sha256:result.sha256}:{status:'SLOT_ALREADY_COVERED',slot}));
}
function ensureScheduledPilotRunning() {
  const pilotRoot='D:\\FLSD-Batch7-Validation\\.pilot';
  const cluster=path.join(pilotRoot,'pgdata');
  const logFile=path.join(pilotRoot,'postgres.log');
  checkedPath(cluster,true);
  checkedPath(path.join(pilotRoot,'setup-complete'));
  if (fs.existsSync(logFile)) checkedPath(logFile);
  const env=envFor(path.join(root,'pgpass.conf'));
  const status=(tool,args)=>spawnSync(path.join(tools,tool+'.exe'),args,
    {env,windowsHide:true,stdio:'ignore',timeout:8000}).status;
  const ready=()=>status('pg_isready',['-q','-h',host,'-p',port,'-t','4']);
  const current=status('pg_ctl',['status','-D',cluster]);
  const listener=ready();
  if (current===0&&listener===0) return;
  if (current!==3||listener!==2) bail('PILOT_RUNTIME_STATE_MISMATCH');
  const setting=name=>run('postgres',['-D',cluster,'-C',name],env,'PILOT_CONFIGURATION_UNREADABLE',null,8000).trim();
  if (setting('port')!==port||setting('listen_addresses')!==host||
      path.resolve(setting('data_directory')).toLowerCase()!==path.resolve(cluster).toLowerCase()) bail('PILOT_CONFIGURATION_REFUSED');
  run('pg_ctl',['-D',cluster,'-l',logFile,'-w','-t','20','start'],env,'PILOT_WINDOWS_START_FAILED',null,25000);
  if (ready()!==0) bail('PILOT_STARTUP_NOT_READY');
}
if (require.main===module) main().catch(error=>{
  const code=error.backupCode??'BACKUP_CONFIGURATION_OR_IO_ERROR';
  const [mode,argument]=process.argv.slice(2);
  const slot=mode==='scheduled'&&['midnight','noon'].includes(argument)?argument:'manual';
  try {
    checkedPath(root,true);
    log(root,slot,'FAILURE',{code});
    const alert=alertPath(root,slot);
    if (!fs.existsSync(alert)) writeJson(alert,{at:new Date().toISOString(),slot,code});
  } catch { /* Scheduler still receives a nonzero result. */ }
  if (mode==='scheduled') {
    try {
      execFileSync('C:\\Windows\\System32\\eventcreate.exe',['/T','ERROR','/ID','842','/L','APPLICATION',
        '/SO','FLSD Invoicing Backup','/D',`Pilot backup ${slot}: ${code}`],{windowsHide:true,stdio:'ignore',timeout:10000});
    } catch { /* Local alert file and scheduler exit status remain available. */ }
  }
  console.error(code);
  process.exitCode=1;
});
module.exports={backup,bundlePattern,checkManifest,checkToc,dueAt,identityOid,identitySql,inventory,manifestSql,retain,sameManifest,tables,verifyRecovery};
