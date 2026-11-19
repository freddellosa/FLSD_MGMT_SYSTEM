/** Simulated pre-printed form lifecycle. Customer settlement remains in shared allocations. */
import type { DemoDocument,DemoState } from './store';
import {requireBusinessDate} from '../domain/business-date';
import {customerPaymentTerm} from '../domain/payment-terms';
export type PrintState='UNPRINTED'|'INSPECTION_REQUIRED'|'CLEAN_USABLE'|'USED'|'SPOILED';
export type InvoiceLifecycleAction=
 | {type:'UPDATE_INVOICE_DETAILS';invoiceId:string;expectedVersion:number;receivedDate:string;description:string}
 | {type:'INVOICE_PRINT_RESULT';invoiceId:string;expectedVersion:number;outcome:'SUCCESS'|'FAILED';reason:string}
 | {type:'INSPECT_INVOICE_FORM';invoiceId:string;expectedVersion:number;usable:boolean;reason:string}
 | {type:'CLEAR_INVOICE_ASSIGNMENT';invoiceId:string;expectedVersion:number;reason:string}
 | {type:'CANCEL_INVOICE';invoiceId:string;expectedVersion:number;reason:string;confirmedInvoiceNumber?:string}
 | {type:'REASSIGN_INVOICE';invoiceId:string;expectedVersion:number;soaId:string;expectedSoaVersion:number;invoiceDate:string};
export const invoiceActionTypes=['UPDATE_INVOICE_DETAILS','INVOICE_PRINT_RESULT','INSPECT_INVOICE_FORM','CLEAR_INVOICE_ASSIGNMENT','CANCEL_INVOICE','REASSIGN_INVOICE'];
export const activeInvoice=(d:DemoDocument)=>d.type==='INVOICE'&&(!d.invoiceState||d.invoiceState==='ACTIVE');
export const billingReservation=(d:DemoDocument)=>(d.type==='SOA'&&d.stage!=='VOIDED')||activeInvoice(d);
export function requireInvoiceServiceDate(date:string,trips:readonly {date:string;schedule?:{endDate:string}}[]):void {
 requireBusinessDate(date,'Invoice date');
 for(const trip of trips){
  const lastServiceDate=trip.schedule?.endDate??trip.date;
  requireBusinessDate(lastServiceDate,'Trip service date');
  if(date<lastServiceDate)throw new Error('Invoice date cannot precede the latest trip service date');
 }
}
export function changeInvoice(s:DemoState,a:InvoiceLifecycleAction):string {
 const invoice=s.documents.find(d=>d.id===a.invoiceId&&d.type==='INVOICE');
 if(!invoice)throw new Error('Invoice not found');
 if(invoice.version!==a.expectedVersion)throw new Error('Invoice changed; reload before saving');
 if(a.type!=='REASSIGN_INVOICE'&&!activeInvoice(invoice))throw new Error('Invoice is no longer actively assigned');
 const print=invoice.printState??'UNPRINTED';
 switch(a.type){
  case 'UPDATE_INVOICE_DETAILS':
   if(a.description.length>2000)throw new Error('Description exceeds 2000 characters');
   if(a.receivedDate){requireBusinessDate(a.receivedDate,'Received date');if(a.receivedDate<(invoice.invoiceDate??''))throw new Error('Received date cannot precede invoice date');}
   if(invoice.receivedDate&&!a.receivedDate)throw new Error('Customer receipt cannot be cleared to make a released form reusable');
   invoice.receivedDate=a.receivedDate||undefined;invoice.description=a.description.trim();break;
  case 'INVOICE_PRINT_RESULT':
   if(!['UNPRINTED','CLEAN_USABLE'].includes(print))throw new Error('Inspect a failed form before reuse; used or spoiled forms cannot be printed again');
   if(!['SUCCESS','FAILED'].includes(a.outcome))throw new Error('Invalid print outcome');
   if(!a.reason.trim()||a.reason.length>200)throw new Error('Print outcome evidence required (maximum 200 characters)');
   invoice.printState=a.outcome==='SUCCESS'?'USED':'INSPECTION_REQUIRED';break;
  case 'INSPECT_INVOICE_FORM':
   if(print!=='INSPECTION_REQUIRED')throw new Error('Only a failed print may be inspected');
   if(!a.reason.trim()||a.reason.length>200)throw new Error('Inspection evidence required (maximum 200 characters)');
   invoice.printState=a.usable?'CLEAN_USABLE':'SPOILED';break;
  case 'CLEAR_INVOICE_ASSIGNMENT':case 'CANCEL_INVOICE': {
   if(!a.reason.trim()||a.reason.length>200)throw new Error('Reason required (maximum 200 characters)');
   if(s.allocations.some(x=>invoice.tripIds.includes(x.tripId)&&x.amount>x.reversed))throw new Error('Reverse existing payment allocations before clearing or cancelling; receipts are preserved');
   if(a.type==='CANCEL_INVOICE'&&(!invoice.invoiceNumber||a.confirmedInvoiceNumber!==invoice.invoiceNumber))throw new Error('Confirm the invoice number before cancellation');
   if(a.type==='CLEAR_INVOICE_ASSIGNMENT'&&(invoice.receivedDate||!['UNPRINTED','CLEAN_USABLE'].includes(print)))throw new Error('Only an unreleased, unprinted or inspected clean form can be reassigned');
   invoice.assignmentHistory=[...(invoice.assignmentHistory??[]),{soaId:invoice.soaId,customerId:invoice.customerId,tripIds:[...invoice.tripIds],amountSnapshot:invoice.amountSnapshot,invoiceDate:invoice.invoiceDate,paymentTerm:invoice.paymentTerm,reason:a.reason.trim()}];
   invoice.invoiceState=a.type==='CANCEL_INVOICE'?'CANCELLED':'AVAILABLE';
   if(invoice.soaId){const soa=s.documents.find(d=>d.id===invoice.soaId)!;soa.stage='DRAFT';soa.version++;}
   break;
  }
  case 'REASSIGN_INVOICE': {
   if(invoice.invoiceState!=='AVAILABLE'||invoice.receivedDate||!['UNPRINTED','CLEAN_USABLE'].includes(print))throw new Error('Select an available, usable pre-printed form');
   const soa=s.documents.find(d=>d.id===a.soaId&&d.type==='SOA');
   if(!soa||soa.stage!=='FINAL'||soa.version!==a.expectedSoaVersion)throw new Error('Select a current final SOA');
   if(s.documents.some(d=>activeInvoice(d)&&(d.soaId===soa.id||d.tripIds.some(id=>soa.tripIds.includes(id)))))throw new Error('SOA or trip already invoiced');
   const trips=soa.tripIds.map(id=>s.trips.find(t=>t.id===id));
   if(!trips.length||trips.some(t=>!t))throw new Error('SOA trip not found');
   requireInvoiceServiceDate(a.invoiceDate,trips.map(t=>t!));
   invoice.soaId=soa.id;invoice.soaVersion=soa.version;invoice.tripIds=[...soa.tripIds];invoice.customerId=soa.customerId;invoice.amountSnapshot=soa.amountSnapshot;invoice.invoiceDate=a.invoiceDate;invoice.paymentTerm=customerPaymentTerm(soa.customerId,s.customers.find(c=>c.id===soa.customerId)?.paymentTerm);invoice.description='';invoice.receivedDate=undefined;invoice.receiptReference=undefined;invoice.invoiceState='ACTIVE';break;
  }
 }
 invoice.version++;return invoice.id;
}
