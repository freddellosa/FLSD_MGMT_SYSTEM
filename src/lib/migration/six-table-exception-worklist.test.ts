import {describe, expect, it} from 'vitest';
import {buildSixTableExceptionWorklist, renderSixTableExceptionMarkdown} from './six-table-exception-worklist';
import type {prepareSixTableTargetCandidates} from './six-table-target-candidates';
type Prepared = ReturnType<typeof prepareSixTableTargetCandidates>;
function fixture(): Prepared {
  const source = {namespace: 'QA', table: 'Trips_Tbl' as const, sourceKey: '0001', fileId: 'trips.csv', row: 2, fileSha256: 'a'.repeat(64), evidenceSha256: 'b'.repeat(64)};
  return {kind: 'SIX_TABLE_TARGET_CANDIDATES', version: 1, importEnabled: false, executionAuthorized: false,
    releaseState: 'BLOCKED_PENDING_REVIEW_AND_DATABASE_AUTHORIZATION', sourcePlanSha256: 'c'.repeat(64), mappingSha256: 'd'.repeat(64), evidenceSha256: 'e'.repeat(64),
    counts: {rows: 2, candidates: 0, quarantined: 2}, limitations: [], candidates: [
      {source, state: 'QUARANTINED', issues: [{field: null, code: 'FINANCIAL_RELATIONSHIP_STATUS_POLICY_REVIEW'}, {field: 'DateOfTrip_End', code: 'SERVICE_END_BEFORE_START'}],
        fields: [], sourceReferences: [], sourceEvidence: {DateOfTrip_Start: '9/1/2026 2:00:00 PM', DateOfTrip_End: '9/1/2026 1:00:00 PM', Passenger: 'PRIVATE PASSENGER', SSSNo: 'PRIVATE PAYROLL', ORNo: 'PRIVATE OR'}},
      {source: {...source, table: 'vehicle_tbl', sourceKey: 'V01', fileId: 'vehicles.csv'}, state: 'QUARANTINED',
        issues: [{field: 'PlateNo', code: 'MISSING_OR_UNRESOLVED_TYPED_VALUE'}], fields: [], sourceReferences: [], sourceEvidence: {PlateNo: ''}},
    ]};
}
describe('private source exception worklist', () => {
  it('separates source findings from blanket financial holds and preserves original IDs/locators', () => {
    const report = buildSixTableExceptionWorklist(fixture());
    expect(report).toMatchObject({importEnabled: false, executionAuthorized: false, counts: {sourceCases: 2, affectedRows: 2, policyHeldRows: 1}});
    expect(report.policyHolds).toEqual([{table: 'Trips_Tbl', rows: 1}]);
    expect(report.cases[0].source).toMatchObject({sourceKey: '0001', fileId: 'trips.csv', row: 2});
    expect(report.cases[0].evidence).toEqual([{field: 'DateOfTrip_Start', present: true, value: '9/1/2026 2:00:00 PM', valueWithheld: false},
      {field: 'DateOfTrip_End', present: true, value: '9/1/2026 1:00:00 PM', valueWithheld: false}]);
    expect(report.cases.every(c => c.state === 'OPEN_SOURCE_REVIEW')).toBe(true);
  });
  it('does not copy unrelated sensitive fields or generate corrections/approvals', () => {
    const report = buildSixTableExceptionWorklist(fixture()), text = JSON.stringify(report);
    for (const privateValue of ['PRIVATE PASSENGER', 'PRIVATE PAYROLL', 'PRIVATE OR']) expect(text).not.toContain(privateValue);
    expect(report).not.toHaveProperty('corrections'); expect(report).not.toHaveProperty('decisions');
    expect(report.cases[0].guidance).toContain('Do not assume overnight rollover');
  });
  it('withholds arbitrary field values even when an issue targets a personal or excluded column', () => {
    const input = fixture(); input.candidates[0].issues = [{field: 'Passenger', code: 'INVALID_TYPED_VALUE'}, {field: 'SSSNo', code: 'INVALID_TYPED_VALUE'}];
    const report = buildSixTableExceptionWorklist(input);
    expect(report.cases.filter(c => c.source.table === 'Trips_Tbl').every(c => c.evidence[0].valueWithheld && c.evidence[0].value === null)).toBe(true);
    expect(JSON.stringify(report)).not.toContain('PRIVATE');
  });
  it('deduplicates repeated issues without losing distinct findings on the same row', () => {
    const input = fixture(); input.candidates[0].issues.push({...input.candidates[0].issues[1]}, {field: 'DriverID', code: 'MASTER_CANDIDATE_QUARANTINED'});
    const report = buildSixTableExceptionWorklist(input);
    expect(report.counts).toMatchObject({sourceCases: 3, affectedRows: 2, policyHeldRows: 1});
  });
  it('binds case IDs to file version, row evidence and mapping, rather than source ID alone', () => {
    const input = fixture(), original = buildSixTableExceptionWorklist(input).cases[0].caseId;
    input.candidates[0].source.fileSha256 = 'f'.repeat(64);
    expect(buildSixTableExceptionWorklist(input).cases[0].caseId).not.toBe(original);
    input.candidates[0].source.fileSha256 = 'a'.repeat(64); input.mappingSha256 = 'f'.repeat(64);
    expect(buildSixTableExceptionWorklist(input).cases[0].caseId).not.toBe(original);
  });
  it('does not mutate input and orders reports deterministically across row order', () => {
    const input = fixture(), before = structuredClone(input), report = buildSixTableExceptionWorklist(input);
    expect(input).toEqual(before);
    input.candidates.reverse(); expect(buildSixTableExceptionWorklist(input).evidenceSha256).toBe(report.evidenceSha256);
  });
  it('escapes Markdown/HTML controls in source identifiers, filenames and selected evidence', () => {
    const input = fixture(); input.candidates[0].source.sourceKey = '[click](javascript:alert(1))|<script>*`';
    input.candidates[0].sourceEvidence.DateOfTrip_Start = '<img src=x onerror=alert(1)>\n|[link] https://example.test someone@example.test';
    const markdown = renderSixTableExceptionMarkdown(buildSixTableExceptionWorklist(input));
    expect(markdown).not.toContain('<script>'); expect(markdown).not.toContain('<img'); expect(markdown).not.toContain('[click]');
    expect(markdown).toContain('&#124;'); expect(markdown).toContain('&#10;');
    expect(markdown).not.toContain('https://'); expect(markdown).not.toContain('someone@example.test');
  });
  it('represents no source findings without clearing independent policy or release reviews', () => {
    const input = fixture(); input.candidates = [input.candidates[0]]; input.candidates[0].issues = [input.candidates[0].issues[0]];
    const report = buildSixTableExceptionWorklist(input);
    expect(report.counts).toEqual({sourceCases: 0, affectedRows: 0, policyHeldRows: 1});
    expect(report.independentReviews.join(' ')).toContain('explicit execution approval');
  });
});
