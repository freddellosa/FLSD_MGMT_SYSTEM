'use client';
import { useState,type ReactNode } from 'react';
import { businessDate,customerName } from '@/lib/demo/billing-register';
import { overviewReport,customerPaymentTerm } from '@/lib/demo/overview';
import { tripStatus,type DemoAction,type DemoState } from '@/lib/demo/store';
import { can,type Role } from '@/lib/security/permissions';
import type { WidgetId } from '@/lib/demo/workspace-settings';
import DataTable from './ui/data-table';
import DashboardCanvas from './dashboard-canvas';
import { RevenueBars,RevenuePie,chartMoney as money } from './revenue-charts';
const months=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
export default function OfficeOverview({state,role,onInvoice,onOpenTrip,onCommand,metrics,actions,operations,editLayout}:{state:DemoState;role:Role;onInvoice:(id:string)=>void;onOpenTrip:(id:string)=>void;onCommand:(a:DemoAction)=>Promise<DemoState|null>;metrics:ReactNode[];actions:ReactNode;operations:ReactNode;editLayout:boolean}) {
 const [selected,setSelected]=useState(''),[showTerms,setShowTerms]=useState(false),[showUnbilled,setShowUnbilled]=useState(false),[showOverdue,setShowOverdue]=useState(false),[query,setQuery]=useState('');
 const customers=state.customers,today=businessDate(),r=overviewReport(state,today);
 const title=(id:WidgetId,fallback:string)=>state.dashboard.widgets.find(w=>w.id===id)?.title||fallback;
 const groups=customers.map(c=>({...c,invoices:r.invoices.filter(i=>i.customerId===c.id)})).filter(c=>c.invoices.length);
 const schedule=[...new Set(r.invoices.map(i=>i.dueDate).filter((d):d is string=>Boolean(d)))].sort();
 function close(){setSelected('');setShowTerms(false);setShowUnbilled(false);setShowOverdue(false);}
 function openInvoice(id:string){close();onInvoice(id);}
 const invoiceTable=(rows:typeof r.invoices,name:string)=><DataTable name={name} rows={rows} initialSize={10} columns={[{key:'number',label:'Invoice number',value:i=>i.number,render:i=><button className="text-link" onClick={()=>openInvoice(i.id)}>{i.number}</button>},{key:'date',label:'Invoice date',value:i=>i.date},{key:'customer',label:'Customer',value:i=>customerName(i.customerId,state)},{key:'balance',label:'Amount due',value:i=>i.balance,render:i=><span title={'Invoice total '+money(i.amount)}>{money(i.balance)}</span>},{key:'dueDate',label:'Due date',value:i=>i.dueDate??'Invoice date missing'}]} />;
 const nodes:Partial<Record<WidgetId,ReactNode>>={'office-actions':actions,operations};
 if(can(role,'report:read')){
  (['charges','collections','outstanding','driver-cash'] as const).forEach((id,i)=>nodes[id]=metrics[i]);
  nodes.unbilled=<section className="panel"><h2><button className="text-link" onClick={()=>setShowUnbilled(true)}>{title('unbilled','Unbilled trips')}</button></h2><button className="overview-amount text-link" aria-label="View unbilled trips list" onClick={()=>setShowUnbilled(true)}>{money(r.unbilledAmount)}</button><span className="overview-caption">{r.unbilledCount} trips without an active invoice</span>{r.taxPendingUnbilled>0&&<small>{r.taxPendingUnbilled} tax-review trips excluded from amount</small>}</section>;
  nodes['customer-invoices']=<section className="panel"><h2>{title('customer-invoices','Unsettled invoices per customer')}</h2><div className="table-wrap"><table aria-label="Unsettled invoice customers"><thead><tr><th>Customer</th><th>Invoices</th><th>Outstanding</th></tr></thead><tbody>{groups.map(c=><tr key={c.id}><td><button className="text-link" onClick={()=>setSelected(c.id)}>{c.name}</button></td><td>{c.invoices.length}</td><td>{money(c.invoices.reduce((n,i)=>n+i.balance,0n))}</td></tr>)}</tbody></table>{!groups.length&&<p className="overview-empty">No outstanding invoices.</p>}</div></section>;
  nodes.overdue=<section className={'panel overdue-card '+(r.overdue.length?'has-overdue':'')}><div className="section-head"><h2>{title('overdue','Overdue invoices')}</h2><b>{r.overdue.length}</b></div>{invoiceTable(r.overdue,'Overdue invoices')}<span className="overview-caption">Total {money(r.overdue.reduce((n,i)=>n+i.balance,0n))}</span><button className="text-link" onClick={()=>setShowOverdue(true)}>View overdue details</button></section>;
  nodes.expected=<section className="panel"><h2>{title('expected','Expected collections by date')}</h2><div className="table-wrap"><table aria-label="Expected collections"><thead><tr><th>Due date</th><th>Invoices</th><th>Amount</th></tr></thead><tbody>{schedule.map(date=><tr key={date}><td>{date}</td><td>{r.invoices.filter(i=>i.dueDate===date).length}</td><td>{money(r.invoices.filter(i=>i.dueDate===date).reduce((n,i)=>n+i.balance,0n))}</td></tr>)}</tbody></table></div><button className="text-link" onClick={()=>setShowTerms(true)}>Customer payment terms</button></section>;
 }
 if(role==='OWNER')for(const [index,y] of r.years.entries()){
  const suffix=index===0?'current':'previous';
  const monthly=('monthly-'+suffix) as WidgetId,share=('share-'+suffix) as WidgetId,workflow=('workflow-'+suffix) as WidgetId;
  nodes[monthly]=<RevenueBars title={title(monthly,'Monthly revenue - '+y.year)} rows={y.months.map((value,i)=>({label:months[i],value}))}/>;
  nodes[share]=<RevenuePie title={title(share,'Customer revenue share - '+y.year)} rows={y.customers.map(c=>({label:customerName(c.customerId,state),value:c.amount,colorIndex:Math.max(0,customers.findIndex(customer=>customer.id===c.customerId))}))}/>;
  nodes[workflow]=<RevenueBars title={title(workflow,'Corporate vs direct revenue - '+y.year)} rows={[{label:'Corporate',value:y.corporate},{label:'Direct pay',value:y.direct}]}/>;
 }
 const unbilled=r.unbilledTrips.filter(t=>(t.id+' '+customerName(t.customerId,state)+' '+(t.itinerary||t.origin+' '+t.destination)).toLowerCase().includes(query.toLowerCase()));
 return <>
 <div aria-label={role==='OWNER'?'Owner revenue reports':undefined}><DashboardCanvas config={state.dashboard} role={role} editing={editLayout} onSave={config=>onCommand({type:'SAVE_DASHBOARD',expectedVersion:state.dashboard.version,config})} render={w=>nodes[w.id]}/></div>
 {role==='OWNER'&&<p className="revenue-basis">Revenue = agreed trip charges by service date, including unpaid/future trips; tax-review trips excluded.</p>}
 {can(role,'report:read')&&(selected||showTerms||showUnbilled||showOverdue)&&<dialog className="demo-modal trip-modal" aria-label="Overview details" ref={node=>{if(node&&!node.open)node.showModal();}} onCancel={close}><header><h2>{selected?'Unpaid invoices - '+customerName(selected,state):showUnbilled?'Unbilled trips':showOverdue?'Overdue invoices':'Customer payment terms'}</h2><button className="button" onClick={close}>Close overview details</button></header><div className="modal-content">
 {selected?invoiceTable(r.invoices.filter(i=>i.customerId===selected),'Selected customer unpaid invoices'):showOverdue?<div className="overdue-card has-overdue">{invoiceTable(r.overdue,'Overdue invoice details')}</div>:showUnbilled?<><label>Search unbilled trips<input aria-label="Search unbilled trips" value={query} onChange={e=>setQuery(e.target.value)}/></label><div className="table-wrap"><table aria-label="Unbilled trip preview"><thead><tr><th>TripID</th><th>Date</th><th>Customer</th><th>Itinerary</th><th>Workflow</th><th>Amount</th><th>Status</th></tr></thead><tbody>{unbilled.map(t=><tr key={t.id}><td><button className="text-link" onClick={async()=>{close();onOpenTrip(t.id);}}>{t.id}</button></td><td>{t.date}</td><td>{customerName(t.customerId,state)}</td><td>{t.itinerary||[t.origin,t.destination].join(' - ')}</td><td>{t.workflow}</td><td>{money(t.amount)}</td><td>{tripStatus(state,t)}</td></tr>)}</tbody></table></div><p className="panel-footnote">Includes trips in Draft/Final SOAs without an active invoice. Tax-review trips are shown but excluded from the approved summary amount.</p></>:<><p>Customer billing terms are captured on new invoices.</p><div className="table-wrap"><table aria-label="Customer payment terms"><thead><tr><th>Customer</th><th>Calendar days</th><th>Count from</th></tr></thead><tbody>{customers.map(c=><tr key={c.id}><td>{c.name}</td><td>{customerPaymentTerm(c.id,c.paymentTerm).days}</td><td>{customerPaymentTerm(c.id,c.paymentTerm).basis==='INVOICE_DATE'?'Invoice date':'Customer receipt of invoice'}</td></tr>)}</tbody></table></div></>}
 </div></dialog>}
 </>;
}
