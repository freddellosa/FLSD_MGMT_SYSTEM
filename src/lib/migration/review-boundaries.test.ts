import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {reviewCsvBytes} from './csv-review';
import {buildReviewReport} from './review-report';
import {syntheticReviewRequest} from './synthetic-review';

describe('offline review resource and coverage boundaries', () => {
  it('rejects excessive supplied bytes before hashing or parsing', () => {
    const request = syntheticReviewRequest();
    request.files[0].bytes = new Uint8Array(20 * 1024 * 1024 + 1);
    expect(() => reviewCsvBytes(request.manifest, request.files)).toThrow('byte limit');
  });
  it('rejects over 100,000 parsed records before candidate construction', () => {
    const request = syntheticReviewRequest();
    request.files[0].bytes = new TextEncoder().encode('ID,Date,Customer,Vehicle,Driver,Gross,Status\n' + 'T,2026-09-01,C01,V01,D01,1.00,A\n'.repeat(100001));
    request.manifest.files[0].sha256 = createHash('sha256').update(request.files[0].bytes).digest('hex');
    request.manifest.files[0].rows = 100001;
    expect(() => reviewCsvBytes(request.manifest, request.files)).toThrow('row limit');
  });
  it('reviews 2,000 distinct synthetic trips with exact totals and all links checked', () => {
    const request = syntheticReviewRequest();
    request.files[0].bytes = new TextEncoder().encode('ID,Date,Customer,Vehicle,Driver,Gross,Status\n' +
      Array.from({length: 2000}, (_, i) => `T${i.toString().padStart(4, '0')},2026-09-01,C01,V01,D01,0.01,Approved`).join('\n'));
    request.manifest.files[0].sha256 = createHash('sha256').update(request.files[0].bytes).digest('hex');
    request.manifest.files[0].rows = 2000;
    const report = buildReviewReport(request);
    expect(report).toMatchObject({structuralStatus: 'REVIEWED', policyStatus: 'PENDING', importEnabled: false,
      counts: {sourceRows: 2003, candidateRows: 2003, pendingRows: 2003}, totals: {values: {gross: '20.00'}}});
    expect(report.relationships?.counts.every(c => c.checked === 2000 && c.matched === 2000)).toBe(true);
  });
  it('does not call source coverage complete when all evidence is empty', () => {
    const request = syntheticReviewRequest();
    for (let i = 0; i < request.files.length; i++) {
      request.files[i].bytes = new TextEncoder().encode('ID,Date,Customer,Vehicle,Driver,Gross,Status\n');
      request.manifest.files[i].sha256 = createHash('sha256').update(request.files[i].bytes).digest('hex');
      request.manifest.files[i].rows = 0;
    }
    expect(() => reviewCsvBytes(request.manifest, request.files)).toThrow('coverage must not be empty');
  });
});
