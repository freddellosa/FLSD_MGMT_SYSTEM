import assert from 'node:assert/strict';
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {createHash,createHmac,pbkdf2Sync,randomBytes,randomUUID} from 'node:crypto';
import {existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {resolve} from 'node:path';
import {PrismaClient} from '@prisma/client';
import {chromium} from 'playwright';
import {createCandidatePostgresCustomerReceipt} from '../src/lib/production/candidate-postgres-customer-receipt';
import {encodeWire} from '../src/lib/pilot/wire';
import {officeReceiptCookie} from '../src/lib/production/candidate-office-receipt-http';

const browser=process.argv[2]==='--verify-fictional-receipt-browser';
const office=browser||process.argv[2]==='--verify-fictional-office';
const port=browser?3106:3105;
const database=browser?'flsd_batch7_receipt_browser_rehearsal':office?'flsd_batch7_receipt_office_rehearsal':'flsd_batch7_receipt_adapter_rehearsal';
const schema='flsd_batch7_commit_rehearsal';
const writer=browser?'flsd_batch7_receipt_browser_writer':office?'flsd_batch7_receipt_office_writer':'flsd_batch7_receipt_adapter_writer';
const marker=browser?'FLSD_BATCH7_RECEIPT_BROWSER_ONLY':office?'FLSD_BATCH7_RECEIPT_OFFICE_ONLY':'FLSD_BATCH7_RECEIPT_ADAPTER_ONLY';
const evidence=browser?'artifacts/batch7-receipt-browser-verified.json':office?'artifacts/batch7-receipt-office-verified.json':'artifacts/batch7-receipt-adapter-verified.json';
const old=(tail:string)=>'70000000-0000-4000-8000-0000000000'+tail;
const secondInvoice='71000000-0000-4000-8000-000000000005';
let stage='PREFLIGHT';

function verifier(password:string) {
  const salt=randomBytes(16),key=pbkdf2Sync(password,salt,4096,32,'sha256');
  const derive=(label:string)=>createHmac('sha256',key).update(label).digest();
  return 'SCRAM-SHA-256$4096:'+salt.toString('base64')+'$'+
    createHash('sha256').update(derive('Client Key')).digest('base64')+':'+derive('Server Key').toString('base64');
}

async function main() {
  assert.equal(resolve('.'),'D:\\FLSD-Batch7-Validation');
  assert.ok(office||process.argv[2]==='--verify-fictional-adapter');
  assert.ok(!existsSync(evidence));
  const build=resolve(browser?'artifacts/qa-batch7-receipt-browser':'artifacts/qa-batch7-office');
  if(office){
    assert.equal(realpathSync(build).toLowerCase(),build.toLowerCase());
    assert.ok(existsSync(resolve(build,'.next-review/BUILD_ID')));
    await new Promise<void>((available,reject)=>{
      const probe=createServer().once('error',reject);
      probe.listen(port,'127.0.0.1',()=>probe.close(error=>error?reject(error):available()));
    });
  }
  const receipt=JSON.parse(readFileSync(browser?'artifacts/batch7-receipt-browser-bootstrap.json':office?'artifacts/batch7-receipt-office-bootstrap.json':'artifacts/batch7-receipt-adapter-bootstrap.json','utf8'));
  assert.ok(receipt.synthetic && receipt.retiredWriter && receipt.status==='BATCH7_MULTI_INVOICE_SCHEMA_REHEARSED');
  const oid=String(receipt.databaseOid);
  assert.match(oid,/^[1-9][0-9]{0,9}$/);
  const config=JSON.parse(readFileSync('.pilot/maintenance.json','utf8'));
  assert.ok(config.marker==='FLSD_ISOLATED_PILOT_ONLY'&&config.host==='127.0.0.1'&&config.port===55437&&
    config.database==='flsd_pilot_validation'&&config.user==='flsd_pilot_admin'&&typeof config.password==='string'&&config.password);
  const env={...process.env};
  for (const key of Object.keys(env)) if (/^PG/i.test(key)) delete env[key];
  Object.assign(env,{PGPASSWORD:config.password,PGHOSTADDR:config.host,PGCONNECT_TIMEOUT:'5',
    PGOPTIONS:'-c statement_timeout=15000 -c lock_timeout=5000'});
  function pg(input:string) {
    const result=spawnSync('C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe',
      ['-X','-qAt','-w','-v','ON_ERROR_STOP=1','-h',config.host,'-p','55437','-U',config.user,'-d',database,'-f','-'],
      {env,input,encoding:'utf8',timeout:20000,windowsHide:true});
    if(result.status!==0)throw Error(result.stderr.match(/ERROR:\s+([A-Z0-9]{5}):/)?.[1]??'PSQL_FAILED');
    return result.stdout.trim();
  }
  const guard=`DO $$ BEGIN
    IF current_database()<>'${database}' OR current_user<>'flsd_pilot_admin'
       OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet OR inet_server_port() IS DISTINCT FROM 55437
       OR NOT EXISTS (SELECT 1 FROM pg_database WHERE datname=current_database() AND oid=${oid} AND shobj_description(oid,'pg_database')='${marker}')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${writer}' AND shobj_description(oid,'pg_authid')='${marker}')
    THEN RAISE EXCEPTION 'Receipt adapter rehearsal refused'; END IF; END $$;
    SET LOCAL search_path TO ${schema}, pg_catalog;`;
  const read=()=>JSON.parse(pg(`BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;${guard}
    SELECT json_build_object(
      'payments',(SELECT count(*) FROM "Payment"),
      'scopes',(SELECT count(*) FROM operation_scope),
      'events',(SELECT count(*) FROM "PaymentAllocationEvent"),
      'audits',(SELECT count(*) FROM "AuditEvent"),
      'operations',(SELECT count(*) FROM "FinancialOperation"),
      'allocated',(SELECT (100*sum(amount))::bigint::text FROM "PaymentAllocation"),
      'opening',(SELECT (100*amount)::bigint::text FROM "PaymentAllocation" WHERE "paymentId"='${old('06')}'),
      'reserved',(SELECT count(*) FROM invoice_reservation));
    ROLLBACK;`));
  const before=read();
  assert.deepEqual(before,{payments:2,scopes:3,events:4,audits:2,operations:3,allocated:'4002',opening:'1001',reserved:1});
  const token=randomBytes(32).toString('hex'), password=randomBytes(32).toString('hex'), sessionId=randomUUID();
  const tokenDigest=createHash('sha256').update(token).digest('hex');
  const viewerToken=randomBytes(32).toString('hex'), viewerId=randomUUID(), viewerSessionId=randomUUID();
  const viewerDigest=createHash('sha256').update(viewerToken).digest('hex');
  stage='SYNTHETIC_AUTHORIZATION';
  const [schemaOid,roleOid]=pg(`\\set VERBOSITY verbose
    BEGIN;${guard}
    ALTER TABLE staff_authorization ADD COLUMN lock_guard boolean NOT NULL DEFAULT false CHECK(NOT lock_guard);
    GRANT CONNECT ON DATABASE ${database} TO ${writer};
    GRANT SELECT (staff_id,revision), UPDATE (lock_guard) ON staff_authorization TO ${writer};
    GRANT SELECT (id,active,role) ON "StaffUser" TO ${writer};
    GRANT SELECT ON staff_session,payment_scope,operation_scope,"FinancialOperation","OfficialInvoice",
      receivable,invoice_attribution,invoice_reservation,"PaymentAllocation" TO ${writer};
    ${office?`GRANT SELECT ("customerId",state,"paymentMethod",reference) ON "Payment" TO ${writer};`:''}
    ${browser?`GRANT SELECT (id,name) ON "Customer" TO ${writer};
      UPDATE "OfficialInvoice" SET "serialNumber"='QA-001' WHERE id='${old('05')}';
      UPDATE "OfficialInvoice" SET "serialNumber"='QA-002' WHERE id='${secondInvoice}';`:''}
    INSERT INTO staff_session (id,staff_id,token_digest,issued_at,expires_at)
      VALUES ('${sessionId}','${old('01')}',decode('${tokenDigest}','hex'),now(),now()+interval '10 minutes');
    ${office?`INSERT INTO "StaffUser" (id,email,"displayName","passwordHash",role,"updatedAt")
      VALUES ('${viewerId}','office-viewer@example.invalid','Fictional Viewer','DISABLED','VIEWER',now());
      INSERT INTO staff_authorization(staff_id) VALUES ('${viewerId}');
      INSERT INTO staff_session(id,staff_id,token_digest,issued_at,expires_at)
      VALUES ('${viewerSessionId}','${viewerId}',decode('${viewerDigest}','hex'),now(),now()+interval '10 minutes');`:''}
    ALTER TABLE "AuditEvent" ADD CONSTRAINT synthetic_receipt_failure CHECK (reason IS DISTINCT FROM 'FORCED-SYNTHETIC-FAILURE');
    ALTER ROLE ${writer} LOGIN PASSWORD '${verifier(password)}' VALID UNTIL '${new Date(Date.now()+600000).toISOString()}';
    SELECT n.oid,r.oid FROM pg_namespace n CROSS JOIN pg_roles r WHERE n.nspname='${schema}' AND r.rolname='${writer}';
    COMMIT;`).split('|');
  const client=new PrismaClient({log:[],datasources:{db:{
    url:'postgresql://'+writer+':'+password+'@127.0.0.1:55437/'+database+'?connection_limit=3&connect_timeout=5',
  }}});
  const identity={databaseOid:oid,schemaOid,roleOid};
  let server:ChildProcess|undefined;
  try {
    const record=createCandidatePostgresCustomerReceipt(client,identity,async()=>token);
    const command={
      key:'adapter-multi-invoice',customerId:old('02'),receivedCentavos:1500n,receivedDate:'2026-01-02',
      method:'BANK_TRANSFER' as const,reference:'FICTIONAL-ADAPTER-RECEIPT',
      allocations:[
        {invoiceId:old('05'),cashCentavos:1001n,withheldCentavos:0n},
        {invoiceId:secondInvoice,cashCentavos:499n,withheldCentavos:0n},
      ],
    };
    if(office){
      stage='START_OFFICE_HTTP';
      const origin='http://127.0.0.1:'+port;
      const path=origin+'/api/office/batch7-receipts';
      server=spawn(process.execPath,[resolve('node_modules/next/dist/bin/next'),'start','--hostname','127.0.0.1','--port',String(port)],{
        cwd:build,stdio:'ignore',windowsHide:true,env:{...process.env,
          FLSD_REVIEW_BUILD:'1',NEXT_TELEMETRY_DISABLED:'1',FLSD_BATCH7_OFFICE_QA:browser?'fictional-browser-loopback':'fictional-loopback',
          FLSD_BATCH7_OFFICE_PASSWORD:password,FLSD_BATCH7_OFFICE_DB_OID:oid,FLSD_BATCH7_OFFICE_SCHEMA_OID:schemaOid,
          FLSD_BATCH7_OFFICE_ROLE_OID:roleOid},
      });
      let ready=false;
      for(let attempt=0;attempt<40;attempt++){
        if(server.exitCode!==null)throw Error('OFFICE_SERVER_EXIT');
        try{if((await fetch(path,{signal:AbortSignal.timeout(1000)})).status===(browser?401:404)){ready=true;break;}}catch{}
        await new Promise(resolve=>setTimeout(resolve,250));
      }
      assert.ok(ready);
      if(browser){
        stage='OFFICE_BROWSER_AUTH_AND_LOAD';
        assert.equal((await fetch(path)).status,401);
        const edge=await chromium.launch({channel:'msedge'});
        try{
          const viewer=await edge.newContext();
          await viewer.addCookies([{name:officeReceiptCookie,value:viewerToken,url:origin,httpOnly:true,sameSite:'Strict'}]);
          const denied=await viewer.newPage();
          await denied.goto(origin+'/office/receipts');
          await denied.getByRole('alert').filter({hasText:'Receipt authorization required'}).waitFor();
          assert.equal(await denied.getByRole('table',{name:'Invoice balances'}).count(),0);
          await viewer.close();
          const billing=await edge.newContext();
          await billing.addCookies([{name:officeReceiptCookie,value:token,url:origin,httpOnly:true,sameSite:'Strict'}]);
          const first=await billing.newPage(), second=await billing.newPage();
          for(const page of [first,second]){
            await page.goto(origin+'/office/receipts');
            await page.getByLabel('Customer',{exact:true}).selectOption(old('02'));
            await page.getByRole('row').filter({hasText:'QA-002'}).getByText('₱14.99',{exact:true}).waitFor();
          }
          await first.getByLabel('Amount received (PHP)').fill('15.00');
          await first.getByLabel('Payment reference').fill('Fictional browser split');
          await first.getByLabel('Apply to invoice QA-001').fill('10.01');
          await first.getByLabel('Apply to invoice QA-002').fill('4.99');
          await second.getByLabel('Amount received (PHP)').fill('8.00');
          await second.getByLabel('Payment reference').fill('Fictional stale tab');
          await second.getByLabel('Apply to invoice QA-002').fill('8.00');
          stage='OFFICE_BROWSER_SUBMIT_AND_REFRESH';
          await first.getByRole('button',{name:'Record payment'}).click();
          await first.getByRole('status').filter({hasText:'Payment recorded'}).waitFor();
          const afterFirst=read();
          await second.getByRole('button',{name:'Record payment'}).click();
          await second.getByRole('alert').filter({hasText:'invoice balance changed'}).waitFor();
          assert.deepEqual(read(),afterFirst);
          assert.equal(await second.getByRole('button',{name:'Record payment'}).isEnabled(),false);
          await second.getByRole('button',{name:'Refresh invoice balances'}).click();
          await second.getByRole('status').filter({hasText:'Review the amounts'}).waitFor();
          await second.getByRole('row').filter({hasText:'QA-002'}).getByText('₱10.00',{exact:true}).waitFor();
          assert.equal(await second.getByLabel('Payment reference').inputValue(),'Fictional stale tab');
          assert.equal(await second.getByLabel('Apply to invoice QA-002').inputValue(),'8.00');
          await second.getByRole('button',{name:'Record payment'}).click();
          await second.getByRole('status').filter({hasText:'Payment recorded'}).waitFor();
          await second.getByRole('row').filter({hasText:'QA-002'}).getByText('₱2.00',{exact:true}).waitFor();
          await billing.close();
        }finally{await edge.close();}
        const after=read();
        assert.deepEqual(after,{payments:4,scopes:6,events:7,audits:4,operations:5,allocated:'6302',opening:'1001',reserved:1});
        const report={status:'BATCH7_OFFICE_RECEIPT_BROWSER_VERIFIED',synthetic:true,databaseOid:oid,schemaOid,roleOid,
          closingReceivablesCentavos:'3198',port,writerNoLogin:true,
          verified:['anonymous-read-denial','viewer-read-denial','authenticated-invoice-balances','multi-invoice-entry',
            'two-tab-stale-refusal','refresh-retains-draft','explicit-resubmission','updated-invoice-balance'],...after};
        stage='RETIRE_WRITER';
        server.kill();
        await client.$disconnect();
        retire();
        writeFileSync(evidence,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
        console.log(JSON.stringify(report));
        return;
      }
      const post=(value:unknown,cookie=officeReceiptCookie+'='+token,requestOrigin=origin)=>fetch(path,{
        method:'POST',headers:{origin:requestOrigin,cookie,'content-type':'application/json'},
        body:encodeWire(value),signal:AbortSignal.timeout(15000),
      });
      const submitted={...command,allocations:[
        {invoiceId:old('05'),cashCentavos:1001n,expectedOutstandingCentavos:3999n},
        {invoiceId:secondInvoice,cashCentavos:499n,expectedOutstandingCentavos:1499n},
      ]};
      stage='OFFICE_HTTP_AUTH_AND_VALIDATION';
      assert.equal((await post(submitted,'')).status,401);
      assert.equal((await post(submitted,officeReceiptCookie+'='+randomBytes(32).toString('hex'))).status,403);
      assert.equal((await post(submitted,officeReceiptCookie+'='+viewerToken)).status,403);
      assert.equal((await post(submitted,undefined,'http://127.0.0.1:3104')).status,403);
      assert.equal((await post({...submitted,actor:{id:old('01'),role:'BILLING'}})).status,400);
      assert.equal((await post({...submitted,receivedCentavos:1500})).status,400);
      assert.equal((await post({...submitted,receivedDate:'2026-02-30'})).status,422);
      assert.deepEqual(read(),before);
      stage='OFFICE_HTTP_POST_AND_REPLAY';
      const saved=await post(submitted);
      assert.equal(saved.status,201);
      const savedBody=await saved.json();
      assert.equal(savedBody.replayed,false);
      assert.equal(savedBody.allocatedCentavos.$centavos,'1500');
      const afterReceipt=read();
      const replay=await post({...submitted,allocations:[...submitted.allocations].reverse()});
      assert.equal(replay.status,200);
      assert.deepEqual(await replay.json(),{...savedBody,replayed:true});
      const fresh={...submitted,allocations:[
        {...submitted.allocations[0],expectedOutstandingCentavos:2998n},
        {...submitted.allocations[1],expectedOutstandingCentavos:1000n},
      ]};
      stage='OFFICE_HTTP_CONFLICT_AND_ROLLBACK';
      const stale=await post({...submitted,key:'office-stale',reference:'NEW STALE REFERENCE'});
      assert.equal(stale.status,409);
      assert.match((await stale.json()).error,/balance changed/);
      const duplicate=await post({...fresh,key:'office-reference-reuse',reference:' fictional-adapter-receipt '});
      assert.equal(duplicate.status,409);
      assert.match((await duplicate.json()).error,/already recorded/);
      assert.equal((await post({...fresh,key:'candidate-unbound'})).status,409);
      assert.equal((await post({...fresh,key:'office-rollback',reference:'FORCED-SYNTHETIC-FAILURE'})).status,503);
      assert.deepEqual(read(),afterReceipt);
      stage='OFFICE_HTTP_CONCURRENCY';
      const compete=(key:string)=>post({...fresh,key,reference:key,receivedCentavos:800n,
        allocations:[{invoiceId:secondInvoice,cashCentavos:800n,expectedOutstandingCentavos:1000n}]});
      assert.deepEqual((await Promise.all([compete('office-a'),compete('office-b')])).map(r=>r.status).sort(),[201,409]);
      const after=read();
      assert.deepEqual(after,{payments:4,scopes:6,events:7,audits:4,operations:5,allocated:'6302',opening:'1001',reserved:1});
      const report={status:'BATCH7_OFFICE_RECEIPT_HTTP_VERIFIED',synthetic:true,databaseOid:oid,schemaOid,roleOid,
        receiptOperation:savedBody.operationId,closingReceivablesCentavos:'3198',port,writerNoLogin:true,
        verified:['session','same-origin','wire-validation','multi-invoice','zero-write-replay','stale-balance','duplicate-reference',
          'reserved-key','rollback','concurrent-submission'],...after};
      stage='RETIRE_WRITER';
      server.kill();
      await client.$disconnect();
      retire();
      writeFileSync(evidence,JSON.stringify(report,null,2)+'\n',{flag:'wx'});
      console.log(JSON.stringify(report));
      return;
    }
    stage='AUTH_AND_REPLAY';
    await assert.rejects(createCandidatePostgresCustomerReceipt(client,identity,async()=>null)(command),/Forbidden/);
    await assert.rejects(createCandidatePostgresCustomerReceipt(client,identity,async()=>randomBytes(32).toString('hex'))(command),/Forbidden/);
    const posted=await record(command);
    assert.equal(posted.replayed,false);
    assert.equal(posted.allocatedCentavos,1500n);
    const afterReceipt=read();
    assert.deepEqual(await record({...command,allocations:[...command.allocations].reverse()}),{...posted,replayed:true});
    await assert.rejects(record({...command,key:'candidate-unbound'}),/Receipt key unavailable/);
    await assert.rejects(record({...command,reference:'Changed receipt reference'}),/Receipt key unavailable/);
    assert.deepEqual(read(),afterReceipt);
    stage='LATE_FAILURE_ROLLBACK';
    await assert.rejects(record({...command,key:'adapter-rollback',reference:'FORCED-SYNTHETIC-FAILURE'}),error=>
      (error as {meta?:{code?:string}}).meta?.code==='23514');
    assert.deepEqual(read(),afterReceipt);
    stage='COMPETING_INVOICE_CEILING';
    const compete=(key:string)=>record({...command,key,reference:key,receivedCentavos:800n,
      allocations:[{invoiceId:secondInvoice,cashCentavos:800n,withheldCentavos:0n}]});
    const outcomes=await Promise.allSettled([compete('adapter-competing-a'),compete('adapter-competing-b')]);
    assert.equal(outcomes.filter(x=>x.status==='fulfilled').length,1);
    const rejected=outcomes.find(x=>x.status==='rejected');
    assert.ok(rejected?.status==='rejected');
    assert.match(rejected.reason.message,/Invoice overallocated/);
    const after=read();
    assert.deepEqual(after,{payments:4,scopes:6,events:7,audits:4,operations:5,allocated:'6302',opening:'1001',reserved:1});
    const report={status:'BATCH7_AUTHENTICATED_RECEIPT_ADAPTER_VERIFIED',synthetic:true,databaseOid:oid,schemaOid,
      roleOid,receiptOperation:posted.operationId,closingReceivablesCentavos:(9500n-BigInt(after.allocated)).toString(),
      verified:['server-session','two-invoice-receipt','zero-write-replay','legacy-key-refusal','competing-ceiling','late-failure-rollback'],...after};
    stage='RETIRE_WRITER';
    await client.$disconnect();
    retire();
    writeFileSync(evidence,JSON.stringify({...report,writerNoLogin:true},null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify(report));
  } finally {
    server?.kill();
    if(stage!=='RETIRE_WRITER'||!existsSync(evidence)){
      await client.$disconnect();
      retire();
    }
  }
  function retire(){
    assert.equal(pg(`BEGIN;${guard}
      UPDATE staff_session SET revoked_at=statement_timestamp() WHERE id IN ('${sessionId}','${viewerSessionId}') AND revoked_at IS NULL;
      ALTER ROLE ${writer} NOLOGIN PASSWORD NULL;
      SELECT (NOT rolcanlogin)::int FROM pg_roles WHERE rolname='${writer}';COMMIT;`),'1');
  }
}
main().catch((error:unknown)=>{
  const failure=error as {code?:string;meta?:{code?:string};message?:string};
  console.error(JSON.stringify({status:'BATCH7_RECEIPT_ADAPTER_STOPPED',stage,
    code:failure.meta?.code??failure.code??(/^[0-9A-Z_]+$/.test(failure.message??'')?failure.message:undefined)}));
  process.exitCode=1;
});
