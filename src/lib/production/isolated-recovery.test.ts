import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import {describe,expect,it} from 'vitest';

const {selectedCopyBlocks,validateArchiveList,recoveryDdl,manifestSql,schema} =
  createRequire(import.meta.url)('../../../scripts/lib/main-isolated-recovery.cjs');
const owner='flsd_test_owner_b813e7439f4c';
const columns={
  meta:'id, run_id, marker', actors:'id, role, active', sessions:'token_hash, actor_id, expires_at',
  workspace:'id, revision, payload', records:'kind, id, version, customer_id, amount, payload',
  operations:'operation_id, actor_id, digest, receipt', audit:'operation_id, actor_id, event', history:'operation_id, payload',
};
const copy=(table:keyof typeof columns, row='')=>`COPY ${schema}.${table} (${columns[table]}) FROM stdin;\n${row}\\.\n`;
const decoded='\\restrict fixedKey\nSET client_encoding = \'UTF8\';\n'+
  (Object.keys(columns) as (keyof typeof columns)[]).reverse().map(table=>copy(table)).join('')+'\\unrestrict fixedKey\n';
const toc=[
  `SCHEMA - ${schema}`,`COMMENT - SCHEMA ${schema}`,
  ...Object.keys(columns).flatMap(table=>[`TABLE ${schema} ${table}`,`TABLE DATA ${schema} ${table}`,`CONSTRAINT ${schema} ${table} ${table}_pkey`]),
  ...['immutable_history()','require_atomic_history()'].map(name=>`FUNCTION ${schema} ${name}`),
  ...['sessions sessions_actor_id_fkey','operations operations_actor_id_fkey','audit audit_actor_id_fkey','audit audit_operation_id_fkey','history history_operation_id_fkey'].map(name=>`FK CONSTRAINT ${schema} ${name}`),
  ...['operations immutable_operations','audit immutable_audit','history immutable_history','operations atomic_history'].map(name=>`TRIGGER ${schema} ${name}`),
].map((entry,i)=>`${i+1}; 0 0 ${entry} ${owner}`).join('\n');

describe('Isolated recovery archive boundaries',()=>{
  it('copies only the selected tables in dependency order and preserves encoded row data',()=>{
    const row='1\t0\t{"value":"synthetic \\n text"}\n';
    const body:string=selectedCopyBlocks(decoded.replace(copy('workspace'),copy('workspace',row)));
    const names=Array.from(body.matchAll(/^COPY [^.]+\.([a-z_]+)/gm), match=>match[1]);
    expect(names).toEqual(Object.keys(columns));
    expect(body).toContain(row);
    expect(body).not.toContain('\\restrict');
  });
  it.each([
    decoded+'\\connect postgres\n', decoded.replace(schema,'public'),
    decoded.replace(copy('history'),''), decoded.replace(copy('audit'),copy('audit')+copy('audit')),
    decoded.replace('token_hash, actor_id, expires_at','actor_id, token_hash, expires_at'),
    decoded.replace('\\unrestrict fixedKey','\\unrestrict differentKey'),
    decoded.replace(copy('meta'),copy('meta')+'COMMIT;\n'),
  ])('refuses changed archive statements and controls %#',sql=>{expect(()=>selectedCopyBlocks(sql)).toThrow();});
  it('requires the exact object inventory and refuses missing, duplicate, extra or unexpected owners',()=>{
    expect(()=>validateArchiveList(toc,owner)).not.toThrow();
    const entries=toc.split('\n');
    for(const invalid of [entries.slice(1).join('\n'),toc+'\n'+entries[0],toc+`\n999; 0 0 TABLE public unrelated ${owner}`,toc.replace(owner,'postgres')]){
      expect(()=>validateArchiveList(invalid,owner)).toThrow();
    }
  });
  it('builds trusted DDL without loading a second meta row or granting source access',()=>{
    const migration=readFileSync('prisma/disposable-main-adapter.sql');
    const ddl=recoveryDdl(migration,'b813e743-9f4c-4121-b8ab-b01ca51b9335');
    expect(ddl).toContain(`CREATE SCHEMA ${schema};`);
    expect(ddl).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(ddl).not.toMatch(/INSERT INTO|^GRANT|flsd_adapter_test/m);
    expect(()=>recoveryDdl(Buffer.concat([migration,Buffer.from('\n')]),'b813e743-9f4c-4121-b8ab-b01ca51b9335')).toThrow();
  });
  it('fingerprints data and catalog structure without returning individual rows',()=>{
    const sql=manifestSql();
    for(const table of Object.keys(columns))expect(sql).toContain(`FROM ${schema}.${table} t`);
    expect(sql).toContain('sha256(convert_to');
    expect(sql).toContain('pg_get_triggerdef');
    expect(sql).toContain('pg_get_indexdef');
    expect(sql).toContain('pg_get_constraintdef');
  });
});
