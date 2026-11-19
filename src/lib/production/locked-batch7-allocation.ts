import {createHash} from 'node:crypto';
import {
  confirmPaymentAllocationInTransaction,
  type AllocationTransaction,
  type LockedInvoice,
  type LockedPayment,
  type PaymentAllocationCommand,
} from '../domain/payment-transaction';
import {buildSharedDependencyDiscovery,type SharedDependencyEvidence} from './shared-transaction-evidence';
import {assertSharedTransactionDiscoveryUnchanged,assertSharedTransactionLockAcquisition,type SharedTransactionLock,type SharedTransactionLockPlan} from './shared-transaction-lock-plan';

type ScopedRow = {authority:string; id:string; customerId:string};
type Payment = ScopedRow & LockedPayment & {
  allocationScope:'CUSTOMER'|'DIRECT_TRIP'|'REFUND_ONLY';
  refundIds:readonly string[];
};
type Invoice = ScopedRow & {eligible:boolean; receivableIds:readonly string[]};
type Receivable = ScopedRow & {tripId:string; outstandingCentavos:bigint; eligible:boolean};
type SavedAllocation = {
  authority:string; key:string; actorId:string; customerId:string; paymentId:string;
  kind:string; requestDigest:string; resultVisible:boolean; operationId:string; allocatedCashCentavos:bigint;
};
type Scope = {authority:string;key:string;actorId:string;customerId:string;paymentId:string};
type Append = Parameters<AllocationTransaction['appendAllocationAndAudit']>[0];
export interface SyntheticLockedAllocationEffects {
  findReceipt(scope: Scope): Promise<SavedAllocation | null>;
  appendAllocationAndAudit(input: Append & {
    authority:string;
    attributions:readonly {invoiceId:string;receivableId:string}[];
  }): Promise<string>;
}

