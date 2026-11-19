import {beforeAll,afterAll,describe,it,expect,inject} from 'vitest';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {emptyDemo} from '../../src/lib/demo/store';
import {encodeWire} from '../../src/lib/pilot/wire';
import {assertDisposableIsolation,createDisposableClient,createDisposableOperationalAdapter,validateDisposableConfig,scopedFixtureQueries} from '../../src/lib/production/disposable-postgres';
import {readInstalledIsolatedTarget,writeIsolatedFixtureIntent} from '../../src/lib/production/isolated-fixture-intent';
if(process.cwd()!=='D:\\FLSD-Batch7-Validation'||process.env.FLSD_RUN_MAIN_ADAPTER!=='SYNTHETIC_ONLY'||process.env.FLSD_MAIN_ADAPTER_SUITE!=='ISOLATED_SCHEMA')throw new Error('Explicit isolated-schema opt-in required');
const proof=JSON.parse(readFileSync('artifacts/main-adapter-creation.json','utf8'));
if(proof.proofVersion!==2||proof.createdByThisRun!==true)throw new Error('Creation provenance required');
const config=validateDisposableConfig({host:proof.host,port:proof.port,database:'flsd_main_adapter_test',user:proof.user,expectedOwner:proof.expectedOwner,runId:proof.runId,databaseOid:proof.verifiedDatabases.find((d:{name:string})=>d.name==='flsd_main_adapter_test')?.oid,ownerOid:proof.verifiedRoles.find((r:{name:string})=>r.name===proof.expectedOwner)?.oid,appOid:proof.verifiedRoles.find((r:{name:string})=>r.name===proof.user)?.oid});
const target=readInstalledIsolatedTarget(config,process.env.FLSD_MAIN_ISOLATED_RUN_ID),client=createDisposableClient(config,inject('adapterTestPassword')||undefined,target),adapter=createDisposableOperationalAdapter(client,config,target),actorId=randomUUID(),token=randomBytes(32).toString('hex');
process.stderr.write('FLSD_SAFE_PHASE:SUITE_LOADED\n');
function command(){const s=emptyDemo();return {schemaVersion:1,operationId:randomUUID(),expectedVersions:[],action:{type:'CREATE_TRIP',trip:{customerId:'c1',workflow:'DIRECT',amount:100001n,charges:{base:100001n,fuel:0n,toll:0n,parking:0n,others:0n,othersNote:''},date:'2026-11-17',itinerary:'Synthetic isolated adapter',vehicle:s.vehicles[0].label,driver:s.drivers[0].label}}};}
async function snapshot(){return client.$transaction(async raw=>{await assertDisposableIsolation(raw,config,target);const db=scopedFixtureQueries(raw,target.schema);return db.$queryRawUnsafe('SELECT (SELECT count(*)::text FROM __FLSD_SCHEMA__.operations) AS operations,(SELECT count(*)::text FROM __FLSD_SCHEMA__.audit) AS audit,(SELECT count(*)::text FROM __FLSD_SCHEMA__.history) AS history,(SELECT count(*)::text FROM __FLSD_SCHEMA__.records) AS records,(SELECT revision::text FROM __FLSD_SCHEMA__.workspace WHERE id=1) AS revision');});}
describe('Isolated per-run PostgreSQL adapter',()=>{
 beforeAll(async()=>{process.stderr.write('FLSD_SAFE_PHASE:FIXTURE_BEGIN\n');await client.$transaction(async raw=>{
  await assertDisposableIsolation(raw,config,target);const db=scopedFixtureQueries(raw,target.schema);
  const rows=await db.$queryRawUnsafe<Record<string,string>[]>(`SELECT ${['workspace','actors','sessions','records','operations','audit','history'].map(t=>'(SELECT count(*)::text FROM __FLSD_SCHEMA__.'+t+') AS '+t).join(',')}`);
  if(rows.length!==1||Object.values(rows[0]).some(v=>v!=='0'))throw new Error('FLSD_FIXTURE_PARTIAL_OR_PROGRESSED');
  const payload=encodeWire(emptyDemo()),sessionHash=createHash('sha256').update(token).digest('hex');
  writeIsolatedFixtureIntent(config,target,actorId,sessionHash,payload);
  await db.$executeRawUnsafe('INSERT INTO __FLSD_SCHEMA__.workspace(id,payload) VALUES(1,$1::jsonb)',payload);
  await db.$executeRawUnsafe("INSERT INTO __FLSD_SCHEMA__.actors(id,role,active) VALUES($1::uuid,'BILLING',true)",actorId);
  await db.$executeRawUnsafe("INSERT INTO __FLSD_SCHEMA__.sessions(token_hash,actor_id,expires_at) VALUES($1,$2::uuid,now()+interval '1 hour')",sessionHash,actorId);
 },{isolationLevel:'Serializable',timeout:30000});process.stderr.write('FLSD_SAFE_PHASE:FIXTURE_READY\n');});
 afterAll(async()=>{await client.$disconnect();});
 it('uses only the per-run search path and has no legacy schema access',async()=>{
  await client.$transaction(async db=>{await assertDisposableIsolation(db,config,target);const rows=await db.$queryRawUnsafe<{path:string;usage:boolean;ddl:boolean}[]>("SELECT current_setting('search_path') AS path,has_schema_privilege(current_user,'flsd_adapter_test','USAGE') AS usage,has_schema_privilege(current_user,'flsd_adapter_test','CREATE') AS ddl");expect(rows[0]).toEqual({path:'pg_catalog, '+target.schema,usage:false,ddl:false});});
 });
 it('uses a nonprivileged application role without DDL or history overwrite rights',async()=>{
  const rows=await client.$transaction(async raw=>{await assertDisposableIsolation(raw,config,target);const db=scopedFixtureQueries(raw,target.schema);return db.$queryRawUnsafe<{schema_create:boolean;history_update:boolean}[]>("SELECT has_schema_privilege(current_user,'__FLSD_SCHEMA__','CREATE') AS schema_create,has_table_privilege(current_user,'__FLSD_SCHEMA__.history','UPDATE') AS history_update");});
  expect(rows[0]).toEqual({schema_create:false,history_update:false});
 });
 it.each([1,2,3,4,5] as const)('rolls back injected write failure at stage %s',async stage=>{const before=await snapshot();await expect(adapter.execute(command(),token,{stage})).rejects.toThrow(`Synthetic injected failure at stage ${stage}`);expect(await snapshot()).toEqual(before);});
 it('persists exact decimals and replays duplicate concurrent requests once',async()=>{
  const c=command(),results=await Promise.all([adapter.execute(c,token),adapter.execute(c,token)]);expect(results.filter(r=>r.replayed)).toHaveLength(1);expect(results[0].result).toEqual(results[1].result);
  const rows=await client.$transaction(async raw=>{await assertDisposableIsolation(raw,config,target);const db=scopedFixtureQueries(raw,target.schema);return db.$queryRawUnsafe<{amount:string}[]>('SELECT amount::text FROM __FLSD_SCHEMA__.records WHERE id=$1',results[0].result!.entityId);});expect(rows[0].amount).toBe('1000.01');
 });
 it('rejects invalid sessions without writes',async()=>{const before=await snapshot();await expect(adapter.execute(command(),'x'.repeat(64))).rejects.toThrow();expect(await snapshot()).toEqual(before);});
 it('requires atomic audit/history in the installed schema',async()=>{
  const before=await snapshot();
  await expect(client.$transaction(async raw=>{await assertDisposableIsolation(raw,config,target);const db=scopedFixtureQueries(raw,target.schema);await db.$executeRawUnsafe("INSERT INTO __FLSD_SCHEMA__.operations(operation_id,actor_id,digest,receipt) VALUES($1::uuid,$2::uuid,$3,'{}'::jsonb)",randomUUID(),actorId,'0'.repeat(64));})).rejects.toThrow();
  expect(await snapshot()).toEqual(before);
 });
 it('rejects stored history mutation',async()=>{
  const before=await snapshot();
  await expect(client.$transaction(async raw=>{await assertDisposableIsolation(raw,config,target);const db=scopedFixtureQueries(raw,target.schema);await db.$executeRawUnsafe("UPDATE __FLSD_SCHEMA__.operations SET digest=$1",'1'.repeat(64));})).rejects.toThrow();expect(await snapshot()).toEqual(before);
 });
 it('rejects revoked permission before replay',async()=>{
  const c=command();await adapter.execute(c,token);
  await client.$transaction(async raw=>{await assertDisposableIsolation(raw,config,target);const db=scopedFixtureQueries(raw,target.schema);await db.$executeRawUnsafe("UPDATE __FLSD_SCHEMA__.actors SET role='VIEWER' WHERE id=$1::uuid",actorId);});
  const before=await snapshot();await expect(adapter.execute(c,token)).rejects.toThrow();expect(await snapshot()).toEqual(before);
 });
});
