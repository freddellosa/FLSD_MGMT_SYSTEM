import type { DemoState } from './store';
export const excludedCompany=(name:string)=>/^(glaxo|tricar|waysmarter)/i.test(name.trim());
/** Read-only dashboard projection. The source ledger and registers are never changed. */
export function filterDashboardCompanies(state:DemoState,include:boolean):DemoState{
 if(include)return state;
 const customerIds=new Set(state.customers.filter(c=>!excludedCompany(c.name)).map(c=>c.id));const trips=state.trips.filter(t=>customerIds.has(t.customerId)),tripIds=new Set(trips.map(t=>t.id));
 const payments=state.payments.filter(p=>customerIds.has(p.customerId)),paymentIds=new Set(payments.map(p=>p.id));
 return {...state,trips,payments,allocations:state.allocations.filter(a=>tripIds.has(a.tripId)&&paymentIds.has(a.paymentId)),refunds:state.refunds.filter(r=>paymentIds.has(r.paymentId)),remittances:state.remittances.filter(r=>paymentIds.has(r.paymentId)),documents:state.documents.filter(d=>customerIds.has(d.customerId))};
}
