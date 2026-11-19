import { describe,expect,it } from 'vitest';
import { mapWtsRows,wtsMoney,type WtsSourceRow } from './wts-import';
import { emptyDemo,executeDemo } from '../demo/store';
const row=(overrides:Record<string,string>={}):WtsSourceRow=>({row:3,cells:{J:'46312',K:'Pickup',M:'Dropoff',H:'Requester',I:'Approver',V:'Workforce',X:'WBS',Y:'Passenger',AV:'3300',BI:'3300',...overrides}});
const digest='a'.repeat(64);
describe('Accenture WTS preflight and atomic demo import',()=>{
 it('maps only matching fields, leaves unknown masters/schedule unassigned and supports blank source IDs',()=>{
  const result=mapWtsRows([row({G:'same-ref',F:''})])[0];expect(result.errors).toEqual([]);
  expect(result.trip).toMatchObject({customerId:'accenture',date:'2026-10-17',workflow:'CORPORATE',amount:330000n,vehicle:'',driver:'',itinerary:'Pickup → Dropoff'});
  expect(result.trip?.reference).toMatchObject({reservedBy:'Requester',customerApprovedBy:'Approver',department:'Workforce',chargeSite:'WBS'});
  expect(result.trip).not.toHaveProperty('G');expect(result.trip?.schedule).toBeUndefined();
 });
 it('corrects only microscopic Excel representation errors and rejects real sub-cent values',()=>{
  expect(wtsMoney('1209.5999999999999')).toBe(120960n);expect(wtsMoney('76952.299999999988')).toBe(7695230n);
  expect(()=>wtsMoney('1.005')).toThrow('precision');expect(()=>wtsMoney('-1')).toThrow();expect(()=>wtsMoney('NaN')).toThrow();
 });
 it('rejects mismatched totals and unmapped monetary charges',()=>{
  expect(mapWtsRows([row({BI:'3301'})])[0].errors[0]).toContain('breakdown');
  expect(mapWtsRows([row({AY:'100'})])[0].errors[0]).toContain('no matching');
 });
 it('rejects invalid dates and OT precision, and gates imported VAT',()=>{
  expect(mapWtsRows([row({J:'2026-02-30'})])[0].errors.length).toBe(1);
  expect(mapWtsRows([row({AO:'1.25'})])[0].errors.length).toBe(1);
  expect(mapWtsRows([row({BG:'396',BI:'3696'})])[0].trip?.reference?.vatTreatment).toBe('UNCONFIRMED');
 });
 it('generates unique stable Trip IDs per row even when source references repeat',()=>{
  const action={type:'IMPORT_WTS' as const,digest,rows:[row({G:'repeated'}),{...row({G:'repeated'}),row:4}]};
  const state=executeDemo(emptyDemo(),action,'batch','BILLING');
  expect(state.trips.map(t=>t.id)).toEqual(['TRIP-0001','TRIP-0002']);expect(state.payments).toEqual([]);expect(state.documents).toEqual([]);
  expect(executeDemo(state,action,'batch','BILLING')).toBe(state);
  expect(()=>executeDemo(state,action,'other-key','BILLING')).toThrow('already imported');
 });
 it('fails the whole batch without mutating input and enforces permissions',()=>{
  const before=emptyDemo();const action={type:'IMPORT_WTS' as const,digest,rows:[row(),row({BI:'1'})]};
  expect(()=>executeDemo(before,action,'bad','BILLING')).toThrow('Resolve');expect(before.trips).toEqual([]);
  expect(()=>executeDemo(before,{...action,rows:[row()]},'denied','VIEWER')).toThrow();
  expect(executeDemo(before,{...action,rows:[row()]},'ops','OPERATIONS').trips).toHaveLength(1);
 });
});
