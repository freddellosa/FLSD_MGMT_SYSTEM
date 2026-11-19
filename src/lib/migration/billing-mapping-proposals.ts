import {validateBillingDecisionEntries} from './billing-review-decisions';
/** Review proposals only. Never applies corrections, writes SQL or approves financial policy. */
import {createHash} from 'node:crypto';
import {fromCentavos, toCentavos} from '../domain/billing';
import {accessMoney} from './access-staging';
import {scopeLegacyBilling, type LegacyBillingInput} from './legacy-billing-scope';
import {canonicalReviewJson} from './review-report';
import {tripPartitionDigest, type TripPartitionEvidence} from './trip-partitions';

export type BillingSourceFingerprint = {kind: 'trips' | 'customers' | 'soas' | 'invoices'; sha256: string; rows: number; partitions?: TripPartitionEvidence[]};
const labelIssues = new Set(['SOA_CUSTOMER_LABEL_DIFFERENCE', 'INVOICE_CUSTOMER_LABEL_DIFFERENCE']);
const hash = (value: unknown) => createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
const sort = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const actions: Record<string, string> = {
  CUSTOMER_ID_UNRESOLVED: 'Establish customer identity from original trip keys; do not merge names.',
  MULTIPLE_TRIP_CUSTOMERS: 'Review the listed trip customer IDs and original SOA membership before any split or reassignment.',
  REFERENCED_INVOICE_MARKED_CANCELLED: 'Inspect the original invoice/replacement history; no alternative form is selected.',
  SOA_INVOICE_REFERENCE_UNASSIGNED: 'Confirm the original invoice reference, or retain the SOA as having no confirmed invoice.',
  TRIP_INVOICE_GROSS_DIFFERENCE: 'Reconcile recorded charges and document membership; no balancing charge or payment is proposed.',
  SOA_CUSTOMER_LABEL_DIFFERENCE: 'Confirm whether this historical SOA label belongs to the candidate customer ID; preserve its original label.',
  INVOICE_CUSTOMER_LABEL_DIFFERENCE: 'Confirm whether this historical invoice label belongs to the candidate customer ID; preserve its original label.',
};

