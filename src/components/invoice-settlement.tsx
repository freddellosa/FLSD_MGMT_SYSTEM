'use client';
import {usePilot} from './pilot-context';
import { useState } from 'react';
import {readEvidence,type DemoAttachment} from '@/lib/demo/attachments';
import { businessDate,customerName } from '@/lib/demo/billing-register';
import { formatPeso,formatAmount } from '@/lib/demo/display';
import { toCentavos } from '@/lib/domain/billing';
import { tripBalance, type DemoAction, type DemoDocument, type DemoState, type Method } from '@/lib/demo/store';
export default function InvoiceSettlement({invoice,state,onCommand,onClose,commandError}:{invoice:DemoDocument;state:DemoState;onCommand:(a:DemoAction)=>Promise<DemoState|null>;onClose:()=>void;commandError?:string}) {
 const pilot=usePilot();
 const [snapshot]=useState(()=>({version:invoice.version,rows:invoice.tripIds.map(tripId=>({tripId,balance:tripBalance(state,tripId)})).filter(r=>r.balance>0n)}));
 const [receivedDate,setReceivedDate]=useState(businessDate);
 const [mode,setMode]=useState('PAID'),[amounts,setAmounts]=useState<Record<string,string>>({}),[method,setMethod]=useState<Method>('BANK_TRANSFER'),[reference,setReference]=useState(''),[error,setError]=useState(''),[busy,setBusy]=useState(false);
 const [files,setFiles]=useState<DemoAttachment[]>([]),[reading,setReading]=useState(false);
 const balance=snapshot.rows.reduce((n,r)=>n+r.balance,0n);
 let total=0n;try{total=snapshot.rows.reduce((n,r)=>n+(mode==='PAID'?r.balance:toCentavos(amounts[r.tripId]||'0')),0n);}catch{/* Submission shows precise validation error. */}
 return <section className="invoice-settlement" aria-label="Invoice settlement"><h3>Change settlement status</h3><p>Customer: {customerName(invoice.customerId,state)} · Invoice {invoice.invoiceNumber} · Remaining {formatPeso(balance)}. Confirm the actual collection below. Settlement is calculated from these receipts.</p>
 <form onSubmit={async e=>{e.preventDefault();if(busy||reading)return;setBusy(true);try{
  const allocations=snapshot.rows.map(r=>({tripId:r.tripId,expectedBalance:r.balance,amount:mode==='PAID'?r.balance:toCentavos(amounts[r.tripId]||'0')})).filter(r=>r.amount!==0n);
  if(allocations.some(a=>a.amount>a.expectedBalance))throw new Error('An allocation exceeds the remaining balance on its trip.');
  const received=allocations.reduce((n,r)=>n+r.amount,0n);
  if(received<=0n||(mode==='PARTIAL'&&received>=balance))throw new Error('Partial payment must be greater than zero and below the remaining invoice balance.');
  const result=await onCommand({type:'SETTLE_INVOICE',invoiceId:invoice.id,expectedVersion:snapshot.version,allocations,method,reference,receivedDate,files});
  if(result)onClose();else setError('Collection was not saved. Reopen settlement to refresh balances.');
 }catch(cause){setError(cause instanceof Error?cause.message:'Invalid collection');}finally{setBusy(false);}}}>
 {error&&<p className="alert error" role="alert">{commandError||error}</p>}
 <div className="form-grid"><label>Settlement option<select aria-label="Invoice settlement option" value={mode} onChange={e=>setMode(e.target.value)}><option value="PAID">Paid — collect all remaining balances</option><option value="PARTIAL">Partially paid — specify trip allocations</option></select></label><label>Payment method<select aria-label="Invoice collection method" value={method} onChange={e=>setMethod(e.target.value as Method)}><option value="BANK_TRANSFER">Bank transfer</option><option value="GCASH">GCash</option><option value="CASH">Cash received by office</option></select></label></div>
 {mode==='PARTIAL'&&<div className="table-wrap"><table aria-label="Invoice collection allocations"><thead><tr><th>Trip</th><th>Remaining (PHP)</th><th>Apply (PHP)</th></tr></thead><tbody>{snapshot.rows.map(r=><tr key={r.tripId}><td>{r.tripId}</td><td>{formatAmount(r.balance)}</td><td><input aria-label={`Collection for ${r.tripId}`} inputMode="decimal" pattern="[0-9]+([.][0-9]{1,2})?" value={amounts[r.tripId]??''} onChange={e=>setAmounts({...amounts,[r.tripId]:e.target.value})}/></td></tr>)}</tbody></table></div>}
 <label>Collection date<input aria-label="Invoice collection date" type="date" max={businessDate()} value={receivedDate} onChange={e=>setReceivedDate(e.target.value)} required/></label><label>Collection reference / evidence<input aria-label="Invoice collection reference" value={reference} onChange={e=>setReference(e.target.value)} maxLength={200} required/></label><label>Collection evidence attachments<input aria-label="Invoice collection attachments" type="file" accept=".pdf,.png,.jpg,.jpeg,.txt" multiple disabled={busy||reading} onChange={async e=>{setFiles([]);setError('');if(!e.target.files)return;setReading(true);try{setFiles(await readEvidence(e.target.files));}catch(err){setError(err instanceof Error?err.message:'Cannot read evidence');}finally{setReading(false);}}}/></label>{reading&&<p role="status">Reading local evidence...</p>}{files.length>0&&<ul>{files.map((f,i)=><li key={i}>{f.name} ({Math.ceil(f.size/1024)} KB) <button className="text-link" type="button" onClick={()=>setFiles(files.filter((_,n)=>n!==i))}>Remove attachment {i+1}</button></li>)}</ul>}<p className="form-note">PDF, PNG, JPG or TXT; up to 3 files, 5 MB each / 10 MB total. {pilot?'Evidence is saved in the private pilot database; no external upload.':'Stored in this tab only; never uploaded.'}</p><p><b>Confirm office collection: {formatPeso(total)}</b> via {method.replaceAll('_',' ')} for {invoice.invoiceNumber}.</p><p className="form-note">One atomic invoice operation records linked trip receipts in the shared payment system. Partial allocations remain explicit. Existing advances must be reconciled through their original receipt.</p><div className="billing-form-actions"><button type="button" className="button" onClick={onClose}>Cancel settlement</button><button className="button primary" disabled={busy||reading||balance===0n}>Confirm demo invoice collection</button></div></form></section>;
}
