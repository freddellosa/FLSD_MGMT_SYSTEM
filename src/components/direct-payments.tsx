'use client';
import { useMemo,useState } from 'react';
import { can,type Role } from '@/lib/security/permissions';
import { needsTaxReview } from '@/lib/domain/trip-reference';
import { formatPeso } from '@/lib/demo/display';
import { type DemoState } from '@/lib/demo/store';
import { directPaymentRows } from '@/lib/demo/payment-register';
import DataTable,{type DataColumn} from './ui/data-table';
import { StatusBadge } from './ui/workspace-ui';
export default function DirectPayments({state,role,onPayment,onDetail}:{state:DemoState;role:Role;onPayment:(id:string)=>void;onDetail:(id:string)=>void}){
 const [query,setQuery]=useState(''),[status,setStatus]=useState('ALL');
 const projected=useMemo(()=>directPaymentRows(state),[state]);const rows=projected.filter(t=>(t.id+' '+t.route+' '+t.customer).toLowerCase().includes(query.toLowerCase())&&(status==='ALL'||(status==='OPEN'?t.balance>0n:t.balance===0n)));
 type Row=typeof rows[number];
 const columns:DataColumn<Row>[]=[{key:'id',label:'TripID',value:r=>r.id,render:r=><button className="text-link" onClick={()=>onDetail(r.id)}>{r.id}</button>},{key:'date',label:'Trip date',value:r=>r.date},{key:'customer',label:'Customer',value:r=>r.customer},{key:'route',label:'Itinerary',value:r=>r.route},{key:'amount',label:'Agreed amount',value:r=>r.amount,render:r=>formatPeso(r.amount)},{key:'received',label:'Received',value:r=>r.received,render:r=>formatPeso(r.received)},{key:'balance',label:'Remaining',value:r=>r.balance,render:r=>formatPeso(r.balance)},{key:'status',label:'Settlement',value:r=>r.status,render:r=><StatusBadge tone={r.balance===0n?'success':'info'}>{r.status}</StatusBadge>},{key:'progress',label:'Progress',value:r=>r.progress,render:r=><meter aria-label="Settlement progress" min={0} max={100} value={r.progress}/>},{key:'actions',label:'Actions',value:()=>'',sortable:false,render:r=><div className="actions"><button className="button small" onClick={()=>onDetail(r.id)}>Payment history</button>{can(role,'payment:write')&&!needsTaxReview(r.reference)&&<button className="button primary small" onClick={()=>onPayment(r.id)}>Record payment</button>}</div>}];
 return <section className="panel direct-payments-register"><div className="section-head"><h2>Direct payment register</h2><StatusBadge tone="info">Demonstration</StatusBadge></div><div className="filter-bar"><label>Search<input aria-label="Search direct payments" value={query} placeholder="Trip, itinerary or customer" onChange={e=>setQuery(e.target.value)}/></label><label>Settlement<select aria-label="Direct payment filter" value={status} onChange={e=>setStatus(e.target.value)}><option value="ALL">All direct trips</option><option value="OPEN">Outstanding balance</option><option value="SETTLED">Settled</option></select></label></div><DataTable name="Direct payments" rows={rows} columns={columns}/><p className="panel-footnote">Received includes unapplied advances and refund-only excess. Remaining is based on effective allocations. No real funds move.</p></section>;
}
