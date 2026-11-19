import {parseCsvTable} from './csv';
import {parseLegacyDate} from './trips';

export const customerReviewHeaders = ['CompanyID', 'SourceNameForReference', 'EffectiveFrom', 'EffectiveTo', 'VatClassification', 'BaseOtAmountBasis', 'EvidenceReference', 'Reviewer', 'ReviewDate', 'ReviewStatus', 'Notes'];
export const receivableReviewHeaders = ['InvoiceID', 'SOAID', 'CompanyID', 'AsOfDate', 'ApprovedOutstandingAmount', 'EvidenceReference', 'Reviewer', 'ReviewDate', 'ReviewStatus', 'Notes'];
type Context = {customerIds: readonly string[]; invoiceIds: readonly string[]; soaIds: readonly string[]};
type Issue = {row: number; field: string; code: string};
const validDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && parseLegacyDate(value) !== null;

/** Structural review only; never authorizes policy, balances, posting or importing. */
export function validateFinancialReviewResponses(kind: 'CUSTOMER' | 'RECEIVABLE', csv: string, context: Context) {
  const expected = kind === 'CUSTOMER' ? customerReviewHeaders : receivableReviewHeaders;
  const issues: Issue[] = [];
  const result = {issues, pendingRows: 0, submittedRows: 0, status: 'PENDING' as 'PENDING' | 'INVALID' | 'STRUCTURALLY_VALID_NOT_APPROVED', policyApproved: false as const, importEnabled: false as const, executionAuthorized: false as const};
  let parsed: ReturnType<typeof parseCsvTable>;
  try { parsed = parseCsvTable(csv, {strictQuotes: true}); }
  catch { issues.push({row: 1, field: 'CSV', code: 'INVALID_CSV'}); result.status = 'INVALID'; return result; }
  if (parsed.headers.length !== expected.length || new Set(parsed.headers).size !== expected.length || expected.some(h => !parsed.headers.includes(h))) {
    issues.push({row: 1, field: 'headers', code: 'EXACT_NAMED_HEADERS_REQUIRED'}); result.status = 'INVALID'; return result;
  }
  const periods: {id: string; from: string; to: string; row: number}[] = [];
  const invoices = new Set<string>();
  for (const [index, raw] of parsed.rows.entries()) {
    const row = index + 2, data = Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value.trim()]));
    const fail = (field: string, code: string) => issues.push({row, field, code});
    if (!context.customerIds.includes(data.CompanyID)) fail('CompanyID', 'UNKNOWN_CUSTOMER');
    if (data.ReviewStatus === 'PENDING') result.pendingRows++;
    else if (data.ReviewStatus === 'SUBMITTED') result.submittedRows++;
    else fail('ReviewStatus', 'PENDING_OR_SUBMITTED_REQUIRED');
    // Draft answers are retained but never treated as submitted or approved.
    const submitted = data.ReviewStatus === 'SUBMITTED';
    for (const field of ['EvidenceReference', 'Reviewer', 'ReviewDate']) if (submitted && !data[field]) fail(field, 'REQUIRED_FOR_SUBMISSION');
    if (data.ReviewDate && !validDate(data.ReviewDate)) fail('ReviewDate', 'ISO_CALENDAR_DATE_REQUIRED');
    if (kind === 'CUSTOMER') {
      for (const field of ['EffectiveFrom', 'EffectiveTo']) if (data[field] && !validDate(data[field])) fail(field, 'ISO_CALENDAR_DATE_REQUIRED');
      if (submitted && !data.EffectiveFrom) fail('EffectiveFrom', 'REQUIRED_FOR_SUBMISSION');
      if (data.VatClassification && !['VAT', 'NON_VAT'].includes(data.VatClassification)) fail('VatClassification', 'INVALID_CLASSIFICATION');
      if (submitted && !data.VatClassification) fail('VatClassification', 'REQUIRED_FOR_SUBMISSION');
      if (data.BaseOtAmountBasis && !['INCLUDED', 'ADDED', 'NOT_APPLICABLE'].includes(data.BaseOtAmountBasis)) fail('BaseOtAmountBasis', 'INVALID_BASIS');
      if (data.VatClassification === 'VAT' && (submitted || data.BaseOtAmountBasis) && !['INCLUDED', 'ADDED'].includes(data.BaseOtAmountBasis)) fail('BaseOtAmountBasis', 'VAT_BASIS_REQUIRED');
      if (data.VatClassification === 'NON_VAT' && (submitted || data.BaseOtAmountBasis) && data.BaseOtAmountBasis !== 'NOT_APPLICABLE') fail('BaseOtAmountBasis', 'NON_VAT_BASIS_MUST_BE_NOT_APPLICABLE');
      if (submitted && data.VatClassification === 'NON_VAT' && !data.Notes) fail('Notes', 'NOT_APPLICABLE_EXPLANATION_REQUIRED');
      if (validDate(data.EffectiveFrom) && (!data.EffectiveTo || validDate(data.EffectiveTo))) {
        const to = data.EffectiveTo || '9999-12-31';
        if (to < data.EffectiveFrom) fail('EffectiveTo', 'REVERSED_PERIOD');
        else {
          if (periods.some(p => p.id === data.CompanyID && p.from <= to && data.EffectiveFrom <= p.to)) fail('EffectiveFrom', 'OVERLAPPING_CUSTOMER_PERIOD');
          periods.push({id: data.CompanyID, from: data.EffectiveFrom, to, row});
        }
      }
    } else {
      if (!context.invoiceIds.includes(data.InvoiceID)) fail('InvoiceID', 'UNKNOWN_INVOICE');
      if (data.SOAID && !context.soaIds.includes(data.SOAID)) fail('SOAID', 'UNKNOWN_SOA');
      if (invoices.has(data.InvoiceID)) fail('InvoiceID', 'DUPLICATE_INVOICE_REVIEW');
      invoices.add(data.InvoiceID);
      if (submitted && !data.AsOfDate) fail('AsOfDate', 'REQUIRED_FOR_SUBMISSION');
      if (data.AsOfDate && !validDate(data.AsOfDate)) fail('AsOfDate', 'ISO_CALENDAR_DATE_REQUIRED');
      if (submitted || data.ApprovedOutstandingAmount) {
        if (!/^(0|[1-9]\d{0,15})\.\d{2}$/.test(data.ApprovedOutstandingAmount)) fail('ApprovedOutstandingAmount', 'EXACT_NONNEGATIVE_DECIMAL_REQUIRED');
      }
    }
  }
  result.status = issues.length ? 'INVALID' : result.pendingRows || !result.submittedRows ? 'PENDING' : 'STRUCTURALLY_VALID_NOT_APPROVED';
  return result;
}
