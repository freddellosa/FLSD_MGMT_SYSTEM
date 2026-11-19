// MANUAL opt-in only. No test collection, fixtures, inserts, updates, migrations or resets.
const fs=require('node:fs'),path=require('node:path'),ts=require('typescript');
const {category}=require('./lib/main-adapter-diagnostics.cjs');
const {reviewFixture}=require('./lib/main-fixture-review.cjs');
const phase=value=>process.stdout.write('FLSD_SAFE_PHASE:'+value+'\n');
(async()=>{let client,prior=require.extensions['.ts'];try{
 if(process.cwd()!=='D:\\FLSD-Batch7-Validation'||process.env.FLSD_RUN_MAIN_ADAPTER!=='READ_ONLY_DIAGNOSTIC')throw new Error('Creation provenance');
 phase('DIAGNOSTIC_INPUT');const chunks=[];let bytes=0;
 for await(const chunk of process.stdin){bytes+=chunk.length;if(bytes>16384)throw new Error('FLSD_SAFE_CREDENTIAL_INPUT');chunks.push(chunk);}
 let input;try{input=JSON.parse(Buffer.concat(chunks).toString('utf8').replace(/^\ufeff/,''));}catch{throw new Error('FLSD_SAFE_CREDENTIAL_INPUT');}
 if(!input||Object.keys(input).join(',')!=='testPassword'||typeof input.testPassword!=='string'||!input.testPassword.length||input.testPassword.length>1024)throw new Error('FLSD_SAFE_CREDENTIAL_INPUT');
 phase('DIAGNOSTIC_CONFIG');const root=process.cwd(),lib=fs.realpathSync(path.join(root,'src','lib'));
 require.extensions['.ts']=(module,filename)=>{const relative=path.relative(lib,fs.realpathSync(filename));if(relative.startsWith('..')||path.isAbsolute(relative))throw new Error('Creation provenance');module._compile(ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true}}).outputText,filename);};
 const {createDisposableClient,validateDisposableConfig,assertDisposableIsolation}=require('../src/lib/production/disposable-postgres.ts');
 const {readFixtureIntent,inspectFixture,assertResumableFixture}=require('../src/lib/production/fixture-resume.ts');
 const proof=JSON.parse(fs.readFileSync('artifacts/main-adapter-creation.json','utf8'));
 if(proof.proofVersion!==2||proof.createdByThisRun!==true)throw new Error('Creation provenance');
 const config=validateDisposableConfig({host:proof.host,port:proof.port,database:'flsd_main_adapter_test',user:proof.user,expectedOwner:proof.expectedOwner,runId:proof.runId,databaseOid:proof.verifiedDatabases.find(d=>d.name==='flsd_main_adapter_test')?.oid,ownerOid:proof.verifiedRoles.find(r=>r.name===proof.expectedOwner)?.oid,appOid:proof.verifiedRoles.find(r=>r.name===proof.user)?.oid});
 client=createDisposableClient(config,input.testPassword);input=null;phase('DIAGNOSTIC_CONNECT');
 await client.$transaction(async db=>{
  await db.$executeRawUnsafe('SET TRANSACTION READ ONLY');
  phase('DIAGNOSTIC_ISOLATION');await assertDisposableIsolation(db,config);
  phase('DIAGNOSTIC_PERMISSIONS');
  const privileges=await db.$queryRawUnsafe("SELECT current_setting('transaction_read_only') AS read_only,has_schema_privilege(current_user,'flsd_adapter_test','USAGE') AS usage,has_schema_privilege(current_user,'flsd_adapter_test','CREATE') AS ddl,has_table_privilege(current_user,'flsd_adapter_test.workspace','INSERT') AS workspace_insert,has_table_privilege(current_user,'flsd_adapter_test.workspace','UPDATE') AS workspace_update,has_table_privilege(current_user,'flsd_adapter_test.operations','INSERT') AS operation_insert,has_table_privilege(current_user,'flsd_adapter_test.history','UPDATE') AS history_update");
  const p=privileges[0];if(p?.read_only!=='on'||p.usage!==true||p.ddl!==false||p.workspace_insert!==true||p.workspace_update!==true||p.operation_insert!==true||p.history_update!==false)throw new Error('permission denied');
  phase('DIAGNOSTIC_STATE');
  const rows=await db.$queryRawUnsafe(`SELECT
   (SELECT count(*)::text FROM flsd_adapter_test.workspace) AS workspace,
   (SELECT count(*)::text FROM flsd_adapter_test.actors) AS actors,
   (SELECT count(*)::text FROM flsd_adapter_test.sessions) AS sessions,
   (SELECT count(*)::text FROM flsd_adapter_test.operations) AS operations,
   (SELECT count(*)::text FROM flsd_adapter_test.audit) AS audit,
   (SELECT count(*)::text FROM flsd_adapter_test.history) AS history,
   (SELECT count(*)::text FROM flsd_adapter_test.records) AS records,
   (SELECT revision::text FROM flsd_adapter_test.workspace WHERE id=1) AS revision,
   (SELECT count(*)::text FROM flsd_adapter_test.sessions WHERE expires_at<=now()) AS expired_sessions,
   (SELECT count(*)::text FROM flsd_adapter_test.actors WHERE role='VIEWER') AS viewer_actors,
   (SELECT count(*)::text FROM flsd_adapter_test.actors WHERE role='BILLING' AND active) AS billing_actors,
   (SELECT count(*)::text FROM flsd_adapter_test.operations o
    LEFT JOIN flsd_adapter_test.audit a ON a.operation_id=o.operation_id AND a.actor_id=o.actor_id
    LEFT JOIN flsd_adapter_test.history h ON h.operation_id=o.operation_id
    WHERE a.operation_id IS NULL OR h.operation_id IS NULL) AS orphan_links,
   EXISTS(SELECT 1 FROM flsd_adapter_test.history h JOIN flsd_adapter_test.workspace w ON w.id=1 AND w.payload=h.payload) AS history_matches_workspace`);
  const review=reviewFixture(rows[0]);if(!review)throw new Error('Disposable schema provenance mismatch');
  process.stdout.write('FLSD_SAFE_STATE:'+review.state+'\n');
  process.stdout.write('FLSD_SAFE_FIXTURE:'+JSON.stringify(rows[0])+'\n');
  if(process.env.FLSD_MAIN_ADAPTER_CHECK_RESUME==='1'){
   const intent=readFixtureIntent(config);
   assertResumableFixture(config,intent,await inspectFixture(db));
   process.stdout.write('FLSD_SAFE_RESUME:IDENTITY_VERIFIED_PRISTINE\n');
  }
 },{isolationLevel:'RepeatableRead',timeout:30000});
 phase('DIAGNOSTIC_COMPLETE');process.stdout.write('FLSD_SAFE_CATEGORY:SUCCESS\n');
}catch(error){
 const codes=[error?.code,error?.meta?.code].filter(v=>typeof v==='string').join(' ');
 const message=typeof error?.message==='string'?error.message:'';
 process.stdout.write('FLSD_SAFE_CATEGORY:'+category(codes+' '+message)+'\n');process.exitCode=1;
}finally{if(client)try{await client.$disconnect();}catch{};if(prior)require.extensions['.ts']=prior;else delete require.extensions['.ts'];}})();
