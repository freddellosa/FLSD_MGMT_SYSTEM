/** NS-1 offline shape/coverage validation. No trusted origin, business approval, DB access or posting. */
import {createHash} from 'node:crypto';
import dictionary from '../../../docs/NORMALIZED_IMPORT_SNAPSHOT_CONTRACT.json';
import {canonicalReviewJson} from './canonical-review-json';
import {sixTableSchemas, type SixTableKind} from './six-table-contract';
import {validateImportComparisonBinding, type ImportComparisonBinding, type ImportComparisonSnapshot} from './import-reconciliation';
import type {LegacyIdentity} from './legacy-identity-review';
import type {OfflineCandidate, ReviewGate} from './reconciliation';
import {parseLegacyDate} from './trips';
import type {SixTablePlanScope} from './six-table-import-plan';

export type NormalizedSlot = {name: string; state: 'VALUE'; value: unknown; reviewRef?: string} |
  {name: string; state: 'BLANK' | 'NOT_PRESENT'} | {name: string; state: 'UNKNOWN'; reasonCode: string} |
  {name: string; state: 'NOT_APPLICABLE'; reasonCode: string; reviewRef: string};
export type SnapshotFile = {id: string; table: SixTableKind; sha256: string; headers: string[]; rows: number};
export type NormalizedRecord = {identity: LegacyIdentity; sourceFileId: string; logicalRow: number; sourceEvidenceSha256: string;
  reviewState: 'CANDIDATE' | 'QUARANTINED'; pending: ReviewGate[]; slots: NormalizedSlot[]};
type NormalizedData = {version: 'NS-1'; contractSha256: string;
  expectedIdentities: LegacyIdentity[]; files: SnapshotFile[]; records: NormalizedRecord[]};
export type NormalizedSnapshot = NormalizedData & {binding: ImportComparisonBinding};
export type UnboundNormalizedSource = NormalizedData & {serviceScope: SixTablePlanScope; coverageSha256: string};
const hash = (value: unknown) => createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
export const normalizedContractSha256 = hash(dictionary);
const identityKey = (id: LegacyIdentity) => JSON.stringify([id.namespace, id.kind, id.key]);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const checkHash = (text: string) => {if (!/^[a-f0-9]{64}$/.test(text)) throw new Error('Invalid snapshot evidence hash');};
function text(value: unknown, limit = 16000): asserts value is string {if (typeof value !== 'string' || !value.length || value.length > limit || value.includes('\0')) throw new Error('Bounded snapshot text required');}
function exactKeys(value: object, allowed: readonly string[]) {if (Object.keys(value).some(k => !allowed.includes(k))) throw new Error('Unsupported snapshot fields');}
function identity(value: LegacyIdentity) {
  exactKeys(value, ['namespace', 'kind', 'key']); text(value.namespace, 100); text(value.key, 1000);
  if (value.namespace !== value.namespace.trim() || value.key !== value.key.trim() || !Object.hasOwn(sixTableSchemas, value.kind)) throw new Error('Exact supported snapshot identity required');
}
function integer(value: unknown, maximum: bigint, positive = false) {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > maximum || (positive && value === '0')) throw new Error('Canonical bounded integer string required');
}
const gates: ReviewGate[] = ['TAX_BASIS', 'WORKFLOW', 'SCHEDULE', 'HISTORY'];

export function assertNormalizedEvidenceHashes(records: readonly NormalizedRecord[]) {
  for (const row of records) {
    const payload = Object.fromEntries(row.slots.filter(s => s.name.startsWith('evidence.') && s.state !== 'NOT_PRESENT').map(s => [s.name.slice(9), s.state === 'VALUE' ? s.value : '']));
    if (hash(payload) !== row.sourceEvidenceSha256) throw new Error('Normalized original evidence changed');
  }
}

