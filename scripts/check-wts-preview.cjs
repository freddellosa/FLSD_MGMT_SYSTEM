// Read-only workbook inspection through isolated demo browser memory. Logs counts only.
const {chromium}=require('playwright');
(async()=>{
 const browser=await chromium.launch({channel:'msedge'});
 try{
  const page=await browser.newPage();
  await page.goto(process.argv[3]||'http://127.0.0.1:3001');
  await page.getByRole('navigation').getByRole('button',{name:'Trips',exact:true}).click();
  await page.getByRole('button',{name:'Import Accenture WTS',exact:true}).click();
  await page.getByLabel('WTS workbook').setInputFiles(process.argv[2]);
  await page.getByRole('dialog').getByRole('status').waitFor({state:'hidden'});
  const error=page.getByRole('dialog').getByRole('alert');
  if(await error.count())throw new Error(await error.textContent());
  const rows=page.getByRole('table',{name:'WTS import preview'}).locator('tbody tr');
  console.log('Preview row count:',await rows.count());
  console.log('Ready row count:',await rows.filter({has:page.getByText('Ready',{exact:true})}).count());
  const submit=page.getByRole('button',{name:/Import \d+ demo trips/});
  console.log('Import enabled:',await submit.isEnabled());
  if(await submit.isEnabled()){
   await submit.click();
   console.log('Trip register row count after demo import:',await page.getByRole('table',{name:'Trip register',exact:true}).locator('tbody tr').count());
  }else{
   const issues=await rows.locator('.badge.amber').allTextContents();
   console.log('Validation issues:',[...new Set(issues)]);
   process.exitCode=1;
  }
 }finally{await browser.close();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
