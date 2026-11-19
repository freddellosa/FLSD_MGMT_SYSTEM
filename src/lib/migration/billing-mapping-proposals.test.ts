import {describe, expect, it} from 'vitest';
import {billingMappingReviewProgress, buildBillingMappingProposals, initialBillingMappingDecisions, validateBillingMappingDecisions, type BillingSourceFingerprint} from './billing-mapping-proposals';
import type {LegacyBillingInput} from './legacy-billing-scope';
import {renderBillingMappingHtml} from './billing-mapping-html';

function fixture() {
  const input: LegacyBillingInput = {from: '2026-09-01', through: '2026-10-31',
    customers: [{CompanyID: 'C01', CompanyName: 'Fictional registered name'}],
    trips: [{tmpInvoiceNo: '001', CompanyID: 'C01', SOANo: 'S1', DateOfTrip_Start: '9/1/2026', InvoiceTotAmt: '112.00', Evat: '12.00'}],
    soas: [{SOANo: 'S1', InvoiceNo: 'I1', ChargeTo: 'Historical label', Status: 'Received'}],
    invoices: [{InvoiceNo: 'I1', SOANo: 'S1', ChargeTo: 'Historical label', Status: 'Received', DateOfTrip_Start: '9/1/2026', InvoiceTotAmt: '112.00'}]};
  const fingerprints: BillingSourceFingerprint[] = (['trips', 'customers', 'soas', 'invoices'] as const).map((kind, i) => ({kind, sha256: String(i).repeat(64), rows: input[kind].length}));
  return {input, fingerprints};
}
describe('attributable mapping proposals', () => {
  it('proposes document-specific identity confirmation without rewriting historical labels, money or source input', () => {
    const f = fixture(), before = structuredClone(f), packet = buildBillingMappingProposals(f.input, f.fingerprints);
    expect(packet).toMatchObject({importEnabled: false, counts: {groups: 1, candidateIdentityConfirmations: 1, sourceEvidenceRequired: 0}});
    expect(packet.proposals[0]).toMatchObject({approval: 'PENDING', applyEnabled: false, candidateCustomerId: 'C01',
      originalEvidence: {soa: {originalLabel: 'Historical label'}, customerLabels: [{masterLabel: 'Fictional registered name'}]}, amounts: {difference: '0.00'}});
    expect(f).toEqual(before);
  });
  it.each(['cancelled', 'missing-reference', 'amount-difference', 'mixed-customer'] as const)('keeps %s as a blocker without proposing an identity change', kind => {
    const f = fixture();
    if (kind === 'cancelled') f.input.invoices[0].Status = 'Cancelled';
    if (kind === 'missing-reference') f.input.soas[0].InvoiceNo = '0';
    if (kind === 'amount-difference') f.input.invoices[0].InvoiceTotAmt = '111.99';
    if (kind === 'mixed-customer') { f.input.trips.push({...f.input.trips[0], tmpInvoiceNo: '002', CompanyID: 'C02'}); f.fingerprints[0].rows++; }
    const packet = buildBillingMappingProposals(f.input, f.fingerprints);
    expect(packet.proposals[0]).toMatchObject({classification: 'SOURCE_EVIDENCE_REQUIRED', candidateCustomerId: null, applyEnabled: false});
  });
  it('retains exact differences and never proposes balancing receipts or automatic replacement invoices', () => {
    const f = fixture(); f.input.trips[0].InvoiceTotAmt = '9999999999999999.99'; f.input.invoices[0].InvoiceTotAmt = '9999999999999999.98';
    const packet = buildBillingMappingProposals(f.input, f.fingerprints);
    expect(packet.proposals[0].amounts.difference).toBe('0.01');
    expect(packet.proposals[0]).not.toHaveProperty('replacementInvoice'); expect(packet).not.toHaveProperty('receipts');
  });
  it('does not infer customer tax/workflow policy from zero or nonzero recorded VAT', () => {
    const f = fixture(), packet = buildBillingMappingProposals(f.input, f.fingerprints);
    expect(packet.customerTasks[0]).toMatchObject({sourceCustomerId: 'C01', nonzeroRecordedVatRows: 1, vatStatus: null, vatTreatment: null, billingWorkflow: null, approval: 'PENDING'});
    f.input.trips[0].Evat = '0';
    expect(buildBillingMappingProposals(f.input, f.fingerprints).customerTasks[0].vatStatus).toBeNull();
  });
  it('binds source fingerprints while ignoring fingerprint property and array ordering', () => {
    const f = fixture(), first = buildBillingMappingProposals(f.input, f.fingerprints);
    expect(buildBillingMappingProposals(f.input, [...f.fingerprints].reverse()).evidenceSha256).toBe(first.evidenceSha256);
    f.fingerprints[0].sha256 = 'a'.repeat(64);
    expect(buildBillingMappingProposals(f.input, f.fingerprints).evidenceSha256).not.toBe(first.evidenceSha256);
    expect(() => buildBillingMappingProposals(f.input, f.fingerprints.slice(1))).toThrow('four');
  });
  it('renders escaped original labels with no forms, scripts or external requests', () => {
    const f = fixture(); f.input.soas[0].ChargeTo = '<img src=x onerror=alert(1)>';
    const packet = buildBillingMappingProposals(f.input, f.fingerprints), html = renderBillingMappingHtml(packet, 'Pending');
    expect(html).toContain('&lt;img'); expect(html).not.toMatch(/<script|<img|<iframe|<form/i);
    expect(html).toContain('Original document labels'); expect(html).toContain('Identity confirmation candidate');
    expect(html).toContain('Import and execution disabled'); expect(html).toContain("default-src 'none'");
  });
});
describe('mapping review decisions remain non-executable', () => {
  it.each(['CONFIRM_CANDIDATE_IDENTITY', 'REJECT_CANDIDATE', 'KEEP_UNRESOLVED'] as const)('renders validated %s and escaped notes without overwriting original evidence', decision => {
    const f = fixture(), packet = buildBillingMappingProposals(f.input, f.fingerprints), decisions = initialBillingMappingDecisions(packet);
    decisions.items[0] = {...decisions.items[0], decision, customerId: decision === 'CONFIRM_CANDIDATE_IDENTITY' ? 'C01' : null,
      reviewerNote: '<script>untrusted note</script> & original evidence retained'};
    const before = structuredClone({packet, decisions});
    const html = renderBillingMappingHtml(packet, 'Review recorded', 'current.json', decisions);
    expect(html).toContain('Recorded decisions');
    expect(html).toContain(decision === 'CONFIRM_CANDIDATE_IDENTITY' ? 'Identity confirmed' : decision === 'REJECT_CANDIDATE' ? 'Candidate rejected; unresolved' : 'Reviewed; unresolved');
    expect(html).toContain('&lt;script&gt;untrusted note&lt;/script&gt; &amp;');
    expect(html).not.toMatch(/<script|<iframe|<form/i);
    expect(html).toContain('Historical label'); expect(html).toContain('Import and execution disabled');
    expect({packet, decisions}).toEqual(before);
  });
  it('does not infer per-document confirmations from a summary when validated decisions are absent', () => {
    const f = fixture(), packet = buildBillingMappingProposals(f.input, f.fingerprints);
    const html = renderBillingMappingHtml(packet, 'All confirmed');
    expect(html).toContain('No validated decision file supplied');
    expect(html).toContain('Per-document decisions are unavailable');
    expect(html).not.toContain('<strong>Identity confirmed</strong>');
  });
  it('rejects stale decision evidence before displaying recorded identities', () => {
    const f = fixture(), packet = buildBillingMappingProposals(f.input, f.fingerprints), decisions = initialBillingMappingDecisions(packet);
    decisions.evidenceSha256 = 'f'.repeat(64);
    expect(() => renderBillingMappingHtml(packet, 'Confirmed', 'current.json', decisions)).toThrow('stale');
  });
  it('reads current edits rather than a generated summary and never enables execution after confirmation', () => {
    const f = fixture(), packet = buildBillingMappingProposals(f.input, f.fingerprints), decisions = initialBillingMappingDecisions(packet);
    expect(billingMappingReviewProgress(packet, decisions).counts).toMatchObject({pending: 1, recordedIdentityConfirmations: 0});
    decisions.items[0] = {...decisions.items[0], decision: 'CONFIRM_CANDIDATE_IDENTITY', customerId: 'C01', reviewerNote: 'Verified original document.'};
    const before = structuredClone({packet, decisions});
    expect(billingMappingReviewProgress(packet, decisions)).toMatchObject({importEnabled: false, executionAuthorized: false,
      counts: {pending: 0, recordedIdentityConfirmations: 1}, items: [{identityRecorded: true, sourceEvidenceStillRequired: false}]});
    expect({packet, decisions}).toEqual(before);
  });
  it.each(['KEEP_UNRESOLVED', 'REJECT_CANDIDATE'] as const)('does not clear cancelled-document evidence after %s', decision => {
    const f = fixture(); f.input.invoices[0].Status = 'Cancelled';
    const packet = buildBillingMappingProposals(f.input, f.fingerprints), decisions = initialBillingMappingDecisions(packet);
    decisions.items[0] = {...decisions.items[0], decision, reviewerNote: 'Recorded review; original evidence remains unresolved.'};
    const progress = billingMappingReviewProgress(packet, decisions);
    expect(progress.counts).toMatchObject({pending: 0, sourceEvidenceStillRequired: 1,
      keptUnresolved: decision === 'KEEP_UNRESOLVED' ? 1 : 0, rejectedCandidates: decision === 'REJECT_CANDIDATE' ? 1 : 0});
    expect(progress.items[0].issueCodes).toContain('REFERENCED_INVOICE_MARKED_CANCELLED');
    expect(progress.executionAuthorized).toBe(false);
  });
  it('keeps partial references out of the decision queue while retaining their count', () => {
    const f = fixture(); f.input.retainMissingSoaReferences = true;
    f.input.trips.push({...f.input.trips[0], tmpInvoiceNo: '002', SOANo: 'PARTIAL'}); f.fingerprints[0].rows++;
    const packet = buildBillingMappingProposals(f.input, f.fingerprints);
    const progress = billingMappingReviewProgress(packet, initialBillingMappingDecisions(packet));
    expect(progress.counts).toMatchObject({actionable: 1, pending: 1, retainedPartialReferences: 1});
    expect(progress.items.map(i => i.sourceSoa)).toEqual(['S1']);
  });
  it('rejects stale decisions before reporting progress', () => {
    const f = fixture(), packet = buildBillingMappingProposals(f.input, f.fingerprints), decisions = initialBillingMappingDecisions(packet);
    decisions.evidenceSha256 = 'f'.repeat(64);
    expect(() => billingMappingReviewProgress(packet, decisions)).toThrow('stale');
  });
  it('starts entirely pending and accepts only exact reviewed identity candidates with a note', () => {
    const f = fixture(), packet = buildBillingMappingProposals(f.input, f.fingerprints), decisions = initialBillingMappingDecisions(packet);
    expect(validateBillingMappingDecisions(packet, decisions)).toMatchObject({pending: 1, recordedIdentityConfirmations: 0, importEnabled: false, executionAuthorized: false});
    decisions.items[0] = {...decisions.items[0], decision: 'CONFIRM_CANDIDATE_IDENTITY', customerId: 'C01', reviewerNote: 'Reviewed original source document for this ID.'};
    expect(validateBillingMappingDecisions(packet, decisions)).toMatchObject({pending: 0, recordedIdentityConfirmations: 1, executionAuthorized: false});
    decisions.items[0].customerId = 'C02';
    expect(() => validateBillingMappingDecisions(packet, decisions)).toThrow('exact proposed');
  });
  it('rejects stale evidence, packet edits, duplicate decisions and missing review notes', () => {
    const f = fixture(), packet = buildBillingMappingProposals(f.input, f.fingerprints), decisions = initialBillingMappingDecisions(packet);
    expect(() => validateBillingMappingDecisions(packet, {...decisions, evidenceSha256: 'a'.repeat(64)})).toThrow('stale');
    expect(() => validateBillingMappingDecisions(packet, {...decisions, items: []})).toThrow('Every proposal');
    decisions.items[0].decision = 'KEEP_UNRESOLVED';
    expect(() => validateBillingMappingDecisions(packet, decisions)).toThrow('note');
    packet.proposals[0].sourceSoa = 'edited';
    expect(() => validateBillingMappingDecisions(packet, decisions)).toThrow('changed');
  });
  it('cannot confirm an identity to bypass a cancelled-invoice or amount blocker', () => {
    const f = fixture(); f.input.invoices[0].Status = 'Cancelled';
    const packet = buildBillingMappingProposals(f.input, f.fingerprints), decisions = initialBillingMappingDecisions(packet);
    decisions.items[0] = {...decisions.items[0], decision: 'CONFIRM_CANDIDATE_IDENTITY', customerId: 'C01', reviewerNote: 'Attempted override'};
    expect(() => validateBillingMappingDecisions(packet, decisions)).toThrow('exact proposed');
  });
});
