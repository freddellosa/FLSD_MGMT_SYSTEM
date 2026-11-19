/** Offline proposal adapter. Returned values are private review data, never write commands. */
import {createHash} from 'node:crypto';
import {parseCsv} from './csv';
import {canonicalReviewJson} from './canonical-review-json';
import {buildSixTableImportPlan, type SixTablePlanFile, type SixTablePlanScope} from './six-table-import-plan';
import {stageSixTableCsv, sixTableSchemas, type SixTableKind} from './six-table-contract';
import {parseLegacyDate} from './trips';
import {accessMoney} from './access-staging';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const dispositions = new Set(['IDENTITY_MAP', 'TYPED_AFTER_VALIDATION', 'EXCLUDED', 'RESOLVE_SOURCE_FK', 'RETAIN_ORIGINAL_EVIDENCE', 'REVIEW_AMOUNT_OR_ALIAS', 'RECORDED_TAX_EVIDENCE', 'EXACT_COMPONENT_REVIEW', 'EXACT_RECORDED_GROSS', 'REVIEW_MEMBERSHIP', 'REVIEW_DOCUMENT_LINK']);
const moneyDispositions = new Set(['RECORDED_TAX_EVIDENCE', 'EXACT_COMPONENT_REVIEW', 'EXACT_RECORDED_GROSS']);
type Issue = {field: string | null; code: string};
type Field = {sourceField: string; targetTable: string; targetField: string; type: string; value: string | boolean | number | null};
const requiredValues: Partial<Record<SixTableKind, readonly string[]>> = {
  Driver_tbl: ['DriverName'], vehicle_tbl: ['MakeModel', 'PlateNo'], company_tbl: ['CompanyName'], Trips_Tbl: ['DateOfTrip_Start'],
};
const referenceTargets: Record<string, SixTableKind> = {CompanyID: 'company_tbl', DriverID: 'Driver_tbl', VehicleID: 'vehicle_tbl'};

function fieldMap(text: string) {
  if (text.length > 1024 * 1024) throw new Error('Bounded field map required');
  const rows = parseCsv(text, {strictQuotes: true});
  const expected = Object.entries(sixTableSchemas).flatMap(([table, schema]) => schema.headers.map(field => JSON.stringify([table, field])));
  const keys = rows.map(r => JSON.stringify([r.source_table, r.source_field]));
  if (rows.length !== expected.length || new Set(keys).size !== keys.length || expected.some(k => !keys.includes(k))) throw new Error('Complete exact six-table field map required');
  for (const row of rows) {
    const schema = sixTableSchemas[row.source_table as SixTableKind];
    if (!dispositions.has(row.disposition) || !row.proposed_target_table || !row.proposed_target_field || !row.proposed_type ||
      schema.excluded.includes(row.source_field as never) !== (row.disposition === 'EXCLUDED') ||
      (row.source_field === schema.key) !== (row.disposition === 'IDENTITY_MAP') ||
      (row.disposition === 'RESOLVE_SOURCE_FK' && (row.source_table !== 'Trips_Tbl' || !Object.hasOwn(referenceTargets, row.source_field))) ||
      (row.disposition === 'TYPED_AFTER_VALIDATION' && !['TEXT', 'BOOLEAN', 'INTEGER', 'DATE', 'TIMESTAMP WITHOUT TIME ZONE'].includes(row.proposed_type)) ||
      (moneyDispositions.has(row.disposition) && row.proposed_type !== 'NUMERIC(18,2)')) throw new Error('Unsupported or unsafe field-map contract');
  }
  return rows;
}

function convert(raw: string | undefined, type: string): Field['value'] {
  if (raw === undefined || !raw.trim()) return null;
  if (type === 'TEXT') return raw; // No trimming, name merging or normalization.
  if (type === 'BOOLEAN') {
    if (/^(?:true|y|yes|-1|1)$/i.test(raw.trim())) return true;
    if (/^(?:false|n|no|0)$/i.test(raw.trim())) return false;
    throw new Error('Boolean encoding requires review');
  }
  if (type === 'INTEGER') {
    if (!/^\d+$/.test(raw.trim())) throw new Error('Nonnegative integer required');
    const value = BigInt(raw.trim());
    if (value > 2147483647n) throw new Error('PostgreSQL integer range exceeded');
    return Number(value);
  }
  if (type === 'NUMERIC(18,2)') {
    const cents = accessMoney(raw);
    if (cents > 999999999999999999n) throw new Error('Decimal range exceeded');
    return `${cents / 100n}.${(cents % 100n).toString().padStart(2, '0')}`;
  }
  const date = parseLegacyDate(raw);
  if (!date) throw new Error('Invalid local source timestamp');
  const local = date.toISOString().slice(0, 19);
  if (type === 'DATE') {
    if (local.slice(11) !== '00:00:00') throw new Error('Date would lose source time');
    return local.slice(0, 10);
  }
  return local; // Parser uses UTC only as a component container; no timezone conversion or Z stored.
}

