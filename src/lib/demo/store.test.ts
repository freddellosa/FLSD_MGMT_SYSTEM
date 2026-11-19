import { readTripReference } from '../domain/trip-reference';
import { describe, expect, it } from 'vitest';
import { advanceAvailable, assertDemoIntegrity, createDemoSeed, demoTotals, driverHeld, emptyDemo, executeDemo, paymentSnapshot, refundAvailable, tripBalance, vehicles, drivers, type DemoAction, type DemoState } from './store';
function fixture() {
 let s=emptyDemo();let n=0;
 const run=(a:DemoAction,key=`key-${++n}`)=>{s=executeDemo(s,a,key,'BILLING');return s;};
 const add=(amount=10000n,customerId='c1')=>{run({type:'CREATE_TRIP',trip:{customerId,date:'2026-11-14',origin:'Manila',destination:'Laguna',vehicle:vehicles[0],driver:drivers[0],amount,workflow:'DIRECT'}});return s.trips.at(-1)!.id;};
 const pay=(tripId:string,amount:bigint,purpose:'SETTLEMENT'|'ADVANCE'|'DEPOSIT'='SETTLEMENT',cash=false)=>{run({type:'RECEIVE',tripId,amount,purpose,method:cash?'CASH':'GCASH',collector:cash?'DRIVER':'OFFICE',driver:drivers[0],reference:'DEMO verified receipt'});return s.payments.at(-1)!;};
 return {run,add,pay,get state(){return s;}};
}
describe('Isolated unified demo store',()=>{
 it('has deterministic seed and coherent balances',()=>{expect(createDemoSeed()).toEqual(createDemoSeed());expect(()=>assertDemoIntegrity(createDemoSeed())).not.toThrow();});
 it('supports partial/multiple receipts and refund-only excess',()=>{const f=fixture(),t=f.add();f.pay(t,4000n);const p=f.pay(t,7000n);expect(tripBalance(f.state,t)).toBe(0n);expect(refundAvailable(f.state,p)).toBe(1000n);});
 it('holds deposits and applies explicitly chosen advance',()=>{const f=fixture(),t=f.add(),p=f.pay(t,5000n,'DEPOSIT');expect(tripBalance(f.state,t)).toBe(10000n);f.run({type:'ALLOCATE',paymentId:p.id,tripId:t,amount:2000n});expect(advanceAvailable(f.state,p)).toBe(3000n);expect(tripBalance(f.state,t)).toBe(8000n);});
 it('accounts for previous advances when receiving later funds',()=>{const f=fixture(),t=f.add();f.pay(t,8000n,'ADVANCE');const p=f.pay(t,5000n);expect(p.excess).toBe(3000n);expect(tripBalance(f.state,t)).toBe(8000n);});
 it('does not spend another trip or customer funds',()=>{const f=fixture(),t=f.add(),other=f.add(),p=f.pay(t,5000n,'ADVANCE');expect(()=>f.run({type:'ALLOCATE',paymentId:p.id,tripId:other,amount:1000n})).toThrow('another trip');});
 it('blocks refund-only allocation',()=>{const f=fixture(),t=f.add(),p=f.pay(t,11000n);f.run({type:'REVERSE',allocationId:f.state.allocations[0].id,amount:1000n,reason:'DEMO correction'});expect(()=>f.run({type:'ALLOCATE',paymentId:p.id,tripId:t,amount:2000n})).toThrow();});
 it('reserves refund only once and completes without double deduction',()=>{const f=fixture(),t=f.add(),p=f.pay(t,11000n);f.run({type:'REQUEST_REFUND',paymentId:p.id,amount:1000n,method:'GCASH',recipient:'Demo customer',reason:'Excess'});expect(()=>f.run({type:'REQUEST_REFUND',paymentId:p.id,amount:1n,method:'CASH',recipient:'x',reason:'x'})).toThrow();const refundId=f.state.refunds[0].id;
 for(const next of ['APPROVED','PROCESSING','COMPLETED'] as const) f.run({type:'REFUND_STATE',refundId,next,reference:'DEMO evidence'});
 expect(paymentSnapshot(f.state,p).completedRefundsCentavos).toBe(1000n);expect(refundAvailable(f.state,p)).toBe(0n);expect(()=>f.run({type:'REFUND_STATE',refundId,next:'COMPLETED',reference:'duplicate'})).toThrow();});
 it('retains uncertain reservation and releases definitive failure',()=>{const f=fixture(),t=f.add(),p=f.pay(t,11000n);f.run({type:'REQUEST_REFUND',paymentId:p.id,amount:1000n,method:'BANK_TRANSFER',recipient:'Demo customer',reason:'Excess'});const refundId=f.state.refunds[0].id;for(const next of ['APPROVED','PROCESSING','RECONCILIATION_REQUIRED'] as const)f.run({type:'REFUND_STATE',refundId,next,reference:'DEMO evidence'});expect(refundAvailable(f.state,p)).toBe(0n);f.run({type:'REFUND_STATE',refundId,next:'FAILED',reference:'Verified no transfer'});expect(refundAvailable(f.state,p)).toBe(1000n);});
 it('keeps collection and settlement unchanged by partial remittance',()=>{const f=fixture(),t=f.add(),p=f.pay(t,4000n,'SETTLEMENT',true);const before=demoTotals(f.state);f.run({type:'TENDER',paymentId:p.id,amount:3000n,reference:'DEMO tender'});expect(driverHeld(f.state,p)).toBe(4000n);const remittanceId=f.state.remittances[0].id;f.run({type:'ACCEPT',remittanceId,counted:2000n,reference:'Counted; 1000 shortage remains'});expect(driverHeld(f.state,p)).toBe(2000n);expect(demoTotals(f.state).collections).toBe(before.collections);expect(tripBalance(f.state,t)).toBe(6000n);expect(()=>f.run({type:'ACCEPT',remittanceId,counted:2000n,reference:'duplicate'})).toThrow();});
 it('does not reserve the same cash in competing tenders',()=>{const f=fixture(),t=f.add(),p=f.pay(t,4000n,'SETTLEMENT',true);f.run({type:'TENDER',paymentId:p.id,amount:3000n,reference:'DEMO'});expect(()=>f.run({type:'TENDER',paymentId:p.id,amount:2000n,reference:'DEMO'})).toThrow();});
 it('does not create cash custody for driver-coordinated GCash',()=>{const f=fixture(),t=f.add();f.run({type:'RECEIVE',tripId:t,amount:1000n,purpose:'SETTLEMENT',method:'GCASH',collector:'DRIVER',driver:drivers[0],reference:'Company GCash demo'});expect(driverHeld(f.state,f.state.payments[0])).toBe(0n);});
 it('replays identical commands and rejects different payloads',()=>{const f=fixture(),t=f.add();const a:DemoAction={type:'RECEIVE',tripId:t,amount:1000n,purpose:'SETTLEMENT',method:'GCASH',collector:'OFFICE',driver:'',reference:'DEMO'};f.run(a,'same');const before=f.state;expect(f.run(a,'same')).toBe(before);expect(()=>f.run({...a,amount:2000n},'same')).toThrow('different payload');});
 it('enforces role before replay',()=>{const f=fixture(),t=f.add();const a:DemoAction={type:'CREATE_INVOICE',invoiceDate:'2026-11-14',tripId:t};f.run(a,'same');expect(()=>executeDemo(f.state,a,'same','VIEWER')).toThrow('Forbidden');});
 it('rolls back trip plus invalid initial payment',()=>{const f=fixture(),before=f.state;expect(()=>f.run({type:'CREATE_TRIP',trip:{customerId:'c1',date:'2026-11-14',origin:'Manila',destination:'Baguio',vehicle:vehicles[0],driver:drivers[0],amount:1000n,workflow:'DIRECT'},payment:{amount:0n,purpose:'DEPOSIT',method:'CASH',collector:'OFFICE',driver:'',reference:'DEMO'}})).toThrow();expect(f.state).toBe(before);});
 it('permits Operations trip entry but no payment capture',()=>{const f=fixture();const a:DemoAction={type:'CREATE_TRIP',trip:{customerId:'c1',date:'2026-11-14',origin:'Manila',destination:'Baguio',vehicle:vehicles[0],driver:drivers[0],amount:1000n,workflow:'DIRECT'}};expect(executeDemo(f.state,a,'op','OPERATIONS').trips).toHaveLength(1);expect(()=>executeDemo(f.state,{...a,payment:{amount:100n,purpose:'DEPOSIT',method:'CASH',collector:'OFFICE',driver:'',reference:'DEMO'}},'op2','OPERATIONS')).toThrow();});
 it('preserves corporate SOA/invoice flow without duplicate collections',()=>{let s=createDemoSeed();const t=s.trips.find(t=>t.workflow==='CORPORATE'&&!s.documents.some(d=>d.tripIds.includes(t.id)))!;const before=demoTotals(s);s=executeDemo(s,{type:'CREATE_SOA',tripIds:[t.id]},'soa','BILLING');const soa=s.documents.at(-1)!;s=executeDemo(s,{type:'FINALIZE_SOA',soaId:soa.id,expectedVersion:soa.version},'final','BILLING');s=executeDemo(s,{type:'CREATE_INVOICE',invoiceDate:t.date,soaId:soa.id,expectedSoaVersion:s.documents.find(d=>d.id===soa.id)!.version},'invoice','BILLING');expect(demoTotals(s).collections).toBe(before.collections);expect(demoTotals(s).charges).toBe(before.charges);expect(()=>executeDemo(s,{type:'CREATE_INVOICE',invoiceDate:t.date,soaId:soa.id,expectedSoaVersion:s.documents.find(d=>d.id===soa.id)!.version},'dupe','BILLING')).toThrow('already invoiced');});
 it('requires invoice for corporate collection',()=>{const s=createDemoSeed(),t=s.trips.find(t=>t.workflow==='CORPORATE'&&!s.documents.some(d=>d.type==='INVOICE'&&d.tripIds.includes(t.id)))!;expect(()=>executeDemo(s,{type:'RECEIVE',tripId:t.id,amount:100n,purpose:'SETTLEMENT',method:'CASH',collector:'OFFICE',driver:'',reference:'DEMO'},'unbilled','BILLING')).toThrow('requires');});
 it('bounds cumulative reversals',()=>{const f=fixture(),t=f.add();f.pay(t,10000n);const allocationId=f.state.allocations[0].id;f.run({type:'REVERSE',allocationId,amount:6000n,reason:'Correction'});expect(()=>f.run({type:'REVERSE',allocationId,amount:5000n,reason:'Correction'})).toThrow();});
 it('voids only dependency-free noncash error with retained audit',()=>{const f=fixture(),t=f.add(),p=f.pay(t,1000n,'ADVANCE');f.run({type:'VOID',paymentId:p.id,reason:'Duplicate erroneous demo entry'});expect(f.state.payments[0].state).toBe('VOIDED');expect(demoTotals(f.state).collections).toBe(0n);expect(f.state.events.at(-1)?.action).toBe('VOID');});
 it('blocks refund completion while driver cash remains outstanding',()=>{const f=fixture(),t=f.add(),p=f.pay(t,11000n,'SETTLEMENT',true);f.run({type:'REQUEST_REFUND',paymentId:p.id,amount:1000n,method:'CASH',recipient:'Demo',reason:'Excess'});const refundId=f.state.refunds[0].id;for(const next of ['APPROVED','PROCESSING'] as const)f.run({type:'REFUND_STATE',refundId,next,reference:'DEMO'});expect(()=>f.run({type:'REFUND_STATE',refundId,next:'COMPLETED',reference:'DEMO'})).toThrow('remittance');});
 it('rejects invalid dates and preserves source input',()=>{const s:DemoState=emptyDemo();expect(()=>executeDemo(s,{type:'CREATE_TRIP',trip:{customerId:'c1',date:'2026-02-30',origin:'M',destination:'B',vehicle:vehicles[0],driver:drivers[0],amount:100n,workflow:'DIRECT'}},'date','BILLING')).toThrow('date');expect(s.trips).toHaveLength(0);});
});

