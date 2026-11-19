import {describe, expect, it} from 'vitest';
import {emptyDemo, executeDemo, type DemoState, type NewDemoTrip} from './store';
import {customerInput, type CustomerVatStatus} from './workspace-settings';
import {manualTripTotal, readTripReference} from '../domain/trip-reference';
import {readTripCharges} from '../domain/trip-encoding';
import {buildProjectionPlan} from '../pilot/entity-projections';
import {decodeWire, encodeWire} from '../pilot/wire';

function classify(state: DemoState, vatStatus: CustomerVatStatus) {
  const customer = state.customers[0];
  return executeDemo(state, {type: 'SAVE_CUSTOMER', customerId: customer.id, expectedVersion: customer.version, customer: {...customer, vatStatus}}, 'classification-' + vatStatus, 'OWNER');
}
function trip(state: DemoState, mode: 'ADDED' | 'INCLUDED' | 'NONE' = 'ADDED'): NewDemoTrip {
  const form = new FormData();
  for (const [key, value] of Object.entries({baseAmount: '1000', otFee: '100', fuel: '500', parking: '50', toll: '80', food: '90', lodging: '200', others: '70'})) form.set(key, value);
  if (mode !== 'NONE') { form.set('vatEnabled', 'on'); form.set('vatTreatment', mode); }
  const reference = readTripReference(form), charges = readTripCharges(form);
  return {customerId: state.customers[0].id, date: '2026-11-16', itinerary: 'Synthetic VAT rule test', vehicle: state.vehicles[0].label,
    driver: state.drivers[0].label, workflow: 'DIRECT', reference, charges, amount: manualTripTotal(charges, reference)};
}

describe('customer VAT classification', () => {
  it.each(['VAT', 'NON_VAT', 'UNREVIEWED'] as const)('saves %s through the common command with exact projection/wire preservation', vatStatus => {
    const before = emptyDemo(), after = classify(before, vatStatus);
    expect(decodeWire<DemoState>(encodeWire(after)).customers[0].vatStatus).toBe(vatStatus);
    expect(buildProjectionPlan(before, after).batches.find(b => b.table === 'pilot_customers')?.upserts[0].payload).toMatchObject({vatStatus});
    expect(after.trips).toEqual(before.trips); expect(after.payments).toEqual(before.payments);
  });
  it('does not infer a classification for legacy customers or erase it on older client saves', () => {
    const state = classify(emptyDemo(), 'VAT'), customer = state.customers[0];
    const input = {...customer}; delete input.vatStatus;
    const result = executeDemo(state, {type: 'SAVE_CUSTOMER', customerId: customer.id, expectedVersion: customer.version, customer: input}, 'older-client', 'ADMIN');
    expect(result.customers[0].vatStatus).toBe('VAT');
    expect(customerInput(emptyDemo().customers[0])).not.toHaveProperty('vatStatus');
  });
  it('rejects unsupported client classifications and unauthorized changes', () => {
    const state = emptyDemo(), customer = state.customers[0];
    expect(() => customerInput({...customer, vatStatus: 'VAT_EXEMPT' as CustomerVatStatus})).toThrow('Choose VAT');
    expect(() => executeDemo(state, {type: 'SAVE_CUSTOMER', customerId: customer.id, expectedVersion: customer.version, customer: {...customer, vatStatus: 'VAT'}}, 'denied', 'BILLING')).toThrow('Forbidden');
  });
  it('lets Billing edit basic details while preserving the existing VAT classification', () => {
    const state = classify(emptyDemo(), 'VAT'), customer = state.customers[0];
    const input = {...customer, name:'Renamed VAT customer'};
    delete input.vatStatus;
    const edited = executeDemo(state, {type:'SAVE_CUSTOMER', customerId:customer.id, expectedVersion:customer.version, customer:input}, 'edit-basics', 'BILLING');
    expect(edited.customers[0]).toMatchObject({name:'Renamed VAT customer', vatStatus:'VAT'});
  });
  it('computes added VAT on base plus OT and excludes every expense component', () => {
    const state = classify(emptyDemo(), 'VAT'), value = trip(state);
    const after = executeDemo(state, {type: 'CREATE_TRIP', trip: value}, 'added', 'BILLING');
    expect(after.trips[0].reference?.vatReference).toBe(13200n);
    expect(after.trips[0].amount).toBe(222200n);
    expect(after.payments).toEqual([]);
  });
  it('keeps explicit included VAT inside the existing payable without adding it again', () => {
    const state = classify(emptyDemo(), 'VAT'), value = trip(state, 'INCLUDED');
    const after = executeDemo(state, {type: 'CREATE_TRIP', trip: value}, 'included', 'BILLING');
    expect(after.trips[0].amount).toBe(209000n); expect(after.trips[0].reference?.vatReference).toBe(11786n);
  });
  it('rejects disabling VAT for VAT customers and applying VAT for Non-VAT customers', () => {
    for (const [vatStatus, mode] of [['VAT', 'NONE'], ['NON_VAT', 'ADDED'], ['NON_VAT', 'INCLUDED']] as const) {
      const state = classify(emptyDemo(), vatStatus), before = structuredClone(state);
      expect(() => executeDemo(state, {type: 'CREATE_TRIP', trip: trip(state, mode)}, 'invalid', 'BILLING')).toThrow(/VAT/);
      expect(state).toEqual(before);
    }
  });
  it('stores Non-VAT trips without tax and changing customer classification never reprices history', () => {
    const state = classify(emptyDemo(), 'NON_VAT');
    const withTrip = executeDemo(state, {type: 'CREATE_TRIP', trip: trip(state, 'NONE')}, 'non-vat', 'BILLING');
    const changed = classify(withTrip, 'VAT');
    expect(changed.trips).toEqual(withTrip.trips); expect(changed.documents).toEqual(withTrip.documents);
    expect(changed.trips[0].amount).toBe(209000n);
  });
});
