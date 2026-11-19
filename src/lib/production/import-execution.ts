/** Executable synthetic reference only. No DB provider, route, CLI or live posting adapter. */
import {createHash} from 'node:crypto';
import {canonicalReviewJson} from '../migration/canonical-review-json';
import {validateNormalizedSourceSnapshot, normalizedSlotDefinitions, type UnboundNormalizedSource, type NormalizedRecord} from '../migration/normalized-snapshot';
import {requirePermission} from '../security/permissions';
import {seedBusinessNumberCounter, proposeBusinessNumber, type BusinessNumberKind} from '../domain/business-numbering';
import {fromCentavos} from '../domain/billing';
import {parseLegacyDate} from '../migration/trips';
import type {SixTableKind} from '../migration/six-table-contract';
import type {ReviewImportRepository, ReviewImportTransaction, ReviewEntity, ReviewReceipt, ReviewActor} from './review-repository';
const hash = (value: unknown) => createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
const key = (namespace: string, kind: string, sourceKey: string) => JSON.stringify([namespace, kind, sourceKey]);
const kinds: SixTableKind[] = ['Driver_tbl', 'vehicle_tbl', 'company_tbl', 'Trips_Tbl', 'SOA_Tbl', 'Invoice_Tbl'];
const seriesKinds: Record<BusinessNumberKind, SixTableKind> = {TRIP: 'Trips_Tbl', DRIVER: 'Driver_tbl', VEHICLE: 'vehicle_tbl', COMPANY: 'company_tbl', SOA: 'SOA_Tbl'};
function text(value: string) {if (typeof value !== 'string' || !value.trim() || value.length > 160) throw new Error('Bounded command reference required');}
function exact(value: object, fields: string[]) {if (Object.keys(value).some(k => !fields.includes(k))) throw new Error('Unsupported import command fields');}
function environment(repository: ReviewImportRepository) {if (repository.environment !== 'DISCONNECTED_SYNTHETIC') throw new Error('Actual database import is not enabled');}
function authorize(tx: ReviewImportTransaction, bulk: boolean, kind?: SixTableKind) {
  const actor = tx.currentActor(); text(actor.id);
  if (bulk) for (const permission of ['master:write', 'trip:write', 'soa:write', 'invoice:write'] as const) requirePermission(actor.role, permission);
  else requirePermission(actor.role, kind === 'Trips_Tbl' ? 'trip:write' : kind === 'SOA_Tbl' ? 'soa:write' : 'master:write');
  return actor;
}
function prior(tx: ReviewImportTransaction, operationId: string, digest: string, actor: ReviewActor) {
  const previous = Object.hasOwn(tx.state.receipts, operationId) ? tx.state.receipts[operationId] : undefined;
  if (previous && (previous.actorId !== actor.id || previous.digest !== digest)) throw new Error('Operation ID reused for different actor or input');
  return previous ? {...structuredClone(previous.result), replayed: true as const, executionAuthorized: false as const} : null;
}
function commitReceipt(tx: ReviewImportTransaction, operationId: string, digest: string, actor: ReviewActor, action: string, result: ReviewReceipt['result']) {
  tx.state.receipts[operationId] = {actorId: actor.id, digest, result: structuredClone(result)};
  tx.state.audit.push({operationId, actorId: actor.id, action, subjects: [...result.entityIds]}); tx.checkpoint();
  return {...result, replayed: false as const, executionAuthorized: false as const};
}
function revision(tx: ReviewImportTransaction, expected: number) {if (!Number.isSafeInteger(expected) || expected < 0 || tx.state.revision !== expected) throw new Error('Repository revision changed; reload before retry');}

export function prepareSyntheticImportManifest(source: UnboundNormalizedSource, mappingSha256: string, expectedCoverageSha256: string, chunkSize = 100) {
  if (!Number.isSafeInteger(chunkSize) || chunkSize < 1 || chunkSize > 100) throw new Error('Chunk size must be 1 to 100');
  const validated = validateNormalizedSourceSnapshot(source, mappingSha256, expectedCoverageSha256);
  const body = {version: 'PR-1', mode: 'SYNTHETIC_REVIEW_ONLY', namespace: source.serviceScope.namespace,
    sourceSnapshotSha256: validated.sourceSnapshotSha256, contractSha256: validated.contractSha256, mappingSha256, coverageSha256: validated.coverageSha256,
    rows: source.records.length, chunkSize, chunks: Math.ceil(source.records.length / chunkSize)};
  return {...body, manifestSha256: hash(body)};
}
export type SyntheticImportManifest = ReturnType<typeof prepareSyntheticImportManifest>;
export type ImportChunkCommand = {operationId: string; batchId: string; chunkIndex: number; expectedRevision: number};

