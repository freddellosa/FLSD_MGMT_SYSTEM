'use client';

import {useCallback,useEffect,useRef,useState,type FormEvent} from 'react';
import {fromCentavos,toCentavos} from '@/lib/domain/billing';
import {businessDate} from '@/lib/domain/business-date';
import {canonicalWire,decodeWire,encodeWire} from '@/lib/pilot/wire';

type Invoice={id:string;customerId:string;customerName:string;serialNumber:string|null;outstandingCentavos:bigint};
type Receipt={paymentId:string;allocatedCentavos:bigint;replayed:boolean};
const endpoint='/api/office/batch7-receipts';
const peso=(amount:bigint)=>'₱'+fromCentavos(amount);

export default function OfficeReceiptForm({signInEnabled=false}:{signInEnabled?:boolean}){
  const [invoices,setInvoices]=useState<Invoice[]>([]);
  const [customerId,setCustomerId]=useState('');
  const [splits,setSplits]=useState<Record<string,string>>({});
  const [received,setReceived]=useState('');
  const [date,setDate]=useState(businessDate);
  const [method,setMethod]=useState('BANK_TRANSFER');
  const [reference,setReference]=useState('');
  const [stale,setStale]=useState(false);
  const [busy,setBusy]=useState(true);
  const [error,setError]=useState('');
  const [notice,setNotice]=useState('');
  const [signedOut,setSignedOut]=useState(false);
  const pending=useRef<{fingerprint:string;key:string}|null>(null);
  const requestInFlight=useRef(false);

  const load=useCallback(async(keepDraft=false)=>{
    setBusy(true);
    try{
      const res=await fetch(endpoint,{cache:'no-store'});
      setSignedOut(res.status===401);
      const payload=decodeWire<Invoice[]|{error:string}>(await res.text());
      if(!res.ok||!Array.isArray(payload))throw Error(Array.isArray(payload)?'Unable to load invoices':payload.error);
      const available=new Set(payload.map(row=>row.id));
      setInvoices(previous=>keepDraft
        ?[...payload,...previous.filter(row=>!available.has(row.id)).map(row=>({...row,outstandingCentavos:0n}))]
        :payload);
      setStale(false);
      setError('');
      if(keepDraft)setNotice('Balances refreshed. Review the amounts before submitting.');
    }catch(error){
      setError(error instanceof Error?error.message:'Unable to load invoices');
    }finally{setBusy(false);}
  },[]);
  useEffect(()=>{void load();},[load]);

  async function signIn(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(requestInFlight.current)return;
    requestInFlight.current=true;
    const fields=new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try{
      const res=await fetch(endpoint+'/session',{method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({email:fields.get('email'),password:fields.get('password')})});
      if(!res.ok)throw Error((await res.json()).error);
      await load();
    }catch(error){setError(error instanceof Error?error.message:'Sign-in failed');}
    finally{requestInFlight.current=false;setBusy(false);}
  }

  async function signOut(){
    if(requestInFlight.current)return;
    requestInFlight.current=true;
    setBusy(true);
    try{
      const res=await fetch(endpoint+'/session',{method:'DELETE'});
      if(!res.ok&&res.status!==401)throw Error('Unable to sign out');
      setInvoices([]);setCustomerId('');setSplits({});setReceived('');setReference('');
      setNotice('');setError('');setStale(false);pending.current=null;setSignedOut(true);
    }catch(error){setError(error instanceof Error?error.message:'Unable to sign out');}
    finally{requestInFlight.current=false;setBusy(false);}
  }

  const customers=[...new Map(invoices.map(row=>[row.customerId,row.customerName]))];
  const rows=invoices.filter(row=>row.customerId===customerId);
  async function submit(event:FormEvent<HTMLFormElement>){
    event.preventDefault();
    if(stale||busy||requestInFlight.current)return;
    requestInFlight.current=true;
    setBusy(true);
    setError('');
    setNotice('');
    try{
      const allocations=rows.flatMap(row=>{
        if(!splits[row.id]?.trim())return [];
        const cashCentavos=toCentavos(splits[row.id]);
        if(cashCentavos<=0n||cashCentavos>row.outstandingCentavos)throw Error('Review each allocation against its outstanding balance.');
        return [{invoiceId:row.id,cashCentavos,expectedOutstandingCentavos:row.outstandingCentavos}];
      });
      const receivedCentavos=toCentavos(received);
      if(!allocations.length||allocations.reduce((total,row)=>total+row.cashCentavos,0n)!==receivedCentavos){
        throw Error('Allocate the full payment amount across the selected invoices.');
      }
      const command={customerId,receivedCentavos,receivedDate:date,method,reference:reference.trim(),allocations};
      const fingerprint=canonicalWire(command);
      if(pending.current?.fingerprint!==fingerprint)pending.current={fingerprint,key:crypto.randomUUID()};
      const res=await fetch(endpoint,{method:'POST',headers:{'content-type':'application/json'},
        body:encodeWire({...command,key:pending.current.key})});
      const payload=decodeWire<Receipt|{error:string;code?:string}>(await res.text());
      if('error' in payload){
        if(payload.code==='STALE_BALANCE')setStale(true);
        throw Error(payload.error);
      }
      if(!res.ok)throw Error('Unable to confirm receipt');
      setNotice('Payment recorded. Reference '+command.reference+' · '+peso(payload.allocatedCentavos)+' applied.');
      setSplits({});
      setReceived('');
      setReference('');
      pending.current=null;
      await load();
    }catch(error){
      setError(error instanceof Error?error.message:'Unable to record payment');
    }finally{requestInFlight.current=false;setBusy(false);}
  }
  if(signInEnabled&&signedOut)return <main className="pilot-login"><section className="panel">
    <h1>Office sign in</h1>
    {error&&error!=='Sign in required'&&<p className="alert error" role="alert">{error}</p>}
    <form onSubmit={signIn}>
      <label>Email<input name="email" type="email" autoComplete="username" required/></label>
      <label>Password<input name="password" type="password" autoComplete="current-password" required maxLength={128}/></label>
      <button className="button primary" disabled={busy}>Sign in</button>
    </form>
  </section></main>;
  return <main className="pilot-login"><section className="panel" style={{maxWidth:850,width:'100%'}}>
    <h1>Record customer payment</h1>
    {signInEnabled&&<button type="button" className="button" disabled={busy} onClick={()=>void signOut()}>Sign out</button>}
    {error&&<p role="alert" className="alert error">{error}</p>}
    {notice&&<p role="status">{notice}</p>}
    {stale&&<button type="button" className="button" disabled={busy} onClick={()=>void load(true)}>Refresh invoice balances</button>}
    {!busy&&!invoices.length&&!error&&<p>No invoices with an outstanding balance.</p>}
    {invoices.length>0&&<form onSubmit={submit} onInvalidCapture={()=>setError('')} onChange={()=>setError('')}>
      <fieldset disabled={busy||stale}>
        <label>Customer<select aria-label="Customer" value={customerId} required onChange={e=>{setCustomerId(e.target.value);setSplits({});}}>
          <option value="">Select customer</option>
          {customers.map(([id,name])=><option key={id} value={id}>{name}</option>)}
        </select></label>
        <label>Amount received (PHP)<input value={received} onChange={e=>setReceived(e.target.value)} inputMode="decimal" required/></label>
        <label>Collection date<input type="date" value={date} max={businessDate()} onChange={e=>setDate(e.target.value)} required/></label>
        <label>Payment method<select value={method} onChange={e=>setMethod(e.target.value)}>
          <option value="BANK_TRANSFER">Bank transfer</option><option value="CASH">Cash</option><option value="GCASH">GCash</option>
        </select></label>
        <label>Payment reference<input value={reference} onChange={e=>setReference(e.target.value)} maxLength={200} required/></label>
        {rows.length>0&&<table aria-label="Invoice balances"><thead><tr><th scope="col">Invoice</th><th scope="col">Outstanding</th><th scope="col">Apply (PHP)</th></tr></thead>
          <tbody>{rows.map(row=>{
            const name=row.serialNumber??row.id;
            return <tr key={row.id}><th scope="row">{name}</th><td>{peso(row.outstandingCentavos)}</td><td>
              <input aria-label={'Apply to invoice '+name} inputMode="decimal" value={splits[row.id]??''}
                onChange={e=>setSplits(previous=>({...previous,[row.id]:e.target.value}))}/>
            </td></tr>;
          })}</tbody>
        </table>}
        <button type="submit" className="button primary" disabled={!customerId||busy||stale}>Record payment</button>
      </fieldset>
    </form>}
  </section></main>;
}
