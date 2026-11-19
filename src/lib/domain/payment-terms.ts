import {requireBusinessDate} from './business-date';

export type PaymentTerm={days:number;basis:'INVOICE_DATE'|'RECEIVED_DATE'};

export function validatePaymentTerm(term:PaymentTerm):PaymentTerm {
  if(!term||!Number.isSafeInteger(term.days)||term.days<0||term.days>3650)throw new Error('Payment term must be 0–3650 whole days');
  if(term.basis!=='INVOICE_DATE'&&term.basis!=='RECEIVED_DATE')throw new Error('Invalid payment term basis');
  return {days:term.days,basis:term.basis};
}

export function customerPaymentTerm(customerId:string, configured?:PaymentTerm):PaymentTerm {
  return configured?validatePaymentTerm(configured):{days:customerId==='accenture'?60:30,basis:'INVOICE_DATE'};
}

export function invoiceDueDate(invoice:{invoiceDate?:string;receivedDate?:string},term?:PaymentTerm):string|null {
  if(!term)return null;
  const {days,basis}=validatePaymentTerm(term);
  const base=basis==='INVOICE_DATE'?invoice.invoiceDate:invoice.receivedDate;
  if(!base)return null;
  requireBusinessDate(base,'Invoice date');
  const date=new Date(`${base}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate()+days);
  return date.toISOString().slice(0,10);
}
