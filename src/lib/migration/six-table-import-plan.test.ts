import {describe, expect, it} from 'vitest';
import {buildSixTableImportPlan, type SixTablePlanFile, type SixTablePlanScope} from './six-table-import-plan';
import {sixTableSchemas, type SixTableKind} from './six-table-contract';
const scope: SixTablePlanScope = {namespace: 'QA-ACCESS', from: '2026-09-01', through: '2026-10-31', retainMissingSoaReferences: true};
function file(table: SixTableKind, id: string, rows: Record<string, string>[]): SixTablePlanFile {
  const headers = sixTableSchemas[table].headers;
  const quote = (v: string) => '"' + v.replaceAll('"', '""') + '"';
  return {table, id, bytes: new TextEncoder().encode([headers.map(quote).join(','), ...rows.map(r => headers.map(h => quote(r[h] ?? '')).join(','))].join('\n'))};
}
function fixture() {
  const rows = {
    Driver_tbl: [{DriverID: 'D01', DriverName: 'PRIVATE DRIVER LABEL', SSSNo: 'HIDDEN-SSS', SSS_Rate: '987.65'}],
    vehicle_tbl: [{VehicleID: 'V01', MakeModel: 'QA model', PlateNo: 'QA 0001'}],
    company_tbl: [{CompanyID: 'C01', CompanyName: 'PRIVATE CUSTOMER LABEL'}],
    Trips_Tbl: [{tmpInvoiceNo: '0001', CompanyID: 'C01', VehicleID: 'V01', DriverID: 'D01', DateOfTrip_Start: '9/1/2026', InvoiceTotAmt: '112.00', SOANo: 'S01'}],
    SOA_Tbl: [{SOANo: 'S01', InvoiceNo: 'I01', ChargeTo: 'QA original label', Status: 'Received'}],
    Invoice_Tbl: [{InvoiceNo: 'I01', SOANo: 'S01', ChargeTo: 'QA original label', Status: 'Paid', InvoiceTotAmt: '112.00'}],
  };
  const files = () => (Object.keys(rows) as SixTableKind[]).map(table => file(table, table + '.csv', rows[table]));
  return {rows, files};
}
describe('combined six-table source import plan', () => {
  it('reuses exact-key links, preserves original locators and is deterministic across file ordering without writes', () => {
    const f = fixture(), inputs = f.files(), before = structuredClone(inputs), plan = buildSixTableImportPlan(inputs, scope);
    expect(plan).toMatchObject({structuralStatus: 'CHECKED', importEnabled: false, executionAuthorized: false, counts: {sourceRows: 6, includedTrips: 1, duplicateIdentities: 0, reviewIssues: 0}});
    expect(plan.records.find(r => r.table === 'Trips_Tbl')).toMatchObject({sourceKey: '0001', row: 2, fileId: 'Trips_Tbl.csv'});
    expect(buildSixTableImportPlan([...inputs].reverse(), scope).evidenceSha256).toBe(plan.evidenceSha256);
    expect(inputs).toEqual(before); expect(plan.relationshipCounts.every(c => c.matched === 1)).toBe(true);
  });
  it('does not expose payroll, display labels, receipts, balances or invented application IDs', () => {
    const plan = buildSixTableImportPlan(fixture().files(), scope), text = JSON.stringify(plan);
    for (const value of ['HIDDEN-SSS', '987.65', 'PRIVATE DRIVER LABEL', 'PRIVATE CUSTOMER LABEL']) expect(text).not.toContain(value);
    expect(plan).not.toHaveProperty('payments'); expect(plan).not.toHaveProperty('applicationIds');
    expect(plan.files.find(f => f.table === 'Driver_tbl')?.excludedHeaders).toEqual(['SSSNo', 'SSS_Rate']);
  });
  it('flags duplicate identities across files and retains every source row instead of deduplicating', () => {
    const f = fixture(), plan = buildSixTableImportPlan([...f.files(), file('Trips_Tbl', 'extra-trips.csv', f.rows.Trips_Tbl)], scope);
    expect(plan.counts).toMatchObject({sourceRows: 7, duplicateIdentities: 1});
    expect(plan.duplicates[0]).toMatchObject({table: 'Trips_Tbl', sourceKey: '0001', count: 2});
    expect(plan.duplicates[0].locations).toHaveLength(2); expect(plan.structuralStatus).toBe('REVIEW');
  });
  it('marks references to duplicate masters ambiguous and retains both target locations', () => {
    const f = fixture(), plan = buildSixTableImportPlan([...f.files(), file('Driver_tbl', 'extra-drivers.csv', f.rows.Driver_tbl)], scope);
    expect(plan.issues.find(i => i.ruleId === 'trip-driver')).toMatchObject({code: 'AMBIGUOUS', disposition: 'REVIEW'});
    expect(plan.issues.find(i => i.ruleId === 'trip-driver')?.targetLocations).toHaveLength(2);
  });
  it('keeps missing required master references as review issues without name/number repair', () => {
    const f = fixture(); f.rows.Trips_Tbl[0].CompanyID = 'C99';
    const plan = buildSixTableImportPlan(f.files(), scope);
    expect(plan.issues.find(i => i.ruleId === 'trip-customer')).toMatchObject({code: 'ORPHAN', disposition: 'REVIEW', sourceKey: '0001', target: {sourceKey: 'C99'}, sourceLocations: [{fileId: 'Trips_Tbl.csv', row: 2}]});
  });
  it('retains partial-export SOA references without fabricating parents or requiring individual approval', () => {
    const f = fixture(); f.rows.Trips_Tbl[0].SOANo = 'MISSING';
    const plan = buildSixTableImportPlan(f.files(), scope);
    expect(plan.retainedMissingSoaKeys).toEqual(['MISSING']); expect(plan.counts.reviewIssues).toBe(0);
    expect(plan.issues.find(i => i.ruleId === 'trip-soa')).toMatchObject({code: 'ORPHAN', disposition: 'RETAIN_REFERENCE'});
    expect(plan.records.some(r => r.sourceKey === 'MISSING')).toBe(false);
    expect(buildSixTableImportPlan(f.files(), {...scope, retainMissingSoaReferences: false}).counts.reviewIssues).toBe(1);
  });
  it('cannot use partial-export policy to bypass an ambiguous existing SOA', () => {
    const f = fixture(), plan = buildSixTableImportPlan([...f.files(), file('SOA_Tbl', 'extra-soas.csv', f.rows.SOA_Tbl)], scope);
    expect(plan.issues.find(i => i.ruleId === 'trip-soa')).toMatchObject({code: 'AMBIGUOUS', disposition: 'REVIEW'});
    expect(plan.retainedMissingSoaKeys).toHaveLength(0);
  });
  it('retains outside-scope document issues as context and never discards their source evidence', () => {
    const f = fixture(); f.rows.Invoice_Tbl.push({...f.rows.Invoice_Tbl[0], InvoiceNo: 'I02', SOANo: 'OTHER'});
    const plan = buildSixTableImportPlan(f.files(), {...scope, retainMissingSoaReferences: false});
    expect(plan.counts).toMatchObject({sourceRows: 7, contextIssues: 1, reviewIssues: 0});
    expect(plan.records.some(r => r.sourceKey === 'I02')).toBe(true);
    expect(plan.issues.find(i => i.sourceKey === 'I02')).toMatchObject({scope: 'OTHER_SUPPLIED_HISTORY', disposition: 'OUTSIDE_KNOWN_TRIP_LINKS'});
  });
  it.each(['OTHER', '0'])('reports a contradictory reverse invoice/SOA link %s without substituting an invoice', reverse => {
    const f = fixture(); f.rows.Invoice_Tbl[0].SOANo = reverse;
    const plan = buildSixTableImportPlan(f.files(), scope);
    expect(plan.documentLinkIssues).toMatchObject([{sourceSoa: 'S01', sourceInvoice: 'I01', invoiceSoaReference: reverse, disposition: 'REVIEW'}]);
    expect(plan.structuralStatus).toBe('REVIEW');
  });
  it('retains invalid-date and blank-key rows explicitly rather than silently excluding them', () => {
    const f = fixture(); f.rows.Trips_Tbl[0].DateOfTrip_Start = 'invalid'; f.rows.Driver_tbl[0].DriverID = '';
    const plan = buildSixTableImportPlan(f.files(), scope);
    expect(plan.counts).toMatchObject({sourceRows: 6, includedTrips: 0, invalidServiceDates: 1, recordsWithKeyIssues: 1});
    expect(plan.records).toHaveLength(6); expect(plan.dateIssues[0].row).toBe(2); expect(plan.structuralStatus).toBe('REVIEW');
  });
  it('reports missing tables and unchecked relationships for header-only exports', () => {
    const plan = buildSixTableImportPlan([file('company_tbl', 'company.csv', [])], scope);
    expect(plan.missingTables).toHaveLength(5); expect(plan.uncheckedRules).toHaveLength(6); expect(plan.structuralStatus).toBe('REVIEW');
  });
  it('binds changed evidence and scope even if keys and links stay the same', () => {
    const f = fixture(), first = buildSixTableImportPlan(f.files(), scope);
    f.rows.Invoice_Tbl[0].InvoiceTotAmt = '113.00';
    expect(buildSixTableImportPlan(f.files(), scope).evidenceSha256).not.toBe(first.evidenceSha256);
    expect(buildSixTableImportPlan(f.files(), {...scope, through: '2026-11-30'}).evidenceSha256).not.toBe(first.evidenceSha256);
  });
  it('rejects duplicate/path file identities, invalid UTF-8 and invalid service windows', () => {
    const f = fixture(), inputs = f.files();
    expect(() => buildSixTableImportPlan([...inputs, inputs[0]], scope)).toThrow('Unique');
    expect(() => buildSixTableImportPlan([{...inputs[0], id: '../source.csv'}], scope)).toThrow('identity');
    expect(() => buildSixTableImportPlan([{...inputs[0], bytes: new Uint8Array([255])}], scope)).toThrow();
    expect(() => buildSixTableImportPlan(inputs, {...scope, from: '2026-02-30'})).toThrow('window');
  });
});
