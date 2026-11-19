import {describe, expect, it} from 'vitest';
import {demoTotals, emptyDemo, executeDemo, tripBalance, tripStatus, type DemoAction, type NewDemoTrip} from './store';
import {billingChargeTotals, billingTripRows, unbilledCorporateTrips} from './billing-register';
import {dashboardPercentages} from './overview';
import {readTripReference} from '../domain/trip-reference';
const context = {allowZeroDailyTrips: true as const};
function fixture() {
  const state = emptyDemo();
  const trip: NewDemoTrip = {customerId: 'c2', date: '2026-11-01', itinerary: 'Daily service', vehicle: state.vehicles[0].label, driver: state.drivers[0].label,
    workflow: 'CORPORATE', amount: 0n, charges: {base: 0n, otFee: 0n, fuel: 0n, toll: 0n, parking: 0n, others: 0n, othersNote: ''},
    schedule: {startDate: '2026-11-01', endDate: '2026-11-01', startTime: '08:00', endTime: '17:00'}};
  return {state, trip};
}
describe('ordinary daily entry and manual month-end base', () => {
  it('records zero daily activity for any valid customer without a contract, receipt or Paid label', () => {
    const f = fixture(); f.trip.customerId = 'c1'; const before = structuredClone(f.state);
    const next = executeDemo(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING', context);
    expect(next.trips).toHaveLength(1); expect(tripStatus(next, next.trips[0])).toBe('No charge recorded');
    expect(next.payments).toHaveLength(0); expect(next.allocations).toHaveLength(0); expect(demoTotals(next).outstanding).toBe(0n);
    expect(dashboardPercentages(next, '2026-11-30').settled).toBe(0); expect(f.state).toEqual(before);
    expect(executeDemo(next, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING', context)).toBe(next);
  });
  it('keeps callers without explicit zero-daily context strict', () => {
    const f = fixture(); expect(() => executeDemo(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING')).toThrow();
    f.trip.amount = 100n; f.trip.charges!.otFee = 100n;
    expect(executeDemo(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'fee', 'BILLING').trips[0].amount).toBe(100n);
  });
  it('sums daily fields and the month-end fixed base exactly once, retaining zero members and excluding unselected regular requests', () => {
    const f = fixture(); let state = f.state; const ids: string[] = [];
    const add = (trip: NewDemoTrip) => {state = executeDemo(state, {type: 'CREATE_TRIP', trip}, 'trip-' + ids.length, 'BILLING', context); ids.push(state.trips.at(-1)!.id);};
    add(f.trip);
    add({...f.trip, amount: 12003n, charges: {...f.trip.charges!, otFee: 10001n, toll: 2002n}});
    add({...f.trip, date: '2026-11-30', schedule: {...f.trip.schedule!, startDate: '2026-11-30', endDate: '2026-11-30'}, amount: 7770007n,
      charges: {...f.trip.charges!, base: 7700000n, otFee: 30003n, fuel: 40004n}});
    add({...f.trip, amount: 450000n, charges: {...f.trip.charges!, base: 450000n}, vehicle: state.vehicles[1].label});
    state = executeDemo(state, {type: 'CREATE_SOA', tripIds: ids.slice(0, 3)}, 'soa', 'BILLING', context);
    const soa = state.documents.at(-1)!;
    expect(soa).toMatchObject({tripIds: ids.slice(0, 3), amountSnapshot: 7782010n});
    expect(billingChargeTotals(billingTripRows(state.trips.filter(t => soa.tripIds.includes(t.id)), state))).toMatchObject({base: 7700000n, ot: 40004n, fuel: 40004n, toll: 2002n, amount: 7782010n});
    expect(unbilledCorporateTrips(state).map(t => t.id)).toEqual([ids[3]]);
    expect(() => executeDemo(state, {type: 'CREATE_SOA', tripIds: [ids[0]]}, 'duplicate-billing', 'BILLING', context)).toThrow('assigned');
  });
  it('settles only positive invoice members through the existing engine and never creates a zero-value receipt', () => {
    const f = fixture(); let state = executeDemo(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING', context);
    const zero = state.trips[0].id;
    state = executeDemo(state, {type: 'CREATE_TRIP', trip: {...f.trip, amount: 12345n, charges: {...f.trip.charges!, base: 12345n}}}, 'fixed', 'BILLING', context);
    const positive = state.trips[1].id;
    state = executeDemo(state, {type: 'CREATE_SOA', tripIds: [zero, positive]}, 'soa', 'BILLING', context); const soa = state.documents.at(-1)!;
    state = executeDemo(state, {type: 'FINALIZE_SOA', soaId: soa.id, expectedVersion: 1}, 'finalize', 'BILLING', context);
    state = executeDemo(state, {type: 'CREATE_INVOICE', soaId: soa.id, expectedSoaVersion: 2, invoiceDate: '2026-11-30'}, 'invoice', 'BILLING', context);
    const invoice = state.documents.at(-1)!;
    const command: DemoAction = {type: 'SETTLE_INVOICE', invoiceId: invoice.id, expectedVersion: invoice.version,
      allocations: [{tripId: positive, amount: 12345n, expectedBalance: 12345n}], method: 'BANK_TRANSFER', reference: 'QA verified invoice receipt', receivedDate: '2026-11-19'};
    state = executeDemo(state, command, 'collect', 'BILLING', context);
    expect(state.payments).toHaveLength(1); expect(state.payments[0].tripId).toBe(positive); expect(tripBalance(state, positive)).toBe(0n);
    expect(tripStatus(state, state.trips[0])).toBe('No charge recorded'); expect(executeDemo(state, command, 'collect', 'BILLING', context)).toBe(state);
  });
  it('rejects a zero-only SOA until a positive charge is selected', () => {
    const f = fixture(), state = executeDemo(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING', context);
    expect(() => executeDemo(state, {type: 'CREATE_SOA', tripIds: [state.trips[0].id]}, 'soa', 'BILLING', context)).toThrow();
    expect(state.documents).toHaveLength(0);
  });
  it.each(['SETTLEMENT', 'ADVANCE', 'DEPOSIT'] as const)('does not create a %s against a zero-charge trip', purpose => {
    const f = fixture(), state = executeDemo(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING', context);
    expect(() => executeDemo(state, {type: 'RECEIVE', tripId: state.trips[0].id, amount: 100n, purpose, method: 'CASH', collector: 'OFFICE', driver: '', reference: 'QA receipt'}, 'pay', 'BILLING', context)).toThrow('No charge to collect');
    expect(state.payments).toHaveLength(0);
  });
  it('rejects initial receipts and incomplete charge breakdowns atomically', () => {
    const f = fixture();
    expect(() => executeDemo(f.state, {type: 'CREATE_TRIP', trip: f.trip, payment: {amount: 100n, purpose: 'DEPOSIT', method: 'CASH', collector: 'OFFICE', driver: '', reference: 'QA deposit'}}, 'zero', 'BILLING', context)).toThrow('without an initial receipt');
    expect(() => executeDemo(f.state, {type: 'CREATE_TRIP', trip: {...f.trip, charges: undefined}}, 'no-breakdown', 'BILLING', context)).toThrow();
    expect(f.state.trips).toHaveLength(0); expect(f.state.events).toHaveLength(0);
  });
  it('retains explicit VAT treatment and does not infer Non-VAT from zero', () => {
    const f = fixture(); f.state.customers.find(c => c.id === 'c2')!.vatStatus = 'VAT';
    expect(() => executeDemo(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'BILLING', context)).toThrow('explicit added or included');
    const form = new FormData(); form.set('vatEnabled', 'on'); form.set('vatTreatment', 'ADDED');
    const state = executeDemo(f.state, {type: 'CREATE_TRIP', trip: {...f.trip, reference: readTripReference(form)}}, 'zero', 'BILLING', context);
    expect(state.trips[0].reference?.vatTreatment).toBe('ADDED'); expect(state.trips[0].reference?.vatReference).toBe(0n);
  });
  it('rejects retired contract payloads and retains role restrictions', () => {
    const f = fixture();
    expect(() => executeDemo(f.state, {type: 'CREATE_TRIP', trip: {...f.trip, arrangement: {kind: 'MONTHLY_CONTRACT_USAGE'}} as NewDemoTrip}, 'old', 'BILLING', context)).toThrow('retired');
    expect(() => executeDemo(f.state, {type: 'CREATE_TRIP', trip: f.trip}, 'zero', 'VIEWER', context)).toThrow('Forbidden');
  });
});
