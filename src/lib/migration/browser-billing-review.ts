/** Browser-local inspection only. No source import, persistence or verified actor authority. */
import {canonicalReviewJson} from './canonical-review-json';
import {validateBillingDecisionEntries} from './billing-review-decisions';
import type {BillingMappingDecisions, BillingMappingPacket} from './billing-mapping-proposals';

type JsonObject = Record<string, unknown>;
const object = (v: unknown): JsonObject => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected review object');
  return v as JsonObject;
};
const string = (v: unknown): string => {
  if (typeof v !== 'string' || v.length > 4000) throw new Error('Invalid review text');
  return v;
};
const optionalString = (v: unknown) => v === null ? null : string(v);
const array = (v: unknown): unknown[] => {
  if (!Array.isArray(v) || v.length > 10000) throw new Error('Invalid review rows');
  return v;
};
const classifications = ['CANDIDATE_IDENTITY_CONFIRMATION', 'SOURCE_EVIDENCE_REQUIRED', 'PARTIAL_EXPORT_REFERENCE'];
export type BrowserBillingRow = {
  id: string; soa: string; classification: string; candidate: string | null;
  customerLabels: string[]; invoice: string | null; invoiceStatus: string | null;
  originalSoaLabel: string | null; originalInvoiceLabel: string | null;
  tripGross: string | null; invoiceGross: string | null; difference: string | null;
  trips: string[]; instructions: string[];
  decision: BillingMappingDecisions['items'][number]['decision'] | 'REFERENCE_ONLY'; note: string;
};
export type BrowserBillingReview = Awaited<ReturnType<typeof inspectBrowserBillingReview>>;

export async function inspectBrowserBillingReview(packetText: string, decisionText: string) {
  try {
    if (packetText.length > 10 * 1024 * 1024 || decisionText.length > 10 * 1024 * 1024) throw new Error('Review bound exceeded');
    const envelope = object(JSON.parse(packetText)), packet = object(envelope.packet);
    if (packet.kind !== 'BILLING_MAPPING_REVIEW_PROPOSALS' || packet.version !== 1 || packet.importEnabled !== false) throw new Error('Disabled review packet required');
    const {evidenceSha256, ...body} = packet;
    if (typeof evidenceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(evidenceSha256)) throw new Error('Invalid fingerprint');
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalReviewJson(body)));
    const actual = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
    if (actual !== evidenceSha256) throw new Error('Packet fingerprint mismatch');
    const rows = array(packet.proposals).map(value => {
      const p = object(value), evidence = object(p.originalEvidence), amounts = object(p.amounts);
      const classification = string(p.classification);
      if (!classifications.includes(classification) || p.applyEnabled !== false) throw new Error('Invalid proposal');
      const soa = evidence.soa === null ? null : object(evidence.soa);
      const invoice = evidence.referencedInvoice === null ? null : object(evidence.referencedInvoice);
      return {id: string(p.id), soa: string(p.sourceSoa), classification, candidate: optionalString(p.candidateCustomerId),
        customerLabels: array(evidence.customerLabels).map(c => {const item = object(c); return string(item.sourceCustomerId) + ': ' + (optionalString(item.masterLabel) ?? 'Not supplied');}),
        invoice: invoice ? string(invoice.sourceInvoice) : null, invoiceStatus: invoice ? string(invoice.originalStatus) : null,
        originalSoaLabel: soa ? string(soa.originalLabel) : null, originalInvoiceLabel: invoice ? string(invoice.originalLabel) : null,
        tripGross: optionalString(amounts.tripGross), invoiceGross: optionalString(amounts.invoiceGross), difference: optionalString(amounts.difference),
        trips: array(evidence.trips).map(t => {const item = object(t); return string(item.sourceTrip) + ' / customer ' + string(item.sourceCustomerId) + ' / ' + string(item.fileName) + ' / record ' + stringOrRow(item.row);}),
        instructions: array(p.reviewSteps).map(s => string(object(s).instruction))};
    });
    if (new Set(rows.map(r => r.id)).size !== rows.length) throw new Error('Duplicate proposals');
    const decisions = object(JSON.parse(decisionText));
    for (const item of array(decisions.items)) {const d = object(item); string(d.proposalId); string(d.decision); optionalString(d.customerId); string(d.reviewerNote);}
    // This check is shared with the CLI; the packet body hash above is verified before entry validation.
    const summary = validateBillingDecisionEntries(packet as unknown as BillingMappingPacket, decisions as unknown as BillingMappingDecisions);
    const byId = new Map((decisions.items as BillingMappingDecisions['items']).map(d => [d.proposalId, d]));
    const result: BrowserBillingRow[] = rows.map(r => ({...r, decision: byId.get(r.id)?.decision ?? 'REFERENCE_ONLY', note: byId.get(r.id)?.reviewerNote ?? ''}));
    return {importEnabled: false as const, executionAuthorized: false as const, evidenceSha256,
      from: string(packet.from), through: string(packet.through), decisionFileName: string(envelope.decisionFileName),
      counts: {pending: summary.pending, confirmed: summary.recordedIdentityConfirmations,
        rejected: result.filter(r => r.decision === 'REJECT_CANDIDATE').length,
        unresolved: result.filter(r => r.decision === 'KEEP_UNRESOLVED').length,
        references: result.filter(r => r.decision === 'REFERENCE_ONLY').length,
        sourceCases: result.filter(r => r.classification === 'SOURCE_EVIDENCE_REQUIRED').length,
        contractReminders: array(packet.customerTasks).length}, rows: result};
  } catch {
    throw new Error('These review files are invalid, changed or from different revisions. Choose the current generated packet and its matching decision file.');
  }
}
function stringOrRow(value: unknown) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 2) throw new Error('Invalid source row');
  return String(value);
}
