import {describe,expect,it} from 'vitest';
import {assertDisposableIsolation,validateDisposableConfig} from './disposable-postgres';
const config={host:'127.0.0.1',port:5432,database:'flsd_main_adapter_test',user:'flsd_test_app_123456781234',expectedOwner:'flsd_test_owner_123456781234',runId:'12345678-1234-4234-8234-123456789abc',databaseOid:'40001',ownerOid:'40002',appOid:'40003'};
function fake(change:Record<string,unknown>={},metaChange:Record<string,unknown>={}){
 const calls:string[]=[];
 const db={$queryRawUnsafe:async(sql:string)=>{calls.push(sql);return calls.length===1?[{database:config.database,host:config.host,port:config.port,owner:config.expectedOwner,actor:config.user,database_oid:config.databaseOid,owner_oid:config.ownerOid,app_oid:config.appOid,superuser:false,createdb:false,createrole:false,bypassrls:false,replication:false,inherit:false,any_membership:false,owner_member:false,marker:`FLSD_DISPOSABLE:${config.runId}:${config.database}`,...change}]:[{run_id:config.runId,marker:'FLSD_SYNTHETIC_ADAPTER_V1',...metaChange}];},$executeRawUnsafe:async()=>{throw new Error('No writes permitted');}};
 return {db:db as unknown as Parameters<typeof assertDisposableIsolation>[0],calls};
}
describe('Disposable main adapter isolation',()=>{
 it('accepts only the explicit immutable local configuration',()=>{const c=validateDisposableConfig(config);c.database='flsd_main_restore_test';expect(config.database).toBe('flsd_main_adapter_test');});
 it.each([{port:55432},{host:'localhost'},{database:'postgres'},{database:'business'},{user:'postgres;DROP'},{expectedOwner:'other'},{password:'not-accepted'},{runId:'wrong'}])('rejects unsafe configuration %j',change=>{expect(()=>validateDisposableConfig({...config,...change})).toThrow();});
 it('checks actual identity and provenance without writes',async()=>{const f=fake();await assertDisposableIsolation(f.db,validateDisposableConfig(config));expect(f.calls).toHaveLength(2);});
 it.each([{port:55432},{database:'existing_business'},{owner:'other'},{actor:'other'},{marker:null},{marker:'FLSD_DISPOSABLE:old:flsd_main_adapter_test'},{host:'::1'}])('refuses an actual identity mismatch before schema reads %j',async change=>{
  const f=fake(change);await expect(assertDisposableIsolation(f.db,validateDisposableConfig(config))).rejects.toThrow('identity/ownership');expect(f.calls).toHaveLength(1);
 });
 it('rejects a stale run marker',async()=>{const f=fake({}, {run_id:'other'});await expect(assertDisposableIsolation(f.db,validateDisposableConfig(config))).rejects.toThrow('provenance');});
 it.each(['superuser','createdb','createrole','bypassrls','replication','inherit','any_membership','owner_member'])('refuses elevated application privilege %s',async flag=>{const f=fake({[flag]:true});await expect(assertDisposableIsolation(f.db,validateDisposableConfig(config))).rejects.toThrow('identity/ownership');});
 it.each(['database_oid','owner_oid','app_oid'])('rejects drop/recreate identity drift in %s',async field=>{const f=fake({[field]:'49999'});await expect(assertDisposableIsolation(f.db,validateDisposableConfig(config))).rejects.toThrow('identity/ownership');});
});
