'use client';
import { useRef } from 'react';
import { assignedInvoiceFormat,renderInvoiceHtml } from '@/lib/demo/invoice-renderer';
import type { DemoDocument,DemoState } from '@/lib/demo/store';
export default function InvoicePrintReport({invoice,state,onClose}:{invoice:DemoDocument;state:DemoState;onClose:()=>void}){
 const frame=useRef<HTMLIFrameElement>(null),format=assignedInvoiceFormat(state,invoice.customerId),html=renderInvoiceHtml(invoice,state,format);
 return <dialog className="demo-modal trip-modal print-report-modal" aria-label="Printable invoice report" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={onClose}><header><h2>Printable invoice report</h2><button className="button" onClick={onClose}>Close print report</button></header><div className="modal-content"><p className="note">A4 portrait - {format.name}. Plain-paper demo; For the Access overlay use A4, Actual size / 100%, no browser headers or footers. Physical alignment and statutory readiness require review. Record print outcomes separately.</p><iframe title="Invoice print document" ref={frame} srcDoc={html} sandbox="allow-same-origin allow-modals"/><div className="billing-form-actions"><button className="button primary" onClick={()=>{frame.current?.contentWindow?.focus();frame.current?.contentWindow?.print();}}>Print demo report</button></div></div></dialog>;
}
