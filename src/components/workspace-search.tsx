'use client';
import { useEffect,useRef,useState } from 'react';
import { Search,X } from 'lucide-react';
import { can,type Role } from '@/lib/security/permissions';
import { tripRoute,type TripFilters } from '@/lib/demo/trip-operations';
import type { DemoState } from '@/lib/demo/store';
export default function WorkspaceSearch({state,role,onTrip,onInvoice,onCustomer,onSearchTrips}:{state:DemoState;role:Role;onTrip:(id:string)=>void;onInvoice:(id:string)=>void;onCustomer:(name:string)=>void;onSearchTrips:(filters:TripFilters)=>void}) {
 const [query,setQuery]=useState(''),[open,setOpen]=useState(false);const input=useRef<HTMLInputElement>(null);
 useEffect(()=>{const handler=(e:KeyboardEvent)=>{if((e.ctrlKey||e.metaKey)&&e.key.toLowerCase()==='k'){e.preventDefault();input.current?.focus();setOpen(true);}};document.addEventListener('keydown',handler);return()=>document.removeEventListener('keydown',handler);},[]);
 const q=query.trim().toLowerCase(),trips=q?state.trips.filter(t=>(t.id+' '+tripRoute(t)+' '+(state.customers.find(c=>c.id===t.customerId)?.name??'')).toLowerCase().includes(q)).slice(0,5):[];
 const customers=q?state.customers.filter(c=>c.name.toLowerCase().includes(q)).slice(0,3):[],invoices=q&&can(role,'invoice:read')?state.documents.filter(d=>d.type==='INVOICE'&&(d.invoiceNumber??'').toLowerCase().includes(q)).slice(0,3):[];
 function close(){setOpen(false);setQuery('');}
 return <div className={'workspace-search '+(open?'search-is-open':'')}><form onSubmit={e=>{e.preventDefault();if(q){onSearchTrips({query});close();}}}><button type="button" className="mobile-search-toggle" aria-label={open?'Close workspace search':'Open workspace search'} onClick={()=>{if(open)setOpen(false);else{setOpen(true);input.current?.focus();}}}><Search size={17}/></button><Search size={16}/><input ref={input} aria-label="Search workspace" placeholder="Search trips, customers, invoices…" value={query} onFocus={()=>setOpen(true)} onKeyDown={e=>{if(e.key==='Escape')close();}} onChange={e=>{setQuery(e.target.value);setOpen(true);}}/>{query?<button type="button" className="icon-button" aria-label="Clear workspace search" onClick={close}><X size={14}/></button>:<kbd>Ctrl K</kbd>}</form>
 {open&&q&&<section className="search-results" aria-label="Workspace search results"><header><b>Search results</b><button className="text-link" onClick={close}>Close search</button></header>{trips.map(t=><button key={t.id} onClick={()=>{close();onTrip(t.id);}}><span className="result-kind">Trip</span><div><b>{t.id}</b><small>{tripRoute(t)}</small></div></button>)}{customers.map(c=><button key={c.id} onClick={()=>{close();onCustomer(c.name);}}><span className="result-kind">Client</span><b>{c.name}</b></button>)}{invoices.map(d=><button key={d.id} onClick={()=>{close();onInvoice(d.id);}}><span className="result-kind">Invoice</span><b>{d.invoiceNumber}</b></button>)}{!trips.length&&!customers.length&&!invoices.length&&<p>No matching records. Press Enter to search the trip register.</p>}</section>}
 </div>;
}
