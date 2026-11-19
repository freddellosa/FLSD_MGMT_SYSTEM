import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {createRequire} from 'node:module';
import {emptyDemo} from '../demo/store';
import {encodeWire} from '../pilot/wire';
import {assertEmptyFixture,assertResumableFixture,newFixtureIntent,validateFixtureIntent,readFixtureIntent,writeFixtureIntent,writeResumeAttempt,type FixtureSnapshot} from './fixture-resume';
const storage=vi.hoisted(()=>({files:new Map<string,string>(),fds:new Map<number,string>(),next:10}));
const validationRoot='D:\\FLSD-Batch7-Validation';
vi.mock('node:fs',async original=>{
 const actual=await original<typeof import('node:fs')>();
 const target=(p:unknown)=>String(p).includes('main-adapter-fixture-intent.json');
 const canonicalDirectory=(p:string)=>p===validationRoot||/[\\/]artifacts$/.test(p);
 return {...actual,
  existsSync:(p:string)=>target(p)?storage.files.has(p):actual.existsSync(p),
  lstatSync:(p:string)=>{if(canonicalDirectory(p))return {isSymbolicLink:()=>false};if(!target(p))return actual.lstatSync(p);if(!storage.files.has(p))throw Object.assign(new Error('Absent'),{code:'ENOENT'});return {isFile:()=>true,isSymbolicLink:()=>false,size:storage.files.get(p)!.length};},
  realpathSync:(p:string)=>target(p)||canonicalDirectory(p)?p:actual.realpathSync(p),
  readFileSync:(p:string,...args:unknown[])=>target(p)?storage.files.get(p):Reflect.apply(actual.readFileSync,actual,[p,...args]),
  openSync:(p:string,flags:string)=>{if(!target(p))throw new Error('Unexpected file write');if(flags!=='wx'||storage.files.has(p))throw Object.assign(new Error('Exists'),{code:'EEXIST'});const fd=storage.next++;storage.files.set(p,'');storage.fds.set(fd,p);return fd;},
  writeSync:(fd:number,text:string)=>{const p=storage.fds.get(fd)!;storage.files.set(p,storage.files.get(p)+text);return text.length;},
  fsyncSync:()=>{},closeSync:(fd:number)=>{storage.fds.delete(fd);}
 };
});
const config={host:'127.0.0.1',port:5432,database:'flsd_main_adapter_test',user:'flsd_test_app_b813e7439f4c',expectedOwner:'flsd_test_owner_b813e7439f4c',runId:'b813e743-9f4c-4121-b8ab-b01ca51b9335',databaseOid:'16394',ownerOid:'16392',appOid:'16393'} as const;
const actor='730a9ad4-9620-4f88-9955-661d4c14c7ca',hash='a'.repeat(64),expiry='2026-11-17T00:00:00.000Z';
function fixture(){const intent=newFixtureIntent(config,actor,hash,expiry);const snapshot:FixtureSnapshot={workspace:[{id:1,revision:'0',payload:JSON.parse(encodeWire(emptyDemo()))}],actors:[{id:actor,role:'BILLING',active:true}],sessions:[{token_hash:hash,actor_id:actor,expires_at:new Date(expiry)}],counts:{records:'0',operations:'0',audit:'0',history:'0'}};return {intent,snapshot};}
beforeEach(()=>{vi.spyOn(process,'cwd').mockReturnValue(validationRoot);storage.files.clear();storage.fds.clear();});
afterEach(()=>vi.restoreAllMocks());
describe('Guarded pristine fixture resume',()=>{
 it('requires a recorded intent even when all rows/counts look synthetic',()=>{
  expect(()=>assertResumableFixture(config,undefined,fixture().snapshot)).toThrow('PROVENANCE_UNRECORDED');
  expect(()=>readFixtureIntent(config)).toThrow('PROVENANCE_UNRECORDED');expect(storage.files.size).toBe(0);
 });
 it('accepts exact identity including an expired/unavailable old session without returning its token',()=>{
  const {intent,snapshot}=fixture();expect(assertResumableFixture(config,intent,snapshot)).toEqual({actorId:actor,origin:'MATCHED_PREEXISTING_INTENT',session:'NEW_REQUIRED'});
 });
 it.each(['actor','session','payload','revision','role','expiry'])('rejects %s identity mismatch',kind=>{
  const {intent,snapshot}=fixture();
  if(kind==='actor')snapshot.actors[0].id='wrong';if(kind==='session')snapshot.sessions[0].token_hash='b'.repeat(64);
  if(kind==='payload')snapshot.workspace[0].payload={};if(kind==='revision')snapshot.workspace[0].revision='1';
  if(kind==='role')snapshot.actors[0].role='VIEWER';if(kind==='expiry')snapshot.sessions[0].expires_at=new Date('2027-01-01');
  expect(()=>assertResumableFixture(config,intent,snapshot)).toThrow('IDENTITY_MISMATCH');
 });
 it.each(['workspace','actors','sessions'] as const)('refuses interrupted partial initialization missing %s',key=>{
  const {intent,snapshot}=fixture();snapshot[key]=[];expect(()=>assertResumableFixture(config,intent,snapshot)).toThrow('PARTIAL_OR_PROGRESSED');
 });
 it('refuses progressed records and extra sessions after interrupted resume',()=>{
  const {intent,snapshot}=fixture();snapshot.sessions.push({...snapshot.sessions[0],token_hash:'b'.repeat(64)});
  expect(()=>assertResumableFixture(config,intent,snapshot)).toThrow('PARTIAL_OR_PROGRESSED');
  snapshot.sessions.pop();snapshot.counts.operations='1';expect(()=>assertResumableFixture(config,intent,snapshot)).toThrow('PARTIAL_OR_PROGRESSED');
 });
 it.each([{database:'flsd_main_restore_test'},{databaseOid:'99999'},{ownerOid:'99999'},{appOid:'99999'}])('refuses cross-database/provenance changes %j',change=>{
  const {intent}=fixture();expect(()=>validateFixtureIntent({...intent,config:{...config,...change}},config)).toThrow('IDENTITY_MISMATCH');
 });
 it('writes identity intent exclusively without tokens or passwords',()=>{
  const {intent}=fixture();writeFixtureIntent(intent);expect(readFixtureIntent(config)).toEqual(intent);
  expect(()=>writeFixtureIntent(intent)).toThrow('INTENT_ALREADY_EXISTS');
  expect([...storage.files.values()].join('')).not.toMatch(/testPassword|postgresql:\/\/|password/i);
 });
 it('blocks retry after durable resume intent even if database commit is uncertain',()=>{
  const {intent}=fixture();writeFixtureIntent(intent);writeResumeAttempt(intent,'6d991929-7b89-4d49-9048-e53090ef7ce9','b'.repeat(64),expiry);
  expect(()=>readFixtureIntent(config)).toThrow('RESUME_ATTEMPT_RECORDED');
  expect(()=>writeResumeAttempt(intent,'6d991929-7b89-4d49-9048-e53090ef7ce9','c'.repeat(64),expiry)).toThrow('RESUME_ATTEMPT_RECORDED');
  expect(storage.files.size).toBe(2);
 });
 it('refuses to assign the previous actor or session to a new resume attempt',()=>{
  const {intent}=fixture();expect(()=>writeResumeAttempt(intent,actor,'b'.repeat(64),expiry)).toThrow('IDENTITY_MISMATCH');
  expect(()=>writeResumeAttempt(intent,'6d991929-7b89-4d49-9048-e53090ef7ce9',hash,expiry)).toThrow('IDENTITY_MISMATCH');expect(storage.files.size).toBe(0);
 });
 it('does not adopt an empty/rolled-back database merely because an intent exists',()=>{
  const {intent}=fixture();const snapshot:FixtureSnapshot={workspace:[],actors:[],sessions:[],counts:{records:'0',operations:'0',audit:'0',history:'0'}};
  assertEmptyFixture(snapshot);expect(()=>assertResumableFixture(config,intent,snapshot)).toThrow('PARTIAL_OR_PROGRESSED');
 });
 it('fresh mode refuses existing workspace before minting identity',()=>{
  expect(()=>assertEmptyFixture(fixture().snapshot)).toThrow('NOT_EMPTY');expect(storage.files.size).toBe(0);
 });
 it('reports missing provenance as a fixed category without leaking identity records',()=>{
  const {safeReport}=createRequire(import.meta.url)('../../../scripts/lib/main-adapter-diagnostics.cjs');
  expect(safeReport({exitCode:1,stdout:'FLSD_SAFE_CATEGORY:FIXTURE_PROVENANCE_UNRECORDED'}).category).toBe('FIXTURE_PROVENANCE_UNRECORDED');
  expect(safeReport({exitCode:1,stderr:'FLSD_FIXTURE_IDENTITY_MISMATCH'}).category).toBe('FIXTURE_RESUME_REFUSED');
 });
});
