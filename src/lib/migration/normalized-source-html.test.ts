import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {canonicalReviewJson} from './canonical-review-json';
import {renderNormalizedSourceReview, type SourceReviewHtmlInput} from './normalized-source-html';
const sha = 'a'.repeat(64), candidateSha = 'b'.repeat(64), mapSha = 'c'.repeat(64);
const hash = (value: unknown) => createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
function seal<T extends object>(body: T) {return {...body, evidenceSha256: hash(body)};}
function reseal<T extends {evidenceSha256: string}>(report: T) {report.evidenceSha256 = hash(Object.fromEntries(Object.entries(report).filter(([name]) => name !== 'evidenceSha256')));}
function fixture(): SourceReviewHtmlInput {
  const files = [{id: 'synthetic.csv', table: 'Trips_Tbl' as const, sha256: sha, rows: 1}];
  return {files, sourcePlanSha256: sha, candidateEvidenceSha256: candidateSha, retainedMissingSoaKeys: ['MISSING'],
    validation: seal({kind: 'NORMALIZED_SOURCE_VALIDATION', version: 'NS-1', status: 'SOURCE_SHAPE_CHECKED_DESTINATION_UNBOUND', importEnabled: false, executionAuthorized: false,
      contractSha256: sha, mappingSha256: mapSha, sourceSnapshotSha256: sha, coverageSha256: sha, fileInventorySha256: hash(files),
      serviceScope: {namespace: 'QA', from: '2026-09-01', through: '2026-10-31', retainMissingSoaReferences: true},
      counts: {rows: 1, quarantinedRows: 1, destinationUnboundRows: 1}, stateCounts: {VALUE: 3, UNKNOWN: 2}, gateCounts: {HISTORY: 1, SCHEDULE: 1}, limitations: []}),
    worklist: seal({kind: 'SIX_TABLE_EXCEPTION_WORKLIST', version: 1, importEnabled: false, executionAuthorized: false, sourcePlanSha256: sha, mappingSha256: mapSha, candidateEvidenceSha256: candidateSha,
      counts: {sourceCases: 1, affectedRows: 1, policyHeldRows: 1}, policyHolds: [{table: 'Trips_Tbl', rows: 1}], independentReviews: [],
      cases: [{caseId: sha, source: {namespace: 'QA', table: 'Trips_Tbl', sourceKey: '0001', fileId: 'synthetic.csv', row: 2, fileSha256: sha, evidenceSha256: sha},
        code: 'SERVICE_END_BEFORE_START', field: 'DateOfTrip_End', state: 'OPEN_SOURCE_REVIEW', guidance: 'Verify date; do not assume overnight rollover.',
        evidence: [{field: 'DateOfTrip_Start', present: true, value: '9/1/2026 19:00:00', valueWithheld: false}, {field: 'DateOfTrip_End', present: true, value: '9/1/2026 05:00:00', valueWithheld: false}]}]})};
}
describe('private static source-validation review', () => {
  it('shows source evidence, separate overlapping holds, file inventory and destination-unbound warning', () => {
    const input = fixture(), before = structuredClone(input), html = renderNormalizedSourceReview(input);
    expect(html).toContain('Historical source review'); expect(html).toContain('0001'); expect(html).toContain('9/1/2026 19:00:00');
    expect(html).toContain('Source file inventory'); expect(html).toContain('No import or financial clearance'); expect(html).toContain('Gate counts overlap');
    expect(html).toContain('missing SOA keys retained'); expect(input).toEqual(before);
  });
  it('escapes all source keys, selected evidence, filenames, notes and reference labels', () => {
    const input = fixture(), hostile = '<script>alert("x")</script><img src=x onerror=alert(1)>';
    input.files[0].id = hostile; input.worklist.cases[0].source.fileId = hostile; input.worklist.cases[0].source.sourceKey = hostile;
    input.worklist.cases[0].guidance = hostile; input.worklist.cases[0].evidence[0].value = hostile; input.retainedMissingSoaKeys = [hostile];
    input.validation.fileInventorySha256 = hash(input.files); reseal(input.validation); reseal(input.worklist);
    const html = renderNormalizedSourceReview(input);
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;'); expect(html).not.toMatch(/<script|<img/i);
  });
  it('includes a restrictive CSP and no scripts/forms/remote assets or executable action controls', () => {
    const html = renderNormalizedSourceReview(fixture());
    expect(html).toContain("default-src 'none'"); expect(html).toContain("connect-src 'none'");
    expect(html).not.toMatch(/<(script|form|iframe|img|link)\b/i); expect(html).not.toMatch(/https?:\/\//i);
    expect(html).not.toContain('<button'); expect(html).toContain('tabindex="0"');
  });
  it('rejects modified evidence and unrelated candidate/source metadata instead of producing a mixed report', () => {
    const changed = fixture(); changed.worklist.cases[0].guidance = 'Changed'; expect(() => renderNormalizedSourceReview(changed)).toThrow('artifact changed');
    const stale = fixture(); stale.candidateEvidenceSha256 = sha; expect(() => renderNormalizedSourceReview(stale)).toThrow('Mismatched');
    const inventory = fixture(); inventory.files[0].sha256 = 'd'.repeat(64); expect(() => renderNormalizedSourceReview(inventory)).toThrow('inventory differs');
  });
  it('rejects case/file mismatches and does not render unrelated payload fields', () => {
    const stale = fixture(); stale.worklist.cases[0].source.fileSha256 = 'd'.repeat(64); reseal(stale.worklist); expect(() => renderNormalizedSourceReview(stale)).toThrow('case does not match');
    const input = fixture(); (input.worklist as unknown as Record<string, unknown>).rawPayload = {name: 'PRIVATE PAYROLL CUSTOMER DETAIL'}; reseal(input.worklist);
    expect(renderNormalizedSourceReview(input)).not.toContain('PRIVATE PAYROLL CUSTOMER DETAIL');
  });
  it('keeps other gates explicit when no source cases remain', () => {
    const input = fixture(); input.worklist.cases = []; input.worklist.counts.sourceCases = 0; input.worklist.counts.affectedRows = 0; reseal(input.worklist);
    expect(renderNormalizedSourceReview(input)).toContain('No source cases in this worklist. Other review gates still apply.');
  });
});
