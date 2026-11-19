import {describe,it,expect} from 'vitest';
import {randomUUID} from 'node:crypto';
import {pilotDatabase,assertPilotDatabase,type PilotTx} from '../../src/lib/pilot/database';
import {decodeWire} from '../../src/lib/pilot/wire';
import {executeDemo,type DemoState,type DemoAction} from '../../src/lib/demo/store';
import {persistProjections} from '../../src/lib/pilot/projection-repository';
import {hydrateEvidence} from '../../src/lib/pilot/evidence-repository';

async function rollbackOnly(work:(tx:PilotTx,state:DemoState)=>Promise<void>){
 const rollback=new Error('ROLLBACK_VERIFICATION_ONLY');
 try{await pilotDatabase().$transaction(async tx=>{await assertPilotDatabase(tx);const rows=await tx.$queryRaw<{state:unknown}[]>`SELECT state FROM pilot_workspace WHERE id=1 FOR UPDATE`;const state=decodeWire<DemoState>(JSON.stringify(rows[0].state));await hydrateEvidence(tx,state);await work(tx,state);throw rollback;},{isolationLevel:'Serializable',timeout:30000});throw new Error('Expected forced rollback');}catch(e){if(e!==rollback)throw e;}
}
const apply=(s:DemoState,a:DemoAction)=>executeDemo(s,a,randomUUID(),'OWNER');
describe('Projection repository in rollback-only isolated PostgreSQL transactions',()=>{
 it('stores exact new receipts and reversals atomically without retaining QA records',async()=>{
  let paymentId='';await rollbackOnly(async(tx,before)=>{
   const tag=randomUUID().slice(0,8);let s=apply(before,{type:'SAVE_CUSTOMER',customer:{name:'QA rollback-only '+tag,tin:'',address:'',email:'',phone:'',contact:''}});const customerId=s.customers.at(-1)!.id;
   s=apply(s,{type:'SAVE_VEHICLE',vehicle:{model:'QA rollback van '+tag,plate:'QR-'+tag,color:'',capacity:'',notes:''}});const vehicle=s.vehicles.at(-1)!.label;
   s=apply(s,{type:'SAVE_DRIVER',driver:{name:'QA rollback driver '+tag,phone:'',license:'',notes:''}});const driver=s.drivers.at(-1)!.label;
   s=apply(s,{type:'CREATE_TRIP',trip:{customerId,vehicle,driver,date:'2026-11-15',itinerary:'QA rollback only',amount:10001n,workflow:'DIRECT'}});
   s=apply(s,{type:'RECEIVE',tripId:s.trips.at(-1)!.id,amount:1234n,purpose:'SETTLEMENT',method:'GCASH',collector:'OFFICE',driver:'',reference:'QA rollback-only exact'});
   await persistProjections(tx,before,s);paymentId=s.payments.at(-1)!.id;
   const receipts=await tx.$queryRaw<{amount:string}[]>`SELECT amount::text FROM pilot_receipts WHERE id=${paymentId}`;expect(receipts[0].amount).toBe('12.34');
   const reversed=apply(s,{type:'REVERSE',allocationId:s.allocations.at(-1)!.id,amount:234n,reason:'QA rollback-only'});await persistProjections(tx,s,reversed);
   const amounts=await tx.$queryRaw<{amount:string;reversed:string}[]>`SELECT amount::text,reversed::text FROM pilot_allocations WHERE receipt_id=${paymentId}`;expect(amounts[0]).toEqual({amount:'12.34',reversed:'2.34'});
   const large=apply(reversed,{type:'CREATE_TRIP',trip:{customerId,vehicle,driver,date:'2026-11-15',itinerary:'QA exact limit rollback only',amount:999999999999999999n,workflow:'DIRECT'}});await persistProjections(tx,reversed,large);
   const largeId=large.trips.at(-1)!.id,exact=await tx.$queryRaw<{amount:string;payload:unknown}[]>`SELECT amount::text,payload FROM pilot_trips WHERE id=${largeId}`;expect(exact[0].amount).toBe('9999999999999999.99');expect(decodeWire<{amount:bigint}>(JSON.stringify(exact[0].payload)).amount).toBe(999999999999999999n);
  });expect(await pilotDatabase().$queryRaw`SELECT id FROM pilot_receipts WHERE id=${paymentId}`).toEqual([]);
 });
 it('archives only a removed vehicle and permits active-plate reuse without deleting history',async()=>{
  await rollbackOnly(async(tx,before)=>{
   const tag=randomUUID().slice(0,8),plate='QR-'+tag;const added=apply(before,{type:'SAVE_VEHICLE',vehicle:{model:'QA old '+tag,plate,color:'',capacity:'',notes:''}});await persistProjections(tx,before,added);const id=added.vehicles.at(-1)!.id;
   const removed=apply(added,{type:'CATALOG_STATE',kind:'VEHICLE',id,expectedVersion:1,remove:true});
   const replaced=apply(removed,{type:'SAVE_VEHICLE',vehicle:{model:'QA new '+tag,plate,color:'',capacity:'',notes:''}});await persistProjections(tx,added,replaced);
   const rows=await tx.$queryRaw<{archived:boolean}[]>`SELECT archived FROM pilot_vehicles WHERE plate=${plate.toUpperCase()} ORDER BY archived`;expect(rows).toEqual([{archived:false},{archived:true}]);
  });
 });
 it('initializes relational seed records when no predecessor is supplied',async()=>{
  await rollbackOnly(async(tx,before)=>{await persistProjections(tx,undefined,before);const rows=await tx.$queryRaw<{count:bigint}[]>`SELECT count(*) FROM pilot_customers WHERE archived=false`;expect(rows[0].count).toBe(BigInt(before.customers.length));});
 });
 it('does not confuse account-only workspace revisions with initialized business projections',async()=>{
  await rollbackOnly(async(tx,before)=>{
   await tx.$executeRaw`UPDATE pilot_settings SET id='QA-ROLLBACK-INIT-PROBE' WHERE id='invoice_stock'`;
   const customer=before.customers[0];await tx.$executeRaw`UPDATE pilot_customers SET name='QA rollback stale projection' WHERE id=${customer.id}`;
   await persistProjections(tx,before,before);
   const rows=await tx.$queryRaw<{name:string}[]>`SELECT name FROM pilot_customers WHERE id=${customer.id}`;expect(rows[0].name).toBe(customer.name);
   expect(await tx.$queryRaw`SELECT id FROM pilot_settings WHERE id='invoice_stock'`).toHaveLength(1);
  });
 });
});
