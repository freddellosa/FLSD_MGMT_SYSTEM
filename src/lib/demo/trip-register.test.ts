import { describe, expect, it } from 'vitest';
import { createDemoSeed } from './store';
import { sortTripRows, tripColumns, tripRegisterRows, type TripRegisterRow } from './trip-register';
const a:TripRegisterRow={id:'TRIP-2',date:'2026-11-14',passenger:'Zoe',itinerary:'Airport',chargeLocation:'SITE-A',workflow:'Corporate',settlement:'Unpaid',amount:90000n};
const b:TripRegisterRow={id:'TRIP-10',date:'2026-11-15',passenger:'Ana',itinerary:'Beach',chargeLocation:'SITE-B',workflow:'Direct pay',settlement:'Settled',amount:100000n};
describe('Trip register projection and sorting',()=>{
 it('projects exactly the eight requested fields',()=>{const rows=tripRegisterRows(createDemoSeed(),true);expect(Object.keys(rows[0])).toEqual(['id','date','passenger','itinerary','chargeLocation','workflow','settlement','amount']);expect(rows[0].itinerary).toBe('Quezon City → Tagaytay');});
 it('masks settlement before sorting or export for restricted roles',()=>expect(tripRegisterRows(createDemoSeed(),false).every(r=>r.settlement==='Restricted')).toBe(true));
 it('preserves whole passenger and itinerary values',()=>{const s=createDemoSeed();s.trips[0].itinerary='Pickup\nStop\nReturn';s.trips[0].reference={passengers:'Guest A\nGuest B',reservedBy:'',department:'',destinationDetails:'',chargeSite:'',remarks:'',customerApprovedBy:'',externalSoaReference:'',odoOut:'',odoIn:'',vatReference:0n,withholdingReference:0n};expect(tripRegisterRows(s,true)[0]).toMatchObject({passenger:'Guest A\nGuest B',itinerary:'Pickup\nStop\nReturn'});});
 for(const col of tripColumns) for(const direction of ['asc','desc'] as const) it(`sorts ${col.label} ${direction}`,()=>{
  const ascending=col.key==='passenger'||col.key==='settlement'?[b.id,a.id]:[a.id,b.id];
  expect(sortTripRows([b,a],{key:col.key,direction}).map(row=>row.id)).toEqual(direction==='asc'?ascending:[...ascending].reverse());
 });
 it('does not mutate input and resolves ties deterministically',()=>{const rows=[{...a,id:'TRIP-10'},{...a,id:'TRIP-2'}];expect(sortTripRows(rows,{key:'amount',direction:'desc'}).map(r=>r.id)).toEqual(['TRIP-2','TRIP-10']);expect(rows[0].id).toBe('TRIP-10');});
 it('compares large centavo amounts without floating point conversion',()=>{const rows=[{...a,amount:999999999999999998n},{...b,amount:999999999999999999n}];expect(sortTripRows(rows,{key:'amount',direction:'asc'})[0].id).toBe(a.id);});
});

