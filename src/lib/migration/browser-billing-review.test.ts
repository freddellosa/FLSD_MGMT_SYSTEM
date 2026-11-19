import {describe, expect, it} from 'vitest';
import {buildBillingMappingProposals, initialBillingMappingDecisions} from './billing-mapping-proposals';
import {inspectBrowserBillingReview} from './browser-billing-review';

function fixture() {
  const packet = buildBillingMappingProposals({from: '2026-09-01', through: '2026-10-31', retainMissingSoaReferences: true,
    customers: [{CompanyID: 'C1', CompanyName: 'Current customer'}],
    trips: [{tmpInvoiceNo: 'T1', CompanyID: 'C1', SOANo: 'S1', DateOfTrip_Start: '9/1/2026', InvoiceTotAmt: '112.00'},
      {tmpInvoiceNo: 'T2', CompanyID: 'C1', SOANo: 'PARTIAL', DateOfTrip_Start: '10/1/2026', InvoiceTotAmt: '25.00'}],
    soas: [{SOANo: 'S1', InvoiceNo: 'I1', ChargeTo: 'Historical customer', Status: 'Received'}],
    invoices: [{InvoiceNo: 'I1', SOANo: 'S1', ChargeTo: 'Historical customer', Status: 'Approved', DateOfTrip_Start: '9/1/2026', InvoiceTotAmt: '112.00'}]},
  (['trips', 'customers', 'soas', 'invoices'] as const).map((kind, i) => ({kind, sha256: String(i).repeat(64), rows: i === 0 ? 2 : 1})));
  const decisions = initialBillingMappingDecisions(packet);
  return {packet, decisions, envelope: {packet, decisionFileName: 'billing-mapping-decisions.json'}};
}
describe('browser-local billing evidence inspection', () => {
  it('verifies the same packet hash and review entries as offline tooling without changing original values', async () => {
    const f = fixture(), before = structuredClone(f);
    const result = await inspectBrowserBillingReview(JSON.stringify(f.envelope), JSON.stringify(f.decisions));
    expect(result).toMatchObject({importEnabled: false, executionAuthorized: false,
      counts: {pending: 1, confirmed: 0, references: 1}});
    expect(result.rows.find(r => r.soa === 'S1')).toMatchObject({tripGross: '112.00', invoiceGross: '112.00', difference: '0.00'});
    expect(result.rows.find(r => r.soa === 'PARTIAL')?.decision).toBe('REFERENCE_ONLY');
    expect(f).toEqual(before);
  });
  it.each(['CONFIRM_CANDIDATE_IDENTITY', 'REJECT_CANDIDATE', 'KEEP_UNRESOLVED'] as const)('retains %s notes as text and never authorizes execution', async decision => {
    const f = fixture(); f.decisions.items[0] = {...f.decisions.items[0], decision,
      customerId: decision === 'CONFIRM_CANDIDATE_IDENTITY' ? 'C1' : null, reviewerNote: '<img src=x onerror=alert(1)> original note'};
    const result = await inspectBrowserBillingReview(JSON.stringify(f.envelope), JSON.stringify(f.decisions));
    expect(result.rows.find(r => r.soa === 'S1')).toMatchObject({decision, note: '<img src=x onerror=alert(1)> original note'});
    expect(result.executionAuthorized).toBe(false);
  });
  it('rejects changed packet content even when decisions still reference its old digest', async () => {
    const f = fixture(); f.packet.proposals[0].amounts.tripGross = '999.00';
    await expect(inspectBrowserBillingReview(JSON.stringify(f.envelope), JSON.stringify(f.decisions))).rejects.toThrow('invalid, changed');
  });
  it('rejects another revision and customer overrides using shared entry rules', async () => {
    const f = fixture(); f.decisions.evidenceSha256 = 'a'.repeat(64);
    await expect(inspectBrowserBillingReview(JSON.stringify(f.envelope), JSON.stringify(f.decisions))).rejects.toThrow('different revisions');
    f.decisions.evidenceSha256 = f.packet.evidenceSha256;
    f.decisions.items[0] = {...f.decisions.items[0], decision: 'CONFIRM_CANDIDATE_IDENTITY', customerId: 'C2', reviewerNote: 'Wrong customer'};
    await expect(inspectBrowserBillingReview(JSON.stringify(f.envelope), JSON.stringify(f.decisions))).rejects.toThrow('different revisions');
  });
  it.each(['null', '{"packet":null}', '{"packet":{"proposals":[null]}}', '{broken'])('rejects malformed %s with a safe error', async text => {
    await expect(inspectBrowserBillingReview(text, 'null')).rejects.toThrow('These review files are invalid');
  });
});
