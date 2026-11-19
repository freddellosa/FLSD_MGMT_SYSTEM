import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import {resolve} from 'node:path';
import {writeIsolatedFixtureIntent,readInstalledIsolatedTarget} from './isolated-fixture-intent';
import {validateDisposableConfig} from './disposable-postgres';
const mem=vi.hoisted(()=>({files:new Map<string,string>(),fds:new Map<number,string>(),next:10,redirect:false}));
const validationRoot='D:\\FLSD-Batch7-Validation';
vi.mock('node:fs',async original=>{
 const actual=await original<typeof import('node:fs')>();const target=(p:unknown)=>String(p).includes('main-adapter-isolated-');
 const canonicalDirectory=(p:string)=>p===validationRoot||/[\\/]artifacts$/.test(p);
 return {...actual,
  realpathSync:(p:string)=>target(p)?(mem.redirect?p+'.redirect':p):canonicalDirectory(p)?p:actual.realpathSync(p),
  lstatSync:(p:string)=>{if(!target(p))return actual.lstatSync(p);if(!mem.files.has(p))throw new Error('Missing installation evidence');return {isFile:()=>true,size:mem.files.get(p)!.length};},
  readFileSync:(p:string,...args:unknown[])=>target(p)?mem.files.get(p):Reflect.apply(actual.readFileSync,actual,[p,...args]),
  openSync:(p:string,mode:string)=>{if(!target(p))throw new Error('Unexpected write');if(mode!=='wx'||mem.files.has(p))throw new Error('Collision');const fd=mem.next++;mem.files.set(p,'');mem.fds.set(fd,p);return fd;},
  writeFileSync:(fd:number,data:string)=>{mem.files.set(mem.fds.get(fd)!,data);},fsyncSync:()=>{},closeSync:(fd:number)=>{mem.fds.delete(fd);}
 };
});
const config=validateDisposableConfig({host:'127.0.0.1',port:5432,database:'flsd_main_adapter_test',user:'flsd_test_app_b813e7439f4c',expectedOwner:'flsd_test_owner_b813e7439f4c',runId:'b813e743-9f4c-4121-b8ab-b01ca51b9335',databaseOid:'16394',ownerOid:'16392',appOid:'16393'});
const runId='32f9216c-e7d4-4e78-80b3-cfb7f58e04eb',target={runId,parentRunId:config.runId,schema:'flsd_iso_'+runId.replaceAll('-',''),appRole:'flsd_iso_app_'+runId.replaceAll('-',''),schemaOid:'50001',appOid:'50002'};
const actor='1db9d3ea-aa62-4340-8abb-d85fc17e3b5a',hash='a'.repeat(64);
let installed:string;
beforeEach(()=>{vi.spyOn(process,'cwd').mockReturnValue(validationRoot);installed=resolve('artifacts/main-adapter-isolated-installed.json');mem.files.clear();mem.fds.clear();mem.redirect=false;});
afterEach(()=>vi.restoreAllMocks());
describe('Isolated fixture interruption and evidence boundaries',()=>{
 it('does not infer installation evidence from an existing schema name',()=>{expect(()=>readInstalledIsolatedTarget(config)).toThrow();expect(mem.files.size).toBe(0);});
 it('accepts exact recorded installation identity',()=>{mem.files.set(installed,JSON.stringify(target));expect(readInstalledIsolatedTarget(config)).toEqual(target);});
 it('selects a per-run receipt and never falls back to the preserved installation',()=>{
  const fresh=resolve(`artifacts/main-adapter-isolated-installed-${runId}.json`);
  mem.files.set(installed,JSON.stringify(target));
  expect(()=>readInstalledIsolatedTarget(config,runId)).toThrow();
  mem.files.set(fresh,JSON.stringify(target));
  expect(readInstalledIsolatedTarget(config,runId)).toEqual(target);
  expect(mem.files.get(installed)).toBe(JSON.stringify(target));
 });
 it('rejects path input and mismatched run IDs in explicit receipts',()=>{
  const other='fc326d70-ff5a-44b2-ad31-f6d91000254c';
  mem.files.set(resolve(`artifacts/main-adapter-isolated-installed-${other}.json`),JSON.stringify(target));
  expect(()=>readInstalledIsolatedTarget(config,'../main-adapter-isolated-installed')).toThrow('Invalid isolated run identity');
  expect(()=>readInstalledIsolatedTarget(config,other)).toThrow('receipt run mismatch');
 });
 it('rejects redirected proof paths and role/OID drift',()=>{
  mem.files.set(installed,JSON.stringify({...target,appRole:config.user}));expect(()=>readInstalledIsolatedTarget(config)).toThrow();
  mem.files.set(installed,JSON.stringify(target));mem.redirect=true;expect(()=>readInstalledIsolatedTarget(config)).toThrow();
 });
 it('reserves one durable attempt and refuses retry after an interrupted transaction',()=>{
  writeIsolatedFixtureIntent(config,target,actor,hash,'{"synthetic":true}');const before=[...mem.files.values()];
  expect(()=>writeIsolatedFixtureIntent(config,target,actor,hash,'{}')).toThrow('ATTEMPT_RECORDED');expect([...mem.files.values()]).toEqual(before);
  const value=JSON.parse(before[0]);expect(value.kind).toBe('ISOLATED_FIXTURE_INTENT_NOT_COMMIT_PROOF');expect(value).not.toHaveProperty('password');expect(value).not.toHaveProperty('token');expect(value).not.toHaveProperty('payload');
 });
 it('keeps independent run intents without overwriting the interrupted run',()=>{
  writeIsolatedFixtureIntent(config,target,actor,hash,'{}');const second='fc326d70-ff5a-44b2-ad31-f6d91000254c';
  writeIsolatedFixtureIntent(config,{...target,runId:second,schema:'flsd_iso_'+second.replaceAll('-',''),appRole:'flsd_iso_app_'+second.replaceAll('-','')},actor,hash,'{}');expect(mem.files.size).toBe(2);
 });
 it('rejects legacy/restore targets before creating an attempt file',()=>{
  expect(()=>writeIsolatedFixtureIntent(config,{...target,schema:'flsd_adapter_test'},actor,hash,'{}')).toThrow();
  expect(()=>writeIsolatedFixtureIntent({...config,database:'flsd_main_restore_test'},target,actor,hash,'{}')).toThrow();expect(mem.files.size).toBe(0);
 });
});
