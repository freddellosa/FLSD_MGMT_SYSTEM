/** Offline exact-key relationship review. No merging, policy approval or persistence. */
import type {OfflineCandidate, SourceIdentity} from './reconciliation';

export type RelationshipRule = {
  id: string;
  sourceKind: string;
  field: string;
  targetKind: string;
  required: boolean;
  /** When supplied, both records must have equal nonblank customer scope. */
  customerScope?: {sourceField: string; targetField: string};
};
export type RelationshipIssue = {
  ruleId: string;
  identity: SourceIdentity;
  code: 'UNASSIGNED' | 'ORPHAN' | 'AMBIGUOUS' | 'SCOPE_MISSING' | 'SCOPE_MISMATCH';
  target: SourceIdentity | null;
};
const key = (id: SourceIdentity) => JSON.stringify([id.namespace, id.kind, id.key]);
const nonblank = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** All duplicates are retained in the index; references to them are ambiguous. */
export function reviewRelationships(records: readonly OfflineCandidate[], rules: readonly RelationshipRule[]) {
  if (!records.length || !rules.length) throw new Error('Records and explicit relationship rules required');
  const ruleIds = new Set<string>();
  for (const rule of rules) {
    if (![rule.id, rule.sourceKind, rule.field, rule.targetKind].every(nonblank) || typeof rule.required !== 'boolean') throw new Error('Invalid relationship rule');
    if (ruleIds.has(rule.id)) throw new Error('Duplicate relationship rule identity');
    ruleIds.add(rule.id);
    if (rule.customerScope && ![rule.customerScope.sourceField, rule.customerScope.targetField].every(nonblank)) throw new Error('Explicit customer scope fields required');
  }
  const index = new Map<string, OfflineCandidate[]>();
  for (const record of records) {
    if (![record.identity.namespace, record.identity.kind, record.identity.key].every(nonblank)) throw new Error('Invalid source identity');
    const id = key(record.identity);
    const matches = index.get(id) ?? [];
    matches.push(record); index.set(id, matches);
  }
  const duplicates = [...index.values()].filter(group => group.length > 1).map(group => ({identity: {...group[0].identity}, count: group.length}));
  duplicates.sort((a, b) => compare(key(a.identity), key(b.identity)));
  const issues: RelationshipIssue[] = [];
  const counts = rules.map(rule => ({ruleId: rule.id, checked: 0, matched: 0, optionalUnassigned: 0})).sort((a, b) => compare(a.ruleId, b.ruleId));
  const countsById = new Map(counts.map(c => [c.ruleId, c]));
  for (const record of records) for (const rule of rules) {
    if (record.identity.kind !== rule.sourceKind) continue;
    const count = countsById.get(rule.id)!; count.checked++;
    const value = Object.hasOwn(record.fields, rule.field) ? record.fields[rule.field] : null;
    const target: SourceIdentity | null = nonblank(value) ? {namespace: record.identity.namespace, kind: rule.targetKind, key: value} : null;
    const add = (code: RelationshipIssue['code']) => issues.push({ruleId: rule.id, identity: {...record.identity}, code, target: target ? {...target} : null});
    if (!target) {
      if (rule.required) add('UNASSIGNED'); else count.optionalUnassigned++;
      continue;
    }
    const matches = index.get(key(target)) ?? [];
    if (!matches.length) { add('ORPHAN'); continue; }
    if (matches.length !== 1) { add('AMBIGUOUS'); continue; }
    if (rule.customerScope) {
      const scope = rule.customerScope;
      const sourceCustomer = Object.hasOwn(record.fields, scope.sourceField) ? record.fields[scope.sourceField] : null;
      const targetCustomer = Object.hasOwn(matches[0].fields, scope.targetField) ? matches[0].fields[scope.targetField] : null;
      if (!nonblank(sourceCustomer) || !nonblank(targetCustomer)) { add('SCOPE_MISSING'); continue; }
      if (sourceCustomer !== targetCustomer) { add('SCOPE_MISMATCH'); continue; }
    }
    count.matched++;
  }
  issues.sort((a, b) => compare(JSON.stringify([key(a.identity), a.ruleId, a.code, a.target]), JSON.stringify([key(b.identity), b.ruleId, b.code, b.target])));
  const uncheckedRules = counts.filter(c => c.checked === 0).map(c => c.ruleId);
  return {importEnabled: false as const, status: issues.length || duplicates.length || uncheckedRules.length ? 'REVIEW' as const : 'MATCH' as const,
    issues, duplicates, uncheckedRules, counts};
}
