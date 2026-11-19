import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';

const attachments=process.argv[2]==='--fresh-fictional-attachment-restore';
const source=attachments?'flsd_pilot_qa_phase_payments':'flsd_batch7_receipt_browser_rehearsal';
const target=attachments?'flsd_phase_payments_attachment_restore':'flsd_batch7_receipt_restore_rehearsal';
const schema=attachments?'public':'flsd_batch7_commit_rehearsal';
const sourceOid=attachments?'26236':'28592';
const archive=resolve(attachments?'artifacts/batch7-attachment-recovery/archive.dump':'artifacts/batch7-office-recovery/archive.dump');
const directory=resolve(archive,'..');
const receipt=resolve(directory,'recovery.json');
let stage='PREFLIGHT';

function main(){
  assert.equal(resolve('.'),'D:\\FLSD-Batch7-Validation');
  assert.ok(attachments||process.argv[2]==='--fresh-fictional-restore');
  assert.ok(!existsSync(directory));
  assert.equal(realpathSync('artifacts').toLowerCase(),resolve('artifacts').toLowerCase());
  const evidence=JSON.parse(readFileSync(attachments?'artifacts/qa-remediation-phase-payments/connected-phase-payments.json':
    'artifacts/batch7-receipt-browser-verified.json','utf8'));
  assert.ok(evidence.synthetic&&evidence.databaseOid===sourceOid&&(attachments||evidence.writerNoLogin));
  const config=JSON.parse(readFileSync('.pilot/maintenance.json','utf8'));
  assert.ok(config.marker==='FLSD_ISOLATED_PILOT_ONLY'&&config.host==='127.0.0.1'&&config.port===55437&&
    config.database==='flsd_pilot_validation'&&config.user==='flsd_pilot_admin'&&typeof config.password==='string'&&config.password);
  const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>!/^PG/i.test(key)));
  Object.assign(env,{PGPASSWORD:config.password,PGHOSTADDR:config.host,PGCONNECT_TIMEOUT:'5'});
  const args=['-h',config.host,'-p','55437','-U',config.user,'-w'];
  function run(program,params,input,readOnly=false){
    const result=spawnSync('C:\\Program Files\\PostgreSQL\\18\\bin\\'+program+'.exe',params,{
      env:{...env,PGOPTIONS:'-c statement_timeout=25000 -c lock_timeout=5000'+(readOnly?' -c default_transaction_read_only=on':'')},
      input,encoding:'utf8',maxBuffer:10*1024*1024,timeout:35000,windowsHide:true,
    });
    if(result.status!==0)throw Error(result.stderr?.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]??program.toUpperCase()+'_FAILED');
    return result.stdout.trim();
  }
  function pg(db,input,readOnly=false){
    return run('psql',['-X','-qAt','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose',...args,'-d',db,'-f','-'],input,readOnly);
  }
  function guard(db,oid,marker){
    return `DO $$ BEGIN
      IF current_database()<>'${db}' OR current_user<>'flsd_pilot_admin'
         OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet OR inet_server_port() IS DISTINCT FROM 55437
         OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND oid=${oid}
                       AND shobj_description(oid,'pg_database')='${marker}')
      THEN RAISE EXCEPTION 'Recovery target identity refused'; END IF; END $$;`;
  }
  const sourceGuard=guard(source,sourceOid,attachments?'ISOLATED_PHASE_PAYMENTS_QA_ONLY':'FLSD_BATCH7_RECEIPT_BROWSER_ONLY');
  const targetMark='FLSD_BATCH7_RECOVERY_RESTORE_ONLY';
  function snapshot(db,guardSql){
    return pg(db,`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;${guardSql}
      SELECT format('SELECT jsonb_build_object(%L,%L,%L,count(*),%L,encode(sha256(convert_to(coalesce(string_agg(to_jsonb(t)::text,E''\\n'' ORDER BY to_jsonb(t)::text COLLATE "C"),''''),''UTF8'')),''hex'')) FROM %I.%I AS t;',
        'table',c.relname,'rows','sha256',n.nspname,c.relname)
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='${schema}' AND c.relkind='r' ORDER BY c.relname COLLATE "C" \\gexec
      ROLLBACK;`,true).split(/\r?\n/).filter(Boolean).map(line=>JSON.parse(line));
  }
  function constraints(db,guardSql){
    return pg(db,`BEGIN READ ONLY;${guardSql}
      SELECT encode(sha256(convert_to(jsonb_agg(jsonb_build_array(c.relname,p.conname,pg_get_constraintdef(p.oid))
        ORDER BY c.relname,p.conname)::text,'UTF8')),'hex')
      FROM pg_constraint p JOIN pg_class c ON c.oid=p.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}';
      ROLLBACK;`,true);
  }
  stage='SOURCE_SNAPSHOT';
  const oldData=snapshot(source,sourceGuard);
  assert.ok(attachments?oldData.some(row=>row.table==='pilot_attachments'&&row.rows>=3):
    oldData.length>=25&&oldData.some(row=>row.table==='Payment'&&row.rows===4));
  const constraintsSha256=constraints(source,sourceGuard);
  assert.match(constraintsSha256,/^[a-f0-9]{64}$/);
  mkdirSync(directory);
  stage='CUSTOM_ARCHIVE';
  run('pg_dump',[...args,'-d',source,'--schema='+schema,'--format=custom','--no-owner','--no-acl','--file='+archive],undefined,true);
  const toc=run('pg_restore',['--list',archive]);
  assert.ok(toc.includes('TABLE DATA')&&toc.includes(schema));
  const archiveSha256=createHash('sha256').update(readFileSync(archive)).digest('hex');
  writeFileSync(resolve(directory,'archive.toc.txt'),toc+'\n',{flag:'wx'});
  assert.deepEqual(snapshot(source,sourceGuard),oldData);
  stage='RESTORE_DATABASE';
  const oid=pg(source,`${sourceGuard}
    DO $$ BEGIN IF EXISTS(SELECT 1 FROM pg_database WHERE datname='${target}') THEN RAISE EXCEPTION 'Restore target exists'; END IF; END $$;
    CREATE DATABASE ${target} TEMPLATE template0 ALLOW_CONNECTIONS false;
    REVOKE CONNECT,TEMPORARY ON DATABASE ${target} FROM PUBLIC;
    COMMENT ON DATABASE ${target} IS '${targetMark}';
    ALTER DATABASE ${target} ALLOW_CONNECTIONS true;
    SELECT oid FROM pg_database WHERE datname='${target}';`);
  assert.match(oid,/^[1-9][0-9]{0,9}$/);
  const restoreGuard=guard(target,oid,targetMark);
  const sql=run('pg_restore',['--no-owner','--no-acl','--exit-on-error','--file=-',archive]);
  assert.ok(!/^\s*\\(?:connect|c)\b/im.test(sql));
  const publicSchema=attachments&&/^CREATE SCHEMA public;/m.test(sql)?'DROP SCHEMA public;':'REVOKE ALL ON SCHEMA public FROM PUBLIC;';
  pg(target,`BEGIN;${restoreGuard} ${publicSchema}
    ${sql}
    REVOKE ALL ON SCHEMA public FROM PUBLIC;
    COMMIT;`);
  stage='RECONCILIATION';
  assert.deepEqual(snapshot(target,restoreGuard),oldData);
  assert.equal(constraints(target,restoreGuard),constraintsSha256);
  const amounts=attachments?['SELECT 100*sum(amount) FROM public.pilot_trips WHERE NOT archived',
    'SELECT 100*sum(amount-reversed) FROM public.pilot_allocations']:
    [`SELECT 100*sum(payable) FROM ${schema}.receivable`,`SELECT 100*sum(amount) FROM ${schema}."PaymentAllocation"`];
  const closingReceivablesCentavos=attachments?'15000':'3198';
  assert.equal(pg(target,`BEGIN READ ONLY;${restoreGuard}
    SELECT ((${amounts[0]})-(${amounts[1]}))::bigint; ROLLBACK;`,true),closingReceivablesCentavos);
  const result={status:attachments?'BATCH7_ATTACHMENT_ARCHIVE_RESTORED':'BATCH7_OFFICE_ARCHIVE_RESTORED',
    synthetic:true,sourceOid,restoreOid:oid,archiveSha256,constraintsSha256,tables:oldData.length,
    closingReceivablesCentavos,tableDigests:oldData};
  writeFileSync(receipt,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify({...result,tableDigests:undefined}));
}
try{main();}catch(error){
  console.error(JSON.stringify({status:'BATCH7_RECOVERY_STOPPED',stage,code:error.code??(/^[A-Z0-9_]+$/.test(error.message)?error.message:undefined)}));
  process.exitCode=1;
}