function typedFacts(row: NormalizedRecord): ReviewEntity['typedFacts'] {
  return Object.fromEntries(row.slots.filter(s => s.name.startsWith('facts.')).map(s => [s.name, s.state === 'VALUE' ? s.value as string | boolean : null]));
}
/** Exact serialization proposal for a future reviewed SQL adapter; no SQL is executed. */
export function decimalColumnsForReviewEntity(entity: ReviewEntity) {
  return Object.fromEntries(normalizedSlotDefinitions(entity.kind).filter(d => d.name.startsWith('facts.')).map(d => {
    const value = entity.typedFacts[d.name];
    return [d.name, d.type === 'NUMERIC(18,2)' && value !== null ? fromCentavos(BigInt(value as string)) : value];
  }));
}

export async function executeSyntheticImportChunk(repository: ReviewImportRepository, source: UnboundNormalizedSource, manifest: SyntheticImportManifest, command: ImportChunkCommand) {
  environment(repository); exact(command, ['operationId', 'batchId', 'chunkIndex', 'expectedRevision']); text(command.operationId); text(command.batchId);
  if (['__proto__', 'prototype', 'constructor'].includes(command.operationId)) throw new Error('Invalid operation ID');
  const expected = prepareSyntheticImportManifest(source, manifest.mappingSha256, manifest.coverageSha256, manifest.chunkSize);
  if (canonicalReviewJson(expected) !== canonicalReviewJson(manifest) || !Number.isSafeInteger(command.chunkIndex) || command.chunkIndex < 0 || command.chunkIndex >= manifest.chunks) throw new Error('Import manifest or chunk scope changed');
  const ordered = [...source.records].sort((a, b) => kinds.indexOf(a.identity.kind) - kinds.indexOf(b.identity.kind) || (key(a.identity.namespace, a.identity.kind, a.identity.key) < key(b.identity.namespace, b.identity.kind, b.identity.key) ? -1 : 1));
  const rows = ordered.slice(command.chunkIndex * manifest.chunkSize, (command.chunkIndex + 1) * manifest.chunkSize);
  const fileHashes = new Map(source.files.map(f => [f.id, f.sha256]));
  return repository.serializable(async tx => {
    const actor = authorize(tx, true), digest = hash({command, manifestSha256: manifest.manifestSha256, actor});
    const replay = prior(tx, command.operationId, digest, actor); if (replay) return replay;
    revision(tx, command.expectedRevision);
    const duplicateManifest = tx.state.batches.find(b => b.namespace === manifest.namespace && b.manifestSha256 === manifest.manifestSha256 && b.id !== command.batchId);
    if (duplicateManifest) throw new Error('Manifest already staged; resume the existing batch ID');
    let batch = tx.state.batches.find(b => b.id === command.batchId);
    if (!batch) {batch = {id: command.batchId, namespace: manifest.namespace, manifestSha256: manifest.manifestSha256, sourceSnapshotSha256: manifest.sourceSnapshotSha256, mappingSha256: manifest.mappingSha256, rows: manifest.rows, chunkSize: manifest.chunkSize, chunks: [], state: 'LOADING'}; tx.state.batches.push(batch);}
    if (batch.manifestSha256 !== manifest.manifestSha256 || batch.namespace !== manifest.namespace || batch.chunks.length !== command.chunkIndex) throw new Error('Batch/chunk changed or already committed; resume its original operation');
    for (const file of source.files) if (!tx.state.files.some(f => f.namespace === manifest.namespace && f.kind === file.table && f.sha256 === file.sha256)) tx.state.files.push({namespace: manifest.namespace, kind: file.table, sha256: file.sha256, filename: file.id, rows: file.rows});
    const entityIds: string[] = [];
    for (const row of rows) {
      const payload = Object.fromEntries(row.slots.filter(s => s.name.startsWith('evidence.') && s.state !== 'NOT_PRESENT').map(s => [s.name.slice(9), s.state === 'VALUE' ? s.value as string : '']));
      const fileSha256 = fileHashes.get(row.sourceFileId)!;
      const stored = tx.state.sourceRows.find(r => r.namespace === row.identity.namespace && r.kind === row.identity.kind && r.fileSha256 === fileSha256 && r.logicalRow === row.logicalRow);
      if (stored && (stored.evidenceSha256 !== row.sourceEvidenceSha256 || canonicalReviewJson(stored.payload) !== canonicalReviewJson(payload))) throw new Error('Immutable source version conflict');
      if (!stored) tx.state.sourceRows.push({namespace: row.identity.namespace, kind: row.identity.kind, key: row.identity.key, fileSha256, logicalRow: row.logicalRow, evidenceSha256: row.sourceEvidenceSha256, payload});
      const mapping = tx.state.mappings.find(m => key(m.namespace, m.kind, m.key) === key(row.identity.namespace, row.identity.kind, row.identity.key));
      if (mapping) {
        if (mapping.evidenceSha256 !== row.sourceEvidenceSha256 || mapping.mappingSha256 !== manifest.mappingSha256) throw new Error('Revised source evidence requires review; existing entity history is protected');
        entityIds.push(mapping.entityId); continue;
      }
      const foreignKeys: Record<string, string | null> = {};
      for (const slot of row.slots.filter(s => s.name.startsWith('references.') && s.state === 'VALUE')) {
        if (slot.state !== 'VALUE') continue;
        const field = slot.name.slice(11), target = slot.value as {namespace: string; kind: SixTableKind; key: string};
        if (field === 'InvoiceNo' || (field === 'SOANo' && row.identity.kind === 'Trips_Tbl')) continue; // Original references retained; no circular placeholder membership.
        const parent = tx.state.mappings.find(m => key(m.namespace, m.kind, m.key) === key(target.namespace, target.kind, target.key));
        if (!parent && ['CompanyID', 'DriverID', 'VehicleID'].includes(field)) throw new Error('Required master mapping missing');
        foreignKeys[field] = parent?.entityId ?? null;
      }
      const id = tx.newEntityId(), entity: ReviewEntity = {id, kind: row.identity.kind, version: '1', businessNumber: null, legacyBusinessNumber: row.identity.key,
        typedFacts: typedFacts(row), foreignKeys, reviewSlots: structuredClone(row.slots), visibility: 'REVIEW_HOLD'};
      tx.state.entities.push(entity); tx.state.history.push(structuredClone(entity));
      tx.state.mappings.push({...row.identity, entityId: id, evidenceSha256: row.sourceEvidenceSha256, mappingSha256: manifest.mappingSha256});
      entityIds.push(id); tx.checkpoint();
    }
    batch.chunks.push(command.chunkIndex); if (batch.chunks.length === manifest.chunks) batch.state = 'RECONCILING';
    return commitReceipt(tx, command.operationId, digest, actor, 'SYNTHETIC_IMPORT_CHUNK', {entityIds, batchId: batch.id, chunkIndex: command.chunkIndex, businessNumber: null});
  });
}