describe('Trip encoding integration',()=>{
 const schedule={startDate:'2026-11-14',startTime:'22:15',endDate:'2026-11-16',endTime:'01:45'};
 const charges={base:1000000n,fuel:150025n,toll:80010n,parking:20000n,others:9965n,othersNote:'Customer-requested stop'};
 const trip={customerId:'c1',date:schedule.startDate,origin:'Manila',destination:'Baguio',vehicle:vehicles[0],driver:drivers[0],amount:1260000n,workflow:'DIRECT' as const,schedule,charges};
 it('retains schedule and breakdown and uses computed total for settlement',()=>{
  const s=executeDemo(emptyDemo(),{type:'CREATE_TRIP',trip,payment:{amount:400000n,purpose:'SETTLEMENT',method:'GCASH',collector:'OFFICE',driver:'',reference:'Demo receipt'}},'trip-plan','BILLING');
  expect(s.trips[0].schedule).toEqual(schedule);expect(s.trips[0].charges).toEqual(charges);expect(tripBalance(s,s.trips[0].id)).toBe(860000n);expect(demoTotals(s).charges).toBe(1260000n);
 });
 it('rejects a supplied total that disagrees with component charges',()=>expect(()=>executeDemo(emptyDemo(),{type:'CREATE_TRIP',trip:{...trip,amount:1000000n}},'mismatch','BILLING')).toThrow('breakdown'));
 it('rejects an invalid schedule atomically with no payment or trip',()=>{
  const s=emptyDemo();expect(()=>executeDemo(s,{type:'CREATE_TRIP',trip:{...trip,schedule:{...schedule,endDate:'2026-11-14',endTime:'21:00'}}},'schedule','BILLING')).toThrow('after');expect(s.trips).toHaveLength(0);expect(s.payments).toHaveLength(0);
 });
});

