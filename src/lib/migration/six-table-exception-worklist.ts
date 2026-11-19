/** Private offline exception evidence. No corrections, decisions or executable import operations. */
import {createHash} from 'node:crypto';
import {canonicalReviewJson} from './canonical-review-json';
import type {prepareSixTableTargetCandidates} from './six-table-target-candidates';

type Prepared = ReturnType<typeof prepareSixTableTargetCandidates>;
const hash = (value: unknown) => createHash('sha256').update(canonicalReviewJson(value)).digest('hex');
const valueFields = new Set(['DriverID', 'VehicleID', 'CompanyID', 'tmpInvoiceNo', 'SOANo', 'InvoiceNo', 'PlateNo', 'NoOfSeats', 'isActv', 'Active', 'NeedPO', 'NeedRequestor',
  'HireDate', 'DateOfTrip_Start', 'DateOfTrip_End', 'DateCreated', 'ApprovedDate', 'ReceivedDate', 'InvoiceDate', 'BaseAmount', 'OTFee', 'Gas', 'TollFee', 'ParkingFee', 'FoodExp', 'Lodging', 'Evat', 'InvoiceTotAmt']);
const relationshipFields: Record<string, string> = {'trip-customer': 'CompanyID', 'trip-driver': 'DriverID', 'trip-vehicle': 'VehicleID', 'trip-soa': 'SOANo', 'soa-invoice': 'InvoiceNo', 'invoice-soa': 'SOANo'};
const policyCode = 'FINANCIAL_RELATIONSHIP_STATUS_POLICY_REVIEW';

export function buildSixTableExceptionWorklist(prepared: Prepared) {
  const policyHolds = new Map<string, number>(), seen = new Set<string>();
  const cases = prepared.candidates.flatMap(candidate => {
    if (candidate.issues.some(i => i.code === policyCode)) policyHolds.set(candidate.source.table, (policyHolds.get(candidate.source.table) ?? 0) + 1);
    return candidate.issues.filter(i => i.code !== policyCode).flatMap(issue => {
      const identity = {source: candidate.source, code: issue.code, field: issue.field, mappingSha256: prepared.mappingSha256};
      const caseId = hash(identity);
      if (seen.has(caseId)) return [];
      seen.add(caseId);
      const selected = issue.code === 'SERVICE_END_BEFORE_START' ? ['DateOfTrip_Start', 'DateOfTrip_End'] :
        issue.field ? [relationshipFields[issue.field] ?? issue.field] : [];
      const evidence = selected.map(field => ({field, present: Object.hasOwn(candidate.sourceEvidence, field),
        // Never copy display names, payroll, cheque/OR details or arbitrary full rows.
        value: valueFields.has(field) ? candidate.sourceEvidence[field] ?? null : null,
        valueWithheld: !valueFields.has(field)}));
      const guidance = issue.code === 'SERVICE_END_BEFORE_START' ? 'Verify source start/end date and time. Do not assume overnight rollover or rewrite either timestamp.' :
        issue.field === 'PlateNo' ? 'Verify the source vehicle plate. Keep the original vehicle key; do not merge by plate or invent a value.' :
          issue.code === 'MASTER_CANDIDATE_QUARANTINED' ? 'Resolve the referenced master evidence first; existence of its key alone does not clear the dependency.' :
            'Review the indicated source field, header or relationship against its file version. Do not apply defaults or automatic corrections.';
      return [{caseId, source: candidate.source, code: issue.code, field: issue.field, evidence,
        state: 'OPEN_SOURCE_REVIEW' as const, guidance}];
    });
  }).sort((a, b) => a.source.fileId < b.source.fileId ? -1 : a.source.fileId > b.source.fileId ? 1 : a.source.row - b.source.row || a.caseId.localeCompare(b.caseId));
  const holds = [...policyHolds].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([table, rows]) => ({table, rows}));
  const body = {kind: 'SIX_TABLE_EXCEPTION_WORKLIST' as const, version: 1, importEnabled: false as const, executionAuthorized: false as const,
    sourcePlanSha256: prepared.sourcePlanSha256, mappingSha256: prepared.mappingSha256, candidateEvidenceSha256: prepared.evidenceSha256,
    counts: {sourceCases: cases.length, affectedRows: new Set(cases.map(c => JSON.stringify([c.source.fileId, c.source.row]))).size,
      policyHeldRows: holds.reduce((total, h) => total + h.rows, 0)},
    cases, policyHolds: holds,
    independentReviews: ['Billing exceptions and customer/document ownership remain in their separate evidence worklist; this report cannot close them.',
      'Partial-export missing SOAs remain reference-only under the Owner-confirmed policy; no fabricated parents or new per-reference approvals.',
      'No decisions are accepted or applied here. Regenerate from corrected supplied copies to bind fresh file and row evidence.',
      'All candidates still require reviewed authority/schema, reconciliation, database rehearsal/recovery and explicit execution approval.']};
  return {...body, evidenceSha256: hash(body)};
}
export type SixTableExceptionWorklist = ReturnType<typeof buildSixTableExceptionWorklist>;

// Encode Markdown/HTML controls so source keys and values cannot become links, markup or table columns.
const cell = (value: string | number | null) => String(value ?? '(not supplied)').replace(/[&<>"'`|\[\]\\*_{}:()@!~\r\n]/g, c => `&#${c.charCodeAt(0)};`);
export function renderSixTableExceptionMarkdown(report: SixTableExceptionWorklist) {
  return ['# Private six-table source exception worklist', '',
    'Review only. No import, correction, decision application or posting is enabled.', '',
    `Source cases: ${report.counts.sourceCases}; affected rows: ${report.counts.affectedRows}. Separate policy-held rows: ${report.counts.policyHeldRows}.`, '',
    `Source-plan SHA256: ${cell(report.sourcePlanSha256)}`, `Mapping SHA256: ${cell(report.mappingSha256)}`, `Worklist SHA256: ${cell(report.evidenceSha256)}`, '',
    '| Table | Source ID | File | Logical row | Finding | Selected source evidence | Review guidance | Case SHA256 |',
    '| --- | --- | --- | ---: | --- | --- | --- | --- |',
    ...report.cases.map(c => `| ${cell(c.source.table)} | ${cell(c.source.sourceKey)} | ${cell(c.source.fileId)} | ${c.source.row} | ${cell(c.code)} | ${c.evidence.map(e => `${cell(e.field)}=${e.valueWithheld ? '(value withheld)' : cell(e.value)}`).join('; ')} | ${cell(c.guidance)} | ${cell(c.caseId)} |`), '',
    '## Separate policy holds', '', '| Source table | Rows |', '| --- | ---: |', ...report.policyHolds.map(h => `| ${cell(h.table)} | ${h.rows} |`), '',
    ...report.independentReviews.map(note => `- ${cell(note)}`), ''].join('\n');
}
