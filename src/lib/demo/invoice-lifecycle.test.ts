import { describe,expect,it } from 'vitest';
import { emptyDemo,executeDemo,vehicles,drivers,demoTotals,type DemoAction } from './store';
import { activeInvoice } from './invoice-lifecycle';
import { soaRows,corporateInvoiceRows } from './billing-register';
import type { Role } from '../security/permissions';
function fixture(){
 let state=emptyDemo(),n=0;
 const run=(action:DemoAction,role:Role='BILLING',key=`op-${++n}`)=>state=executeDemo(state,action,key,role);
 for(let i=0;i<2;i++)run({type:'CREATE_TRIP',trip:{customerId:'c2',date:'2026-11-15',itinerary:`Demo trip ${i}`,amount:10000n+BigInt(i)*100n,vehicle:vehicles[0],driver:drivers[0],workflow:'CORPORATE'}});
 const trips=state.trips.map(t=>t.id);
 for(const trip of trips){run({type:'CREATE_SOA',tripIds:[trip]});run({type:'FINALIZE_SOA',soaId:state.documents.at(-1)!.id,expectedVersion:1});}
 const [a,b]=state.documents;
 run({type:'CREATE_INVOICE',soaId:a.id,expectedSoaVersion:2,invoiceDate:'2026-11-15'});
 const invoiceId=state.documents.at(-1)!.id;
 return {run,trips,a:a.id,b:b.id,invoiceId,get state(){return state;},get invoice(){return state.documents.find(d=>d.id===invoiceId)!;},get version(){return {invoiceId,expectedVersion:state.documents.find(d=>d.id===invoiceId)!.version};}};
}
describe('Pre-printed invoice form lifecycle',()=>{
 it('edits only description and customer receipt without changing charges, number or finances',()=>{
  const f=fixture(),before=demoTotals(f.state),original=f.invoice;
  f.run({type:'UPDATE_INVOICE_DETAILS',...f.version,description:'Corrected description',receivedDate:'2026-11-16'});
  expect(f.invoice).toMatchObject({description:'Corrected description',receivedDate:'2026-11-16',invoiceNumber:original.invoiceNumber,amountSnapshot:original.amountSnapshot,invoiceDate:original.invoiceDate,customerId:original.customerId});expect(demoTotals(f.state)).toEqual(before);
  expect(()=>f.run({type:'UPDATE_INVOICE_DETAILS',...f.version,description:'',receivedDate:''})).toThrow('cannot be cleared');
 });
 it('requires inspection after a failed print and preserves the same physical number on clean retry',()=>{
  const f=fixture(),number=f.invoice.invoiceNumber;
  f.run({type:'INVOICE_PRINT_RESULT',...f.version,outcome:'FAILED',reason:'Paper feed failure'});
  expect(()=>f.run({type:'CLEAR_INVOICE_ASSIGNMENT',...f.version,reason:'Retry'})).toThrow('inspected clean');
  expect(()=>f.run({type:'INVOICE_PRINT_RESULT',...f.version,outcome:'SUCCESS',reason:'Retry'})).toThrow('Inspect');
  f.run({type:'INSPECT_INVOICE_FORM',...f.version,usable:true,reason:'Form checked: blank, clean and usable'});
  f.run({type:'INVOICE_PRINT_RESULT',...f.version,outcome:'SUCCESS',reason:'Retry completed'});
  expect(f.invoice.invoiceNumber).toBe(number);expect(f.invoice.printState).toBe('USED');expect(f.state.invoiceStock.next).toBe(1002);
  expect(()=>f.run({type:'CLEAR_INVOICE_ASSIGNMENT',...f.version,reason:'Reuse used'})).toThrow();
 });
 it('unlocks the SOA and reassigns the same clean form to one final SOA without consuming stock',()=>{
  const f=fixture(),number=f.invoice.invoiceNumber,before=demoTotals(f.state);
  f.run({type:'CLEAR_INVOICE_ASSIGNMENT',...f.version,reason:'Wrong SOA, unprinted form'});
  expect(f.invoice.invoiceState).toBe('AVAILABLE');expect(soaRows(f.state).find(r=>r.id===f.a)?.status).toBe('Draft');
  f.run({type:'EDIT_SOA',soaId:f.a,expectedVersion:f.state.documents.find(d=>d.id===f.a)!.version,tripIds:[f.trips[0]]});
  f.run({type:'REASSIGN_INVOICE',...f.version,soaId:f.b,expectedSoaVersion:2,invoiceDate:'2026-11-16'});
  expect(f.invoice).toMatchObject({invoiceNumber:number,soaId:f.b,invoiceState:'ACTIVE',amountSnapshot:10100n});expect(f.invoice.assignmentHistory?.[0].soaId).toBe(f.a);
  expect(f.state.documents.filter(activeInvoice)).toHaveLength(1);expect(f.state.invoiceStock.next).toBe(1002);expect(demoTotals(f.state)).toEqual(before);
 });
 it('blocks clearing and cancellation until allocations are reversed, without deleting receipts',()=>{
  const f=fixture();f.run({type:'RECEIVE',tripId:f.trips[0],amount:5000n,purpose:'SETTLEMENT',method:'GCASH',collector:'OFFICE',driver:'',reference:'Demo reference'});
  for(const type of ['CLEAR_INVOICE_ASSIGNMENT','CANCEL_INVOICE'] as const)expect(()=>f.run({type,...f.version,reason:'Correction'})).toThrow('Reverse existing');
  const a=f.state.allocations[0];f.run({type:'REVERSE',allocationId:a.id,amount:a.amount,reason:'Correction'});
  f.run({type:'CANCEL_INVOICE',...f.version,reason:'Incorrect document',confirmedInvoiceNumber:f.invoice.invoiceNumber});
  expect(f.state.payments).toHaveLength(1);expect(f.state.allocations[0].reversed).toBe(5000n);expect(corporateInvoiceRows(f.state)[0].status).toBe('Cancelled');
  expect(()=>f.run({type:'RECEIVE',tripId:f.trips[0],amount:1n,purpose:'SETTLEMENT',method:'GCASH',collector:'OFFICE',driver:'',reference:'Blocked'})).toThrow('requires a demo-issued invoice');
  expect(()=>f.run({type:'REASSIGN_INVOICE',...f.version,soaId:f.b,expectedSoaVersion:2,invoiceDate:'2026-11-16'})).toThrow('available');
 });
 it('never reuses spoiled forms or customer-received forms',()=>{
  const f=fixture();f.run({type:'INVOICE_PRINT_RESULT',...f.version,outcome:'FAILED',reason:'Ink smudge'});f.run({type:'INSPECT_INVOICE_FORM',...f.version,usable:false,reason:'Spoiled form'});
  expect(()=>f.run({type:'CLEAR_INVOICE_ASSIGNMENT',...f.version,reason:'Reuse'})).toThrow();
  const g=fixture();g.run({type:'UPDATE_INVOICE_DETAILS',...g.version,description:'',receivedDate:'2026-11-16'});expect(()=>g.run({type:'CLEAR_INVOICE_ASSIGNMENT',...g.version,reason:'Reuse'})).toThrow();
 });
 it('rejects stale edits, missing reasons and non-final reassignment atomically',()=>{
  const f=fixture(),old=f.version,before=f.state;
  expect(()=>f.run({type:'CLEAR_INVOICE_ASSIGNMENT',...f.version,reason:''})).toThrow();expect(f.state).toBe(before);
  f.run({type:'CLEAR_INVOICE_ASSIGNMENT',...f.version,reason:'Correction'});
  expect(()=>f.run({type:'REASSIGN_INVOICE',...f.version,soaId:f.a,expectedSoaVersion:3,invoiceDate:'2026-11-16'})).toThrow('current final');
  expect(()=>f.run({type:'UPDATE_INVOICE_DETAILS',...old,description:'stale',receivedDate:''})).toThrow('changed');
 });
 it.each(['VIEWER','OPERATIONS'] as Role[])('denies invoice lifecycle mutations to %s',role=>{
  const f=fixture();expect(()=>f.run({type:'UPDATE_INVOICE_DETAILS',...f.version,description:'Denied',receivedDate:''},role)).toThrow('Forbidden');expect(()=>f.run({type:'CANCEL_INVOICE',...f.version,reason:'Denied'},role)).toThrow('Forbidden');
 });
 it('replays a clear command idempotently without duplicating history',()=>{
  const f=fixture();const action:DemoAction={type:'CLEAR_INVOICE_ASSIGNMENT',...f.version,reason:'Wrong assignment'};f.run(action,'BILLING','same-key');const state=f.state;f.run(action,'BILLING','same-key');expect(f.state).toBe(state);expect(f.invoice.assignmentHistory).toHaveLength(1);
 });
});
