/** Source-backed, non-executable import graph. No filesystem, DB, target IDs or business approvals. */
import {createHash} from 'node:crypto';
import {canonicalReviewJson} from './canonical-review-json';
import {stageSixTableCsv, sixTableSchemas, type SixTableKind} from './six-table-contract';
import {reviewRelationships, type RelationshipRule} from './relationships';
import type {OfflineCandidate} from './reconciliation';
import {parseLegacyDate} from './trips';

export type SixTablePlanFile = {id: string; table: SixTableKind; bytes: Uint8Array};
export type SixTablePlanScope = {namespace: string; from: string; through: string; retainMissingSoaReferences: boolean};
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const key = (table: string, value: string) => JSON.stringify([table, value]);
const present = (value: string | undefined) => !!value?.trim() && !/^0+(?:\.0+)?$/.test(value.trim());
const rules: RelationshipRule[] = [
  {id: 'trip-customer', sourceKind: 'Trips_Tbl', field: 'CompanyID', targetKind: 'company_tbl', required: true},
  {id: 'trip-vehicle', sourceKind: 'Trips_Tbl', field: 'VehicleID', targetKind: 'vehicle_tbl', required: true},
  {id: 'trip-driver', sourceKind: 'Trips_Tbl', field: 'DriverID', targetKind: 'Driver_tbl', required: true},
  {id: 'trip-soa', sourceKind: 'Trips_Tbl', field: 'SOANo', targetKind: 'SOA_Tbl', required: false},
  {id: 'soa-invoice', sourceKind: 'SOA_Tbl', field: 'InvoiceNo', targetKind: 'Invoice_Tbl', required: false},
  {id: 'invoice-soa', sourceKind: 'Invoice_Tbl', field: 'SOANo', targetKind: 'SOA_Tbl', required: false},
];
function iso(value: string) {return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;}

