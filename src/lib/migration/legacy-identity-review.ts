/** Offline identity/revision comparison only. No generated IDs, write intents, source merges or approvals. */
import {createHash} from 'node:crypto';
import {canonicalReviewJson} from './canonical-review-json';
import {sixTableSchemas, type SixTableKind} from './six-table-contract';

export type LegacyIdentity = {namespace: string; kind: SixTableKind; key: string};
export type LegacyIdentityCandidate = {identity: LegacyIdentity; evidenceSha256: string; mappingSha256: string};
export type LegacyIdentityMapping = LegacyIdentityCandidate & {entityId: string; entityVersion: string};
export type LegacyIdentitySnapshot = {destinationId: string; authorityVersion: string; registryRevision: string; mappings: readonly LegacyIdentityMapping[]};
const digest = (value: unknown) => createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
const id = (identity: LegacyIdentity) => JSON.stringify([identity.namespace, identity.kind, identity.key]);
const order = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
function boundedText(value: string, limit: number) {if (typeof value !== 'string' || !value.trim() || value !== value.trim() || value.length > limit || /[\u0000-\u001f]/.test(value)) throw new Error('Exact bounded nonblank identity text required');}
function version(value: string, allowZero: boolean) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > 9223372036854775807n || (!allowZero && value === '0')) throw new Error('Exact canonical bigint revision required');
}
function validate(candidate: LegacyIdentityCandidate) {
  boundedText(candidate.identity.namespace, 100); boundedText(candidate.identity.key, 1000);
  if (!Object.hasOwn(sixTableSchemas, candidate.identity.kind) || !/^[a-f0-9]{64}$/.test(candidate.evidenceSha256) || !/^[a-f0-9]{64}$/.test(candidate.mappingSha256)) throw new Error('Supported identity kind and evidence/mapping SHA256 required');
}

export function reviewLegacyIdentityMappings(snapshot: LegacyIdentitySnapshot, candidates: readonly LegacyIdentityCandidate[], expectedRegistrySha256?: string) {
  boundedText(snapshot.destinationId, 200); boundedText(snapshot.authorityVersion, 200); version(snapshot.registryRevision, true);
  if (!Array.isArray(snapshot.mappings) || !Array.isArray(candidates) || snapshot.mappings.length > 200000 || !candidates.length || candidates.length > 200000) throw new Error('Bounded registry and nonempty source coverage required');
  const existing = new Map<string, LegacyIdentityMapping>(), entities = new Set<string>();
  for (const mapping of snapshot.mappings) {
    validate(mapping); boundedText(mapping.entityId, 200); version(mapping.entityVersion, false);
    const key = id(mapping.identity), entityKey = JSON.stringify([mapping.identity.kind, mapping.entityId]);
    if (existing.has(key)) throw new Error('Ambiguous registry source identity');
    // This review has no alias/merge authority, including across namespaces.
    if (entities.has(entityKey)) throw new Error('Multiple source identities claim one entity; explicit alias review required');
    entities.add(entityKey); existing.set(key, mapping);
  }
  const registry = {destinationId: snapshot.destinationId, authorityVersion: snapshot.authorityVersion, registryRevision: snapshot.registryRevision,
    mappings: [...existing.values()].sort((a, b) => order(id(a.identity), id(b.identity)))};
  const registrySha256 = digest(registry);
  if (expectedRegistrySha256 !== undefined && expectedRegistrySha256 !== registrySha256) throw new Error('Registry evidence changed; regenerate review');
  const seen = new Set<string>();
  const rows = candidates.map(candidate => {
    validate(candidate); const key = id(candidate.identity);
    if (seen.has(key)) throw new Error('Duplicate candidate source identity; retain versions in source staging for review');
    seen.add(key); const previous = existing.get(key);
    const disposition = !previous ? 'NEW_IDENTITY_REQUIRES_REVIEW' as const : previous.evidenceSha256 !== candidate.evidenceSha256 || previous.mappingSha256 !== candidate.mappingSha256 ?
      'REVISED_EVIDENCE_REQUIRES_REVIEW' as const : 'UNCHANGED_SOURCE_IDENTITY' as const;
    return {identity: {...candidate.identity}, disposition, existingEntityId: previous?.entityId ?? null, expectedEntityVersion: previous?.entityVersion ?? null,
      sourceEvidenceSha256: candidate.evidenceSha256, mappingSha256: candidate.mappingSha256,
      priorEvidenceSha256: previous?.evidenceSha256 ?? null, priorMappingSha256: previous?.mappingSha256 ?? null};
  }).sort((a, b) => order(id(a.identity), id(b.identity)));
  const body = {kind: 'LEGACY_IDENTITY_REVIEW' as const, version: 1, importEnabled: false as const, executionAuthorized: false as const,
    destinationId: snapshot.destinationId, authorityVersion: snapshot.authorityVersion, registryRevision: snapshot.registryRevision, registrySha256,
    counts: {sourceIdentities: rows.length, unchanged: rows.filter(r => r.disposition === 'UNCHANGED_SOURCE_IDENTITY').length,
      revised: rows.filter(r => r.disposition === 'REVISED_EVIDENCE_REQUIRES_REVIEW').length, new: rows.filter(r => r.disposition === 'NEW_IDENTITY_REQUIRES_REVIEW').length,
      unreferencedMappingsRetained: snapshot.mappings.length - rows.filter(r => r.existingEntityId !== null).length}, rows,
    limitations: ['Supplied registry is comparison evidence, not a verified database read, authenticated approval or operation receipt.',
      'Unchanged source evidence does not prove unchanged operational entity values, financial policy or import eligibility.',
      'No IDs or business numbers are allocated. Revised evidence cannot overwrite existing operations, finalized documents or financial history.',
      'Unreferenced mappings remain retained; partial source windows never imply deletion. Alias/merge decisions are outside this review.',
      'A future authorized transaction must recheck destination, authority, registry/entity revisions, permissions and independent reconciliation.']};
  return {...body, evidenceSha256: digest(body)};
}
