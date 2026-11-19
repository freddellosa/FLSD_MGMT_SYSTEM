'use client';
import {useMemo,useRef,useState} from 'react';
import Link from 'next/link';
import {parseCsv} from '@/lib/migration/csv';
import {stageAccessTrips,suggestReferenceColumns,type AccessColumns,type AccessReference,type AccessRow,type ReferenceKind} from '@/lib/migration/access-staging';
import {fromCentavos} from '@/lib/domain/billing';
import {reviewMonthlyBilling} from '@/lib/migration/monthly-billing';

type SourceFile={name:string;sha256:string;rows:AccessRow[];headers:string[]};
type FileKind='trips'|ReferenceKind;
const fieldSpecs:[keyof AccessColumns,string,string[]][]=[
 ['id','Source trip ID',['tmpInvoiceNo','TripID','TripId','ID']],['startDate','Trip start date',['DateOfTrip_Start','tripStart']],
 ['agreedCharge','Agreed TOTAL charge (confirm source meaning)',['TotalCharge','TripTotal']],
 ['customer','Source customer reference',['CompanyID','CustomerID']],['vehicle','Source vehicle reference',['VehicleID']],['driver','Source driver reference',['DriverID']],
 ['vat','Recorded VAT amount',['Evat','VAT']],['withholding','Recorded withholding amount',['Withholding','EWT']],
];
export default function AccessPreflight(){
 const [files,setFiles]=useState<Partial<Record<FileKind,SourceFile>>>({});
 const [columns,setColumns]=useState<AccessColumns>({id:'',startDate:''});
 const [referenceIds,setReferenceIds]=useState<Partial<Record<ReferenceKind,string>>>({});
 const [monthlyEnabled,setMonthlyEnabled]=useState(false),[monthly,setMonthly]=useState({customerId:'',month:'',fixedChargeTripId:''});
 const [errors,setErrors]=useState<Partial<Record<FileKind,string>>>({}),[busy,setBusy]=useState<Partial<Record<FileKind,boolean>>>({});
 const versions=useRef<Record<FileKind,number>>({trips:0,customer:0,vehicle:0,driver:0});
 const inputs=useRef<Partial<Record<FileKind,HTMLInputElement|null>>>({});
 async function inspect(kind:FileKind,file:File|undefined){
  const version=++versions.current[kind];setFiles(v=>({...v,[kind]:undefined}));setErrors(v=>({...v,[kind]:''}));setBusy(v=>({...v,[kind]:!!file}));
  if(!file)return;
  if(kind==='trips')setMonthlyEnabled(false);
  try{
   if(!file.name.toLowerCase().endsWith('.csv'))throw new Error('Export the Access table as CSV with headers and UTF-8 encoding.');
   if(file.size>30*1024*1024)throw new Error('File exceeds 30 MB. Split the export before inspection.');
   const bytes=await file.arrayBuffer();let text:string;
   try{text=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{throw new Error('This file is not valid UTF-8. Re-export it with UTF-8 encoding.');}
   const rows=parseCsv(text);if(!rows.length||rows.length>100000)throw new Error('Choose a CSV with 1 to 100,000 data rows.');
   const sha256=[...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(b=>b.toString(16).padStart(2,'0')).join('');
   if(versions.current[kind]!==version)return;
   const headers=Object.keys(rows[0]);setFiles(v=>({...v,[kind]:{name:file.name,sha256,rows,headers}}));
   if(kind==='trips')setColumns(Object.fromEntries(fieldSpecs.map(([key,,candidates])=>[key,key==='agreedCharge'&&headers.includes('tmpInvoiceNo')&&headers.includes('InvoiceTotAmt')?'InvoiceTotAmt':candidates.find(c=>headers.includes(c))??''])) as AccessColumns);
   else setReferenceIds(v=>({...v,[kind]:[...(kind==='customer'?['CompanyID']:[]),kind[0].toUpperCase()+kind.slice(1)+'ID','ID'].find(c=>headers.includes(c))??''}));
  }catch(e){if(versions.current[kind]===version)setErrors(v=>({...v,[kind]:e instanceof Error?e.message:'Unable to inspect export'}));}
  finally{if(versions.current[kind]===version)setBusy(v=>({...v,[kind]:false}));}
 }
 const inspected=useMemo(()=>{
  if(!files.trips)return {};
  try{
   const references:Partial<Record<ReferenceKind,AccessReference>>={};
   for(const kind of ['customer','vehicle','driver'] as const)if(files[kind])references[kind]={idColumn:referenceIds[kind]??'',rows:files[kind]!.rows};
   const monthlyBilling=monthlyEnabled?(()=>{
    if(!monthly.customerId||!monthly.month||!monthly.fixedChargeTripId||!columns.customer||!columns.agreedCharge||!files.trips!.headers.includes('BaseAmount'))throw new Error('For monthly review, enter the customer ID, month and fixed-rate Trip ID, and map customer, total charge and BaseAmount source fields.');
    const rows=files.trips!.rows.map(r=>({...r,tmpInvoiceNo:r[columns.id],CompanyID:r[columns.customer!],DateOfTrip_Start:r[columns.startDate],InvoiceTotAmt:r[columns.agreedCharge!]}));
    return reviewMonthlyBilling(rows,[{...monthly,contractTerm:'ANNUAL',billingUnit:'CUSTOMER'}]);
   })():[];
   return {report:stageAccessTrips({trips:files.trips.rows,columns,references,monthlyUsageEvidence:monthlyBilling.flatMap(c=>c.usageEvidence)}),monthlyBilling};
  }catch(e){return {error:e instanceof Error?e.message:'Review the selected mappings'};}
 },[files,columns,referenceIds,monthlyEnabled,monthly]);
 const report=inspected.report,loading=Object.values(busy).some(Boolean);
 const suggestions=useMemo(()=>Object.fromEntries((['customer','vehicle','driver'] as const).map(kind=>{
  const column=columns[kind],reference=files[kind];
  const values=files.trips&&column&&report?report.rows.filter(r=>r.status!=='EXCLUDED').map(r=>files.trips!.rows[r.row-2][column]):[];
  return [kind,reference&&values.length?suggestReferenceColumns(values,reference.rows):[]];
 })),[files,columns,report]);
 const samples=(values:string[])=>[...new Set(values)].slice(0,3).map(v=>v===''?'[blank]':JSON.stringify(v.length>80?v.slice(0,80)+'…':v)).join(', ');
 function download(){
  if(!report||loading)return;
  const sourceFiles=Object.fromEntries(Object.entries(files).filter(([,f])=>!!f).map(([kind,f])=>[kind,{fileName:f!.name,sha256:f!.sha256,rowCount:f!.rows.length}]));
  const text=JSON.stringify({kind:'OFFLINE_ACCESS_PREFLIGHT',version:1,createdAt:new Date().toISOString(),sourceFiles,columns,referenceIdColumns:referenceIds,report,monthlyBilling:inspected.monthlyBilling??[]},(_,v)=>typeof v==='bigint'?v.toString():v,2);
  const url=URL.createObjectURL(new Blob([text],{type:'application/json'})),link=document.createElement('a');link.href=url;link.download='flsd-access-preflight.json';link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }
 const choose=(kind:FileKind,title:string)=><section className="panel" key={kind}>
  <h2>{title}</h2><label htmlFor={'access-'+kind}>{kind==='trips'?'Choose an exported Trips CSV file':'Optional '+kind+' CSV export'}</label>
  <input id={'access-'+kind} type="file" accept=".csv,text/csv" ref={node=>{inputs.current[kind]=node;}} onChange={e=>void inspect(kind,e.target.files?.[0])}/>
  {busy[kind]&&<p role="status">Reading export locally…</p>}{errors[kind]&&<p role="alert" className="alert error">{errors[kind]}</p>}
  {files[kind]&&<><p>{files[kind]!.name} · {files[kind]!.rows.length.toLocaleString()} rows</p>
   {kind!=='trips'&&<label>Unique {kind} source key<select aria-label={kind+' export ID column'} value={referenceIds[kind]??''} onChange={e=>setReferenceIds(v=>({...v,[kind]:e.target.value}))}><option value="">Select source key</option>{files[kind]!.headers.map(h=><option key={h} value={h}>{h}</option>)}</select></label>}
   <button className="button" onClick={()=>{if(inputs.current[kind])inputs.current[kind]!.value='';void inspect(kind,undefined);}}>Remove {kind} export</button></>}
 </section>;
 return <main className="access-preflight">
  <nav aria-label="Preflight navigation"><Link href="/billing-review">Billing review</Link><Link href="/pilot">Back to pilot</Link><Link href="/">Offline demo</Link></nav>
  <header><span className="eyebrow">MIGRATION PREPARATION</span><h1>MS Access export preflight</h1><p>Choose separate CSV exports with column headers and UTF-8 encoding. Files stay in this browser. Nothing is uploaded, saved to PostgreSQL, or imported.</p></header>
  <p className="alert">2025 onward · 30 MB and 100,000 rows per file. Passing selected checks does not approve tax treatment, opening balances, invoice history or a live import.</p>
  <div className="source-grid">{choose('trips','1. Trips export')}{choose('customer','2. Customer references')}{choose('vehicle','3. Vehicle references')}{choose('driver','4. Driver references')}</div>
  {files.trips&&<section className="panel"><h2>Match the source columns</h2><p>Use the agreed total charge, not a base amount unless both mean the same thing in your source. Unmapped columns are not validated. Relationships match exact exported keys; names are never merged automatically.</p><div className="mapping-grid">{fieldSpecs.map(([key,label])=><label key={key}>{label}<select aria-label={label} value={columns[key]??''} onChange={e=>setColumns(v=>({...v,[key]:e.target.value}))}><option value="">Not mapped</option>{files.trips!.headers.map(h=><option key={h} value={h}>{h}</option>)}</select></label>)}</div></section>}
  {files.trips&&<section className="panel"><h2>Monthly fixed-rate review</h2><label><input type="checkbox" aria-label="Review annual monthly fixed-rate billing" checked={monthlyEnabled} onChange={e=>setMonthlyEnabled(e.target.checked)}/>Annual customer contract billed monthly</label><p>One designated trip holds the fixed charge for the customer/month. Usage trips retain their recorded OT/other charges; zero-charge usage is operational history.</p>{monthlyEnabled&&<div className="mapping-grid"><label>Customer source ID<input aria-label="Monthly customer source ID" value={monthly.customerId} onChange={e=>setMonthly({...monthly,customerId:e.target.value})}/></label><label>Billing month<input type="month" aria-label="Monthly billing period" value={monthly.month} onChange={e=>setMonthly({...monthly,month:e.target.value})}/></label><label>Fixed-rate Trip ID<input aria-label="Monthly fixed-rate Trip ID" value={monthly.fixedChargeTripId} onChange={e=>setMonthly({...monthly,fixedChargeTripId:e.target.value})}/></label></div>}{inspected.monthlyBilling?.map(c=><div key={c.definition.customerId+c.definition.month} role="region" aria-label="Monthly charge summary"><h3>Customer {c.definition.customerId} · {c.definition.month}</h3><p>Fixed-charge trip: <strong>{c.fixedCharge.sourceTripId}</strong> · counted once</p><p>Recorded fixed gross: PHP {c.totals.fixedGross}<br/>Recorded extra gross: PHP {c.totals.recordedExtrasGross}<br/><strong>Combined recorded gross: PHP {c.totals.combinedRecordedGross}</strong></p><p>{c.usageRows.length} usage trips; {c.usageRows.filter(r=>r.zeroGross).length} zero-charge operational records. No payment status or receipts are inferred.</p></div>)}</section>}
  {inspected.error&&<p role="alert" className="alert error">{inspected.error}</p>}
  {report&&!loading&&<section className="panel"><h2>Preflight results</h2><div className="counts">{([['Passed selected checks',report.counts.VALIDATED],['Needs review',report.counts.REVIEW],['Rejected',report.counts.REJECTED],['Excluded before 2025',report.counts.EXCLUDED]] as const).map(([label,count])=><div key={label}><small>{label}</small><strong>{count.toLocaleString()}</strong></div>)}</div>
   <h3>Check reference mappings before changing source data</h3><p>Each Trips reference must match the selected source key in its exported reference table. For example, a company name will not match a numeric customer ID. Suggestions below use exact unique values and require your selection.</p>
   <div className="mapping-grid">{report.relationshipChecks.map(check=>{
    const reference=files[check.kind],column=columns[check.kind];
    return <article className="key-check" key={check.kind} aria-label={check.kind+' reference check'}><strong>{check.kind[0].toUpperCase()+check.kind.slice(1)}: {check.matched} of {check.checked} trip references matched</strong>
     <p>Trips column: <b>{column||'Not mapped'}</b><br/>Export key: <b>{check.referenceColumn||'Not selected'}</b></p>
     {column&&<p>Trips examples: <code>{samples(files.trips!.rows.map(r=>r[column]))}</code></p>}
     {reference&&check.referenceColumn&&<p>Export examples: <code>{samples(reference.rows.map(r=>r[check.referenceColumn!]))}</code></p>}
     {check.missing>0&&<p className="mapping-warning">{check.missing} not found. Check both selected columns before editing the source.</p>}
     {check.ambiguous>0&&<p className="mapping-warning">{check.ambiguous} have duplicate reference keys.</p>}
     {check.unverified>0&&<p>{check.unverified} need a column mapping or reference export.</p>}
     {suggestions[check.kind].filter(s=>s.column!==check.referenceColumn).map(s=><button className="button small" key={s.column} onClick={()=>setReferenceIds(v=>({...v,[check.kind]:s.column}))}>Use {check.kind} export column {s.column} ({s.matched} exact matches)</button>)}
    </article>;
   })}</div>
   <p>Agreed charges passing selected checks: <strong>₱{fromCentavos(report.validatedAgreedCentavos)}</strong></p>
   {report.counts.VALIDATED===0&&<p className="mapping-warning">₱0.00 here means no trips passed every selected check. It does not mean the source trips have zero charges. Review the mapped amounts and reference keys below.</p>}
   <p>No receipts, paid status or accounting entries are inferred from source labels. VAT and withholding values are retained for review.</p>
   {report.referenceIssues.length>0&&<div className="alert error"><h3>Reference export issues</h3><ul>{report.referenceIssues.slice(0,100).map((r,i)=><li key={i}>{r.kind} row {r.row}: {r.message}</li>)}</ul></div>}
   <details><summary>Trip exceptions ({report.counts.REVIEW+report.counts.REJECTED})</summary><p>First 100 exceptions shown; download includes every row result.</p><div className="exception-table"><table aria-label="Access trip exceptions"><colgroup><col style={{width:50}}/><col style={{width:120}}/><col style={{width:105}}/><col/></colgroup><thead><tr><th>Row</th><th>Source trip ID</th><th>Status</th><th>Details</th></tr></thead><tbody>{report.rows.filter(r=>r.status==='REVIEW'||r.status==='REJECTED').slice(0,100).map(r=><tr key={r.row}><td>{r.row}</td><td title={r.sourceId}>{r.sourceId||'Missing'}</td><td>{r.status}</td><td>{[...r.errors,...r.review].join('; ')}{r.diagnostics.map((d,i)=><div className="source-value" key={i}><b>{d.field}</b>: Trips column <code>{d.sourceColumn}</code> contains <code>{d.sourceValue===''?'[blank]':JSON.stringify(d.sourceValue)}</code>{d.referenceColumn&&<>; compared with export column <code>{d.referenceColumn}</code></>}</div>)}</td></tr>)}</tbody></table></div></details>
   <button className="button primary" onClick={download}>Download preflight report</button><p><small>Report includes source-file fingerprints, selected mappings, source IDs, bounded diagnostic values and row results. Keep it private. Original source files remain unchanged. Import is not enabled.</small></p>
  </section>}
  <style jsx>{`
   .access-preflight{max-width:1100px;margin:auto;padding:24px;color:var(--text-primary,#17213a)}
   nav{display:flex;gap:20px;margin-bottom:24px}nav a{text-decoration:underline}header{margin-bottom:20px}h1{font-size:28px;font-weight:750}h2{font-size:17px;font-weight:700;margin-bottom:10px}p{margin:10px 0;line-height:1.5}
   .source-grid,.mapping-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px;margin:20px 0}.source-grid .panel{min-width:0}.panel{padding:20px;margin-bottom:16px}label{display:grid;gap:6px;font-size:13px}select{min-height:38px;height:auto;line-height:1.4;padding:8px;width:100%;color:var(--text-primary,#17213a);background:var(--surface,#fff)}input[type=file]{width:100%;margin:12px 0;font-size:13px}.counts{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:16px 0}.counts div{padding:12px;background:var(--surface-muted,#f4f6fb);border-radius:10px}.counts strong{display:block;font-size:26px}.button{margin-top:12px}summary{cursor:pointer;font-weight:650}.exception-table{overflow-x:auto}table{width:100%;min-width:650px;table-layout:fixed;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:8px;vertical-align:top;border-bottom:1px solid #e1e6ef;overflow-wrap:anywhere}th:nth-child(-n+3),td:nth-child(-n+3){white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.key-check{padding:14px;background:#f4f6fb;border-radius:10px;min-width:0;overflow-wrap:anywhere}.mapping-warning{color:#9b3f00}.source-value{margin-top:6px;padding:6px;background:#f4f6fb;border-radius:5px}code{white-space:pre-wrap;overflow-wrap:anywhere}ul{padding-left:20px;list-style:disc}
   @media(max-width:700px){.access-preflight{padding:16px}.source-grid,.mapping-grid{grid-template-columns:1fr}.counts{grid-template-columns:repeat(2,1fr)}}
  `}</style>
 </main>;
}