export type SeedCounterCommand = {operationId: string; expectedRevision: number; kind: BusinessNumberKind; reviewedNumbers: string[]; reviewRef: string; scope: 'COMPLETE_SYNTHETIC_HISTORY'};
export async function seedSyntheticBusinessCounter(repository: ReviewImportRepository, command: SeedCounterCommand) {
  environment(repository); exact(command, ['operationId', 'expectedRevision', 'kind', 'reviewedNumbers', 'reviewRef', 'scope']); text(command.operationId); text(command.reviewRef);
  if (command.scope !== 'COMPLETE_SYNTHETIC_HISTORY' || !Object.hasOwn(seriesKinds, command.kind)) throw new Error('Complete reviewed synthetic history required; no partial/live seed');
  if (['__proto__', 'prototype', 'constructor'].includes(command.operationId)) throw new Error('Invalid operation ID');
  const proposed = seedBusinessNumberCounter(command.kind, command.reviewedNumbers);
  return repository.serializable(async tx => {
    const actor = authorize(tx, true), digest = hash({command, actor}); const replay = prior(tx, command.operationId, digest, actor); if (replay) return replay;
    revision(tx, command.expectedRevision);
    if (tx.state.counters.some(c => c.kind === command.kind)) throw new Error('Counter already seeded');
    const stored = tx.state.entities.filter(e => e.kind === seriesKinds[command.kind]).map(e => e.businessNumber ?? e.legacyBusinessNumber).filter((v): v is string => v !== null && v !== undefined).sort();
    if (canonicalReviewJson(stored) !== canonicalReviewJson([...command.reviewedNumbers].sort())) throw new Error('Reviewed business-number coverage differs from stored history');
    tx.state.counters.push(proposed); tx.checkpoint();
    return commitReceipt(tx, command.operationId, digest, actor, 'SYNTHETIC_SEED_COUNTER', {entityIds: [], batchId: null, chunkIndex: null, businessNumber: null});
  });
}

