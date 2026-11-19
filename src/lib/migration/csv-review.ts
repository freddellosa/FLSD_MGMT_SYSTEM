/** Trusted offline bytes -> UTF-8 CSV -> explicit candidates -> coverage review. No I/O. */
import {createHash} from 'node:crypto';
import {parseCsv} from './csv';
import {buildOfflineCandidates, type CandidateMapping} from './candidate-adapter';
import {manifestFingerprint, verifyOfflineManifest, type LocatedCandidate, type OfflineManifest, type OfflineSourceFile} from './manifest';
import {reviewRelationships, type RelationshipRule} from './relationships';

export type CsvReviewFile = {id: string; bytes: Uint8Array; mapping: CandidateMapping};
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const canonicalColumns = (columns: Record<string, string>) => Object.entries(columns).sort(([a], [b]) => order(a, b));

/** Byte and row limits bound a synchronous offline review, not a production capacity claim. */
export function reviewCsvBytes(manifest: OfflineManifest, files: readonly CsvReviewFile[]) {
  const fingerprint = manifestFingerprint(manifest);
  if (manifest.job !== 'ACCESS_REVIEW') throw new Error('CSV review does not capture pilot history');
  const declared = new Map(manifest.files.map(f => [f.id, f]));
  const seen = new Set<string>();
  let totalBytes = 0;
  // Validate the entire source set before parsing any supplied content.
  for (const file of files) {
    const expected = declared.get(file.id);
    if (!expected || seen.has(file.id)) throw new Error('Unexpected or duplicate CSV file');
    seen.add(file.id);
    if (!(file.bytes instanceof Uint8Array)) throw new Error('CSV bytes required');
    totalBytes += file.bytes.byteLength;
    if (totalBytes > 20 * 1024 * 1024) throw new Error('Offline CSV review byte limit exceeded');
    if (hash(file.bytes) !== expected.sha256) throw new Error('CSV bytes differ from manifest');
    if (file.mapping.fileId !== file.id || file.mapping.namespace !== manifest.namespace) throw new Error('CSV mapping identity differs from manifest');
    if ((expected.recordType === 'MASTER') !== (file.mapping.dateColumn === null)) throw new Error('CSV date mapping differs from declared record type');
  }
  if (seen.size !== declared.size) throw new Error('Missing CSV source file');
  const records: LocatedCandidate[] = [], observed: OfflineSourceFile[] = [];
  const exceptions: ReturnType<typeof buildOfflineCandidates>['exceptions'] = [];
  let sourceRows = 0;
  const mappingEvidence = [];
  for (const file of [...files].sort((a, b) => order(a.id, b.id))) {
    let text: string;
    try { text = new TextDecoder('utf-8', {fatal: true}).decode(file.bytes); }
    catch { throw new Error('CSV must be valid UTF-8; no fallback encoding was inferred'); }
    if (text.includes('\0')) throw new Error('CSV contains unsupported NUL characters');
    const rows = parseCsv(text, {strictQuotes: true});
    sourceRows += rows.length;
    if (sourceRows > 100000) throw new Error('Offline CSV review row limit exceeded');
    if (rows.length !== declared.get(file.id)!.rows) throw new Error('Parsed CSV row count differs from manifest');
    const mapped = buildOfflineCandidates(rows, file.mapping);
    records.push(...mapped.records); exceptions.push(...mapped.exceptions);
    observed.push({id: file.id, bytes: file.bytes, parsedRows: rows.length});
    const m = file.mapping;
    mappingEvidence.push({fileId: m.fileId, namespace: m.namespace, kind: m.kind,
      idColumn: m.idColumn, dateColumn: m.dateColumn, fields: canonicalColumns(m.fields), money: canonicalColumns(m.money)});
  }
  // Mapping contents are bound in addition to the manifest's declared mapping version.
  const reviewFingerprint = hash(JSON.stringify({version: 1, manifestFingerprint: fingerprint, mappings: mappingEvidence}));
  if (exceptions.length) return {importEnabled: false as const, status: 'REJECTED' as const,
    fingerprint, reviewFingerprint, sourceRows, records, exceptions, verification: null};
  const verification = verifyOfflineManifest(manifest, observed, records);
  return {importEnabled: false as const, status: 'REVIEWED' as const,
    fingerprint, reviewFingerprint, sourceRows, records, exceptions, verification};
}

/** Combined byte/coverage and relationship evidence; rules are included in the evidence hash. */
export function reviewRelatedCsvBytes(manifest: OfflineManifest, files: readonly CsvReviewFile[], rules: readonly RelationshipRule[]) {
  const csv = reviewCsvBytes(manifest, files);
  const canonicalRules = [...rules].sort((a, b) => order(a.id, b.id)).map(r => ({id: r.id, sourceKind: r.sourceKind,
    field: r.field, targetKind: r.targetKind, required: r.required,
    customerScope: r.customerScope ? {sourceField: r.customerScope.sourceField, targetField: r.customerScope.targetField} : null}));
  const relationshipFingerprint = hash(JSON.stringify({version: 1, reviewFingerprint: csv.reviewFingerprint, rules: canonicalRules}));
  if (csv.status === 'REJECTED') return {...csv, relationshipFingerprint, relationships: null};
  const relationships = reviewRelationships(csv.records.map(r => r.candidate), rules);
  return {...csv, status: relationships.status === 'MATCH' ? 'REVIEWED' as const : 'REVIEW' as const, relationshipFingerprint, relationships};
}
