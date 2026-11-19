import { customerName } from './billing-register';
import { tripRoute } from './trip-operations';
import { tripBalance,tripStatus,type DemoState } from './store';
function group<T,K>(rows:T[],key:(r:T)=>K){const result=new Map<K,T[]>();for(const row of rows){const id=key(row);const values=result.get(id);if(values)values.push(row);else result.set(id,[row]);}return result;}
/** Group once so each trip projection reads only its own receipts/allocations. */
export function directPaymentRows(state:DemoState){
 const payments=group(state.payments,p=>p.tripId),allocations=group(state.allocations,a=>a.tripId),paymentTrip=new Map(state.payments.map(p=>[p.id,p.tripId]));const refunds=group(state.refunds,r=>paymentTrip.get(r.paymentId)??'');
 return state.trips.filter(t=>t.workflow==='DIRECT').map(t=>{const ps=payments.get(t.id)??[],scoped={...state,trips:[t],payments:ps,allocations:allocations.get(t.id)??[],refunds:refunds.get(t.id)??[]};const balance=tripBalance(scoped,t.id),progress=Number((t.amount-balance)*10000n/t.amount)/100;return {...t,progress,customer:customerName(t.customerId,state),route:tripRoute(t),balance,received:ps.filter(p=>p.state==='RECORDED').reduce((n,p)=>n+p.amount,0n),status:tripStatus(scoped,t)};});
}
