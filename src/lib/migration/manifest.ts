/** Offline manifest verification. Reads only caller-supplied bytes; no filesystem or database. */
import {createHash} from 'node:crypto';
import {reconcileOffline, type OfflineCandidate} from './reconciliation';

type SourceFile = {id: string; sha256: string; rows: number; recordType?: 'DATED' | 'MASTER'};
export type OfflineManifest = {
  version: 1;
  id: string;
  job: 'ACCESS_REVIEW' | 'PILOT_CONVERSION_REVIEW';
  namespace: string;
  mappingVersion: string;
  coverage: {from: string; through: string; cutoff: string; scope: 'SAMPLE' | 'DECLARED_HISTORY'};
  files: SourceFile[];
  /** Evidence references, never authorization or executable financial policy. */
  decisionReferences: string[];
};
export type LocatedCandidate = {fileId: string; row: number; serviceDate?: string; candidate: OfflineCandidate};
export type OfflineSourceFile = {id: string; bytes: Uint8Array; parsedRows: number};

const text = (v: string) => typeof v === 'string' && v.trim().length > 0;
function date(v: string) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const parsed = new Date(v + 'T00:00:00.000Z');
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === v;
}
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

function validateManifest(m: OfflineManifest) {
  if (m.version !== 1) throw new Error('Unsupported manifest version');
  if (!text(m.id) || !text(m.namespace) || !text(m.mappingVersion)) throw new Error('Manifest identity and mapping version required');
  if (!['ACCESS_REVIEW', 'PILOT_CONVERSION_REVIEW'].includes(m.job)) throw new Error('Unknown manifest job');
  const c = m.coverage;
  if (![c.from, c.through, c.cutoff].every(date) || c.from > c.through || c.through > c.cutoff) throw new Error('Invalid manifest coverage or cutoff');
  if (!['SAMPLE', 'DECLARED_HISTORY'].includes(c.scope)) throw new Error('Unknown coverage scope');
  if (!m.files.length) throw new Error('Manifest source files required');
  const ids = new Set<string>();
  for (const file of m.files) {
    if (!text(file.id) || ids.has(file.id)) throw new Error('Missing or duplicate source file identity');
    ids.add(file.id);
    if (!/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.rows) || file.rows < 0) throw new Error('Invalid source fingerprint or row count');
    if (file.recordType !== undefined && !['DATED', 'MASTER'].includes(file.recordType)) throw new Error('Invalid source record type');
  }
  if (m.decisionReferences.some(r => !text(r)) || new Set(m.decisionReferences).size !== m.decisionReferences.length) throw new Error('Invalid decision references');
}

/** Canonical manifest evidence, independent of file/reference ordering. Not an approval token. */
export function manifestFingerprint(manifest: OfflineManifest): string {
  validateManifest(manifest);
  const canonical = {
    version: manifest.version, id: manifest.id, job: manifest.job, namespace: manifest.namespace,
    mappingVersion: manifest.mappingVersion,
    coverage: {from: manifest.coverage.from, through: manifest.coverage.through, cutoff: manifest.coverage.cutoff, scope: manifest.coverage.scope},
    files: [...manifest.files].sort((a, b) => order(a.id, b.id)).map(f => ({id: f.id, sha256: f.sha256, rows: f.rows, recordType: f.recordType})),
    decisionReferences: [...manifest.decisionReferences].sort(order),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

/** All declared parsed rows require a located candidate; excluded rows need a separate reviewed scope. */
export function verifyOfflineManifest(manifest: OfflineManifest, files: readonly OfflineSourceFile[], records: readonly LocatedCandidate[]) {
  const fingerprint = manifestFingerprint(manifest);
  const declared = new Map(manifest.files.map(f => [f.id, f]));
  const observed = new Set<string>();
  for (const file of files) {
    if (observed.has(file.id)) throw new Error('Duplicate supplied source file');
    observed.add(file.id);
    const expected = declared.get(file.id);
    if (!expected) throw new Error('Unexpected supplied source file');
    const hash = createHash('sha256').update(file.bytes).digest('hex');
    if (hash !== expected.sha256) throw new Error('Source bytes do not match manifest fingerprint');
    if (!Number.isSafeInteger(file.parsedRows) || file.parsedRows !== expected.rows) throw new Error('Parsed source row count differs from manifest');
  }
  if (observed.size !== declared.size) throw new Error('Missing supplied source file');
  const locations = new Set<string>(), counts = new Map<string, number>();
  for (const record of records) {
    const file = declared.get(record.fileId);
    if (!file || !Number.isSafeInteger(record.row) || record.row < 2 || record.row > file.rows + 1) throw new Error('Invalid parsed-record locator');
    const locator = JSON.stringify([record.fileId, record.row]);
    if (locations.has(locator)) throw new Error('Duplicate parsed-record locator');
    locations.add(locator);
    counts.set(record.fileId, (counts.get(record.fileId) ?? 0) + 1);
    if (record.candidate.identity.namespace !== manifest.namespace) throw new Error('Candidate namespace differs from manifest');
    if (file.recordType === 'MASTER') {
      if (!['customer', 'vehicle', 'driver'].includes(record.candidate.identity.kind) || record.serviceDate !== undefined) throw new Error('Invalid date-independent master record');
    } else if (record.serviceDate === undefined || !date(record.serviceDate) || record.serviceDate < manifest.coverage.from || record.serviceDate > manifest.coverage.through) throw new Error('Candidate date outside declared coverage');
  }
  for (const file of manifest.files) if ((counts.get(file.id) ?? 0) !== file.rows) throw new Error('Incomplete parsed-record coverage');
  const candidates = records.map(r => r.candidate);
  // Reuse exact-money, duplicate-identity and review-gate validation without clearing gates.
  const comparison = reconcileOffline(candidates, candidates);
  return {importEnabled: false as const, fingerprint, scope: manifest.coverage.scope, rows: records.length,
    blocked: comparison.blocked, totals: comparison.totals.source};
}

/** Compare stored evidence for replay; callers must retain it outside this pure module. */
export function assertManifestReplay(previous: OfflineManifest, next: OfflineManifest) {
  if (previous.id !== next.id || manifestFingerprint(previous) !== manifestFingerprint(next)) throw new Error('Manifest replay content changed');
}
