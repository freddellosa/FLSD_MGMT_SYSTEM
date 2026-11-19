import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash,createHmac,pbkdf2Sync} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {readFileSync,writeFileSync,existsSync,mkdirSync,unlinkSync,realpathSync} from 'node:fs';
import {join,resolve} from 'node:path';
import {hashPassword} from '../src/lib/pilot/password';
import {businessDate} from '../src/lib/domain/business-date';
import {encodeWire,decodeWire} from '../src/lib/pilot/wire';
import type {DemoState} from '../src/lib/demo/store';

const root='D:\\FLSD-Batch7-Validation';
const phasePayments=process.argv[2]==='--fresh-fictional-phase-payments';
const phaseC=phasePayments||process.argv[2]==='--fresh-fictional-phase-c';
const phaseB=phaseC||process.argv[2]==='--fresh-fictional-phase-b';
const suffix=phasePayments?'payments':phaseC?'c':phaseB?'b':'a';
const stage=join(root,'artifacts','qa-remediation-phase-'+suffix);
const source='flsd_pilot_validation';
const candidate='flsd_pilot_qa_phase_'+suffix;
const writer=candidate+'_app';
const marker='ISOLATED_PHASE_'+suffix.toUpperCase()+'_QA_ONLY';
const admin='flsd_pilot_admin';
const password=randomBytes(25).toString('hex');
const port=phasePayments?3101:phaseC?3099:phaseB?3097:3096;
const origin='http://127.0.0.1:'+port;
const phaseEvidence=join(stage,'connected-phase-'+suffix+'.json');
type Actor={id:string;name:string;email:string;role:string;active:boolean;version:number};
type State={actor:Actor;revision:number;state:DemoState};
let phase='PREFLIGHT';

