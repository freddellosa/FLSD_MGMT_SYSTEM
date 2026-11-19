import {test,expect,type Page} from '@playwright/test';
import {readFile} from 'node:fs/promises';
const csv=(name:string,content:string)=>({name,mimeType:'text/csv',buffer:Buffer.from(content,'utf8')});
async function references(p:Page){
 for(const [kind,name,id]of [['customer','customers','C1'],['vehicle','vehicles','V1'],['driver','drivers','D1']] as const){await p.getByLabel('Optional '+kind+' CSV export',{exact:true}).setInputFiles(csv(name+'.csv','ID,Name\n'+id+',QA reference'));await expect(p.getByLabel(kind+' export ID column')).toBeVisible();}
}
test('Access exports are inspected locally with exact mappings, fingerprints and downloadable exceptions',async({page})=>{
 const apiRequests:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))apiRequests.push(r.url());});
 await page.goto('/import-preflight');await page.getByLabel('Choose an exported Trips CSV file').setInputFiles(csv('trips.csv','TripID,DateOfTrip_Start,TotalCharge,CustomerID,VehicleID,DriverID,Paid\nT1,11/15/2026,"1,234.56",C1,V1,D1,Yes\nT2,2026-11-15,200,C1,V1,D1,No\nT2,invalid,200,C1,V1,D1,No\nOLD,2024-12-31,100,C1,V1,D1,Yes'));
 await references(page);await expect(page.getByText('Agreed charges passing selected checks:')).toContainText('1234.56');
 await page.getByText('Trip exceptions (2)',{exact:true}).click();await expect(page.getByRole('table',{name:'Access trip exceptions'}).locator('tbody tr')).toHaveCount(2);
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download preflight report',exact:true}).click();const download=await pending;
 const report=JSON.parse(await readFile((await download.path())!,'utf8'));expect(report.sourceFiles.trips.sha256).toMatch(/^[a-f0-9]{64}$/);expect(report.report.counts).toEqual({EXCLUDED:1,REJECTED:2,REVIEW:0,VALIDATED:1});expect(report.report.validatedAgreedCentavos).toBe('123456');expect(report.report.importEnabled).toBe(false);expect(report.report.rows[0]).not.toHaveProperty('receipt');expect(apiRequests).toEqual([]);
 await page.getByRole('button',{name:'Remove trips export',exact:true}).click();await expect(page.getByRole('heading',{name:'Preflight results',exact:true})).toHaveCount(0);
 await page.getByLabel('Choose an exported Trips CSV file').setInputFiles(csv('trips.csv','TripID,DateOfTrip_Start\nT3,2026-11-15'));await expect(page.getByRole('heading',{name:'Preflight results',exact:true})).toBeVisible();
});
test('Access amounts require an explicit mapping and VAT remains review-only',async({page})=>{
 await page.goto('/import-preflight');await page.getByLabel('Choose an exported Trips CSV file').setInputFiles(csv('access.csv','TripID,DateOfTrip_Start,Amount,CustomerID,VehicleID,DriverID,VAT\nT1,2026-11-15,1120,C1,V1,D1,120'));
 await references(page);await expect(page.getByLabel('Agreed TOTAL charge (confirm source meaning)')).toHaveValue('');await page.getByLabel('Agreed TOTAL charge (confirm source meaning)').selectOption('Amount');
 await page.getByText('Trip exceptions (1)',{exact:true}).click();await expect(page.getByRole('table',{name:'Access trip exceptions'})).toContainText('inclusive/exclusive treatment requires accounting confirmation');await expect(page.getByRole('button',{name:/^Import /})).toHaveCount(0);
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});

test('monthly customer review retains zero usage, counts fixed charge once and downloads its evidence',async({page})=>{
 const apiRequests:string[]=[];page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))apiRequests.push(r.url());});
 await page.goto('/import-preflight');await page.getByLabel('Choose an exported Trips CSV file').setInputFiles(csv('monthly.csv','tmpInvoiceNo,DateOfTrip_Start,InvoiceTotAmt,BaseAmount,CompanyID,VehicleID,DriverID\nM1,10/31/2026,1120,1000,C1,V1,D1\nU1,10/1/2026,0,0,C1,V1,D1\nU2,10/2/2026,25.01,0,C1,V1,D1'));
 await references(page);await page.getByLabel('Review annual monthly fixed-rate billing').check();
 await page.getByLabel('Monthly customer source ID').fill('C1');await page.getByLabel('Monthly billing period').fill('2026-10');await page.getByLabel('Monthly fixed-rate Trip ID').fill('M1');
 const summary=page.getByRole('region',{name:'Monthly charge summary'});
 await expect(summary).toContainText('1145.01');await expect(summary).toContainText('2 usage trips; 1 zero-charge operational records');
 await expect(page.getByText('Trip exceptions (0)',{exact:true})).toBeVisible();
 const pending=page.waitForEvent('download');await page.getByRole('button',{name:'Download preflight report',exact:true}).click();
 const report=JSON.parse(await readFile((await (await pending).path())!,'utf8'));
 expect(report.report.rows[1]).toMatchObject({billingRole:'MONTHLY_USAGE',fixedChargeTripId:'M1',status:'VALIDATED',agreedCentavos:'0'});
 expect(report.monthlyBilling[0].fixedChargeCounted).toBe(1);expect(report.monthlyBilling[0].totals.combinedRecordedGross).toBe('1145.01');expect(apiRequests).toEqual([]);
});

