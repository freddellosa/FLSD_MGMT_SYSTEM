/** Disconnected, parameterized commit plans for schema review. No connection factory or SQL execution. */
import {canonicalReviewJson} from '../migration/canonical-review-json';
import {normalizedSlotDefinitions} from '../migration/normalized-snapshot';
import {decimalColumnsForReviewEntity} from './import-execution';
import type {ReviewRepositoryState, ReviewEntity} from './review-repository';
import type {SixTableKind} from '../migration/six-table-contract';
const tables: Record<SixTableKind, string> = {Driver_tbl: 'drivers', vehicle_tbl: 'vehicles', company_tbl: 'customers', Trips_Tbl: 'trips', SOA_Tbl: 'statements_of_account', Invoice_Tbl: 'invoices'};
const targetColumns: Record<SixTableKind, string> = {Driver_tbl: 'driver_id', vehicle_tbl: 'vehicle_id', company_tbl: 'customer_id', Trips_Tbl: 'trip_id', SOA_Tbl: 'soa_id', Invoice_Tbl: 'invoice_id'};
type Parameter = string | number | boolean | null;
export type ReviewSqlStatement = {text: string; values: Parameter[]; expectedRows?: number};
function identifier(value: string) {if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error('Static SQL identifier required'); return value;}
function insert(table: string, fields: Record<string, Parameter>): ReviewSqlStatement {
  const columns = Object.keys(fields).map(identifier);
  return {text: `INSERT INTO flsd_core_review.${identifier(table)} (${columns.join(',')}) VALUES (${columns.map((column, i) => '$' + (i + 1) + (['payload', 'result', 'snapshot', 'subjects'].includes(column) ? '::jsonb' : column === 'actor_id' ? '::uuid' : '')).join(',')})`, values: Object.values(fields), expectedRows: 1};
}
function entityStatements(entity: ReviewEntity) {
  if (entity.visibility !== 'REVIEW_HOLD') throw new Error('Operational activation is not implemented');
  const encoded = decimalColumnsForReviewEntity(entity), groups = new Map<string, Record<string, Parameter>>();
  const table = tables[entity.kind], main: Record<string, Parameter> = {id: entity.id, version: entity.version, business_number: entity.businessNumber, legacy_business_number: entity.legacyBusinessNumber ?? null, visibility: 'REVIEW_HOLD'};
  groups.set(table, main);
  const originalReference = (field: string) => {
    const slot = entity.reviewSlots.find(s => s.name === 'evidence.' + field);
    return slot?.state === 'VALUE' ? slot.value as string : slot?.state === 'BLANK' ? '' : null;
  };
  if (entity.kind === 'Trips_Tbl') main.legacy_soa_reference = originalReference('SOANo');
  if (entity.kind === 'SOA_Tbl') main.legacy_invoice_reference = originalReference('InvoiceNo');
  for (const definition of normalizedSlotDefinitions(entity.kind).filter(d => d.name.startsWith('facts.'))) {
    const [, target, column] = definition.name.split('.');
    if (![...Object.values(tables), 'trip_charges'].includes(target)) throw new Error('Unknown production fact table');
    const row = groups.get(target) ?? {id: entity.id}; row[column] = encoded[definition.name] ?? null; groups.set(target, row);
  }
  for (const [field, target] of Object.entries(entity.foreignKeys)) {
    const column = field === 'CompanyID' ? 'customer_id' : field === 'DriverID' ? 'driver_id' : field === 'VehicleID' ? 'vehicle_id' : field === 'SOANo' ? 'soa_id' : null;
    if (!column) throw new Error('Unknown typed FK'); main[column] = target;
  }
  return [...groups].map(([name, fields]) => insert(name, fields));
}

