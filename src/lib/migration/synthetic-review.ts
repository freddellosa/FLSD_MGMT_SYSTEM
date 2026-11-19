/** Fictional fixtures for offline review demonstrations. Never reads real exports. */
import {createHash} from 'node:crypto';
import type {CsvReviewRequest} from './review-report';
import type {CsvReviewFile} from './csv-review';

export type SyntheticReviewScenario = 'MATCH' | 'ORPHAN' | 'INVALID_MONEY';
export function syntheticReviewRequest(scenario: SyntheticReviewScenario = 'MATCH'): CsvReviewRequest {
  if (!['MATCH', 'ORPHAN', 'INVALID_MONEY'].includes(scenario)) throw new Error('Unknown synthetic review scenario');
  const files: CsvReviewFile[] = [
    {id: 'trips', bytes: new TextEncoder().encode('ID,Date,Customer,Vehicle,Driver,Gross,Status\r\n' +
      `001,2026-09-01,${scenario === 'ORPHAN' ? 'C-missing' : 'C01'},V01,D01,${scenario === 'INVALID_MONEY' ? '112.001' : '112.00'},Received\r\n` +
      '002,2026-09-02,C01,V01,D01,9999999999999999.99,Approved\r\n'),
      mapping: {namespace: 'SYNTHETIC_ONLY', kind: 'trip', fileId: 'trips', idColumn: 'ID', dateColumn: 'Date',
        fields: {customerId: 'Customer', vehicleId: 'Vehicle', driverId: 'Driver', statusEvidence: 'Status'}, money: {gross: 'Gross'}}},
    ...(['customer', 'vehicle', 'driver'] as const).map((kind, index) => {
      const fileId = kind + 's', id = ['C01', 'V01', 'D01'][index];
      return {id: fileId, bytes: new TextEncoder().encode(`ID,Name\n${id},Fictional ${kind}\n`),
        mapping: {namespace: 'SYNTHETIC_ONLY', kind, fileId, idColumn: 'ID', dateColumn: null, fields: {name: 'Name'}, money: {}}};
    }),
  ];
  return {
    manifest: {version: 1, id: 'synthetic-review-' + scenario.toLowerCase(), job: 'ACCESS_REVIEW', namespace: 'SYNTHETIC_ONLY', mappingVersion: 'synthetic-map-1',
      coverage: {from: '2026-09-01', through: '2026-09-30', cutoff: '2026-09-30', scope: 'SAMPLE'}, decisionReferences: [],
      files: files.map(f => ({id: f.id, sha256: createHash('sha256').update(f.bytes).digest('hex'), rows: f.id === 'trips' ? 2 : 1,
        ...(f.id === 'trips' ? {} : {recordType: 'MASTER' as const})}))},
    files, rules: ['customer', 'vehicle', 'driver'].map(kind => ({id: 'trip-' + kind, sourceKind: 'trip', field: kind + 'Id', targetKind: kind, required: true})),
  };
}
