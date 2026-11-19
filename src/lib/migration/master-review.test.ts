import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {reviewCsvBytes, reviewRelatedCsvBytes, type CsvReviewFile} from './csv-review';
import {manifestFingerprint, type OfflineManifest} from './manifest';
import type {RelationshipRule} from './relationships';

const rules: RelationshipRule[] = [{id: 'trip-customer', sourceKind: 'trip', field: 'customerId', targetKind: 'customer', required: true}];
function fixture(customer = 'C01') {
  const files: CsvReviewFile[] = [
    {id: 'trips', bytes: new TextEncoder().encode(`ID,Date,Customer,Gross\n001,2026-09-01,${customer},112.00`), mapping: {namespace: 'synthetic', kind: 'trip', fileId: 'trips', idColumn: 'ID', dateColumn: 'Date', fields: {customerId: 'Customer'}, money: {gross: 'Gross'}}},
    {id: 'customers', bytes: new TextEncoder().encode('ID,Name\nC01,Example customer'), mapping: {namespace: 'synthetic', kind: 'customer', fileId: 'customers', idColumn: 'ID', dateColumn: null, fields: {name: 'Name'}, money: {}}},
  ];
  const manifest: OfflineManifest = {version: 1, id: 'combined', job: 'ACCESS_REVIEW', namespace: 'synthetic', mappingVersion: 'map-1',
    coverage: {from: '2026-09-01', through: '2026-09-30', cutoff: '2026-09-30', scope: 'SAMPLE'}, decisionReferences: [],
    files: files.map(f => ({id: f.id, sha256: createHash('sha256').update(f.bytes).digest('hex'), rows: 1, ...(f.id === 'customers' ? {recordType: 'MASTER' as const} : {})}))};
  return {files, manifest};
}

describe('trusted master and combined CSV review', () => {
  it('reviews master bytes without manufacturing dates and matches exact trip references', () => {
    const f = fixture(), before = structuredClone(f);
    const result = reviewRelatedCsvBytes(f.manifest, f.files, rules);
    expect(result).toMatchObject({status: 'REVIEWED', importEnabled: false, sourceRows: 2, relationships: {status: 'MATCH'}});
    expect(result.records.find(r => r.fileId === 'customers')).not.toHaveProperty('serviceDate');
    expect(result.verification?.blocked).toHaveLength(2);
    expect(f).toEqual(before);
  });
  it('returns review evidence for orphans without masking successful byte verification', () => {
    const f = fixture('C1');
    expect(reviewRelatedCsvBytes(f.manifest, f.files, rules)).toMatchObject({status: 'REVIEW', verification: {rows: 2}, relationships: {issues: [{code: 'ORPHAN'}]}});
  });
  it('binds relationship configuration and record type into fingerprints', () => {
    const f = fixture();
    const first = reviewRelatedCsvBytes(f.manifest, f.files, rules);
    const changed = reviewRelatedCsvBytes(f.manifest, f.files, [{...rules[0], required: false}]);
    expect(first.reviewFingerprint).toBe(changed.reviewFingerprint);
    expect(first.relationshipFingerprint).not.toBe(changed.relationshipFingerprint);
    const previous = manifestFingerprint(f.manifest); f.manifest.files[1].recordType = 'DATED';
    expect(manifestFingerprint(f.manifest)).not.toBe(previous);
  });
  it('rejects undeclared date omission and prevents trips being relabeled as masters', () => {
    const f = fixture(); delete f.manifest.files[1].recordType;
    expect(() => reviewCsvBytes(f.manifest, f.files)).toThrow('record type');
    const trip = fixture(); trip.manifest.files[0].recordType = 'MASTER'; trip.files[0].mapping.dateColumn = null;
    expect(() => reviewCsvBytes(trip.manifest, trip.files)).toThrow('reference masters');
  });
  it('requires verified bytes for masters and never trusts an unrelated supplied master', () => {
    const f = fixture(); f.files[1].bytes = new TextEncoder().encode('ID,Name\nC1,Replacement');
    expect(() => reviewRelatedCsvBytes(f.manifest, f.files, rules)).toThrow('bytes differ');
  });
  it('does not run partial relationship checks after a source-row rejection', () => {
    const f = fixture(); f.files[1].mapping.idColumn = 'Missing';
    expect(reviewRelatedCsvBytes(f.manifest, f.files, rules)).toMatchObject({status: 'REJECTED', relationships: null, verification: null, exceptions: [{code: 'MISSING_COLUMN'}]});
  });
  it('preserves duplicate-master failure and remains deterministic across file ordering', () => {
    const f = fixture();
    expect(reviewRelatedCsvBytes(f.manifest, [...f.files].reverse(), rules)).toEqual(reviewRelatedCsvBytes(f.manifest, f.files, rules));
    f.files[1].bytes = new TextEncoder().encode('ID,Name\nC01,A\nC01,B');
    f.manifest.files[1].rows = 2; f.manifest.files[1].sha256 = createHash('sha256').update(f.files[1].bytes).digest('hex');
    expect(() => reviewRelatedCsvBytes(f.manifest, f.files, rules)).toThrow('Duplicate source identity');
  });
});
