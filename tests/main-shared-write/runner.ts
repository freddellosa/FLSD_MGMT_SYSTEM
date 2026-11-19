import assert from 'node:assert/strict';
import {PrismaClient} from '@prisma/client';
import {bindSyntheticSharedWritePostgres} from '../../src/lib/production/synthetic-shared-write-postgres';
import {runSyntheticSharedWrite} from '../../src/lib/production/synthetic-shared-write-coordinator';

const id=(suffix:string)=>'10000000-0000-4000-8000-0000000000'+suffix;
let phase='INPUT';

async function run(){
  if(process.env.FLSD_SYNTHETIC_SHARED_WRITE!=='VERIFIED_LOCAL_RUN') throw new Error();
  const chunks:Buffer[]=[];
  let size=0;
  for await(const value of process.stdin){
    const chunk=Buffer.from(value);
    size+=chunk.length;
    if(size>8192) throw new Error();
    chunks.push(chunk);
  }
  const {password,schemaOid,roleOid}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(typeof password!=='string'||password.length===0||password.length>1024||
      ![schemaOid,roleOid].every(oid=>typeof oid==='string'&&/^[1-9][0-9]{0,9}$/.test(oid)&&Number(oid)<=4294967295)){
    throw new Error();
  }
  const url=new URL('postgresql://flsd_shared_write_runner_75435c870a31@127.0.0.1:5432/flsd_main_adapter_test');
  url.password=encodeURIComponent(password);
  url.searchParams.set('schema','flsd_shared_write_rehearsal');
  url.searchParams.set('connection_limit','2');
  const client=new PrismaClient({datasources:{db:{url:url.toString()}},log:[]});
  try{
    const transaction=bindSyntheticSharedWritePostgres(client,{schemaOid,roleOid});
    const command={
      customerId:id('03'),paymentId:id('06'),idempotencyKey:'synthetic-shared-write-primary',
      reason:'Disposable synthetic allocation',
      allocations:[{invoiceId:id('11'),cashCentavos:6001n,withheldCentavos:0n}],
    };
    phase='CROSS_CUSTOMER';
    await assert.rejects(runSyntheticSharedWrite(transaction,{...command,paymentId:id('07')}),/Synthetic allocation scope unavailable/);
    phase='ROLLBACK';
    await assert.rejects(runSyntheticSharedWrite(work=>transaction(async tx=>{
      await work(tx);
      throw new Error('Synthetic failure after staged effects');
    }),{...command,idempotencyKey:'synthetic-shared-write-rollback'}),/Synthetic failure after staged effects/);
    phase='DUPLICATE_SUBMISSION';
    const pair=await Promise.allSettled([runSyntheticSharedWrite(transaction,command),runSyntheticSharedWrite(transaction,command)]);
    const results=pair.map(result=>{
      if(result.status==='rejected') throw result.reason;
      return result.value;
    });
    assert.equal(results.filter(result=>result.replayed).length,1);
    assert.equal(results[0].operationId,results[1].operationId);
    phase='COMPETING_RESERVATION';
    await assert.rejects(runSyntheticSharedWrite(transaction,{...command,idempotencyKey:'synthetic-shared-write-competing',
      allocations:[{invoiceId:id('12'),cashCentavos:500n,withheldCentavos:0n}]}),/Receivable reserved by another invoice/);
    phase='REPLAY_DIGEST';
    await assert.rejects(runSyntheticSharedWrite(transaction,{...command,reason:'Changed reason'}),/receipt scope or digest mismatch/);
    phase='RECONCILIATION';
    const rows=await client.$queryRaw<{verified:boolean}[]>`
      SELECT (
        (SELECT count(*) FROM flsd_shared_write_rehearsal.financial_operation)=1
        AND (SELECT count(*) FROM flsd_shared_write_rehearsal.invoice_reservation)=1
        AND (SELECT count(*) FROM flsd_shared_write_rehearsal.allocation_event)=1
        AND (SELECT count(*) FROM flsd_shared_write_rehearsal.allocation_audit)=1
        AND EXISTS (SELECT 1 FROM flsd_shared_write_rehearsal.financial_operation o
          JOIN flsd_shared_write_rehearsal.allocation_event e USING (authority_id,operation_id)
          JOIN flsd_shared_write_rehearsal.allocation_audit a USING (authority_id,operation_id)
          JOIN flsd_shared_write_rehearsal.invoice_reservation i
            ON (i.authority_id,i.created_by_operation,i.invoice_id)=(o.authority_id,o.operation_id,o.invoice_id)
          JOIN flsd_shared_write_rehearsal.payment p ON (p.authority_id,p.id)=(o.authority_id,o.payment_id)
          JOIN flsd_shared_write_rehearsal.trip_receivable r ON (r.authority_id,r.id)=(o.authority_id,o.receivable_id)
          JOIN flsd_shared_write_rehearsal.customer c ON (c.authority_id,c.id)=(o.authority_id,o.customer_id)
          WHERE o.operation_id=${results[0].operationId}::uuid AND o.cash=60.01 AND e.cash_delta=o.cash
            AND a.actor_id=o.actor_id AND a.reason=${command.reason} AND p.allocated=o.cash AND r.outstanding=9.99
            AND c.revision=2 AND p.revision=2 AND r.revision=2)
      ) AS verified`;
    assert.deepEqual(rows,[{verified:true}]);
  }finally{
    await client.$disconnect();
  }
}

run().then(()=>process.stdout.write(JSON.stringify({status:'SHARED_WRITE_CONNECTED_VERIFIED',passed:6,failed:0,rawOutputIncluded:false})+'\n'))
  .catch(()=>{
    process.stdout.write(JSON.stringify({status:'SHARED_WRITE_CONNECTED_FAILED',phase,rawOutputIncluded:false})+'\n');
    process.exitCode=1;
  });
