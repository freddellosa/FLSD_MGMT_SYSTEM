// Synthetic, isolated browser review. No imported records, app server, database or remote requests.
const fs = require('node:fs'), path = require('node:path'), ts = require('typescript');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..'), prior = require.extensions['.ts'];
(async () => {
 let browser;
 try {
  if (root !== 'D:\\FLSD-Batch7-Validation' || process.argv.length !== 2) throw new Error('Fixed workspace required');
  const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
  require.extensions['.ts'] = (module, filename) => {
   const relative = path.relative(lib, fs.realpathSync(filename));
   if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Local library required');
   module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText, filename);
  };
  const {createDemoSeed} = require('../src/lib/demo/store.ts');
  const {genericFormat, initialCanvas} = require('../src/lib/demo/invoice-formats.ts');
  const {renderInvoiceHtml} = require('../src/lib/demo/invoice-renderer.ts');
  const {renderSoaHtml} = require('../src/lib/demo/soa-renderer.ts');
  const {readTripReference, tripVat, manualTripTotal} = require('../src/lib/domain/trip-reference.ts');
  const parent = path.join(root, 'artifacts');
  if (fs.realpathSync(parent) !== parent) throw new Error('Local artifact directory required');
  const output = fs.mkdtempSync(path.join(parent, 'vat-preview-'));
  browser = await chromium.launch({channel: 'msedge', headless: true});
  const context = await browser.newContext({viewport: {width: 1440, height: 1000}, javaScriptEnabled: false});
  const errors = [], requests = [];
  await context.route('**/*', route => {requests.push(route.request().url()); return route.abort();});
  const page = await context.newPage(); page.on('pageerror', error => errors.push(error.message));
  const checks = [];
  for (const treatment of ['INCLUDED', 'ADDED', 'UNCONFIRMED']) {
   const state = createDemoSeed(), trip = structuredClone(state.trips[0]);
   trip.id = 'SYNTHETIC-VAT-TRIP';trip.itinerary = 'Synthetic route for print review';
   trip.charges = {base:900000n,otFee:100000n,fuel:50000n,toll:10000n,parking:0n,food:0n,lodging:0n,others:0n,othersNote:''};
   trip.reference = {...readTripReference(new FormData()), vatTreatment:treatment, vatReference:treatment==='UNCONFIRMED'?0n:tripVat(trip.charges,treatment)};
   trip.amount=manualTripTotal(trip.charges,trip.reference);state.trips=[trip];
   const invoice=state.documents.find(d=>d.type==='INVOICE');invoice.tripIds=[trip.id];invoice.customerId=trip.customerId;invoice.amountSnapshot=trip.amount;
   const before=JSON.stringify(state,(_,v)=>typeof v==='bigint'?v.toString():v);
   for (const layout of ['FLOW', 'CANVAS', 'ACCESS', 'SOA']) {
    const format=genericFormat();format.layout=layout==='SOA'?'FLOW':layout;
    if(layout==='CANVAS')format.canvas=initialCanvas();
    const html=layout==='SOA'?renderSoaHtml({...invoice,type:'SOA'},state):renderInvoiceHtml(invoice,state,format);
    const name=(layout+'-'+treatment).toLowerCase();
    fs.writeFileSync(path.join(output,name+'.html'),html,{flag:'wx'});
    await page.setViewportSize({width:1440,height:1000});await page.setContent(html);
    if(await page.locator('script,iframe,form').count())throw new Error('Active report content');
    const summary=page.getByRole('region',{name:'Net charges and VAT summary'});
    if(treatment==='UNCONFIRMED') {
     if(await summary.count() || !await page.getByText('Recorded amounts retained.',{exact:false}).count())throw new Error('Historical fallback missing');
    } else {
     await summary.waitFor({state:'visible'});
     const text=await summary.innerText();
     for(const amount of treatment==='INCLUDED'?['8,928.57','1,071.43','600.00','10,600.00']:['10,000.00','1,200.00','600.00','11,800.00'])if(!text.includes(amount))throw new Error('Summary arithmetic display mismatch');
     const geometry=await summary.evaluate(el=>({width:el.getBoundingClientRect().width,scroll:el.scrollWidth,height:el.getBoundingClientRect().height}));
     if(geometry.width<1||geometry.height<1||geometry.scroll>geometry.width+2)throw new Error('Summary clipped');
     if(treatment==='INCLUDED')await page.screenshot({path:path.join(output,name+'-desktop.png'),fullPage:true});
    }
    await page.emulateMedia({media:'print'});
    const pdf=await page.pdf({path:path.join(output,name+'.pdf'),preferCSSPageSize:true,printBackground:true});
    const pages=(pdf.toString('latin1').match(/\/Type\s*\/Page\b/g)||[]).length;
    if(!pages || (layout==='ACCESS' && pages!==2))throw new Error('Unexpected print pagination');
    await page.emulateMedia({media:'screen'});await page.setViewportSize({width:390,height:844});
    if(treatment!=='UNCONFIRMED') {
     if(!await summary.isVisible())throw new Error('Mobile summary missing');
     const mobile=await summary.evaluate(el=>({width:el.getBoundingClientRect().width,scroll:el.scrollWidth}));
     if(mobile.scroll>mobile.width+2)throw new Error('Mobile summary clipped');
     if(treatment==='INCLUDED')await page.screenshot({path:path.join(output,name+'-mobile.png'),fullPage:true});
    }
    checks.push({layout,treatment,pages,mobileVisible:true});
   }
   if(JSON.stringify(state,(_,v)=>typeof v==='bigint'?v.toString():v)!==before)throw new Error('Renderer mutated fixture');
  }
  if(errors.length||requests.length)throw new Error('Browser errors or network attempts');
  const result={kind:'SYNTHETIC_VAT_PREVIEW_CHECK',checks,errors:errors.length,networkAttempts:requests.length,activeContent:0,output,physicalPrintingVerified:false,importEnabled:false,executionAuthorized:false};
  fs.writeFileSync(path.join(output,'checks.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(result));
 } catch(error) {console.error('Synthetic VAT browser review failed: '+error.message);process.exitCode=1;}
 finally {if(browser)await browser.close();if(prior)require.extensions['.ts']=prior;else delete require.extensions['.ts'];}
})();
