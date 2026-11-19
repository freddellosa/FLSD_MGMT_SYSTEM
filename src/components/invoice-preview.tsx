'use client';
import { useState } from 'react';
import InvoiceSettlement from './invoice-settlement';
import InvoicePrintReport from './invoice-print-report';
import { can,type Role } from '@/lib/security/permissions';
import { formatPeso as money } from '@/lib/demo/display';
import { activeInvoice } from '@/lib/demo/invoice-lifecycle';
import {billingTripRows,billingChargeTotals} from '@/lib/demo/billing-register';
import { customerName } from '@/lib/demo/billing-register';
import { tripBalance,type DemoAction,type DemoDocument,type DemoState } from '@/lib/demo/store';
export default function InvoicePreview({invoice,state,role,onCommand,onClose,commandError}:{invoice:DemoDocument;state:DemoState;role:Role;onCommand:(a:DemoAction)=>Promise<DemoState|null>;onClose:()=>void;commandError?:string}) {
 const [settling,setSettling]=useState(false),[printing,setPrinting]=useState(false);
 const [edit,setEdit]=useState<{version:number;date:string;description:string}|null>(null),[reason,setReason]=useState(''),[error,setError]=useState('');
 const [cancellation,setCancellation]=useState<Extract<DemoAction,{type:'CANCEL_INVOICE'}>|null>(null);
 const [cancelling,setCancelling]=useState(false);
 const write=can(role,'invoice:write'),active=activeInvoice(invoice),print=invoice.printState??'UNPRINTED';
 const trips=invoice.tripIds.map(id=>state.trips.find(t=>t.id===id)!);
 async function command(action:DemoAction){const result=await onCommand(action);setError(result?'':'Action rejected. Check the application message; no records were changed.');return result;}
 const version={invoiceId:invoice.id,expectedVersion:invoice.version};
 const totals=billingChargeTotals(billingTripRows(trips,state));
 const outstanding=trips.reduce((n,t)=>n+tripBalance(state,t.id),0n);
 return <dialog className="demo-modal trip-modal invoice-preview" aria-labelledby="invoice-preview-title" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={onClose}>
 <header><div><span className="eyebrow">DEMONSTRATION / NOT A TAX INVOICE</span><h2 id="invoice-preview-title">Invoice preview · {invoice.invoiceNumber}</h2></div><div className="invoice-primary-actions">{active&&can(role,'invoice:print')&&<button className="button" disabled={!['UNPRINTED','CLEAN_USABLE'].includes(print)} onClick={()=>setPrinting(true)}>PRINT</button>}{write&&active&&<button className="button" disabled={!!edit} onClick={()=>setEdit({version:invoice.version,date:invoice.receivedDate??'',description:invoice.description??''})}>Edit invoice</button>}{active&&can(role,'payment:write')&&<button className="button primary" disabled={outstanding===0n||settling} onClick={()=>setSettling(true)}>Change settlement status</button>}</div><button className="button" onClick={onClose}>Close preview</button></header>
 <div className="modal-content">{printing&&<InvoicePrintReport invoice={invoice} state={state} onClose={()=>setPrinting(false)}/>}{error&&<div className="alert error" role="alert">{commandError||error}</div>}
 <div className="detail-grid"><div><span>Customer</span><b>{customerName(invoice.customerId,state)}</b></div><div><span>Invoice date</span><b>{invoice.invoiceDate}</b></div><div><span>SOA</span><b>{invoice.soaId??'Direct trip'}</b></div><div><span>Received date · customer acknowledgment</span><b>{invoice.receivedDate??'Not recorded'}</b></div><div><span>Amount</span><b>{money(invoice.amountSnapshot)}</b></div><div><span>State / form condition</span><b>{invoice.invoiceState??'ACTIVE'} / {print.replaceAll('_',' ')}</b></div><div><span>Settlement status</span><b>{!active?'Inactive assignment':outstanding===0n?'Paid':outstanding<invoice.amountSnapshot?'Partially paid':'Unpaid'}</b></div></div>
 <section><h3>Description</h3><p style={{whiteSpace:'pre-wrap'}}>{invoice.description||'Transportation services for the trips listed below.'}</p></section>
 {state.collectionEvidence.filter(e=>e.invoiceId===invoice.id).map(e=><details key={e.id}><summary>{state.certificates2307?.some(c=>e.files.some((_,index)=>c.attachmentId===e.id+'-'+index))?'Form 2307 evidence':'Collection evidence'} ({e.files.length}){e.paymentIds.length>0?' - '+e.paymentIds.join(', '):''}</summary>{e.files.map((f,i)=><a className="button small" key={i} href={f.downloadUrl??f.data} download={f.name}>Download {f.name}</a>)}</details>)}
 <h3>Breakdown of charges</h3><div className="table-wrap"><table aria-label="Invoice charge breakdown"><thead><tr>{['TripID','Trip date','Itinerary','Base','OT','Fuel','Toll','Parking','Food','Lodging','Others','VAT reference','Total'].map(label=><th key={label}>{label}</th>)}</tr></thead><tbody>{trips.map(t=>{const c=t.charges;return <tr key={t.id}><td>{t.id}</td><td>{t.date}</td><td>{t.itinerary||[t.origin,t.destination].filter(Boolean).join(' → ')}</td>{[c?.base??t.amount,c?.otFee??0n,c?.fuel??0n,c?.toll??0n,c?.parking??0n,c?.food??0n,c?.lodging??0n,c?.others??0n,t.reference?.vatReference??0n,t.amount].map((value,i)=><td key={i}>{money(value)}</td>)}</tr>;})}</tbody><tfoot><tr><th colSpan={3}>Totals (PHP)</th>{(['base','ot','fuel','toll','parking','food','lodging','others','vat','amount'] as const).map(key=><td key={key}>{money(totals[key])}</td>)}</tr></tfoot></table></div>
 <p className="panel-footnote">VAT reference may already be included in the charge. It is displayed separately for review and is never added twice. Use Print to open a separate demo report. A4 layout follows the supplied sample; physical registered-form alignment still requires calibration.</p>
 {edit&&<form className="invoice-detail-form" onSubmit={async e=>{e.preventDefault();if(await command({type:'UPDATE_INVOICE_DETAILS',invoiceId:invoice.id,expectedVersion:edit.version,receivedDate:edit.date,description:edit.description}))setEdit(null);}}><label>Received date<input aria-label="Edit invoice received date" type="date" min={invoice.invoiceDate} value={edit.date} onChange={e=>setEdit({...edit,date:e.target.value})}/></label><label>Description<textarea aria-label="Invoice description" maxLength={2000} value={edit.description} onChange={e=>setEdit({...edit,description:e.target.value})}/></label><div className="actions"><button className="button" type="button" onClick={()=>setEdit(null)}>Cancel edit</button><button className="button primary" type="submit">Save invoice details</button></div></form>}
 {settling&&active&&can(role,'payment:write')&&<InvoiceSettlement invoice={invoice} state={state} onCommand={onCommand} onClose={()=>setSettling(false)} commandError={commandError}/>}
 {write&&active&&<details className="invoice-controls"><summary>Pre-printed form controls</summary><p>A failed print requires physical inspection. Only a clean, usable form may retain its number for retry or reassignment. Used, spoiled and cancelled numbers cannot be reassigned.</p><label>Reason / inspection evidence<input aria-label="Invoice action reason" value={reason} maxLength={200} onChange={e=>setReason(e.target.value)}/></label><div className="actions">
 {['UNPRINTED','CLEAN_USABLE'].includes(print)&&<><button className="button" disabled={!reason.trim()} onClick={()=>command({type:'INVOICE_PRINT_RESULT',...version,outcome:'FAILED',reason})}>Record failed print</button><button className="button" disabled={!reason.trim()} onClick={()=>command({type:'INVOICE_PRINT_RESULT',...version,outcome:'SUCCESS',reason})}>Record successful print</button></>}
 {print==='INSPECTION_REQUIRED'&&<><button className="button" disabled={!reason.trim()} onClick={()=>command({type:'INSPECT_INVOICE_FORM',...version,usable:true,reason})}>Inspected: clean and usable</button><button className="button danger" disabled={!reason.trim()} onClick={()=>command({type:'INSPECT_INVOICE_FORM',...version,usable:false,reason})}>Inspected: spoiled</button></>}
 <button className="button" disabled={!reason.trim()||Boolean(invoice.receivedDate)||!['UNPRINTED','CLEAN_USABLE'].includes(print)} onClick={()=>command({type:'CLEAR_INVOICE_ASSIGNMENT',...version,reason})}>Clear invoice assignment</button>
 <button className="button danger" disabled={!reason.trim()||!!cancellation} onClick={()=>setCancellation({type:'CANCEL_INVOICE',...version,reason,confirmedInvoiceNumber:invoice.invoiceNumber})}>Cancel invoice</button></div><p className="panel-footnote">Clearing or cancellation is blocked while any payment allocation remains effective. It unlocks the SOA and returns it to Draft. Original receipts and invoice history are retained.</p>
 {cancellation&&<section className="alert" aria-labelledby="confirm-invoice-cancellation">
  <h3 id="confirm-invoice-cancellation">Confirm invoice cancellation</h3>
  <p>{cancellation.confirmedInvoiceNumber} · {customerName(invoice.customerId,state)} · {money(invoice.amountSnapshot)}</p>
  <p>Cancellation is permanent. This invoice number is retired. {invoice.soaId?'The linked SOA returns to Draft. ':''}Receipts and assignment history are preserved.</p>
  <p>Reason: {cancellation.reason}</p>
  <div className="actions"><button className="button" disabled={cancelling} onClick={()=>setCancellation(null)}>Keep invoice</button>
  <button className="button danger" disabled={cancelling||invoice.version!==cancellation.expectedVersion} onClick={async()=>{
   setCancelling(true);
   try{if(await command(cancellation))setCancellation(null);}finally{setCancelling(false);}
  }}>Confirm cancellation</button></div>
 </section>}</details>}
 {!!invoice.assignmentHistory?.length&&<section><h3>Assignment history</h3>{invoice.assignmentHistory.map((h,i)=><p key={i}>{h.soaId??'Direct trip'} · {customerName(h.customerId,state)} · {money(h.amountSnapshot)} · {h.tripIds.length} trips · {h.reason}</p>)}</section>}
</div></dialog>;
}
