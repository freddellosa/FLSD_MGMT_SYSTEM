import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {confirmPaymentAllocation, confirmPaymentAllocationInTransaction, type AllocationTransaction, type PaymentAllocationCommand, type PaymentAllocationReceipt} from './payment-transaction';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const command=():PaymentAllocationCommand=>({paymentId:'p1',customerId:'c1',idempotencyKey:'k1',actor:{id:'staff1',role:'BILLING'},reason:'Synthetic review',allocations:[{invoiceId:'i2',cashCentavos:100n,withheldCentavos:0n},{invoiceId:'i1',cashCentavos:200n,withheldCentavos:0n}]});
function fixture() {
 const calls:string[]=[];const receipts=new Map<string,{digest:string;receipt:PaymentAllocationReceipt}>();
 const tx:AllocationTransaction={
  async findOperation(key,digest){calls.push('receipt');const r=receipts.get(key);if(r&&r.digest!==digest)throw new Error('Conflict');return r?.receipt??null;},
  async lockPayment(){calls.push('payment');return {customerId:'c1',state:'RECORDED',receivedCentavos:1000n,allocationsCentavos:0n,completedRefundsCentavos:0n,pendingRefundsCentavos:0n};},
  async lockInvoices(ids){calls.push('invoices:'+ids.join(','));return ids.map(id=>({id,customerId:'c1',outstandingCentavos:500n,eligible:true}));},
  async appendAllocationAndAudit({command,totalCashCentavos,payloadDigest}){calls.push('append');receipts.set(command.idempotencyKey,{digest:payloadDigest,receipt:{operationId:'op1',allocatedCashCentavos:totalCashCentavos,replayed:false}});return 'op1';}
 };return {tx,calls,receipts};
}
describe('Transaction-scoped reuse of shared allocation rules',()=>{
 it('uses the supplied transaction with unchanged deterministic locks and totals',async()=>{
  const f=fixture();expect(await confirmPaymentAllocationInTransaction(f.tx,command(),sha)).toEqual({operationId:'op1',allocatedCashCentavos:300n,replayed:false});
  expect(f.calls).toEqual(['receipt','payment','invoices:i1,i2','append']);
 });
 it('keeps the existing store entry point to one outer transaction',async()=>{
  const f=fixture();let transactions=0;
  await confirmPaymentAllocation({async serializable(fn){transactions++;return fn(f.tx);}},command(),sha);
  expect(transactions).toBe(1);expect(f.calls.filter(c=>c==='append')).toHaveLength(1);
 });
 it('replays the same allocation without locks or additional writes',async()=>{
  const f=fixture();await confirmPaymentAllocationInTransaction(f.tx,command(),sha);f.calls.length=0;
  expect((await confirmPaymentAllocationInTransaction(f.tx,command(),sha)).replayed).toBe(true);expect(f.calls).toEqual(['receipt']);
 });
 it('does not allow changed input to reuse the shared receipt',async()=>{
  const f=fixture();await confirmPaymentAllocationInTransaction(f.tx,command(),sha);const c=command();c.allocations[0].cashCentavos=1n;
  await expect(confirmPaymentAllocationInTransaction(f.tx,c,sha)).rejects.toThrow('Conflict');expect(f.calls.filter(s=>s==='append')).toHaveLength(1);
 });
 it('propagates failures so an outer coordinator can roll back rather than committing a receipt',async()=>{
  const f=fixture();f.tx.appendAllocationAndAudit=async()=>{throw new Error('Synthetic write failure');};
  await expect(confirmPaymentAllocationInTransaction(f.tx,command(),sha)).rejects.toThrow('Synthetic write failure');expect(f.receipts.size).toBe(0);
 });
 it('rejects current unauthorized role before looking up a receipt',async()=>{
  const f=fixture(),c=command();Object.assign(c.actor,{role:'VIEWER'});
  await expect(confirmPaymentAllocationInTransaction(f.tx,c,sha)).rejects.toThrow('Unauthorized');expect(f.calls).toEqual([]);
 });
 it('captures request values before awaiting a transaction or digest callback',async()=>{
  const f=fixture(),c=command();
  await confirmPaymentAllocation({async serializable(fn){c.allocations[0].cashCentavos=9999n;return fn(f.tx);}},c,sha);
  expect(f.receipts.get('k1')!.receipt.allocatedCashCentavos).toBe(300n);
 });
 it('retains existing customer and available-credit invariants',async()=>{
  const f=fixture(),c=command();c.customerId='other';
  await expect(confirmPaymentAllocationInTransaction(f.tx,c,sha)).rejects.toThrow('Payment not eligible');expect(f.calls).not.toContain('append');
 });
});
