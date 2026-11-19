import {test,expect,type Page} from '@playwright/test';
import {businessDate} from '../../src/lib/domain/business-date';

const nav=(page:Page,label:string)=>page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:label,exact:true}).click();

test('SOA selection resets invoice date and Operations sees a read-only SOA',async({page})=>{
  await page.goto('/');
  await page.getByLabel('Demo role').selectOption('BILLING');
  await nav(page,'Trips');
  await page.getByRole('button',{name:'New trip',exact:true}).click();
  const trip=page.getByRole('dialog');
  await trip.getByRole('combobox',{name:'Charge to / customer',exact:true}).selectOption('c2');
  await trip.getByRole('combobox',{name:'Billing workflow',exact:true}).selectOption('CORPORATE');
  await trip.getByLabel('Destination details / stops',{exact:true}).fill('Independent fictional second SOA');
  await trip.getByLabel('Base amount (PHP)',{exact:true}).fill('100');
  await trip.getByRole('button',{name:'Create demo trip',exact:true}).click();
  await expect(trip).toHaveCount(0);
  await nav(page,'SOA Management');
  const unbilled=page.getByRole('table',{name:'Unbilled corporate trips'});
  await unbilled.getByRole('row').filter({hasText:'Subic'}).getByRole('checkbox').check();
  await page.getByRole('button',{name:'Create demo SOA (1)',exact:true}).click();
  const soas=page.getByRole('table',{name:'SOA list',exact:true});
  const first=await soas.getByRole('row').filter({hasText:'Draft'}).getByRole('button',{name:/^SOA-/}).innerText();
  await unbilled.getByRole('row').filter({hasText:'Independent fictional second SOA'}).getByRole('checkbox').check();
  await page.getByRole('button',{name:'Create demo SOA (1)',exact:true}).click();
  const date=page.getByLabel('Corporate invoice date');
  await date.fill('2026-12-01');
  await soas.getByRole('button',{name:first,exact:true}).click();
  await expect(date).toHaveValue(businessDate());
  await page.getByLabel('Demo role').selectOption('OPERATIONS');
  await nav(page,'SOA Management');
  await expect(page.getByRole('button',{name:'Invoice list',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:/Create demo SOA/})).toHaveCount(0);
  await page.getByRole('table',{name:'SOA list',exact:true}).getByRole('button',{name:first,exact:true}).click();
  await expect(page.getByRole('table',{name:'Trips under SOA',exact:true})).toBeVisible();
  await expect(page.getByRole('button',{name:'Edit SOA',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Void draft SOA',exact:true})).toHaveCount(0);
});

test('shows document numbers in audit and filters outstanding collections',async({page})=>{
  await page.goto('/');
  await page.getByLabel('Demo role').selectOption('OWNER');
  await nav(page,'Activity');
  await expect(page.getByRole('table',{name:'Activity register'})).toContainText('DEMO-INV-0001001');
  await nav(page,'Collections');
  await page.getByLabel('Collection view').selectOption('OUTSTANDING');
  await expect(page.getByRole('table',{name:'Outstanding collection targets'}).locator('tbody tr').first()).toBeVisible();
  await page.getByLabel('Search collections').fill('nonexistent fictional marker');
  await expect(page.getByRole('table',{name:'Outstanding collection targets'}).locator('tbody tr')).toHaveCount(0);
  await page.getByLabel('Search collections').fill('Marisol');
  await expect(page.getByRole('table',{name:'Outstanding collection targets'})).toContainText('Marisol Events');
});

test('shows a duplicate customer error inside the editor and hides credential storage details',async({page})=>{
  await page.goto('/');
  await page.getByLabel('Demo role').selectOption('OWNER');
  await nav(page,'Customers');
  await page.getByRole('button',{name:'New Customer',exact:true}).click();
  const dialog=page.getByRole('dialog',{name:'Customer editor',exact:true});
  await dialog.getByLabel('Customer name',{exact:true}).fill('Northstar Logistics');
  await dialog.getByRole('button',{name:'Save customer',exact:true}).click();
  await expect(dialog.getByRole('alert')).toContainText('Customer name already exists');
  await page.goto('/pilot');
  await expect(page.getByLabel('Pilot email')).toBeVisible();
  await expect(page.getByText(/owner-login\.json|\.pilot-owner-access/)).toHaveCount(0);
  await expect(page.getByText(/credentials issued for your pilot account/)).toBeVisible();
});
