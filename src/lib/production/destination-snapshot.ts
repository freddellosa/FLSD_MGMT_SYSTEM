/** Disconnected destination-export contract. Does not open a database or authenticate supplied exports. */
import {createHash} from 'node:crypto';
import {canonicalReviewJson} from '../migration/canonical-review-json';
import {reviewLegacyIdentityMappings, type LegacyIdentitySnapshot} from '../migration/legacy-identity-review';
import {assertNormalizedEvidenceHashes, validateAndProjectNormalizedSnapshot, type NormalizedSnapshot} from '../migration/normalized-snapshot';

export type DestinationCapture = {captureId: string; destinationId: string; authorityVersion: string; revisionStart: string; revisionEnd: string;
  registry: LegacyIdentitySnapshot; snapshot: NormalizedSnapshot};
const hash = (value: unknown) => createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
const key = (namespace: string, kind: string, sourceKey: string) => JSON.stringify([namespace, kind, sourceKey]);

export function validateDestinationCapture(capture: DestinationCapture, expectedCoverageSha256: string, expectedRegistrySha256: string) {
  if (typeof capture.captureId !== 'string' || !capture.captureId.trim() || capture.captureId.length > 200 ||
    capture.revisionStart !== capture.revisionEnd || capture.revisionStart !== capture.snapshot.binding.destinationRevision ||
    capture.destinationId !== capture.snapshot.binding.destinationId || capture.destinationId !== capture.registry.destinationId ||
    capture.authorityVersion !== capture.snapshot.binding.authorityVersion || capture.authorityVersion !== capture.registry.authorityVersion) throw new Error('Destination capture identity or consistent revision differs');
  const candidates = capture.snapshot.records.map(r => ({identity: {...r.identity}, evidenceSha256: r.sourceEvidenceSha256, mappingSha256: capture.snapshot.binding.mappingSha256}));
  const registryReview = reviewLegacyIdentityMappings(capture.registry, candidates, expectedRegistrySha256);
  if (capture.snapshot.binding.registrySha256 !== registryReview.registrySha256 || registryReview.counts.new || registryReview.counts.revised) throw new Error('Destination registry does not match retained source evidence');
  const validated = validateAndProjectNormalizedSnapshot(capture.snapshot, expectedCoverageSha256);
  assertNormalizedEvidenceHashes(capture.snapshot.records);
  const mappings = new Map(capture.registry.mappings.map(m => [key(m.identity.namespace, m.identity.kind, m.identity.key), m]));
  for (const row of capture.snapshot.records) {
    const mapping = mappings.get(key(row.identity.namespace, row.identity.kind, row.identity.key))!;
    for (const [name, expected] of [['mapping.applicationEntityId', mapping.entityId], ['mapping.expectedEntityVersion', mapping.entityVersion]] as const) {
      const slot = row.slots.find(s => s.name === name);
      if (slot?.state !== 'VALUE' || slot.value !== expected) throw new Error('Destination entity ID/version differs from registry');
    }
  }
  const body = {kind: 'DESTINATION_CAPTURE_VALIDATION' as const, version: 'DS-1', importEnabled: false as const, executionAuthorized: false as const,
    captureId: capture.captureId, destinationId: capture.destinationId, authorityVersion: capture.authorityVersion, revision: capture.revisionEnd,
    registryRevision: capture.registry.registryRevision, registrySha256: registryReview.registrySha256, coverageSha256: expectedCoverageSha256,
    captureSha256: hash(capture), rows: validated.comparisonSnapshot.records.length,
    limitations: ['Supplied export validation only; no actual database read, authentication or independent-origin proof is performed here.',
      'A trusted server reader must populate every NS-1 fact from stored authoritative values in one consistent read, never from source candidates.',
      'Destination shape/registry equality does not clear review gates, establish a receivable or authorize import/posting.']};
  return {...body, evidenceSha256: hash(body), comparisonSnapshot: validated.comparisonSnapshot};
}
