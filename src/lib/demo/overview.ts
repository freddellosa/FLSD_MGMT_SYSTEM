/** Demo revenue basis: agreed trip charges. Customer terms confirmed by the user. */
import { needsTaxReview } from '../domain/trip-reference';
import { activeInvoice } from './invoice-lifecycle';
import { tripBalance, type DemoState } from './store';
import {customerPaymentTerm,invoiceDueDate,type PaymentTerm} from '../domain/payment-terms';
export {customerPaymentTerm,invoiceDueDate,type PaymentTerm} from '../domain/payment-terms';
export function overviewReport(state:DemoState,today:string,terms?:Record<string,PaymentTerm>) {
 const invoices=state.documents.filter(activeInvoice).map(d=>({id:d.id,number:d.invoiceNumber!,customerId:d.customerId,date:d.invoiceDate!,amount:d.amountSnapshot,balance:d.tripIds.reduce((n,id)=>n+tripBalance(state,id),0n),dueDate:invoiceDueDate(d,terms===undefined?customerPaymentTerm(d.customerId,d.paymentTerm):terms[d.customerId])})).filter(d=>d.balance>0n);
 const unbilled=state.trips.filter(t=>!state.documents.some(d=>activeInvoice(d)&&d.tripIds.includes(t.id)));
 const approvedUnbilled=unbilled.filter(t=>!needsTaxReview(t.reference));
 const year=Number(today.slice(0,4));
 const years=[year,year-1].map(year=>{
  const trips=state.trips.filter(t=>t.date.startsWith(`${year}-`)&&!needsTaxReview(t.reference));
  return {year,months:Array.from({length:12},(_,i)=>trips.filter(t=>Number(t.date.slice(5,7))===i+1).reduce((n,t)=>n+t.amount,0n)),customers:[...new Set(trips.map(t=>t.customerId))].map(customerId=>({customerId,amount:trips.filter(t=>t.customerId===customerId).reduce((n,t)=>n+t.amount,0n)})),corporate:trips.filter(t=>t.workflow==='CORPORATE').reduce((n,t)=>n+t.amount,0n),direct:trips.filter(t=>t.workflow==='DIRECT').reduce((n,t)=>n+t.amount,0n)};
 });
 return {unbilledTrips:unbilled,invoices,overdue:invoices.filter(i=>i.dueDate&&i.dueDate<today),unbilledCount:unbilled.length,unbilledAmount:approvedUnbilled.reduce((n,t)=>n+t.amount,0n),taxPendingUnbilled:unbilled.length-approvedUnbilled.length,years};
}

export function dashboardPercentages(state:DemoState,today:string){const report=overviewReport(state,today),current=report.years[0],previous=report.years[1],total=current.corporate+current.direct,prior=previous.corporate+previous.direct;const percentage=(a:bigint,b:bigint)=>b===0n?null:Number(a*10000n/b)/100;return {settled:percentage(BigInt(state.trips.filter(t=>t.amount>0n&&!needsTaxReview(t.reference)&&tripBalance(state,t.id)===0n).length),BigInt(state.trips.length)),unbilled:percentage(BigInt(report.unbilledCount),BigInt(state.trips.length)),corporate:percentage(current.corporate,total),direct:percentage(current.direct,total),growth:percentage(total-prior,prior),year:current.year};}
