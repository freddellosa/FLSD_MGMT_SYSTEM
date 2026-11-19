/** Source-side NS-1 preparation only. Destination identity and approvals remain deliberately unbound. */
import {createHash} from 'node:crypto';
import dictionary from '../../../docs/NORMALIZED_IMPORT_SNAPSHOT_CONTRACT.json';
import {canonicalReviewJson} from './canonical-review-json';
import {stageSixTableCsv, type SixTableKind} from './six-table-contract';
import {prepareSixTableTargetCandidates} from './six-table-target-candidates';
import {buildSixTableExceptionWorklist} from './six-table-exception-worklist';
import {normalizedContractSha256, normalizedCoverageSha256, normalizedSlotDefinitions, type NormalizedRecord, type NormalizedSlot, type SnapshotFile} from './normalized-snapshot';
import type {SixTablePlanFile, SixTablePlanScope} from './six-table-import-plan';
import type {ReviewGate} from './reconciliation';
import {accessMoney} from './access-staging';

const hash = (value: unknown) => createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
const present = (value: string) => !!value.trim() && !/^0+(?:\.0+)?$/.test(value.trim());
const invalidKeys = new Set(['MISSING_SOURCE_KEY', 'SOURCE_KEY_WHITESPACE_REQUIRES_REVIEW', 'DUPLICATE_SOURCE_KEY', 'DUPLICATE_IDENTITY']);

