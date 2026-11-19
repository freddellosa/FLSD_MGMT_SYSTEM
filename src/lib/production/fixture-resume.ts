/** Synthetic fixture intent/identity only. Never adopts legacy rows from matching counts. */
import {createHash,randomUUID} from 'node:crypto';
import {lstatSync,realpathSync,readFileSync,openSync,writeSync,fsyncSync,closeSync,existsSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import type {Prisma} from '@prisma/client';
import {emptyDemo} from '../demo/store';
import {canonicalWire,encodeWire} from '../pilot/wire';
import {validateDisposableConfig,type DisposableConfig} from './disposable-postgres';

const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash=/^[0-9a-f]{64}$/;
export const fixtureIntentPath='artifacts/main-adapter-fixture-intent.json';
export type FixtureIntent={version:1;kind:'SYNTHETIC_FIXTURE_INIT_INTENT_V1';config:DisposableConfig;attemptId:string;actorId:string;sessionHash:string;expiresAt:string;workspaceDigest:string};
export type FixtureSnapshot={workspace:{id:number;revision:string;payload:unknown}[];actors:{id:string;role:string;active:boolean}[];sessions:{token_hash:string;actor_id:string;expires_at:Date}[];counts:{records:string;operations:string;audit:string;history:string}};
const reject=(code:string):never=>{throw new Error('FLSD_FIXTURE_'+code);};
const digest=(value:unknown)=>createHash('sha256').update(canonicalWire(value)).digest('hex');
const baseline=()=>JSON.parse(encodeWire(emptyDemo())) as unknown;
const zeroCounts=(counts:FixtureSnapshot['counts'])=>counts&&Object.keys(counts).sort().join(',')==='audit,history,operations,records'&&Object.values(counts).every(v=>v==='0');
function primary(config:DisposableConfig){const c=validateDisposableConfig(config);if(c.database!=='flsd_main_adapter_test')reject('IDENTITY_MISMATCH');return c;}
export function newFixtureIntent(config:DisposableConfig,actorId:string,sessionHash:string,expiresAt:string):FixtureIntent{
 if(!uuid.test(actorId)||!hash.test(sessionHash)||!Number.isFinite(Date.parse(expiresAt))||new Date(expiresAt).toISOString()!==expiresAt)reject('IDENTITY_MISMATCH');
 return {version:1,kind:'SYNTHETIC_FIXTURE_INIT_INTENT_V1',config:primary(config),attemptId:randomUUID(),actorId,sessionHash,expiresAt,workspaceDigest:digest(baseline())};
}
export function validateFixtureIntent(value:unknown,config:DisposableConfig):FixtureIntent{
 primary(config);if(!value||typeof value!=='object'||Array.isArray(value))reject('PROVENANCE_UNRECORDED');
 const v=value as FixtureIntent;
 if(Object.keys(v).sort().join(',')!==['version','kind','config','attemptId','actorId','sessionHash','expiresAt','workspaceDigest'].sort().join(',')||v.version!==1||v.kind!=='SYNTHETIC_FIXTURE_INIT_INTENT_V1'||typeof v.attemptId!=='string'||!uuid.test(v.attemptId)||typeof v.actorId!=='string'||!uuid.test(v.actorId)||typeof v.sessionHash!=='string'||!hash.test(v.sessionHash)||typeof v.expiresAt!=='string'||!Number.isFinite(Date.parse(v.expiresAt))||new Date(v.expiresAt).toISOString()!==v.expiresAt||v.workspaceDigest!==digest(baseline()))reject('IDENTITY_MISMATCH');
 if(canonicalWire(primary(v.config))!==canonicalWire(config))reject('IDENTITY_MISMATCH');
 return structuredClone(v);
}
function localPath(){
 const root='D:\\FLSD-Batch7-Validation',path=resolve(fixtureIntentPath);
 if(process.cwd()!==root||realpathSync(root)!==root||realpathSync(dirname(path))!==resolve('artifacts')||lstatSync(dirname(path)).isSymbolicLink())reject('IDENTITY_MISMATCH');
 return path;
}
export function readFixtureIntent(config:DisposableConfig):FixtureIntent{
 const path=localPath();
 if(existsSync(path+'.resume-attempt.json'))reject('RESUME_ATTEMPT_RECORDED');
 try{const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>16384||realpathSync(path)!==path)reject('IDENTITY_MISMATCH');return validateFixtureIntent(JSON.parse(readFileSync(path,'utf8')),config);}
 catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')reject('PROVENANCE_UNRECORDED');if(error instanceof Error&&error.message.startsWith('FLSD_FIXTURE_'))throw error;return reject('IDENTITY_MISMATCH');}
}
/** Durable stop marker: interruptions never cause automatic session creation/retry. */
export function writeResumeAttempt(intent:FixtureIntent,actorId:string,sessionHash:string,expiresAt:string){
 const v=validateFixtureIntent(intent,intent.config);
 if(!uuid.test(actorId)||actorId===v.actorId||!hash.test(sessionHash)||sessionHash===v.sessionHash||!Number.isFinite(Date.parse(expiresAt)))reject('IDENTITY_MISMATCH');
 let fd:number;try{fd=openSync(localPath()+'.resume-attempt.json','wx',0o600);}catch{return reject('RESUME_ATTEMPT_RECORDED');}
 try{writeSync(fd,JSON.stringify({kind:'RESUME_INTENT_ONLY',fixtureAttemptId:v.attemptId,config:v.config,actorId,sessionHash,expiresAt}));fsyncSync(fd);}finally{closeSync(fd);}
}
/** Intent is durable BEFORE initial database INSERTs; never backfilled from existing rows. */
export function writeFixtureIntent(intent:FixtureIntent){
 const value=validateFixtureIntent(intent,intent.config),path=localPath();let fd:number;
 try{fd=openSync(path,'wx',0o600);}catch{return reject('INTENT_ALREADY_EXISTS');}
 try{writeSync(fd,JSON.stringify(value));fsyncSync(fd);}finally{closeSync(fd);}
}
export async function inspectFixture(db:Pick<Prisma.TransactionClient,'$queryRawUnsafe'>):Promise<FixtureSnapshot>{
 const workspace=await db.$queryRawUnsafe<FixtureSnapshot['workspace']>('SELECT id,revision::text,payload FROM flsd_adapter_test.workspace ORDER BY id LIMIT 2');
 const actors=await db.$queryRawUnsafe<FixtureSnapshot['actors']>('SELECT id::text,role,active FROM flsd_adapter_test.actors ORDER BY id LIMIT 2');
 const sessions=await db.$queryRawUnsafe<FixtureSnapshot['sessions']>('SELECT token_hash,actor_id::text,expires_at FROM flsd_adapter_test.sessions ORDER BY token_hash LIMIT 2');
 const counts=await db.$queryRawUnsafe<FixtureSnapshot['counts'][]>("SELECT (SELECT count(*)::text FROM flsd_adapter_test.records) AS records,(SELECT count(*)::text FROM flsd_adapter_test.operations) AS operations,(SELECT count(*)::text FROM flsd_adapter_test.audit) AS audit,(SELECT count(*)::text FROM flsd_adapter_test.history) AS history");
 return {workspace,actors,sessions,counts:counts[0]};
}
export function assertEmptyFixture(snapshot:FixtureSnapshot){
 if(snapshot.workspace.length||snapshot.actors.length||snapshot.sessions.length||!zeroCounts(snapshot.counts))reject('NOT_EMPTY');
}
export function assertResumableFixture(config:DisposableConfig,value:unknown,snapshot:FixtureSnapshot){
 const intent=validateFixtureIntent(value,config);
 if(snapshot.workspace.length!==1||snapshot.actors.length!==1||snapshot.sessions.length!==1||!zeroCounts(snapshot.counts))reject('PARTIAL_OR_PROGRESSED');
 const w=snapshot.workspace[0],a=snapshot.actors[0],s=snapshot.sessions[0];
 if(w.id!==1||w.revision!=='0'||digest(w.payload)!==intent.workspaceDigest||a.id!==intent.actorId||a.role!=='BILLING'||a.active!==true||s.actor_id!==intent.actorId||s.token_hash!==intent.sessionHash||!(s.expires_at instanceof Date)||s.expires_at.toISOString()!==intent.expiresAt)reject('IDENTITY_MISMATCH');
 return {actorId:intent.actorId,origin:'MATCHED_PREEXISTING_INTENT' as const,session:'NEW_REQUIRED' as const};
}
