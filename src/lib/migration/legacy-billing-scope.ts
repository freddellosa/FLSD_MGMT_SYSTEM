/** Offline Access relationship evidence only. Never creates documents, receipts or allocations. */
import {fromCentavos} from '../domain/billing';
import {accessMoney, type AccessRow} from './access-staging';
import {parseLegacyDate} from './trips';
import type {TripSourceLocation} from './trip-partitions';
import {reviewMonthlyBilling, type MonthlyBillingDefinition} from './monthly-billing';

export type LegacyBillingInput = {trips: AccessRow[]; tripLocations?: TripSourceLocation[]; customers: AccessRow[]; soas: AccessRow[]; invoices: AccessRow[]; from: string; through: string;retainMissingSoaReferences?:boolean;monthlyBilling?:MonthlyBillingDefinition[]};
export type LegacyStatusEvidence = {sourceStatus: string; payment: 'PAID_AS_RECORDED' | 'NOT_ESTABLISHED'; document: 'CANCELLED_AS_RECORDED' | 'NOT_ESTABLISHED'};
export function legacyStatusEvidence(sourceStatus: string): LegacyStatusEvidence {
  if (typeof sourceStatus !== 'string' || sourceStatus.length > 200) throw new Error('Invalid source status');
  const key = sourceStatus.trim().toLowerCase();
  return {sourceStatus, payment: key === 'paid' ? 'PAID_AS_RECORDED' : 'NOT_ESTABLISHED',
    document: ['cancel', 'cancelled', 'canceled'].includes(key) ? 'CANCELLED_AS_RECORDED' : 'NOT_ESTABLISHED'};
}
const day = (value: string) => parseLegacyDate(value)?.toISOString().slice(0, 10) ?? null;
const present = (value: string | undefined) => !!value?.trim() && !/^0+(?:\.0+)?$/.test(value.trim());
const sort = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function indexed(rows: AccessRow[], column: string, label: string) {
  const index = new Map<string, {row: AccessRow; locator: number}>();
  rows.forEach((row, i) => {
    const key = row[column];
    if (!key?.trim()) throw new Error('Missing ' + label + ' identity');
    if (index.has(key)) throw new Error('Duplicate ' + label + ' identity');
    index.set(key, {row, locator: i + 2});
  });
  return index;
}
function amount(value: string | undefined): bigint | null {
  if (!value?.trim()) return null;
  try { return accessMoney(value); } catch { return null; }
}
export function scopeLegacyBilling(input: LegacyBillingInput) {
  const {trips, customers, soas, invoices, from, through} = input;
  if (day(from) !== from || day(through) !== through || from > through) throw new Error('Explicit ISO service-date window required');
  if (!trips.length) throw new Error('Trip source coverage is empty');
  if ([trips, customers, soas, invoices].some(rows => rows.length > 100000)) throw new Error('Offline source row limit exceeded');
  indexed(trips, 'tmpInvoiceNo', 'trip');
  const customerIndex = indexed(customers, 'CompanyID', 'customer'), soaIndex = indexed(soas, 'SOANo', 'SOA'), invoiceIndex = indexed(invoices, 'InvoiceNo', 'invoice');
  const within = (value: string | null) => value !== null && value >= from && value <= through;
  if (input.tripLocations && (input.tripLocations.length !== trips.length || new Set(input.tripLocations.map(l => JSON.stringify([l.fileName, l.row]))).size !== trips.length ||
      input.tripLocations.some(l => !l.fileName.trim() || /[/\\]/.test(l.fileName) || !Number.isSafeInteger(l.row) || l.row < 2))) throw new Error('Invalid trip source locations');
  const datedTrips = trips.map((row, i) => ({row, locator: input.tripLocations?.[i].row ?? i + 2, fileName: input.tripLocations?.[i].fileName ?? 'Trips_Tbl.csv', date: day(row.DateOfTrip_Start)}));
  const included = datedTrips.filter(t => within(t.date));
  const monthCounts = new Map<string, number>();
  included.forEach(t => { const m = t.date!.slice(0, 7); monthCounts.set(m, (monthCounts.get(m) ?? 0) + 1); });
  const months: string[] = [];
  for (let month = from.slice(0, 7); month <= through.slice(0, 7);) {
    months.push(month); const [year, value] = month.split('-').map(Number);
    month = value === 12 ? (year + 1) + '-01' : year + '-' + String(value + 1).padStart(2, '0');
  }
  const scopedKeys = new Set(included.map(t => t.row.SOANo).filter(present));
  const groupTrips = (rows: typeof datedTrips) => {
    const result = new Map<string, typeof datedTrips>();
    for (const entry of rows) { const group = result.get(entry.row.SOANo) ?? []; group.push(entry); result.set(entry.row.SOANo, group); }
    return result;
  };
  const includedTripGroups = groupTrips(included), allTripGroups = groupTrips(datedTrips);
  const invoiceGroups = new Map<string, {row: AccessRow; locator: number}[]>();
  invoices.forEach((row, i) => { const group = invoiceGroups.get(row.SOANo) ?? []; group.push({row, locator: i + 2}); invoiceGroups.set(row.SOANo, group); });
  const groups = [...scopedKeys].sort(sort).map(sourceSoa => {
    const members = includedTripGroups.get(sourceSoa)!;
    const allMembers = allTripGroups.get(sourceSoa)!;
    const source = soaIndex.get(sourceSoa), candidates = invoiceGroups.get(sourceSoa) ?? [];
    const issues: string[] = [];
    const customerIds = [...new Set(members.map(t => t.row.CompanyID))].sort(sort);
    if (customerIds.length !== 1) issues.push('MULTIPLE_TRIP_CUSTOMERS');
    const customer = customerIds.length === 1 ? customerIndex.get(customerIds[0])?.row : undefined;
    if (!customer) issues.push('CUSTOMER_ID_UNRESOLVED');
    if (!source) issues.push('SOA_NOT_SUPPLIED');
    if (source && customer && source.row.ChargeTo !== customer.CompanyName) issues.push('SOA_CUSTOMER_LABEL_DIFFERENCE');
    const nonCancelled = candidates.filter(c => legacyStatusEvidence(c.row.Status).document !== 'CANCELLED_AS_RECORDED');
    if (nonCancelled.length > 1) issues.push('MULTIPLE_NON_CANCELLED_INVOICE_ROWS');
    if (source && legacyStatusEvidence(source.row.Status).document === 'CANCELLED_AS_RECORDED') issues.push('SOA_MARKED_CANCELLED');
    const reference = source && present(source.row.InvoiceNo) ? invoiceIndex.get(source.row.InvoiceNo) : undefined;
    if (!source || !present(source.row.InvoiceNo)) issues.push('SOA_INVOICE_REFERENCE_UNASSIGNED');
    else if (!reference) issues.push('REFERENCED_INVOICE_NOT_SUPPLIED');
    if (reference && reference.row.SOANo !== sourceSoa) issues.push('REVERSE_SOA_LINK_DIFFERENCE');
    if (reference && customer && reference.row.ChargeTo !== customer.CompanyName) issues.push('INVOICE_CUSTOMER_LABEL_DIFFERENCE');
    if (reference && legacyStatusEvidence(reference.row.Status).document === 'CANCELLED_AS_RECORDED') issues.push('REFERENCED_INVOICE_MARKED_CANCELLED');
    const components = members.map(t => amount(t.row.InvoiceTotAmt));
    const tripGross = components.some(v => v === null) ? null : components.reduce<bigint>((n, v) => n + v!, 0n);
    if (tripGross === null) issues.push('TRIP_GROSS_UNRESOLVED');
    const invoiceGross = reference ? amount(reference.row.InvoiceTotAmt) : null;
    if (reference && invoiceGross === null) issues.push('INVOICE_GROSS_UNRESOLVED');
    const partial = allMembers.length !== members.length;
    let comparison: 'MATCH' | 'DIFFERENT' | 'PARTIAL_SOURCE_GROUP' | 'NOT_COMPARED' = 'NOT_COMPARED';
    if (partial) { comparison = 'PARTIAL_SOURCE_GROUP'; issues.push('PARTIAL_SOURCE_TRIP_GROUP'); }
    else if (tripGross !== null && invoiceGross !== null) {
      comparison = tripGross === invoiceGross ? 'MATCH' : 'DIFFERENT';
      if (comparison === 'DIFFERENT') issues.push('TRIP_INVOICE_GROSS_DIFFERENCE');
    }
    const invoiceEvidence = (entry: {row: AccessRow; locator: number}) => ({sourceInvoice: entry.row.InvoiceNo, row: entry.locator,
      status: legacyStatusEvidence(entry.row.Status), serviceDate: day(entry.row.DateOfTrip_Start),
      serviceDateInWindow: within(day(entry.row.DateOfTrip_Start)), sourceSoa: entry.row.SOANo});
    const deferred = !source && input.retainMissingSoaReferences === true;
    const requiredIssues = issues.filter(i => !deferred || !['SOA_NOT_SUPPLIED', 'SOA_INVOICE_REFERENCE_UNASSIGNED'].includes(i));
    return {sourceSoa, soaRow: source?.locator ?? null, customerIds, tripRows: members.map(t => ({sourceTrip: t.row.tmpInvoiceNo, row: t.locator, fileName: t.fileName})),
      suppliedTripMembersOutsideWindow: allMembers.length - members.length,
      sourceSoaStatus: source ? legacyStatusEvidence(source.row.Status) : null,
      referencedInvoice: reference ? invoiceEvidence(reference) : null, invoices: candidates.map(invoiceEvidence),
      monetaryEvidence: {tripGross: tripGross === null ? null : fromCentavos(tripGross), invoiceGross: invoiceGross === null ? null : fromCentavos(invoiceGross), comparison},
      status: requiredIssues.length ? 'REVIEW' as const : deferred ? 'REFERENCE_ONLY' as const : 'EVIDENCE_CONSISTENT' as const,
      issues: [...new Set(issues)].sort(sort), requiredIssues: [...new Set(requiredIssues)].sort(sort), sourceDocumentEvidenceComplete: !deferred && requiredIssues.length === 0,
      assignmentApproved: false as const};
  });
  const noSoa = included.filter(t => !present(t.row.SOANo)).map(t => ({sourceTrip: t.row.tmpInvoiceNo, row: t.locator, fileName: t.fileName, customerId: t.row.CompanyID, reason: 'NO_DOCUMENT_LINK_EVIDENCE'}));
  const unlinkedWindowInvoices = invoices.flatMap((row, i) => within(day(row.DateOfTrip_Start)) && !scopedKeys.has(row.SOANo)
    ? [{sourceInvoice: row.InvoiceNo, row: i + 2, sourceSoa: row.SOANo, status: legacyStatusEvidence(row.Status), reason: 'SERVICE_IN_WINDOW_WITHOUT_MATCHED_TRIP_GROUP'}] : []);
  return {kind: 'LEGACY_BILLING_SCOPE_REVIEW' as const, version: 1, importEnabled: false as const, from, through,
    missingSoaPolicy: input.retainMissingSoaReferences === true ? 'RETAIN_REFERENCE_ONLY' as const : 'REVIEW_MISSING_DOCUMENTS' as const,
    monthlyBilling: reviewMonthlyBilling(trips, input.monthlyBilling ?? []),
    policyStatus: 'CONTRACT_AND_WORKFLOW_REVIEW_REQUIRED' as const, receiptsCreated: 0, allocationsCreated: 0,
    coverage: {suppliedTrips: trips.length, includedTrips: included.length, outsideWindow: datedTrips.filter(t => t.date && !within(t.date)).length,
      invalidDateTripRows: datedTrips.filter(t => !t.date).map(t => ({sourceTrip: t.row.tmpInvoiceNo, row: t.locator, fileName: t.fileName})),
      months: months.map(month => ({month, suppliedTripRows: monthCounts.get(month) ?? 0})),
      monthsWithoutSuppliedTrips: months.filter(m => !monthCounts.has(m))},
    counts: {groups: groups.length, groupsRequiringReview: groups.filter(g => g.status === 'REVIEW').length,
      referenceOnlyGroups: groups.filter(g => g.status === 'REFERENCE_ONLY').length, tripsWithoutSoa: noSoa.length,
      supportingInvoiceRows: groups.reduce((n, g) => n + g.invoices.length, 0), unlinkedWindowInvoices: unlinkedWindowInvoices.length},
    groups, tripsWithoutSoa: noSoa, unlinkedWindowInvoices,
    limitations: ['Evidence matches are not approved document assignments or import eligibility.',
      'Equal totals cannot prove all historical trip members were supplied.',
      'Paid is retained as source status only; no payment amount, collection date or cash event is inferred.',
      'No-SOA trips are not automatically classified as direct or corporate.',
      'Documents linked to included trips are retained regardless of their own dates.',
      'Missing months mean no supplied rows, not proof of zero business activity.']};
}

