import {describe, expect, it} from 'vitest';
import {customerReviewHeaders, receivableReviewHeaders, validateFinancialReviewResponses as validate} from './financial-review-responses';
const context = {customerIds: ['47'], invoiceIds: ['49569'], soaIds: ['4262']};
const customer = {CompanyID: '47', SourceNameForReference: 'Example', EffectiveFrom: '2026-09-01', EffectiveTo: '2026-10-31', VatClassification: 'VAT', BaseOtAmountBasis: 'ADDED', EvidenceReference: 'Contract example', Reviewer: 'Fixture reviewer', ReviewDate: '2026-11-16', ReviewStatus: 'SUBMITTED', Notes: ''};
const receipt = {InvoiceID: '49569', SOAID: '4262', CompanyID: '47', AsOfDate: '2026-11-16', ApprovedOutstandingAmount: '1800.00', EvidenceReference: 'Fixture review', Reviewer: 'Fixture reviewer', ReviewDate: '2026-11-16', ReviewStatus: 'SUBMITTED', Notes: ''};
const csv = (headers: string[], rows: Record<string, string>[]) => [headers, ...rows.map(r => headers.map(h => r[h] ?? ''))].map(r => r.map(s => '"' + s.replaceAll('"', '""') + '"').join(',')).join('\r\n');
const check = (changes: Record<string, string>) => validate('CUSTOMER', csv(customerReviewHeaders, [{...customer, ...changes}]), context);
describe('Financial review submissions remain offline evidence', () => {
  it('accepts reordered headers by name without granting financial authority', () => {
    expect(validate('CUSTOMER', csv([...customerReviewHeaders].reverse(), [customer]), context)).toMatchObject({status: 'STRUCTURALLY_VALID_NOT_APPROVED', policyApproved: false, importEnabled: false, executionAuthorized: false});
  });
  it('keeps blank customer answers pending', () => {
    expect(check({EffectiveFrom: '', EffectiveTo: '', VatClassification: '', BaseOtAmountBasis: '', EvidenceReference: '', Reviewer: '', ReviewDate: '', ReviewStatus: 'PENDING'})).toMatchObject({status: 'PENDING', pendingRows: 1, submittedRows: 0});
  });
  it.each(['2026-02-30', '09/01/2026', '2026-09-01T00:00:00'])('rejects invalid or non-ISO period %s', value => {
    expect(check({EffectiveFrom: value}).status).toBe('INVALID');
  });
  it('requires provenance for submitted answers', () => {
    expect(check({Reviewer: '', EvidenceReference: ''}).issues.map(i => i.field)).toEqual(['EvidenceReference', 'Reviewer']);
  });
  it('does not treat arbitrary approval labels as authority', () => { expect(check({ReviewStatus: 'APPROVED'}).status).toBe('INVALID'); });
  it('rejects unknown customers and VAT without an explicit amount basis', () => {
    expect(check({CompanyID: '999', BaseOtAmountBasis: ''}).issues.map(i => i.code)).toEqual(['UNKNOWN_CUSTOMER', 'VAT_BASIS_REQUIRED']);
  });
  it('requires explicit non-applicability and explanation for non-VAT', () => {
    expect(check({VatClassification: 'NON_VAT'}).status).toBe('INVALID');
    expect(check({VatClassification: 'NON_VAT', BaseOtAmountBasis: 'NOT_APPLICABLE', Notes: 'No VAT applies per reviewed classification.'}).status).toBe('STRUCTURALLY_VALID_NOT_APPROVED');
  });
  it('rejects overlapping inclusive periods but permits consecutive periods', () => {
    expect(validate('CUSTOMER', csv(customerReviewHeaders, [customer, {...customer, EffectiveFrom: '2026-10-31', EffectiveTo: ''}]), context).status).toBe('INVALID');
    expect(validate('CUSTOMER', csv(customerReviewHeaders, [customer, {...customer, EffectiveFrom: '2026-11-01', EffectiveTo: ''}]), context).status).toBe('STRUCTURALLY_VALID_NOT_APPROVED');
  });
  it('rejects reversed periods', () => { expect(check({EffectiveTo: '2026-08-31'}).issues.some(i => i.code === 'REVERSED_PERIOD')).toBe(true); });
  it('rejects malformed quotes and duplicate or missing headers', () => {
    expect(validate('CUSTOMER', '"unclosed', context).status).toBe('INVALID');
    expect(validate('CUSTOMER', csv([...customerReviewHeaders.slice(1), 'Notes'], [customer]), context).status).toBe('INVALID');
  });
  it('keeps an empty receivable sheet pending', () => { expect(validate('RECEIVABLE', csv(receivableReviewHeaders, []), context).status).toBe('PENDING'); });
  it.each(['-1.00', '1.001', '1e3', '1,000.00', 'NaN', ''])('rejects unsafe amount %s without currency arithmetic', amount => {
    expect(validate('RECEIVABLE', csv(receivableReviewHeaders, [{...receipt, ApprovedOutstandingAmount: amount}]), context).status).toBe('INVALID');
  });
  it('retains exact large decimal values without enabling a balance', () => {
    expect(validate('RECEIVABLE', csv(receivableReviewHeaders, [{...receipt, ApprovedOutstandingAmount: '9999999999999999.99'}]), context)).toMatchObject({status: 'STRUCTURALLY_VALID_NOT_APPROVED', policyApproved: false});
  });
  it('rejects unknown invoice/SOA keys and duplicate invoice claims', () => {
    expect(validate('RECEIVABLE', csv(receivableReviewHeaders, [receipt, receipt, {...receipt, InvoiceID: '999', SOAID: '999'}]), context).issues.map(i => i.code)).toEqual(['DUPLICATE_INVOICE_REVIEW', 'UNKNOWN_INVOICE', 'UNKNOWN_SOA']);
  });
});
