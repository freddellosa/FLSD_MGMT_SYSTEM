import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {describe,it,expect} from 'vitest';
const requireLocal=createRequire(import.meta.url);
const {safeReport}=requireLocal('../../../scripts/lib/main-adapter-diagnostics.cjs') as {safeReport:(v:Record<string,unknown>)=>Record<string,unknown>};
describe('Credential-free adapter diagnostics',()=>{
 it.each([
  ['P1000 password authentication failed','AUTHENTICATION_FAILED'],
  ['42501 permission denied for table workspace','PERMISSION_DENIED'],
  ['P1001 cannot connect','SERVER_UNAVAILABLE'],
  ['42P01 relation does not exist','SCHEMA_NOT_READY'],
  ['Disposable database identity/ownership mismatch','ISOLATION_MISMATCH'],
  ['23505 duplicate key value','FIXTURE_ALREADY_INITIALIZED'],
  ['FLSD_SAFE_CREDENTIAL_INPUT','CREDENTIAL_INPUT_INVALID'],
  ['ERR_MODULE_NOT_FOUND','DEPENDENCY_OR_MODULE_MISSING'],
  ['failed to load config','CONFIG_STARTUP_FAILED'],
  ['AssertionError','ASSERTION_FAILED'],
  ['40001 could not serialize','TRANSACTION_CONFLICT'],
  ['P1002 timed out','TIMEOUT'],
  ['unrecognized failure','UNKNOWN_FAILURE']
 ])('reports only an allowlisted category for %s',(text,expected)=>{
  const r=safeReport({exitCode:1,stdout:'',stderr:text,mode:'CONNECTED_TESTS'});expect(r.category).toBe(expected);expect(r.rawOutputIncluded).toBe(false);
 });
 it('never returns secret-bearing text, connection URLs, SQL or unknown fields',()=>{
  const secret='PRIVATE-FAKE-PASSWORD-α';
  const r=safeReport({exitCode:1,stdout:`postgresql://actor:${secret}@127.0.0.1:5432/db SELECT private_value`,stderr:`P1000 ${secret}`,password:secret,mode:secret});
  expect(JSON.stringify(r)).not.toContain(secret);expect(JSON.stringify(r)).not.toContain('postgresql');expect(JSON.stringify(r)).not.toContain('SELECT');
  expect(Object.keys(r).sort()).toEqual(['category','exitCode','kind','mode','phases','rawOutputIncluded','tests'].sort());
 });
 it('keeps fixed phase/state markers and counters, dropping arbitrary marker content',()=>{
  const r=safeReport({exitCode:0,mode:'DIAGNOSTIC_READ_ONLY',stdout:'FLSD_SAFE_PHASE:DIAGNOSTIC_CONNECT\nFLSD_SAFE_PHASE:PRIVATE_PASSWORD\nFLSD_SAFE_STATE:PRESENT\n',stderr:'Tests 11 passed (11)'});
  expect(r).toMatchObject({category:'SUCCESS',fixtureState:'PRESENT',phases:['DIAGNOSTIC_CONNECT'],tests:{passed:11,failed:0,skipped:0}});
  expect(JSON.stringify(r)).not.toContain('PRIVATE_PASSWORD');
 });
 it('does not trust arbitrary explicit diagnostic categories',()=>{
  expect(safeReport({exitCode:1,stdout:'FLSD_SAFE_CATEGORY:PRIVATE_PASSWORD'}).category).toBe('UNKNOWN_FAILURE');
 });
 it('diagnostic source does not collect tests or perform SQL writes',()=>{
  const source=readFileSync('scripts/diagnose-main-adapter.cjs','utf8');
  expect(source).not.toContain('connected.test');expect(source).not.toContain('adapter.execute');expect(source).not.toContain('executeDemo');
  const executions=[...source.matchAll(/\$executeRawUnsafe\('([^']+)'\)/g)].map(m=>m[1]);expect(executions).toEqual(['SET TRANSACTION READ ONLY']);
  expect(source).not.toMatch(/\b(?:INSERT INTO|UPDATE flsd_|DELETE FROM|TRUNCATE|CREATE TABLE|ALTER ROLE)\b/);
 });
 it('pins synthetic write clients to primary and refuses restore commands',()=>{
  const suite=readFileSync('tests/main-adapter/connected.test.ts','utf8');
  const adapter=readFileSync('src/lib/production/disposable-postgres.ts','utf8');
  expect(suite).toContain("database:'flsd_main_adapter_test'");
  expect(adapter).toContain("if(config.database!=='flsd_main_adapter_test')throw new Error('Restore database is verification-only')");
 });
});
