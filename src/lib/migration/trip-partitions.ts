/** Exact-key combination of explicit exported copies. Never deduplicates or repairs source rows. */
import {createHash} from 'node:crypto';
import type {AccessRow} from './access-staging';
import {parseLegacyDate} from './trips';
import {canonicalReviewJson} from './review-report';
export type TripPartitionEvidence = {fileName: string; sha256: string; rows: number; declaredMonth: string};
export type TripSourcePartition = Omit<TripPartitionEvidence, 'rows'> & {rows: readonly AccessRow[]};
export type TripSourceLocation = {fileName: string; row: number};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function tripPartitionDigest(partitions: readonly TripPartitionEvidence[]) {
  if (!partitions.length || new Set(partitions.map(p => p.fileName)).size !== partitions.length) throw new Error('Unique explicit trip partitions required');
  for (const p of partitions) if (!p.fileName.trim() || p.fileName.length > 200 || /[/\\]/.test(p.fileName) || !/^[a-f0-9]{64}$/.test(p.sha256) ||
    !Number.isSafeInteger(p.rows) || p.rows < 0 || !/^\d{4}-(0[1-9]|1[0-2])$/.test(p.declaredMonth)) throw new Error('Invalid trip partition evidence');
  const sorted = [...partitions].sort((a, b) => compare(a.fileName, b.fileName)).map(p => ({fileName: p.fileName, sha256: p.sha256, rows: p.rows, declaredMonth: p.declaredMonth}));
  return createHash('sha256').update(canonicalReviewJson({kind: 'TRIP_EXPORT_PARTITIONS', version: 1, partitions: sorted})).digest('hex');
}
export function combineTripPartitions(partitions: readonly TripSourcePartition[]) {
  const evidence = partitions.map(p => ({fileName: p.fileName, sha256: p.sha256, rows: p.rows.length, declaredMonth: p.declaredMonth}));
  const aggregateSha256 = tripPartitionDigest(evidence);
  if (evidence.reduce((n, p) => n + p.rows, 0) > 100000) throw new Error('Combined trip review row limit exceeded');
  const ordered = [...partitions].sort((a, b) => compare(a.fileName, b.fileName));
  const rows: AccessRow[] = [], locations: TripSourceLocation[] = [];
  const issues: {code: 'MISSING_TRIP_KEY' | 'DUPLICATE_TRIP_KEY' | 'INVALID_SERVICE_DATE' | 'DECLARED_MONTH_DIFFERENCE'; sourceTrip: string; fileName: string; row: number}[] = [];
  const keys = new Map<string, number[]>();
  for (const part of ordered) part.rows.forEach((source, index) => {
    for (const column of ['tmpInvoiceNo', 'CompanyID', 'SOANo', 'DateOfTrip_Start', 'InvoiceTotAmt']) if (!Object.hasOwn(source, column) || typeof source[column] !== 'string') throw new Error('Trip partition headers/fields require review');
    const location = {fileName: part.fileName, row: index + 2}, key = source.tmpInvoiceNo;
    const position = rows.length; rows.push({...source}); locations.push(location);
    const add = (code: typeof issues[number]['code']) => issues.push({code, sourceTrip: key, ...location});
    if (!key.trim()) add('MISSING_TRIP_KEY'); else { const positions = keys.get(key) ?? []; positions.push(position); keys.set(key, positions); }
    const date = parseLegacyDate(source.DateOfTrip_Start);
    if (!date) add('INVALID_SERVICE_DATE');
    else if (date.toISOString().slice(0, 7) !== part.declaredMonth) add('DECLARED_MONTH_DIFFERENCE');
  });
  for (const [sourceTrip, positions] of keys) if (positions.length > 1) for (const i of positions) issues.push({code: 'DUPLICATE_TRIP_KEY', sourceTrip, ...locations[i]});
  return {importEnabled: false as const, status: issues.length ? 'REVIEW' as const : 'VALIDATED' as const,
    aggregateSha256, partitions: [...evidence].sort((a, b) => compare(a.fileName, b.fileName)), rows, locations, issues};
}
