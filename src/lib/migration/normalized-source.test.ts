import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {prepareNormalizedSource} from './normalized-source';
import {validateAndProjectNormalizedSnapshot, validateNormalizedSourceSnapshot, type NormalizedSnapshot} from './normalized-snapshot';
import {sixTableSchemas, type SixTableKind} from './six-table-contract';
import type {SixTablePlanFile} from './six-table-import-plan';
const mapping = readFileSync('docs/LEGACY_SIX_TABLE_FIELD_MAP.csv', 'utf8');
const scope = {namespace: 'QA', from: '2026-09-01', through: '2026-10-31', retainMissingSoaReferences: true};
function fixture() {
  const rows: Record<SixTableKind, Record<string, string>> = {
    Driver_tbl: {DriverID: 'D01', DriverName: 'Private Driver', isActv: 'Y', SSSNo: 'PRIVATE PAYROLL', SSS_Rate: '777.77'},
    vehicle_tbl: {VehicleID: 'V01', MakeModel: 'QA Model', PlateNo: 'QA 123', NoOfSeats: '12', Active: 'N'},
    company_tbl: {CompanyID: 'C01', CompanyName: '  Exact Name  ', TIN: '001-234', NeedRequestor: 'N', NeedPO: 'Y'},
    Trips_Tbl: {tmpInvoiceNo: '0001', CompanyID: 'C01', VehicleID: 'V01', DriverID: 'D01', DateOfTrip_Start: '9/1/2026 14:00:00', DateOfTrip_End: '9/1/2026 15:00:00',
      BaseAmount: '0', OTFee: '0', Gas: '0', TollFee: '0', ParkingFee: '0', FoodExp: '0', Lodging: '0', Evat: '0', InvoiceTotAmt: '0', SOANo: 'S01', Amount: '9999'},
    SOA_Tbl: {SOANo: 'S01', ChargeTo: 'Original snapshot', InvoiceNo: 'I01', Status: 'Received'},
    Invoice_Tbl: {InvoiceNo: 'I01', SOANo: 'S01', ChargeTo: 'Original snapshot', InvoiceTotAmt: '0', Evat: '0', Status: 'Paid', ORNo: 'LEGACY-OR'},
  };
  const headers: Record<string, string[]> = {};
  const files = (): SixTablePlanFile[] => (Object.keys(rows) as SixTableKind[]).map(table => {
    const columns = headers[table] ?? [...sixTableSchemas[table].headers], quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
    return {id: table + '.csv', table, bytes: new TextEncoder().encode(columns.map(quote).join(',') + '\n' + columns.map(h => quote(rows[table][h] ?? '')).join(','))};
  });
  return {rows, headers, files, run: () => prepareNormalizedSource(files(), scope, mapping)};
}
function validate(result: ReturnType<typeof prepareNormalizedSource>) {
  const source = result.sourceSnapshot; if (!source) throw new Error('Source structure blocked');
  const snapshot: NormalizedSnapshot = {version: 'NS-1', contractSha256: result.contractSha256, files: source.files, expectedIdentities: source.expectedIdentities, records: source.records,
    binding: {sourcePlanSha256: result.sourcePlanSha256, mappingSha256: result.mappingSha256, candidateEvidenceSha256: result.candidateEvidenceSha256, worklistSha256: result.worklistSha256,
      identityReviewSha256: 'a'.repeat(64), registrySha256: 'b'.repeat(64), destinationId: 'SYNTHETIC-NOT-CONNECTED', authorityVersion: 'TEST', destinationRevision: '0', namespace: scope.namespace,
      serviceFrom: scope.from, serviceThrough: scope.through, retainMissingSoaReferences: true}};
  return validateAndProjectNormalizedSnapshot(snapshot, source.coverageSha256);
}
const record = (result: ReturnType<typeof prepareNormalizedSource>, kind: SixTableKind) => result.sourceSnapshot!.records.find(r => r.identity.kind === kind)!;
describe('source-side NS-1 byte-backed adapter', () => {
  it('prepares all six schemas with original keys/row locations while destination remains explicitly unbound', () => {
    const f = fixture(), inputs = f.files(), before = structuredClone(inputs), result = prepareNormalizedSource(inputs, scope, mapping);
    expect(result).toMatchObject({status: 'SOURCE_PREPARED_DESTINATION_UNBOUND', importEnabled: false, executionAuthorized: false, policyHeldRows: 3});
    expect(record(result, 'Trips_Tbl')).toMatchObject({identity: {key: '0001'}, logicalRow: 2, sourceFileId: 'Trips_Tbl.csv'});
    expect(validate(result).comparisonSnapshot.records).toHaveLength(6); expect(inputs).toEqual(before);
  });
  it('preserves exact evidence without payroll values or invented application mappings/semantic facts', () => {
    const result = fixture().run(), text = JSON.stringify(result);
    expect(text).not.toContain('PRIVATE PAYROLL'); expect(text).not.toContain('777.77');
    const customer = record(result, 'company_tbl');
    expect(customer.slots).toContainEqual({name: 'evidence.CompanyName', state: 'VALUE', value: '  Exact Name  '});
    expect(customer.slots).toContainEqual({name: 'mapping.applicationEntityId', state: 'UNKNOWN', reasonCode: 'DESTINATION_MAPPING_NOT_BOUND'});
    expect(customer.slots).toContainEqual({name: 'semantic.reviewedVatClassification', state: 'UNKNOWN', reasonCode: 'SEMANTIC_FACT_REQUIRES_INDEPENDENT_REVIEW'});
    expect(validate(result).comparisonSnapshot.records.every(r => r.pending.includes('HISTORY'))).toBe(true);
  });
  it('maps by header name after column reordering and preserves exact zero versus blank money', () => {
    const f = fixture(); f.headers.Trips_Tbl = [...sixTableSchemas.Trips_Tbl.headers].reverse(); f.rows.Trips_Tbl.OTFee = '';
    const result = f.run(), trip = record(result, 'Trips_Tbl');
    expect(trip.slots).toContainEqual({name: 'references.CompanyID', state: 'VALUE', value: {namespace: 'QA', kind: 'company_tbl', key: 'C01'}});
    expect(trip.slots).toContainEqual({name: 'facts.trip_charges.base_amount', state: 'VALUE', value: '0'});
    expect(trip.slots).toContainEqual({name: 'facts.trip_charges.ot_amount', state: 'BLANK'});
    expect(validate(result).comparisonSnapshot.records.find(r => r.identity.kind === 'Trips_Tbl')!.money).not.toHaveProperty('facts.trip_charges.ot_amount');
  });
  it('converts exact decimal components once without adding Amount aliases or VAT twice', () => {
    const f = fixture(); f.rows.Trips_Tbl.BaseAmount = '9999999999999999.99'; f.rows.Trips_Tbl.InvoiceTotAmt = '9999999999999999.99';
    const result = f.run();
    expect(record(result, 'Trips_Tbl').slots).toContainEqual({name: 'facts.trip_charges.agreed_gross', state: 'VALUE', value: '999999999999999999'});
    expect(record(result, 'Trips_Tbl').slots).toContainEqual({name: 'evidence.Amount', state: 'VALUE', value: '9999'});
    expect(validate(result).comparisonSnapshot.records.find(r => r.identity.kind === 'Trips_Tbl')!.money['facts.trip_charges.agreed_gross']).toBe(999999999999999999n);
  });
  it('retains Paid/OR as source evidence without lifecycle/receivable/receipt inference', () => {
    const result = fixture().run(), invoice = record(result, 'Invoice_Tbl');
    expect(invoice.slots).toContainEqual({name: 'facts.invoices.source_status', state: 'VALUE', value: 'Paid'});
    expect(invoice.slots).toContainEqual({name: 'evidence.ORNo', state: 'VALUE', value: 'LEGACY-OR'});
    expect(invoice.slots).toContainEqual({name: 'semantic.operationalLifecycleState', state: 'UNKNOWN', reasonCode: 'SEMANTIC_FACT_REQUIRES_INDEPENDENT_REVIEW'});
    expect(result).not.toHaveProperty('receipts');
  });
  it('retains reversed date evidence while typed end stays unknown and schedule hold survives projection', () => {
    const f = fixture(); f.rows.Trips_Tbl.DateOfTrip_End = '9/1/2026 13:00:00'; const result = f.run();
    expect(result.sourceCases).toBe(1);
    expect(record(result, 'Trips_Tbl').slots).toContainEqual({name: 'facts.trips.service_end_local', state: 'UNKNOWN', reasonCode: 'SERVICE_END_BEFORE_START'});
    expect(record(result, 'Trips_Tbl').slots).toContainEqual({name: 'evidence.DateOfTrip_End', state: 'VALUE', value: '9/1/2026 13:00:00'});
    expect(validate(result).comparisonSnapshot.records.find(r => r.identity.kind === 'Trips_Tbl')!.pending).toContain('SCHEDULE');
  });
  it('retains absent optional headers with NOT_PRESENT evidence and unknown dependent fact', () => {
    const f = fixture(); f.headers.company_tbl = [...sixTableSchemas.company_tbl.headers].filter(h => h !== 'NeedPO'); const result = f.run();
    expect(record(result, 'company_tbl').slots).toContainEqual({name: 'evidence.NeedPO', state: 'NOT_PRESENT'});
    expect(record(result, 'company_tbl').slots).toContainEqual({name: 'facts.customers.requires_po', state: 'UNKNOWN', reasonCode: 'SOURCE_COLUMN_NOT_PRESENT'});
    expect(validate(result).comparisonSnapshot.records).toHaveLength(6);
  });
  it('does not infer optional parents from blank/zero references or discard missing partial-export SOA keys', () => {
    const f = fixture(); f.rows.Trips_Tbl.SOANo = 'MISSING'; f.rows.SOA_Tbl.InvoiceNo = '0'; const result = f.run();
    expect(record(result, 'Trips_Tbl').slots).toContainEqual({name: 'references.SOANo', state: 'VALUE', value: {namespace: 'QA', kind: 'SOA_Tbl', key: 'MISSING'}});
    expect(record(result, 'SOA_Tbl').slots).toContainEqual({name: 'references.InvoiceNo', state: 'NOT_APPLICABLE', reasonCode: 'UNASSIGNED_SOURCE_REFERENCE', reviewRef: 'SOURCE_OPTIONAL_REFERENCE_SENTINEL_V1'});
    expect(result.sourceSnapshot!.records).toHaveLength(6); expect(validate(result).comparisonSnapshot.records).toHaveLength(6);
  });
  it('retains malformed typed values as unknown rather than rounding or defaulting to zero', () => {
    const f = fixture(); f.rows.Trips_Tbl.InvoiceTotAmt = '0.001'; f.rows.Driver_tbl.isActv = 'unknown'; const result = f.run();
    expect(record(result, 'Trips_Tbl').slots).toContainEqual({name: 'facts.trip_charges.agreed_gross', state: 'UNKNOWN', reasonCode: 'INVALID_TYPED_SOURCE_VALUE'});
    expect(record(result, 'Driver_tbl').slots).toContainEqual({name: 'facts.drivers.active', state: 'UNKNOWN', reasonCode: 'INVALID_TYPED_SOURCE_VALUE'});
    expect(validate(result).comparisonSnapshot.records).toHaveLength(6);
  });
  it('blocks ambiguous key versions or unknown headers without losing issue locators', () => {
    const f = fixture(), files = f.files(), duplicate = prepareNormalizedSource([...files, {...files[0], id: 'driver-copy.csv'}], scope, mapping);
    expect(duplicate.status).toBe('BLOCKED_SOURCE_STRUCTURE'); expect(duplicate.sourceSnapshot).toBeNull(); expect(duplicate.blockedRows).toHaveLength(2);
    f.headers.company_tbl = [...sixTableSchemas.company_tbl.headers, 'UnreviewedField']; f.rows.company_tbl.UnreviewedField = 'PRIVATE EXTRA';
    const unknown = f.run(); expect(unknown.blockedFiles).toEqual(['company_tbl.csv']); expect(JSON.stringify(unknown)).not.toContain('PRIVATE EXTRA');
  });
  it('binds changed file/row/mapping evidence and is deterministic across file order', () => {
    const f = fixture(), first = f.run();
    expect(prepareNormalizedSource(f.files().reverse(), scope, mapping).evidenceSha256).toBe(first.evidenceSha256);
    f.rows.company_tbl.CompanyName = 'Changed'; expect(f.run().evidenceSha256).not.toBe(first.evidenceSha256);
    expect(() => prepareNormalizedSource(f.files(), scope, mapping + '\n')).toThrow('field map changed');
  });
  it('validates source shape and retained hashes without any destination or registry metadata', () => {
    const prepared = fixture().run(), source = prepared.sourceSnapshot!, before = structuredClone(source);
    const result = validateNormalizedSourceSnapshot(source, prepared.mappingSha256, source.coverageSha256);
    expect(result).toMatchObject({status: 'SOURCE_SHAPE_CHECKED_DESTINATION_UNBOUND', importEnabled: false, executionAuthorized: false, counts: {rows: 6, destinationUnboundRows: 6}});
    expect(result.gateCounts.HISTORY).toBe(6); expect(result).not.toHaveProperty('binding'); expect(source).toEqual(before);
  });
  it('detects changed raw normalized evidence even when the slot shape is valid', () => {
    const prepared = fixture().run(), source = prepared.sourceSnapshot!;
    const slot = source.records.find(r => r.identity.kind === 'company_tbl')!.slots.find(s => s.name === 'evidence.CompanyName')!;
    if (slot.state !== 'VALUE') throw new Error('fixture'); slot.value = 'Changed after source parsing';
    expect(() => validateNormalizedSourceSnapshot(source, prepared.mappingSha256, source.coverageSha256)).toThrow('original evidence changed');
  });
  it('does not allow an unbound source to claim a reviewed application mapping or semantic fact', () => {
    for (const name of ['mapping.applicationEntityId', 'semantic.reviewedVatClassification']) {
      const prepared = fixture().run(), source = prepared.sourceSnapshot!, row = source.records.find(r => r.identity.kind === 'company_tbl')!;
      const i = row.slots.findIndex(s => s.name === name); row.slots[i] = {name, state: 'VALUE', value: 'CLAIMED', reviewRef: 'UNAUTHENTICATED-NOTE'};
      expect(() => validateNormalizedSourceSnapshot(source, prepared.mappingSha256, source.coverageSha256)).toThrow('cannot claim reviewed');
    }
  });
  it('preserves source cases and schedule/quarantine gates in the source-only summary', () => {
    const f = fixture(); f.rows.Trips_Tbl.DateOfTrip_End = '9/1/2026 13:00:00'; const prepared = f.run(), source = prepared.sourceSnapshot!;
    const result = validateNormalizedSourceSnapshot(source, prepared.mappingSha256, source.coverageSha256);
    expect(prepared.sourceCases).toBe(1); expect(prepared.policyHeldRows).toBe(3);
    expect(result.gateCounts).toMatchObject({HISTORY: 6, SCHEDULE: 1, TAX_BASIS: 2, WORKFLOW: 1});
    expect(result.counts.quarantinedRows).toBe(3);
  });
  it('rejects stale source coverage, mismatched mapping and invalid service scope', () => {
    const prepared = fixture().run(), source = prepared.sourceSnapshot!;
    expect(() => validateNormalizedSourceSnapshot(source, prepared.mappingSha256, 'a'.repeat(64))).toThrow('expected coverage');
    expect(() => validateNormalizedSourceSnapshot(source, 'a'.repeat(64), source.coverageSha256)).toThrow('mapping revision');
    source.serviceScope.from = '2026-02-30';
    expect(() => validateNormalizedSourceSnapshot(source, prepared.mappingSha256, source.coverageSha256)).toThrow('source scope');
  });
  it('rejects source-only envelopes with a forged destination and requires the shared slot coverage checks', () => {
    const prepared = fixture().run(), source = prepared.sourceSnapshot!;
    (source as unknown as Record<string, unknown>).destinationId = 'FORGED';
    expect(() => validateNormalizedSourceSnapshot(source, prepared.mappingSha256, source.coverageSha256)).toThrow('Unsupported snapshot fields');
    delete (source as unknown as Record<string, unknown>).destinationId; source.records[0].slots.pop();
    expect(() => validateNormalizedSourceSnapshot(source, prepared.mappingSha256, source.coverageSha256)).toThrow('slot coverage');
  });
});