export function buildBillingMappingProposals(input: LegacyBillingInput, fingerprints: readonly BillingSourceFingerprint[]) {
  const expectedKinds = ['trips', 'customers', 'soas', 'invoices'] as const;
  if (fingerprints.length !== expectedKinds.length || new Set(fingerprints.map(f => f.kind)).size !== expectedKinds.length ||
      expectedKinds.some(kind => !fingerprints.some(f => f.kind === kind))) throw new Error('All four source fingerprints required');
  for (const f of fingerprints) if (!/^[a-f0-9]{64}$/.test(f.sha256) || f.rows !== input[f.kind].length || !Number.isSafeInteger(f.rows)) throw new Error('Source fingerprint/count mismatch');
  for (const f of fingerprints) if (f.partitions && (f.kind !== 'trips' || tripPartitionDigest(f.partitions) !== f.sha256 || f.partitions.reduce((n, p) => n + p.rows, 0) !== f.rows)) throw new Error('Trip partition fingerprint/count mismatch');
  const review = scopeLegacyBilling(input);
  const customers = new Map(input.customers.map(c => [c.CompanyID, c]));
  const tripsById = new Map(input.trips.map(t => [t.tmpInvoiceNo, t]));
  const proposals = review.groups.filter(g => g.status !== 'EVIDENCE_CONSISTENT').map(group => {
    const labelOnly = group.issues.every(issue => labelIssues.has(issue)) && group.customerIds.length === 1 && group.monetaryEvidence.comparison === 'MATCH';
    const customerId = group.customerIds.length === 1 && customers.has(group.customerIds[0]) ? group.customerIds[0] : null;
    const soa = group.soaRow === null ? null : input.soas[group.soaRow - 2];
    const invoice = group.referencedInvoice ? input.invoices[group.referencedInvoice.row - 2] : null;
    return {id: 'SOA:' + encodeURIComponent(group.sourceSoa), sourceSoa: group.sourceSoa,
      classification: group.status === 'REFERENCE_ONLY' ? 'PARTIAL_EXPORT_REFERENCE' as const : labelOnly ? 'CANDIDATE_IDENTITY_CONFIRMATION' as const : 'SOURCE_EVIDENCE_REQUIRED' as const,
      approval: group.status === 'REFERENCE_ONLY' ? 'NOT_REQUIRED_FOR_REFERENCE_RETENTION' as const : 'PENDING' as const, applyEnabled: false as const,
      candidateCustomerId: labelOnly ? customerId : null,
      originalEvidence: {customerIds: [...group.customerIds],
        customerLabels: group.customerIds.map(id => ({sourceCustomerId: id, masterLabel: customers.get(id)?.CompanyName ?? null})),
        soa: soa ? {sourceSoa: group.sourceSoa, row: group.soaRow, originalLabel: soa.ChargeTo, originalInvoiceReference: soa.InvoiceNo} : null,
        referencedInvoice: invoice ? {sourceInvoice: invoice.InvoiceNo, row: group.referencedInvoice!.row, originalLabel: invoice.ChargeTo, originalStatus: invoice.Status} : null,
        trips: group.tripRows.map(t => ({sourceTrip: t.sourceTrip, row: t.row, fileName: t.fileName, sourceCustomerId: tripsById.get(t.sourceTrip)!.CompanyID})),
        otherInvoiceEvidence: group.invoices.map(i => ({sourceInvoice: i.sourceInvoice, row: i.row, originalStatus: i.status.sourceStatus}))},
      amounts: {...group.monetaryEvidence,
        difference: group.monetaryEvidence.tripGross !== null && group.monetaryEvidence.invoiceGross !== null
          ? fromCentavos(toCentavos(group.monetaryEvidence.tripGross) - toCentavos(group.monetaryEvidence.invoiceGross)) : null},
      reviewSteps: group.issues.map(code => ({code, instruction: actions[code] ?? 'Review the original source evidence; no automatic correction is proposed.'})),
      proposedTreatment: group.status === 'REFERENCE_ONLY' ? 'Retain the original SOA number as partial-export evidence. Continue operational development without fabricating a document or authorizing billing against it.' : labelOnly ? 'Confirm a document-specific customer identity association; retain all historical labels and exact amounts.' : 'Keep unresolved until original evidence supports an attributable mapping/correction.',
    };
  });
  const includedIds = new Set([...review.groups.flatMap(g => g.tripRows.map(t => t.sourceTrip)), ...review.tripsWithoutSoa.map(t => t.sourceTrip)]);
  const includedTripRows = input.trips.filter(t => includedIds.has(t.tmpInvoiceNo));
  const tripsByCustomer = new Map<string, typeof includedTripRows>();
  for (const trip of includedTripRows) { const rows = tripsByCustomer.get(trip.CompanyID) ?? []; rows.push(trip); tripsByCustomer.set(trip.CompanyID, rows); }
  const noSoaByCustomer = new Map<string, number>();
  for (const trip of review.tripsWithoutSoa) noSoaByCustomer.set(trip.customerId, (noSoaByCustomer.get(trip.customerId) ?? 0) + 1);
  const customerIds = [...new Set(includedTripRows.map(t => t.CompanyID))].sort(sort);
  const customerTasks = customerIds.map(id => {
    const trips = tripsByCustomer.get(id)!;
    let nonzeroVatRows = 0, unresolvedVatRows = 0;
    for (const t of trips) { try { if (!t.Evat?.trim()) unresolvedVatRows++; else if (accessMoney(t.Evat) > 0n) nonzeroVatRows++; } catch { unresolvedVatRows++; } }
    return {id: 'CUSTOMER:' + encodeURIComponent(id), sourceCustomerId: id, sourceName: customers.get(id)?.CompanyName ?? null,
      tripRows: trips.length, tripsWithoutSoa: noSoaByCustomer.get(id) ?? 0,
      nonzeroRecordedVatRows: nonzeroVatRows, unresolvedRecordedVatRows: unresolvedVatRows,
      vatStatus: null, vatTreatment: null, billingWorkflow: null, effectiveFrom: input.from, effectiveThrough: input.through,
      monthlyBilling: review.monthlyBilling.filter(c => c.definition.customerId === id).map(c => ({month: c.definition.month, fixedChargeTripId: c.definition.fixedChargeTripId, contractTerm: c.definition.contractTerm, billingUnit: c.definition.billingUnit})),
      approval: 'PENDING' as const};
  });
  const body = {kind: 'BILLING_MAPPING_REVIEW_PROPOSALS' as const, version: 1, importEnabled: false as const,
    sources: [...fingerprints].sort((a, b) => sort(a.kind, b.kind)).map(f => ({...f, ...(f.partitions ? {partitions: [...f.partitions].sort((a, b) => sort(a.fileName, b.fileName))} : {})})), from: input.from, through: input.through,
    scopeReviewSha256: hash(review), monthsWithoutSuppliedTrips: [...review.coverage.monthsWithoutSuppliedTrips],
    missingSoaPolicy: review.missingSoaPolicy, monthlyBilling: review.monthlyBilling,
    proposals, customerTasks,
    counts: {groups: proposals.length, candidateIdentityConfirmations: proposals.filter(p => p.classification === 'CANDIDATE_IDENTITY_CONFIRMATION').length,
      sourceEvidenceRequired: proposals.filter(p => p.classification === 'SOURCE_EVIDENCE_REQUIRED').length, customerTasks: customerTasks.length,
      retainedPartialReferences: proposals.filter(p => p.classification === 'PARTIAL_EXPORT_REFERENCE').length,
      noSoaTrips: review.tripsWithoutSoa.length},
    safeguards: ['No source row, document amount, status, membership or customer name is changed.',
      'Candidate identities require explicit review; matching names or totals do not approve a mapping.',
      'Confirmation is document-specific, never a global name alias or customer merge.',
      'Customer tax/workflow fields stay unresolved; recorded zero VAT never defaults a contract to Non-VAT.',
      'This artifact is evidence review only, not verified actor identity or execution authorization.']};
  return {...body, evidenceSha256: hash(body)};
}

