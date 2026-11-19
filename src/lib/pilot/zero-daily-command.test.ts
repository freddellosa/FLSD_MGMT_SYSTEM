import {describe, expect, it} from 'vitest';
import {executePilotCommand} from './command';
import {emptyDemo, tripStatus, type DemoAction, type NewDemoTrip} from '../demo/store';
import {encodeWire, decodeWire} from './wire';
import {buildProjectionPlan, projectedRows} from './entity-projections';
import {readTripReference} from '../domain/trip-reference';
const capability = {zeroChargeTrips: true as const};
function fixture() {
  const state = emptyDemo();
  const trip: NewDemoTrip = {customerId: 'c2', date: '2026-11-01', itinerary: 'QA daily service', vehicle: state.vehicles[0].label, driver: state.drivers[0].label,
    workflow: 'CORPORATE', amount: 0n, charges: {base: 0n, otFee: 0n, fuel: 0n, toll: 0n, parking: 0n, others: 0n, othersNote: ''},
    schedule: {startDate: '2026-11-01', endDate: '2026-11-01', startTime: '08:00', endTime: '17:00'}};
  return {state, trip};
}
describe('schema-gated pilot zero-daily command support, offline only', () => {
  it('keeps current runtime strict with a safe schema message and no mutation', () => {
    const f = fixture(), before = structuredClone(f.state);
    expect(() => executePilotCommand(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING')).toThrow('reviewed pilot schema upgrade');
    expect(f.state).toEqual(before);
    const positive = {...f.trip, amount: 1n, charges: {...f.trip.charges!, base: 1n}};
    expect(executePilotCommand(f.state, {type: 'CREATE_TRIP', trip: positive}, 'positive', 'BILLING').trips[0].amount).toBe(1n);
  });
  it('accepts a complete zero daily record only through trusted capability and round-trips exact wire/projection values', () => {
    const f = fixture(), action = decodeWire<DemoAction>(encodeWire({type: 'CREATE_TRIP', trip: f.trip}));
    const next = executePilotCommand(f.state, action, 'zero', 'OPERATIONS', capability);
    expect(tripStatus(next, next.trips[0])).toBe('No charge recorded');
    expect(next.payments).toEqual([]); expect(next.allocations).toEqual([]);
    const restored = decodeWire<typeof next>(encodeWire(next));
    expect(restored.trips[0].amount).toBe(0n);
    expect(projectedRows(restored).pilot_trips[0].amount).toBe('0.00');
    expect(buildProjectionPlan(f.state, restored).batches.map(b => b.table)).toEqual(['pilot_trips']);
  });
  it('checks current permissions before accepting the capability or replay', () => {
    const f = fixture(), action: DemoAction = {type: 'CREATE_TRIP', trip: f.trip};
    const next = executePilotCommand(f.state, action, 'zero', 'BILLING', capability);
    expect(() => executePilotCommand(next, action, 'zero', 'VIEWER', capability)).toThrow('Forbidden');
    expect(() => executePilotCommand(f.state, action, 'zero', 'VIEWER')).toThrow('Forbidden');
  });
  it('preserves replay and rejects changed payloads without duplicate trips or audit events', () => {
    const f = fixture(), action: DemoAction = {type: 'CREATE_TRIP', trip: f.trip};
    const next = executePilotCommand(f.state, action, 'zero', 'BILLING', capability);
    expect(executePilotCommand(next, action, 'zero', 'BILLING', capability)).toBe(next);
    expect(() => executePilotCommand(next, {...action, trip: {...f.trip, itinerary: 'Changed'}}, 'zero', 'BILLING', capability)).toThrow('reused');
    expect(next.trips).toHaveLength(1); expect(next.events).toHaveLength(1);
  });
  it('does not accept a request capability or client role as authority', () => {
    const f = fixture();
    expect(() => executePilotCommand(f.state, {type: 'CREATE_TRIP', trip: f.trip, capabilities: capability} as DemoAction, 'zero', 'BILLING')).toThrow('Unsupported command fields');
    expect(() => executePilotCommand(f.state, {type: 'CREATE_TRIP', trip: {...f.trip, allowZeroDailyTrips: true}} as DemoAction, 'zero', 'BILLING')).toThrow('schema upgrade');
    expect(() => executePilotCommand(f.state, {type: 'CREATE_TRIP', trip: {...f.trip, role: 'OWNER'}} as DemoAction, 'zero', 'BILLING', capability)).toThrow('Client identity');
  });
  it.each(['SETTLEMENT', 'ADVANCE', 'DEPOSIT'] as const)('rejects %s on zero daily scope, including initial receipt atomically', purpose => {
    const f = fixture(), payment = {amount: 1n, purpose, method: 'CASH' as const, collector: 'OFFICE' as const, driver: '', reference: 'QA receipt'};
    expect(() => executePilotCommand(f.state, {type: 'CREATE_TRIP', trip: f.trip, payment}, 'initial', 'BILLING', capability)).toThrow('without an initial receipt');
    const next = executePilotCommand(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING', capability);
    expect(() => executePilotCommand(next, {type: 'RECEIVE', tripId: next.trips[0].id, ...payment}, 'pay', 'BILLING', capability)).toThrow('No charge to collect');
    expect(f.state.trips).toHaveLength(0); expect(next.payments).toHaveLength(0);
  });
  it('rejects missing/negative components and mismatched saved totals', () => {
    const f = fixture();
    for (const trip of [{...f.trip, charges: undefined}, {...f.trip, charges: {...f.trip.charges!, base: -1n}}, {...f.trip, charges: {...f.trip.charges!, otFee: 1n}}]) {
      expect(() => executePilotCommand(f.state, {type: 'CREATE_TRIP', trip}, 'bad', 'BILLING', capability)).toThrow();
    }
    expect(f.state.events).toHaveLength(0);
  });
  it('keeps explicit VAT treatment required even for zero taxable base', () => {
    const f = fixture(); f.state.customers.find(c => c.id === 'c2')!.vatStatus = 'VAT';
    expect(() => executePilotCommand(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING', capability)).toThrow('explicit added or included');
    const form = new FormData(); form.set('vatEnabled', 'on'); form.set('vatTreatment', 'ADDED');
    expect(executePilotCommand(f.state, {type: 'CREATE_TRIP', trip: {...f.trip, reference: readTripReference(form)}}, 'vat', 'BILLING', capability).trips[0].reference?.vatReference).toBe(0n);
  });
  it('preserves zero members in a positive SOA but rejects zero-only SOA and duplicate active membership', () => {
    const f = fixture(); let state = executePilotCommand(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING', capability);
    const zero = state.trips[0].id;
    expect(() => executePilotCommand(state, {type: 'CREATE_SOA', tripIds: [zero]}, 'zero-soa', 'BILLING', capability)).toThrow();
    state = executePilotCommand(state, {type: 'CREATE_TRIP', trip: {...f.trip, amount: 7000001n, charges: {...f.trip.charges!, base: 7000000n, otFee: 1n}}}, 'monthend', 'BILLING', capability);
    const ids = state.trips.map(t => t.id);
    state = executePilotCommand(state, {type: 'CREATE_SOA', tripIds: ids}, 'soa', 'BILLING', capability);
    expect(state.documents[0]).toMatchObject({tripIds: ids, amountSnapshot: 7000001n});
    expect(() => executePilotCommand(state, {type: 'CREATE_SOA', tripIds: ids}, 'duplicate', 'BILLING', capability)).toThrow('assigned');
  });
  it('supports zero daily editing before billing and retains stale-version and financial-history locks', () => {
    const f = fixture(); let state = executePilotCommand(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING', capability);
    const tripId = state.trips[0].id;
    const edit = {itinerary: 'QA corrected daily itinerary', origin: '', vehicle: f.trip.vehicle, driver: f.trip.driver, schedule: f.trip.schedule,
      operationalStatus: 'COMPLETED' as const, passengers: '', remarks: '', reason: 'QA correction'};
    const command: DemoAction = {type: 'EDIT_TRIP', tripId, expectedVersion: 1, edit, replacement: {...f.trip, itinerary: edit.itinerary}};
    expect(() => executePilotCommand(state, command, 'edit-no-schema', 'BILLING')).toThrow('schema upgrade');
    state = executePilotCommand(state, command, 'edit', 'BILLING', capability);
    expect(state.trips[0].version).toBe(2);
    expect(() => executePilotCommand(state, command, 'stale', 'BILLING', capability)).toThrow('changed');
    state = executePilotCommand(state, {type: 'CREATE_TRIP', trip: {...f.trip, amount: 100n, charges: {...f.trip.charges!, base: 100n}}}, 'positive', 'BILLING', capability);
    state = executePilotCommand(state, {type: 'CREATE_SOA', tripIds: state.trips.map(t => t.id)}, 'soa', 'BILLING', capability);
    expect(() => executePilotCommand(state, {...command, expectedVersion: 2, replacement: {...f.trip, amount: 1n, charges: {...f.trip.charges!, otFee: 1n}}}, 'financial-edit', 'BILLING', capability)).toThrow('history');
  });
});