export type PriorBillingDiagnostic = {code: string; sourceSoa?: string; sourceInvoice?: string; file?: string; row?: number; rows?: number[]};
/** Partition prior findings without declaring outside-cohort evidence safe to discard. */
export function triageBillingDiagnostics(review: ReturnType<typeof scopeLegacyBilling>, diagnostics: readonly PriorBillingDiagnostic[]) {
  const scopedKeys = new Set(review.groups.map(g => g.sourceSoa));
  const unlinkedKeys = new Set(review.unlinkedWindowInvoices.map(i => i.sourceSoa));
  const rows = diagnostics.map(d => ({...structuredClone(d),
    scope: d.sourceSoa && scopedKeys.has(d.sourceSoa) ? 'SHARES_INCLUDED_SOA_KEY' as const :
      d.sourceSoa && unlinkedKeys.has(d.sourceSoa) ? 'UNLINKED_SERVICE_WINDOW' as const : 'OUTSIDE_KNOWN_TRIP_LINKS' as const}));
  return {total: rows.length, counts: {
    sharesIncludedSoaKey: rows.filter(r => r.scope === 'SHARES_INCLUDED_SOA_KEY').length,
    unlinkedServiceWindow: rows.filter(r => r.scope === 'UNLINKED_SERVICE_WINDOW').length,
    outsideKnownTripLinks: rows.filter(r => r.scope === 'OUTSIDE_KNOWN_TRIP_LINKS').length,
  }, rows, outsideScopeIsNotApprovalToDiscard: true as const};
}
