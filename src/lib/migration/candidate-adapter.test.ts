import {describe, expect, it} from 'vitest';
import {buildOfflineCandidates, type CandidateMapping} from './candidate-adapter';

const mapping: CandidateMapping = {namespace: 'synthetic', kind: 'trip', fileId: 'trips', idColumn: 'ID', dateColumn: 'Date', fields: {statusEvidence: 'Status'}, money: {gross: 'Gross'}};
const row = {ID: '001', Date: '2026-09-01', Status: 'Received', Gross: '112.00'};

describe('offline evidence candidate adapter', () => {
  it('retains exact identity and status evidence with all decisions gated and no payment inferred', () => {
    const source = [{...row}], before = structuredClone(source);
    const result = buildOfflineCandidates(source, mapping);
    expect(result.importEnabled).toBe(false);
    expect(result.records[0]).toMatchObject({row: 2, candidate: {identity: {key: '001'}, fields: {statusEvidence: 'Received'}, money: {gross: 11200n}, pending: ['TAX_BASIS', 'WORKFLOW', 'SCHEDULE', 'HISTORY']}});
    expect(result.records[0].candidate).not.toHaveProperty('receipt');
    expect(source).toEqual(before);
  });
  it('reports every rejected row without excluding it from the source count', () => {
    const result = buildOfflineCandidates([{...row, Gross: '12.345'}, {...row, ID: ' '}, {ID: '3'}], mapping);
    expect(result.sourceRows).toBe(3); expect(result.records).toHaveLength(0);
    expect(result.exceptions.map(e => e.code)).toEqual(['INVALID_MONEY', 'INVALID_ID', 'MISSING_COLUMN', 'MISSING_COLUMN', 'MISSING_COLUMN']);
  });
  it('hashes all source evidence deterministically, including unmapped columns', () => {
    const a = buildOfflineCandidates([{...row, Note: 'A'}], mapping).records[0];
    const b = buildOfflineCandidates([{Note: 'A', Gross: row.Gross, Status: row.Status, Date: row.Date, ID: row.ID}], mapping).records[0];
    const c = buildOfflineCandidates([{...row, Note: 'B'}], mapping).records[0];
    expect(a.candidate.evidenceHash).toBe(b.candidate.evidenceHash);
    expect(a.candidate.evidenceHash).not.toBe(c.candidate.evidenceHash);
  });
  it('keeps large amounts exact without adding or recalculating any tax', () => {
    const result = buildOfflineCandidates([{...row, Gross: '9999999999999999.99'}], mapping);
    expect(result.records[0].candidate.money).toEqual({gross: 999999999999999999n});
  });
  it.each(['10000000000000000.00', '1e3', 'PHP 112.00', ''])('rejects unsupported money without rounding: %s', Gross => {
    expect(buildOfflineCandidates([{...row, Gross}], mapping).exceptions[0].code).toBe('INVALID_MONEY');
  });
  it('preserves invalid dates for explicit manifest rejection instead of inventing timestamps', () => {
    expect(buildOfflineCandidates([{...row, Date: 'invalid'}], mapping).records[0].serviceDate).toBe('invalid');
  });
});
