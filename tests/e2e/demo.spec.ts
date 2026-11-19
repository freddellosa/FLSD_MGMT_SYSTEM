import { readFile } from 'node:fs/promises';
import { test, expect, type Page } from '@playwright/test';
const navigate = (page:Page,name:string) => page.getByRole('navigation',{name:'Main navigation'}).getByRole('button',{name:({Overview:'Dashboard','Corporate billing':'SOA Management',Remittances:'Driver Remittances'} as Record<string,string>)[name]??name,exact:true}).click();
async function createTrip(page:Page,initial=false) {
 await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();
 const modal=page.getByRole('dialog');
 await modal.getByLabel('Destination details / stops',{exact:true}).fill('Demo Origin → Demo Destination');
 await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('10000');
 if(initial) {
  await modal.getByText('Add a payment during encoding (optional)',{exact:true}).click();
  await modal.getByLabel('Initial receipt amount (PHP)').fill('4000');
  await modal.getByLabel('Payment purpose').selectOption('DEPOSIT');
  await modal.getByLabel('Demo collection reference / verification evidence').fill('DEMO initial deposit');
 }
 await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();
 await expect(modal).not.toBeVisible();
 await navigate(page,'Trips');await page.getByLabel('Search trips').fill('Demo Origin');
 const row=page.getByRole('row').filter({hasText:'Demo Origin'});
 await expect(row).toHaveCount(1);await row.getByRole('button',{name:/View TRIP/}).click();
}
test('encodes a trip without mandatory payment or SOA and searches it',async({page})=>{
 await page.goto('/');await createTrip(page);
 await page.getByRole('dialog').getByText(/Payment history \(/).click();await expect(page.getByRole('dialog')).toContainText('No customer payments recorded.');
 await expect(page.getByRole('dialog')).toContainText('₱10,000.00');
 await page.getByRole('button',{name:'Close dialog'}).click();await page.getByLabel('Search trips').fill('does not exist');
 await expect(page.getByText('No trips match your search.')).toBeVisible();
});
test('multiple direct receipts, advance allocation and trip-restricted refund credit',async({page})=>{
 await page.goto('/');await createTrip(page,true);
 await page.getByRole('dialog').getByRole('button',{name:'Payment',exact:true}).click();
 let modal=page.getByRole('dialog');await modal.getByLabel('Received amount (PHP)').fill('7000');
 await modal.getByLabel('Demo collection reference / verification evidence').fill('DEMO second receipt');
 await modal.getByRole('button',{name:'Record demo payment',exact:true}).click();
 await navigate(page,'Collections');
 const deposit=page.getByRole('row').filter({hasText:'DEMO initial deposit'});
 await deposit.getByRole('button',{name:'Apply advance'}).click();
 await page.getByRole('dialog').getByRole('button',{name:'Apply demo advance',exact:true}).click();
 await expect(deposit.getByRole('button',{name:'Apply advance'})).toHaveCount(0);
 const excess=page.getByRole('row').filter({hasText:'DEMO second receipt'});
 await expect(excess).toContainText('₱1,000.00');await excess.getByRole('button',{name:'Request refund'}).click();
 modal=page.getByRole('dialog');await modal.getByLabel('Demo recipient / destination').fill('Fictional guest');
 await modal.getByRole('button',{name:'Reserve demo refund',exact:true}).click();
 await expect(excess.getByRole('button',{name:'Request refund'})).toHaveCount(0);
 await navigate(page,'Trips');await page.getByLabel('Search trips').fill('Demo Origin');await expect(page.getByRole('row').filter({hasText:'Demo Origin'})).toContainText('Refund due');
});
test('refund approval, uncertain payout and reconciliation preserve reservation',async({page})=>{
 await page.goto('/');await navigate(page,'Refunds');
 for(const [button,submit] of [['Approve','Simulate approved'],['Start simulated payout','Simulate processing'],['Reconciliation required','Simulate reconciliation required'],['Confirm simulated payout','Simulate completed']]) {
  await page.getByRole('button',{name:button,exact:true}).click();
  const modal=page.getByRole('dialog');await modal.getByLabel('Demo approval / payout / reconciliation evidence').fill('DEMO verified outcome');
  await modal.getByRole('button',{name:submit,exact:true}).click();
 }
 await expect(page.locator('.refund-card').getByText('Completed',{exact:true})).toBeVisible();
 await expect(page.getByRole('button',{name:'Confirm simulated payout'})).toHaveCount(0);
 await navigate(page,'Collections');await expect(page.locator('.metric').filter({hasText:'Net after completed refunds'}).locator(':scope > strong')).toHaveText('₱31,000.00');
});
test('driver cash partial remittance never increases customer collections',async({page})=>{
 await page.goto('/');await navigate(page,'Remittances');
 const collection=page.locator('.metric').filter({hasText:'Gross customer collections'});const before=await collection.locator(':scope > strong').textContent();
 await page.getByRole('button',{name:'Tender cash',exact:true}).click();let modal=page.getByRole('dialog');
 await modal.getByLabel('Cash tendered (PHP)').fill('3000');await modal.getByLabel('Demo tender reference').fill('DEMO physical cash bag');
 await modal.getByRole('button',{name:'Tender demo cash',exact:true}).click();await page.getByRole('button',{name:'Count & accept',exact:true}).click();
 modal=page.getByRole('dialog');await modal.getByLabel('Cash physically counted (PHP)').fill('2000');await modal.getByLabel('Acknowledgment / discrepancy note').fill('DEMO shortage remains with driver');
 await modal.getByRole('button',{name:'Accept counted demo cash',exact:true}).click();
 await expect(page.getByText('Partial',{exact:true})).toBeVisible();await expect(collection.locator(':scope > strong')).toHaveText(before!);
 await expect(page.locator('.metric').filter({hasText:'Driver-held cash'}).locator(':scope > strong')).toHaveText('₱2,000.00');
});
test('corporate SOA and invoice creation do not duplicate receipts',async({page})=>{
 await page.goto('/');await navigate(page,'Corporate billing');
 await page.getByRole('table',{name:'Unbilled corporate trips',exact:true}).getByRole('row').filter({hasText:'Manila → Subic'}).getByRole('checkbox').check();
 await page.getByRole('button',{name:'Create demo SOA (1)',exact:true}).click();
 await page.getByRole('button',{name:'Finalize SOA',exact:true}).click();
 await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();
 await expect(page.getByRole('table',{name:'Invoice list',exact:true}).getByRole('row')).toHaveCount(3);
 await navigate(page,'Collections');await expect(page.getByRole('row')).toHaveCount(5);
});
test('role controls are explicitly simulated and restrict finance actions',async({page})=>{
 await page.goto('/');await page.getByLabel('Demo role').selectOption('VIEWER');
 await expect(page.getByRole('button',{name:'New trip',exact:true})).toHaveCount(0);
 await navigate(page,'Refunds');await expect(page.getByRole('button',{name:'Approve',exact:true})).toHaveCount(0);
 await page.getByLabel('Demo role').selectOption('OPERATIONS');
 await expect(page.getByRole('navigation').getByRole('button',{name:'Collections',exact:true})).toHaveCount(0);
 await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();await expect(page.getByText('Add a payment during encoding (optional)',{exact:true})).toHaveCount(0);
});
test('responsive navigation and dialogs have no horizontal page overflow',async({page})=>{
 await page.setViewportSize({width:390,height:844});const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));await page.goto('/');
 await page.getByRole('button',{name:'Toggle navigation'}).click();await navigate(page,'Trips');
 await expect(page.getByRole('heading',{name:'Trip management'})).toBeVisible();
 expect(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth)).toBe(true);
 await page.getByRole('button',{name:'New trip',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);expect(errors).toEqual([]);
});
test('keeps invalid charge input and duplicate submissions cannot create two trips',async({page})=>{
 await page.goto('/');await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();
 const modal=page.getByRole('dialog');await modal.getByLabel('Destination details / stops',{exact:true}).fill('Retry Origin → Retry Destination');
 await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('-1');
 // Zero is now a valid operational day. Bypass native validation to verify negative amounts still fail in the command path.
 await modal.locator('form').evaluate(form=>form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true})));
 await expect(modal.getByRole('alert')).toContainText('valid positive amount');await expect(modal.getByLabel('Destination details / stops',{exact:true})).toHaveValue('Retry Origin → Retry Destination');
 await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('10000');
 // Dispatch both submissions in the same browser turn to exercise the operation key.
 await modal.locator('form').evaluate(form=>{form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));form.dispatchEvent(new Event('submit',{bubbles:true,cancelable:true}));});
 await expect(modal).not.toBeVisible();await navigate(page,'Trips');await page.getByLabel('Search trips').fill('Retry Origin');await expect(page.getByRole('row').filter({hasText:'Retry Origin'})).toHaveCount(1);
});
test('reset restores fictional samples and refresh never persists transactions',async({page})=>{
 await page.goto('/');await createTrip(page);await page.getByRole('button',{name:'Close dialog'}).click();
 await page.getByRole('button',{name:'Reset sample data',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Reset sample data',exact:true}).click();
 await page.getByLabel('Search trips').fill('Demo Origin');await expect(page.getByText('No trips match your search.')).toBeVisible();
 await page.reload();await expect(page.getByRole('heading',{name:'Management overview'})).toBeVisible();await navigate(page,'Trips');await expect(page.getByRole('table',{name:'Trip register',exact:true}).locator('tbody tr')).toHaveCount(6);
});


test('trip encoding computes overnight hours and exact customer-charge total live',async({page})=>{
 await page.goto('/');await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();const modal=page.getByRole('dialog');
 await modal.getByLabel('Destination details / stops',{exact:true}).fill('Duration Origin → Duration Destination');
 await modal.getByLabel('Trip date (start)',{exact:true}).fill('2026-11-14');await modal.getByLabel('Trip start time',{exact:true}).fill('22:15');
 await modal.getByLabel('Trip end date',{exact:true}).fill('2026-11-16');await modal.getByLabel('Trip end time',{exact:true}).fill('01:45');
 await expect(modal.getByLabel('Total trip hours',{exact:true})).toHaveText('27 h 30 min (27.50 hours)');
 for(const [label,value] of [['Base amount (PHP)','10000'],['Fuel (PHP)','1500.25'],['Toll fees (PHP)','800.10'],['Parking (PHP)','200'],['Others (PHP)','99.65']])await modal.getByLabel(label,{exact:true}).fill(value);
 await modal.getByLabel('Other charge description').fill('Customer-requested stop');
 await expect(modal.getByLabel('Total trip amount',{exact:true})).toHaveText('₱12,600.00');
 await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();await expect(modal).not.toBeVisible();
 await navigate(page,'Trips');await page.getByLabel('Search trips').fill('Duration Origin');const row=page.getByRole('row').filter({hasText:'Duration Origin'});
 await expect(row).toContainText('₱12,600.00');await expect(row).not.toContainText('27 h 30 min');await row.getByRole('button',{name:/View TRIP/}).click();
 await expect(page.getByRole('dialog')).toContainText('Customer-requested stop');await expect(page.getByRole('dialog')).toContainText('2026-11-16 01:45');
 await page.getByRole('dialog').getByRole('button',{name:'Payment',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('₱12,600.00 remaining');
});
test('trip end before start is rejected with entered fields preserved',async({page})=>{
 await page.goto('/');await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();const modal=page.getByRole('dialog');
 await modal.getByLabel('Destination details / stops',{exact:true}).fill('Invalid Duration → Destination');await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('10000');
 await modal.getByLabel('Trip date (start)',{exact:true}).fill('2026-11-14');await modal.getByLabel('Trip end date',{exact:true}).fill('2026-11-14');await modal.getByLabel('Trip start time',{exact:true}).fill('17:00');await modal.getByLabel('Trip end time',{exact:true}).fill('08:00');
 await expect(modal.getByLabel('Total trip hours',{exact:true})).toHaveText('Trip end must be after trip start');await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();
 await expect(modal.getByRole('alert')).toContainText('Trip end must be after trip start');await expect(modal.getByLabel('Destination details / stops',{exact:true})).toHaveValue('Invalid Duration → Destination');
 await modal.getByLabel('Trip end date',{exact:true}).fill('2026-11-15');await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();await expect(modal).not.toBeVisible();
});

test('captures legacy trip fields, food and lodging, and keeps VAT optional per trip',async({page})=>{
 await page.goto('/');await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();const modal=page.getByRole('dialog');
 await expect(modal.getByLabel('Enter VAT for this trip',{exact:true})).not.toBeChecked();await expect(modal.getByLabel('VAT amount (PHP)',{exact:true})).toHaveCount(0);
 await modal.getByLabel('Destination details / stops',{exact:true}).fill('Reference Origin → Reference Destination');await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('10000');
 await modal.getByLabel('Food (PHP)',{exact:true}).fill('200');await modal.getByLabel('Lodging (PHP)',{exact:true}).fill('300');await expect(modal.getByLabel('Total trip amount',{exact:true})).toHaveText('₱10,500.00');
 await modal.getByLabel('Enter VAT for this trip',{exact:true}).check();await modal.getByRole('combobox',{name:'VAT treatment',exact:true}).selectOption('ADDED');
 await expect(modal.getByLabel('Total trip amount',{exact:true})).toHaveText('₱11,700.00');await modal.getByRole('combobox',{name:'VAT treatment',exact:true}).selectOption('INCLUDED');await expect(modal.getByLabel('Total trip amount',{exact:true})).toHaveText('₱10,500.00');
 await modal.getByLabel('Enter VAT for this trip',{exact:true}).uncheck();await expect(modal.getByLabel('Total trip amount',{exact:true})).toHaveText('₱10,500.00');
 for(const [label,value] of [['Passenger(s)','Fictional passenger group'],['Reserved by','Demo booking contact'],['Department','Demo events team'],['Charge location / site','SITE-42'],['Remarks','Demo request notes'],['Approved by (customer / reference)','Demo customer representative']])await modal.getByLabel(label,{exact:true}).fill(value);
 await expect(modal.getByRole('combobox',{name:'Vehicle billing class (reference)',exact:true})).toHaveCount(0);await modal.getByLabel('Odometer out (km)',{exact:true}).fill('12000.25');await modal.getByLabel('Odometer in (km)',{exact:true}).fill('12125.75');await expect(modal.getByLabel('Distance traveled',{exact:true})).toHaveText('125.50 km');
 await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();await expect(modal).not.toBeVisible();await navigate(page,'Trips');await page.getByLabel('Search trips').fill('Reference Origin');await page.getByRole('row').filter({hasText:'Reference Origin'}).getByRole('button',{name:/View TRIP/}).click();
 const detail=page.getByRole('dialog');for(const text of ['Fictional passenger group','Demo booking contact','Demo events team','SITE-42','125.50 km','Demo customer representative'])await expect(detail).toContainText(text);
 await expect(detail).toContainText('₱10,500.00');await expect(detail).toContainText('₱0.00 · not applied');
});
test('manual added VAT is saved and used in the payment balance',async({page})=>{
 await page.goto('/');await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();const modal=page.getByRole('dialog');await modal.getByLabel('Destination details / stops',{exact:true}).fill('VAT Origin → VAT Destination');await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('10000');
 await modal.getByLabel('Enter VAT for this trip',{exact:true}).check();await modal.getByRole('combobox',{name:'VAT treatment',exact:true}).selectOption('ADDED');await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();await expect(modal).not.toBeVisible();await navigate(page,'Trips');await page.getByLabel('Search trips').fill('VAT Origin');const row=page.getByRole('row').filter({hasText:'VAT Origin'});await expect(row).toContainText('₱11,200.00');await row.getByRole('button',{name:/View TRIP/}).click();await page.getByRole('dialog').getByRole('button',{name:'Payment',exact:true}).click();await expect(page.getByRole('dialog')).toContainText('₱11,200.00 remaining');
});



test('wide trip window keeps drafts on backdrop click, saves OT and supports Cancel',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await page.goto('/');await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();const modal=page.getByRole('dialog');
 const bounds=await modal.boundingBox();expect(bounds!.width).toBeGreaterThan(1200);
 await modal.getByLabel('Destination details / stops',{exact:true}).fill('OT Origin → OT Destination');await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('10000');
 await modal.getByLabel('OT fee (PHP)',{exact:true}).fill('1000');await modal.getByRole('textbox',{name:/^Total OT hours/}).fill('2.5');await modal.getByLabel('Fuel (PHP)',{exact:true}).fill('5000');
 await modal.getByLabel('Enter VAT for this trip',{exact:true}).check();await modal.getByRole('combobox',{name:'VAT treatment',exact:true}).selectOption('ADDED');await expect(modal.getByLabel('VAT amount (PHP)',{exact:true})).toHaveValue('1320.00');await expect(modal.getByLabel('Total trip amount',{exact:true})).toHaveText('₱17,320.00');
 await modal.getByRole('textbox',{name:/^Total OT hours/}).fill('9.7');await expect(modal.getByLabel('Total trip amount',{exact:true})).toHaveText('₱17,320.00');
 await page.mouse.click(2,2);await expect(modal).toBeVisible();await expect(modal.getByLabel('Destination details / stops',{exact:true})).toHaveValue('OT Origin → OT Destination');await expect(modal.getByLabel('OT fee (PHP)',{exact:true})).toHaveValue('1000');
 await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();await expect(modal).not.toBeVisible();await navigate(page,'Trips');await page.getByLabel('Search trips').fill('OT Origin');await page.getByRole('row').filter({hasText:'OT Origin'}).getByRole('button',{name:/View TRIP/}).click();await expect(page.getByRole('dialog')).toContainText('9.7');await expect(page.getByRole('dialog')).toContainText('₱17,320.00');
 await page.getByRole('button',{name:'Close dialog'}).click();await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Cancel',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
});



test('itinerary-only entry, compact odometers and single-decimal OT follow the requested layout',async({page})=>{
 await page.setViewportSize({width:1440,height:1000});await page.goto('/');await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();const modal=page.getByRole('dialog');
 await expect(modal.getByLabel('Origin',{exact:true})).toHaveCount(0);await expect(modal.getByLabel('Destination',{exact:true})).toHaveCount(0);await expect(modal.getByLabel('External SOA reference (optional)',{exact:true})).toHaveCount(0);
 const itinerary='Manila pickup\nHidden stop at Talisay\nReturn to Manila';await modal.getByLabel('Destination details / stops',{exact:true}).fill(itinerary);await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('10000');
 const endDate=await modal.getByLabel('Trip end date',{exact:true}).boundingBox();const endTime=await modal.getByLabel('Trip end time',{exact:true}).boundingBox();const totalHours=await modal.getByLabel('Total trip hours',{exact:true}).boundingBox();const ot=modal.getByRole('textbox',{name:/^Total OT hours/});const otBox=await ot.boundingBox();
 expect(totalHours!.y).toBeGreaterThan(endDate!.y+endDate!.height);expect(Math.abs(totalHours!.x-endDate!.x)).toBeLessThan(20);expect(otBox!.y).toBeGreaterThan(endTime!.y+endTime!.height);expect(Math.abs(otBox!.x-endTime!.x)).toBeLessThan(5);
 const driverBox=await modal.getByRole('combobox',{name:'Assigned driver',exact:true}).boundingBox();const odoBox=await modal.getByLabel('Odometer out (km)',{exact:true}).boundingBox();const passengersBox=await modal.getByLabel('Passenger(s)',{exact:true}).boundingBox();expect(odoBox!.y).toBeGreaterThan(driverBox!.y+driverBox!.height);expect(odoBox!.y).toBeLessThan(passengersBox!.y);expect(odoBox!.width).toBeLessThanOrEqual(120);
 const fuel=await modal.getByLabel('Fuel (PHP)',{exact:true}).boundingBox();expect(fuel!.width).toBeLessThanOrEqual(150);
 await ot.fill('1.25');expect(await ot.evaluate(input=>(input as HTMLInputElement).validity.patternMismatch)).toBe(true);await ot.fill('2');await ot.blur();await expect(ot).toHaveValue('2.0');
 await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();await expect(modal).not.toBeVisible();await navigate(page,'Trips');await page.getByLabel('Search trips').fill('Hidden stop at Talisay');const row=page.getByRole('row').filter({hasText:'Manila pickup'});await expect(row).toHaveCount(1);await row.getByRole('button',{name:/View TRIP/}).click();await expect(page.getByRole('dialog').locator('.saved-itinerary p')).toHaveText(itinerary);await expect(page.getByRole('dialog')).toContainText('2.0');
});



test('trip register uses eight sortable columns and compact single-line rows',async({page})=>{
 await page.goto('/');await navigate(page,'Trips');const table=page.getByRole('table',{name:'Trip register'});
 expect((await table.getByRole('columnheader').allTextContents()).map(t=>t.trim())).toEqual(['','TripID','Date of trip','Passenger','Itinerary','Charge location','Workflow','Settlement status','Amount']);
 for(const column of ['Date of trip','Passenger','Itinerary','Charge location','Workflow','Settlement status','Amount','TripID']) {
  const button=table.getByRole('button',{name:`Sort by ${column}`,exact:true});await button.click();await expect(button.locator('..')).toHaveAttribute('aria-sort','ascending');await button.click();await expect(button.locator('..')).toHaveAttribute('aria-sort','descending');
 }
 await table.getByRole('button',{name:'Sort by Amount',exact:true}).click();await expect(table.locator('tbody tr').first().getByRole('cell').last()).toHaveText('₱9,500.00');await table.getByRole('button',{name:'Sort by Amount',exact:true}).click();await expect(table.locator('tbody tr').first().getByRole('cell').last()).toHaveText('₱24,000.00');
 for(const row of await table.locator('tbody tr').all()){expect((await row.boundingBox())!.height).toBeLessThanOrEqual(56);await expect(row.getByRole('cell')).toHaveCount(9);await expect(row.locator('small.row-meta')).toHaveCount(0);}
 await expect(table).not.toContainText('Total trip hours');
});
test('exports selected trips only across filters in the current sort order',async({page})=>{
 await page.goto('/');await navigate(page,'Trips');const table=page.getByRole('table',{name:'Trip register'});const exportButton=page.getByRole('button',{name:'Export selected to Excel',exact:true});await expect(exportButton).toBeDisabled();
 const first=table.locator('tbody tr').nth(0),second=table.locator('tbody tr').nth(1);const firstId=(await first.getByRole('button',{name:/^View /}).textContent())!;const secondId=(await second.getByRole('button',{name:/^View /}).textContent())!;await first.getByRole('checkbox').check();await second.getByRole('checkbox').check();
 await table.getByRole('button',{name:'Sort by Date of trip',exact:true}).click();await table.getByRole('button',{name:'Sort by Date of trip',exact:true}).click();await page.getByRole('button',{name:'Corporate',exact:true}).click();await expect(page.getByText('2 selected · includes trips hidden by current filter',{exact:true})).toBeVisible();
 const [download]=await Promise.all([page.waitForEvent('download'),exportButton.click()]);expect(download.suggestedFilename()).toBe('FLSD-DEMO-selected-trips.xlsx');const path=test.info().outputPath('selected-trips.xlsx');await download.saveAs(path);const bytes=await readFile(path);expect(bytes.readUInt32LE(0)).toBe(0x04034b50);
 const content=bytes.toString('utf8');const sheet=content.slice(content.indexOf('<worksheet'),content.indexOf('</worksheet>')+12);expect(sheet).toContain('A1:H3');expect(sheet.indexOf(secondId)).toBeLessThan(sheet.indexOf(firstId));expect(sheet).not.toContain('TRIP-0010');expect(content).toContain('NOT REAL POSTED RECORDS');
 await page.getByRole('button',{name:'Clear selection',exact:true}).click();await expect(exportButton).toBeDisabled();await page.getByRole('button',{name:'All trips',exact:true}).click();await table.getByRole('checkbox',{name:'Select all visible trips',exact:true}).check();await expect(page.getByText('6 selected',{exact:true})).toBeVisible();await table.getByRole('checkbox',{name:'Select all visible trips',exact:true}).uncheck();await expect(exportButton).toBeDisabled();
});
test('Operations sees restricted settlement in both table and Excel export',async({page})=>{
 await page.goto('/');await page.getByLabel('Demo role').selectOption('OPERATIONS');await navigate(page,'Trips');const table=page.getByRole('table',{name:'Trip register'});await expect(table.getByText('Restricted',{exact:true})).toHaveCount(6);await table.locator('tbody tr').first().getByRole('checkbox').check();
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export selected to Excel',exact:true}).click()]);const path=test.info().outputPath('restricted-trips.xlsx');await download.saveAs(path);const content=(await readFile(path)).toString('utf8');const sheet=content.slice(content.indexOf('<worksheet'),content.indexOf('</worksheet>')+12);expect(sheet).toContain('Restricted');expect(sheet).not.toContain('Partially paid');
});


test('SOA editor releases and adds trips, locks final membership, then records customer invoice receipt',async({page})=>{
 await page.goto('/');await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();const modal=page.getByRole('dialog');
 await modal.getByRole('combobox',{name:'Charge to / customer',exact:true}).selectOption('c2');await modal.getByRole('combobox',{name:'Billing workflow',exact:true}).selectOption('CORPORATE');await modal.getByLabel('Destination details / stops',{exact:true}).fill('Northstar additional stop');await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('6000');await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();
 await navigate(page,'Corporate billing');let unbilled=page.getByRole('table',{name:'Unbilled corporate trips',exact:true});await unbilled.getByRole('row').filter({hasText:'Manila → Subic'}).getByRole('checkbox').check();await page.getByRole('button',{name:'Create demo SOA (1)',exact:true}).click();
 await expect(page.getByRole('button',{name:'Create demo invoice',exact:true})).toBeDisabled();await expect(page.getByText('Next demo invoice: DEMO-INV-0001002',{exact:true})).toBeVisible();
 await page.getByRole('button',{name:'Edit SOA',exact:true}).click();let editor=page.getByRole('table',{name:'Edit SOA trips',exact:true});await editor.getByRole('row').filter({hasText:'Northstar additional stop'}).getByRole('checkbox').check();await editor.getByRole('row').filter({hasText:'Manila → Subic'}).getByRole('checkbox').uncheck();await page.getByRole('button',{name:'Save SOA changes',exact:true}).click();
 await expect(page.getByRole('table',{name:'Trips under SOA',exact:true})).toContainText('Northstar additional stop');unbilled=page.getByRole('table',{name:'Unbilled corporate trips',exact:true});await expect(unbilled).toContainText('Manila → Subic');
 await page.getByRole('button',{name:'Edit SOA',exact:true}).click();editor=page.getByRole('table',{name:'Edit SOA trips',exact:true});await editor.getByRole('row').filter({hasText:'Manila → Subic'}).getByRole('checkbox').check();await page.getByRole('button',{name:'Save SOA changes',exact:true}).click();await expect(page.getByRole('button',{name:'Create demo invoice',exact:true})).toBeDisabled();
 await page.getByRole('button',{name:'Finalize SOA',exact:true}).click();await expect(page.getByRole('button',{name:'Edit SOA',exact:true})).toHaveCount(0);const invoiceDate=await page.getByLabel('Corporate invoice date').inputValue();await page.getByRole('button',{name:'Create demo invoice',exact:true}).click();const invoices=page.getByRole('table',{name:'Invoice list',exact:true});const invoice=invoices.getByRole('row').filter({hasText:'DEMO-INV-0001002'});await expect(invoice).toContainText('₱22,000.00');await expect(page.getByText('Next demo invoice: DEMO-INV-0001003',{exact:true})).toBeVisible();
 await invoice.getByRole('button',{name:'Record date',exact:true}).click();await page.getByLabel('Customer received invoice date').fill(invoiceDate);await page.getByLabel('Invoice acknowledgment reference').fill('DEMO customer signed receipt');await page.getByRole('button',{name:'Save received date',exact:true}).click();await expect(invoice).toContainText(invoiceDate);await expect(invoice).toContainText('Unpaid');
 await invoice.getByRole('button',{name:'Preview DEMO-INV-0001002',exact:true}).click();await expect(page.getByRole('dialog').getByRole('table',{name:'Invoice charge breakdown'}).locator('tbody tr')).toHaveCount(2);await page.getByRole('button',{name:'Close preview',exact:true}).click();await page.getByRole('button',{name:'SOA list',exact:true}).click();await expect(page.getByRole('table',{name:'Trips under SOA',exact:true}).locator('tbody tr')).toHaveCount(2);await expect(page.getByRole('button',{name:'Edit SOA',exact:true})).toHaveCount(0);
 await navigate(page,'Collections');await expect(page.getByRole('row')).toHaveCount(5);
});
test('billing views are separate, compact and sortable on all columns, with Viewer writes disabled',async({page})=>{
 await page.goto('/');await navigate(page,'Corporate billing');const unbilled=page.getByRole('table',{name:'Unbilled corporate trips',exact:true});expect((await unbilled.getByRole('columnheader').allTextContents()).map(t=>t.trim())).toEqual(['','TripID','Trip date','Customer','Passenger','Destination','Charge location','Department','Amount']);
 for(const label of ['Trip date','Customer','Passenger','Destination','Charge location','Department','Amount','TripID']){const button=unbilled.getByRole('button',{name:`Sort Unbilled corporate trips by ${label}`,exact:true});await button.click();await expect(button.locator('..')).toHaveAttribute('aria-sort','ascending');await button.click();await expect(button.locator('..')).toHaveAttribute('aria-sort','descending');}
 for(const row of await unbilled.locator('tbody tr').all())expect((await row.boundingBox())!.height).toBeLessThanOrEqual(48);
 let soas=page.getByRole('table',{name:'SOA list',exact:true});await expect(page.getByRole('table',{name:'Invoice list',exact:true})).toHaveCount(0);
 for(const label of ['Customer','Trips','Amount','Status','Invoice number','SOA number']){const button=soas.getByRole('button',{name:`Sort SOA list by ${label}`,exact:true});await button.click();await expect(button.locator('..')).toHaveAttribute('aria-sort','ascending');await button.click();await expect(button.locator('..')).toHaveAttribute('aria-sort','descending');}
 await page.getByRole('button',{name:'Invoice list',exact:true}).click();const invoices=page.getByRole('table',{name:'Invoice list',exact:true});await expect(page.getByRole('table',{name:'SOA list',exact:true})).toHaveCount(0);expect((await invoices.getByRole('columnheader').allTextContents()).map(t=>t.trim())).toEqual(['Invoice number','Invoice date','Customer','Amount','Received date','Status']);
 for(const label of ['Invoice date','Customer','Amount','Received date','Status','Invoice number']){const button=invoices.getByRole('button',{name:`Sort Invoice list by ${label}`,exact:true});await button.click();await expect(button.locator('..')).toHaveAttribute('aria-sort','ascending');await button.click();await expect(button.locator('..')).toHaveAttribute('aria-sort','descending');}
 await page.getByLabel('Demo role').selectOption('VIEWER');await navigate(page,'Corporate billing');await expect(page.getByRole('button',{name:/Create demo SOA/})).toHaveCount(0);soas=page.getByRole('table',{name:'SOA list',exact:true});await soas.getByRole('button',{name:/^SOA-DEMO/}).click();await expect(page.getByRole('button',{name:'Edit SOA',exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Invoice list',exact:true}).click();await expect(page.getByRole('button',{name:'Record date',exact:true})).toHaveCount(0);
});
test('trip itinerary and charge-location previews are bounded while export retains full values',async({page})=>{
 const itinerary='Long whole trip itinerary with several stops and a detailed return route';const location='NORTHSTAR-WAREHOUSE-METRO-MANILA';await page.goto('/');await navigate(page,'Trips');await page.getByRole('button',{name:'New trip',exact:true}).click();const modal=page.getByRole('dialog');await modal.getByLabel('Destination details / stops',{exact:true}).fill(itinerary);await modal.getByLabel('Charge location / site',{exact:true}).fill(location);await modal.getByLabel('Base amount (PHP)',{exact:true}).fill('10000');await modal.getByRole('button',{name:'Create demo trip',exact:true}).click();await navigate(page,'Trips');await page.getByLabel('Search trips').fill('detailed return');const row=page.getByRole('table',{name:'Trip register'}).locator('tbody tr');await expect(row).toHaveCount(1);
 const itineraryCell=row.getByRole('cell').nth(4).locator('span');const locationCell=row.getByRole('cell').nth(5).locator('span');expect(Array.from((await itineraryCell.textContent())!)).toHaveLength(40);expect(Array.from((await locationCell.textContent())!)).toHaveLength(15);await expect(itineraryCell).toHaveAttribute('title',itinerary);await expect(locationCell).toHaveAttribute('title',location);await row.getByRole('checkbox').check();
 const [download]=await Promise.all([page.waitForEvent('download'),page.getByRole('button',{name:'Export selected to Excel',exact:true}).click()]);const path=test.info().outputPath('full-trip-values.xlsx');await download.saveAs(path);const content=(await readFile(path)).toString('utf8');expect(content).toContain(itinerary);expect(content).toContain(location);expect(content).toContain('A1:H2');
});

