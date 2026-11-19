import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {describe, expect, it} from 'vitest';
import {canonicalReviewJson} from '../migration/canonical-review-json';
import {normalizedContractSha256, normalizedCoverageSha256, normalizedSlotDefinitions, type NormalizedSlot} from '../migration/normalized-snapshot';
import {reviewLegacyIdentityMappings} from '../migration/legacy-identity-review';
import {validateDestinationCapture, type DestinationCapture} from './destination-snapshot';
const hash = (value: unknown) => createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
const dict = JSON.parse(readFileSync('docs/NORMALIZED_IMPORT_SNAPSHOT_CONTRACT.json', 'utf8'));
function fixture() {
  const identity = {namespace: 'SYNTHETIC', kind: 'company_tbl' as const, key: '001'};
  const payload = {CompanyID: '001', CompanyName: 'Historical name', CompanyAddress: 'Address', TIN: '001', BusinessStyle: 'QA', NeedRequestor: 'Y', NeedPO: 'N'};
  const evidence = hash(payload), entityId = 'opaque-customer', entityVersion = '9007199254740993';
  const registry = {destinationId: 'SYNTHETIC-DEST', authorityVersion: 'PR-1', registryRevision: '2', mappings: [{identity, evidenceSha256: evidence, mappingSha256: dict.fieldMapSha256, entityId, entityVersion}]};
  const registryReview = reviewLegacyIdentityMappings(registry, registry.mappings);
  const slots: NormalizedSlot[] = normalizedSlotDefinitions('company_tbl').map(d => {
    if (d.name.startsWith('evidence.')) return {name: d.name, state: 'VALUE', value: payload[d.sourceField as keyof typeof payload]};
    if (d.name === 'mapping.applicationEntityId') return {name: d.name, state: 'VALUE', value: entityId, reviewRef: 'repository-read'};
    if (d.name === 'mapping.expectedEntityVersion') return {name: d.name, state: 'VALUE', value: entityVersion, reviewRef: 'repository-read'};
    if (d.name.startsWith('mapping.')) return {name: d.name, state: 'VALUE', value: 'REVIEW_PENDING', reviewRef: 'repository-read'};
    if (d.name.startsWith('semantic.')) return {name: d.name, state: 'UNKNOWN', reasonCode: 'NO_APPROVED_TAX_CLASSIFICATION'};
    return {name: d.name, state: 'VALUE', value: d.type === 'BOOLEAN' ? d.sourceField === 'NeedRequestor' : d.sourceField === 'CompanyName' ? 'Independent stored name' : payload[d.sourceField as keyof typeof payload]};
  });
  const files = [{id: 'company.csv', table: 'company_tbl' as const, sha256: hash('file'), headers: Object.keys(payload), rows: 1}];
  const capture: DestinationCapture = {captureId: 'synthetic-read', destinationId: registry.destinationId, authorityVersion: registry.authorityVersion, revisionStart: '7', revisionEnd: '7', registry,
    snapshot: {version: 'NS-1', contractSha256: normalizedContractSha256, expectedIdentities: [identity], files,
      records: [{identity, sourceFileId: 'company.csv', logicalRow: 2, sourceEvidenceSha256: evidence, reviewState: 'QUARANTINED', pending: ['TAX_BASIS'], slots}],
      binding: {sourcePlanSha256: evidence, mappingSha256: dict.fieldMapSha256, candidateEvidenceSha256: evidence, worklistSha256: evidence, identityReviewSha256: registryReview.evidenceSha256,
        registrySha256: registryReview.registrySha256, destinationId: registry.destinationId, authorityVersion: registry.authorityVersion, destinationRevision: '7', namespace: 'SYNTHETIC', serviceFrom: '2026-09-01', serviceThrough: '2026-10-31', retainMissingSoaReferences: true}}};
  return {capture, coverage: normalizedCoverageSha256(files, [identity]), registryHash: registryReview.registrySha256};
}
describe('DS-1 disconnected destination capture', () => {
  it('validates exact identities/large versions without copying stored facts from historical labels or clearing gates', () => {
    const f = fixture(), before = structuredClone(f.capture), result = validateDestinationCapture(f.capture, f.coverage, f.registryHash);
    expect(result).toMatchObject({rows: 1, importEnabled: false, executionAuthorized: false});
    expect(result.comparisonSnapshot.records[0].fields['facts.customers.registered_name']).toBe('Independent stored name');
    expect(result.comparisonSnapshot.records[0].pending).toContain('TAX_BASIS'); expect(f.capture).toEqual(before);
  });
  it('rejects mixed read revisions and a different destination', () => {
    const f = fixture(); f.capture.revisionEnd = '8'; expect(() => validateDestinationCapture(f.capture, f.coverage, f.registryHash)).toThrow('consistent revision');
    f.capture.revisionEnd = '7'; f.capture.destinationId = 'OTHER'; expect(() => validateDestinationCapture(f.capture, f.coverage, f.registryHash)).toThrow('identity');
  });
  it.each(['mapping.applicationEntityId', 'mapping.expectedEntityVersion'])('rejects incorrect %s despite a valid slot shape', name => {
    const f = fixture(), slot = f.capture.snapshot.records[0].slots.find(s => s.name === name)!;
    if (slot.state !== 'VALUE') throw new Error('fixture'); slot.value = name.endsWith('Version') ? '2' : 'other-entity';
    expect(() => validateDestinationCapture(f.capture, f.coverage, f.registryHash)).toThrow('ID/version');
  });
  it('rejects altered retained original evidence and stale registry', () => {
    const f = fixture(), slot = f.capture.snapshot.records[0].slots.find(s => s.name === 'evidence.CompanyName')!;
    if (slot.state !== 'VALUE') throw new Error('fixture'); slot.value = 'tampered';
    expect(() => validateDestinationCapture(f.capture, f.coverage, f.registryHash)).toThrow('original evidence');
    const stale = fixture(); stale.capture.registry.registryRevision = '3'; expect(() => validateDestinationCapture(stale.capture, stale.coverage, stale.registryHash)).toThrow('Registry evidence');
  });
});
