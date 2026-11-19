import {describe, expect, it} from 'vitest';
import {reconcileOffline, type OfflineCandidate} from './reconciliation';

const row = (key = '001', amount = 100n): OfflineCandidate => ({
  identity: {namespace: 'synthetic-access', kind: 'trip', key}, evidenceHash: 'a'.repeat(64),
  fields: {customerId: 'C1', schedule: null}, money: {gross: amount}, pending: ['TAX_BASIS', 'HISTORY'],
});

describe('offline candidate reconciliation', () => {
  it('retains review gates on an exact match and never enables import', () => {
    const source = [row()], candidate = structuredClone(source), before = structuredClone({source, candidate});
    const result = reconcileOffline(source, candidate);
    expect(result).toMatchObject({comparison: 'MATCH', importEnabled: false, totals: {source: {gross: '1.00'}}});
    expect(result.blocked[0].pending).toEqual(['HISTORY', 'TAX_BASIS']);
    expect({source, candidate}).toEqual(before);
    result.blocked[0].identity.key = 'changed';
    expect(source[0].identity.key).toBe('001');
  });
  it('reports offsetting errors even when grand totals match', () => {
    const result = reconcileOffline([row('1', 100n), row('2', 200n)], [row('1', 101n), row('2', 199n)]);
    expect(result.totals.source).toEqual(result.totals.candidate);
    expect(result.comparison).toBe('DIFFERENT');
    expect(result.differences).toHaveLength(2);
  });
  it('reports missing and unexpected identities without coercing leading zeroes', () => {
    const result = reconcileOffline([row('001')], [row('1')]);
    expect(result.missing[0].key).toBe('001');
    expect(result.unexpected[0].key).toBe('1');
  });
  it('keeps namespaces and entity kinds distinct', () => {
    const a = row(), b = row(), c = row();
    b.identity.namespace = 'other'; c.identity.kind = 'customer';
    expect(reconcileOffline([a, b, c], [c, a, b]).comparison).toBe('MATCH');
  });
  it('rejects duplicates on either side instead of overwriting evidence', () => {
    expect(() => reconcileOffline([row(), row()], [row()])).toThrow('Duplicate');
    expect(() => reconcileOffline([row()], [row(), row()])).toThrow('Duplicate');
  });
  it('preserves exact maximum amounts and aggregate sums beyond per-row limits', () => {
    const rows = [row('1', 999999999999999999n), row('2', 999999999999999999n)];
    expect(reconcileOffline(rows, rows).totals.source.gross).toBe('19999999999999999.98');
  });
  it('compares every component and evidence fingerprint independently', () => {
    const a = row(), b = row();
    a.money.vat = 0n; b.money.vat = 1n; b.evidenceHash = 'b'.repeat(64); b.fields.customerId = 'C2';
    expect(reconcileOffline([a], [b]).differences.map(d => d.field)).toEqual(['evidenceHash', 'fields.customerId', 'money.vat']);
  });
  it('distinguishes absent fields from null and zero', () => {
    const a = row(), b = row(); delete b.fields.schedule; b.money.vat = 0n;
    expect(reconcileOffline([a], [b]).differences.map(d => d.field)).toEqual(['fields.schedule:CANDIDATE_ABSENT', 'money.vat:SOURCE_ABSENT']);
  });
  it('does not let the candidate clear pending source decisions', () => {
    const a = row(), b = row(); b.pending = [];
    expect(reconcileOffline([a], [b]).blocked[0].pending).toEqual(['HISTORY', 'TAX_BASIS']);
  });
  it('rejects empty coverage, blank identities, inexact runtime money and out-of-range values', () => {
    expect(() => reconcileOffline([], [])).toThrow('coverage');
    const a = row(); a.identity.key = ' ';
    expect(() => reconcileOffline([a], [])).toThrow('identity');
    const b = row(); b.money.gross = 1 as unknown as bigint;
    expect(() => reconcileOffline([b], [])).toThrow('centavos');
    expect(() => reconcileOffline([row('1', 1000000000000000000n)], [])).toThrow('centavos');
  });
  it('produces stable results independent of input order', () => {
    const a = row('2'), b = row('1'), c = row('3');
    expect(reconcileOffline([a, b], [c, b])).toEqual(reconcileOffline([b, a], [b, c]));
  });
});