describe('Manual VAT and legacy reference integration',()=>{
 const charges={base:1000000n,fuel:0n,toll:0n,parking:0n,food:20000n,lodging:30000n,others:0n,othersNote:''};
 const reference={passengers:'Demo passenger',reservedBy:'Demo reserver',department:'Events',destinationDetails:'Stop A\nStop B',chargeSite:'SITE-A',remarks:'Demo remarks',customerApprovedBy:'Demo representative',externalSoaReference:'EXT-04270',billedVehicleClass:'VAN' as const,odoOut:'12000',odoIn:'12125.5',vatReference:120000n,withholdingReference:0n,vatTreatment:'ADDED' as const};
 const trip={customerId:'c1',date:'2026-11-14',origin:'Manila',destination:'Baguio',vehicle:vehicles[0],driver:drivers[0],amount:1170000n,workflow:'DIRECT' as const,charges,reference};
 it('uses manually added VAT exactly once and retains all reference fields',()=>{
  const s=executeDemo(emptyDemo(),{type:'CREATE_TRIP',trip,payment:{amount:170000n,purpose:'SETTLEMENT',method:'GCASH',collector:'OFFICE',driver:'',reference:'DEMO receipt'}},'manual-vat','BILLING');
  expect(s.trips[0].reference).toEqual(reference);expect(tripBalance(s,s.trips[0].id)).toBe(1000000n);expect(demoTotals(s).charges).toBe(1170000n);
 });
 it('retains manually included VAT without adding it to the amount',()=>{
  const s=executeDemo(emptyDemo(),{type:'CREATE_TRIP',trip:{...trip,amount:1050000n,reference:{...reference,vatTreatment:'INCLUDED'}}},'included','BILLING');expect(s.trips[0].amount).toBe(1050000n);
 });
 it('keeps withholding as a reference and blocks unapproved settlement and invoice',()=>{
  const s=executeDemo(emptyDemo(),{type:'CREATE_TRIP',trip:{...trip,reference:{...reference,withholdingReference:20000n}}},'wht','BILLING');
  expect(s.trips).toHaveLength(1);expect(demoTotals(s).charges).toBe(0n);
  expect(()=>executeDemo(s,{type:'RECEIVE',tripId:s.trips[0].id,amount:100n,purpose:'SETTLEMENT',method:'GCASH',collector:'OFFICE',driver:'',reference:'DEMO'},'pay-wht','BILLING')).toThrow('accounting review');
  expect(()=>executeDemo(s,{type:'CREATE_INVOICE',invoiceDate:'2026-11-14',tripId:s.trips[0].id},'invoice-wht','BILLING')).toThrow('accounting review');
 });
});


