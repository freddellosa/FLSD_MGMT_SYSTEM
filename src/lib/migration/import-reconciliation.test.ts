import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {reconcileImportSnapshots, type ImportComparisonSnapshot} from './import-reconciliation';
import {reviewLegacyIdentityMappings} from './legacy-identity-review';
import {buildSixTableExceptionWorklist} from './six-table-exception-worklist';
import type {prepareSixTableTargetCandidates} from './six-table-target-candidates';
import type {OfflineCandidate} from './reconciliation';
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function fixture(options: {policy?: boolean; sourceCase?: boolean; newIdentity?: boolean} = {}) {
  const records: OfflineCandidate[] = ['0001', '0002'].map(key => ({identity: {namespace: 'QA', kind: 'Trips_Tbl', key}, evidenceHash: hash(key),
    fields: {customerSourceKey: '47', soaSourceKey: 'S01', sourceStatus: 'Paid'}, money: {base: 10000n, ot: 1n, gross: 10001n}, pending: []}));
  const prepared: ReturnType<typeof prepareSixTableTargetCandidates> = {kind: 'SIX_TABLE_TARGET_CANDIDATES', version: 1, importEnabled: false, executionAuthorized: false,
    releaseState: 'BLOCKED_PENDING_REVIEW_AND_DATABASE_AUTHORIZATION', sourcePlanSha256: hash('source-plan'), mappingSha256: hash('mapping'), evidenceSha256: hash('candidates'),
    counts: {rows: 2, candidates: 0, quarantined: 2}, limitations: [], candidates: records.map((record, i) => ({source: {namespace: 'QA', table: 'Trips_Tbl', sourceKey: record.identity.key,
      fileId: 'synthetic-trips.csv', row: i + 2, fileSha256: hash('synthetic-file'), evidenceSha256: record.evidenceHash}, state: 'QUARANTINED',
      issues: [...(options.policy ? [{field: null, code: 'FINANCIAL_RELATIONSHIP_STATUS_POLICY_REVIEW'}] : []), ...(options.sourceCase && i === 0 ? [{field: 'DateOfTrip_End', code: 'SERVICE_END_BEFORE_START'}] : [])],
      fields: [], sourceReferences: [], sourceEvidence: {DateOfTrip_Start: '9/1/2026 14:00:00', DateOfTrip_End: '9/1/2026 13:00:00'}}))};
  const identityCandidates = records.map(r => ({identity: {...r.identity, kind: 'Trips_Tbl' as const}, evidenceSha256: r.evidenceHash, mappingSha256: prepared.mappingSha256}));
  const identityReview = reviewLegacyIdentityMappings({destinationId: 'SYNTHETIC', authorityVersion: 'PROPOSED-V1', registryRevision: '1',
    mappings: options.newIdentity ? [] : identityCandidates.map((c, i) => ({...c, entityId: 'existing-' + i, entityVersion: '1'}))}, identityCandidates);
  const worklist = buildSixTableExceptionWorklist(prepared);
  const source: ImportComparisonSnapshot = {binding: {sourcePlanSha256: prepared.sourcePlanSha256, mappingSha256: prepared.mappingSha256,
    candidateEvidenceSha256: prepared.evidenceSha256, worklistSha256: worklist.evidenceSha256, identityReviewSha256: identityReview.evidenceSha256,
    registrySha256: identityReview.registrySha256, destinationId: 'SYNTHETIC', authorityVersion: 'PROPOSED-V1', destinationRevision: '9007199254740993', namespace: 'QA',
    serviceFrom: '2026-09-01', serviceThrough: '2026-10-31', retainMissingSoaReferences: true}, records};
  const destination = structuredClone(source);
  return {source, destination, identityReview, worklist, run: () => reconcileImportSnapshots(source, destination, identityReview, worklist)};
}
describe('bound offline import reconciliation', () => {
  it('reports evidence equality only, never authorization, with exact revision metadata', () => {
    const report = fixture().run();
    expect(report).toMatchObject({reviewStatus: 'EVIDENCE_MATCH_ONLY', importEnabled: false, executionAuthorized: false, comparison: {comparison: 'MATCH'}});
    expect(report.binding.destinationRevision).toBe('9007199254740993');
    expect(report.blockers).toEqual([]); expect(report.limitations.join(' ')).toContain('not destination evidence');
  });
  it('detects opposite per-record monetary errors even when aggregate totals match', () => {
    const f = fixture(); f.destination.records[0].money.base += 1n; f.destination.records[1].money.base -= 1n;
    const report = f.run();
    expect(report.comparison.totals.source).toEqual(report.comparison.totals.candidate);
    expect(report.comparison.differences).toHaveLength(2);
    expect(report.reviewStatus).toBe('REVIEW_REQUIRED');
  });
  it.each(['customerSourceKey', 'soaSourceKey', 'sourceStatus'])('compares %s independently of amounts', field => {
    const f = fixture(); f.destination.records[0].fields[field] = 'OTHER';
    expect(f.run().comparison.differences).toContainEqual(expect.objectContaining({field: 'fields.' + field}));
  });
  it('retains source cases and policy holds despite identical row values', () => {
    const f = fixture({policy: true, sourceCase: true}), report = f.run();
    expect(report.comparison.comparison).toBe('MATCH');
    expect(report.blockers).toEqual([{code: 'SOURCE_CASES_OPEN', count: 1}, {code: 'FINANCIAL_STATUS_POLICY_HELD_ROWS', count: 2}]);
  });
  it('preserves pending gates from either side and new identity review', () => {
    const f = fixture({newIdentity: true}); f.source.records[0].pending = ['TAX_BASIS']; f.destination.records[1].pending = ['HISTORY'];
    expect(f.run().blockers).toContainEqual({code: 'ROW_REVIEW_GATES', count: 2});
    expect(f.run().blockers).toContainEqual({code: 'NEW_OR_REVISED_IDENTITY_REVIEW', count: 2});
  });
  it('reports missing/unexpected destination identities rather than deleting or inventing rows', () => {
    const f = fixture(); f.destination.records = [f.destination.records[0], {...f.destination.records[1], identity: {...f.destination.records[1].identity, key: '9999'}}];
    const report = f.run(); expect(report.comparison.missing).toHaveLength(1); expect(report.comparison.unexpected).toHaveLength(1);
    expect(report).not.toHaveProperty('inserts'); expect(report).not.toHaveProperty('deletes');
  });
  it.each(['mappingSha256', 'destinationId', 'destinationRevision', 'serviceThrough', 'retainMissingSoaReferences'] as const)('rejects mismatched comparison binding %s', field => {
    const f = fixture();
    if (field === 'retainMissingSoaReferences') f.destination.binding[field] = false;
    else if (field === 'serviceThrough') f.destination.binding[field] = '2026-11-30';
    else if (field === 'destinationRevision') f.destination.binding[field] = '9007199254740994';
    else f.destination.binding[field] = field === 'mappingSha256' ? hash('other-map') : 'OTHER';
    expect(() => f.run()).toThrow('bindings differ');
  });
  it('rejects modified sealed worklist and identity-review content', () => {
    const f = fixture(); f.worklist.counts.policyHeldRows = 0; f.worklist.independentReviews = [];
    expect(() => f.run()).toThrow('content changed');
    const other = fixture(); other.identityReview.rows[0].existingEntityId = 'forged';
    expect(() => other.run()).toThrow('content changed');
  });
  it('requires identity-review source hash coverage, not just matching aggregate counts', () => {
    const f = fixture(); f.source.records[0].evidenceHash = hash('changed-row');
    expect(() => f.run()).toThrow('exact source rows');
  });
  it('rejects a stale expected candidate/worklist fingerprint even if both comparison labels match', () => {
    const f = fixture(); f.source.binding.candidateEvidenceSha256 = hash('other-candidates'); f.destination.binding.candidateEvidenceSha256 = f.source.binding.candidateEvidenceSha256;
    expect(() => f.run()).toThrow('Stale or unrelated');
  });
  it('keeps null versus absent fields and zero versus missing money distinct', () => {
    const f = fixture(); f.source.records[0].fields.optional = null; f.source.records[0].money.fuel = 0n;
    expect(f.run().comparison.differences.map(d => d.field)).toEqual(expect.arrayContaining(['fields.optional:CANDIDATE_ABSENT', 'money.fuel:CANDIDATE_ABSENT']));
  });
  it('does not mutate snapshots and binds the resulting per-record report digest', () => {
    const f = fixture(), before = structuredClone(f.source), first = f.run();
    expect(f.source).toEqual(before); f.destination.records[0].money.gross += 1n;
    expect(f.run().evidenceSha256).not.toBe(first.evidenceSha256);
  });
});
