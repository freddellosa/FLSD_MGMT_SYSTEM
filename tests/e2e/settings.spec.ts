import { test,expect,type Page,type Locator } from '@playwright/test';
const nav=(page:Page,name:string)=>page.getByRole('navigation').getByRole('button',{name:({Overview:'Dashboard','Corporate billing':'SOA Management',Remittances:'Driver Remittances'} as Record<string,string>)[name]??name,exact:true}).click();
// Start the actual native drag before scrolling to an off-screen destination.
async function dragAcrossPage(page:Page,source:Locator,target:Locator){
 await source.scrollIntoViewIfNeeded();const start=(await source.boundingBox())!;
 await page.mouse.move(start.x+start.width/2,start.y+start.height/2);await page.mouse.down();
 await page.mouse.move(start.x+start.width/2,start.y+start.height/2-8,{steps:5});
 await target.scrollIntoViewIfNeeded();const end=(await target.boundingBox())!;
 await page.mouse.move(end.x+10,end.y+10,{steps:10});await page.mouse.up();
}
test('activity is one compact row per record with details in a separate dialog',async({page})=>{
 await page.goto('/');await page.getByLabel('Demo role').selectOption('OWNER');await nav(page,'Activity');
 const table=page.getByRole('table',{name:'Activity register',exact:true}),rows=table.locator('tbody tr');const count=await rows.count();expect(count).toBeGreaterThan(10);
 for(const row of await rows.all())expect((await row.boundingBox())!.height).toBeLessThanOrEqual(36);
 await rows.first().getByRole('button').click();await expect(page.getByRole('dialog',{name:'Activity details'})).toBeVisible();await expect(page.locator('.event-detail')).toContainText('CREATE_TRIP');await page.getByRole('button',{name:'Close activity details',exact:true}).click();await expect(rows).toHaveCount(count);
});
test('overdue summary exposes full invoice fields in red and unbilled trips open searchable details',async({page})=>{
 await page.clock.setFixedTime(new Date('2026-12-15T04:00:00Z'));await page.goto('/');
 const overdue=page.getByRole('table',{name:'Overdue invoices',exact:true});
 expect(await overdue.getByRole('columnheader').allTextContents()).toEqual(['Invoice number','Invoice date','Customer','Amount due','Due date']);
 await expect(overdue).toContainText('2026-11-14');await expect(overdue).toContainText('Northstar Logistics');await expect(overdue).toContainText('14,000.00');await expect(overdue).toContainText('2026-12-14');await expect(page.locator('.has-overdue').first()).toHaveCSS('background-color','rgb(255, 248, 247)');
 await page.getByRole('button',{name:'View overdue details',exact:true}).click();await expect(page.getByRole('table',{name:'Overdue invoice details'})).toContainText('DEMO-INV-0001001');await page.getByRole('button',{name:'Close overview details',exact:true}).click();
 await page.getByRole('button',{name:'Unbilled trips',exact:true}).click();const preview=page.getByRole('table',{name:'Unbilled trip preview'});await expect(preview.locator('tbody tr')).toHaveCount(5);await expect(preview).not.toContainText('Clark');await page.getByLabel('Search unbilled trips').fill('Subic');await expect(preview.locator('tbody tr')).toHaveCount(1);await preview.locator('tbody tr').getByRole('button').click();await expect(page.getByRole('dialog')).toContainText('Manila');await expect(page.getByRole('table',{name:'Unbilled trip preview'})).toHaveCount(0);
});
test('Settings is limited to Owner/Admin; dashboard management is Owner-only',async({page})=>{
 await page.goto('/');for(const role of ['BILLING','OPERATIONS','VIEWER']){await page.getByLabel('Demo role').selectOption(role);await expect(page.getByRole('navigation').getByRole('button',{name:'Settings',exact:true})).toHaveCount(0);}
 await page.getByLabel('Demo role').selectOption('ADMIN');await nav(page,'Settings');await expect(page.getByRole('button',{name:'Customer management',exact:true})).toHaveCount(0);await expect(page.getByRole('button',{name:'Invoice customization',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Users / roles',exact:true})).toBeVisible();await expect(page.getByRole('button',{name:'Dashboard management',exact:true})).toHaveCount(0);
 await page.getByLabel('Demo role').selectOption('OWNER');await nav(page,'Settings');await expect(page.getByRole('button',{name:'Dashboard management',exact:true})).toBeVisible();await expect(page.getByRole('table',{name:'Demo users',exact:true})).toBeVisible();
});
test('Admin customer creation and editing are used by trip encoding and corporate invoice displays',async({page})=>{
 await page.goto('/');await page.getByLabel('Demo role').selectOption('ADMIN');await nav(page,'Customers');await page.getByRole('button',{name:'New Customer',exact:true}).click();
 await page.getByLabel('Customer name',{exact:true}).fill('Fictional Demo Client');await page.getByLabel('Customer contact',{exact:true}).fill('Demo office');await page.getByLabel('Customer email',{exact:true}).fill('client@example.test');await page.getByRole('button',{name:'Save customer',exact:true}).click();await expect(page.getByRole('table',{name:'Customer directory'})).toContainText('Fictional Demo Client');
 await nav(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();const modal=page.getByRole('dialog');await modal.getByRole('combobox',{name:'Charge to / customer',exact:true}).selectOption({label:'Fictional Demo Client'});await modal.getByLabel('Destination details / stops',{exact:true}).fill('New customer demo journey');await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('100');await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();
 await nav(page,'Customers');await page.getByRole('button',{name:'Edit customer Northstar Logistics',exact:true}).click();await page.getByLabel('Customer name',{exact:true}).fill('Northstar Revised');await page.getByRole('button',{name:'Save customer',exact:true}).click();await nav(page,'Corporate billing');await page.getByRole('button',{name:'Invoice list',exact:true}).click();await expect(page.getByRole('table',{name:'Invoice list',exact:true})).toContainText('Northstar Revised');
 await nav(page,'Trips');await page.getByLabel('Search trips').fill('Fictional Demo Client');await expect(page.getByRole('table',{name:'Trip register',exact:true}).locator('tbody tr')).toHaveCount(1);
});
test('Admin manages simulated users and roles without changing the selected actor role',async({page})=>{
 await page.goto('/');await page.getByLabel('Demo role').selectOption('ADMIN');await nav(page,'Settings');await page.getByRole('button',{name:'Users / roles',exact:true}).click();await page.getByRole('button',{name:'Add demo user',exact:true}).click();
 await page.getByLabel('User name',{exact:true}).fill('Demo tester');await page.getByLabel('User email',{exact:true}).fill('tester@example.test');await page.getByLabel('User role',{exact:true}).selectOption('BILLING');await page.getByRole('button',{name:'Save demo user',exact:true}).click();
 await page.getByRole('button',{name:'Edit user Demo tester',exact:true}).click();await page.getByLabel('User role',{exact:true}).selectOption('VIEWER');await page.getByLabel('User active',{exact:true}).uncheck();await page.getByRole('button',{name:'Save demo user',exact:true}).click();const row=page.getByRole('table',{name:'Demo users'}).locator('tbody tr').filter({hasText:'tester@example.test'});await expect(row).toContainText('VIEWER');await expect(row).toContainText('Inactive');await expect(page.getByLabel('Demo role')).toHaveValue('ADMIN');
});
test('Owner saves draggable layout options and moves actual dashboard sections with drag and keyboard',async({page})=>{
 await page.goto('/');await page.getByLabel('Demo role').selectOption('OWNER');await nav(page,'Settings');
 const source=page.locator('.dashboard-layout-row[data-widget-id="share-previous"]'),target=page.locator('.dashboard-layout-row[data-widget-id="charges"]');await dragAcrossPage(page,source.locator('.drag-handle'),target);await expect(page.locator('.dashboard-layout-row').first()).toHaveAttribute('data-widget-id','share-previous');
 await page.getByLabel('Show Driver-held cash',{exact:true}).uncheck();await page.getByLabel('Title for Unbilled trips',{exact:true}).fill('Trips awaiting invoice');await page.getByLabel('Width for Overdue invoices',{exact:true}).selectOption('12');await page.getByRole('button',{name:'Save dashboard',exact:true}).click();await nav(page,'Overview');
 const widgets=page.locator('.dashboard-canvas > .dashboard-widget');await expect(widgets.first()).toHaveAttribute('data-widget-id','share-previous');await expect(page.getByRole('button',{name:'Trips awaiting invoice',exact:true})).toBeVisible();await expect(page.locator('.dashboard-widget[data-widget-id="driver-cash"]')).toHaveCount(0);await expect(page.locator('.dashboard-widget[data-widget-id="overdue"]')).toHaveAttribute('style',/span 12/);
 await page.getByRole('button',{name:'Edit dashboard layout',exact:true}).click();const charges=page.locator('.dashboard-widget[data-widget-id="charges"]'),expected=page.locator('.dashboard-widget[data-widget-id="expected"]');await dragAcrossPage(page,charges.locator('.widget-edit-tools span'),expected);
 let ids=await widgets.evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-widget-id')));expect(ids.indexOf('charges')).toBeGreaterThan(ids.indexOf('expected'));
 const before=ids.indexOf('charges');await page.getByRole('button',{name:'Move Agreed charges / revenue up',exact:true}).click();ids=await widgets.evaluateAll(nodes=>nodes.map(n=>n.getAttribute('data-widget-id')));expect(ids.indexOf('charges')).toBe(before-1);await page.getByRole('button',{name:'Finish dashboard layout',exact:true}).click();await nav(page,'Trips');await nav(page,'Overview');await expect(page.getByRole('button',{name:'Trips awaiting invoice',exact:true})).toBeVisible();
});