function verifier(value:string){
  const salt=randomBytes(16),key=pbkdf2Sync(value,salt,4096,32,'sha256');
  const derive=(label:string)=>createHmac('sha256',key).update(label).digest();
  return 'SCRAM-SHA-256$4096:'+salt.toString('base64')+'$'+createHash('sha256').update(derive('Client Key')).digest('base64')+':'+derive('Server Key').toString('base64');
}
async function waitForCandidate(){
  for(let n=0;n<30;n++){
    try {if((await fetch(origin+'/pilot',{signal:AbortSignal.timeout(1000),redirect:'error'})).ok)return;}catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  throw new Error();
}
async function main(){
  if((!phaseB&&process.argv[2]!=='--fresh-fictional-phase-a')||resolve('.')!==root||existsSync(phaseEvidence)||
    !existsSync(join(stage,'.next-review','BUILD_ID'))||realpathSync(stage).toLowerCase()!==stage.toLowerCase())throw Error();
  const c=JSON.parse(readFileSync(join(root,'.pilot','maintenance.json'),'utf8'));
  if(c.marker!=='FLSD_ISOLATED_PILOT_ONLY'||c.host!=='127.0.0.1'||c.port!==55437||c.database!==source||c.user!==admin||!c.password)throw Error();
  const env={...process.env};
  for(const key of Object.keys(env)){if(/^PG/i.test(key))delete env[key];}
  Object.assign(env,{PGPASSWORD:c.password,PGCONNECT_TIMEOUT:'5',PGHOSTADDR:'127.0.0.1',
    PGOPTIONS:'-c statement_timeout=20000 -c lock_timeout=5000'});
  const pg=(database:string,sql:string)=>execFileSync('C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe',
    ['-X','-qAt','-w','-v','ON_ERROR_STOP=on','-h','127.0.0.1','-p','55437','-U',admin,'-d',database,'-f','-'],
    {env,input:sql+'\n',encoding:'utf8',stdio:['pipe','pipe','pipe'],windowsHide:true,timeout:30000}).trim();
  const sourceGuard=`DO $guard$ BEGIN
  IF current_database()<>'flsd_pilot_validation' OR current_user<>'flsd_pilot_admin'
    OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet OR inet_server_port() IS DISTINCT FROM 55437
    OR (SELECT oid FROM pg_database WHERE datname=current_database())<>16384
    OR NOT EXISTS(SELECT 1 FROM public.pilot_meta WHERE id=1 AND schema_version=3 AND marker='FLSD_ISOLATED_PILOT_ONLY')
  THEN RAISE EXCEPTION 'Pilot identity refused'; END IF;
  END $guard$;`;
  phase='FRESH_CANDIDATE';
  const oid=pg(source,sourceGuard+`
  DO $new$ BEGIN
    IF EXISTS(SELECT 1 FROM pg_database WHERE datname='${candidate}')
      OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${writer}') THEN RAISE EXCEPTION 'Candidate already exists'; END IF;
  END $new$;
  CREATE ROLE ${writer} NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  COMMENT ON ROLE ${writer} IS '${marker}';
  CREATE DATABASE ${candidate} TEMPLATE template0 ALLOW_CONNECTIONS false;
  REVOKE CONNECT,TEMPORARY ON DATABASE ${candidate} FROM PUBLIC;
  COMMENT ON DATABASE ${candidate} IS '${marker}';
  GRANT CONNECT ON DATABASE ${candidate} TO ${writer};
  ALTER DATABASE ${candidate} ALLOW_CONNECTIONS true;
  SELECT oid FROM pg_database WHERE datname='${candidate}';`);
  assert.match(oid,/^[1-9][0-9]+$/);
  const candidateGuard=`DO $scope$ BEGIN
  IF current_database()<>'${candidate}' OR current_user<>'${admin}' OR inet_server_port() IS DISTINCT FROM 55437
    OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND oid=${oid}::oid
      AND shobj_description(oid,'pg_database')='${marker}')
  THEN RAISE EXCEPTION 'Candidate identity refused'; END IF;
  END $scope$;`;
  const managerId=randomUUID(),ownerId=randomUUID(),opsId=randomUUID();
  const ownerEmail='phase-a-owner@flsd.test',adminEmail='phase-a-admin@flsd.test';
  const opsEmail='phase-operations@flsd.test';
  const ownerPassword=randomBytes(24).toString('hex'),adminPassword=randomBytes(24).toString('hex'),opsPassword=randomBytes(24).toString('hex');
  const [ownerHash,adminHash,opsHash]=await Promise.all([hashPassword(ownerPassword),hashPassword(adminPassword),hashPassword(opsPassword)]);
  const migrations=['001-initial.sql','002-master-relations.sql','003-active-vehicle-plates.sql'];
  if(phasePayments)migrations.push('004-customer-receipts.sql');
  const ddl=migrations.map(file=>
    readFileSync(join(root,'prisma','pilot',file),'utf8')).join('\n').replaceAll('flsd_pilot_app',writer);
  try {
    pg(candidate,candidateGuard+'\n'+ddl+`
    INSERT INTO public.pilot_users(id,email,name,role,password_hash) VALUES
      ('${ownerId}','${ownerEmail}','Fictional Phase A Owner','OWNER','${ownerHash}'),
      ('${managerId}','${adminEmail}','Fictional Phase A Admin','ADMIN','${adminHash}'),
      ('${opsId}','${opsEmail}','Fictional Operations','OPERATIONS','${opsHash}');
    GRANT USAGE ON SCHEMA public TO ${writer};
    GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA public TO ${writer};
    ALTER ROLE ${writer} LOGIN PASSWORD '${verifier(password)}' VALID UNTIL '${new Date(Date.now()+600000).toISOString()}';`);
    phase='CANDIDATE_START';
    const dataDir=join(stage,'.pilot');
    mkdirSync(dataDir);
    const authFile=join(dataDir,'runtime.json');
    const sid=execFileSync('whoami.exe',['/user','/fo','csv','/nh'],{encoding:'utf8'}).match(/S-1-5-[0-9-]+/)?.[0];
    assert.ok(sid);
    execFileSync('icacls.exe',[dataDir,'/inheritance:r','/grant:r','*'+sid+':(OI)(CI)F','*S-1-5-18:(OI)(CI)F'],{stdio:'ignore'});
    writeFileSync(authFile,JSON.stringify({marker:c.marker,host:'127.0.0.1',port:55437,database:candidate,user:writer,password}),{flag:'wx'});
    const child=spawn(process.execPath,[join(root,'node_modules','next','dist','bin','next'),'start','--hostname','127.0.0.1','--port',String(port)],
      {cwd:stage,env:{...process.env,FLSD_REVIEW_BUILD:'1',NEXT_TELEMETRY_DISABLED:'1'},windowsHide:true,stdio:'ignore'});
    try {
      await waitForCandidate();
      if(child.exitCode!==null)throw Error();
      async function call<T>(route:string,method='GET',cookie='',body?:unknown){
        const response=await fetch(origin+'/api/pilot/'+route,{method,redirect:'error',signal:AbortSignal.timeout(10000),
          headers:{origin,cookie,'content-type':'application/json'},body:body===undefined?undefined:encodeWire(body)});
        return {status:response.status,result:decodeWire<T>(await response.text()),cookie:response.headers.get('set-cookie')?.split(';')[0]};
      }
      phase='CONNECTED_S1';
      const owner=await call<{actor:Actor}>('login','POST','',{email:ownerEmail,password:ownerPassword});
      const manager=await call<{actor:Actor}>('login','POST','',{email:adminEmail,password:adminPassword});
      assert.equal(owner.result.actor.id,ownerId);
      assert.equal(manager.result.actor.id,managerId);
      const account={id:ownerId,version:1,name:'Fictional Phase A Owner',email:ownerEmail,active:true,role:'OWNER'};
      for(const fields of [{name:'Unauthorized edit'},{active:false},{role:'VIEWER'},
        {password:randomBytes(20).toString('hex')},{...manager.result.actor,role:'OWNER'},{id:undefined,version:undefined,role:'OWNER',password:'Fictional candidate test only'}]){
        assert.equal((await call('users','POST',manager.cookie,{...account,...fields,operationId:randomUUID()})).status,403);
      }
      const listed=await call<{users:Actor[]}>('users','GET',owner.cookie);
      const savedOwner=listed.result.users.find(u=>u.id===ownerId);
      assert.equal(savedOwner?.name,account.name);assert.equal(savedOwner.active,true);assert.equal(savedOwner.version,1);
      const cookie=owner.cookie!;
      let current=(await call<State>('workspace','GET',cookie)).result;
      async function command(action:unknown,status=200){
        const operationId=randomUUID();
        const response=await call<State>('workspace','POST',cookie,{operationId,revision:current.revision,action});
        assert.equal(response.status,status);
        if(status===200)current=response.result;
        else{
          const after=(await call<State>('workspace','GET',cookie)).result;
          assert.equal(after.revision,current.revision);
          assert.deepEqual(after.state,current.state);
        }
      }
      phase='CONNECTED_FINANCIAL_GUARDS';
      await command({type:'SAVE_VEHICLE',vehicle:{plate:'QA-PHASE-A',model:'Fictional van',capacity:'10',notes:''}});
      await command({type:'SAVE_DRIVER',driver:{name:'Fictional driver',phone:'',license:'',notes:''}});
      const vehicle=current.state.vehicles[0].label,driver=current.state.drivers[0].label;
      const today=businessDate();
      const earlier=new Date(Date.parse(today)-86400000).toISOString().slice(0,10);
      const later=new Date(Date.parse(today)+86400000).toISOString().slice(0,10);
      const schedule={startDate:earlier,startTime:'23:00',endDate:today,endTime:'02:00'};
      await command({type:'CREATE_TRIP',trip:{customerId:'accenture',date:earlier,workflow:'CORPORATE',
        amount:30000n,vehicle,driver,itinerary:'Fictional Phase A service',schedule}});
      const trip=current.state.trips[0];
      await command({type:'CREATE_SOA',tripIds:[trip.id]});
      const soaId=current.state.documents[0].id;
      await command({type:'FINALIZE_SOA',soaId,expectedVersion:1});
      const create={type:'CREATE_INVOICE',soaId,expectedSoaVersion:2};
      await command({...create,invoiceDate:earlier},400);
      await command({...create,invoiceDate:today});
      const invoice=current.state.documents.at(-1)!;
      await command({type:'SETTLE_INVOICE',invoiceId:invoice.id,expectedVersion:1,reference:'Fictional receipt',
        method:'BANK_TRANSFER',receivedDate:later,allocations:[{tripId:trip.id,amount:30000n,expectedBalance:30000n}]},400);
      const edit={type:'EDIT_TRIP',tripId:trip.id,expectedVersion:1,edit:{origin:'',itinerary:'Fictional Phase A service',
        vehicle,driver,operationalStatus:'COMPLETED',passengers:'',remarks:'Fictional',reason:'Fictional correction',
        schedule:{...schedule,endTime:'03:00'}}};
      await command(edit,400);
      const cancel={type:'CANCEL_INVOICE',invoiceId:invoice.id,expectedVersion:1,reason:'Fictional cancellation'};
      await command(cancel,400);
      await command({...cancel,confirmedInvoiceNumber:invoice.invoiceNumber});
      await command(edit);
      assert.equal(current.state.payments.length,0);
      assert.equal(current.state.documents.at(-1)?.invoiceNumber,invoice.invoiceNumber);
      assert.equal(current.state.documents.at(-1)?.invoiceState,'CANCELLED');
      const verified=['S1','D1','D2','D11','D12'];
      let paymentReconciliation: Record<string,string>|undefined;
      if(phaseB){
        phase='CONNECTED_WORKFLOW';
        const draft=current.state.documents.find(d=>d.id===soaId)!;
        const ops=await call<{actor:Actor}>('login','POST','',{email:opsEmail,password:opsPassword});
        assert.equal(ops.result.actor.id,opsId);
        const scoped=await call<State>('workspace','GET',ops.cookie);
        assert.equal(scoped.result.state.documents.length,1);
        assert.equal(scoped.result.state.documents[0].id,draft.id);
        assert.equal(scoped.result.state.documents[0].amountSnapshot,30000n);
        assert.equal(scoped.result.state.trips[0].amount,30000n);
        assert.equal(scoped.result.state.payments.length,0);
        const voidDraft={type:'VOID_SOA',soaId:draft.id,expectedVersion:draft.version,reason:'Release fictional trip'};
        assert.equal((await call('workspace','POST',ops.cookie,{
          operationId:randomUUID(),revision:scoped.result.revision,action:voidDraft,
        })).status,403);
        await command(voidDraft);
        assert.equal(current.state.documents.find(d=>d.id===soaId)?.stage,'VOIDED');
        await command({type:'CREATE_SOA',tripIds:[trip.id]});
        const released=pg(candidate,candidateGuard+`
          SELECT current_membership FROM public.pilot_document_trips WHERE document_id='${soaId}';`);
        assert.equal(released,'f');
        const input={name:'Fictional tax fixture',email:'',phone:'',contact:'',address:''};
        await command({type:'SAVE_CUSTOMER',customer:{...input,tin:'abc'}},400);
        await command({type:'SAVE_CUSTOMER',customer:{...input,tin:'123-456-789-000'}});
        verified.push('D3','D4_TIN','D13_API','D14_API');
      }
      if(phaseC){
        phase='CONNECTED_TERMS_AND_RELEASE_CHECKS';
        const customer=current.state.customers.find(c=>c.id==='accenture')!;
        await command({type:'CATALOG_STATE',kind:'CUSTOMER',id:customer.id,expectedVersion:customer.version,remove:true},400);
        await command({type:'SAVE_CUSTOMER',customerId:customer.id,expectedVersion:customer.version,
          customer:{...customer,paymentTerm:{days:45,basis:'RECEIVED_DATE'}}});
        const draft=current.state.documents.filter(d=>d.type==='SOA').at(-1)!;
        await command({type:'FINALIZE_SOA',soaId:draft.id,expectedVersion:draft.version});
        await command({type:'CREATE_INVOICE',soaId:draft.id,expectedSoaVersion:draft.version+1,invoiceDate:today});
        const billed=current.state.documents.at(-1)!;
        assert.deepEqual(billed.paymentTerm,{days:45,basis:'RECEIVED_DATE'});
        await command({type:'SAVE_CUSTOMER',customerId:customer.id,expectedVersion:customer.version+1,
          customer:{...customer,paymentTerm:{days:30,basis:'INVOICE_DATE'}}});
        assert.deepEqual(current.state.documents.at(-1)?.paymentTerm,billed.paymentTerm);
        const bytes=Buffer.from('Fictional Phase D evidence');
        const settlement={type:'SETTLE_INVOICE',invoiceId:billed.id,expectedVersion:billed.version,method:'BANK_TRANSFER',
          receivedDate:today,allocations:[{tripId:trip.id,amount:10000n,expectedBalance:30000n}],
          files:[{name:'qa-evidence.txt',type:'text/plain',size:bytes.length,data:'data:text/plain;base64,'+bytes.toString('base64')}]};
        const [first,second]=await Promise.all([
          call('workspace','POST',cookie,{operationId:randomUUID(),revision:current.revision,action:{...settlement,reference:'Candidate receipt A'}}),
          call('workspace','POST',manager.cookie,{operationId:randomUUID(),revision:current.revision,action:{...settlement,reference:'Candidate receipt B'}}),
        ]);
        assert.deepEqual([first.status,second.status].sort(),[200,409]);
        current=(await call<State>('workspace','GET',cookie)).result;
        assert.equal(current.state.payments.length,1);
        assert.equal(current.state.payments[0].amount,10000n);
        assert.equal(current.state.allocations.reduce((n,a)=>n+a.amount-a.reversed,0n),10000n);
        const file=current.state.collectionEvidence[0]?.files[0];
        assert.ok(file?.downloadUrl);
        assert.equal(file.data,'');
        const downloaded=await fetch(origin+file.downloadUrl,{headers:{cookie}});
        assert.equal(await downloaded.text(),bytes.toString());
        assert.equal((await fetch(origin+file.downloadUrl)).status,401);
        const ops=await call<{actor:Actor}>('login','POST','',{email:opsEmail,password:opsPassword});
        assert.equal((await fetch(origin+file.downloadUrl,{headers:{cookie:ops.cookie!}})).status,403);
        verified.push('D4_BILLING_TERMS','ATTACHMENTS','CUSTOMER_DELETE','CONCURRENT_SETTLEMENT','REVISION_CONFLICT');
        if(phasePayments){
          phase='CONNECTED_CUSTOMER_RECEIPT';
          const opening=current.state.trips.reduce((total,row)=>total+row.amount,0n)
            -current.state.allocations.reduce((total,row)=>total+row.amount-row.reversed,0n);
          await command({type:'CREATE_TRIP',trip:{customerId:customer.id,date:earlier,workflow:'CORPORATE',
            amount:25000n,vehicle,driver,itinerary:'Fictional second invoiced service',schedule}});
          const secondTrip=current.state.trips.at(-1)!;
          await command({type:'CREATE_SOA',tripIds:[secondTrip.id]});
          const secondSoa=current.state.documents.at(-1)!;
          await command({type:'FINALIZE_SOA',soaId:secondSoa.id,expectedVersion:secondSoa.version});
          await command({type:'CREATE_INVOICE',soaId:secondSoa.id,expectedSoaVersion:secondSoa.version+1,invoiceDate:today});
          const secondInvoice=current.state.documents.at(-1)!;
          const firstInvoice=current.state.documents.find(d=>d.id===billed.id)!;
          const receipt={type:'RECORD_CUSTOMER_RECEIPT',customerId:customer.id,amount:30001n,receivedDate:today,
            method:'BANK_TRANSFER',reference:'One fictional bank deposit',
            splits:[{invoiceId:firstInvoice.id,expectedVersion:firstInvoice.version,amount:20000n},
              {invoiceId:secondInvoice.id,expectedVersion:secondInvoice.version,amount:10001n}]};
          await command({...receipt,customerId:'different-fictional-customer'},400);
          await command({...receipt,amount:30002n},400);
          await command({...receipt,splits:[{...receipt.splits[0],amount:30001n}]},400);
          assert.equal((await call('workspace','POST',ops.cookie,{operationId:randomUUID(),revision:current.revision,action:receipt})).status,403);
          const envelope={operationId:randomUUID(),revision:current.revision,action:receipt};
          const competingEnvelope={...envelope,operationId:randomUUID()};
          const [posted,competing]=await Promise.all([
            call<State>('workspace','POST',cookie,envelope),
            call<State>('workspace','POST',cookie,competingEnvelope),
          ]);
          assert.deepEqual([posted.status,competing.status].sort(),[200,409]);
          const replay=await call<State&{replayed:boolean}>('workspace','POST',cookie,posted.status===200?envelope:competingEnvelope);
          assert.equal(replay.result.replayed,true);
          current=(await call<State>('workspace','GET',cookie)).result;
          const customerReceipt=current.state.payments.find(p=>p.tripId===null)!;
          assert.equal(customerReceipt?.amount,30001n);
          const splits=current.state.allocations.filter(a=>a.paymentId===customerReceipt.id);
          assert.deepEqual(splits.map(a=>a.invoiceId),[firstInvoice.id,secondInvoice.id]);
          await command({type:'REVERSE',allocationId:splits[1].id,amount:1n,reason:'Fictional one-cent reversal'});
          const ledger=pg(candidate,candidateGuard+String.raw`
            SELECT json_build_object('charges',(SELECT (sum(amount)*100)::bigint::text FROM pilot_trips),
              'allocated',(SELECT (sum(amount-reversed)*100)::bigint::text FROM pilot_allocations),
              'receipts',(SELECT count(*) FROM pilot_receipts),
              'audits',(SELECT count(*) FROM pilot_audit WHERE action='RECORD_CUSTOMER_RECEIPT'));`);
          const reconciled=JSON.parse(ledger);
          const closing=BigInt(reconciled.charges)-BigInt(reconciled.allocated);
          assert.equal(reconciled.receipts,2);
          assert.equal(reconciled.audits,1);
          assert.equal(closing,opening+25000n-30001n+1n);
          paymentReconciliation={opening:opening.toString(),newCharges:'25000',allocations:'30001',
            adjustments:'-1',closing:closing.toString(),variance:'0',unit:'PHP centavos'};
          phase='CONNECTED_FORM_2307';
          await command({type:'SET_WITHHOLDING_EXPECTATION',invoiceId:secondInvoice.id,amount:2500n,reason:'Fictional expectation'});
          assert.equal(current.state.certificates2307?.length??0,0);
          await command({type:'REGISTER_FORM_2307',customerId:customer.id,reference:'FICTIONAL-001',issuedDate:today,
            periodStart:earlier,periodEnd:today,amount:2000n,lines:[{invoiceId:secondInvoice.id,amount:2000n}],
            file:{name:'qa-2307.txt',type:'text/plain',size:bytes.length,data:'data:text/plain;base64,'+bytes.toString('base64')}});
          const certificate=current.state.certificates2307?.[0];
          assert.equal(certificate?.certifiedCentavos,2000n);
          assert.equal(current.state.withholdingExpectations?.[secondInvoice.id],2500n);
          assert.equal((await fetch(origin+'/api/pilot/evidence/'+certificate!.attachmentId,{headers:{cookie:ops.cookie!}})).status,403);
          assert.equal(await (await fetch(origin+'/api/pilot/evidence/'+certificate!.attachmentId,{headers:{cookie}})).text(),bytes.toString());
          assert.equal(current.state.allocations.reduce((total,a)=>total+a.amount-a.reversed,0n),40000n);
          verified.push('MULTI_INVOICE_RECEIPT','CUSTOMER_RECEIPT_CONCURRENCY','ALLOCATION_REVERSAL','FORM_2307_EVIDENCE','RECEIVABLE_RECONCILIATION');
        }
      }
      const evidence={status:'PHASE_'+suffix.toUpperCase()+'_CONNECTED_CANDIDATE_VERIFIED',databaseOid:oid,port,
        verified,synthetic:true,...(paymentReconciliation?{paymentReconciliation}:{})};
      writeFileSync(phaseEvidence,JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
      console.log(JSON.stringify(evidence));
    }finally{
      child.kill();
      unlinkSync(authFile);
    }
  }finally{
    pg(candidate,candidateGuard+`
    ALTER ROLE ${writer} NOLOGIN PASSWORD NULL;`);
  }
}
main().catch(error=>{
  const result=error as {actual?:unknown;expected?:unknown};
  console.error(JSON.stringify({status:'PHASE_A_CANDIDATE_STOPPED',phase,
    ...(typeof result.actual==='number'?{actual:result.actual,expected:result.expected}:{})}));
  process.exitCode=1;
});
