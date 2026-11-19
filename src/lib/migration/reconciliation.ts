/** Pure offline comparison contracts. No importer, policy approval or persistence. */
import {fromCentavos} from '../domain/billing';

export type SourceIdentity = {namespace: string; kind: string; key: string};
export type ReviewGate = 'TAX_BASIS' | 'WORKFLOW' | 'SCHEDULE' | 'HISTORY';
export type OfflineCandidate = {
  identity: SourceIdentity;
  /** Exact evidence fingerprint supplied by the offline adapter. */
  evidenceHash: string;
  fields: Record<string, string | null>;
  money: Record<string, bigint>;
  pending: ReviewGate[];
};
export type ReconciliationDifference = {
  identity: SourceIdentity;
  field: string;
  source: string | null;
  candidate: string | null;
};
export type OfflineReconciliation = {
  importEnabled: false;
  comparison: 'MATCH' | 'DIFFERENT';
  sourceCount: number;
  candidateCount: number;
  missing: SourceIdentity[];
  unexpected: SourceIdentity[];
  differences: ReconciliationDifference[];
  blocked: {identity: SourceIdentity; pending: ReviewGate[]}[];
  totals: {source: Record<string, string>; candidate: Record<string, string>};
};

const gates = new Set<ReviewGate>(['TAX_BASIS', 'WORKFLOW', 'SCHEDULE', 'HISTORY']);
const maxCentavos = 999999999999999999n;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const identityKey = (id: SourceIdentity) => JSON.stringify([id.namespace, id.kind, id.key]);
const copyIdentity = (id: SourceIdentity): SourceIdentity => ({...id});

function index(rows: readonly OfflineCandidate[]) {
  const result = new Map<string, OfflineCandidate>();
  for (const row of rows) {
    if ([row.identity.namespace, row.identity.kind, row.identity.key].some(v => typeof v !== 'string' || !v.trim())) {
      throw new Error('Source identity must contain nonblank text');
    }
    if (!/^[a-f0-9]{64}$/.test(row.evidenceHash)) throw new Error('Invalid evidence SHA-256');
    if (Object.values(row.fields).some(v => v !== null && typeof v !== 'string')) throw new Error('Invalid evidence field');
    if (Object.values(row.money).some(v => typeof v !== 'bigint' || v < -maxCentavos || v > maxCentavos)) {
      throw new Error('Money must be exact bounded centavos');
    }
    if (Object.keys(row.fields).some(k => Object.hasOwn(row.money, k))) throw new Error('Field and money names overlap');
    if (row.pending.some(g => !gates.has(g))) throw new Error('Unknown review gate');
    const key = identityKey(row.identity);
    if (result.has(key)) throw new Error('Duplicate source identity; resolve every affected row');
    result.set(key, row);
  }
  return result;
}

function totals(rows: readonly OfflineCandidate[]) {
  const sums = new Map<string, bigint>();
  for (const row of rows) for (const [name, amount] of Object.entries(row.money)) sums.set(name, (sums.get(name) ?? 0n) + amount);
  return Object.fromEntries([...sums].sort(([a], [b]) => compare(a, b)).map(([name, amount]) => [name, fromCentavos(amount)]));
}

/** Comparison success is evidence equality only, never import eligibility or approval. */
export function reconcileOffline(source: readonly OfflineCandidate[], candidate: readonly OfflineCandidate[]): OfflineReconciliation {
  if (!source.length) throw new Error('Source coverage must not be empty');
  const left = index(source), right = index(candidate);
  const missing: SourceIdentity[] = [], unexpected: SourceIdentity[] = [];
  const differences: ReconciliationDifference[] = [], blocked: OfflineReconciliation['blocked'] = [];
  const keys = [...new Set([...left.keys(), ...right.keys()])].sort(compare);
  for (const key of keys) {
    const a = left.get(key), b = right.get(key), identity = copyIdentity((a ?? b)!.identity);
    const pending = [...new Set([...(a?.pending ?? []), ...(b?.pending ?? [])])].sort(compare);
    if (pending.length) blocked.push({identity: copyIdentity(identity), pending});
    if (!a) { unexpected.push(identity); continue; }
    if (!b) { missing.push(identity); continue; }
    const add = (field: string, before: string | null, after: string | null) => {
      differences.push({identity: copyIdentity(identity), field, source: before, candidate: after});
    };
    if (a.evidenceHash !== b.evidenceHash) add('evidenceHash', a.evidenceHash, b.evidenceHash);
    for (const group of ['fields', 'money'] as const) {
      const names = [...new Set([...Object.keys(a[group]), ...Object.keys(b[group])])].sort(compare);
      for (const name of names) {
        const hasA = Object.hasOwn(a[group], name), hasB = Object.hasOwn(b[group], name);
        const before = hasA ? a[group][name] : undefined, after = hasB ? b[group][name] : undefined;
        if (hasA !== hasB || before !== after) {
          // Missing and explicit null remain distinct through the diagnostic field suffix.
          const render = (v: string | bigint | null | undefined) => typeof v === 'bigint' ? fromCentavos(v) : v ?? null;
          add(group + '.' + name + (!hasA ? ':SOURCE_ABSENT' : !hasB ? ':CANDIDATE_ABSENT' : ''), render(before), render(after));
        }
      }
    }
  }
  return {importEnabled: false, comparison: missing.length || unexpected.length || differences.length ? 'DIFFERENT' : 'MATCH',
    sourceCount: source.length, candidateCount: candidate.length, missing, unexpected, differences, blocked,
    totals: {source: totals(source), candidate: totals(candidate)}};
}
