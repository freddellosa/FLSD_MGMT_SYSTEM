import {test, expect} from '@playwright/test';
const cases = [
  {role: 'OWNER', customers: true, tax: true, catalogs: true, accounts: true},
  {role: 'ADMIN', customers: true, tax: true, catalogs: true, accounts: true},
  {role: 'OPERATIONS', customers: true, tax: false, catalogs: true, accounts: false},
  {role: 'BILLING', customers: true, tax: false, catalogs: false, accounts: false},
  {role: 'VIEWER', customers: false, tax: false, catalogs: false, accounts: false},
];
for (const entry of cases) test(`${entry.role} directory creation and lifecycle controls match existing permissions`, async ({page}) => {
  await page.goto('/'); await page.getByLabel('Demo role').selectOption(entry.role);
  const nav = (name: string) => page.getByRole('navigation').getByRole('button', {name, exact: true}).click();
  await nav('Customers');
  await expect(page.getByRole('button', {name: 'New Customer', exact: true})).toHaveCount(entry.customers ? 1 : 0);
  await expect(page.getByRole('button', {name: 'Edit customer Santos Family', exact: true})).toHaveCount(entry.customers ? 1 : 0);
  await expect(page.getByRole('button', {name: 'Delete customer Santos Family', exact: true})).toHaveCount(entry.customers ? 1 : 0);
  await expect(page.getByRole('button', {name: 'Toggle customer Santos Family', exact: true})).toHaveCount(entry.customers ? 1 : 0);
  if (entry.customers) {
    await page.getByRole('button', {name: 'New Customer', exact: true}).click();
    await expect(page.getByRole('dialog', {name: 'Customer editor', exact: true})).toBeVisible();
    await expect(page.getByLabel('Customer VAT status', {exact:true})).toHaveCount(entry.tax ? 1 : 0);
    await page.getByRole('button', {name: 'Cancel customer edit', exact: true}).click();
  }
  for (const [section, singular, editor] of [['Vehicles', 'Vehicle', 'Vehicle editor'], ['Drivers', 'Driver', 'Driver editor']]) {
    await nav(section);
    await expect(page.getByRole('button', {name: 'New ' + singular, exact: true})).toHaveCount(entry.catalogs ? 1 : 0);
    const cards = page.locator('.directory-card');
    await expect(cards.first().getByRole('switch')).toHaveCount(entry.catalogs ? 1 : 0);
    if (entry.catalogs) {
      await page.getByRole('button', {name: 'New ' + singular, exact: true}).click();
      await expect(page.getByRole('dialog', {name: editor, exact: true})).toBeVisible();
      await page.getByRole('dialog').getByRole('button', {name: 'Cancel', exact: true}).click();
      const toggle = cards.first().getByRole('switch'); await toggle.uncheck(); await expect(toggle).not.toBeChecked();
      await toggle.check(); await expect(toggle).toBeChecked();
    }
  }
  await expect(page.getByRole('navigation').getByRole('button', {name: 'Settings', exact: true})).toHaveCount(entry.accounts ? 1 : 0);
  if (entry.accounts) {
    await nav('Settings'); await page.getByRole('button', {name: 'Users / roles', exact: true}).click();
    await page.getByRole('button', {name: 'Add demo user', exact: true}).click();
    await expect(page.getByRole('form', {name: 'User editor', exact: true})).toBeVisible();
    await expect(page.getByLabel('User active', {exact: true})).toBeChecked();
  }
});
