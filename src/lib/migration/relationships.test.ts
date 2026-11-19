import {describe, expect, it} from 'vitest';
import {reviewRelationships, type RelationshipRule} from './relationships';
import type {OfflineCandidate} from './reconciliation';

const record = (kind: string, key: string, fields: Record<string, string | null> = {}, namespace = 'synthetic'): OfflineCandidate => ({identity: {namespace, kind, key}, evidenceHash: 'a'.repeat(64), fields, money: {}, pending: ['HISTORY']});
const rule: RelationshipRule = {id: 'trip-customer', sourceKind: 'trip', field: 'customerId', targetKind: 'customer', required: true};

describe('offline relationship review', () => {
  it('matches exact IDs without clearing policy gates or enabling import', () => {
    const rows = [record('trip', '001', {customerId: '01'}), record('customer', '01')], before = structuredClone(rows);
    const result = reviewRelationships(rows, [rule]);
    expect(result).toMatchObject({status: 'MATCH', importEnabled: false, counts: [{checked: 1, matched: 1}]});
    expect(rows).toEqual(before);
  });
  it('does not merge by display name or coerce whitespace and leading zeroes', () => {
    const rows = [record('trip', '1', {customerId: '1'}), record('trip', '2', {customerId: ' 01'}), record('customer', '01', {name: 'Same'})];
    expect(reviewRelationships(rows, [rule]).issues.map(i => i.code)).toEqual(['ORPHAN', 'ORPHAN']);
  });
  it('reports all references to duplicate targets as ambiguous and retains duplicate counts', () => {
    const rows = [record('trip', '1', {customerId: 'C'}), record('trip', '2', {customerId: 'C'}), record('customer', 'C'), record('customer', 'C')];
    const result = reviewRelationships(rows, [rule]);
    expect(result.issues.map(i => i.code)).toEqual(['AMBIGUOUS', 'AMBIGUOUS']);
    expect(result.duplicates[0].count).toBe(2);
  });
  it('does not resolve links across namespaces or entity kinds', () => {
    const rows = [record('trip', '1', {customerId: 'C'}), record('customer', 'C', {}, 'other'), record('driver', 'C')];
    expect(reviewRelationships(rows, [rule]).issues[0].code).toBe('ORPHAN');
  });
  it('distinguishes required blanks from explicitly optional unassigned references', () => {
    const rows = [record('trip', '1', {customerId: null}), record('trip', '2', {})];
    expect(reviewRelationships(rows, [rule]).issues).toHaveLength(2);
    expect(reviewRelationships(rows, [{...rule, required: false}])).toMatchObject({status: 'MATCH', counts: [{optionalUnassigned: 2, matched: 0}]});
  });
  it('checks customer scope independently of target existence', () => {
    const scoped: RelationshipRule = {id: 'allocation-trip', sourceKind: 'allocation', field: 'tripId', targetKind: 'trip', required: true, customerScope: {sourceField: 'customerId', targetField: 'customerId'}};
    const rows = [record('trip', 'T', {customerId: 'C1'}), record('allocation', 'A1', {tripId: 'T', customerId: 'C2'}), record('allocation', 'A2', {tripId: 'T'}), record('allocation', 'A3', {tripId: 'T', customerId: 'C1'})];
    expect(reviewRelationships(rows, [scoped])).toMatchObject({issues: [{code: 'SCOPE_MISMATCH'}, {code: 'SCOPE_MISSING'}], counts: [{matched: 1, checked: 3}]});
  });
  it('does not treat unchecked rules or unrelated duplicate identities as a clean result', () => {
    expect(reviewRelationships([record('driver', 'D')], [rule])).toMatchObject({status: 'REVIEW', uncheckedRules: ['trip-customer']});
    const rows = [record('trip', '1', {customerId: 'C'}), record('customer', 'C'), record('driver', 'D'), record('driver', 'D')];
    expect(reviewRelationships(rows, [rule]).status).toBe('REVIEW');
  });
  it('produces stable diagnostics independent of source and rule ordering', () => {
    const rows = [record('trip', '2', {customerId: 'missing'}), record('trip', '1', {})];
    const rules = [rule, {...rule, id: 'trip-driver', field: 'driverId', targetKind: 'driver'}];
    expect(reviewRelationships(rows, rules)).toEqual(reviewRelationships([...rows].reverse(), [...rules].reverse()));
  });
  it('rejects empty reviews and invalid or duplicate rules', () => {
    expect(() => reviewRelationships([], [rule])).toThrow('required');
    expect(() => reviewRelationships([record('trip', '1')], [])).toThrow('required');
    expect(() => reviewRelationships([record('trip', '1')], [rule, rule])).toThrow('Duplicate');
    expect(() => reviewRelationships([record('trip', '1')], [{...rule, field: ''}])).toThrow('Invalid');
  });
  it('returns copied identities so diagnostic edits cannot change source evidence', () => {
    const rows = [record('trip', '1', {customerId: 'missing'})];
    const result = reviewRelationships(rows, [rule]); result.issues[0].identity.key = 'edited';
    expect(rows[0].identity.key).toBe('1');
  });
});
