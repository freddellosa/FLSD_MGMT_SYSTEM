import assert from 'node:assert/strict';
import {PrismaClient,type Prisma} from '@prisma/client';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {createDisposableCombinedAllocation} from '../../src/lib/production/disposable-combined-allocation';
import {combinedWriteAuthority as authority,createDisposableWriteAuthorization} from '../../src/lib/production/disposable-write-authorization';

const schema='flsd_combined_write_rehearsal';
const role='flsd_combined_write_runner_75435c870a31';
const marker='FLSD_SYNTHETIC_COMBINED_WRITE_V1:b813e743-9f4c-4121-b8ab-b01ca51b9335';
const id=(suffix:string)=>'10000000-0000-4000-8000-0000000000'+suffix;
const validPassword=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=1024;
let phase='INPUT';

async function run(){
  if(process.env.FLSD_SYNTHETIC_COMBINED_WRITE!=='VERIFIED_LOCAL_RUN') throw new Error();
  const continuation=process.argv[2]==='continue-revocation';
  if(process.argv[2] && !continuation) throw new Error();
  const chunks:Buffer[]=[];
  let size=0;
  for await(const value of process.stdin){
    const chunk=Buffer.from(value);
    size+=chunk.length;
    if(size>16384) throw new Error();
    chunks.push(chunk);
  }
  const {password,adminPassword,token:initialToken,schemaOid,roleOid}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!validPassword(password)||!validPassword(adminPassword)||
      (continuation?(schemaOid!=='17643'||roleOid!=='17642'||initialToken!==undefined):
        (typeof initialToken!=='string'||!/^[a-f0-9]{64}$/.test(initialToken)))||
      ![schemaOid,roleOid].every(oid=>typeof oid==='string'&&/^[1-9][0-9]{0,9}$/.test(oid)&&Number(oid)<=4294967295)) throw new Error();
  const token=continuation?randomBytes(32).toString('hex'):initialToken;
  const sessionId=continuation?randomUUID():id('02');
  const client=(user:string,secret:string)=>new PrismaClient({log:[],datasources:{db:{
    url:`postgresql://${user}:${encodeURIComponent(secret)}@127.0.0.1:5432/flsd_main_adapter_test?schema=${schema}&connection_limit=2`,
  }}});
  const writer=client(role,password),admin=client('postgres',adminPassword);
  const identity={schemaOid,roleOid};
  try{
    const allocate=createDisposableCombinedAllocation(writer,identity);
    const inspect=createDisposableWriteAuthorization(writer,identity,'combined');
    const credential=async()=>token;
    const command={customerId:id('03'),paymentId:id('06'),idempotencyKey:'synthetic-combined-primary',
      reason:'Disposable combined allocation',allocations:[{invoiceId:id('11'),cashCentavos:6001n,withheldCentavos:0n}]};
    async function guardedAdmin(db:Prisma.TransactionClient) {
      await db.$executeRaw`SET LOCAL search_path TO pg_catalog`;
      const rows=await db.$queryRaw<unknown[]>`
        SELECT 1 FROM pg_database d JOIN pg_namespace n ON n.nspowner=d.datdba
        JOIN pg_roles r ON r.rolname=${role}
        WHERE current_user='postgres' AND session_user=current_user AND d.datname=current_database()
          AND d.datname='flsd_main_adapter_test' AND d.oid=16394::oid AND d.datdba=16392::oid
          AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=5432
          AND current_setting('server_version_num')='180007' AND NOT pg_is_in_recovery()
          AND shobj_description(d.oid,'pg_database')='FLSD_DISPOSABLE:b813e743-9f4c-4121-b8ab-b01ca51b9335:flsd_main_adapter_test'
          AND n.nspname=${schema} AND n.oid=${schemaOid}::oid AND obj_description(n.oid,'pg_namespace')=${marker}
          AND r.oid=${roleOid}::oid AND shobj_description(r.oid,'pg_authid')=${marker}`;
      assert.equal(rows.length,1);
    }
    let operationId:string;
    if(continuation){
      phase='CONTINUATION_SESSION';
      await inspect(async()=>undefined);
      await admin.$transaction(async db=>{
        await guardedAdmin(db);
        await db.$queryRaw`SELECT pg_advisory_xact_lock(176661,1)::text`;
        const fence=await db.$queryRaw<unknown[]>`SELECT 1 FROM flsd_combined_write_rehearsal.staff_authorization
          WHERE authority_id=${authority} AND staff_id=${id('01')}::uuid AND revision=1 AND active AND role='BILLING' FOR UPDATE`;
        assert.equal(fence.length,1);
        const [state]=await db.$queryRaw<{verified:boolean}[]>`
          SELECT ((SELECT count(*) FROM flsd_combined_write_rehearsal.staff_session)=1 AND EXISTS(
            SELECT 1 FROM flsd_combined_write_rehearsal.staff_session WHERE authority_id=${authority}
              AND session_id=${id('02')}::uuid AND staff_id=${id('01')}::uuid AND revoked_at IS NULL)
            AND (SELECT count(*) FROM flsd_combined_write_rehearsal.financial_operation)=1
            AND (SELECT count(*) FROM flsd_combined_write_rehearsal.invoice_reservation)=1
            AND (SELECT count(*) FROM flsd_combined_write_rehearsal.allocation_event)=1
            AND (SELECT count(*) FROM flsd_combined_write_rehearsal.allocation_audit)=1
            AND EXISTS(SELECT 1 FROM flsd_combined_write_rehearsal.financial_operation o
              JOIN flsd_combined_write_rehearsal.allocation_event e USING (authority_id,operation_id)
              JOIN flsd_combined_write_rehearsal.allocation_audit a USING (authority_id,operation_id)
              JOIN flsd_combined_write_rehearsal.invoice_reservation i
                ON (i.authority_id,i.created_by_operation,i.invoice_id,i.receivable_id,i.customer_id)
                 =(o.authority_id,o.operation_id,o.invoice_id,o.receivable_id,o.customer_id)
              JOIN flsd_combined_write_rehearsal.payment p ON (p.authority_id,p.id)=(o.authority_id,o.payment_id)
              JOIN flsd_combined_write_rehearsal.trip_receivable r ON (r.authority_id,r.id)=(o.authority_id,o.receivable_id)
              JOIN flsd_combined_write_rehearsal.customer c ON (c.authority_id,c.id)=(o.authority_id,o.customer_id)
              WHERE o.authority_id=${authority} AND o.operation_key=${command.idempotencyKey}
                AND o.actor_id=${id('01')}::uuid AND o.payment_id=${command.paymentId}::uuid
                AND o.customer_id=${command.customerId}::uuid AND o.invoice_id=${id('11')}::uuid
                AND o.cash=60.01 AND e.cash_delta=o.cash AND a.actor_id=o.actor_id AND a.reason=${command.reason}
                AND p.allocated=o.cash AND r.outstanding=9.99 AND c.revision=2 AND p.revision=2 AND r.revision=2)) AS verified`;
        assert.equal(state.verified,true);
        const digest=createHash('sha256').update(token,'ascii').digest('hex');
        const inserted=await db.$executeRaw`INSERT INTO flsd_combined_write_rehearsal.staff_session
          (authority_id,session_id,staff_id,token_digest,issued_at,expires_at)
          VALUES (${authority},${sessionId}::uuid,${id('01')}::uuid,decode(${digest},'hex'),
            transaction_timestamp(),transaction_timestamp()+interval '15 minutes')`;
        assert.equal(inserted,1);
      },{timeout:15000});
      phase='COMMIT_AND_REPLAY';
      const replay=await allocate(credential,command,{replayOnly:true});
      assert.equal(replay.replayed,true);
      operationId=replay.operationId;
    } else {
      phase='SCOPE';
      await assert.rejects(allocate(credential,{...command,paymentId:id('07')}),/Synthetic allocation scope unavailable/);
      phase='COMMIT_AND_REPLAY';
      const pair=await Promise.allSettled([allocate(credential,command),allocate(credential,command)]);
      const results=pair.map(item=>{if(item.status==='rejected') throw item.reason;return item.value;});
      assert.equal(results.filter(item=>item.replayed).length,1);
      assert.equal(results[0].operationId,results[1].operationId);
      operationId=results[0].operationId;
      phase='COMPETING_RESERVATION';
      await assert.rejects(allocate(credential,{...command,idempotencyKey:'synthetic-combined-competing',
        allocations:[{invoiceId:id('12'),cashCentavos:500n,withheldCentavos:0n}]}),/Receivable reserved by another invoice/);
    }
    phase='REVOCATION';
    let waitingCommand:Promise<void>|undefined;
    const replayOnly={replayOnly:continuation};
    try {
      await admin.$transaction(async db=>{
      await guardedAdmin(db);
      const staff=await db.$executeRaw`UPDATE flsd_combined_write_rehearsal.staff_authorization SET revision=revision+1
        WHERE authority_id=${authority} AND staff_id=${id('01')}::uuid AND revision=1`;
      assert.equal(staff,1);
      const session=await db.$executeRaw`UPDATE flsd_combined_write_rehearsal.staff_session SET revoked_at=clock_timestamp()
        WHERE authority_id=${authority} AND session_id=${sessionId}::uuid AND staff_id=${id('01')}::uuid AND revoked_at IS NULL`;
      assert.equal(session,1);
      waitingCommand=assert.rejects(allocate(credential,{...command,idempotencyKey:'synthetic-combined-revoked'},replayOnly),
        /^Error: Forbidden$/);
      void waitingCommand.catch(()=>{});
      const deadline=Date.now()+5000;
      do {
        await db.$queryRaw`SELECT pg_stat_clear_snapshot()::text`;
        const [state]=await db.$queryRaw<{blocked:boolean}[]>`
          SELECT EXISTS(SELECT 1 FROM pg_stat_activity a WHERE a.datname=current_database() AND a.usename=${role}
            AND pg_backend_pid()=ANY(pg_blocking_pids(a.pid))) AS blocked`;
        if(state.blocked) return;
        await new Promise(resolve=>setTimeout(resolve,50));
      } while(Date.now()<deadline);
      throw new Error('Command did not reach the staff fence');
      },{timeout:15000});
      assert.ok(waitingCommand);
      await waitingCommand;
    } finally {
      await Promise.allSettled([waitingCommand]);
    }
    await assert.rejects(allocate(credential,command,replayOnly),/^Error: Forbidden$/);
    phase='RECONCILIATION';
    await inspect(async (_tx,db)=>{
      const rows=await db.$queryRaw<{verified:boolean}[]>`
        SELECT (
          (SELECT count(*) FROM flsd_combined_write_rehearsal.financial_operation)=1
          AND (SELECT count(*) FROM flsd_combined_write_rehearsal.invoice_reservation)=1
          AND (SELECT count(*) FROM flsd_combined_write_rehearsal.allocation_event)=1
          AND (SELECT count(*) FROM flsd_combined_write_rehearsal.allocation_audit)=1
          AND EXISTS (SELECT 1 FROM flsd_combined_write_rehearsal.financial_operation o
            JOIN flsd_combined_write_rehearsal.allocation_event e USING (authority_id,operation_id)
            JOIN flsd_combined_write_rehearsal.allocation_audit a USING (authority_id,operation_id)
            JOIN flsd_combined_write_rehearsal.invoice_reservation i
              ON (i.authority_id,i.created_by_operation,i.invoice_id)=(o.authority_id,o.operation_id,o.invoice_id)
            JOIN flsd_combined_write_rehearsal.payment p ON (p.authority_id,p.id)=(o.authority_id,o.payment_id)
            JOIN flsd_combined_write_rehearsal.trip_receivable r ON (r.authority_id,r.id)=(o.authority_id,o.receivable_id)
            JOIN flsd_combined_write_rehearsal.customer c ON (c.authority_id,c.id)=(o.authority_id,o.customer_id)
            WHERE o.operation_id=${operationId}::uuid AND o.cash=60.01 AND e.cash_delta=o.cash
              AND a.actor_id=o.actor_id AND a.reason=${command.reason} AND p.allocated=o.cash AND r.outstanding=9.99
              AND c.revision=2 AND p.revision=2 AND r.revision=2)
        ) AS verified`;
      assert.deepEqual(rows,[{verified:true}]);
      if(continuation){
        const sessions=await db.$queryRaw<{verified:boolean}[]>`
          SELECT ((SELECT count(*) FROM flsd_combined_write_rehearsal.staff_session)=2 AND EXISTS(
            SELECT 1 FROM flsd_combined_write_rehearsal.staff_session WHERE authority_id=${authority}
              AND session_id=${id('02')}::uuid AND revoked_at IS NULL)
            AND EXISTS(SELECT 1 FROM flsd_combined_write_rehearsal.staff_session WHERE authority_id=${authority}
              AND session_id=${sessionId}::uuid AND revoked_at IS NOT NULL)) AS verified`;
        assert.deepEqual(sessions,[{verified:true}]);
      }
    });
  }finally{
    await Promise.allSettled([admin.$disconnect(),writer.$disconnect()]);
  }
}
run().then(()=>process.stdout.write(JSON.stringify(process.argv[2]==='continue-revocation'
  ?{status:'COMBINED_WRITE_REVOCATION_CONTINUATION_VERIFIED',rawOutputIncluded:false}
  :{status:'COMBINED_WRITE_CONNECTED_VERIFIED',passed:5,rawOutputIncluded:false})+'\n'))
  .catch(()=>{
    process.stdout.write(JSON.stringify({status:'COMBINED_WRITE_CONNECTED_FAILED',phase,rawOutputIncluded:false})+'\n');
    process.exitCode=1;
  });
