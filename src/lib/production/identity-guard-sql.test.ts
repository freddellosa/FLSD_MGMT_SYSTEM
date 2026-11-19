import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const source=readFileSync('scripts/main-disposable-safety.ps1','utf8');
const start=source.indexOf('function Get-MainIdentityGuardSql(');
const template=/\$sql=@'\r?\n([\s\S]*?)\r?\n'@/.exec(source.slice(start))?.[1];
if(!template)throw new Error('Identity guard template unavailable');

/** Focused regression model of PostgreSQL18 read_sql_construct(K_THEN):
 * expression termination observes parentheses/brackets, not CASE nesting.
 * This is not a complete SQL parser or a replacement for connected compilation.
 */
function ifExpression(statement:string) {
 let depth=0;
 const tokens=statement.matchAll(/'(?:''|[^'])*'|"(?:""|[^"])*"|[A-Za-z_][A-Za-z_0-9]*|[()[\]]/g);
 for(const token of tokens){
  if(token[0]==='THEN'&&depth===0)return statement.slice(0,token.index).trim();
  if(token[0]==='('||token[0]==='[')depth++;
  if(token[0]===')'||token[0]===']')depth--;
  if(depth<0)throw new Error('Unbalanced expression');
 }
 throw new Error('No top-level THEN found');
}
function guard(database:'flsd_main_adapter_test'|'flsd_main_restore_test',pristine:boolean) {
 const values:Record<string,string>={DATABASE:database,OID:database==='flsd_main_adapter_test'?'16394':'16395',OWNER_OID:'16392',APP_OID:'16393',ADMIN:'postgres',OWNER:'test_owner',APP:'test_app',RUN:'b813e743-9f4c-4121-b8ab-b01ca51b9335',PRISTINE:String(pristine)};
 return template!.replace(/__([A-Z_]+)__/g,(_,key:string)=>values[key]);
}
describe('PL/pgSQL generated identity guard CASE regression',()=>{
 it('reproduces the truncated expression from the reported failed stage',()=>{
  const failed="IF r.rolinherit OR r.rolname<>CASE WHEN r.oid=16392::oid THEN 'test_owner' ELSE 'test_app' END OR r.rolcanlogin<>(r.oid=16393::oid) THEN RAISE EXCEPTION 'mismatch'; END IF;";
  const expression=ifExpression(failed);
  expect(expression).toBe('IF r.rolinherit OR r.rolname<>CASE WHEN r.oid=16392::oid');
  expect(expression).not.toContain('END');
 });
 for(const database of ['flsd_main_adapter_test','flsd_main_restore_test'] as const)for(const pristine of [true,false]){
  it(`retains the complete IF condition for ${database}, pristine=${pristine}`,()=>{
   const sql=guard(database,pristine),line=sql.split(/\r?\n/).find(s=>s.trimStart().startsWith('IF r.rolsuper'))!;
   const expression=ifExpression(line);
   expect(expression).toContain("r.rolname<>(CASE WHEN r.oid=16392::oid THEN 'test_owner' ELSE 'test_app' END)");
   expect(expression).toContain("ELSE 'APP' END)");
   expect(expression).toContain('pg_auth_members');
   expect(line.trimStart().slice(expression.length).trimStart()).toMatch(/^THEN RAISE EXCEPTION/);
   expect(sql).toContain(`current_database()<>'${database}'`);
   expect(sql).toContain(`d.oid<>${database==='flsd_main_adapter_test'?'16394':'16395'}::oid`);
   expect(sql).toContain('d.datdba<>16392::oid');
   expect(sql).toContain(`IF ${pristine} AND`);
   expect(sql).not.toMatch(/__[A-Z_]+__/);
  });
 }
 it('keeps the original migration free of the injected guard and inside one transaction',()=>{
  const migration=readFileSync('prisma/disposable-main-adapter.sql','utf8');
  expect(migration).not.toContain('$flsd_guard$');
  expect(migration.match(/^BEGIN;\r?$/gm)).toHaveLength(1);expect(migration.match(/^COMMIT;\r?$/gm)).toHaveLength(1);
  expect(migration.indexOf('BEGIN;')).toBeLessThan(migration.indexOf('CREATE SCHEMA'));
 });
 it('makes pre-migration verification read-only and separate from Migrate',()=>{
  const maintenance=readFileSync('scripts/maintain-main-disposable.ps1','utf8');
  const verification=maintenance.slice(maintenance.indexOf("if($Action -eq 'VerifyPreMigration')"),maintenance.indexOf("}elseif($Action -eq 'Migrate')"));
  expect(verification).toContain('BEGIN READ ONLY;');expect(verification).toContain('ROLLBACK;');
  expect(verification).toContain("Invoke-TargetSql 'flsd_main_adapter_test' $sql $true");
  expect(verification).not.toMatch(/CREATE\s+(TABLE|SCHEMA|DATABASE)|INSERT\s+INTO|\bUPDATE\s+flsd/);
 });
});