/** Caller must supply a separately retained expected coverage digest; hashes still do not authenticate origin. */
export function normalizedCoverageSha256(files: readonly SnapshotFile[], identities: readonly LegacyIdentity[]) {
  return hash({files: [...files].sort((a, b) => compare(a.id, b.id)), identities: [...identities].sort((a, b) => compare(identityKey(a), identityKey(b)))});
}
export function normalizedSlotDefinitions(kind: SixTableKind) {
  const table = dictionary.tables.find(t => t.sourceTable === kind);
  if (!table) throw new Error('Unsupported snapshot kind');
  const semantic = dictionary.requiredSemanticSlots[kind];
  return [...table.requiredEvidenceSlots.map(name => ({name, type: 'EVIDENCE', sourceField: name.slice(9)})),
    ...table.typedSlots.map(s => ({name: s.slot, type: s.proposedType, sourceField: s.sourceField})),
    ...table.referenceSlots.map(s => ({name: s.slot, type: 'REFERENCE', sourceField: s.sourceField})),
    ...dictionary.requiredMappingSlots.map(name => ({name: 'mapping.' + name, type: name === 'expectedEntityVersion' ? 'VERSION' : 'TEXT', sourceField: null})),
    ...semantic.map(name => ({name: 'semantic.' + name, type: name === 'reviewedTripMemberships' ? 'MEMBERSHIPS' : name === 'reviewedCustomerSourceIdentity' ? 'CUSTOMER_IDENTITY' : 'TEXT', sourceField: null}))];
}
function members(value: unknown, namespace: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Current/historical membership sets required');
  exactKeys(value, ['current', 'historical']);
  const set = value as {current: unknown; historical: unknown};
  const group = (items: unknown) => {
    if (!Array.isArray(items) || items.length > 10000) throw new Error('Bounded membership list required');
    const seen = new Set<string>();
    for (const item of items) {
      if (!item || typeof item !== 'object') throw new Error('Membership entry required');
      exactKeys(item, ['identity', 'amountAtBilling']); identity(item.identity);
      const id = identityKey(item.identity);
      if (item.identity.namespace !== namespace || item.identity.kind !== 'Trips_Tbl' || seen.has(id)) throw new Error('Unique same-namespace trip membership required');
      seen.add(id);
      const amount = item.amountAtBilling;
      if (amount?.state === 'VALUE') {exactKeys(amount, ['state', 'value']); integer(amount.value, 999999999999999999n);}
      else if (amount?.state === 'UNKNOWN') {exactKeys(amount, ['state', 'reasonCode']); text(amount.reasonCode, 200);}
      else throw new Error('Explicit membership amount state required');
    }
    return [...items].sort((a, b) => compare(identityKey(a.identity), identityKey(b.identity)));
  };
  const current = group(set.current);
  if (!Array.isArray(set.historical) || set.historical.length > 1000) throw new Error('Bounded membership revision list required');
  const revisions = new Set<string>();
  const historical = set.historical.map(revision => {
    exactKeys(revision, ['revisionRef', 'members']); text(revision.revisionRef, 200);
    if (revisions.has(revision.revisionRef)) throw new Error('Duplicate membership revision');
    revisions.add(revision.revisionRef); return {revisionRef: revision.revisionRef, members: group(revision.members)};
  }).sort((a, b) => compare(a.revisionRef, b.revisionRef));
  return {current, historical};
}

