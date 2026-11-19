import {describe, expect, it} from 'vitest';
import {assertReviewIntegrity, buildReviewReport, canonicalReviewJson, sealReviewReport} from './review-report';
import {syntheticReviewRequest} from './synthetic-review';

describe('consolidated offline review report', () => {
  it('separates structural review from pending policy and preserves exact JSON-safe money', () => {
    const report = buildReviewReport(syntheticReviewRequest());
    expect(report).toMatchObject({structuralStatus: 'REVIEWED', policyStatus: 'PENDING', importEnabled: false,
      counts: {sourceRows: 5, candidateRows: 5, rejectedRows: 0, pendingRows: 5},
      totals: {scope: 'ALL_PARSED_CANDIDATES', values: {gross: '10000000000000111.99'}}});
    expect(() => JSON.stringify(report)).not.toThrow();
    expect(report.records.find(r => r.identity.kind === 'customer')).not.toHaveProperty('serviceDate');
  });
  it('locates relationship failures without exposing unselected raw cell values', () => {
    const report = buildReviewReport(syntheticReviewRequest('ORPHAN'));
    expect(report).toMatchObject({structuralStatus: 'REVIEW', relationships: {issues: [{code: 'ORPHAN', locator: {fileId: 'trips', row: 2}, targetLocator: null}]}});
    expect(JSON.stringify(report)).not.toContain('Received');
    expect(JSON.stringify(report)).not.toContain('Fictional customer');
  });
  it('labels accepted-only totals and counts rejected rows once even with multiple diagnostics', () => {
    const request = syntheticReviewRequest('INVALID_MONEY');
    request.files[0].mapping.fields.extra = 'Absent';
    const report = buildReviewReport(request);
    expect(report).toMatchObject({structuralStatus: 'REJECTED', totals: {scope: 'ACCEPTED_CANDIDATES_ONLY', values: {}},
      counts: {sourceRows: 5, candidateRows: 3, rejectedRows: 2}, relationships: null});
  });
  it('preserves input evidence and isolates report edits', () => {
    const request = syntheticReviewRequest(), before = structuredClone(request);
    const report = buildReviewReport(request); report.records[0].identity.key = 'edited'; report.coverage.from = 'edited';
    expect(request).toEqual(before);
  });
  it('keeps file and rule ordering from changing report evidence', () => {
    const request = syntheticReviewRequest(); const a = buildReviewReport(request);
    const b = buildReviewReport({...request, files: [...request.files].reverse(), rules: [...request.rules].reverse()});
    expect(canonicalReviewJson(a)).toBe(canonicalReviewJson(b));
  });
});

describe('review artifact integrity', () => {
  it('round-trips plain JSON and rejects edited artifact contents', () => {
    const envelope = sealReviewReport(buildReviewReport(syntheticReviewRequest()));
    const restored = JSON.parse(JSON.stringify(envelope));
    expect(() => assertReviewIntegrity(restored)).not.toThrow();
    restored.report.totals.values.gross = '0.00';
    expect(() => assertReviewIntegrity(restored)).toThrow('integrity');
  });
  it('isolates envelope from report edits and canonicalizes property insertion order', () => {
    const report = buildReviewReport(syntheticReviewRequest()), envelope = sealReviewReport(report);
    report.counts.sourceRows = 0;
    expect(() => assertReviewIntegrity(envelope)).not.toThrow();
    expect(canonicalReviewJson({b: 1, a: 2})).toBe(canonicalReviewJson({a: 2, b: 1}));
  });
  it('rejects non-JSON and nonfinite evidence rather than silently dropping or rounding it', () => {
    for (const value of [1n, NaN, Infinity, {a: undefined}, new Date()]) expect(() => canonicalReviewJson(value)).toThrow('finite JSON');
  });
  it('never seals an enabled import artifact', () => {
    const report = buildReviewReport(syntheticReviewRequest());
    expect(() => sealReviewReport({...report, importEnabled: true as false})).toThrow('disabled');
  });
});
