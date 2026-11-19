import {createHash} from 'node:crypto';
import {describe, expect, it} from 'vitest';
import {assertManifestReplay, manifestFingerprint, verifyOfflineManifest, type LocatedCandidate, type OfflineManifest} from './manifest';
import {buildOfflineCandidates} from './candidate-adapter';
import {reconcileOffline} from './reconciliation';

function fixture() {
  const bytes = new TextEncoder().encode('synthetic exported bytes');
  const manifest: OfflineManifest = {version: 1, id: 'review-1', job: 'ACCESS_REVIEW', namespace: 'synthetic', mappingVersion: 'map-1',
    coverage: {from: '2026-09-01', through: '2026-09-30', cutoff: '2026-09-30', scope: 'SAMPLE'},
    files: [{id: 'trips', sha256: createHash('sha256').update(bytes).digest('hex'), rows: 1}], decisionReferences: []};
  const records: LocatedCandidate[] = [{fileId: 'trips', row: 2, serviceDate: '2026-09-01', candidate: {
    identity: {namespace: 'synthetic', kind: 'trip', key: '001'}, evidenceHash: 'a'.repeat(64), fields: {}, money: {gross: 11200n}, pending: ['TAX_BASIS', 'HISTORY'],
  }}];
  return {manifest, records, files: [{id: 'trips', bytes, parsedRows: 1}]};
}

describe('offline manifest verification', () => {
  it('verifies mapped synthetic evidence and rejects coverage when an invalid row is quarantined', () => {
    const f = fixture();
    const mapping = {namespace: 'synthetic', kind: 'trip', fileId: 'trips', idColumn: 'ID', dateColumn: 'Date', fields: {status: 'Status'}, money: {gross: 'Gross'}};
    const source = [{ID: '001', Date: '2026-09-01', Status: 'Received', Gross: '112.00'}];
    const mapped = buildOfflineCandidates(source, mapping);
    expect(verifyOfflineManifest(f.manifest, f.files, mapped.records).importEnabled).toBe(false);
    expect(reconcileOffline(mapped.records.map(r => r.candidate), structuredClone(mapped.records.map(r => r.candidate))).comparison).toBe('MATCH');
    const rejected = buildOfflineCandidates([{...source[0], Gross: '112.001'}], mapping);
    expect(rejected.exceptions).toHaveLength(1);
    expect(() => verifyOfflineManifest(f.manifest, f.files, rejected.records)).toThrow('Incomplete');
  });
  it('hashes supplied bytes and retains sample scope and pending decisions without import permission', () => {
    const f = fixture(), before = structuredClone(f);
    expect(verifyOfflineManifest(f.manifest, f.files, f.records)).toMatchObject({importEnabled: false, scope: 'SAMPLE', rows: 1, totals: {gross: '112.00'}, blocked: [{pending: ['HISTORY', 'TAX_BASIS']}]});
    expect(f).toEqual(before);
  });
  it('rejects substituted bytes even when file name and row count match', () => {
    const f = fixture(); f.files[0].bytes = new TextEncoder().encode('changed');
    expect(() => verifyOfflineManifest(f.manifest, f.files, f.records)).toThrow('bytes');
  });
  it('requires every declared file and rejects unexpected or duplicate files', () => {
    const f = fixture();
    expect(() => verifyOfflineManifest(f.manifest, [], f.records)).toThrow('Missing');
    expect(() => verifyOfflineManifest(f.manifest, [...f.files, ...f.files], f.records)).toThrow('Duplicate');
    expect(() => verifyOfflineManifest(f.manifest, [{...f.files[0], id: 'other'}], f.records)).toThrow('Unexpected');
  });
  it('requires exact parsed counts and complete unique record coverage', () => {
    const f = fixture();
    expect(() => verifyOfflineManifest(f.manifest, [{...f.files[0], parsedRows: 2}], f.records)).toThrow('count');
    expect(() => verifyOfflineManifest(f.manifest, f.files, [])).toThrow('Incomplete');
    expect(() => verifyOfflineManifest(f.manifest, f.files, [...f.records, ...f.records])).toThrow('Duplicate');
    f.records[0].row = 3;
    expect(() => verifyOfflineManifest(f.manifest, f.files, f.records)).toThrow('locator');
  });
  it.each(['2026-02-30', '2026-08-31', '2026-10-01', '09/01/2026'])('rejects invalid or uncovered record dates: %s', serviceDate => {
    const f = fixture(); f.records[0].serviceDate = serviceDate;
    expect(() => verifyOfflineManifest(f.manifest, f.files, f.records)).toThrow('coverage');
  });
  it('rejects invalid cutoff ordering and impossible coverage dates', () => {
    const f = fixture(); f.manifest.coverage.cutoff = '2026-09-29';
    expect(() => manifestFingerprint(f.manifest)).toThrow('coverage');
    f.manifest.coverage.cutoff = '2026-09-30'; f.manifest.coverage.from = '2026-02-30';
    expect(() => manifestFingerprint(f.manifest)).toThrow('coverage');
  });
  it('rejects version, namespace, identity and runtime-money violations', () => {
    const f = fixture(); f.records[0].candidate.identity.namespace = 'other';
    expect(() => verifyOfflineManifest(f.manifest, f.files, f.records)).toThrow('namespace');
    f.records[0].candidate.identity.namespace = 'synthetic'; f.records[0].candidate.money.gross = 1 as unknown as bigint;
    expect(() => verifyOfflineManifest(f.manifest, f.files, f.records)).toThrow('centavos');
    expect(() => manifestFingerprint({...f.manifest, version: 2 as 1})).toThrow('version');
    expect(() => manifestFingerprint({...f.manifest, mappingVersion: ''})).toThrow('identity');
  });
  it('fingerprints stable ordering and rejects replay with changed mapping, scope, or hash', () => {
    const f = fixture(); f.manifest.files.push({id: 'masters', sha256: 'b'.repeat(64), rows: 0}); f.manifest.decisionReferences = ['review-b', 'review-a'];
    const reordered = structuredClone(f.manifest); reordered.files.reverse(); reordered.decisionReferences.reverse();
    expect(manifestFingerprint(f.manifest)).toBe(manifestFingerprint(reordered));
    expect(() => assertManifestReplay(f.manifest, reordered)).not.toThrow();
    for (const change of [
      (m: OfflineManifest) => { m.mappingVersion = 'map-2'; },
      (m: OfflineManifest) => { m.coverage.scope = 'DECLARED_HISTORY'; },
      (m: OfflineManifest) => { m.files[0].sha256 = 'c'.repeat(64); },
    ]) {
      const next = structuredClone(f.manifest); change(next);
      expect(() => assertManifestReplay(f.manifest, next)).toThrow('changed');
    }
  });
  it('rejects duplicate declarations and unsafe counts instead of masking them', () => {
    const f = fixture(); f.manifest.files.push({...f.manifest.files[0]});
    expect(() => manifestFingerprint(f.manifest)).toThrow('duplicate');
    f.manifest.files.pop(); f.manifest.files[0].rows = Number.MAX_SAFE_INTEGER + 1;
    expect(() => manifestFingerprint(f.manifest)).toThrow('row count');
  });
});
