import {describe, expect, it} from 'vitest';
import {buildReviewReport, sealReviewReport} from './review-report';
import {renderReviewHtml} from './review-html';
import {syntheticReviewRequest} from './synthetic-review';

describe('standalone offline review HTML', () => {
  it('shows distinct policy and structural status, exact money and logical row locators', () => {
    const html = renderReviewHtml(sealReviewReport(buildReviewReport(syntheticReviewRequest())));
    expect(html).toContain('Structure: <strong>REVIEWED</strong>');
    expect(html).toContain('Policy: <strong>PENDING</strong>');
    expect(html).toContain('10000000000000111.99');
    expect(html).toContain('trips / record 2');
    expect(html).toContain('Import disabled');
  });
  it('escapes every source-controlled HTML field and blocks active content', () => {
    const report = buildReviewReport(syntheticReviewRequest('ORPHAN'));
    report.records[0].identity.key = '<script>alert("x")</script>';
    report.relationships!.issues[0].target!.key = '<img src=x onerror=alert(1)>';
    report.provenance.manifestId = '" autofocus onfocus="x';
    const html = renderReviewHtml(sealReviewReport(report));
    expect(html).not.toMatch(/<script|<img|<iframe|<form|<a\s/i);
    expect(html).toContain('&lt;script&gt;'); expect(html).toContain('&lt;img');
    expect(html).toContain('default-src &#39;none&#39;'.replaceAll('&#39;', "'"));
    expect(html).not.toMatch(/(?:src|href)="https?:/);
  });
  it('labels partial totals and unassessed relationships after source rejection', () => {
    const html = renderReviewHtml(sealReviewReport(buildReviewReport(syntheticReviewRequest('INVALID_MONEY'))));
    expect(html).toContain('Partial totals: accepted candidates only');
    expect(html).toContain('Not assessed because source candidates were rejected');
    expect(html).toContain('INVALID_MONEY');
  });
  it('rejects changed envelope contents before rendering', () => {
    const envelope = sealReviewReport(buildReviewReport(syntheticReviewRequest())); envelope.report.counts.sourceRows = 0;
    expect(() => renderReviewHtml(envelope)).toThrow('integrity');
  });
});