export function buildSixTableImportPlan(files: readonly SixTablePlanFile[], scope: SixTablePlanScope) {
  if (!scope.namespace?.trim() || scope.namespace.length > 100 || !iso(scope.from) || !iso(scope.through) || scope.from > scope.through || typeof scope.retainMissingSoaReferences !== 'boolean') throw new Error('Explicit source namespace, service window and partial-export policy required');
  if (!files.length || files.length > 64 || new Set(files.map(f => f.id)).size !== files.length) throw new Error('Unique bounded source file identities required');
  let bytes = 0, rowCount = 0;
  const sources = [...files].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).map(file => {
    if (!file.id.trim() || file.id.length > 200 || /[/\\]/.test(file.id) || !Object.hasOwn(sixTableSchemas, file.table) || !(file.bytes instanceof Uint8Array)) throw new Error('Valid local source file identity/table/bytes required');
    bytes += file.bytes.byteLength;
    if (file.bytes.byteLength > 30 * 1024 * 1024 || bytes > 60 * 1024 * 1024) throw new Error('Combined source byte bound exceeded');
    const text = new TextDecoder('utf-8', {fatal: true}).decode(file.bytes);
    if (text.includes('\0')) throw new Error('NUL source text requires review');
    const staging = stageSixTableCsv(file.table, text); rowCount += staging.rows.length;
    if (rowCount > 200000) throw new Error('Combined source row bound exceeded');
    return {id: file.id, table: file.table, sha256: hash(file.bytes), staging};
  });
  const records = sources.flatMap(file => file.staging.rows.map(row => ({table: file.table, fileId: file.id, row: row.logicalRow,
    sourceKey: row.sourceKey, rowIssues: [...row.issues], payload: row.payload, evidenceSha256: hash(canonicalReviewJson(row.payload))})));
  const located = new Map<string, {fileId: string; row: number}[]>();
  for (const record of records) {
    const id = key(record.table, record.sourceKey), rows = located.get(id) ?? [];
    rows.push({fileId: record.fileId, row: record.row}); located.set(id, rows);
  }
  const tripScope = new Set<string>(), includedSoas = new Set<string>(), includedInvoices = new Set<string>();
  const dateIssues: {fileId: string; row: number; sourceKey: string; code: 'INVALID_SERVICE_DATE'}[] = [];
  for (const r of records.filter(r => r.table === 'Trips_Tbl')) {
    const day = parseLegacyDate(r.payload.DateOfTrip_Start)?.toISOString().slice(0, 10);
    if (!day) dateIssues.push({fileId: r.fileId, row: r.row, sourceKey: r.sourceKey, code: 'INVALID_SERVICE_DATE'});
    else if (day >= scope.from && day <= scope.through) {tripScope.add(r.sourceKey); if (present(r.payload.SOANo)) includedSoas.add(r.payload.SOANo);}
  }
  for (const r of records.filter(r => r.table === 'SOA_Tbl' && includedSoas.has(r.sourceKey))) if (present(r.payload.InvoiceNo)) includedInvoices.add(r.payload.InvoiceNo);
  for (const r of records.filter(r => r.table === 'Invoice_Tbl' && includedSoas.has(r.payload.SOANo))) includedInvoices.add(r.sourceKey);
  const inScope = (table: string, sourceKey: string) => table === 'Trips_Tbl' ? tripScope.has(sourceKey) : table === 'SOA_Tbl' ? includedSoas.has(sourceKey) : table === 'Invoice_Tbl' ? includedInvoices.has(sourceKey) : true;
  const candidates: OfflineCandidate[] = records.filter(r => !!r.sourceKey.trim()).map(r => ({identity: {namespace: scope.namespace, kind: r.table, key: r.sourceKey},
    evidenceHash: r.evidenceSha256, money: {}, pending: ['HISTORY'],
    fields: Object.fromEntries(rules.filter(rule => rule.sourceKind === r.table).map(rule => [rule.field, present(r.payload[rule.field]) ? r.payload[rule.field] : null]))}));
  const graph = candidates.length ? reviewRelationships(candidates, rules) : {issues: [], duplicates: [], counts: rules.map(r => ({ruleId: r.id, checked: 0, matched: 0, optionalUnassigned: 0})), uncheckedRules: rules.map(r => r.id)};
  const issues = graph.issues.map(issue => {
    const sourceInScope = inScope(issue.identity.kind, issue.identity.key);
    const referenceOnly = issue.code === 'ORPHAN' && issue.target?.kind === 'SOA_Tbl' && scope.retainMissingSoaReferences;
    return {ruleId: issue.ruleId, code: issue.code, sourceTable: issue.identity.kind, sourceKey: issue.identity.key,
      sourceLocations: located.get(key(issue.identity.kind, issue.identity.key)) ?? [], target: issue.target ? {table: issue.target.kind, sourceKey: issue.target.key} : null,
      targetLocations: issue.target ? located.get(key(issue.target.kind, issue.target.key)) ?? [] : [],
      scope: sourceInScope ? 'IN_SCOPE' as const : 'OTHER_SUPPLIED_HISTORY' as const,
      disposition: referenceOnly ? 'RETAIN_REFERENCE' as const : sourceInScope ? 'REVIEW' as const : 'OUTSIDE_KNOWN_TRIP_LINKS' as const};
  });
  const duplicates = graph.duplicates.map(d => ({table: d.identity.kind, sourceKey: d.identity.key, count: d.count,
    locations: located.get(key(d.identity.kind, d.identity.key)) ?? []}));
  const invoiceRows = new Map<string, typeof records>();
  for (const r of records.filter(r => r.table === 'Invoice_Tbl')) {const entries = invoiceRows.get(r.sourceKey) ?? []; entries.push(r); invoiceRows.set(r.sourceKey, entries);}
  const documentLinkIssues = records.filter(r => r.table === 'SOA_Tbl' && present(r.payload.InvoiceNo)).flatMap(r => {
    const invoice = invoiceRows.get(r.payload.InvoiceNo);
    if (invoice?.length !== 1 || invoice[0].payload.SOANo === r.sourceKey) return [];
    return [{sourceSoa: r.sourceKey, sourceInvoice: r.payload.InvoiceNo, invoiceSoaReference: invoice[0].payload.SOANo,
      soaLocation: {fileId: r.fileId, row: r.row}, invoiceLocation: {fileId: invoice[0].fileId, row: invoice[0].row},
      code: present(invoice[0].payload.SOANo) ? 'REVERSE_DOCUMENT_LINK_MISMATCH' as const : 'REVERSE_DOCUMENT_LINK_UNASSIGNED' as const,
      disposition: inScope('SOA_Tbl', r.sourceKey) ? 'REVIEW' as const : 'OUTSIDE_KNOWN_TRIP_LINKS' as const}];
  });
  const missingTables = (Object.keys(sixTableSchemas) as SixTableKind[]).filter(table => !sources.some(s => s.table === table));
  const scopedMissingSoas = [...new Set(issues.filter(i => i.disposition === 'RETAIN_REFERENCE' && inScope(i.sourceTable, i.sourceKey)).map(i => i.target!.sourceKey))].sort();
  const recordIssues = records.filter(r => r.rowIssues.length).map(r => ({table: r.table, fileId: r.fileId, row: r.row, sourceKey: r.sourceKey, codes: r.rowIssues}));
  const headerReviewFiles = sources.filter(s => s.staging.structuralStatus === 'REVIEW').map(s => s.id);
  const body = {kind: 'SIX_TABLE_IMPORT_PLAN' as const, version: 1, importEnabled: false as const, executionAuthorized: false as const,
    sourceNamespace: scope.namespace, serviceWindow: {from: scope.from, through: scope.through}, partialExportReferencesRetained: scope.retainMissingSoaReferences,
    schemaSha256: hash(canonicalReviewJson(sixTableSchemas)),
    files: sources.map(s => ({id: s.id, table: s.table, sha256: s.sha256, rows: s.staging.rows.length,
      excludedHeaders: s.staging.excludedHeaders, unknownHeaders: s.staging.unknownHeaders, missingOptional: s.staging.missingOptional})),
    counts: {sourceRows: records.length, includedTrips: tripScope.size, reviewIssues: issues.filter(i => i.disposition === 'REVIEW').length + documentLinkIssues.filter(i => i.disposition === 'REVIEW').length,
      retainedMissingSoaKeys: scopedMissingSoas.length, contextIssues: issues.filter(i => i.disposition === 'OUTSIDE_KNOWN_TRIP_LINKS').length + documentLinkIssues.filter(i => i.disposition === 'OUTSIDE_KNOWN_TRIP_LINKS').length,
      duplicateIdentities: duplicates.length, recordsWithKeyIssues: recordIssues.length, invalidServiceDates: dateIssues.length},
    structuralStatus: missingTables.length || headerReviewFiles.length || duplicates.length || recordIssues.length || dateIssues.length || graph.uncheckedRules.length || issues.some(i => i.disposition === 'REVIEW') || documentLinkIssues.some(i => i.disposition === 'REVIEW') ? 'REVIEW' as const : 'CHECKED' as const,
    missingTables, headerReviewFiles, uncheckedRules: graph.uncheckedRules, relationshipCounts: graph.counts, issues, documentLinkIssues, duplicates, recordIssues, dateIssues,
    retainedMissingSoaKeys: scopedMissingSoas,
    records: records.map(r => ({table: r.table, sourceKey: r.sourceKey, fileId: r.fileId, row: r.row, evidenceSha256: r.evidenceSha256})),
    limitations: ['Source identity/relationship planning only; no application IDs, inserts, corrections or approvals are generated.',
      'Financial amounts, customer-name ownership, cancelled/replacement invoice semantics, tax and opening receivables remain in their separate reviewed evidence.',
      'Outside known trip links is context, not permission to discard records. Missing parents never create placeholders.',
      'Paid source labels never create receipts, allocations or custody balances. No payroll or source display-name values are included in this plan.',
      'Checksums are change evidence, not authenticated approval. Matching structural links cannot establish production readiness.']};
  return {...body, evidenceSha256: hash(canonicalReviewJson(body))};
}
export type SixTableImportPlan = ReturnType<typeof buildSixTableImportPlan>;
