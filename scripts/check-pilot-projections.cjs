// Read-only prerequisite for replacing aggregate persistence. No row data exported.
const fs=require('node:fs'),path=require('node:path'),{PrismaClient}=require('@prisma/client');
const root=path.resolve(__dirname,'..');let db;
const canonical=v=>JSON.stringify(v,(_,x)=>x&&typeof x==='object'&&!Array.isArray(x)?Object.fromEntries(Object.keys(x).sort().map(k=>[k,x[k]])):x);
(async()=>{
 const c=JSON.parse(fs.readFileSync(path.join(root,'.pilot/runtime.json'),'utf8'));
 if(root!=='D:\\FLSD-Batch7-Validation'||c.marker!=='FLSD_ISOLATED_PILOT_ONLY'||c.host!=='127.0.0.1'||c.port!==55437||c.database!=='flsd_pilot_validation'||c.user!=='flsd_pilot_app')throw Error('Isolated pilot required');
 db=new PrismaClient({datasources:{db:{url:'postgresql://'+c.user+':'+encodeURIComponent(c.password)+'@127.0.0.1:55437/flsd_pilot_validation?schema=public'}},log:[]});
 const report=await db.$transaction(async tx=>{
  await tx.$executeRawUnsafe('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
  const meta=await tx.$queryRawUnsafe('SELECT marker,schema_version FROM pilot_meta WHERE id=1');if(meta[0]?.marker!==c.marker||meta[0]?.schema_version!==3)throw Error('Pilot identity mismatch');
  const rows=await tx.$queryRawUnsafe('SELECT revision,state FROM pilot_workspace WHERE id=1');if(!rows[0])throw Error('Workspace missing');
  const s=rows[0].state,issues=[],checks=[];
  for(const [table,key,archive] of [['pilot_customers','customers',true],['pilot_vehicles','vehicles',true],['pilot_drivers','drivers',true],['pilot_trips','trips',true],['pilot_documents','documents'],['pilot_receipts','payments'],['pilot_allocations','allocations'],['pilot_refunds','refunds'],['pilot_remittances','remittances'],['pilot_invoice_formats','invoiceFormats'],['pilot_import_batches','importBatches']]){
   const actual=await tx.$queryRawUnsafe('SELECT id,payload FROM '+table+(archive?' WHERE archived=false':''));
   const expected=s[key],index=new Map(actual.map(r=>[r.id,r.payload]));let mismatches=0;
   if(actual.length!==expected.length)issues.push(table+': count mismatch');
   for(const record of expected)if(!index.has(record.id)||canonical(index.get(record.id))!==canonical(record))mismatches++;
   if(mismatches)issues.push(table+': payload mismatches');checks.push({table,expectedRows:expected.length,actualRows:actual.length,mismatches});
  }
  const assignments=await tx.$queryRawUnsafe('SELECT customer_id,format_id FROM pilot_customer_formats'),formats=new Map(assignments.map(a=>[a.customer_id,a.format_id]));
  for(const c of s.customers)if(formats.get(c.id)!==(c.invoiceFormatId??'FORMAT-GENERIC'))issues.push('Customer format assignment mismatch');
  const memberships=await tx.$queryRawUnsafe('SELECT document_id,trip_id FROM pilot_document_trips WHERE current_membership=true');
  const expectedLinks=s.documents.filter(d=>d.stage!=='VOIDED').flatMap(d=>d.tripIds.map(t=>d.id+'\u0000'+t)).sort(),actualLinks=memberships.map(m=>m.document_id+'\u0000'+m.trip_id).sort();
  if(canonical(expectedLinks)!==canonical(actualLinks))issues.push('Current document/trip membership mismatch');
  const settings=await tx.$queryRawUnsafe('SELECT id,payload FROM pilot_settings'),settingMap=new Map(settings.map(r=>[r.id,r.payload]));
  for(const [id,value]of [['dashboard',s.dashboard],['invoice_stock',s.invoiceStock]])if(canonical(settingMap.get(id))!==canonical(value))issues.push('Settings projection mismatch');
  return {verifiedAt:new Date().toISOString(),schemaVersion:3,revision:rows[0].revision,readOnly:true,consistent:issues.length===0,checks,customerFormatChecks:s.customers.length,currentDocumentTripChecks:expectedLinks.length,settingsChecks:2,issues};
 },{timeout:30000});
 fs.mkdirSync(path.join(root,'artifacts/backend-readiness'),{recursive:true});
 fs.writeFileSync(path.join(root,'artifacts/backend-readiness/projection-check.json'),JSON.stringify(report,null,2));
 console.log('Read-only projection verification: '+(report.consistent?'PASS':'FAIL')+'; '+report.checks.length+' entity types, '+report.customerFormatChecks+' customer formats, '+report.currentDocumentTripChecks+' memberships, '+report.settingsChecks+' settings. Metadata-only evidence saved.');
 if(!report.consistent)process.exitCode=1;
})().catch(()=>{console.error('Projection check stopped; no data or credentials logged.');process.exitCode=1;}).finally(async()=>{if(db)await db.$disconnect();});
