import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {prepareSixTableTargetCandidates} from './six-table-target-candidates';
import {sixTableSchemas, type SixTableKind} from './six-table-contract';
import type {SixTablePlanFile} from './six-table-import-plan';
const mapping = readFileSync('docs/LEGACY_SIX_TABLE_FIELD_MAP.csv', 'utf8');
const scope = {namespace: 'QA', from: '2026-09-01', through: '2026-10-31', retainMissingSoaReferences: true};
function fixture() {
  const rows: Record<SixTableKind, Record<string, string>> = {
    Driver_tbl: {DriverID: '001', DriverName: 'Private Driver', isActv: '-1', SSSNo: 'HIDDEN PAYROLL', SSS_Rate: '999.99'},
    vehicle_tbl: {VehicleID: 'V01', MakeModel: 'QA Model', PlateNo: 'QA 123', NoOfSeats: '12', Active: '0'},
    company_tbl: {CompanyID: 'C01', CompanyName: '  Exact Name  ', TIN: '001-234', NeedRequestor: 'True', NeedPO: 'False'},
    Trips_Tbl: {tmpInvoiceNo: '0001', CompanyID: 'C01', DriverID: '001', VehicleID: 'V01', DateOfTrip_Start: '9/1/2026 1:30:00 PM', DateOfTrip_End: '9/1/2026 2:00:00 PM', SOANo: 'S01', BaseAmount: '100.00', OTFee: '0', Evat: '12', Gas: '0', TollFee: '0', ParkingFee: '0', FoodExp: '0', Lodging: '0', InvoiceTotAmt: '112.00', Amount: '9999', CheckAmt: '123'},
    SOA_Tbl: {SOANo: 'S01', ChargeTo: 'Original snapshot', InvoiceNo: 'I01', Status: 'Received'},
    Invoice_Tbl: {InvoiceNo: 'I01', SOANo: 'S01', ChargeTo: 'Original snapshot', InvoiceTotAmt: '112.00', Evat: '12', Status: 'Paid', ORNo: 'LEGACY-OR'},
  };
  const files = (): SixTablePlanFile[] => (Object.keys(rows) as SixTableKind[]).map(table => {
    const headers = sixTableSchemas[table].headers;
    const quote = (text: string) => '"' + text.replaceAll('"', '""') + '"';
    return {id: table + '.csv', table, bytes: new TextEncoder().encode(headers.map(quote).join(',') + '\n' + headers.map(h => quote(rows[table][h] ?? '')).join(','))};
  });
  return {rows, files, run: () => prepareSixTableTargetCandidates(files(), scope, mapping)};
}
const target = (report: ReturnType<typeof prepareSixTableTargetCandidates>, table: SixTableKind) => report.candidates.find(c => c.source.table === table)!;
describe('non-writing proposed target candidates', () => {
  it('binds field map, source plan and locators without generating application IDs or write authority', () => {
    const f = fixture(), report = f.run();
    expect(report).toMatchObject({importEnabled: false, executionAuthorized: false, counts: {rows: 6, candidates: 3, quarantined: 3}});
    expect(target(report, 'Driver_tbl').source).toMatchObject({namespace: 'QA', sourceKey: '001', row: 2});
    expect(target(report, 'Driver_tbl')).not.toHaveProperty('id');
    expect(report.evidenceSha256).toBe(prepareSixTableTargetCandidates(f.files().reverse(), scope, mapping).evidenceSha256);
  });
  it('preserves names and leading-zero TIN while retaining inactive referenced masters', () => {
    const report = fixture().run();
    expect(target(report, 'company_tbl').fields).toContainEqual(expect.objectContaining({targetField: 'registered_name', value: '  Exact Name  '}));
    expect(target(report, 'company_tbl').fields).toContainEqual(expect.objectContaining({targetField: 'tin', value: '001-234'}));
    expect(target(report, 'vehicle_tbl')).toMatchObject({state: 'CANDIDATE'});
    expect(target(report, 'vehicle_tbl').fields).toContainEqual(expect.objectContaining({targetField: 'active', value: false}));
    expect(target(report, 'company_tbl').fields.some(f => f.targetField === 'active')).toBe(false);
  });
  it('never retains excluded payroll even in quarantine', () => {
    const f = fixture(); f.rows.Driver_tbl.isActv = 'unknown';
    const report = f.run(), text = JSON.stringify(report);
    expect(text).not.toContain('HIDDEN PAYROLL'); expect(text).not.toContain('999.99');
    expect(target(report, 'Driver_tbl').state).toBe('QUARANTINED');
  });
  it('keeps original Paid and OR evidence separate from lifecycle, receipts, balances and audit actors', () => {
    const invoice = target(fixture().run(), 'Invoice_Tbl');
    expect(invoice.fields).toContainEqual(expect.objectContaining({targetField: 'source_status', value: 'Paid'}));
    expect(invoice.sourceEvidence.ORNo).toBe('LEGACY-OR');
    for (const field of ['lifecycle_state', 'balance', 'actor_id', 'paid_amount', 'current_serial_number']) expect(invoice.fields.some(f => f.targetField === field)).toBe(false);
    expect(invoice.state).toBe('QUARANTINED');
  });
  it('converts exact component amounts independently without adding VAT or overlapping aliases', () => {
    const trip = target(fixture().run(), 'Trips_Tbl');
    expect(trip.fields).toContainEqual(expect.objectContaining({targetField: 'agreed_gross', value: '112.00'}));
    expect(trip.fields).toContainEqual(expect.objectContaining({targetField: 'recorded_vat', value: '12.00'}));
    expect(trip.fields).toContainEqual(expect.objectContaining({targetField: 'ot_amount', value: '0.00'}));
    expect(trip.fields.some(f => f.sourceField === 'Amount')).toBe(false);
    expect(trip.sourceEvidence.Amount).toBe('9999');
  });
  it.each(['0.001', '-1', '10000000000000000.00', '1e2'])('quarantines invalid amount %s without rounding or zero fallback', amount => {
    const f = fixture(); f.rows.Trips_Tbl.InvoiceTotAmt = amount;
    const trip = target(f.run(), 'Trips_Tbl');
    expect(trip.fields.find(f => f.targetField === 'agreed_gross')?.value).toBeNull();
    expect(trip.issues).toContainEqual({field: 'InvoiceTotAmt', code: 'INVALID_TYPED_VALUE'});
    expect(trip.sourceEvidence.InvoiceTotAmt).toBe(amount);
  });
  it('distinguishes unknown amount from explicit zero and accepts zero daily source evidence without marking Paid', () => {
    const f = fixture(); f.rows.Trips_Tbl.InvoiceTotAmt = ''; f.rows.Trips_Tbl.BaseAmount = '0';
    const trip = target(f.run(), 'Trips_Tbl');
    expect(trip.fields.find(f => f.targetField === 'agreed_gross')?.value).toBeNull();
    expect(trip.fields.find(f => f.targetField === 'base_amount')?.value).toBe('0.00');
    expect(trip.issues).toContainEqual({field: 'InvoiceTotAmt', code: 'MISSING_OR_UNRESOLVED_TYPED_VALUE'});
    expect(trip.fields.some(f => f.targetField === 'source_status')).toBe(false);
  });
  it('preserves local timestamp components and quarantines reversed service times', () => {
    const f = fixture(); f.rows.Trips_Tbl.DateOfTrip_End = '9/1/2026 12:00:00 PM';
    const trip = target(f.run(), 'Trips_Tbl');
    expect(trip.fields.find(f => f.targetField === 'service_start_local')?.value).toBe('2026-09-01T13:30:00');
    expect(trip.issues).toContainEqual({field: 'DateOfTrip_End', code: 'SERVICE_END_BEFORE_START'});
  });
  it('propagates quarantined master dependency even when the source key exists', () => {
    const f = fixture(); f.rows.vehicle_tbl.NoOfSeats = '2.5';
    const report = f.run();
    expect(target(report, 'vehicle_tbl').state).toBe('QUARANTINED');
    expect(target(report, 'Trips_Tbl').issues).toContainEqual({field: 'VehicleID', code: 'MASTER_CANDIDATE_QUARANTINED'});
    expect(target(report, 'Trips_Tbl').sourceReferences).toContainEqual({field: 'VehicleID', table: 'vehicle_tbl', sourceKey: 'V01'});
  });
  it('recognizes the supplied Y/N active encoding while unknown flags remain unresolved', () => {
    const f = fixture(); f.rows.Driver_tbl.isActv = 'Y';
    expect(target(f.run(), 'Driver_tbl').fields).toContainEqual(expect.objectContaining({targetField: 'active', value: true}));
    f.rows.Driver_tbl.isActv = 'N';
    expect(target(f.run(), 'Driver_tbl').fields).toContainEqual(expect.objectContaining({targetField: 'active', value: false}));
    f.rows.Driver_tbl.isActv = '';
    expect(target(f.run(), 'Driver_tbl').issues).toContainEqual({field: 'isActv', code: 'MISSING_OR_UNRESOLVED_TYPED_VALUE'});
  });
  it('preserves the exact decimal ceiling and trailing-zero precision without floating point', () => {
    const f = fixture(); f.rows.Trips_Tbl.InvoiceTotAmt = '9,999,999,999,999,999.9900';
    expect(target(f.run(), 'Trips_Tbl').fields).toContainEqual(expect.objectContaining({targetField: 'agreed_gross', value: '9999999999999999.99'}));
  });
  it('does not discard time from a proposed date-only field', () => {
    const f = fixture(); f.rows.Driver_tbl.HireDate = '9/1/2026 1:00:00 PM';
    expect(target(f.run(), 'Driver_tbl').issues).toContainEqual({field: 'HireDate', code: 'INVALID_TYPED_VALUE'});
  });
  it('does not turn retained missing SOA references into parents or new review approvals', () => {
    const f = fixture(); f.rows.Trips_Tbl.SOANo = 'MISSING';
    const report = f.run();
    expect(target(report, 'Trips_Tbl').sourceEvidence.SOANo).toBe('MISSING');
    expect(target(report, 'Trips_Tbl').issues.some(i => i.code === 'RELATIONSHIP_ORPHAN')).toBe(false);
    expect(report.candidates).toHaveLength(6);
  });
  it('retains duplicate source versions in quarantine', () => {
    const f = fixture(), files = f.files();
    const report = prepareSixTableTargetCandidates([...files, {...files[0], id: 'duplicate.csv'}], scope, mapping);
    expect(report.candidates.filter(c => c.source.table === 'Driver_tbl')).toHaveLength(2);
    expect(report.candidates.filter(c => c.source.table === 'Driver_tbl').every(c => c.issues.some(i => i.code === 'DUPLICATE_IDENTITY'))).toBe(true);
  });
  it('rejects incomplete mapping and attempts to include excluded payroll or reclassify identity', () => {
    const f = fixture();
    expect(() => prepareSixTableTargetCandidates(f.files(), scope, mapping.split('\n').slice(0, 10).join('\n'))).toThrow('Complete');
    expect(() => prepareSixTableTargetCandidates(f.files(), scope, mapping.replaceAll('"EXCLUDED"', '"RETAIN_ORIGINAL_EVIDENCE"'))).toThrow('unsafe');
    expect(() => prepareSixTableTargetCandidates(f.files(), scope, mapping.replace('"IDENTITY_MAP"', '"TYPED_AFTER_VALIDATION"'))).toThrow('unsafe');
  });
});