export function prepareSixTableTargetCandidates(files: readonly SixTablePlanFile[], scope: SixTablePlanScope, mappingCsv: string) {
  const mapping = fieldMap(mappingCsv), plan = buildSixTableImportPlan(files, scope);
  const locator = (fileId: string, row: number) => JSON.stringify([fileId, row]);
  const records = new Map(plan.records.map(r => [locator(r.fileId, r.row), r]));
  const fileHashes = new Map(plan.files.map(f => [f.id, f.sha256]));
  const structuralIssues = new Map<string, Issue[]>();
  const addIssue = (location: {fileId: string; row: number}, issue: Issue) => {
    const id = locator(location.fileId, location.row), entries = structuralIssues.get(id) ?? [];
    entries.push(issue); structuralIssues.set(id, entries);
  };
  for (const duplicate of plan.duplicates) for (const location of duplicate.locations) addIssue(location, {field: null, code: 'DUPLICATE_IDENTITY'});
  for (const link of plan.issues) if (link.disposition !== 'RETAIN_REFERENCE') for (const location of link.sourceLocations) addIssue(location, {field: link.ruleId, code: `RELATIONSHIP_${link.code}`});
  for (const link of plan.documentLinkIssues) for (const location of [link.soaLocation, link.invoiceLocation]) addIssue(location, {field: null, code: 'REVERSE_DOCUMENT_LINK_REVIEW'});
  const candidates = [...files].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0).flatMap(file => {
    const staged = stageSixTableCsv(file.table, new TextDecoder('utf-8', {fatal: true}).decode(file.bytes));
    return staged.rows.map(row => {
      const issues: Issue[] = row.issues.map(code => ({field: null, code}));
      const fields: Field[] = [], sourceReferences: {field: string; table: SixTableKind; sourceKey: string | null}[] = [];
      const source = records.get(locator(file.id, row.logicalRow))!;
      if (staged.structuralStatus === 'REVIEW' && (staged.unknownHeaders.length || staged.missingOptional.length)) issues.push({field: null, code: 'SOURCE_HEADER_REVIEW'});
      issues.push(...(structuralIssues.get(locator(file.id, row.logicalRow)) ?? []));
      for (const m of mapping.filter(m => m.source_table === file.table)) {
        if (m.disposition === 'RESOLVE_SOURCE_FK') {
          const raw = row.payload[m.source_field];
          sourceReferences.push({field: m.source_field, table: referenceTargets[m.source_field], sourceKey: raw?.trim() ? raw : null});
        } else if (m.disposition === 'TYPED_AFTER_VALIDATION' || moneyDispositions.has(m.disposition)) {
          let value: Field['value'] = null, invalid = false;
          try {value = convert(row.payload[m.source_field], m.proposed_type);}
          catch {invalid = true; issues.push({field: m.source_field, code: 'INVALID_TYPED_VALUE'});}
          if (!invalid && value === null && (requiredValues[file.table]?.includes(m.source_field) || ['BOOLEAN', 'INTEGER', 'NUMERIC(18,2)'].includes(m.proposed_type))) issues.push({field: m.source_field, code: 'MISSING_OR_UNRESOLVED_TYPED_VALUE'});
          fields.push({sourceField: m.source_field, targetTable: m.proposed_target_table, targetField: m.proposed_target_field, type: m.proposed_type, value});
        }
      }
      if (file.table === 'Trips_Tbl') {
        const start = fields.find(f => f.sourceField === 'DateOfTrip_Start')?.value, end = fields.find(f => f.sourceField === 'DateOfTrip_End')?.value;
        if (typeof start === 'string' && typeof end === 'string' && end < start) issues.push({field: 'DateOfTrip_End', code: 'SERVICE_END_BEFORE_START'});
      }
      if (['Trips_Tbl', 'SOA_Tbl', 'Invoice_Tbl'].includes(file.table)) issues.push({field: null, code: 'FINANCIAL_RELATIONSHIP_STATUS_POLICY_REVIEW'});
      return {source: {namespace: scope.namespace, table: file.table, sourceKey: row.sourceKey, fileId: file.id, row: row.logicalRow,
        fileSha256: fileHashes.get(file.id)!, evidenceSha256: source.evidenceSha256},
        state: issues.length ? 'QUARANTINED' as const : 'CANDIDATE' as const, issues, fields, sourceReferences,
        // Sanitizer removed payroll and unknown values before this private evidence is retained.
        sourceEvidence: row.payload};
    });
  });
  const quarantinedMasters = new Set(candidates.filter(c => c.state === 'QUARANTINED' && ['Driver_tbl', 'vehicle_tbl', 'company_tbl'].includes(c.source.table)).map(c => JSON.stringify([c.source.table, c.source.sourceKey])));
  for (const candidate of candidates) for (const reference of candidate.sourceReferences) {
    if (quarantinedMasters.has(JSON.stringify([reference.table, reference.sourceKey]))) {
      candidate.issues.push({field: reference.field, code: 'MASTER_CANDIDATE_QUARANTINED'}); candidate.state = 'QUARANTINED';
    }
  }
  const body = {kind: 'SIX_TABLE_TARGET_CANDIDATES' as const, version: 1, importEnabled: false as const, executionAuthorized: false as const,
    releaseState: 'BLOCKED_PENDING_REVIEW_AND_DATABASE_AUTHORIZATION' as const, sourcePlanSha256: plan.evidenceSha256, mappingSha256: sha(mappingCsv),
    counts: {rows: candidates.length, candidates: candidates.filter(c => c.state === 'CANDIDATE').length, quarantined: candidates.filter(c => c.state === 'QUARANTINED').length},
    candidates, limitations: ['Private non-writing review values only; CANDIDATE does not mean approved or importable.',
      'No application/business IDs, active defaults, VAT category/basis, customer-name ownership, lifecycle state, receipts, allocations, balances or audit actors are inferred.',
      'Exact amounts are isolated source candidates, never additive aliases or approved financial authority. Blank values are not zero.',
      'Local timestamp components have no assigned timezone. Source status and dates are evidence, not new operational events.',
      'Mapping hashes bind a proposal, not authenticated approval. Required/nullability and operational mappings remain subject to reviewed DDL and rehearsal.']};
  return {...body, evidenceSha256: sha(canonicalReviewJson(body))};
}
