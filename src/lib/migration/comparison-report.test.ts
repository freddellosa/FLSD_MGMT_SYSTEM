import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {buildComparisonReport} from './comparison-report';
import {syntheticReviewRequest} from './synthetic-review';
import type {CsvReviewRequest} from './review-report';

function change(request: CsvReviewRequest, before: string, after: string) {
  const files = request.files;
  files[0].bytes = new TextEncoder().encode(new TextDecoder().decode(files[0].bytes).replace(before, after));
  request.manifest.files[0].sha256 = createHash('sha256').update(files[0].bytes).digest('hex');
}
describe('verified dataset comparison report', () => {
  it('compares identical bytes without claiming policy or import readiness', () => {
    const result = buildComparisonReport(syntheticReviewRequest(), syntheticReviewRequest());
    expect(result).toMatchObject({status: 'MATCH', importEnabled: false, policyStatus: 'PENDING', reconciliation: {pendingRows: 5, differences: []}});
    expect(() => JSON.stringify(result)).not.toThrow();
  });
  it('reports exact row differences and locators even with offsetting total changes', () => {
    const candidate = syntheticReviewRequest(); change(candidate, ',112.00,', ',112.01,'); change(candidate, ',9999999999999999.99,', ',9999999999999999.98,');
    const result = buildComparisonReport(syntheticReviewRequest(), candidate);
    expect(result.status).toBe('DIFFERENT');
    expect(result.reconciliation?.totals.source).toEqual(result.reconciliation?.totals.candidate);
    expect(result.reconciliation?.differences.filter(d => d.field === 'money.gross')).toEqual(expect.arrayContaining([
      expect.objectContaining({sourceLocator: {fileId: 'trips', row: 2}, source: '112.00', candidate: '112.01'}),
    ]));
  });
  it('does not compare rejected or orphaned datasets as if they were reconciled', () => {
    expect(buildComparisonReport(syntheticReviewRequest(), syntheticReviewRequest('ORPHAN'))).toMatchObject({status: 'NOT_COMPARED', reasons: ['CANDIDATE_REQUIRES_REVIEW'], reconciliation: null});
    expect(buildComparisonReport(syntheticReviewRequest('INVALID_MONEY'), syntheticReviewRequest()).status).toBe('NOT_COMPARED');
  });
  it('blocks incompatible coverage, mapping version, namespaces and relationship rules', () => {
    const candidate = syntheticReviewRequest(); candidate.manifest.mappingVersion = 'changed'; candidate.manifest.coverage.cutoff = '2026-10-01';
    expect(buildComparisonReport(syntheticReviewRequest(), candidate).reasons).toEqual(['MAPPING_VERSION_CHANGED', 'COVERAGE_CHANGED']);
    const rules = syntheticReviewRequest(); rules.rules = rules.rules.map(r => ({...r, required: false}));
    expect(buildComparisonReport(syntheticReviewRequest(), rules).reasons).toContain('RELATIONSHIP_RULES_CHANGED');
    const mapping = syntheticReviewRequest(); delete mapping.files[0].mapping.fields.statusEvidence;
    expect(buildComparisonReport(syntheticReviewRequest(), mapping).reasons).toContain('MAPPING_CONTENT_CHANGED');
  });
  it('reports identity replacements on both sides without exporting text cells', () => {
    const candidate = syntheticReviewRequest(); change(candidate, '001,2026', '009,2026');
    const result = buildComparisonReport(syntheticReviewRequest(), candidate);
    expect(result.reconciliation?.missing[0].identity.key).toBe('001');
    expect(result.reconciliation?.unexpected[0].identity.key).toBe('009');
    expect(JSON.stringify(result)).not.toContain('Received');
  });
});