export function prepareNormalizedSource(files: readonly SixTablePlanFile[], scope: SixTablePlanScope, mappingCsv: string) {
  if (createHash('sha256').update(mappingCsv).digest('hex') !== dictionary.fieldMapSha256) throw new Error('NS-1 field map changed; review dictionary before normalization');
  const prepared = prepareSixTableTargetCandidates(files, scope, mappingCsv), worklist = buildSixTableExceptionWorklist(prepared);
  const inventory: SnapshotFile[] = [], blockedFiles: string[] = [];
  for (const file of [...files].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
    const staged = stageSixTableCsv(file.table, new TextDecoder('utf-8', {fatal: true}).decode(file.bytes));
    if (staged.unknownHeaders.length) blockedFiles.push(file.id);
    inventory.push({id: file.id, table: file.table, sha256: createHash('sha256').update(file.bytes).digest('hex'), headers: staged.headers, rows: staged.rows.length});
  }
  const blockedRows = prepared.candidates.filter(c => c.issues.some(i => invalidKeys.has(i.code))).map(c => ({source: c.source, codes: c.issues.filter(i => invalidKeys.has(i.code)).map(i => i.code)}));
  const metadata = {kind: 'NORMALIZED_SOURCE_PREPARATION' as const, version: 'NS-1' as const, importEnabled: false as const, executionAuthorized: false as const,
    contractSha256: normalizedContractSha256, sourcePlanSha256: prepared.sourcePlanSha256, mappingSha256: prepared.mappingSha256,
    candidateEvidenceSha256: prepared.evidenceSha256, worklistSha256: worklist.evidenceSha256, sourceCases: worklist.counts.sourceCases,
    policyHeldRows: worklist.counts.policyHeldRows, blockedFiles, blockedRows};
  if (blockedFiles.length || blockedRows.length || !prepared.candidates.length) {
    const body = {...metadata, status: 'BLOCKED_SOURCE_STRUCTURE' as const, sourceSnapshot: null};
    return {...body, evidenceSha256: hash(body)};
  }
  const fileIndex = new Map(inventory.map(f => [f.id, f]));
  const records: NormalizedRecord[] = prepared.candidates.map(candidate => {
    const source = candidate.source, file = fileIndex.get(source.fileId)!;
    if (file.sha256 !== source.fileSha256 || hash(candidate.sourceEvidence) !== source.evidenceSha256) throw new Error('Source file/row provenance changed during normalization');
    const fields = new Map(candidate.fields.map(f => ['facts.' + f.targetTable + '.' + f.targetField, f]));
    const slots: NormalizedSlot[] = normalizedSlotDefinitions(source.table).map(definition => {
      const name = definition.name, raw = definition.sourceField === null ? undefined : candidate.sourceEvidence[definition.sourceField];
      const unknown = (reasonCode: string): NormalizedSlot => ({name, state: 'UNKNOWN', reasonCode});
      if (definition.type === 'EVIDENCE') {
        return !file.headers.includes(definition.sourceField!) ? {name, state: 'NOT_PRESENT'} : raw === '' ? {name, state: 'BLANK'} : {name, state: 'VALUE', value: raw};
      }
      if (name.startsWith('mapping.')) return unknown('DESTINATION_MAPPING_NOT_BOUND');
      if (name.startsWith('semantic.')) return unknown('SEMANTIC_FACT_REQUIRES_INDEPENDENT_REVIEW');
      if (!file.headers.includes(definition.sourceField!)) return unknown('SOURCE_COLUMN_NOT_PRESENT');
      if (definition.type === 'REFERENCE') {
        const optional = definition.sourceField === 'SOANo' || definition.sourceField === 'InvoiceNo';
        if (optional && !present(raw ?? '')) return {name, state: 'NOT_APPLICABLE', reasonCode: 'UNASSIGNED_SOURCE_REFERENCE', reviewRef: 'SOURCE_OPTIONAL_REFERENCE_SENTINEL_V1'};
        if (!raw?.trim()) return unknown('MISSING_SOURCE_REFERENCE');
        if (raw !== raw.trim()) return unknown('SOURCE_REFERENCE_WHITESPACE_REQUIRES_REVIEW');
        const kind: SixTableKind = definition.sourceField === 'SOANo' ? 'SOA_Tbl' : definition.sourceField === 'InvoiceNo' ? 'Invoice_Tbl' : definition.sourceField === 'CompanyID' ? 'company_tbl' : definition.sourceField === 'VehicleID' ? 'vehicle_tbl' : 'Driver_tbl';
        return {name, state: 'VALUE', value: {namespace: source.namespace, kind, key: raw}};
      }
      if (candidate.issues.some(i => i.field === definition.sourceField && i.code === 'INVALID_TYPED_VALUE')) return unknown('INVALID_TYPED_SOURCE_VALUE');
      if (definition.sourceField === 'DateOfTrip_End' && candidate.issues.some(i => i.code === 'SERVICE_END_BEFORE_START')) return unknown('SERVICE_END_BEFORE_START');
      const field = fields.get(name);
      if (!field) throw new Error('NS-1 dictionary and typed candidate mapping differ');
      if (field.value === null || (typeof field.value === 'string' && !field.value.trim())) return {name, state: 'BLANK'};
      const value = definition.type === 'NUMERIC(18,2)' ? accessMoney(String(field.value)).toString() : definition.type === 'INTEGER' ? String(field.value) : field.value;
      return {name, state: 'VALUE', value};
    });
    const pending: ReviewGate[] = ['HISTORY']; // No application identity or semantic approval is bound by this source adapter.
    if (source.table === 'Trips_Tbl' || source.table === 'Invoice_Tbl') pending.push('TAX_BASIS');
    if (source.table === 'Trips_Tbl') pending.push('WORKFLOW');
    if (candidate.issues.some(i => i.code === 'SERVICE_END_BEFORE_START' || (i.code === 'INVALID_TYPED_VALUE' && i.field?.startsWith('DateOfTrip')))) pending.push('SCHEDULE');
    return {identity: {namespace: source.namespace, kind: source.table, key: source.sourceKey}, sourceFileId: source.fileId, logicalRow: source.row,
      sourceEvidenceSha256: source.evidenceSha256, reviewState: candidate.state, pending, slots};
  });
  const expectedIdentities = records.map(r => ({...r.identity}));
  const coverageSha256 = normalizedCoverageSha256(inventory, expectedIdentities);
  const sourceSnapshot = {version: 'NS-1' as const, contractSha256: normalizedContractSha256, serviceScope: {...scope}, files: inventory, expectedIdentities, records, coverageSha256};
  const body = {...metadata, status: 'SOURCE_PREPARED_DESTINATION_UNBOUND' as const, sourceSnapshot};
  return {...body, evidenceSha256: hash(body)};
}
