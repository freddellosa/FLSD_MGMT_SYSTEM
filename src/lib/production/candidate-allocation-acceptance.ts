import assert from 'node:assert/strict';
import type {PaymentAllocationCommand,PaymentAllocationReceipt} from '../domain/payment-transaction';

type Command=Omit<PaymentAllocationCommand,'actor'>;
const id=(suffix:string)=>'70000000-0000-4000-8000-0000000000'+suffix;
const paymentId=id('06'),customerId=id('02'),invoiceId=id('05');
const migratedOperation=id('07'),reservationReceivable=id('14');

type Facts={
  historySha256:string;
  operationCount:number;
  eventCount:number;
  auditCount:number;
  reservationCount:number;
  scopeCount:number;
  allocatedCentavos:bigint;
  receivedCentavos:bigint;
  pendingRefundCentavos:bigint;
  completedRefundCentavos:bigint;
  payableCentavos:bigint;
  reservation:{operationId:string;invoiceId:string;receivableId:string};
  latestEffect:null|{operationId:string;cashCentavos:bigint;invoiceId:string;receivableId:string;actorId:string};
};

export interface CandidateAllocationAcceptancePort {
  allocate(command:Command):Promise<PaymentAllocationReceipt>;
  /** Independent, consistent read from the pinned fixture. Hash the opening receipts and events only. */
  inspect():Promise<Facts>;
  /** Repository must map a reserved legacy key to this stable refusal without attempting an append. */
  isUnboundKeyRefusal(error:unknown):boolean;
}

export async function acceptCandidateAllocation(port:CandidateAllocationAcceptancePort) {
  const before=await port.inspect();
  assert.match(before.historySha256,/^[a-f0-9]{64}$/);
  assert.deepEqual(before,{
    historySha256:before.historySha256,operationCount:2,eventCount:2,auditCount:1,reservationCount:1,scopeCount:1,
    allocatedCentavos:1001n,receivedCentavos:10001n,pendingRefundCentavos:2500n,completedRefundCentavos:500n,
    payableCentavos:7000n,reservation:{operationId:migratedOperation,invoiceId,receivableId:reservationReceivable},latestEffect:null,
  });
  const command:Command={paymentId,customerId,idempotencyKey:'candidate-bound',reason:'Synthetic canonical allocation',
    allocations:[{invoiceId,cashCentavos:600n,withheldCentavos:0n}]};
  const migrated=await port.allocate(command);
  assert.deepEqual(migrated,{operationId:migratedOperation,allocatedCashCentavos:600n,replayed:true});
  assert.deepEqual(await port.inspect(),before);
  await assert.rejects(port.allocate({...command,idempotencyKey:'candidate-unbound'}),error=>port.isUnboundKeyRefusal(error));
  assert.deepEqual(await port.inspect(),before);

  const fresh={...command,idempotencyKey:'candidate-acceptance-allocation',reason:'Synthetic allocation after upgrade',
    allocations:[{invoiceId,cashCentavos:2001n,withheldCentavos:0n}]};
  const accepted=await port.allocate(fresh);
  assert.equal(accepted.replayed,false);
  assert.equal(accepted.allocatedCashCentavos,2001n);
  assert.match(accepted.operationId,/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
  assert.notEqual(accepted.operationId,migratedOperation);
  const after=await port.inspect();
  assert.deepEqual(after,{
    ...before,operationCount:3,eventCount:3,auditCount:2,scopeCount:2,allocatedCentavos:3002n,
    latestEffect:{operationId:accepted.operationId,cashCentavos:2001n,invoiceId,
      receivableId:reservationReceivable,actorId:id('01')},
  });
  assert.deepEqual(await port.allocate(fresh),{...accepted,replayed:true});
  assert.deepEqual(await port.inspect(),after);
  return {status:'BATCH7_CANDIDATE_ALLOCATION_ACCEPTANCE_VERIFIED' as const,operationId:accepted.operationId};
}