export type BillingMappingPacket = ReturnType<typeof buildBillingMappingProposals>;
export type BillingMappingDecisions = {kind: 'BILLING_MAPPING_REVIEW_DECISIONS'; version: 1; evidenceSha256: string;
  items: {proposalId: string; decision: 'PENDING' | 'CONFIRM_CANDIDATE_IDENTITY' | 'KEEP_UNRESOLVED' | 'REJECT_CANDIDATE'; customerId: string | null; reviewerNote: string}[]};
export function initialBillingMappingDecisions(packet: BillingMappingPacket): BillingMappingDecisions {
  return {kind: 'BILLING_MAPPING_REVIEW_DECISIONS', version: 1, evidenceSha256: packet.evidenceSha256,
    items: packet.proposals.filter(p => p.classification !== 'PARTIAL_EXPORT_REFERENCE').map(p => ({proposalId: p.id, decision: 'PENDING', customerId: null, reviewerNote: ''}))};
}
export function validateBillingMappingDecisions(packet: BillingMappingPacket, decisions: BillingMappingDecisions) {
  const {evidenceSha256, ...body} = packet;
  if (hash(body) !== evidenceSha256 || decisions.kind !== 'BILLING_MAPPING_REVIEW_DECISIONS' || decisions.version !== 1 || decisions.evidenceSha256 !== evidenceSha256) throw new Error('Mapping decision evidence is stale or changed');
  return validateBillingDecisionEntries(packet, decisions);
}

/** Current review progress, never an import-readiness or authorization assessment. */
export function billingMappingReviewProgress(packet: BillingMappingPacket, decisions: BillingMappingDecisions) {
  const validated = validateBillingMappingDecisions(packet, decisions);
  const byId = new Map(decisions.items.map(d => [d.proposalId, d]));
  const actionable = packet.proposals.filter(p => p.classification !== 'PARTIAL_EXPORT_REFERENCE');
  const items = actionable.map(p => ({proposalId: p.id, sourceSoa: p.sourceSoa,
    classification: p.classification, decision: byId.get(p.id)!.decision,
    identityRecorded: byId.get(p.id)!.decision === 'CONFIRM_CANDIDATE_IDENTITY',
    sourceEvidenceStillRequired: p.classification === 'SOURCE_EVIDENCE_REQUIRED',
    issueCodes: p.reviewSteps.map(s => s.code)}));
  return {kind: 'BILLING_MAPPING_REVIEW_PROGRESS' as const, version: 1, ...validated,
    evidenceSha256: packet.evidenceSha256,
    counts: {actionable: items.length, pending: validated.pending,
      recordedIdentityConfirmations: validated.recordedIdentityConfirmations,
      keptUnresolved: items.filter(i => i.decision === 'KEEP_UNRESOLVED').length,
      rejectedCandidates: items.filter(i => i.decision === 'REJECT_CANDIDATE').length,
      sourceEvidenceStillRequired: items.filter(i => i.sourceEvidenceStillRequired).length,
      retainedPartialReferences: packet.proposals.length - actionable.length,
      customerContractReminders: packet.customerTasks.length}, items};
}