test('monthly preflight refuses a wrong-customer anchor without losing source selections',async({page})=>{
 await page.goto('/import-preflight');await page.getByLabel('Choose an exported Trips CSV file').setInputFiles(csv('monthly.csv','tmpInvoiceNo,DateOfTrip_Start,InvoiceTotAmt,BaseAmount,CompanyID,VehicleID,DriverID\nM1,10/31/2026,1120,1000,C1,V1,D1\nU1,10/1/2026,0,0,C1,V1,D1'));
 await page.getByLabel('Review annual monthly fixed-rate billing').check();await page.getByLabel('Monthly customer source ID').fill('C2');await page.getByLabel('Monthly billing period').fill('2026-10');await page.getByLabel('Monthly fixed-rate Trip ID').fill('M1');
 await expect(page.getByRole('main').getByRole('alert').filter({hasText:'Monthly charge row must match customer and month'})).toBeVisible();
 await expect(page.getByLabel('Monthly customer source ID')).toHaveValue('C2');await expect(page.getByLabel('Source trip ID',{exact:true})).toHaveValue('tmpInvoiceNo');
 await page.setViewportSize({width:390,height:844});expect(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth)).toBe(true);
});
test('invalid Access files fail clearly without leaving stale results',async({page})=>{
 await page.goto('/import-preflight');await page.getByLabel('Choose an exported Trips CSV file').setInputFiles(csv('trips.csv','TripID,DateOfTrip_Start\nT1,2026-11-15'));await expect(page.getByRole('heading',{name:'Preflight results',exact:true})).toBeVisible();
 await page.getByLabel('Choose an exported Trips CSV file').setInputFiles({name:'ansi.csv',mimeType:'text/csv',buffer:Buffer.from([0x54,0x72,0x69,0x70,0xe9])});await expect(page.getByRole('main').getByRole('alert')).toContainText('not valid UTF-8');await expect(page.getByRole('heading',{name:'Preflight results',exact:true})).toHaveCount(0);
 await page.getByLabel('Choose an exported Trips CSV file').setInputFiles(csv('duplicate.csv','TripID,TripID\nT1,T1'));await expect(page.getByRole('main').getByRole('alert')).toContainText('duplicate CSV header');
});
test('Access formatted currency and mismatched display keys show actionable local diagnostics',async({page})=>{
 await page.goto('/import-preflight');await page.getByLabel('Choose an exported Trips CSV file').setInputFiles(csv('formatted.csv','TripID,DateOfTrip_Start,TotalCharge,CustomerID,VehicleID,DriverID,VAT\nT1,2026-11-15,"PHP 20,000.0000",Company A,V1,D1,\nT2,2026-11-15,1000.0001,Company A,V1,D1,0.0000'));
 await page.getByLabel('Optional customer CSV export',{exact:true}).setInputFiles(csv('customers.csv','ID,Company\n99,Company A'));await expect(page.getByLabel('customer export ID column')).toBeVisible();
 for(const [kind,id]of [['vehicle','V1'],['driver','D1']] as const){await page.getByLabel('Optional '+kind+' CSV export',{exact:true}).setInputFiles(csv(kind+'.csv','ID,Name\n'+id+',QA'));await expect(page.getByLabel(kind+' export ID column')).toBeVisible();}
 const check=page.getByRole('article',{name:'customer reference check'});await expect(check).toContainText('0 of 2 trip references matched');await expect(check).toContainText('Company A');await expect(check).toContainText('99');
 await check.getByRole('button',{name:'Use customer export column Company (2 exact matches)',exact:true}).click();await expect(check).toContainText('2 of 2 trip references matched');await expect(page.getByLabel('customer export ID column')).toHaveValue('Company');
 await page.getByText('Trip exceptions (2)',{exact:true}).click();const rows=page.getByRole('table',{name:'Access trip exceptions'}).locator('tbody tr');await expect(rows.nth(0)).toContainText('REVIEW');await expect(rows.nth(0)).toContainText('No zero was assumed');await expect(rows.nth(1)).toContainText('1000.0001');await expect(rows.nth(1)).toContainText('Meaningful precision below one centavo');
 expect(await rows.nth(1).locator('td').nth(2).evaluate(n=>getComputedStyle(n).whiteSpace)).toBe('nowrap');
});
