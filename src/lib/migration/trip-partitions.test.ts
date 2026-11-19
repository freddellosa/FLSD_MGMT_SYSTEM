import {describe, expect, it} from 'vitest';
import {combineTripPartitions, tripPartitionDigest, type TripSourcePartition} from './trip-partitions';
import {scopeLegacyBilling} from './legacy-billing-scope';
import {buildBillingMappingProposals, initialBillingMappingDecisions, validateBillingMappingDecisions, type BillingSourceFingerprint} from './billing-mapping-proposals';

function fixture(): TripSourcePartition[] {
  const row = {CompanyID: 'C1', SOANo: 'S1', InvoiceTotAmt: '1.00', Evat: '0'};
  return [
    {fileName: 'September.csv', declaredMonth: '2026-09', sha256: 'a'.repeat(64), rows: [{...row, tmpInvoiceNo: '001', DateOfTrip_Start: '9/1/2026'}]},
    {fileName: 'October.csv', declaredMonth: '2026-10', sha256: 'b'.repeat(64), rows: [{...row, tmpInvoiceNo: '002', DateOfTrip_Start: '10/1/2026'}]},
  ];
}
describe('explicit trip export partitions', () => {
  it('combines both months with original per-file row locations and stable evidence', () => {
    const parts = fixture(), before = structuredClone(parts), result = combineTripPartitions(parts);
    expect(result).toMatchObject({status: 'VALIDATED', importEnabled: false, locations: [{fileName: 'October.csv', row: 2}, {fileName: 'September.csv', row: 2}]});
    expect(combineTripPartitions([...parts].reverse())).toEqual(result);
    result.rows[0].CompanyID = 'edited'; expect(parts).toEqual(before);
  });
  it('flags all duplicate IDs across files instead of silently deduplicating', () => {
    const parts = fixture(); parts[1].rows = [{...parts[0].rows[0], DateOfTrip_Start: '10/1/2026'}];
    const result = combineTripPartitions(parts);
    expect(result.status).toBe('REVIEW'); expect(result.rows).toHaveLength(2);
    expect(result.issues.map(i => i.code)).toEqual(['DUPLICATE_TRIP_KEY', 'DUPLICATE_TRIP_KEY']);
  });
  it('retains leading zero identities and reports wrong-month or invalid-date evidence', () => {
    const parts = fixture(); parts[1].rows = [{...parts[1].rows[0], tmpInvoiceNo: '1', DateOfTrip_Start: '9/30/2026'}];
    expect(combineTripPartitions(parts).issues.map(i => i.code)).toEqual(['DECLARED_MONTH_DIFFERENCE']);
    parts[1].rows = [{...parts[1].rows[0], DateOfTrip_Start: '2026-02-30'}];
    expect(combineTripPartitions(parts).issues.map(i => i.code)).toEqual(['INVALID_SERVICE_DATE']);
  });
  it('rejects duplicate file declarations, unsafe counts and undeclared source structure', () => {
    const parts = fixture();
    expect(() => combineTripPartitions([parts[0], parts[0]])).toThrow('Unique');
    expect(() => tripPartitionDigest([{fileName: '../outside.csv', sha256: 'a'.repeat(64), rows: 1, declaredMonth: '2026-09'}])).toThrow('Invalid');
    expect(() => combineTripPartitions([{...parts[0], rows: [{tmpInvoiceNo: '1'}]}])).toThrow('headers');
  });
  it('keeps correct customer identities and file locations when rows restart at two in October', () => {
    const combined = combineTripPartitions(fixture());
    const input = {trips: combined.rows, tripLocations: combined.locations, from: '2026-09-01', through: '2026-10-31',
      customers: [{CompanyID: 'C1', CompanyName: 'Current master'}], soas: [{SOANo: 'S1', InvoiceNo: 'I1', ChargeTo: 'Old label', Status: 'Approved'}],
      invoices: [{InvoiceNo: 'I1', SOANo: 'S1', ChargeTo: 'Old label', Status: 'Approved', DateOfTrip_Start: '9/1/2026', InvoiceTotAmt: '2.00'}]};
    const review = scopeLegacyBilling(input);
    expect(review.coverage.monthsWithoutSuppliedTrips).toEqual([]);
    expect(review.groups[0].tripRows.map(t => [t.fileName, t.row])).toEqual([['October.csv', 2], ['September.csv', 2]]);
    const fingerprints: BillingSourceFingerprint[] = [{kind: 'trips', sha256: combined.aggregateSha256, rows: 2, partitions: combined.partitions},
      ...(['customers', 'soas', 'invoices'] as const).map(kind => ({kind, sha256: 'c'.repeat(64), rows: input[kind].length}))];
    const packet = buildBillingMappingProposals(input, fingerprints);
    expect(packet.proposals[0].originalEvidence.trips.every(t => t.sourceCustomerId === 'C1')).toBe(true);
    expect(packet.proposals[0].originalEvidence.trips.map(t => t.fileName)).toEqual(['October.csv', 'September.csv']);
    fingerprints[0].sha256 = 'd'.repeat(64);
    expect(() => buildBillingMappingProposals(input, fingerprints)).toThrow('partition');
  });
  it('invalidates earlier decisions when October is added without altering those decisions', () => {
    const parts = fixture();
    const common = {from: '2026-09-01', through: '2026-10-31', customers: [{CompanyID: 'C1', CompanyName: 'Master'}],
      soas: [{SOANo: 'S1', InvoiceNo: 'I1', ChargeTo: 'Old label', Status: 'Approved'}],
      invoices: [{InvoiceNo: 'I1', SOANo: 'S1', ChargeTo: 'Old label', Status: 'Approved', DateOfTrip_Start: '9/1/2026', InvoiceTotAmt: '1.00'}]};
    const makePacket = (selected: TripSourcePartition[]) => {
      const combined = combineTripPartitions(selected);
      return buildBillingMappingProposals({...common, trips: combined.rows, tripLocations: combined.locations}, [
        {kind: 'trips', sha256: combined.aggregateSha256, rows: combined.rows.length, partitions: combined.partitions},
        ...(['customers', 'soas', 'invoices'] as const).map(kind => ({kind, sha256: 'c'.repeat(64), rows: common[kind].length})),
      ]);
    };
    const old = initialBillingMappingDecisions(makePacket([parts[0]])), before = structuredClone(old);
    expect(() => validateBillingMappingDecisions(makePacket(parts), old)).toThrow('stale');
    expect(old).toEqual(before);
  });
  it('rejects repeated per-file locations rather than treating them as new source records', () => {
    const combined = combineTripPartitions(fixture());
    expect(() => scopeLegacyBilling({trips: combined.rows, tripLocations: [combined.locations[0], combined.locations[0]],
      customers: [], soas: [], invoices: [], from: '2026-09-01', through: '2026-10-31'})).toThrow('locations');
  });
});