export type NumberedCreateCommand = {operationId: string; expectedRevision: number; kind: BusinessNumberKind; expectedCounterRevision: number; typedFacts: Record<string, string | boolean | null>};
export async function createSyntheticNumberedEntity(repository: ReviewImportRepository, command: NumberedCreateCommand) {
  environment(repository); exact(command, ['operationId', 'expectedRevision', 'kind', 'expectedCounterRevision', 'typedFacts']); text(command.operationId);
  if (!Object.hasOwn(seriesKinds, command.kind)) throw new Error('Official invoice stock is a separate workflow');
  if (['__proto__', 'prototype', 'constructor'].includes(command.operationId)) throw new Error('Invalid operation ID');
  const entityKind = seriesKinds[command.kind], definitions = normalizedSlotDefinitions(entityKind).filter(d => d.name.startsWith('facts.'));
  if (Object.keys(command.typedFacts).some(name => !definitions.some(d => d.name === name))) throw new Error('Unsupported numbered-entity fields');
  for (const [name, value] of Object.entries(command.typedFacts)) {
    const type = definitions.find(d => d.name === name)!.type;
    if (value !== null && ((type === 'BOOLEAN' && typeof value !== 'boolean') || (type !== 'BOOLEAN' && typeof value !== 'string'))) throw new Error('Explicit numbered-entity type required');
    if (value !== null && ['INTEGER', 'NUMERIC(18,2)'].includes(type) && (typeof value !== 'string' || !/^(?:0|[1-9]\d{0,18})$/.test(value) || BigInt(value) > (type === 'INTEGER' ? 2147483647n : 999999999999999999n))) throw new Error('Exact bounded numbered-entity amount/count required');
    if (typeof value === 'string' && (value.length > 16000 || value.includes('\0'))) throw new Error('Numbered-entity text bound exceeded');
    if (value !== null && ['DATE', 'TIMESTAMP WITHOUT TIME ZONE'].includes(type) && (typeof value !== 'string' || !(type === 'DATE' ? /^\d{4}-\d{2}-\d{2}$/ : /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/).test(value) || !parseLegacyDate(value))) throw new Error('Exact local numbered-entity date required');
  }
  return repository.serializable(async tx => {
    const actor = authorize(tx, false, entityKind), digest = hash({command, actor}); const replay = prior(tx, command.operationId, digest, actor); if (replay) return replay;
    revision(tx, command.expectedRevision); const i = tx.state.counters.findIndex(c => c.kind === command.kind); if (i < 0) throw new Error('Reviewed counter missing');
    const proposed = proposeBusinessNumber(tx.state.counters[i], command.expectedCounterRevision); tx.state.counters[i] = proposed.nextCounter; tx.checkpoint();
    const entity: ReviewEntity = {id: tx.newEntityId(), kind: entityKind, version: '1', businessNumber: proposed.businessNumber, legacyBusinessNumber: null,
      typedFacts: Object.fromEntries(definitions.map(d => [d.name, command.typedFacts[d.name] ?? null])), foreignKeys: {}, reviewSlots: [], visibility: 'REVIEW_HOLD'};
    tx.state.entities.push(entity); tx.state.history.push(structuredClone(entity)); tx.checkpoint();
    return commitReceipt(tx, command.operationId, digest, actor, 'SYNTHETIC_NUMBERED_CREATE', {entityIds: [entity.id], batchId: null, chunkIndex: null, businessNumber: proposed.businessNumber});
  });
}
