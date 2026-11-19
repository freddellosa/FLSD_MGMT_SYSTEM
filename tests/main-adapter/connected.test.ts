import {beforeAll,afterAll,describe,it,expect,inject} from 'vitest';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {emptyDemo} from '../../src/lib/demo/store';
import {encodeWire} from '../../src/lib/pilot/wire';
import {assertDisposableIsolation,createDisposableClient,createDisposableOperationalAdapter,validateDisposableConfig} from '../../src/lib/production/disposable-postgres';
import {assertEmptyFixture,assertResumableFixture,inspectFixture,newFixtureIntent,readFixtureIntent,writeFixtureIntent,writeResumeAttempt} from '../../src/lib/production/fixture-resume';

// This separate suite NEVER runs from npm test. No credentials or generic DATABASE_URL.
if(process.env.FLSD_RUN_MAIN_ADAPTER!=='SYNTHETIC_ONLY')throw new Error('Explicit isolated-suite opt-in required');
const receipt=JSON.parse(readFileSync('artifacts/main-adapter-creation.json','utf8'));
if(receipt.proofVersion!==2||receipt.createdByThisRun!==true||JSON.stringify(receipt.databases)!==JSON.stringify(['flsd_main_adapter_test','flsd_main_restore_test']))throw new Error('Creation provenance required');
const config=validateDisposableConfig({host:receipt.host,port:receipt.port,database:'flsd_main_adapter_test',user:receipt.user,expectedOwner:receipt.expectedOwner,runId:receipt.runId,databaseOid:receipt.verifiedDatabases.find((d:{name:string})=>d.name==='flsd_main_adapter_test')?.oid,ownerOid:receipt.verifiedRoles.find((r:{name:string})=>r.name===receipt.expectedOwner)?.oid,appOid:receipt.verifiedRoles.find((r:{name:string})=>r.name===receipt.user)?.oid});
const client=createDisposableClient(config,inject('adapterTestPassword')||undefined),adapter=createDisposableOperationalAdapter(client,config),token=randomBytes(32).toString('hex');
const actorId=randomUUID();
const fixtureMode=process.env.FLSD_MAIN_ADAPTER_FIXTURE_MODE;
if(fixtureMode!==undefined&&fixtureMode!=='RESUME_PRISTINE')throw new Error('FLSD_FIXTURE_IDENTITY_MISMATCH');
process.stderr.write('FLSD_SAFE_PHASE:SUITE_LOADED\n');
function command(){const s=emptyDemo();return {schemaVersion:1,operationId:randomUUID(),expectedVersions:[],action:{type:'CREATE_TRIP',trip:{customerId:'c1',workflow:'DIRECT',amount:100001n,charges:{base:100001n,fuel:0n,toll:0n,parking:0n,others:0n,othersNote:''},date:'2026-11-17',itinerary:'Synthetic connected adapter',vehicle:s.vehicles[0].label,driver:s.drivers[0].label}}};}
async function snapshot(){return client.$transaction(async db=>{await assertDisposableIsolation(db,config);return db.$queryRawUnsafe('SELECT (SELECT count(*)::text FROM flsd_adapter_test.operations) AS operations,(SELECT count(*)::text FROM flsd_adapter_test.audit) AS audit,(SELECT count(*)::text FROM flsd_adapter_test.history) AS history,(SELECT count(*)::text FROM flsd_adapter_test.records) AS records,(SELECT revision::text FROM flsd_adapter_test.workspace WHERE id=1) AS revision');});}
describe('Newly created isolated PostgreSQL adapter',()=>{
 beforeAll(async()=>{process.stderr.write('FLSD_SAFE_PHASE:FIXTURE_BEGIN\n');
  // Missing intent fails before connection/writes; never mint provenance for legacy rows.
  const prior=fixtureMode==='RESUME_PRISTINE'?readFixtureIntent(config):undefined;
  await client.$transaction(async db=>{
  await assertDisposableIsolation(db,config);
  await db.$queryRawUnsafe('SELECT pg_advisory_xact_lock(176660,1)::text');
  await db.$queryRawUnsafe('SELECT id FROM flsd_adapter_test.workspace FOR UPDATE');
  await db.$queryRawUnsafe('SELECT id FROM flsd_adapter_test.actors FOR SHARE');
  await db.$queryRawUnsafe('SELECT token_hash FROM flsd_adapter_test.sessions FOR SHARE');
  const snapshot=await inspectFixture(db),sessionHash=createHash('sha256').update(token).digest('hex'),expiresAt=new Date(Date.now()+3600000).toISOString();
  if(prior){
   assertResumableFixture(config,prior,snapshot);
   writeResumeAttempt(prior,actorId,sessionHash,expiresAt);
  }else{
   assertEmptyFixture(snapshot);
   writeFixtureIntent(newFixtureIntent(config,actorId,sessionHash,expiresAt));
   await db.$executeRawUnsafe('INSERT INTO flsd_adapter_test.workspace(id,payload) VALUES(1,$1::jsonb)',encodeWire(emptyDemo()));
  }
  // Each run gets its own actor; the revocation test cannot alter a prior actor.
  await db.$executeRawUnsafe("INSERT INTO flsd_adapter_test.actors(id,role,active) VALUES($1::uuid,'BILLING',true)",actorId);
  // Never recover, extend or overwrite previous sessions; insert a new synthetic one.
  await db.$executeRawUnsafe('INSERT INTO flsd_adapter_test.sessions(token_hash,actor_id,expires_at) VALUES($1,$2::uuid,$3::timestamptz)',sessionHash,actorId,expiresAt);
 },{isolationLevel:'Serializable',timeout:30000});process.stderr.write('FLSD_SAFE_PHASE:FIXTURE_READY\n');});
 afterAll(async()=>{await client.$disconnect();});
 it('uses a nonprivileged application role without DDL or history overwrite rights',async()=>{
  const rows=await client.$transaction(async db=>{await assertDisposableIsolation(db,config);return db.$queryRawUnsafe<{schema_create:boolean;history_update:boolean}[]>("SELECT has_schema_privilege(current_user,'flsd_adapter_test','CREATE') AS schema_create,has_table_privilege(current_user,'flsd_adapter_test.history','UPDATE') AS history_update");});
  expect(rows[0]).toEqual({schema_create:false,history_update:false});
 });
 it.each([1,2,3,4,5] as const)('rolls back injected write failure at stage %s',async stage=>{const before=await snapshot();await expect(adapter.execute(command(),token,{stage})).rejects.toThrow();expect(await snapshot()).toEqual(before);});
 it('persists exact decimals and replays duplicate concurrent requests once',async()=>{
  const c=command(),results=await Promise.all([adapter.execute(c,token),adapter.execute(c,token)]);expect(results.filter(r=>r.replayed)).toHaveLength(1);expect(results[0].result).toEqual(results[1].result);
  const rows=await client.$transaction(async db=>{await assertDisposableIsolation(db,config);return db.$queryRawUnsafe<{amount:string}[]>('SELECT amount::text FROM flsd_adapter_test.records WHERE id=$1',results[0].result!.entityId);});expect(rows[0].amount).toBe('1000.01');
 });
 it('rejects invalid sessions without writes',async()=>{const before=await snapshot();await expect(adapter.execute(command(),'x'.repeat(64))).rejects.toThrow();expect(await snapshot()).toEqual(before);});
 it('requires atomic audit/history in the installed schema',async()=>{
  const before=await snapshot();
  await expect(client.$transaction(async db=>{await assertDisposableIsolation(db,config);await db.$executeRawUnsafe("INSERT INTO flsd_adapter_test.operations(operation_id,actor_id,digest,receipt) VALUES($1::uuid,$2::uuid,$3,'{}'::jsonb)",randomUUID(),actorId,'0'.repeat(64));})).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
 });
 it('rejects stored history mutation',async()=>{
  const before=await snapshot();
  await expect(client.$transaction(async db=>{await assertDisposableIsolation(db,config);await db.$executeRawUnsafe("UPDATE flsd_adapter_test.operations SET digest=$1",'1'.repeat(64));})).rejects.toThrow();expect(await snapshot()).toEqual(before);
 });
 it('rejects revoked permission before replay',async()=>{
  const c=command();await adapter.execute(c,token);
  await client.$transaction(async db=>{await assertDisposableIsolation(db,config);await db.$executeRawUnsafe("UPDATE flsd_adapter_test.actors SET role='VIEWER' WHERE id=$1::uuid",actorId);});
  const before=await snapshot();await expect(adapter.execute(c,token)).rejects.toThrow();expect(await snapshot()).toEqual(before);
 });
});
