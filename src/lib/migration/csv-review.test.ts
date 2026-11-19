import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {reviewCsvBytes} from './csv-review';
import type {OfflineManifest} from './manifest';
import type {CandidateMapping} from './candidate-adapter';

function fixture(text = 'ID,Date,Gross,Status\r\n001,2026-09-01,112.00,Received\r\n') {
  const bytes = new TextEncoder().encode(text);
  const mapping: CandidateMapping = {namespace: 'synthetic', kind: 'trip', fileId: 'trips', idColumn: 'ID', dateColumn: 'Date', fields: {status: 'Status'}, money: {gross: 'Gross'}};
  const manifest: OfflineManifest = {version: 1, id: 'review-1', job: 'ACCESS_REVIEW', namespace: 'synthetic', mappingVersion: 'map-1',
    coverage: {from: '2026-09-01', through: '2026-09-30', cutoff: '2026-09-30', scope: 'SAMPLE'},
    files: [{id: 'trips', sha256: createHash('sha256').update(bytes).digest('hex'), rows: 1}], decisionReferences: []};
  return {manifest, files: [{id: 'trips', bytes, mapping}]};
}

describe('trusted offline CSV review', () => {
  it('derives counts, evidence and exact candidates from verified bytes with all decisions pending', () => {
    const f = fixture(), before = structuredClone(f), result = reviewCsvBytes(f.manifest, f.files);
    expect(result).toMatchObject({status: 'REVIEWED', sourceRows: 1, importEnabled: false, verification: {scope: 'SAMPLE', totals: {gross: '112.00'}}});
    expect(result.records[0].candidate.identity.key).toBe('001');
    expect(result.records[0].candidate.pending).toHaveLength(4);
    expect(f).toEqual(before);
  });
  it('rejects substituted bytes before parsing them', () => {
    const f = fixture(); f.files[0].bytes = new TextEncoder().encode('unclosed,"');
    expect(() => reviewCsvBytes(f.manifest, f.files)).toThrow('bytes differ');
  });
  it('cannot accept caller-supplied counts or candidate rows in place of parsing', () => {
    const f = fixture(); f.manifest.files[0].rows = 2;
    expect(() => reviewCsvBytes(f.manifest, f.files)).toThrow('row count');
  });
  it('keeps rejected source rows attributable and does not produce coverage verification', () => {
    const f = fixture('ID,Date,Gross,Status\n001,2026-09-01,112.001,Received');
    expect(reviewCsvBytes(f.manifest, f.files)).toMatchObject({status: 'REJECTED', sourceRows: 1, records: [], verification: null,
      exceptions: [{fileId: 'trips', row: 2, code: 'INVALID_MONEY', column: 'Gross'}]});
  });
  it('supports UTF-8 BOM, CRLF, quoted multiline fields and escaped quotes', () => {
    const f = fixture('\uFEFFID,Date,Gross,Status\r\n001,2026-09-01,112.00,"Line 1\r\nLine ""2"""\r\n');
    const result = reviewCsvBytes(f.manifest, f.files);
    expect(result.records[0].candidate.fields.status).toBe('Line 1\r\nLine "2"');
    expect(result.records[0].row).toBe(2);
  });
  it.each(['ID,Date,Gross,Status\n001,2026-09-01,112.00,"Received"junk', 'ID,Date,Gross,Status\n001,2026-09-01,112.00,"Received', 'ID,ID\n1,2'])('rejects malformed CSV instead of repairing it', text => {
    const f = fixture(text);
    expect(() => reviewCsvBytes(f.manifest, f.files)).toThrow(/CSV/);
  });
  it('rejects invalid UTF-8 and NUL rather than guessing encoding', () => {
    const f = fixture(); f.files[0].bytes = new Uint8Array([0xc3, 0x28]);
    f.manifest.files[0].sha256 = createHash('sha256').update(f.files[0].bytes).digest('hex');
    expect(() => reviewCsvBytes(f.manifest, f.files)).toThrow('UTF-8');
    const nul = fixture('ID,Date,Gross,Status\n001,2026-09-01,112.00,\0');
    expect(() => reviewCsvBytes(nul.manifest, nul.files)).toThrow('NUL');
  });
  it('rejects duplicate identities and out-of-coverage dates from parsed bytes', () => {
    const f = fixture('ID,Date,Gross,Status\n001,2026-09-01,112.00,A\n001,2026-09-02,1.00,B');
    f.manifest.files[0].rows = 2;
    expect(() => reviewCsvBytes(f.manifest, f.files)).toThrow('Duplicate source identity');
    const date = fixture('ID,Date,Gross,Status\n001,2026-10-01,112.00,A');
    expect(() => reviewCsvBytes(date.manifest, date.files)).toThrow('coverage');
  });
  it('binds mapping content even when the declared mapping version stays unchanged', () => {
    const f = fixture('ID,Date,Gross,Status,Other\n001,2026-09-01,112.00,A,B');
    const first = reviewCsvBytes(f.manifest, f.files);
    f.files[0].mapping.fields.status = 'Other';
    const second = reviewCsvBytes(f.manifest, f.files);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.reviewFingerprint).not.toBe(second.reviewFingerprint);
  });
  it('requires matching file/mapping identities and a complete source set', () => {
    const f = fixture();
    expect(() => reviewCsvBytes(f.manifest, [])).toThrow('Missing');
    expect(() => reviewCsvBytes(f.manifest, [...f.files, ...f.files])).toThrow('duplicate');
    f.files[0].mapping.namespace = 'other';
    expect(() => reviewCsvBytes(f.manifest, f.files)).toThrow('mapping identity');
  });
  it('does not pretend a CSV batch captures pilot authority or archived history', () => {
    const f = fixture(); f.manifest.job = 'PILOT_CONVERSION_REVIEW';
    expect(() => reviewCsvBytes(f.manifest, f.files)).toThrow('pilot history');
  });
});