/** Synthetic transaction-local view. The caller owns live authorization, locks, commit and rollback. */
export function applyLockedBatch7Allocation(input:{
  plan:SharedTransactionLockPlan;
  acquired:readonly SharedTransactionLock[];
  evidence:SharedDependencyEvidence;
  command:Omit<PaymentAllocationCommand,'actor'>;
  payment:Payment;
  invoices:readonly Invoice[];
  receivables:readonly Receivable[];
  effects:SyntheticLockedAllocationEffects;
}) {
  const {plan,acquired,effects}=input;
  const {evidence,payment,invoices,receivables}=structuredClone({
    evidence:input.evidence,payment:input.payment,invoices:input.invoices,receivables:input.receivables,
  });
  const {authority,operationKey,actor}=evidence;
  assertSharedTransactionLockAcquisition(plan,acquired);
  assertSharedTransactionDiscoveryUnchanged(plan,buildSharedDependencyDiscovery(evidence));
  if (!actor.active || evidence.session.revokedAt!==null || !(
      actor.role==='OWNER'||actor.role==='ADMIN'||actor.role==='BILLING')) throw new Error('Allocation actor forbidden');
  const command:PaymentAllocationCommand=structuredClone({...input.command,actor:{id:actor.id,role:actor.role}});
  if(command.idempotencyKey!==operationKey || command.paymentId!==payment.id || payment.allocationScope!=='CUSTOMER') {
    throw new Error('Unsupported or mismatched synthetic allocation scope');
  }
  if(command.allocations.some(allocation=>allocation.withheldCentavos!==0n)) throw new Error('Withholding allocation not enabled');
  const requireLock = (kind:SharedTransactionLock['kind'],id:string) => {
    if(!plan.locks.some(lock=>lock.kind===kind&&lock.id===id&&lock.authority===authority)) {
      throw new Error('Required allocation lock missing');
    }
  };
  const requireEvidence = (kind:'PAYMENT'|'INVOICE'|'TRIP_RECEIVABLE'|'TRIP'|'REFUND',id:string) => {
    requireLock(kind,id);
    const row=evidence.resources.find(record=>record.kind===kind&&record.id===id);
    if(row?.customerId!==command.customerId) throw new Error('Cross-authority or cross-customer allocation');
    return row;
  };
  const requireRow = (kind:'PAYMENT'|'INVOICE'|'TRIP_RECEIVABLE',row:ScopedRow) => {
    if(row.authority!==authority||row.customerId!==command.customerId) throw new Error('Cross-authority or cross-customer allocation');
    return requireEvidence(kind,row.id);
  };
  const exactAmount = (row:SharedDependencyEvidence['resources'][number],name:string,amount:bigint) => {
    if(typeof amount!=='bigint'||!row.amounts?.some(value=>value.name===name&&value.centavos===amount)) {
      throw new Error('Allocation balance differs from verified discovery');
    }
  };
  requireLock('CUSTOMER',command.customerId);
  const paymentEvidence=requireRow('PAYMENT',payment);
  if(paymentEvidence.state!==payment.state) throw new Error('Payment state differs from verified discovery');
  exactAmount(paymentEvidence,'received',payment.receivedCentavos);
  exactAmount(paymentEvidence,'allocated',payment.allocationsCentavos);
  exactAmount(paymentEvidence,'completedRefunds',payment.completedRefundsCentavos);
  exactAmount(paymentEvidence,'reservedRefunds',payment.pendingRefundsCentavos);
  const refundEdges=evidence.relationships.filter(({role,from})=>role==='PAYMENT_REFUND'&&from.kind==='PAYMENT'&&from.id===payment.id);
  if(refundEdges.length!==payment.refundIds.length||new Set(payment.refundIds).size!==payment.refundIds.length||
      refundEdges.some(edge=>edge.to.kind!=='REFUND'||!payment.refundIds.includes(edge.to.id))) {
    throw new Error('Payment refund scope differs from verified discovery');
  }
  for(const id of payment.refundIds) requireEvidence('REFUND',id);
  const targets=new Map<string,LockedInvoice>();
  const attributions:{invoiceId:string;receivableId:string}[]=[];
  const usedReceivables=new Set<string>();
  for(const allocation of command.allocations) {
    const matching=invoices.filter(invoice=>invoice.id===allocation.invoiceId);
    if(matching.length!==1||targets.has(allocation.invoiceId)) throw new Error('Missing or duplicate locked invoice');
    const invoice=matching[0];
    const invoiceEvidence=requireRow('INVOICE',invoice);
    if(invoice.receivableIds.length!==1) throw new Error('Allocation requires exactly one attributed receivable');
    const receivableId=invoice.receivableIds[0];
    const attributed=receivables.filter(row=>row.id===receivableId);
    if(attributed.length!==1||usedReceivables.has(receivableId)) throw new Error('Missing or shared attributed receivable');
    const receivable=attributed[0];
    const receivableEvidence=requireRow('TRIP_RECEIVABLE',receivable);
    requireEvidence('TRIP',receivable.tripId);
    if(invoiceEvidence.eligible!==invoice.eligible||receivableEvidence.eligible!==receivable.eligible) {
      throw new Error('Allocation eligibility differs from verified discovery');
    }
    exactAmount(receivableEvidence,'outstanding',receivable.outstandingCentavos);
    const edges=evidence.relationships.filter(({role,from})=>role==='INVOICE_RECEIVABLE'&&from.kind==='INVOICE'&&from.id===invoice.id);
    if(edges.length!==1||edges[0].to.kind!=='TRIP_RECEIVABLE'||edges[0].to.id!==receivableId) {
      throw new Error('Invoice attribution differs from verified discovery');
    }
    const tripEdges=evidence.relationships.filter(({role,from})=>role==='RECEIVABLE_TRIP'&&from.kind==='TRIP_RECEIVABLE'&&from.id===receivableId);
    if(tripEdges.length!==1||tripEdges[0].to.kind!=='TRIP'||tripEdges[0].to.id!==receivable.tripId) {
      throw new Error('Receivable trip differs from verified discovery');
    }
    usedReceivables.add(receivableId);
    attributions.push({invoiceId:invoice.id,receivableId});
    targets.set(invoice.id,{id:invoice.id,customerId:invoice.customerId,
      outstandingCentavos:receivable.outstandingCentavos,eligible:invoice.eligible&&receivable.eligible});
  }

  const scope={authority,key:operationKey,actorId:actor.id,customerId:command.customerId,paymentId:payment.id};
  let newReceiptVerified=false;
  const view:AllocationTransaction={
    async findOperation(key,requestDigest) {
      if(key!==scope.key) throw new Error('Allocation operation key mismatch');
      const prior=await effects.findReceipt({...scope});
      const captured=evidence.receipt;
      if(prior===null&&captured===null){newReceiptVerified=true;return null;}
      if(!prior||!captured||prior.authority!==scope.authority||prior.key!==scope.key||prior.actorId!==scope.actorId||
          prior.customerId!==scope.customerId||prior.paymentId!==scope.paymentId||prior.kind!=='ALLOCATE_PAYMENT'||
          prior.requestDigest!==requestDigest||prior.resultVisible!==true||captured.kind!==prior.kind||
          captured.actorId!==prior.actorId||captured.requestDigest!==prior.requestDigest||
          captured.result.kind!=='PAYMENT'||captured.result.id!==scope.paymentId||!prior.operationId||
          typeof prior.allocatedCashCentavos!=='bigint'||prior.allocatedCashCentavos<=0n) {
        throw new Error('Allocation receipt scope or digest mismatch');
      }
      return {operationId:prior.operationId,allocatedCashCentavos:prior.allocatedCashCentavos};
    },
    async lockPayment(id) {
      if(id!==payment.id) throw new Error('Unplanned allocation payment');
      return {
        customerId:payment.customerId,state:payment.state,receivedCentavos:payment.receivedCentavos,
        allocationsCentavos:payment.allocationsCentavos,completedRefundsCentavos:payment.completedRefundsCentavos,
        pendingRefundsCentavos:payment.pendingRefundsCentavos,
      };
    },
    async lockInvoices(ids) {
      return ids.map(id=>{
        const invoice=targets.get(id);
        if(!invoice) throw new Error('Unplanned allocation invoice');
        return {...invoice};
      });
    },
    appendAllocationAndAudit: value => {
      if(!newReceiptVerified) throw new Error('Allocation receipt was not checked');
      return effects.appendAllocationAndAudit({...value,authority,attributions});
    },
  };
  return confirmPaymentAllocationInTransaction(view,command,value=>createHash('sha256').update(value).digest('hex'));
}
