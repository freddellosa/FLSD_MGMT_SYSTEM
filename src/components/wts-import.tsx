'use client';
import {usePilot} from './pilot-context';
import { useRef, useState } from 'react';
import { readWtsWorkbook } from '@/lib/import/wts-xlsx';
import { formatPeso } from '@/lib/demo/display';
import DataTable from './ui/data-table';
import {wtsPreviewColumns,wtsPreviewRows} from '@/lib/demo/wts-preview';
import type { DemoAction, DemoState } from '@/lib/demo/store';
type Preview=Awaited<ReturnType<typeof readWtsWorkbook>>;
export default function WtsImport({onCommand,onClose,onImported}:{onImported?:(count:number)=>void;onCommand:(action:DemoAction)=>Promise<DemoState|null>;onClose:()=>void}) {
 const pilot=usePilot();
 const [preview,setPreview]=useState<Preview|null>(null),[error,setError]=useState(''),[busy,setBusy]=useState(false),[name,setName]=useState('');
 const [columns,setColumns]=useState('ALL'),[query,setQuery]=useState('');
 const attempt=useRef(0);
 const clean=preview&&preview.rows.every(r=>!r.errors.length&&r.trip);
 return <dialog className="demo-modal trip-modal wts-preview" data-column-view={columns} aria-labelledby="wts-title" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={onClose}>
 <header><div><span className="eyebrow">LOCAL IMPORT / DEMONSTRATION ONLY</span><h2 id="wts-title">Import Accenture WTS</h2></div><button className="button small" onClick={onClose}>Cancel</button></header>
 <div className="modal-content"><p>Choose an Accenture .xlsx file. Review every row before importing. Each trip receives a new, searchable Trip ID automatically. No SOA, invoice or payment is created.</p>
 <label>WTS workbook<input aria-label="WTS workbook" type="file" accept=".xlsx" disabled={busy} onChange={async e=>{
  const file=e.target.files?.[0];const current=++attempt.current;setPreview(null);setError('');if(!file)return;setBusy(true);setName(file.name);
  try{const result=await readWtsWorkbook(file);if(attempt.current===current)setPreview(result);}catch(err){if(attempt.current===current)setError(err instanceof Error?err.message:'Unable to read WTS');}finally{if(attempt.current===current)setBusy(false);}
 }}/></label>
 {busy&&<p role="status">Checking workbook…</p>}{error&&<div role="alert" className="alert error">{error}</div>}
 {preview&&<><div className="note"><span><b>{name}</b> · {preview.rows.length} trip rows · {preview.rows.filter(r=>r.errors.length).length} rows with errors · Total {formatPeso(preview.rows.reduce((n,r)=>n+(r.trip?.amount??0n),0n))}</span></div>
 <p className="muted">Maps service date, passenger, itinerary, WBS → charge location, Workforce → department, Requester → reserved by, Approver → approved by and matching charge fields. Source references do not become Trip IDs. Unmapped columns are not stored.</p>
 <div className="filter-bar"><label>Show columns<select aria-label="WTS preview columns" value={columns} onChange={e=>setColumns(e.target.value)}><option value="ALL">All trip fields</option><option value="TRIP">Trip and booking details</option><option value="MONEY">Financial breakdown</option></select></label><label>Search preview<input aria-label="Search WTS preview" value={query} onChange={e=>setQuery(e.target.value)}/></label><small>Amounts in PHP. Blank master assignments are shown as Unassigned.</small></div>
 <DataTable name="WTS import preview" rows={wtsPreviewRows(preview.rows,preview.sourceRows).filter(r=>Object.values(r.values).some(v=>String(v).toLowerCase().includes(query.toLowerCase())))} columns={[...wtsPreviewColumns.filter(c=>columns==='ALL'||(columns==='TRIP'?!c.financial||c.key==='amount':c.financial||['row','tripId','date'].includes(c.key))).map(c=>({key:c.key,label:c.label,value:(r:ReturnType<typeof wtsPreviewRows>[number])=>r.values[c.key],render:(r:ReturnType<typeof wtsPreviewRows>[number])=><span title={String(r.values[c.key])}>{c.money&&typeof r.values[c.key]==='bigint'?formatPeso(r.values[c.key] as bigint):String(r.values[c.key])}</span>})),{key:'validation',label:'Validation',value:r=>r.row.errors.join('; '),render:r=><>{r.row.errors.length?<span className="badge amber">{r.row.errors.join('; ')}</span>:<span className="badge green">Ready</span>}{r.row.warnings.map(w=><p className="muted" key={w}>{w}</p>)}</>}]} />
 <p className="panel-footnote">{pilot?'Import is saved to the private pilot database after confirmation.':'Import stays in this tab and is lost on refresh.'} The original workbook is read only and is never uploaded. Imported VAT remains subject to accounting review.</p></>}
 <div className="billing-form-actions"><button className="button" onClick={onClose}>Cancel import</button><button className="button primary" disabled={!clean||busy} onClick={async()=>{
  if(!preview||!clean)return;setBusy(true);const result=await onCommand({type:'IMPORT_WTS',digest:preview.digest,rows:preview.sourceRows,fileName:name});
  if(result){onImported?.(preview.rows.length);onClose();}else{setError('Import was rejected. See the application message; no trips were inserted.');setBusy(false);}
 }}>Import {preview?.rows.length??0} demo trips</button></div></div></dialog>;
}
