import {describe,it,expect,vi} from 'vitest';
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {schemaSql,validateIsolatedTarget} from './isolated-schema-target';
import {assertDisposableIsolation,validateDisposableConfig,scopedFixtureQueries,createDisposableOperationalAdapter} from './disposable-postgres';
import {emptyDemo} from '../demo/store';
import {encodeWire} from '../pilot/wire';
const {buildPlan}=createRequire(import.meta.url)('../../../scripts/lib/main-isolated-schema-plan.cjs');
const config=validateDisposableConfig({host:'127.0.0.1',port:5432,database:'flsd_main_adapter_test',user:'flsd_test_app_b813e7439f4c',expectedOwner:'flsd_test_owner_b813e7439f4c',runId:'b813e743-9f4c-4121-b8ab-b01ca51b9335',databaseOid:'16394',ownerOid:'16392',appOid:'16393'});
const runId='32f9216c-e7d4-4e78-80b3-cfb7f58e04eb';
const target={runId,parentRunId:config.runId,schema:'flsd_iso_'+runId.replaceAll('-',''),appRole:'flsd_iso_app_'+runId.replaceAll('-',''),schemaOid:'50001',appOid:'50002'};
const proof={proofVersion:2,createdByThisRun:true,host:config.host,port:config.port,runId:config.runId,expectedOwner:config.expectedOwner,user:config.user,adminUser:'postgres',verifiedDatabases:[{name:config.database,oid:config.databaseOid}],migrationSha256:'0B73853CB8A5D82651785FF35C9C9F9DC898205429C3AAE50708A1A7E8426FDC'};
const source=readFileSync('prisma/disposable-main-adapter.sql','utf8');
// Generator input comes from the existing PS guard in actual preparation.
const guard="DO $guard$ BEGIN IF current_database()<>'flsd_main_adapter_test' THEN RAISE EXCEPTION 'wrong'; END IF; IF false AND false THEN RAISE EXCEPTION 'pristine'; END IF; END $guard$;";
function fake(change:Record<string,unknown>={}){
 const queries:string[]=[],writes:string[]=[];
 const raw={
  $queryRawUnsafe:vi.fn(async(sql:string)=>{queries.push(sql);
   if(sql.includes('FROM pg_database'))return [{database:config.database,host:config.host,port:config.port,owner:config.expectedOwner,actor:target.appRole,marker:`FLSD_DISPOSABLE:${config.runId}:${config.database}`,superuser:false,createdb:false,createrole:false,bypassrls:false,replication:false,inherit:false,any_membership:false,owner_member:false,database_oid:config.databaseOid,owner_oid:config.ownerOid,app_oid:target.appOid,canlogin:true,app_marker:`FLSD_ISOLATED_APP:${config.runId}:${runId}`,...change}];
   if(sql.includes('FROM pg_namespace'))return [{oid:target.schemaOid,owner:config.ownerOid,marker:`FLSD_ISOLATED:${config.runId}:${runId}:${target.schema}`,legacy_usage:false,legacy_create:false,schema_create:false,path:'pg_catalog, '+target.schema,...change}];
   if(sql.includes('.meta'))return [{run_id:runId,marker:'FLSD_SYNTHETIC_ADAPTER_V1'}];
   if(sql.includes('set_config'))return [];
   if(sql.includes('JOIN')&&sql.includes('.sessions')){
    if(!sql.endsWith('FOR SHARE OF a'))throw new Error('Restricted role can lock only the actor');
    return [{id:'8c5d26c2-7d5c-422a-8032-7d48d6382a9c',role:'BILLING'}];
   }
   if(sql.includes('SELECT payload,revision'))return [{payload:JSON.parse(encodeWire(emptyDemo())),revision:'0'}];
   return [];
  }),$executeRawUnsafe:vi.fn(async(sql:string)=>{writes.push(sql);return 1;})
 };
 return {raw,queries,writes};
}
describe('Per-run schema preparation and adapter isolation',()=>{
 it('generates atomic collision-guarded SQL and a read-only preflight without legacy DDL',()=>{
  const p=buildPlan(proof,runId,source,guard);expect(p.status).toBe('PREPARED_OFFLINE_NOT_EXECUTED');expect(p.schema).toBe(target.schema);
  expect(p.sql.indexOf('BEGIN;')).toBeLessThan(p.sql.indexOf('CREATE ROLE'));expect(p.sql.indexOf('CREATE ROLE')).toBeLessThan(p.sql.indexOf('CREATE SCHEMA'));expect(p.sql).toContain('COMMIT;');
  expect(p.sql).toContain('pg_advisory_xact_lock');expect(p.sql).toContain('already exists; no reuse or overwrite');expect(p.sql).toContain('PASSWORD NULL');expect(p.sql).toContain('NOINHERIT');
  expect(p.sql).not.toMatch(/(?:CREATE|ALTER|DROP|TRUNCATE|INSERT INTO|UPDATE|DELETE FROM)\s+(?:SCHEMA\s+)?flsd_adapter_test\b/i);
  expect(p.sql).not.toContain('flsd_main_restore_test');expect(p.sql).not.toContain('55432');expect(p.sql).not.toMatch(/CREATE\s+(?:SCHEMA|TABLE|ROLE)\s+IF NOT EXISTS|DROP\s+(?:SCHEMA|ROLE)|^\s*TRUNCATE\b/im);
  expect(p.preflight).toContain('BEGIN READ ONLY');expect(p.preflight).toContain('ROLLBACK');expect(p.preflight).not.toContain('CREATE ROLE');
 });
 it('retains scoped immutable history and deferred atomicity constraints',()=>{
  const p=buildPlan(proof,runId,source,guard);expect(p.sql).toContain('DEFERRABLE INITIALLY DEFERRED');expect(p.sql).toContain('CREATE TRIGGER immutable_history');expect(p.sql).toContain('Cross-schema write capability refused');expect(p.sql).toContain('External security-definer capability refused');
  expect(p.sql).toContain(`GRANT UPDATE ON ${target.schema}.actors,${target.schema}.workspace,${target.schema}.records TO ${target.appRole}`);
 });
 it('checks effective column grants on all external relations before commit',()=>{
  const {sql}=buildPlan(proof,runId,source,guard);
  const start=sql.indexOf('DO $privileges$');
  const commit=sql.indexOf('COMMIT;');
  expect(start).toBeGreaterThan(sql.indexOf('RESET ROLE;'));
  expect(commit).toBeGreaterThan(start);
  const checks=sql.slice(start,commit);
  expect(checks).toMatch(/FROM pg_class c WHERE c\.relnamespace<>isolated_oid AND\s+CASE/);
  expect(checks).toContain("WHEN c.relkind IN('r','p','v','m','f') THEN");
  expect(checks).toMatch(/has_table_privilege\(app_oid,c\.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN'\)\s+OR has_any_column_privilege\(app_oid,c\.oid,'INSERT,UPDATE,REFERENCES'\)/);
  expect(checks).not.toContain('nspname NOT LIKE');
  expect(checks).toContain("WHEN c.relkind='S' THEN has_sequence_privilege(app_oid,c.oid,'USAGE,UPDATE')");
  expect(checks).toContain("has_schema_privilege(app_oid,n.oid,'CREATE')");
  expect(checks).toContain("has_database_privilege(app_oid,current_database(),'CREATE,TEMPORARY')");
  expect(checks).toContain("has_largeobject_privilege(app_oid,l.oid,'UPDATE')");
  expect(checks).toContain("has_function_privilege(app_oid,p.oid,'EXECUTE')");
 });
 it('allows only relation-level UPDATE on the built-in session-settings view',()=>{
  const {sql}=buildPlan(proof,runId,source,guard);
  expect(sql).toContain("settings_view_oid oid := 'pg_catalog.pg_settings'::regclass;");
  const branch=sql.match(/WHEN c\.oid=settings_view_oid AND c\.relkind='v' THEN([\s\S]*?)WHEN c\.relkind IN/);
  expect(branch).not.toBeNull();
  expect(branch?.[1]).toContain("has_table_privilege(app_oid,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')");
  expect(branch?.[1]).toContain("has_any_column_privilege(app_oid,c.oid,'INSERT,REFERENCES')");
  expect(branch?.[1]).toContain('col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped');
  expect(branch?.[1]).toContain("a.grantee IN (0,app_oid) AND a.privilege_type='UPDATE'");
 });
 it('checks schema and object ownership and limits grants inherited from owner defaults',()=>{
  const {sql}=buildPlan(proof,runId,source,guard);
  expect(sql).toContain(`SET LOCAL ROLE ${proof.expectedOwner};`);
  expect(sql).toContain(`IN DATABASE flsd_main_adapter_test SET search_path TO pg_catalog,${target.schema};`);
  expect(sql).toContain(`REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${target.schema} FROM PUBLIC;`);
  expect(sql).toContain('n.nspowner<>owner_oid');
  expect(sql).toContain('c.relowner<>owner_oid');
  expect(sql).toContain('p.proowner<>owner_oid');
  expect(sql).toContain('aclexplode(n.nspacl)');
  expect(sql).toContain('aclexplode(c.relacl)');
  expect(sql).toContain("aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner)))");
  expect(sql).toContain('a.is_grantable');
  expect(sql).not.toMatch(/ALTER DEFAULT PRIVILEGES|REVOKE[^\n]+(?:DATABASE|SCHEMA public|SCHEMA flsd_adapter_test)/);
 });
 it('versions the hardened plan and binds both SQL payloads to their SHA-256 hashes',()=>{
  const plan=buildPlan(proof,runId,source,guard);
  expect(plan.version).toBe(3);
  const hash=(payload:string)=>createHash('sha256').update(payload).digest('hex').toUpperCase();
  expect(plan.sqlSha256).toBe(hash(plan.sql));
  expect(plan.preflightSha256).toBe(hash(plan.preflight));
  expect(plan.preflight).not.toContain('DO $privileges$');
 });
 it('refuses a changed migration or wrong parent server',()=>{
  expect(()=>buildPlan(proof,runId,source+'\n',guard)).toThrow();expect(()=>buildPlan({...proof,port:55432},runId,source,guard)).toThrow();expect(()=>buildPlan(proof,proof.runId,source,guard)).toThrow();
 });
 it.each([{schema:'flsd_adapter_test'},{parentRunId:runId},{appRole:config.user},{schemaOid:'0'},{appOid:'4294967296'},{extra:'x'}])('rejects target drift %j',change=>{expect(()=>validateIsolatedTarget({...target,...change},config)).toThrow();});
 it('refuses restore configuration entirely',()=>{expect(()=>validateIsolatedTarget(target,{...config,database:'flsd_main_restore_test'})).toThrow();});
 it.each(['INSERT INTO flsd_adapter_test.records VALUES(1)','UPDATE public.records SET x=1','INSERT INTO attacker.records VALUES(1)','SELECT * FROM "flsd_adapter_test".meta','SET search_path=public','SELECT * FROM __FLSD_SCHEMA__.meta; DELETE FROM public.x','SELECT * FROM flsd_iso_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.meta'])('rejects cross-schema SQL before dispatch: %s',sql=>{
  const execute=vi.fn(),query=vi.fn();const db=scopedFixtureQueries({$executeRawUnsafe:execute,$queryRawUnsafe:query},target.schema);
  expect(()=>db.$executeRawUnsafe(sql)).toThrow();expect(execute).not.toHaveBeenCalled();expect(query).not.toHaveBeenCalled();
 });
 it('preserves parameter values and supports the existing records upsert',async()=>{
  const f=fake(),db=scopedFixtureQueries(f.raw as unknown as Parameters<typeof scopedFixtureQueries>[0],target.schema);
  await db.$executeRawUnsafe('INSERT INTO __FLSD_SCHEMA__.records(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET id=excluded.id','flsd_adapter_test.private');
  expect(f.raw.$executeRawUnsafe).toHaveBeenCalledWith(`INSERT INTO ${target.schema}.records(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET id=excluded.id`,'flsd_adapter_test.private');
 });
 it('allows privilege inspection string literals while rejecting DDL after a literal',()=>{
  expect(schemaSql(target.schema,"SELECT has_schema_privilege(current_user,'__FLSD_SCHEMA__','CREATE')")).toContain("'CREATE'");
  expect(()=>schemaSql(target.schema,"SELECT '__FLSD_SCHEMA__'; CREATE SCHEMA bad")).toThrow();
 });
 it('verifies database then transaction-local path/schema OID and run marker before data use',async()=>{
  const f=fake();await assertDisposableIsolation(f.raw as unknown as Parameters<typeof assertDisposableIsolation>[0],config,target);expect(f.writes).toEqual([]);expect(f.queries[0]).toContain('FROM pg_database');expect(f.queries[1]).toContain('set_config');expect(f.queries.at(-1)).toContain(target.schema+'.meta');
 });
 it.each([{actor:config.user},{app_oid:config.appOid},{canlogin:false},{app_marker:'wrong'},{legacy_usage:true},{schema_create:true},{oid:'50099'},{path:'public'},{marker:'wrong'}])('fails identity/permissions before synthetic writes %j',async change=>{
  const f=fake(change);await expect(assertDisposableIsolation(f.raw as unknown as Parameters<typeof assertDisposableIsolation>[0],config,target)).rejects.toThrow();expect(f.writes).toEqual([]);
 });
 it('runs shared adapter logic with every persistence write restricted to the selected schema',async()=>{
  const f=fake(),client={$transaction:async(fn:(db:typeof f.raw)=>Promise<unknown>)=>fn(f.raw)};
  const adapter=createDisposableOperationalAdapter(client as unknown as Parameters<typeof createDisposableOperationalAdapter>[0],config,target),s=emptyDemo();
  const command={schemaVersion:1,operationId:'ee7e5975-15cb-4eea-b67e-669f1ec32092',expectedVersions:[],action:{type:'CREATE_TRIP',trip:{customerId:'c1',workflow:'DIRECT',amount:100001n,charges:{base:100001n,fuel:0n,toll:0n,parking:0n,others:0n,othersNote:''},date:'2026-11-17',itinerary:'Synthetic',vehicle:s.vehicles[0].label,driver:s.drivers[0].label}}};
  const result=await adapter.execute(command,'x'.repeat(64));
  expect(result.replayed).toBe(false);expect(f.writes.length).toBeGreaterThan(0);for(const sql of f.writes){expect(sql).toContain(target.schema+'.');expect(sql).not.toContain('flsd_adapter_test');}
  f.writes.length=0;
  await expect(adapter.execute(command,'x'.repeat(64),{stage:2})).rejects.toThrow('Synthetic injected failure at stage 2');
  expect(f.writes).toHaveLength(1);
  expect(f.writes[0]).toContain(target.schema+'.records');
 });
});
