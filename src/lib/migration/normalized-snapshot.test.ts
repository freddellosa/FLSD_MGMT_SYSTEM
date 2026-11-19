import {describe, expect, it} from 'vitest';
import dictionary from '../../../docs/NORMALIZED_IMPORT_SNAPSHOT_CONTRACT.json';
import {normalizedContractSha256, normalizedCoverageSha256, normalizedSlotDefinitions, validateAndProjectNormalizedSnapshot, type NormalizedSnapshot, type NormalizedSlot} from './normalized-snapshot';
import {sixTableSchemas, type SixTableKind} from './six-table-contract';
import {reconcileOffline} from './reconciliation';
const sha = 'a'.repeat(64);
function fixture(kind: SixTableKind = 'company_tbl') {
  const id = {namespace: 'QA', kind, key: '0001'};
  const slots: NormalizedSlot[] = normalizedSlotDefinitions(kind).map(d => {
    let value: unknown = 'Original';
    if (d.type === 'BOOLEAN') value = true;
    if (d.type === 'INTEGER' || d.type === 'VERSION') value = '1';
    if (d.type === 'NUMERIC(18,2)') value = '0';
    if (d.type === 'DATE') value = '2026-09-01';
    if (d.type === 'TIMESTAMP WITHOUT TIME ZONE') value = '2026-09-01T12:30:00';
    if (d.type === 'REFERENCE' || d.type === 'CUSTOMER_IDENTITY') {
      value = {namespace: 'QA', kind: d.type === 'CUSTOMER_IDENTITY' || d.sourceField === 'CompanyID' ? 'company_tbl' : d.sourceField === 'VehicleID' ? 'vehicle_tbl' : d.sourceField === 'DriverID' ? 'Driver_tbl' : d.sourceField === 'InvoiceNo' ? 'Invoice_Tbl' : 'SOA_Tbl', key: 'REF01'};
    }
    if (d.type === 'MEMBERSHIPS') value = {current: [], historical: []};
    if (d.name === 'evidence.' + sixTableSchemas[kind].key) value = '0001';
    return {name: d.name, state: 'VALUE', value, ...(d.name.startsWith('mapping.') || d.name.startsWith('semantic.') ? {reviewRef: 'SYNTHETIC-REVIEW'} : {})};
  });
  const snapshot: NormalizedSnapshot = {version: 'NS-1', contractSha256: normalizedContractSha256,
    binding: {sourcePlanSha256: sha, mappingSha256: dictionary.fieldMapSha256, candidateEvidenceSha256: sha, worklistSha256: sha, identityReviewSha256: sha, registrySha256: sha,
      destinationId: 'SYNTHETIC', authorityVersion: 'PROPOSED', destinationRevision: '1', namespace: 'QA', serviceFrom: '2026-09-01', serviceThrough: '2026-10-31', retainMissingSoaReferences: true},
    expectedIdentities: [id], files: [{id: 'synthetic.csv', table: kind, sha256: sha, headers: [...sixTableSchemas[kind].headers], rows: 1}],
    records: [{identity: id, sourceFileId: 'synthetic.csv', logicalRow: 2, sourceEvidenceSha256: sha, reviewState: 'CANDIDATE', pending: [], slots}]};
  const coverage = () => normalizedCoverageSha256(snapshot.files, snapshot.expectedIdentities);
  const run = () => validateAndProjectNormalizedSnapshot(snapshot, coverage());
  const set = (name: string, slot: {state: NormalizedSlot['state']; value?: unknown; reasonCode?: string; reviewRef?: string}) => {const i = slots.findIndex(s => s.name === name); slots[i] = {name, ...slot} as NormalizedSlot;};
  return {snapshot, slots, coverage, run, set};
}
describe('NS-1 shape/type/coverage and comparator projection', () => {
  it.each(['Driver_tbl', 'vehicle_tbl', 'company_tbl', 'Trips_Tbl', 'SOA_Tbl', 'Invoice_Tbl'] as SixTableKind[])('projects complete %s without execution authority', kind => {
    const f = fixture(kind), before = structuredClone(f.snapshot), result = f.run();
    expect(result).toMatchObject({importEnabled: false, executionAuthorized: false, contractSha256: normalizedContractSha256});
    expect(result.comparisonSnapshot.binding.normalizationCoverageSha256).toBe(f.coverage());
    expect(result.comparisonSnapshot.records[0].identity.key).toBe('0001'); expect(f.snapshot).toEqual(before);
  });
  it('rejects omitted, duplicate and unexpected slots including excluded payroll', () => {
    const f = fixture(); f.slots.pop(); expect(() => f.run()).toThrow('slot coverage');
    const duplicate = fixture(); duplicate.slots[1] = {...duplicate.slots[0]}; expect(() => duplicate.run()).toThrow('slot coverage');
    const payroll = fixture('Driver_tbl'); payroll.slots.push({name: 'evidence.SSSNo', state: 'VALUE', value: 'PRIVATE'}); expect(() => payroll.run()).toThrow('slot coverage');
  });
  it('preserves blank/unknown/not-present versus explicit zero as different comparison facts', () => {
    const f = fixture('Trips_Tbl'), name = 'facts.trip_charges.base_amount', known = f.run().comparisonSnapshot.records;
    f.set(name, {state: 'BLANK'}); const blank = f.run().comparisonSnapshot.records;
    expect(blank[0].money).not.toHaveProperty(name); expect(blank[0].pending).toContain('HISTORY');
    expect(reconcileOffline(known, blank).differences.some(d => d.field === 'fields.' + name + '.state')).toBe(true);
    f.set(name, {state: 'UNKNOWN', reasonCode: 'UNREVIEWED'});
    expect(f.run().comparisonSnapshot.records[0].fields[name + '.state']).toBe('UNKNOWN');
    expect(() => {f.set(name, {state: 'NOT_PRESENT'}); f.run();}).toThrow('absent original column');
  });
  it('requires NOT_PRESENT evidence for an absent header and unknown dependent typed fact', () => {
    const f = fixture(); f.snapshot.files[0].headers = f.snapshot.files[0].headers.filter(h => h !== 'NeedPO');
    expect(() => f.run()).toThrow('header presence');
    f.set('evidence.NeedPO', {state: 'NOT_PRESENT'});
    expect(() => f.run()).toThrow('lacks source column');
    f.set('facts.customers.requires_po', {state: 'UNKNOWN', reasonCode: 'ABSENT_SOURCE_COLUMN'});
    expect(f.run().comparisonSnapshot.records[0].pending).toContain('HISTORY');
  });
  it.each(['1.01', '-1', '01', '1000000000000000000', 1])('rejects inexact/noncanonical/out-of-range centavo value %s', value => {
    const f = fixture('Trips_Tbl'); f.set('facts.trip_charges.base_amount', {state: 'VALUE', value}); expect(() => f.run()).toThrow('integer string');
  });
  it('preserves the Decimal ceiling without floating point', () => {
    const f = fixture('Trips_Tbl'); f.set('facts.trip_charges.base_amount', {state: 'VALUE', value: '999999999999999999'});
    expect(f.run().comparisonSnapshot.records[0].money['facts.trip_charges.base_amount']).toBe(999999999999999999n);
  });
  it('rejects number/boolean coercion, invalid integer and invalid local date/time', () => {
    const f = fixture(); f.set('facts.customers.requires_po', {state: 'VALUE', value: 'false'}); expect(() => f.run()).toThrow('Boolean VALUE');
    const seats = fixture('vehicle_tbl'); seats.set('facts.vehicles.seat_count', {state: 'VALUE', value: '2147483648'}); expect(() => seats.run()).toThrow('integer string');
    const trip = fixture('Trips_Tbl'); trip.set('facts.trips.service_start_local', {state: 'VALUE', value: '2026-02-30T12:00:00'}); expect(() => trip.run()).toThrow('local date/time');
    trip.set('facts.trips.service_start_local', {state: 'VALUE', value: '2026-09-01T12:00:00Z'}); expect(() => trip.run()).toThrow('local date/time');
    trip.set('facts.trips.service_start_local', {state: 'VALUE', value: '2026-09-01T19:00:00'}); expect(() => trip.run()).toThrow('Service end precedes start');
  });
  it('retains explicit pending gates and quarantined-row holds even when all fields are known', () => {
    const f = fixture(); f.snapshot.records[0].pending = ['TAX_BASIS']; f.snapshot.records[0].reviewState = 'QUARANTINED';
    expect(f.run().comparisonSnapshot.records[0].pending).toEqual(['HISTORY', 'TAX_BASIS']);
  });
  it('requires reasons/review references and does not accept a fake review as authentication', () => {
    const f = fixture(); f.set('semantic.reviewedVatClassification', {state: 'UNKNOWN', reasonCode: ''}); expect(() => f.run()).toThrow('text required');
    f.set('semantic.reviewedVatClassification', {state: 'NOT_APPLICABLE', reasonCode: 'RULE', reviewRef: ''}); expect(() => f.run()).toThrow('text required');
    f.set('semantic.reviewedVatClassification', {state: 'VALUE', value: 'NON_VAT', reviewRef: 'UNAUTHENTICATED-NOTE'});
    const result = f.run(); expect(result.executionAuthorized).toBe(false); expect(result.limitations[0]).toContain('not independently authenticated');
  });
  it('rejects unknown snapshot fields and mismatched original source key evidence', () => {
    const f = fixture(); (f.snapshot as unknown as Record<string, unknown>).actorId = 'FORGED'; expect(() => f.run()).toThrow('Unsupported snapshot fields');
    const key = fixture(); key.set('evidence.CompanyID', {state: 'VALUE', value: '1'}); expect(() => key.run()).toThrow('key evidence');
  });
  it('rejects dictionary, expected coverage and normalization-binding drift', () => {
    const f = fixture(), expected = f.coverage(); f.snapshot.files[0].sha256 = 'b'.repeat(64);
    expect(() => validateAndProjectNormalizedSnapshot(f.snapshot, expected)).toThrow('coverage differs');
    f.snapshot.contractSha256 = 'b'.repeat(64); expect(() => f.run()).toThrow('dictionary changed');
    const binding = fixture(); binding.snapshot.binding.normalizationContractSha256 = 'b'.repeat(64); binding.snapshot.binding.normalizationCoverageSha256 = binding.coverage(); expect(() => binding.run()).toThrow('Normalization binding differs');
  });
  it('rejects missing expected rows, duplicate locators and mismatched namespace/type references', () => {
    const f = fixture(); f.snapshot.expectedIdentities.push({namespace: 'QA', kind: 'company_tbl', key: '0002'}); expect(() => f.run()).toThrow('Incomplete identity');
    const duplicate = fixture(); duplicate.snapshot.records.push(structuredClone(duplicate.snapshot.records[0])); expect(() => duplicate.run()).toThrow('coverage differs');
    const trip = fixture('Trips_Tbl'); trip.set('references.CompanyID', {state: 'VALUE', value: {namespace: 'OTHER', kind: 'company_tbl', key: '47'}}); expect(() => trip.run()).toThrow('Reference scope/type');
  });
  it('canonicalizes membership ordering while rejecting duplicate current members and revisions', () => {
    const f = fixture('SOA_Tbl'), name = 'semantic.reviewedTripMemberships';
    const member = (key: string) => ({identity: {namespace: 'QA', kind: 'Trips_Tbl', key}, amountAtBilling: {state: 'VALUE', value: '0'}});
    f.set(name, {state: 'VALUE', reviewRef: 'QA', value: {current: [member('2'), member('1')], historical: []}});
    const first = f.run().comparisonSnapshot.records[0].fields[name];
    f.set(name, {state: 'VALUE', reviewRef: 'QA', value: {current: [member('1'), member('2')], historical: []}});
    expect(f.run().comparisonSnapshot.records[0].fields[name]).toBe(first);
    f.set(name, {state: 'VALUE', reviewRef: 'QA', value: {current: [member('1'), member('1')], historical: []}}); expect(() => f.run()).toThrow('Unique same-namespace');
    f.set(name, {state: 'VALUE', reviewRef: 'QA', value: {current: [], historical: [{revisionRef: 'v1', members: []}, {revisionRef: 'v1', members: []}]}}); expect(() => f.run()).toThrow('Duplicate membership revision');
  });
  it('keeps unknown membership amounts as review holds without inventing zero', () => {
    const f = fixture('SOA_Tbl'); f.set('semantic.reviewedTripMemberships', {state: 'VALUE', reviewRef: 'QA', value: {current: [{identity: {namespace: 'QA', kind: 'Trips_Tbl', key: '1'}, amountAtBilling: {state: 'UNKNOWN', reasonCode: 'UNESTABLISHED'}}], historical: []}});
    const record = f.run().comparisonSnapshot.records[0]; expect(record.pending).toContain('HISTORY'); expect(record.fields['semantic.reviewedTripMemberships']).toContain('UNESTABLISHED');
  });
});
