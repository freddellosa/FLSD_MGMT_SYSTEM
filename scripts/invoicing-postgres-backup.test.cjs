'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {bundlePattern,checkManifest,checkToc,dueAt,identityOid,identitySql,inventory,manifestSql,retain,sameManifest,tables}=require('./invoicing-postgres-backup.cjs');

test('maps recovery after restart to the latest Manila date and independent slot',()=>{
  const beforeMidnight=Date.parse('2026-11-20T15:59:00Z');
  assert.equal(new Date(dueAt('midnight',beforeMidnight)).toISOString(),'2026-11-19T16:00:00.000Z');
  assert.equal(new Date(dueAt('noon',beforeMidnight)).toISOString(),'2026-11-20T04:00:00.000Z');
  assert.equal(new Date(dueAt('midnight',beforeMidnight+120000)).toISOString(),'2026-11-20T16:00:00.000Z');
  assert.equal(new Date(dueAt('noon',beforeMidnight+120000)).toISOString(),'2026-11-20T04:00:00.000Z');
});

test('pins pilot identity and checks exact integer OIDs and required table grants',()=>{
  assert.equal(identityOid('4294967295'),'4294967295');
  for(const value of ['0','4294967296','1;SELECT 1',null]) assert.throws(()=>identityOid(value));
  const sql=identitySql({databaseOid:'100',roleOid:'101'});
  assert.match(sql,/flsd_pilot_validation/);
  assert.match(sql,/inet_server_port\(\)=55437/);
  assert.match(sql,/current_database\(\)\)=100::oid/);
  assert.match(sql,/oid<>101::oid/);
  assert.match(sql,/has_any_column_privilege/);
  assert.match(manifestSql(),/public\.pilot_attachments/);
  assert.match(manifestSql(),/public\.pilot_workspace/);
  assert.equal(tables.length,22);
});
test('checks all exact table manifests, including same-count differences',()=>{
  const manifest=Object.fromEntries(tables.map(t=>[t,[1,'a'.repeat(64)]]));
  assert.equal(sameManifest(manifest,structuredClone(manifest)),true);
  const altered=structuredClone(manifest);
  altered.pilot_attachments[1]='b'.repeat(64);
  assert.equal(sameManifest(manifest,altered),false);
  delete altered.pilot_meta;
  assert.throws(()=>checkManifest(altered),/TABLE_MANIFEST_INVALID/);
});
test('checks pg_restore listings for all tables, data entries and foreign relations',()=>{
  const entries=tables.flatMap((t,i)=>[
    `${i+1}; 1259 ${200+i} TABLE public ${t} owner`,
    `${100+i}; 0 ${200+i} TABLE DATA public ${t} owner`,
  ]);
  assert.doesNotThrow(()=>checkToc(entries.join('\r\n')));
  assert.throws(()=>checkToc(entries.slice(1).join('\n')),/ARCHIVE_INVENTORY_INVALID/);
  assert.throws(()=>checkToc([...entries,'999; 1259 999 TABLE other foreign_table owner'].join('\n')),/ARCHIVE_SCOPE_INVALID/);
});
test('retention preserves rehearsal archives, latest managed bundles and unrelated files',()=>{
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'flsd-backup-test-'));
  try {
    function add(day,protect=false,tamper=false) {
      const bundle=`flsd_pilot_validation-202601${String(day).padStart(2,'0')}T000000000Z-deadbeef`;
      assert.match(bundle,bundlePattern);
      const folder=path.join(directory,bundle);
      fs.mkdirSync(folder);
      fs.writeFileSync(path.join(folder,'database.dump'),tamper?'y':'x');
      fs.writeFileSync(path.join(folder,'archive.toc'),'toc');
      fs.writeFileSync(path.join(folder,'manifest.json'),JSON.stringify({job:'flsd-pilot-backup-v1',database:'flsd_pilot_validation',
        bundle,slot:'midnight',completedAt:`2026-01-${String(day).padStart(2,'0')}T00:00:00Z`,archiveBytes:1,protect,
        sha256:crypto.createHash('sha256').update('x').digest('hex')}));
      return folder;
    }
    const prune=add(1),control=add(2,true),tamper=add(3,false,true),first=add(4),second=add(5);
    const prior=path.join(directory,'prior-evidence.dump');
    fs.writeFileSync(prior,'prior');
    assert.equal(inventory(directory).length,5);
    retain(directory,Date.parse('2026-03-01T00:00:00Z'));
    assert.equal(fs.existsSync(prune),false);
    for(const file of [control,tamper,first,second,prior]) assert.equal(fs.existsSync(file),true);
  } finally {
    // The test owns this generated, OS-verified temp directory.
    fs.rmSync(directory,{recursive:true,force:true});
  }
});
