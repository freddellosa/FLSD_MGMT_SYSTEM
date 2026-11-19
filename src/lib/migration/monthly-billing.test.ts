import {describe, expect, it} from 'vitest';
import {reviewMonthlyBilling, type MonthlyBillingDefinition} from './monthly-billing';
import {stageAccessTrips, type AccessRow} from './access-staging';
import {scopeLegacyBilling} from './legacy-billing-scope';
import {buildBillingMappingProposals, initialBillingMappingDecisions, validateBillingMappingDecisions, type BillingSourceFingerprint} from './billing-mapping-proposals';
const definition: MonthlyBillingDefinition = {customerId: 'C1', month: '2026-10', fixedChargeTripId: 'M1', contractTerm: 'ANNUAL', billingUnit: 'CUSTOMER'};
function fixture(): AccessRow[] {
  return [{tmpInvoiceNo: 'M1', CompanyID: 'C1', VehicleID: 'V1', SOANo: 'S1', DateOfTrip_Start: '10/31/2026', BaseAmount: '1000.00', InvoiceTotAmt: '1120.00', Status: 'Approved'},
    {tmpInvoiceNo: 'U1', CompanyID: 'C1', VehicleID: 'V2', SOANo: 'S1', DateOfTrip_Start: '10/1/2026', BaseAmount: '0', InvoiceTotAmt: '0', Status: 'Approved'},
    {tmpInvoiceNo: 'U2', CompanyID: 'C1', VehicleID: 'V1', SOANo: 'S1', DateOfTrip_Start: '10/2/2026', BaseAmount: '0', InvoiceTotAmt: '25.01', Status: 'Approved'}];
}
describe('customer monthly fixed-rate source review', () => {
  it('counts the designated fixed charge once plus recorded extras, across vehicles for one customer', () => {
    const rows = fixture(), before = structuredClone(rows), cycle = reviewMonthlyBilling(rows, [definition])[0];
    expect(cycle).toMatchObject({fixedChargeCounted: 1, totals: {fixedGross: '1120.00', recordedExtrasGross: '25.01', combinedRecordedGross: '1145.01'}, receiptsCreated: 0, allocationsCreated: 0, importEnabled: false});
    expect(cycle.usageRows[0]).toMatchObject({sourceTripId: 'U1', zeroGross: true, receivableCreated: false});
    expect(cycle.usageRows[1]).toMatchObject({sourceTripId: 'U2', hasRecordedExtraCharge: true, receivableCreated: false});
    expect(rows).toEqual(before);
  });
  it('does not absorb another customer or another month into the annual contract', () => {
    const rows = fixture(); rows.push({...rows[1], tmpInvoiceNo: 'OTHER', CompanyID: 'C2'}, {...rows[1], tmpInvoiceNo: 'NOV', DateOfTrip_Start: '11/1/2026'});
    expect(reviewMonthlyBilling(rows, [definition])[0].usageRows).toHaveLength(2);
  });
  it('refuses duplicate monthly fixed charges and wrong-customer/period references', () => {
    const rows = fixture(); rows[2].BaseAmount = '1.00';
    expect(() => reviewMonthlyBilling(rows, [definition])).toThrow('Additional base');
    expect(() => reviewMonthlyBilling(fixture(), [{...definition, customerId: 'C2'}])).toThrow('match customer');
    expect(() => reviewMonthlyBilling(fixture(), [definition, definition])).toThrow('duplicate');
  });
  it('keeps ordinary zero-charge checks strict while accepting declared monthly operational usage', () => {
    const rows = fixture(), input = {trips: rows, columns: {id: 'tmpInvoiceNo', startDate: 'DateOfTrip_Start', customer: 'CompanyID', agreedCharge: 'InvoiceTotAmt'}};
    expect(stageAccessTrips(input).rows[1].status).toBe('REJECTED');
    const evidence = reviewMonthlyBilling(rows, [definition])[0].usageEvidence;
    const result = stageAccessTrips({...input, monthlyUsageEvidence: evidence});
    expect(result.rows[1]).toMatchObject({agreedCentavos: 0n, billingRole: 'MONTHLY_USAGE', fixedChargeTripId: 'M1', errors: []});
    expect(result.rows[1]).not.toHaveProperty('paid');
    expect(() => stageAccessTrips({...input, monthlyUsageEvidence: [{...evidence[0], customerId: 'C2'}]})).toThrow('same customer');
  });
  it('retains missing SOA references without fabricating documents or demanding individual confirmation', () => {
    const input = {trips: fixture(), customers: [{CompanyID: 'C1', CompanyName: 'Customer'}], soas: [], invoices: [], from: '2026-10-01', through: '2026-10-31', retainMissingSoaReferences: true, monthlyBilling: [definition]};
    const review = scopeLegacyBilling(input);
    expect(review.groups[0]).toMatchObject({status: 'REFERENCE_ONLY', sourceDocumentEvidenceComplete: false, assignmentApproved: false});
    expect(review.counts).toMatchObject({groupsRequiringReview: 0, referenceOnlyGroups: 1});
    const fingerprints: BillingSourceFingerprint[] = (['trips', 'customers', 'soas', 'invoices'] as const).map(kind => ({kind, sha256: 'a'.repeat(64), rows: input[kind].length}));
    const packet = buildBillingMappingProposals(input, fingerprints), decisions = initialBillingMappingDecisions(packet);
    expect(packet.counts.retainedPartialReferences).toBe(1); expect(decisions.items).toEqual([]);
    expect(validateBillingMappingDecisions(packet, decisions)).toMatchObject({executionAuthorized: false, importEnabled: false});
  });
  it('does not hide a mixed-customer conflict merely because its SOA is absent', () => {
    const rows = fixture(); rows[1].CompanyID = 'C2';
    const review = scopeLegacyBilling({trips: rows, customers: [{CompanyID: 'C1', CompanyName: 'Customer'}], soas: [], invoices: [], from: '2026-10-01', through: '2026-10-31', retainMissingSoaReferences: true});
    expect(review.groups[0].status).toBe('REVIEW'); expect(review.groups[0].requiredIssues).toContain('MULTIPLE_TRIP_CUSTOMERS');
  });
});
