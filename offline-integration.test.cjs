'use strict';
// Node built-in test runner; TypeScript transpilation only, no DB and no app routes.
const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Module = require('node:module');
const ts = require('typescript');
const old = require.extensions['.ts'];
require.extensions['.ts'] = (module, filename) => {
  const source = fs.readFileSync(filename, 'utf8');
  const js = ts.transpileModule(source, {compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
  module._compile(js, filename);
};
const {confirmPaymentAllocation} = require('./src/lib/domain/payment-transaction.ts');
const {availableCredit,canReleaseSoaTrip,nextRefundStatus} = require('./src/lib/domain/financial-ledger.ts');
const sha = x=>crypto.createHash('sha256').update(x).digest('hex');
const actor={id:'staff-1',role:'BILLING'};
const base=()=>({paymentId:'pay-1',customerId:'cust-1',idempotencyKey:'key-1',actor,reason:'confirmed',allocations:[{invoiceId:'inv-1',cashCentavos:500n,withheldCentavos:0n}]});
function fakeStore(overrides={}) {
 const state={writes:0,operations:new Map(),lastDigest:null};
 const tx={
  async findOperation(key,digest){const p=state.operations.get(key);if(!p)return null;if(p.digest!==digest)throw Error('Idempotency conflict');return p.receipt;},
  async lockPayment(){return {customerId:'cust-1',state:'RECORDED',receivedCentavos:1000n,allocationsCentavos:0n,completedRefundsCentavos:0n,pendingRefundsCentavos:0n};},
  async lockInvoices(ids){return ids.map(id=>({id,customerId:'cust-1',outstandingCentavos:900n,eligible:true}));},
  async appendAllocationAndAudit({command,totalCashCentavos,payloadDigest}){state.writes++;state.lastDigest=payloadDigest;state.operations.set(command.idempotencyKey,{digest:payloadDigest,receipt:{operationId:'op-1',allocatedCashCentavos:totalCashCentavos}});return 'op-1';},
  ...overrides
 };
 return {state,store:{serializable:fn=>fn(tx)}};
}
test('valid allocation records once and returns receipt',async()=>{const {store,state}=fakeStore();const r=await confirmPaymentAllocation(store,base(),sha);assert.equal(r.allocatedCashCentavos,500n);assert.equal(r.replayed,false);assert.equal(state.writes,1);});
test('same-key replay does not post twice',async()=>{const {store,state}=fakeStore();await confirmPaymentAllocation(store,base(),sha);const r=await confirmPaymentAllocation(store,base(),sha);assert.equal(r.replayed,true);assert.equal(state.writes,1);});
test('different allocation with same key rejected',async()=>{const {store}=fakeStore();await confirmPaymentAllocation(store,base(),sha);const altered=base();altered.allocations[0].cashCentavos=600n;await assert.rejects(confirmPaymentAllocation(store,altered,sha),/Idempotency conflict/);});
test('cross-customer invoice blocked',async()=>{const {store,state}=fakeStore({lockInvoices:async ids=>ids.map(id=>({id,customerId:'other',outstandingCentavos:900n,eligible:true}))});await assert.rejects(confirmPaymentAllocation(store,base(),sha),/Cross-customer/);assert.equal(state.writes,0);});
test('payment credit reserved by refund cannot be allocated',async()=>{const {store,state}=fakeStore({lockPayment:async()=>({customerId:'cust-1',state:'RECORDED',receivedCentavos:1000n,allocationsCentavos:0n,completedRefundsCentavos:0n,pendingRefundsCentavos:600n})});await assert.rejects(confirmPaymentAllocation(store,base(),sha),/overallocated/);assert.equal(state.writes,0);});
test('invoice over-allocation blocked',async()=>{const {store,state}=fakeStore({lockInvoices:async ids=>ids.map(id=>({id,customerId:'cust-1',outstandingCentavos:400n,eligible:true}))});await assert.rejects(confirmPaymentAllocation(store,base(),sha),/overallocated/);assert.equal(state.writes,0);});
test('duplicate invoice entries blocked',async()=>{const {store,state}=fakeStore();const cmd=base();cmd.allocations.push({...cmd.allocations[0]});await assert.rejects(confirmPaymentAllocation(store,cmd,sha),/Duplicate invoice/);assert.equal(state.writes,0);});
test('refund reserve and SOA release guards',()=>{assert.equal(availableCredit({receivedCentavos:1000n,allocationsCentavos:400n,completedRefundsCentavos:100n,pendingRefundsCentavos:200n}),300n);assert.equal(nextRefundStatus('PENDING','FAILED'),'FAILED');assert.throws(()=>nextRefundStatus('COMPLETED','PENDING'));assert.equal(canReleaseSoaTrip({soaCancelled:true,linkedInvoiceCount:1,unreconciledInvoiceCount:0,unreconciledPaymentCount:0}),true);});
test('same-key changed actor or reason rejected',async()=>{
 const {store,state}=fakeStore();await confirmPaymentAllocation(store,base(),sha);
 for(const change of [{reason:'different reason'},{actor:{id:'another-staff',role:'ADMIN'}},{actor:{id:'staff-1',role:'ADMIN'}}]) {
  const cmd={...base(),...change};
  await assert.rejects(confirmPaymentAllocation(store,cmd,sha),/Idempotency conflict/);
 }
 assert.equal(state.writes,1);
});
test('canonical allocation order does not affect replay',async()=>{
 const {store,state}=fakeStore();const cmd=base();cmd.allocations=[{invoiceId:'inv-2',cashCentavos:200n,withheldCentavos:0n},{invoiceId:'inv-1',cashCentavos:300n,withheldCentavos:0n}];
 await confirmPaymentAllocation(store,cmd,sha);
 const reordered={...cmd,allocations:[...cmd.allocations].reverse()};
 const replay=await confirmPaymentAllocation(store,reordered,sha);
 assert.equal(replay.replayed,true);assert.equal(state.writes,1);
});
test('adapter has bounded P2002 retry path with fresh transaction',()=>{
 const src=fs.readFileSync(path.join(__dirname,'src/lib/persistence/prisma-allocation-store.ts'),'utf8');
 assert.match(src,/P2002/);assert.match(src,/MAX_RETRIES/);
 assert.match(src,/prisma\.\$transaction/);
});

test('voided payment is rejected without writing',async()=>{
 const {store,state}=fakeStore({lockPayment:async()=>({customerId:'cust-1',state:'VOIDED',receivedCentavos:1000n,allocationsCentavos:0n,completedRefundsCentavos:0n,pendingRefundsCentavos:0n})});
 await assert.rejects(confirmPaymentAllocation(store,base(),sha),/Payment not eligible/);
 assert.equal(state.writes,0);
});
test('ineligible invoice is rejected without writing',async()=>{
 const {store,state}=fakeStore({lockInvoices:async ids=>ids.map(id=>({id,customerId:'cust-1',outstandingCentavos:900n,eligible:false}))});
 await assert.rejects(confirmPaymentAllocation(store,base(),sha),/Invoice not eligible/);
 assert.equal(state.writes,0);
});
test('adapter invoice eligibility uses existing PRINTED state',()=>{
 const src=fs.readFileSync(path.join(__dirname,'src/lib/persistence/prisma-allocation-store.ts'),'utf8');
 assert.match(src,/eligible:i\.state==='PRINTED'/);
 assert.doesNotMatch(src,/eligible:i\.state==='ISSUED'/);
});
test('domain payment state matches existing VOIDED schema state',()=>{
 const src=fs.readFileSync(path.join(__dirname,'src/lib/domain/payment-transaction.ts'),'utf8');
 assert.match(src,/state: 'RECORDED' \| 'VOIDED'/);
 assert.doesNotMatch(src,/state: 'RECORDED' \| 'REVERSED'/);
});
