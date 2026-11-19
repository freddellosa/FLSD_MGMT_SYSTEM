import {describe, expect, it} from 'vitest';
import {reviewLegacyIdentityMappings, type LegacyIdentityCandidate, type LegacyIdentitySnapshot} from './legacy-identity-review';
const sha = 'a'.repeat(64), map = 'b'.repeat(64);
const candidate = (key = '001'): LegacyIdentityCandidate => ({identity: {namespace: 'QA-ACCESS', kind: 'Trips_Tbl', key}, evidenceSha256: sha, mappingSha256: map});
function snapshot(): LegacyIdentitySnapshot {return {destinationId: 'SYNTHETIC-DESTINATION', authorityVersion: 'PROPOSED-V1', registryRevision: '9007199254740993',
  mappings: [{...candidate(), entityId: 'existing-trip', entityVersion: '9007199254740994'}]};}
describe('legacy source identity revision review', () => {
  it('reuses only a supplied mapping and preserves exact leading-zero keys and bigint revisions', () => {
    const report = reviewLegacyIdentityMappings(snapshot(), [candidate()]);
    expect(report).toMatchObject({importEnabled: false, executionAuthorized: false, counts: {unchanged: 1, revised: 0, new: 0}});
    expect(report.rows[0]).toMatchObject({identity: {key: '001'}, existingEntityId: 'existing-trip', expectedEntityVersion: '9007199254740994'});
    expect(report.limitations.join(' ')).toContain('does not prove unchanged operational');
  });
  it('does not equate integer-looking keys or assign new application/business IDs', () => {
    const report = reviewLegacyIdentityMappings(snapshot(), [candidate('1')]);
    expect(report.counts).toMatchObject({new: 1, unreferencedMappingsRetained: 1});
    expect(report.rows[0]).toMatchObject({existingEntityId: null, expectedEntityVersion: null});
    expect(report.rows[0]).not.toHaveProperty('businessNumber');
  });
  it.each(['evidenceSha256', 'mappingSha256'] as const)('requires reviewed revision when %s changes without rekeying', field => {
    const next = candidate(); next[field] = 'c'.repeat(64);
    const row = reviewLegacyIdentityMappings(snapshot(), [next]).rows[0];
    expect(row).toMatchObject({disposition: 'REVISED_EVIDENCE_REQUIRES_REVIEW', existingEntityId: 'existing-trip'});
    expect(row.priorEvidenceSha256).toBe(sha); expect(row.priorMappingSha256).toBe(map);
  });
  it('keeps namespace and entity kind distinct', () => {
    const other = candidate(); other.identity.namespace = 'OTHER';
    expect(reviewLegacyIdentityMappings(snapshot(), [other]).counts.new).toBe(1);
    other.identity.namespace = 'QA-ACCESS'; other.identity.kind = 'company_tbl';
    expect(reviewLegacyIdentityMappings(snapshot(), [other]).counts.new).toBe(1);
  });
  it('rejects duplicate candidate and baseline identities instead of selecting a version', () => {
    const baseline = snapshot();
    expect(() => reviewLegacyIdentityMappings(baseline, [candidate(), candidate()])).toThrow('Duplicate candidate');
    baseline.mappings = [...baseline.mappings, {...baseline.mappings[0], entityId: 'different-trip'}];
    expect(() => reviewLegacyIdentityMappings(baseline, [candidate()])).toThrow('Ambiguous registry');
  });
  it('refuses implicit multiple-source merges into the same typed entity', () => {
    const baseline = snapshot(); baseline.mappings = [...baseline.mappings, {...baseline.mappings[0], identity: {...candidate('002').identity}}];
    expect(() => reviewLegacyIdentityMappings(baseline, [candidate()])).toThrow('alias review');
  });
  it('binds destination, authority and revisions and rejects stale registry evidence', () => {
    const baseline = snapshot(), report = reviewLegacyIdentityMappings(baseline, [candidate()]);
    expect(reviewLegacyIdentityMappings(baseline, [candidate()], report.registrySha256).evidenceSha256).toBe(report.evidenceSha256);
    for (const changed of [{...baseline, destinationId: 'OTHER'}, {...baseline, authorityVersion: 'V2'}, {...baseline, registryRevision: '9007199254740994'}]) {
      expect(() => reviewLegacyIdentityMappings(changed, [candidate()], report.registrySha256)).toThrow('Registry evidence changed');
    }
  });
  it('retains mappings outside a partial source window and does not mutate the supplied registry', () => {
    const baseline = snapshot(), before = structuredClone(baseline);
    const report = reviewLegacyIdentityMappings(baseline, [candidate('002')]);
    expect(report.counts.unreferencedMappingsRetained).toBe(1); expect(baseline).toEqual(before);
    expect(report).not.toHaveProperty('deletes');
  });
  it('is deterministic across source and registry ordering', () => {
    const baseline = snapshot(); baseline.mappings = [...baseline.mappings, {...candidate('002'), entityId: 'second-trip', entityVersion: '1'}];
    const candidates = [candidate(), candidate('002')], report = reviewLegacyIdentityMappings(baseline, candidates);
    expect(reviewLegacyIdentityMappings({...baseline, mappings: [...baseline.mappings].reverse()}, [...candidates].reverse()).evidenceSha256).toBe(report.evidenceSha256);
  });
  it.each(['01', '-1', '1.0', '9223372036854775808'])('rejects noncanonical/out-of-range revision %s', registryRevision => {
    expect(() => reviewLegacyIdentityMappings({...snapshot(), registryRevision}, [candidate()])).toThrow('bigint revision');
  });
  it('rejects whitespace identity, missing coverage, invalid hash and zero entity version', () => {
    const bad = candidate(' 001'); expect(() => reviewLegacyIdentityMappings(snapshot(), [bad])).toThrow('identity text');
    expect(() => reviewLegacyIdentityMappings(snapshot(), [])).toThrow('coverage');
    expect(() => reviewLegacyIdentityMappings(snapshot(), [{...candidate(), evidenceSha256: 'invalid'}])).toThrow('SHA256');
    const baseline = snapshot(); baseline.mappings = [{...baseline.mappings[0], entityVersion: '0'}];
    expect(() => reviewLegacyIdentityMappings(baseline, [candidate()])).toThrow('bigint revision');
  });
});