function validateSnapshotRows(snapshot: NormalizedData, namespace: string, mappingSha256: string, expectedCoverageSha256: string) {
  if (snapshot.version !== 'NS-1' || snapshot.contractSha256 !== normalizedContractSha256) throw new Error('NS-1 dictionary changed; regenerate snapshot');
  checkHash(expectedCoverageSha256);
  if (mappingSha256 !== dictionary.fieldMapSha256) throw new Error('Dictionary mapping revision differs');
  if (!Array.isArray(snapshot.records) || !snapshot.records.length || snapshot.records.length > 200000 || !Array.isArray(snapshot.expectedIdentities) || snapshot.expectedIdentities.length > 200000 || !Array.isArray(snapshot.files) || !snapshot.files.length || snapshot.files.length > 64) throw new Error('Bounded nonempty snapshot coverage required');
  const expected = new Set<string>(), fileIndex = new Map<string, SnapshotFile>();
  for (const id of snapshot.expectedIdentities) {identity(id); const key = identityKey(id); if (id.namespace !== namespace || expected.has(key)) throw new Error('Unique scoped expected identities required'); expected.add(key);}
  for (const file of snapshot.files) {
    exactKeys(file, ['id', 'table', 'sha256', 'headers', 'rows']); text(file.id, 200); checkHash(file.sha256);
    if (/[/\\]/.test(file.id) || !Object.hasOwn(sixTableSchemas, file.table) || !Array.isArray(file.headers) || file.headers.length > 200 || new Set(file.headers).size !== file.headers.length || file.headers.some(h => !(sixTableSchemas[file.table].headers as readonly string[]).includes(h)) || !Number.isSafeInteger(file.rows) || file.rows < 0 || file.rows > 100000 || fileIndex.has(file.id)) throw new Error('Exact bounded source file/header inventory required');
    fileIndex.set(file.id, file);
  }
  const coverageSha256 = normalizedCoverageSha256(snapshot.files, snapshot.expectedIdentities);
  if (coverageSha256 !== expectedCoverageSha256) throw new Error('Approved expected coverage differs');
  const seen = new Set<string>(), locators = new Set<string>(), fileRows = new Map<string, number>(), stateCounts: Record<string, number> = {};
  let slotCount = 0;
  const records: OfflineCandidate[] = snapshot.records.map(row => {
    exactKeys(row, ['identity', 'sourceFileId', 'logicalRow', 'sourceEvidenceSha256', 'reviewState', 'pending', 'slots']); identity(row.identity); checkHash(row.sourceEvidenceSha256);
    const id = identityKey(row.identity), file = fileIndex.get(row.sourceFileId), location = JSON.stringify([row.sourceFileId, row.logicalRow]);
    if (!expected.has(id) || seen.has(id) || !file || file.table !== row.identity.kind || !Number.isSafeInteger(row.logicalRow) || row.logicalRow < 2 || row.logicalRow > file.rows + 1 || locators.has(location)) throw new Error('Source identity or file/row coverage differs');
    seen.add(id); locators.add(location); fileRows.set(file.id, (fileRows.get(file.id) ?? 0) + 1);
    if (!['CANDIDATE', 'QUARANTINED'].includes(row.reviewState) || !Array.isArray(row.pending) || row.pending.some(g => !gates.includes(g)) || !Array.isArray(row.slots)) throw new Error('Explicit row review state and gates required');
    slotCount += row.slots.length; if (slotCount > 2000000) throw new Error('Snapshot slot bound exceeded');
    const definitions = normalizedSlotDefinitions(row.identity.kind), slots = new Map(row.slots.map(s => [s.name, s]));
    if (slots.size !== row.slots.length || slots.size !== definitions.length || definitions.some(d => !slots.has(d.name))) throw new Error('Exact unique NS-1 slot coverage required');
    const fields: Record<string, string | null> = {}, money: Record<string, bigint> = {}, pending = new Set(row.pending);
    if (row.reviewState === 'QUARANTINED') pending.add('HISTORY');
    for (const definition of definitions) {
      const slot = slots.get(definition.name)!;
      if (!dictionary.slotStates.includes(slot.state)) throw new Error('Unsupported slot state');
      const allowed = slot.state === 'VALUE' ? ['name', 'state', 'value', 'reviewRef'] : slot.state === 'UNKNOWN' ? ['name', 'state', 'reasonCode'] : slot.state === 'NOT_APPLICABLE' ? ['name', 'state', 'reasonCode', 'reviewRef'] : ['name', 'state'];
      exactKeys(slot, allowed); fields[slot.name + '.state'] = slot.state; stateCounts[slot.state] = (stateCounts[slot.state] ?? 0) + 1;
      if (definition.type === 'EVIDENCE') {
        const present = file.headers.includes(definition.sourceField!);
        if ((!present && slot.state !== 'NOT_PRESENT') || (present && !['VALUE', 'BLANK'].includes(slot.state))) throw new Error('Evidence state differs from source header presence');
      }
      if (definition.type !== 'EVIDENCE' && definition.sourceField && !file.headers.includes(definition.sourceField) && !['UNKNOWN', 'NOT_PRESENT'].includes(slot.state)) throw new Error('Typed/reference value lacks source column');
      if (slot.state === 'NOT_PRESENT' && (definition.sourceField === null || file.headers.includes(definition.sourceField))) throw new Error('NOT_PRESENT requires absent original column');
      if (slot.state === 'UNKNOWN' || slot.state === 'NOT_APPLICABLE') {text(slot.reasonCode, 200); fields[slot.name + '.reasonCode'] = slot.reasonCode;}
      if (slot.state === 'NOT_APPLICABLE' || (slot.state === 'VALUE' && (slot.name.startsWith('semantic.') || slot.name.startsWith('mapping.')))) {
        text(slot.reviewRef, 200); fields[slot.name + '.reviewRef'] = slot.reviewRef;
      }
      if (slot.state === 'VALUE' && slot.reviewRef !== undefined) {text(slot.reviewRef, 200); fields[slot.name + '.reviewRef'] = slot.reviewRef;}
      if (slot.state !== 'VALUE') {
        if (definition.type === 'EVIDENCE' && slot.state === 'NOT_APPLICABLE') throw new Error('Original evidence cannot be not-applicable');
        if (definition.type !== 'EVIDENCE' && slot.state !== 'NOT_APPLICABLE') pending.add('HISTORY');
        continue;
      }
      let value = slot.value;
      if (definition.type === 'NUMERIC(18,2)') {integer(value, 999999999999999999n); money[slot.name] = BigInt(value as string);}
      else if (definition.type === 'INTEGER' || definition.type === 'VERSION') {integer(value, definition.type === 'INTEGER' ? 2147483647n : 9223372036854775807n, definition.type === 'VERSION'); fields[slot.name] = value as string;}
      else if (definition.type === 'BOOLEAN') {if (typeof value !== 'boolean') throw new Error('Boolean VALUE required'); fields[slot.name] = String(value);}
      else if (definition.type === 'DATE' || definition.type === 'TIMESTAMP WITHOUT TIME ZONE') {
        text(value, 30); const format = definition.type === 'DATE' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/;
        if (!format.test(value) || !parseLegacyDate(value)) throw new Error('Exact valid local date/time required'); fields[slot.name] = value;
      } else if (definition.type === 'REFERENCE' || definition.type === 'CUSTOMER_IDENTITY') {
        if (!value || typeof value !== 'object') throw new Error('Source reference identity required'); identity(value as LegacyIdentity);
        const target = value as LegacyIdentity;
        const targetKind = definition.type === 'CUSTOMER_IDENTITY' ? 'company_tbl' : definition.sourceField === 'SOANo' ? 'SOA_Tbl' : definition.sourceField === 'InvoiceNo' ? 'Invoice_Tbl' : definition.sourceField === 'CompanyID' ? 'company_tbl' : definition.sourceField === 'VehicleID' ? 'vehicle_tbl' : 'Driver_tbl';
        if (target.namespace !== row.identity.namespace || target.kind !== targetKind) throw new Error('Reference scope/type differs'); fields[slot.name] = identityKey(target);
      } else if (definition.type === 'MEMBERSHIPS') {
        value = members(value, row.identity.namespace); fields[slot.name] = canonicalReviewJson(value);
        if (canonicalReviewJson(value).includes('"state":"UNKNOWN"')) pending.add('HISTORY');
      } else {text(value); if (definition.type !== 'EVIDENCE' && !value.trim()) throw new Error('Use BLANK for whitespace-only typed values'); fields[slot.name] = value;}
    }
    const sourceKey = slots.get('evidence.' + sixTableSchemas[row.identity.kind].key);
    if (sourceKey?.state !== 'VALUE' || sourceKey.value !== row.identity.key) throw new Error('Original key evidence differs from identity');
    const start = slots.get('facts.trips.service_start_local'), end = slots.get('facts.trips.service_end_local');
    if (start?.state === 'VALUE' && end?.state === 'VALUE' && String(end.value) < String(start.value)) throw new Error('Service end precedes start; retain UNKNOWN and source evidence for review');
    return {identity: {...row.identity}, evidenceHash: row.sourceEvidenceSha256, fields, money, pending: [...pending].sort()};
  });
  if (seen.size !== expected.size || snapshot.files.some(f => (fileRows.get(f.id) ?? 0) !== f.rows)) throw new Error('Incomplete identity/file row coverage');
  return {coverageSha256, stateCounts, records};
}