describe('Calculated OT VAT transaction boundary',()=>{
 const build=()=>{const form=new FormData();form.set('baseAmount','10000');form.set('otFee','1000');form.set('fuel','5000');form.set('otHours','2.5');form.set('vatEnabled','on');form.set('vatTreatment','ADDED');return readTripReference(form);};
 const charges={base:1000000n,otFee:100000n,fuel:500000n,toll:0n,parking:0n,others:0n,othersNote:''};
 const trip={customerId:'c1',date:'2026-11-14',origin:'Manila',destination:'Laguna',vehicle:vehicles[0],driver:drivers[0],amount:1732000n,workflow:'DIRECT' as const,charges};
 it('rejects tampered VAT before creating any trip or financial event',()=>{const s=emptyDemo();expect(()=>executeDemo(s,{type:'CREATE_TRIP',trip:{...trip,reference:{...build(),vatReference:999999n}}},'bad-tax','BILLING')).toThrow('12% of base plus OT');expect(s.trips).toHaveLength(0);expect(s.events).toHaveLength(0);});
 it('uses base plus OT VAT in the shared receipt balance and retains reference hours',()=>{const s=executeDemo(emptyDemo(),{type:'CREATE_TRIP',trip:{...trip,reference:build()},payment:{amount:32000n,purpose:'SETTLEMENT',method:'GCASH',collector:'OFFICE',driver:'',reference:'DEMO verified'}},'ot-tax','BILLING');expect(tripBalance(s,s.trips[0].id)).toBe(1700000n);expect(s.trips[0].reference?.otHours).toBe('2.5');expect(s.trips[0].reference?.vatReference).toBe(132000n);});
});

describe('Whole-trip itinerary creation',()=>{
 const trip={customerId:'c1',date:'2026-11-14',itinerary:'Manila pickup\nTagaytay stop\nReturn to Manila',vehicle:vehicles[0],driver:drivers[0],amount:1000000n,workflow:'DIRECT' as const};
 it('saves a complete itinerary without inventing origin or destination fields',()=>{const s=executeDemo(emptyDemo(),{type:'CREATE_TRIP',trip},'itinerary','BILLING');expect(s.trips[0].itinerary).toBe(trip.itinerary);expect(s.trips[0].origin).toBe('');expect(s.trips[0].destination).toBe('');expect(tripBalance(s,s.trips[0].id)).toBe(1000000n);});
 it.each(['','   ','x'.repeat(2001)])('rejects blank or excessive itinerary',itinerary=>expect(()=>executeDemo(emptyDemo(),{type:'CREATE_TRIP',trip:{...trip,itinerary}},'bad-itinerary','BILLING')).toThrow('itinerary'));
});

