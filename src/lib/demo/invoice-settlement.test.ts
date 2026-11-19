import { describe,expect,it } from 'vitest';
import { createDemoSeed,executeDemo,tripBalance,demoTotals,emptyDemo,drivers,vehicles,type DemoAction } from './store';
function fixture(){
 let state=createDemoSeed(),n=0;
 const run=(a:DemoAction,key=`test-${++n}`)=>state=executeDemo(state,a,key,'BILLING');
 const a=state.trips.find(t=>t.workflow==='CORPORATE'&&!state.documents.some(d=>d.tripIds.includes(t.id)))!;
 run({type:'CREATE_TRIP',trip:{customerId:a.customerId,date:'2026-11-15',workflow:'CORPORATE',amount:101n,vehicle:vehicles[0],driver:drivers[0],itinerary:'Second corporate trip'}});
 const b=state.trips.at(-1)!;
 run({type:'CREATE_SOA',tripIds:[a.id,b.id]});const soa=state.documents.at(-1)!;
 run({type:'FINALIZE_SOA',soaId:soa.id,expectedVersion:soa.version});
 run({type:'CREATE_INVOICE',soaId:soa.id,expectedSoaVersion:state.documents.at(-1)!.version,invoiceDate:'2026-11-16'});
 const invoice=state.documents.at(-1)!;
 const command:DemoAction={type:'SETTLE_INVOICE',invoiceId:invoice.id,expectedVersion:invoice.version,allocations:[a,b].map(t=>({tripId:t.id,amount:t.amount,expectedBalance:t.amount})),method:'BANK_TRANSFER',reference:'Office collection confirmation'};
 return {run,command,a,b,invoice,get state(){return state;}};
}
describe('Invoice collection in shared atomic receipt engine',()=>{
 it('settles every member with exact centavos and no second charge or remittance',()=>{
  const f=fixture(),before=demoTotals(f.state);f.run(f.command);
  expect(tripBalance(f.state,f.a.id)).toBe(0n);expect(tripBalance(f.state,f.b.id)).toBe(0n);
  const after=demoTotals(f.state);expect(after.collections-before.collections).toBe(f.a.amount+101n);expect(after.charges).toBe(before.charges);expect(after.remitted).toBe(before.remitted);
  expect(f.state.events.at(-1)).toMatchObject({action:'SETTLE_INVOICE',entityId:f.invoice.id});
 });
 it('partial settlement uses explicit member amounts and leaves other members unpaid',()=>{
  const f=fixture();f.run({...f.command,allocations:[{tripId:f.a.id,amount:12345n,expectedBalance:f.a.amount}]});
  expect(tripBalance(f.state,f.a.id)).toBe(f.a.amount-12345n);expect(tripBalance(f.state,f.b.id)).toBe(101n);
 });
 it('replays one operation without duplicate receipts and enforces permission before replay',()=>{
  const f=fixture();f.run(f.command,'once');const before=f.state;expect(f.run(f.command,'once')).toBe(before);
  expect(()=>executeDemo(f.state,f.command,'once','VIEWER')).toThrow('Forbidden');
  expect(()=>executeDemo(f.state,f.command,'other','OPERATIONS')).toThrow('Forbidden');
 });
 it.each(['foreign','duplicate','overpayment','staleBalance','zero','empty','staleVersion','invalidChannel','missingEvidence'] as const)('rejects %s atomically',kind=>{
  const f=fixture(),before=f.state,command=structuredClone(f.command);
  if(kind==='foreign')command.allocations[1].tripId=f.state.trips.find(t=>t.customerId!==f.a.customerId)!.id;
  if(kind==='duplicate')command.allocations[1].tripId=f.a.id;
  if(kind==='overpayment')command.allocations[1].amount=102n;
  if(kind==='staleBalance')command.allocations[1].expectedBalance=102n;
  if(kind==='zero')command.allocations[1].amount=0n;
  if(kind==='empty')command.allocations=[];
  if(kind==='staleVersion')command.expectedVersion++;
  if(kind==='invalidChannel')command.method='OTHER' as typeof command.method;
  if(kind==='missingEvidence')command.reference='';
  expect(()=>f.run(command)).toThrow();expect(f.state).toBe(before);
 });
 it('rejects a concurrent receipt even when the invoice version has not changed',()=>{
  const f=fixture();f.run({type:'RECEIVE',tripId:f.b.id,amount:1n,method:'GCASH',purpose:'SETTLEMENT',collector:'OFFICE',driver:'',reference:'Another operator collection'});
  expect(()=>f.run(f.command)).toThrow('balance changed');
 });
 it('rejects cancelled invoices and SOA sources',()=>{
  const f=fixture();f.run({type:'CANCEL_INVOICE',invoiceId:f.invoice.id,expectedVersion:f.invoice.version,reason:'Wrong form',confirmedInvoiceNumber:f.invoice.invoiceNumber});
  expect(()=>f.run({...f.command,expectedVersion:f.state.documents.at(-1)!.version})).toThrow('inactive');
  expect(()=>f.run({...f.command,invoiceId:f.invoice.soaId!})).toThrow('inactive');
 });
 it('does not spend a direct advance twice when collecting a direct invoice',()=>{
  let s=executeDemo(emptyDemo(),{type:'CREATE_TRIP',trip:{customerId:'c1',date:'2026-11-15',workflow:'DIRECT',amount:10000n,vehicle:vehicles[0],driver:drivers[0],itinerary:'Advance trip'},payment:{amount:1000n,purpose:'ADVANCE',method:'GCASH',collector:'OFFICE',driver:'',reference:'Held advance'}},'trip','BILLING');
  s=executeDemo(s,{type:'CREATE_INVOICE',tripId:s.trips[0].id,invoiceDate:'2026-11-15'},'inv','BILLING');const d=s.documents[0];
  expect(()=>executeDemo(s,{type:'SETTLE_INVOICE',invoiceId:d.id,expectedVersion:d.version,allocations:[{tripId:s.trips[0].id,amount:10000n,expectedBalance:10000n}],method:'GCASH',reference:'New collection'},'collect','BILLING')).toThrow('advance');
 });
});
