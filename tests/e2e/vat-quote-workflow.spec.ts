import {test, expect} from '@playwright/test';

test('rounded inclusive quote survives save/edit and reconciles in the invoice preview', async ({page}) => {
  const errors: string[] = [], forbidden: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== new URL(test.info().project.use.baseURL!).origin || url.pathname.startsWith('/api/')) {
      forbidden.push(url.pathname); return route.abort();
    }
    return route.continue();
  });
  await page.goto('/');
  await expect(page.getByText('Fictional sample records · no database · no real financial postings.', {exact:false})).toBeVisible();
  const nav = (name: string) => page.getByRole('navigation').getByRole('button', {name, exact:true}).click();
  await nav('Trips');await page.getByRole('button', {name:'New trip',exact:true}).click();
  let dialog=page.getByRole('dialog');
  await dialog.getByLabel('Destination details / stops',{exact:true}).fill('Synthetic rounded VAT quote workflow');
  await dialog.getByLabel('Base amount (PHP)',{exact:true}).fill('9000');
  await dialog.getByLabel('OT fee (PHP)',{exact:true}).fill('1000');
  await dialog.getByLabel('Fuel (PHP)',{exact:true}).fill('500');
  await dialog.getByLabel('Toll fees (PHP)',{exact:true}).fill('100');
  await dialog.getByLabel('Enter VAT for this trip',{exact:true}).check();
  await expect(dialog.getByLabel('VAT treatment',{exact:true})).toHaveValue('ADDED');
  await expect(dialog.getByLabel('VAT amount (PHP)',{exact:true})).toHaveValue('1200.00');
  await expect(dialog.getByLabel('Total trip amount',{exact:true})).toContainText('11,800.00');
  await dialog.getByLabel('VAT treatment',{exact:true}).selectOption('INCLUDED');
  await expect(dialog.getByLabel('VAT amount (PHP)',{exact:true})).toHaveValue('1071.43');
  await expect(dialog.getByLabel('Total trip amount',{exact:true})).toContainText('10,600.00');
  await dialog.getByRole('button',{name:'Create demo trip',exact:true}).click();
  await expect(dialog).toHaveCount(0);
  await nav('Trips');await page.getByLabel('Search trips').fill('Synthetic rounded VAT quote workflow');
  const row=page.getByRole('table',{name:'Trip register',exact:true}).locator('tbody tr');
  await expect(row).toContainText('10,600.00');await row.getByRole('button',{name:/View TRIP/}).click();
  await page.getByRole('button',{name:'Edit trip',exact:true}).click();dialog=page.getByRole('dialog');
  await expect(dialog.getByLabel('VAT treatment',{exact:true})).toHaveValue('INCLUDED');
  await expect(dialog.getByLabel('VAT amount (PHP)',{exact:true})).toHaveValue('1071.43');
  await dialog.getByLabel('Fuel (PHP)',{exact:true}).fill('600');
  await expect(dialog.getByLabel('VAT amount (PHP)',{exact:true})).toHaveValue('1071.43');
  await expect(dialog.getByLabel('Total trip amount',{exact:true})).toContainText('10,700.00');
  await dialog.getByLabel('Trip change reason',{exact:true}).fill('Synthetic expense correction; quoted services unchanged');
  await dialog.getByRole('button',{name:'Save trip changes',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await row.getByRole('button',{name:/View TRIP/}).click();
  await page.getByRole('button',{name:'Create demo direct invoice',exact:true}).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  // The invoice register is corporate-only; workspace search also opens direct invoices.
  await page.getByLabel('Search workspace',{exact:true}).fill('DEMO-INV-');
  const invoiceResults=page.getByRole('region',{name:'Workspace search results'}).getByRole('button').filter({hasText:'Invoice'});
  await expect(invoiceResults).toHaveCount(2);await invoiceResults.last().click();
  await expect(page.getByRole('dialog')).toContainText('10,700.00');
  await page.getByRole('button',{name:'PRINT',exact:true}).click();
  const summary=page.frameLocator('iframe[title="Invoice print document"]').getByRole('region',{name:'Net charges and VAT summary'});
  await expect(summary).toContainText('8,928.57');await expect(summary).toContainText('1,071.43');
  await expect(summary).toContainText('700.00');await expect(summary).toContainText('10,700.00');
  expect(errors).toEqual([]);expect(forbidden).toEqual([]);
});