export function validateAndProjectNormalizedSnapshot(snapshot: NormalizedSnapshot, expectedCoverageSha256: string) {
  exactKeys(snapshot, ['version', 'contractSha256', 'binding', 'expectedIdentities', 'files', 'records']);
  validateImportComparisonBinding(snapshot.binding);
  const {coverageSha256, stateCounts, records} = validateSnapshotRows(snapshot, snapshot.binding.namespace, snapshot.binding.mappingSha256, expectedCoverageSha256);
  if ((snapshot.binding.normalizationContractSha256 !== undefined && snapshot.binding.normalizationContractSha256 !== normalizedContractSha256) ||
    (snapshot.binding.normalizationCoverageSha256 !== undefined && snapshot.binding.normalizationCoverageSha256 !== coverageSha256)) throw new Error('Normalization binding differs');
  const comparisonSnapshot: ImportComparisonSnapshot = {binding: {...snapshot.binding, normalizationContractSha256: normalizedContractSha256, normalizationCoverageSha256: coverageSha256}, records};
  return {kind: 'NORMALIZED_SNAPSHOT_VALIDATION' as const, version: 'NS-1', importEnabled: false as const, executionAuthorized: false as const,
    contractSha256: normalizedContractSha256, coverageSha256, stateCounts, comparisonSnapshot,
    limitations: ['Shape/type/coverage checks only; supplied metadata and review references are not independently authenticated source or destination evidence.',
      'No financial gate, actual database compatibility, business approval or execution authorization is established.']};
}

