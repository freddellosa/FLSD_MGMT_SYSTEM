import {describe, expect, it} from 'vitest';
import {legacyStatusEvidence, scopeLegacyBilling, triageBillingDiagnostics, type LegacyBillingInput} from './legacy-billing-scope';
import {renderLegacyBillingHtml} from './legacy-billing-html';

function fixture(): LegacyBillingInput {
  return {from: '2026-09-01', through: '2026-10-31', customers: [{CompanyID: 'C01', CompanyName: 'Fictional customer'}],
    trips: [{tmpInvoiceNo: '001', CompanyID: 'C01', SOANo: 'S01', DateOfTrip_Start: '9/1/2026 08:00', InvoiceTotAmt: '112.0000'}],
    soas: [{SOANo: 'S01', InvoiceNo: 'I01', ChargeTo: 'Fictional customer', Status: 'Paid'}],
    invoices: [{InvoiceNo: 'I01', SOANo: 'S01', ChargeTo: 'Fictional customer', Status: 'Paid', DateOfTrip_Start: '8/31/2026', InvoiceDate: '11/2/2026', InvoiceTotAmt: '112.00'}]};
}
describe('legacy status evidence', () => {
  it('retains Paid status separately without inventing cash or allocation data', () => {
    expect(legacyStatusEvidence(' Paid ')).toEqual({sourceStatus: ' Paid ', payment: 'PAID_AS_RECORDED', document: 'NOT_ESTABLISHED'});
    expect(legacyStatusEvidence('Paid')).not.toHaveProperty('receivedAmount');
  });
  it.each(['Approved', 'Received', '', 'Partial', 'Not Paid'])('does not infer payment from %s', status => {
    expect(legacyStatusEvidence(status).payment).toBe('NOT_ESTABLISHED');
  });
  it.each(['cancel', 'Cancelled', 'CANCELED'])('retains cancellation spelling and never treats it as a paid receipt: %s', status => {
    expect(legacyStatusEvidence(status)).toMatchObject({sourceStatus: status, document: 'CANCELLED_AS_RECORDED', payment: 'NOT_ESTABLISHED'});
  });
});
describe('service-period billing reconciliation', () => {
  it('keeps supporting documents outside the window and preserves distinct invoice/trip identities', () => {
    const input = fixture(), before = structuredClone(input), result = scopeLegacyBilling(input);
    expect(result).toMatchObject({importEnabled: false, receiptsCreated: 0, allocationsCreated: 0, counts: {groups: 1, supportingInvoiceRows: 1},
      coverage: {includedTrips: 1, monthsWithoutSuppliedTrips: ['2026-10']}});
    expect(result.groups[0]).toMatchObject({status: 'EVIDENCE_CONSISTENT', assignmentApproved: false,
      tripRows: [{sourceTrip: '001', row: 2}], referencedInvoice: {sourceInvoice: 'I01', serviceDateInWindow: false, status: {payment: 'PAID_AS_RECORDED'}},
      monetaryEvidence: {tripGross: '112.00', invoiceGross: '112.00', comparison: 'MATCH'}});
    expect(input).toEqual(before);
  });
  it('uses original IDs and rejects cross-customer groups even when names match', () => {
    const input = fixture(); input.customers.push({CompanyID: 'C02', CompanyName: 'Fictional customer'});
    input.trips.push({...input.trips[0], tmpInvoiceNo: '002', CompanyID: 'C02'});
    expect(scopeLegacyBilling(input).groups[0].issues).toContain('MULTIPLE_TRIP_CUSTOMERS');
  });
  it('does not join padded or numerically similar keys', () => {
    const input = fixture(); input.trips[0].SOANo = ' S01';
    expect(scopeLegacyBilling(input).groups[0].issues).toContain('SOA_NOT_SUPPLIED');
    expect(scopeLegacyBilling(input).counts.supportingInvoiceRows).toBe(0);
  });
  it('keeps no-link trips unclassified and reports unlinked service-window invoices', () => {
    const input = fixture(); input.trips[0].SOANo = '0'; input.invoices[0].DateOfTrip_Start = '10/1/2026';
    expect(scopeLegacyBilling(input)).toMatchObject({counts: {groups: 0, tripsWithoutSoa: 1, unlinkedWindowInvoices: 1},
      tripsWithoutSoa: [{sourceTrip: '001', reason: 'NO_DOCUMENT_LINK_EVIDENCE'}]});
  });
  it('does not compare an included subset to a whole invoice when known source members are outside scope', () => {
    const input = fixture(); input.trips.push({...input.trips[0], tmpInvoiceNo: '002', DateOfTrip_Start: '8/1/2026'});
    const group = scopeLegacyBilling(input).groups[0];
    expect(group.monetaryEvidence.comparison).toBe('PARTIAL_SOURCE_GROUP');
    expect(group.issues).toContain('PARTIAL_SOURCE_TRIP_GROUP');
  });
  it('preserves cancelled invoice history without choosing the first invoice as current', () => {
    const input = fixture(); input.invoices.unshift({...input.invoices[0], InvoiceNo: 'OLD', Status: 'Cancelled'});
    const result = scopeLegacyBilling(input).groups[0];
    expect(result.invoices).toHaveLength(2); expect(result.referencedInvoice?.sourceInvoice).toBe('I01');
    expect(result.issues).not.toContain('MULTIPLE_NON_CANCELLED_INVOICE_ROWS');
    input.invoices[0].Status = 'Approved';
    expect(scopeLegacyBilling(input).groups[0].issues).toContain('MULTIPLE_NON_CANCELLED_INVOICE_ROWS');
  });
  it('never promotes a cancelled referenced form because its gross matches or the SOA says Paid', () => {
    const input = fixture(); input.invoices[0].Status = 'Cancelled';
    const group = scopeLegacyBilling(input).groups[0];
    expect(group.monetaryEvidence.comparison).toBe('MATCH');
    expect(group.status).toBe('REVIEW'); expect(group.issues).toContain('REFERENCED_INVOICE_MARKED_CANCELLED');
    expect(group.referencedInvoice?.status.payment).toBe('NOT_ESTABLISHED');
    expect(group.assignmentApproved).toBe(false);
  });
  it('does not choose the sole Paid invoice when the SOA reference is unassigned', () => {
    const input = fixture(); input.soas[0].InvoiceNo = '0';
    const group = scopeLegacyBilling(input).groups[0];
    expect(group.invoices[0].status.payment).toBe('PAID_AS_RECORDED');
    expect(group.referencedInvoice).toBeNull(); expect(group.monetaryEvidence.comparison).toBe('NOT_COMPARED');
    expect(group.issues).toContain('SOA_INVOICE_REFERENCE_UNASSIGNED');
  });
  it('reports reverse-link and label differences without repairing names or memberships', () => {
    const input = fixture(); input.invoices[0].SOANo = 'OTHER'; input.soas[0].ChargeTo = 'Different label';
    const group = scopeLegacyBilling(input).groups[0];
    expect(group.issues).toEqual(expect.arrayContaining(['REVERSE_SOA_LINK_DIFFERENCE', 'SOA_CUSTOMER_LABEL_DIFFERENCE']));
    expect(group.assignmentApproved).toBe(false);
  });
  it('does not invent missing gross amounts or double-add recorded tax', () => {
    const input = fixture(); input.trips[0].Evat = '12.00'; input.invoices[0].Evat = '12.00';
    expect(scopeLegacyBilling(input).groups[0].monetaryEvidence.tripGross).toBe('112.00');
    input.trips[0].InvoiceTotAmt = '';
    expect(scopeLegacyBilling(input).groups[0]).toMatchObject({monetaryEvidence: {tripGross: null, comparison: 'NOT_COMPARED'}});
  });
  it('reports exact amount differences beyond floating-point precision', () => {
    const input = fixture(); input.trips[0].InvoiceTotAmt = '9999999999999999.99'; input.invoices[0].InvoiceTotAmt = '9999999999999999.98';
    expect(scopeLegacyBilling(input).groups[0]).toMatchObject({monetaryEvidence: {tripGross: '9999999999999999.99', invoiceGross: '9999999999999999.98', comparison: 'DIFFERENT'}});
  });
  it('quarantines invalid dates instead of classifying them outside scope', () => {
    const input = fixture(); input.trips[0].DateOfTrip_Start = '2026-02-30';
    expect(scopeLegacyBilling(input).coverage).toMatchObject({includedTrips: 0, outsideWindow: 0, invalidDateTripRows: [{sourceTrip: '001', row: 2}]});
  });
  it('rejects duplicate identities and invalid coverage before making candidate assignments', () => {
    const input = fixture(); input.invoices.push({...input.invoices[0]});
    expect(() => scopeLegacyBilling(input)).toThrow('Duplicate invoice');
    expect(() => scopeLegacyBilling({...fixture(), through: '2026-02-30'})).toThrow('ISO');
  });
  it('partitions earlier findings without discarding evidence outside known trip links', () => {
    const input = fixture(); input.invoices.push({...input.invoices[0], InvoiceNo: 'OTHER', SOANo: 'UNLINKED', DateOfTrip_Start: '10/1/2026'});
    const result = scopeLegacyBilling(input), findings = [{code: 'A', sourceSoa: 'S01'}, {code: 'B', sourceSoa: 'UNLINKED'}, {code: 'C', sourceSoa: 'OLDER'}];
    expect(triageBillingDiagnostics(result, findings)).toMatchObject({total: 3, counts: {sharesIncludedSoaKey: 1, unlinkedServiceWindow: 1, outsideKnownTripLinks: 1}, outsideScopeIsNotApprovalToDiscard: true});
    expect(findings).toEqual([{code: 'A', sourceSoa: 'S01'}, {code: 'B', sourceSoa: 'UNLINKED'}, {code: 'C', sourceSoa: 'OLDER'}]);
  });
  it('renders escaped read-only evidence with no script or form controls', () => {
    const result = scopeLegacyBilling(fixture()); result.groups[0].sourceSoa = '<script>alert(1)</script>';
    const html = renderLegacyBillingHtml(result, triageBillingDiagnostics(result, []));
    expect(html).toContain('&lt;script&gt;'); expect(html).not.toMatch(/<script|<form|<iframe|<img/i);
    expect(html).toContain('PAID_AS_RECORDED'); expect(html).toContain('2026-10: 0 supplied trips');
    expect(html).toContain('Import disabled'); expect(html).toContain("default-src 'none'");
  });
});
