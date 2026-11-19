import {test, expect, type Page} from '@playwright/test';
const nav = (page: Page, name: string) => page.getByRole('navigation', {name: 'Main navigation'}).getByRole('button', {name, exact: true}).click();
async function create(page: Page, description: string, date: string, values: Record<string, string>) {
  await nav(page, 'Trips'); await page.getByRole('button', {name: 'New trip', exact: true}).click();
  const form = page.getByRole('dialog');
  await expect(form.getByLabel('Trip billing arrangement', {exact: true})).toHaveCount(0);
  await form.getByRole('combobox', {name: 'Charge to / customer', exact: true}).selectOption('c2');
  await form.getByRole('combobox', {name: 'Billing workflow', exact: true}).selectOption('CORPORATE');
  await form.getByLabel('Trip date (start)', {exact: true}).fill(date); await form.getByLabel('Trip end date', {exact: true}).fill(date);
  await form.getByLabel('Destination details / stops', {exact: true}).fill(description);
  for (const [label, value] of Object.entries(values)) await form.getByLabel(label, {exact: true}).fill(value);
  await form.getByRole('button', {name: 'Create demo trip', exact: true}).click(); await expect(form).toHaveCount(0);
  const row = page.getByRole('table', {name: 'Trip register'}).locator('tbody tr').filter({hasText: description});
  return {row, id: await row.getByRole('button', {name: /View TRIP/}).innerText()};
}
test('normal daily records plus a manual month-end base produce one selected-trip SOA summary', async ({page}) => {
  await page.goto('/');
  const zero = await create(page, 'QA daily zero service', '2026-11-01', {'Base amount (PHP)': '0'});
  await expect(zero.row).toContainText('No charge recorded'); await expect(zero.row).not.toContainText('Settled');
  const daily = await create(page, 'QA daily OT expenses', '2026-11-02', {'Base amount (PHP)': '0', 'OT fee (PHP)': '100', 'Fuel (PHP)': '50',
    'Toll fees (PHP)': '20', 'Parking (PHP)': '10', 'Food (PHP)': '5', 'Lodging (PHP)': '15', 'Others (PHP)': '8'});
  const end = await create(page, 'QA month-end fixed base', '2026-11-30', {'Base amount (PHP)': '1000', 'OT fee (PHP)': '20', 'Fuel (PHP)': '30',
    'Toll fees (PHP)': '2', 'Parking (PHP)': '3', 'Food (PHP)': '4', 'Lodging (PHP)': '5', 'Others (PHP)': '6'});
  const regular = await create(page, 'QA separate regular vehicle', '2026-11-10', {'Base amount (PHP)': '4500'});
  await nav(page, 'SOA Management');
  for (const id of [zero.id, daily.id, end.id]) await page.getByRole('checkbox', {name: 'Select ' + id, exact: true}).check();
  await page.getByRole('button', {name: /Create.*SOA/}).click();
  const summary = page.getByRole('region', {name: 'SOA financial summary'});
  await expect(summary).toContainText('3 selected trips'); await expect(summary).toContainText('1,278.00');
  for (const [label, amount] of [['Base', '1,000.00'], ['OT', '120.00'], ['Fuel', '80.00'], ['Toll', '22.00'], ['Parking', '13.00'], ['Food', '9.00'], ['Lodging', '20.00'], ['Others', '14.00']]) {
    await expect(summary.locator('.soa-financial-summary-grid > div').filter({has: page.locator('span').filter({hasText: new RegExp('^' + label + '$')})})).toContainText(amount);
  }
  const members = page.getByRole('table', {name: 'Trips under SOA'});
  await expect(members.locator('tbody tr')).toHaveCount(3); await expect(members).not.toContainText(regular.id);
  await expect(page.getByRole('table', {name: 'Unbilled corporate trips'})).toContainText(regular.id);
  await page.setViewportSize({width: 390, height: 844}); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
test('zero-charge receipt attempts preserve entry and an ordinary customer needs no lease setup', async ({page}) => {
  await page.goto('/'); await nav(page, 'Trips'); await page.getByRole('button', {name: 'New trip', exact: true}).click();
  const form = page.getByRole('dialog');
  await expect(form.getByLabel('Monthly lease contract', {exact: true})).toHaveCount(0);
  await form.getByLabel('Base amount (PHP)', {exact: true}).fill('0');
  await form.getByLabel('Destination details / stops', {exact: true}).fill('QA ordinary zero daily service');
  await form.getByText('Add a payment during encoding (optional)', {exact: true}).click();
  await form.getByLabel('Initial receipt amount (PHP)', {exact: true}).fill('10');
  await form.getByLabel('Demo collection reference / verification evidence').fill('QA no receipt');
  await form.getByRole('button', {name: 'Create demo trip', exact: true}).click();
  await expect(page.getByRole('alert').filter({hasText: 'without an initial receipt'})).toBeVisible();
  await expect(form.getByLabel('Destination details / stops', {exact: true})).toHaveValue('QA ordinary zero daily service');
  await form.getByLabel('Initial receipt amount (PHP)', {exact: true}).fill('');
  await form.getByRole('button', {name: 'Create demo trip', exact: true}).click(); await expect(form).toHaveCount(0);
  const row = page.getByRole('table', {name: 'Trip register'}).locator('tbody tr').filter({hasText: 'QA ordinary zero daily service'});
  await expect(row).toContainText('No charge recorded');
  await row.getByRole('button', {name: /View TRIP/}).click();
  await expect(page.getByRole('dialog').getByRole('button', {name: 'Payment', exact: true})).toHaveCount(0);
});
test('daily VAT stays on base plus OT and the saved SOA total does not add its reference twice', async ({page}) => {
  await page.goto('/'); await nav(page, 'Trips'); await page.getByRole('button', {name: 'New trip', exact: true}).click();
  const form = page.getByRole('dialog');
  await form.getByRole('combobox', {name: 'Charge to / customer', exact: true}).selectOption('c2');
  await form.getByRole('combobox', {name: 'Billing workflow', exact: true}).selectOption('CORPORATE');
  await form.getByLabel('Destination details / stops', {exact: true}).fill('QA VAT daily charge');
  await form.getByLabel('Base amount (PHP)', {exact: true}).fill('0'); await form.getByLabel('OT fee (PHP)', {exact: true}).fill('100');
  await form.getByLabel('Fuel (PHP)', {exact: true}).fill('200'); await form.getByLabel('Enter VAT for this trip', {exact: true}).check();
  await form.getByLabel('VAT treatment', {exact: true}).selectOption('ADDED'); await expect(form.getByLabel('VAT amount (PHP)', {exact: true})).toHaveValue('12.00');
  await form.getByRole('button', {name: 'Create demo trip', exact: true}).click(); await expect(form).toHaveCount(0);
  const row = page.getByRole('table', {name: 'Trip register'}).locator('tbody tr').filter({hasText: 'QA VAT daily charge'});
  const id = await row.getByRole('button', {name: /View TRIP/}).innerText();
  await nav(page, 'SOA Management'); await page.getByRole('checkbox', {name: 'Select ' + id, exact: true}).check();
  await page.getByRole('button', {name: /Create.*SOA/}).click();
  const summary = page.getByRole('region', {name: 'SOA financial summary'});
  await expect(summary).toContainText('312.00'); await expect(summary).toContainText('12.00'); await expect(summary).not.toContainText('324.00');
});
