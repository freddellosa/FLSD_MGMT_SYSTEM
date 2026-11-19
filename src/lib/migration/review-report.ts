import {canonicalReviewJson} from './canonical-review-json';
export {canonicalReviewJson} from './canonical-review-json';
/** Review artifacts only. No raw CSV cells, posting commands or business approvals. */
import {createHash} from 'node:crypto';
import {fromCentavos} from '../domain/billing';
import {reviewRelatedCsvBytes, type CsvReviewFile} from './csv-review';
import type {OfflineManifest} from './manifest';
import type {ReviewGate, SourceIdentity} from './reconciliation';
import type {RelationshipRule} from './relationships';

export type CsvReviewRequest = {manifest: OfflineManifest; files: readonly CsvReviewFile[]; rules: readonly RelationshipRule[]};
export type ReviewLocator = {fileId: string; row: number};
export type ReviewReport = {
  version: 1;
  importEnabled: false;
  structuralStatus: 'REVIEWED' | 'REVIEW' | 'REJECTED';
  policyStatus: 'PENDING' | 'NOT_ASSESSED';
  provenance: {manifestId: string; manifestFingerprint: string; reviewFingerprint: string; relationshipFingerprint: string};
  coverage: OfflineManifest['coverage'];
  counts: {sourceRows: number; candidateRows: number; rejectedRows: number; pendingRows: number};
  /** Partial sums are explicitly marked and cannot be mistaken for source totals. */
  totals: {scope: 'ALL_PARSED_CANDIDATES' | 'ACCEPTED_CANDIDATES_ONLY'; values: Record<string, string>};
  records: {identity: SourceIdentity; locator: ReviewLocator; serviceDate?: string; money: Record<string, string>; pending: ReviewGate[]}[];
  exceptions: {locator: ReviewLocator; code: string; column: string}[];
  relationships: null | {
    counts: {ruleId: string; checked: number; matched: number; optionalUnassigned: number}[];
    uncheckedRules: string[];
    issues: {ruleId: string; code: string; identity: SourceIdentity; locator: ReviewLocator; target: SourceIdentity | null; targetLocator: ReviewLocator | null}[];
  };
  limitations: string[];
};
const idKey = (id: SourceIdentity) => JSON.stringify([id.namespace, id.kind, id.key]);
const copy = <T>(value: T): T => structuredClone(value);

export function buildReviewReport(request: CsvReviewRequest): ReviewReport {
  const {manifest, files, rules} = request;
  const result = reviewRelatedCsvBytes(manifest, files, rules);
  const locations = new Map(result.records.map(r => [idKey(r.candidate.identity), {fileId: r.fileId, row: r.row}]));
  const totals = new Map<string, bigint>();
  for (const row of result.records) for (const [name, amount] of Object.entries(row.candidate.money)) totals.set(name, (totals.get(name) ?? 0n) + amount);
  const report: ReviewReport = {
    version: 1, importEnabled: false, structuralStatus: result.status,
    policyStatus: result.records.length ? 'PENDING' : 'NOT_ASSESSED',
    provenance: {manifestId: manifest.id, manifestFingerprint: result.fingerprint, reviewFingerprint: result.reviewFingerprint, relationshipFingerprint: result.relationshipFingerprint},
    coverage: copy(manifest.coverage),
    counts: {sourceRows: result.sourceRows, candidateRows: result.records.length,
      rejectedRows: new Set(result.exceptions.map(e => JSON.stringify([e.fileId, e.row]))).size,
      pendingRows: result.records.filter(r => r.candidate.pending.length).length},
    totals: {scope: result.exceptions.length ? 'ACCEPTED_CANDIDATES_ONLY' : 'ALL_PARSED_CANDIDATES',
      values: Object.fromEntries([...totals].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, amount]) => [name, fromCentavos(amount)]))},
    records: result.records.map(r => ({identity: copy(r.candidate.identity), locator: {fileId: r.fileId, row: r.row},
      ...(r.serviceDate === undefined ? {} : {serviceDate: r.serviceDate}),
      money: Object.fromEntries(Object.entries(r.candidate.money).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([name, amount]) => [name, fromCentavos(amount)])),
      pending: [...r.candidate.pending].sort()})),
    exceptions: result.exceptions.map(e => ({locator: {fileId: e.fileId, row: e.row}, code: e.code, column: e.column})),
    relationships: result.relationships ? {counts: copy(result.relationships.counts), uncheckedRules: [...result.relationships.uncheckedRules],
      issues: result.relationships.issues.map(i => ({ruleId: i.ruleId, code: i.code, identity: copy(i.identity),
        locator: copy(locations.get(idKey(i.identity))!), target: copy(i.target), targetLocator: i.target ? copy(locations.get(idKey(i.target)) ?? null) : null}))} : null,
    limitations: ['Offline structural review only; no import or posting authorization.',
      'All financial and contract decisions remain pending; no paid balances are inferred.',
      'Coverage and relationship rules describe supplied evidence, not independently proven full history.',
      'Row locators are logical nonblank CSV records, not physical text lines.',
      'Raw cell values and unselected source fields are omitted; source identities remain private review data.'],
  };
  return report;
}

/** Stable JSON ignores object property insertion order; array order remains evidence. */
export type ReviewEnvelope = {kind: 'FLSD_OFFLINE_REVIEW'; version: 1; sha256: string; report: ReviewReport};
export function sealReviewReport(report: ReviewReport): ReviewEnvelope {
  if (report.version !== 1 || report.importEnabled !== false) throw new Error('Expected disabled offline review report');
  return {kind: 'FLSD_OFFLINE_REVIEW', version: 1,
    sha256: createHash('sha256').update(canonicalReviewJson(report)).digest('hex'), report: copy(report)};
}
/** Integrity check only. Unkeyed SHA-256 does not establish authorship or financial approval. */
export function assertReviewIntegrity(envelope: ReviewEnvelope) {
  if (envelope.kind !== 'FLSD_OFFLINE_REVIEW' || envelope.version !== 1 || envelope.report.version !== 1 || envelope.report.importEnabled !== false ||
      envelope.sha256 !== createHash('sha256').update(canonicalReviewJson(envelope.report)).digest('hex')) throw new Error('Review artifact integrity mismatch');
}
