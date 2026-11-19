/** Connected candidate for the two explicitly authorized synthetic databases only.
 * No production credentials/config, connection discovery, schema creation or posting.
 */
import {createHash} from 'node:crypto';
import {PrismaClient, type Prisma} from '@prisma/client';
import {executeDemo, type DemoState} from '../demo/store';
import {encodeWire, decodeWire} from '../pilot/wire';
import {validateOperationalEnvelope, reviewOperationalReplay, type OperationalReviewReceipt, type ExpectedOperationalVersion, type OperationalReviewActor} from './operational-envelope';
import {fromCentavos} from '../domain/billing';
import {schemaSql,validateIsolatedTarget,type IsolatedSchemaTarget} from './isolated-schema-target';

export const disposableDatabaseNames = ['flsd_main_adapter_test', 'flsd_main_restore_test'] as const;
export type DisposableConfig = {host:'127.0.0.1';port:5432;database:typeof disposableDatabaseNames[number];user:string;expectedOwner:string;runId:string;databaseOid:string;ownerOid:string;appOid:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function validateDisposableConfig(value:unknown):DisposableConfig {
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid disposable configuration');
 const c=value as Record<string,unknown>;
 if(Object.keys(c).sort().join(',')!==['host','port','database','user','expectedOwner','runId','databaseOid','ownerOid','appOid'].sort().join(',') || c.host!=='127.0.0.1'||c.port!==5432||!disposableDatabaseNames.includes(c.database as DisposableConfig['database'])||typeof c.runId!=='string'||!uuid.test(c.runId)||[c.databaseOid,c.ownerOid,c.appOid].some(v=>typeof v!=='string'||! /^[1-9]\d{0,9}$/.test(v)||BigInt(v)>4294967295n))throw new Error('Only explicitly owned disposable databases are allowed');
 const suffix=c.runId.replaceAll('-','').slice(0,12);
 if(c.user!==`flsd_test_app_${suffix}`||c.expectedOwner!==`flsd_test_owner_${suffix}`)throw new Error('Dedicated application and NOLOGIN owner roles required');
 return structuredClone(c) as DisposableConfig;
}
/** Explicit local test configuration; optional credential stays in process memory.
 * Never reads .env, .pgpass or pilot configuration, and never logs the URL.
 */
export function createDisposableClient(config:DisposableConfig, transientTestPassword?:string, isolated?:IsolatedSchemaTarget) {
 const c=validateDisposableConfig(config);
 const target=isolated?validateIsolatedTarget(isolated,c):undefined;
 if(transientTestPassword!==undefined&&(typeof transientTestPassword!=='string'||!transientTestPassword.length||transientTestPassword.length>1024))throw new Error('Invalid transient test credential');
 const user=target?.appRole??c.user, schema=target?.schema??'flsd_adapter_test';
 const auth=transientTestPassword===undefined?user:user+':'+encodeURIComponent(transientTestPassword);
 return new PrismaClient({datasources:{db:{url:`postgresql://${auth}@127.0.0.1:5432/${c.database}?schema=${schema}&connection_limit=5`}},log:[]});
}
type Query = Pick<Prisma.TransactionClient,'$queryRawUnsafe'|'$executeRawUnsafe'>;
export async function assertDisposableIsolation(db:Query,config:DisposableConfig,isolated?:IsolatedSchemaTarget) {
 const c=validateDisposableConfig(config);
 const target=isolated?validateIsolatedTarget(isolated,c):undefined;
 const rows=await db.$queryRawUnsafe<{database:string;host:string;port:number;owner:string;actor:string;marker:string|null;superuser:boolean;createdb:boolean;createrole:boolean;bypassrls:boolean;replication:boolean;inherit:boolean;any_membership:boolean;owner_member:boolean;database_oid:string;owner_oid:string;app_oid:string;canlogin:boolean;app_marker:string|null}[]>(
  "SELECT d.oid::text AS database_oid,d.datdba::text AS owner_oid,r.oid::text AS app_oid,r.rolcanlogin AS canlogin,shobj_description(r.oid,'pg_authid') AS app_marker,current_database() AS database,host(inet_server_addr()) AS host,inet_server_port() AS port,pg_get_userbyid(d.datdba) AS owner,current_user AS actor,shobj_description(d.oid,'pg_database') AS marker,r.rolsuper AS superuser,r.rolcreatedb AS createdb,r.rolcreaterole AS createrole,r.rolbypassrls AS bypassrls,r.rolreplication AS replication,r.rolinherit AS inherit,EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) AS any_membership,pg_has_role(current_user,pg_get_userbyid(d.datdba),'MEMBER') AS owner_member FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()");
 const r=rows[0];
 if(rows.length!==1||r.database!==c.database||r.host!==c.host||r.port!==c.port||r.owner!==c.expectedOwner||r.actor!==(target?.appRole??c.user)||r.database_oid!==c.databaseOid||r.owner_oid!==c.ownerOid||r.app_oid!==(target?.appOid??c.appOid)||r.marker!==`FLSD_DISPOSABLE:${c.runId}:${c.database}`||[r.superuser,r.createdb,r.createrole,r.bypassrls,r.replication,r.inherit,r.any_membership,r.owner_member].some(v=>v!==false))throw new Error('Disposable database identity/ownership mismatch');
 if(target&&(r.canlogin!==true||r.app_marker!==`FLSD_ISOLATED_APP:${c.runId}:${target.runId}`))throw new Error('Isolated application role provenance mismatch');
 const schema=target?.schema??'flsd_adapter_test';
 if(target){
  await db.$queryRawUnsafe("SELECT set_config('search_path',$1,true)",'pg_catalog, '+schema);
  const proof=await db.$queryRawUnsafe<{oid:string;owner:string;marker:string|null;legacy_usage:boolean;legacy_create:boolean;schema_create:boolean;path:string}[]>("SELECT n.oid::text,n.nspowner::text AS owner,obj_description(n.oid,'pg_namespace') AS marker,has_schema_privilege(current_user,'flsd_adapter_test','USAGE') AS legacy_usage,has_schema_privilege(current_user,'flsd_adapter_test','CREATE') AS legacy_create,has_schema_privilege(current_user,n.oid,'CREATE') AS schema_create,current_setting('search_path') AS path FROM pg_namespace n WHERE n.nspname=$1",schema);
  const p=proof[0];if(proof.length!==1||p.oid!==target.schemaOid||p.owner!==c.ownerOid||p.marker!==`FLSD_ISOLATED:${c.runId}:${target.runId}:${schema}`||p.legacy_usage!==false||p.legacy_create!==false||p.schema_create!==false||p.path!=='pg_catalog, '+schema)throw new Error('Isolated schema identity/privilege mismatch');
 }
 const meta=await db.$queryRawUnsafe<{run_id:string;marker:string}[]>(`SELECT run_id::text,marker FROM ${schema}.meta WHERE id=1`);
 if(meta.length!==1||meta[0].run_id!==(target?.runId??c.runId)||meta[0].marker!=='FLSD_SYNTHETIC_ADAPTER_V1')throw new Error('Disposable schema provenance mismatch');
}
export function scopedFixtureQueries(db:Query,schema:string):Query{
 return {$queryRawUnsafe:((sql:string,...values:unknown[])=>db.$queryRawUnsafe(schemaSql(schema,sql),...values)) as Query['$queryRawUnsafe'],$executeRawUnsafe:((sql:string,...values:unknown[])=>db.$executeRawUnsafe(schemaSql(schema,sql),...values)) as Query['$executeRawUnsafe']};
}
const retryable=(error:unknown)=>{const e=error as {code?:string;meta?:{code?:string}};return e?.code==='P2034'||e?.code==='40001'||e?.code==='40P01'||e?.code==='P2010'&&['40001','40P01'].includes(e.meta?.code??'');};

/** Only synthetic state; no customer receipt/allocation/refund or live authority binding. */
export function createDisposableOperationalAdapter(client:PrismaClient, configuration:DisposableConfig,isolated?:IsolatedSchemaTarget) {
 const config=validateDisposableConfig(configuration);
 if(config.database!=='flsd_main_adapter_test')throw new Error('Restore database is verification-only');
 const target=isolated?validateIsolatedTarget(isolated,config):undefined;
 return {
  async execute(input:unknown, sessionToken:string, injection?:{stage:1|2|3|4|5}) {
   const envelope=validateOperationalEnvelope(input);
   if(typeof sessionToken!=='string'||sessionToken.length<32||sessionToken.length>256)throw new Error('Authentication required');
   const tokenHash=createHash('sha256').update(sessionToken).digest('hex');
   const injectedFailure=injection&&new Error(`Synthetic injected failure at stage ${injection.stage}`);
   for(let attempt=0;attempt<3;attempt++)try {
    return await client.$transaction(async raw=>{
     await assertDisposableIsolation(raw,config,target);
     const db=scopedFixtureQueries(raw,target?.schema??'flsd_adapter_test');
     // A single parent lock serializes all synthetic commands, including membership/stock.
     // This deliberately does not claim the future granular production financial lock protocol.
     await db.$queryRawUnsafe('SELECT id FROM __FLSD_SCHEMA__.workspace WHERE id=1 FOR UPDATE');
     // Actor permissions can change; session rows are insert-only for the synthetic role.
     const actors=await db.$queryRawUnsafe<{id:string;role:OperationalReviewActor['role']}[]>(
      'SELECT a.id::text,a.role FROM __FLSD_SCHEMA__.actors a JOIN __FLSD_SCHEMA__.sessions s ON s.actor_id=a.id WHERE s.token_hash=$1 AND s.expires_at>now() AND a.active=true FOR SHARE OF a',tokenHash);
     if(actors.length!==1)throw new Error('Authentication required');
     const actor:OperationalReviewActor={authority:target?.runId??config.runId,id:actors[0].id,role:actors[0].role,active:true};
     const work=await db.$queryRawUnsafe<{payload:unknown;revision:string}[]>('SELECT payload,revision::text FROM __FLSD_SCHEMA__.workspace WHERE id=1');
     if(work.length!==1)throw new Error('Synthetic fixture is not initialized');
     const before=decodeWire<DemoState>(JSON.stringify(work[0].payload));
     if(before.payments.length||before.allocations.length||before.refunds.length||before.remittances.length||before.importBatches.length||before.collectionEvidence.length)throw new Error('Synthetic money/import gate violated');
     const versions:ExpectedOperationalVersion[]=[...before.trips.map(t=>({kind:'TRIP' as const,id:t.id,version:String(t.version??1)})),...before.documents.filter(d=>d.type==='SOA').map(d=>({kind:'SOA' as const,id:d.id,version:String(d.version)}))];
     const receipts=await db.$queryRawUnsafe<{receipt:OperationalReviewReceipt}[]>('SELECT receipt FROM __FLSD_SCHEMA__.operations WHERE operation_id=$1::uuid',envelope.operationId);
     const review=reviewOperationalReplay(envelope,actor,receipts[0]?.receipt??null,versions);
     if(review.status==='REPLAY_REVIEW_ONLY')return {replayed:true,result:review.result,postingEnabled:false as const};
     let stage=0;const checkpoint=()=>{if(injectedFailure&&++stage===injection?.stage)throw injectedFailure;};
     const next=executeDemo(before,envelope.action,envelope.operationId,actor.role,{allowZeroDailyTrips:true});next.operations={};
     const event=next.events.at(-1)!;event.actorId=actor.id;event.occurredAt=new Date().toISOString();
     const entity=next.trips.find(t=>t.id===event.entityId)??next.documents.find(d=>d.id===event.entityId);
     if(!entity)throw new Error('Operation entity missing');
     const result={entityId:entity.id,version:String(entity.version??1)};
     const receipt:OperationalReviewReceipt={operationId:envelope.operationId,authority:target?.runId??config.runId,actorId:actor.id,commandType:envelope.action.type,digest:review.digest,result};
     checkpoint();
     for(const t of next.trips)await db.$executeRawUnsafe('INSERT INTO __FLSD_SCHEMA__.records(kind,id,version,customer_id,amount,payload) VALUES($1,$2,$3::bigint,$4,$5::numeric,$6::jsonb) ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,customer_id=excluded.customer_id,amount=excluded.amount,payload=excluded.payload','TRIP',t.id,String(t.version??1),t.customerId,fromCentavos(t.amount),encodeWire(t));
     for(const d of next.documents)await db.$executeRawUnsafe('INSERT INTO __FLSD_SCHEMA__.records(kind,id,version,customer_id,amount,payload) VALUES($1,$2,$3::bigint,$4,$5::numeric,$6::jsonb) ON CONFLICT(kind,id) DO UPDATE SET version=excluded.version,customer_id=excluded.customer_id,amount=excluded.amount,payload=excluded.payload',d.type,d.id,String(d.version),d.customerId,fromCentavos(d.amountSnapshot),encodeWire(d));
     checkpoint();
     await db.$executeRawUnsafe('INSERT INTO __FLSD_SCHEMA__.operations(operation_id,actor_id,digest,receipt) VALUES($1::uuid,$2::uuid,$3,$4::jsonb)',envelope.operationId,actor.id,review.digest,JSON.stringify(receipt));checkpoint();
     await db.$executeRawUnsafe('INSERT INTO __FLSD_SCHEMA__.audit(operation_id,actor_id,event) VALUES($1::uuid,$2::uuid,$3::jsonb)',envelope.operationId,actor.id,encodeWire(event));checkpoint();
     await db.$executeRawUnsafe('INSERT INTO __FLSD_SCHEMA__.history(operation_id,payload) VALUES($1::uuid,$2::jsonb)',envelope.operationId,encodeWire(next));
     const updated=await db.$executeRawUnsafe('UPDATE __FLSD_SCHEMA__.workspace SET payload=$1::jsonb,revision=revision+1 WHERE id=1 AND revision=$2::bigint',encodeWire(next),work[0].revision);
     if(updated!==1)throw new Error('Workspace revision conflict');checkpoint();
     return {replayed:false,result,postingEnabled:false as const};
    },{isolationLevel:'Serializable',maxWait:5000,timeout:30000});
   }catch(error){if(injectedFailure&&error===injectedFailure)throw injectedFailure;if(retryable(error)&&attempt<2)continue;throw new Error('Disposable command rejected; no success was confirmed');}
   throw new Error('Disposable retry exhausted');
  }
 };
}