/** Source-only path: no destination/registry labels are accepted or fabricated. */
export function validateNormalizedSourceSnapshot(source: UnboundNormalizedSource, mappingSha256: string, expectedCoverageSha256: string) {
  exactKeys(source, ['version', 'contractSha256', 'serviceScope', 'files', 'expectedIdentities', 'records', 'coverageSha256']);
  exactKeys(source.serviceScope, ['namespace', 'from', 'through', 'retainMissingSoaReferences']); text(source.serviceScope.namespace, 100);
  const day = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && !!parseLegacyDate(value);
  if (source.serviceScope.namespace !== source.serviceScope.namespace.trim() || !day(source.serviceScope.from) || !day(source.serviceScope.through) || source.serviceScope.from > source.serviceScope.through || typeof source.serviceScope.retainMissingSoaReferences !== 'boolean' || source.coverageSha256 !== expectedCoverageSha256) throw new Error('Exact source scope and expected coverage required');
  const checked = validateSnapshotRows(source, source.serviceScope.namespace, mappingSha256, expectedCoverageSha256);
  assertNormalizedEvidenceHashes(source.records);
  for (const row of source.records) {
    if (row.slots.some(s => (s.name.startsWith('mapping.') || s.name.startsWith('semantic.')) && s.state !== 'UNKNOWN')) throw new Error('Unbound source cannot claim reviewed mappings or semantic facts');
  }
  const gateCounts: Record<string, number> = {};
  for (const row of checked.records) for (const gate of row.pending) gateCounts[gate] = (gateCounts[gate] ?? 0) + 1;
  const body = {kind: 'NORMALIZED_SOURCE_VALIDATION' as const, version: 'NS-1', status: 'SOURCE_SHAPE_CHECKED_DESTINATION_UNBOUND' as const,
    importEnabled: false as const, executionAuthorized: false as const, contractSha256: normalizedContractSha256, mappingSha256,
    sourceSnapshotSha256: hash(source), coverageSha256: checked.coverageSha256,
    fileInventorySha256: hash(source.files.map(({id, table, rows, sha256}) => ({id, table, rows, sha256})).sort((a, b) => compare(a.id, b.id))), serviceScope: {...source.serviceScope},
    counts: {rows: checked.records.length, quarantinedRows: source.records.filter(r => r.reviewState === 'QUARANTINED').length, destinationUnboundRows: checked.records.length},
    stateCounts: checked.stateCounts, gateCounts,
    limitations: ['Validated source shape, supplied coverage and retained row hashes only; no destination, registry, approval or financial eligibility established.',
      'Expected coverage must come from separately retained source evidence. Hash equality alone cannot authenticate origin or reviewer decisions.']};
  return {...body, evidenceSha256: hash(body)};
}
