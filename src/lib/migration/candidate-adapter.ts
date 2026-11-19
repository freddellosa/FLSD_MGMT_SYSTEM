/** Explicit offline evidence mapping only. Never interprets tax, payment or billing status. */
import {createHash} from 'node:crypto';
import {toCentavos} from '../domain/billing';
import type {LocatedCandidate} from './manifest';
import type {ReviewGate} from './reconciliation';

export type CandidateMapping = {
  namespace: string;
  kind: string;
  fileId: string;
  idColumn: string;
  /** ISO service dates for dated rows; explicit null only for reference masters. */
  dateColumn: string | null;
  fields: Record<string, string>;
  money: Record<string, string>;
};
export type CandidateException = {fileId: string; row: number; code: 'MISSING_COLUMN' | 'INVALID_ID' | 'INVALID_MONEY'; column: string};

/** Every source row is either retained or explicitly rejected; no values are silently repaired. */
export function buildOfflineCandidates(rows: readonly Record<string, string>[], mapping: CandidateMapping) {
  if ([mapping.namespace, mapping.kind, mapping.fileId, mapping.idColumn].some(v => typeof v !== 'string' || !v.trim()) ||
      (mapping.dateColumn !== null && (typeof mapping.dateColumn !== 'string' || !mapping.dateColumn.trim()))) throw new Error('Explicit candidate mapping required');
  if (mapping.dateColumn === null && !['customer', 'vehicle', 'driver'].includes(mapping.kind)) throw new Error('Only reference masters may omit service dates');
  const fields = Object.entries(mapping.fields), money = Object.entries(mapping.money);
  if ([...fields, ...money].some(([name, column]) => !name.trim() || !column.trim())) throw new Error('Blank mapped field');
  if (fields.some(([name]) => Object.hasOwn(mapping.money, name))) throw new Error('Field and money names overlap');
  const columns = [...new Set([mapping.idColumn, ...(mapping.dateColumn === null ? [] : [mapping.dateColumn]), ...fields.map(([, c]) => c), ...money.map(([, c]) => c)])];
  const records: LocatedCandidate[] = [], exceptions: CandidateException[] = [];
  rows.forEach((source, index) => {
    const row = index + 2;
    const missing = columns.filter(c => !Object.hasOwn(source, c) || typeof source[c] !== 'string');
    if (missing.length) {
      for (const column of missing) exceptions.push({fileId: mapping.fileId, row, code: 'MISSING_COLUMN', column});
      return;
    }
    if (!source[mapping.idColumn].trim()) {
      exceptions.push({fileId: mapping.fileId, row, code: 'INVALID_ID', column: mapping.idColumn}); return;
    }
    const amounts: [string, bigint][] = [];
    for (const [name, column] of money) {
      try {
        const value = source[column];
        if (value.length > 128) throw new Error('Amount too long');
        const amount = toCentavos(value);
        if (amount < -999999999999999999n || amount > 999999999999999999n) throw new Error('Amount out of range');
        amounts.push([name, amount]);
      } catch { exceptions.push({fileId: mapping.fileId, row, code: 'INVALID_MONEY', column}); }
    }
    if (amounts.length !== money.length) return;
    const evidence = Object.keys(source).sort().map(k => [k, source[k]]);
    const pending: ReviewGate[] = ['TAX_BASIS', 'WORKFLOW', 'SCHEDULE', 'HISTORY'];
    records.push({fileId: mapping.fileId, row, ...(mapping.dateColumn === null ? {} : {serviceDate: source[mapping.dateColumn]}), candidate: {
      identity: {namespace: mapping.namespace, kind: mapping.kind, key: source[mapping.idColumn]},
      evidenceHash: createHash('sha256').update(JSON.stringify(evidence)).digest('hex'),
      fields: Object.fromEntries(fields.map(([name, column]) => [name, source[column]])),
      money: Object.fromEntries(amounts), pending,
    }});
  });
  return {importEnabled: false as const, sourceRows: rows.length, records, exceptions};
}
