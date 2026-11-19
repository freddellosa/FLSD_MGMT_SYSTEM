import {describe,it,expect} from 'vitest';
import {emptyDemo,executeDemo,type DemoState} from '../demo/store';
import {buildProjectionPlan,projectedRows,projectionUpsertSql} from './entity-projections';

function trip(workflow:'DIRECT'|'CORPORATE'='DIRECT'){
 const initial=emptyDemo();
 return executeDemo(initial,{type:'CREATE_TRIP',trip:{customerId:'c1',vehicle:initial.vehicles[0].label,driver:initial.drivers[0].label,date:'2026-11-15',itinerary:'QA pure projection',amount:10001n,workflow}},'trip','BILLING');
}
describe('Typed persistence changes',()=>{
 it('populates unchanged seed masters and settings on the explicit first write',()=>{
  const s=trip(),plan=buildProjectionPlan(undefined,s);
  expect(plan.batches.find(b=>b.table==='pilot_customers')?.upserts).toHaveLength(s.customers.length);
  expect(plan.batches.find(b=>b.table==='pilot_invoice_formats')?.upserts).toHaveLength(1);
  expect(plan.customerFormats).toHaveLength(s.customers.length);expect(plan.settings).toHaveLength(2);
  expect(plan.batches.every(b=>b.archiveIds.length===0)).toBe(true);
 });
 it('does not write unchanged tables, memberships, formats or settings',()=>{
  const s=trip();expect(buildProjectionPlan(s,structuredClone(s))).toEqual({batches:[],customerFormats:[],memberships:[],settings:[]});
 });
 it('limits an ordinary customer edit to that customer, without touching unrelated history',()=>{
  const before=trip(),after=executeDemo(before,{type:'SAVE_CUSTOMER',customerId:'c1',expectedVersion:1,customer:{name:'Updated customer',tin:'123456789',address:'Office',contact:'',phone:'',email:''}},'customer','ADMIN');
  const plan=buildProjectionPlan(before,after);expect(plan.batches).toHaveLength(1);expect(plan.batches[0].table).toBe('pilot_customers');expect(plan.batches[0].upserts.map(r=>r.id)).toEqual(['c1']);expect(plan.batches[0].archiveIds).toEqual([]);expect(plan.customerFormats).toEqual([]);
 });
 it('keeps decimal storage exact and inserts only the new receipt and allocation',()=>{
  const before=trip(),after=executeDemo(before,{type:'RECEIVE',tripId:before.trips[0].id,amount:1234n,purpose:'SETTLEMENT',method:'GCASH',collector:'OFFICE',driver:'',reference:'QA exact receipt'},'pay','BILLING');
  const plan=buildProjectionPlan(before,after);expect(plan.batches.map(b=>b.table)).toEqual(['pilot_receipts','pilot_allocations']);expect(plan.batches[0].upserts[0].amount).toBe('12.34');expect(plan.batches[1].upserts[0].amount).toBe('12.34');
  const large=structuredClone(after);large.trips[0].amount=999999999999999999n;expect(projectedRows(large).pilot_trips[0].amount).toBe('9999999999999999.99');
 });
 it('persists reversal deltas without deleting the receipt or allocation history',()=>{
  const initial=trip(),paid=executeDemo(initial,{type:'RECEIVE',tripId:initial.trips[0].id,amount:1234n,purpose:'SETTLEMENT',method:'GCASH',collector:'OFFICE',driver:'',reference:'QA'},'pay','BILLING');
  const reversed=executeDemo(paid,{type:'REVERSE',allocationId:paid.allocations[0].id,amount:234n,reason:'QA correction'},'reverse','BILLING');
  const plan=buildProjectionPlan(paid,reversed);expect(plan.batches).toHaveLength(1);expect(plan.batches[0].table).toBe('pilot_allocations');expect(plan.batches[0].upserts[0]).toMatchObject({amount:'12.34',reversed:'2.34'});expect(plan.batches[0].archiveIds).toEqual([]);
 });
 it('archives only removed master/trip identities and retains all other rows',()=>{
  const before=trip(),after=structuredClone(before);after.vehicles=after.vehicles.filter(v=>v.id!=='vehicle-1');after.trips=[];
  const plan=buildProjectionPlan(before,after);expect(plan.batches.map(b=>({table:b.table,ids:b.archiveIds,rows:b.upserts.length}))).toEqual([{table:'pilot_vehicles',ids:['vehicle-1'],rows:0},{table:'pilot_trips',ids:[before.trips[0].id],rows:0}]);
 });
 it('rejects missing persistent financial/document history and duplicate identities',()=>{
  const before=trip(),paid=executeDemo(before,{type:'RECEIVE',tripId:before.trips[0].id,amount:1234n,purpose:'DEPOSIT',method:'GCASH',collector:'OFFICE',driver:'',reference:'QA'},'deposit','BILLING');
  const missing=structuredClone(paid);missing.payments=[];expect(()=>buildProjectionPlan(paid,missing)).toThrow('history');
  const duplicate=structuredClone(before);duplicate.trips.push({...duplicate.trips[0]});expect(()=>buildProjectionPlan(before,duplicate)).toThrow('Duplicate');
 });
 it('changes only the affected document memberships and keeps old source state immutable',()=>{
  const before=trip('CORPORATE'),after=executeDemo(before,{type:'CREATE_SOA',tripIds:[before.trips[0].id]},'soa','BILLING');
  const original=structuredClone(before),plan=buildProjectionPlan(before,after);expect(plan.memberships).toEqual([{documentId:after.documents[0].id,tripIds:[before.trips[0].id]}]);expect(before).toEqual(original);
  const labelOnly:DemoState=structuredClone(after);labelOnly.documents[0].description='Updated print description';expect(buildProjectionPlan(after,labelOnly).memberships).toEqual([]);
 });
 it('parameterizes row contents instead of interpolating customer text into SQL',()=>{
  const before=trip(),after=structuredClone(before);after.customers[0].name="QA '; DROP TABLE pilot_trips; --";
  const row=buildProjectionPlan(before,after).batches[0].upserts[0];expect(row.name).toContain('DROP TABLE');expect(projectionUpsertSql('pilot_customers')).not.toContain('DROP TABLE');expect(projectionUpsertSql('pilot_customers')).toContain('$1::jsonb');
 });
});
