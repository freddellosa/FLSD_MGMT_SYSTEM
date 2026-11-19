import {test, expect} from '@playwright/test';
import {buildBillingMappingProposals, initialBillingMappingDecisions} from '../../src/lib/migration/billing-mapping-proposals';
const jsonFile = (name: string, value: unknown) => ({name, mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(value))});
function fixture() {
  const packet = buildBillingMappingProposals({from: '2026-09-01', through: '2026-10-31', retainMissingSoaReferences: true,
    customers: [{CompanyID: 'C1', CompanyName: 'QA customer'}],
    trips: ['S1', 'S2', 'PARTIAL'].map((SOANo, i) => ({tmpInvoiceNo: 'QA' + i, CompanyID: 'C1', SOANo, DateOfTrip_Start: '9/1/2026', InvoiceTotAmt: '112.00'})),
    soas: ['S1', 'S2'].map((SOANo, i) => ({SOANo, InvoiceNo: 'I' + i, ChargeTo: 'QA old label', Status: 'Received'})),
    invoices: ['S1', 'S2'].map((SOANo, i) => ({InvoiceNo: 'I' + i, SOANo, ChargeTo: 'QA old label', Status: 'Approved', DateOfTrip_Start: '9/1/2026', InvoiceTotAmt: '112.00'}))},
  (['trips', 'customers', 'soas', 'invoices'] as const).map((kind, i) => ({kind, sha256: String(i).repeat(64), rows: [3, 1, 2, 2][i]})));
  const decisions = initialBillingMappingDecisions(packet);
  decisions.items[0] = {...decisions.items[0], decision: 'CONFIRM_CANDIDATE_IDENTITY', customerId: 'C1', reviewerNote: '<img src=x onerror=alert(1)> QA confirmed note'};
  decisions.items[1] = {...decisions.items[1], decision: 'REJECT_CANDIDATE', reviewerNote: 'QA rejected association; source unchanged'};
  return {packet, decisions, envelope: {packet, decisionFileName: 'billing-mapping-decisions.json'}};
}
test('billing review is local, searchable and separates confirmed, rejected and reference-only evidence', async ({page}) => {
  const api: string[] = []; page.on('request', r => {if (new URL(r.url()).pathname.startsWith('/api/')) api.push(r.url());});
  const f = fixture(); await page.goto('/billing-review');
  await page.getByLabel('Generated billing review packet').setInputFiles(jsonFile('packet.json', f.envelope));
  await page.getByLabel('Recorded billing decisions').setInputFiles(jsonFile('decisions.json', f.decisions));
  await page.getByRole('button', {name: 'Review selected files'}).click();
  await expect(page.getByRole('region', {name: 'Billing decision summary'})).toContainText('0 pending; 1 identity confirmations; 1 rejected candidates');
  const table = page.getByRole('table', {name: 'Billing review cases'});
  await expect(table.locator('tbody tr')).toHaveCount(1); await expect(table).toContainText('Candidate rejected; unresolved');
  await page.getByLabel('Show cases').selectOption('confirmed'); await expect(table).toContainText('<img src=x onerror=alert(1)> QA confirmed note');
  expect(await table.locator('img,script,iframe').count()).toBe(0);
  await page.getByLabel('Show cases').selectOption('all'); await expect(table.locator('tbody tr')).toHaveCount(3);
  await page.getByLabel('Search evidence').fill('QA1'); await expect(table.locator('tbody tr')).toHaveCount(1);
  await page.getByLabel('Search evidence').fill('not-present'); await expect(page.getByText('No cases match this filter.')).toBeVisible();
  await page.getByLabel('Show cases').selectOption('references'); await page.getByLabel('Search evidence').fill(''); await expect(table).toContainText('Reference only');
  await page.setViewportSize({width: 390, height: 844}); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole('button', {name: 'Clear review files'}).click(); await expect(page.getByRole('region', {name: 'Billing decision summary'})).toHaveCount(0);
  expect(api).toEqual([]);
});
test('stale decisions and changed packets cannot leave a previous confirmation visible', async ({page}) => {
  const f = fixture(); await page.goto('/billing-review');
  await page.getByLabel('Generated billing review packet').setInputFiles(jsonFile('packet.json', f.envelope));
  await page.getByLabel('Recorded billing decisions').setInputFiles(jsonFile('decisions.json', f.decisions));
  await page.getByRole('button', {name: 'Review selected files'}).click(); await expect(page.getByRole('region', {name: 'Billing decision summary'})).toBeVisible();
  f.decisions.evidenceSha256 = 'a'.repeat(64);
  await page.getByLabel('Recorded billing decisions').setInputFiles(jsonFile('stale.json', f.decisions));
  await expect(page.getByRole('region', {name: 'Billing decision summary'})).toHaveCount(0);
  await page.getByRole('button', {name: 'Review selected files'}).click(); await expect(page.getByRole('alert').filter({hasText: 'Unable to verify these files'})).toContainText('same current review revision');
  await expect(page.getByLabel('Recorded billing decisions')).not.toHaveValue('');
  f.decisions.evidenceSha256 = f.packet.evidenceSha256; f.packet.proposals[0].amounts.tripGross = '999.00';
  await page.getByLabel('Generated billing review packet').setInputFiles(jsonFile('changed.json', f.envelope));
  await page.getByLabel('Recorded billing decisions').setInputFiles(jsonFile('decisions.json', f.decisions));
  await page.getByRole('button', {name: 'Review selected files'}).click(); await expect(page.getByRole('alert').filter({hasText: 'Unable to verify these files'})).toBeVisible();
  await expect(page.getByRole('table', {name: 'Billing review cases'})).toHaveCount(0);
});
