/** Offline integration of existing review contracts. No DB reader, import writer, approval or activation. */
import {createHash} from 'node:crypto';
import {canonicalReviewJson} from './canonical-review-json';
import {reconcileOffline, type OfflineCandidate} from './reconciliation';
import type {reviewLegacyIdentityMappings} from './legacy-identity-review';
import type {SixTableExceptionWorklist} from './six-table-exception-worklist';

type IdentityReview = ReturnType<typeof reviewLegacyIdentityMappings>;
export type ImportComparisonBinding = {
  sourcePlanSha256: string; mappingSha256: string; candidateEvidenceSha256: string;
  worklistSha256: string; identityReviewSha256: string; registrySha256: string;
  destinationId: string; authorityVersion: string; destinationRevision: string;
  namespace: string; serviceFrom: string; serviceThrough: string; retainMissingSoaReferences: boolean;
  normalizationContractSha256?: string; normalizationCoverageSha256?: string;
};
export type ImportComparisonSnapshot = {binding: ImportComparisonBinding; records: readonly OfflineCandidate[]};
const hash = (value: unknown) => createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
const key = (identity: OfflineCandidate['identity']) => JSON.stringify([identity.namespace, identity.kind, identity.key]);
function checkSeal(report: {evidenceSha256: string}) {
  const {evidenceSha256, ...body} = report;
  if (hash(body) !== evidenceSha256) throw new Error('Review content changed; regenerate evidence');
}
export function validateImportComparisonBinding(binding: ImportComparisonBinding) {
  if ((binding.normalizationContractSha256 === undefined) !== (binding.normalizationCoverageSha256 === undefined) ||
    (binding.normalizationContractSha256 !== undefined && (!/^[a-f0-9]{64}$/.test(binding.normalizationContractSha256) || !/^[a-f0-9]{64}$/.test(binding.normalizationCoverageSha256!)))) throw new Error('Complete normalization contract/coverage fingerprints required');
  for (const field of ['sourcePlanSha256', 'mappingSha256', 'candidateEvidenceSha256', 'worklistSha256', 'identityReviewSha256', 'registrySha256'] as const) {
    if (!/^[a-f0-9]{64}$/.test(binding[field])) throw new Error('Complete review fingerprints required');
  }
  for (const text of [binding.destinationId, binding.authorityVersion, binding.namespace]) if (typeof text !== 'string' || !text.trim() || text !== text.trim() || text.length > 200) throw new Error('Explicit bounded comparison scope required');
  const day = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value + 'T00:00:00Z')) && new Date(value + 'T00:00:00Z').toISOString().slice(0, 10) === value;
  if (!day(binding.serviceFrom) || !day(binding.serviceThrough) || binding.serviceFrom > binding.serviceThrough || typeof binding.retainMissingSoaReferences !== 'boolean' ||
    !/^(?:0|[1-9]\d{0,18})$/.test(binding.destinationRevision) || BigInt(binding.destinationRevision) > 9223372036854775807n) throw new Error('Explicit service window, partial-export policy and exact destination revision required');
}

export function reconcileImportSnapshots(source: ImportComparisonSnapshot, destination: ImportComparisonSnapshot, identityReview: IdentityReview, worklist: SixTableExceptionWorklist) {
  validateImportComparisonBinding(source.binding); validateImportComparisonBinding(destination.binding); checkSeal(identityReview); checkSeal(worklist);
  const b = source.binding;
  if (canonicalReviewJson(b) !== canonicalReviewJson(destination.binding)) throw new Error('Comparison bindings differ; do not compare different scopes or evidence versions');
  if (identityReview.evidenceSha256 !== b.identityReviewSha256 || identityReview.registrySha256 !== b.registrySha256 || identityReview.destinationId !== b.destinationId || identityReview.authorityVersion !== b.authorityVersion ||
    worklist.evidenceSha256 !== b.worklistSha256 || worklist.sourcePlanSha256 !== b.sourcePlanSha256 || worklist.mappingSha256 !== b.mappingSha256 || worklist.candidateEvidenceSha256 !== b.candidateEvidenceSha256) throw new Error('Stale or unrelated identity/worklist evidence');
  if (source.records.length > 200000 || destination.records.length > 200000) throw new Error('Bounded comparison coverage required');
  // Existing primitive validates unique identities, precise money and field/pending-gate shape.
  const comparison = reconcileOffline(source.records, destination.records);
  const sourceIndex = new Map(source.records.map(r => [key(r.identity), r]));
  if (identityReview.rows.length !== sourceIndex.size) throw new Error('Identity review coverage differs from source');
  const reviewed = new Set<string>();
  for (const row of identityReview.rows) {
    const id = key(row.identity), record = sourceIndex.get(id);
    if (!record || reviewed.has(id) || row.identity.namespace !== b.namespace || row.sourceEvidenceSha256 !== record.evidenceHash || row.mappingSha256 !== b.mappingSha256) throw new Error('Identity review is not bound to these exact source rows');
    reviewed.add(id);
  }
  for (const record of source.records) if (record.identity.namespace !== b.namespace) throw new Error('Source namespace differs from comparison scope');
  for (const item of worklist.cases) {
    const record = sourceIndex.get(key({namespace: item.source.namespace, kind: item.source.table, key: item.source.sourceKey}));
    if (!record || item.source.evidenceSha256 !== record.evidenceHash) throw new Error('Source case is not bound to compared row evidence');
  }
  // Hash binding proves content consistency only; none of these offline reports authenticates approval.
  const blockers: {code: string; count: number}[] = [];
  const add = (code: string, count: number) => {if (count > 0) blockers.push({code, count});};
  add('SOURCE_CASES_OPEN', worklist.cases.length);
  add('FINANCIAL_STATUS_POLICY_HELD_ROWS', worklist.counts.policyHeldRows);
  add('NEW_OR_REVISED_IDENTITY_REVIEW', identityReview.rows.filter(r => r.disposition !== 'UNCHANGED_SOURCE_IDENTITY').length);
  add('ROW_REVIEW_GATES', comparison.blocked.length);
  add('MISSING_DESTINATION_IDENTITIES', comparison.missing.length); add('UNEXPECTED_DESTINATION_IDENTITIES', comparison.unexpected.length);
  add('PER_RECORD_DIFFERENCES', comparison.differences.length);
  const body = {kind: 'IMPORT_RECONCILIATION' as const, version: 1, importEnabled: false as const, executionAuthorized: false as const,
    reviewStatus: blockers.length ? 'REVIEW_REQUIRED' as const : 'EVIDENCE_MATCH_ONLY' as const, binding: {...b}, blockers, comparison,
    limitations: ['Private offline comparison of supplied snapshots; no independently verified database read or source parsing is performed here.',
      'Fingerprints detect changed content, not forged approvals. Independent trusted adapters must establish origin and complete normalized field coverage.',
      'MATCH never clears financial/source gates, proves database concurrency/recovery, allocates IDs or authorizes import/posting.',
      'Destination records must independently resolve source identities, customer/membership/status and every exact component; comparing a candidate copy to itself is not destination evidence.',
      'Partial-export source references retain their agreed treatment; this comparison never invents parents, payments or deletion instructions.']};
  return {...body, evidenceSha256: hash(body)};
}