export function planPostgresReviewCommit(before: ReviewRepositoryState, after: ReviewRepositoryState) {
  const receipts = Object.entries(after.receipts).filter(([id]) => !Object.hasOwn(before.receipts, id));
  if (receipts.length !== 1 || after.revision !== before.revision + 1) throw new Error('One new atomic operation/revision required');
  for (const name of ['entities', 'mappings', 'files', 'sourceRows', 'history'] as const) if (before[name].some((row, i) => canonicalReviewJson(row) !== canonicalReviewJson(after[name][i])) || after[name].length < before[name].length) throw new Error('Immutable production history changed');
  const [operationId, receipt] = receipts[0];
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(receipt.actorId)) throw new Error('Shared authenticated actor UUID required');
  const audit = after.audit.find(a => a.operationId === operationId);
  if (!audit || audit.actorId !== receipt.actorId) throw new Error('Matching atomic audit required');
  const statements: ReviewSqlStatement[] = [];
  for (const batch of after.batches) {
    const previous = before.batches.find(b => b.id === batch.id);
    if (!previous) statements.push(insert('import_batches', {id: batch.id, source_namespace: batch.namespace, manifest_sha256: batch.manifestSha256, source_snapshot_sha256: batch.sourceSnapshotSha256, mapping_sha256: batch.mappingSha256, expected_rows: batch.rows, chunk_size: batch.chunkSize, state: batch.state}));
    else if (previous.state !== batch.state) statements.push({text: 'UPDATE flsd_core_review.import_batches SET state=$1 WHERE id=$2 AND state=$3', values: [batch.state, batch.id, previous.state], expectedRows: 1});
  }
  for (const file of after.files.slice(before.files.length)) statements.push(insert('import_file_versions', {source_namespace: file.namespace, source_kind: file.kind, file_sha256: file.sha256, filename: file.filename, row_count: file.rows}));
  for (const source of after.sourceRows.slice(before.sourceRows.length)) statements.push(insert('import_source_rows', {source_namespace: source.namespace, source_kind: source.kind, file_sha256: source.fileSha256, logical_row: source.logicalRow, source_key: source.key, evidence_sha256: source.evidenceSha256, payload: canonicalReviewJson(source.payload)}));
  const entities = [...after.entities.slice(before.entities.length)].sort((a, b) => Object.keys(tables).indexOf(a.kind) - Object.keys(tables).indexOf(b.kind));
  for (const entity of entities) statements.push(...entityStatements(entity));
  for (const mapping of after.mappings.slice(before.mappings.length)) statements.push(insert('legacy_entity_mappings', {source_namespace: mapping.namespace, source_kind: mapping.kind, source_key: mapping.key, source_evidence_sha256: mapping.evidenceSha256, mapping_sha256: mapping.mappingSha256, [targetColumns[mapping.kind]]: mapping.entityId}));
  statements.push(insert('import_operations', {operation_id: operationId, actor_id: receipt.actorId, request_digest: receipt.digest, batch_id: receipt.result.batchId, chunk_index: receipt.result.chunkIndex, result: canonicalReviewJson(receipt.result)}));
  for (const entity of after.history.slice(before.history.length)) statements.push(insert('entity_revisions', {id: entity.kind + ':' + entity.id + ':' + entity.version, version: entity.version, operation_id: operationId, [targetColumns[entity.kind]]: entity.id, snapshot: canonicalReviewJson(entity)}));
  for (const counter of after.counters) {
    const previous = before.counters.find(c => c.kind === counter.kind);
    if (!previous) statements.push(insert('business_number_counters', {kind: counter.kind, next_value: counter.next?.toString() ?? null, revision: counter.revision}));
    else if (previous.revision !== counter.revision) statements.push({text: 'UPDATE flsd_core_review.business_number_counters SET next_value=$1,revision=$2 WHERE kind=$3 AND revision=$4', values: [counter.next?.toString() ?? null, counter.revision, counter.kind, previous.revision], expectedRows: 1});
  }
  statements.push({text: "UPDATE flsd_core_review.repository_meta SET revision=$1 WHERE id=1 AND revision=$2 AND schema_version='PR-1' AND marker='FLSD_REVIEW_ONLY'", values: [after.revision, before.revision], expectedRows: 1});
  statements.push(insert('import_audit', {operation_id: operationId, actor_id: audit.actorId, action: audit.action, subjects: canonicalReviewJson(audit.subjects)}));
  return {kind: 'POSTGRES_REVIEW_COMMIT_PLAN' as const, schemaVersion: 'PR-1', executionAuthorized: false as const, postingEnabled: false as const,
    requiredIsolation: 'SERIALIZABLE' as const, requiredBeforeReading: {text: 'SELECT pg_advisory_xact_lock($1::bigint)', values: ['73785219460317']} as ReviewSqlStatement,
    statements, limitations: ['No statements are executed. A future approved server adapter must authenticate, lock before rereading, check affected-row counts and atomically commit all statements.',
      'Existing shared financial transaction/event handling must use the same transaction where relevant; this path never posts customer money.',
      'No SQL parser, installed-schema check, database concurrency or recovery evidence is supplied by this plan.']};
}
