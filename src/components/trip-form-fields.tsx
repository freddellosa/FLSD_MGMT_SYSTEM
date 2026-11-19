'use client';
import {useState,type ReactNode} from 'react';
import type {DemoTrip} from '@/lib/demo/store';
import type {CustomerVatStatus} from '@/lib/demo/workspace-settings';
import {businessDate} from '@/lib/demo/billing-register';
import {formatPeso as peso} from '@/lib/demo/display';
import {toCentavos,fromCentavos} from '@/lib/domain/billing';
import {formatTripDuration,tripDurationMinutes} from '@/lib/domain/trip-encoding';
import {formatKilometers,manualTripTotal,normalizeOtHours,tripKilometers,tripVat} from '@/lib/domain/trip-reference';
function Field({label,children,wide=false}:{label:string;children:ReactNode;wide?:boolean}){return <label className={wide?'field wide':'field'}><span>{label}</span>{children}</label>;}
export function TripEncodingFields({trip,locked=false,scheduleLocked=false,customerVatStatus}:{trip?:DemoTrip;locked?:boolean;scheduleLocked?:boolean;customerVatStatus?:CustomerVatStatus}={}) {
 const [draft,setDraft]=useState({date:trip?.date??businessDate(),startTime:trip?.schedule?.startTime??'08:00',endDate:trip?.schedule?.endDate??trip?.date??businessDate(),endTime:trip?.schedule?.endTime??'17:00',baseAmount:trip?fromCentavos(trip.charges?.base??trip.amount):'',otFee:trip?fromCentavos(trip.charges?.otFee??0n):'',fuel:trip?fromCentavos(trip.charges?.fuel??0n):'',toll:trip?fromCentavos(trip.charges?.toll??0n):'',parking:trip?fromCentavos(trip.charges?.parking??0n):'',food:trip?fromCentavos(trip.charges?.food??0n):'',lodging:trip?fromCentavos(trip.charges?.lodging??0n):'',others:trip?fromCentavos(trip.charges?.others??0n):'',withholdingReference:trip?fromCentavos(trip.reference?.withholdingReference??0n):'',vatTreatment:(trip?trip.reference?.vatTreatment??'NONE':'ADDED') as string});
 const [manualVatEnabled,setVatEnabled]=useState(!!trip?.reference?.vatReference);
 const vatEnabled=locked?manualVatEnabled:customerVatStatus==='VAT'?true:customerVatStatus==='NON_VAT'?false:manualVatEnabled;
 // New entries regain the exclusive-amount default when a VAT customer enables tax.
 // Existing trips retain recorded treatment, including unresolved historical values.
 const selectedTreatment=['ADDED','INCLUDED','UNCONFIRMED'].includes(draft.vatTreatment)?draft.vatTreatment:!trip&&vatEnabled?'ADDED':'';
 const update=(key:keyof typeof draft,value:string)=>setDraft(previous=>({...previous,[key]:value}));
 let duration='Enter valid start and end dates/times';let total:bigint|null=null;let chargeError='';let vat=0n;
 try {duration=formatTripDuration(tripDurationMinutes({startDate:draft.date,startTime:draft.startTime,endDate:draft.endDate,endTime:draft.endTime}));}catch(error){duration=error instanceof Error?error.message:duration;}
 try {
  const charges={base:toCentavos(draft.baseAmount||'0'),otFee:toCentavos(draft.otFee||'0'),fuel:toCentavos(draft.fuel||'0'),toll:toCentavos(draft.toll||'0'),parking:toCentavos(draft.parking||'0'),food:toCentavos(draft.food||'0'),lodging:toCentavos(draft.lodging||'0'),others:toCentavos(draft.others||'0'),othersNote:''};
  if(vatEnabled&&['INCLUDED','ADDED'].includes(selectedTreatment))vat=tripVat(charges,selectedTreatment);else if(vatEnabled&&trip)vat=trip.reference?.vatReference??0n;
  total=manualTripTotal(charges,{vatReference:vat,vatTreatment:vatEnabled?selectedTreatment as 'INCLUDED'|'ADDED':'NONE'});
 }catch(error){chargeError=error instanceof Error?error.message:'Enter valid charges';}
 if(locked&&trip){total=trip.amount;vat=trip.reference?.vatReference??0n;}
 let taxPending=vatEnabled&&!['INCLUDED','ADDED'].includes(selectedTreatment);try{taxPending=taxPending||toCentavos(draft.withholdingReference||'0')!==0n;}catch{taxPending=true;}
 const chargeField=(key:'baseAmount'|'otFee'|'fuel'|'toll'|'parking'|'food'|'lodging'|'others'|'withholdingReference',label:string)=><Field label={label}><input name={key} disabled={locked} type="text" inputMode="decimal" maxLength={21} pattern="[0-9]+([.][0-9]{1,2})?" placeholder="0.00" value={draft[key]} onChange={e=>update(key,e.target.value)} required={key==='baseAmount'}/></Field>;
 return <>
  <div className="wide charge-heading"><h3>Schedule & charges</h3></div>
  <Field label="Trip date (start)"><input name="date" disabled={scheduleLocked} type="date" value={draft.date} onChange={e=>update('date',e.target.value)} required/></Field>
  <Field label="Trip start time"><input name="startTime" disabled={scheduleLocked} type="time" value={draft.startTime} onChange={e=>update('startTime',e.target.value)} required/></Field>
  <Field label="Trip end date"><input name="endDate" disabled={scheduleLocked} type="date" value={draft.endDate} onChange={e=>update('endDate',e.target.value)} required/></Field>
  <Field label="Trip end time"><input name="endTime" disabled={scheduleLocked} type="time" value={draft.endTime} onChange={e=>update('endTime',e.target.value)} required/></Field>
  <div className="compact-summary trip-hours"><span>Total trip hours</span><output aria-label="Total trip hours" aria-live="polite">{duration}</output></div><Field label="Total OT hours"><input name="otHours" defaultValue={trip?.reference?.otHours} type="text" inputMode="decimal" maxLength={8} pattern="[0-9]{1,6}([.][0-9])?" placeholder="0.0" onBlur={e=>{try{e.currentTarget.value=normalizeOtHours(e.currentTarget.value);}catch{/* Retain invalid input for correction; form validation prevents save. */}}}/><small className="compact-hint">Saved only · no fee calculation</small></Field>
  <div className="wide charge-heading"><h3>Trip amount breakdown</h3></div>
  <div className="base-ot-fields">{chargeField('baseAmount','Base amount (PHP)')}{chargeField('otFee','OT fee (PHP)')}</div>
  
  {chargeField('fuel','Fuel (PHP)')}{chargeField('parking','Parking (PHP)')}{chargeField('toll','Toll fees (PHP)')}{chargeField('food','Food (PHP)')}{chargeField('lodging','Lodging (PHP)')}{chargeField('others','Others (PHP)')}
  <Field label="Other charge description"><input name="othersNote" disabled={locked} defaultValue={trip?.charges?.othersNote} maxLength={2000}/></Field>
  <label className="vat-toggle wide"><input type="checkbox" disabled={locked||customerVatStatus==='VAT'||customerVatStatus==='NON_VAT'} aria-label="Enter VAT for this trip" name="vatEnabled" checked={vatEnabled} onChange={e=>{setVatEnabled(e.target.checked);setDraft(previous=>({...previous,vatTreatment:e.target.checked?'ADDED':'NONE'}));}}/>Enter VAT for this trip <small>12% · base + OT fee only{customerVatStatus==='VAT'?' · VAT customer':customerVatStatus==='NON_VAT'?' · Non-VAT customer':''}</small></label>
  {vatEnabled&&!locked&&customerVatStatus==='VAT'&&<input type="hidden" name="vatEnabled" value="on"/>}
  {vatEnabled&&<><Field label="VAT amount (PHP)"><input name="vatReference" value={fromCentavos(vat)} readOnly aria-readonly="true"/></Field><Field label="VAT treatment"><select aria-label="VAT treatment" disabled={locked} name="vatTreatment" value={selectedTreatment} onChange={e=>update('vatTreatment',e.target.value)} required><option value="" disabled>Select VAT treatment</option><option value="UNCONFIRMED" disabled>Pending VAT review</option><option value="INCLUDED">Already included</option><option value="ADDED">Add VAT</option></select></Field></>}
  {chargeField('withholdingReference','Less withholding tax reference (PHP)')}
  <div className="encoding-summary wide total"><span>{taxPending?'Amount · tax review pending':'Total trip amount'}</span><output aria-label="Total trip amount" aria-live="polite">{total===null?chargeError:peso(total)}</output><small>VAT excludes fuel, toll, parking, food, lodging and others.</small></div>
 </>;
}
export function TripOdometerFields({trip}:{trip?:DemoTrip}={}) {
 const [odoOut,setOdoOut]=useState(trip?.reference?.odoOut??'');const [odoIn,setOdoIn]=useState(trip?.reference?.odoIn??'');
 let distance='Not recorded';try{const value=tripKilometers(odoOut,odoIn);distance=value===null?(odoOut?'Awaiting return':'Not recorded'):formatKilometers(value);}catch(error){distance=error instanceof Error?error.message:'Invalid readings';}
 return <div className="odometer-fields wide">
 <Field label="Odometer out (km)"><input name="odoOut" value={odoOut} onChange={e=>setOdoOut(e.target.value)} inputMode="decimal" maxLength={12} placeholder="0.00"/></Field>
 <Field label="Odometer in (km)"><input name="odoIn" value={odoIn} onChange={e=>setOdoIn(e.target.value)} inputMode="decimal" maxLength={12} placeholder="0.00"/></Field>
 <div className="distance-field"><span>Distance traveled</span><output aria-label="Distance traveled" aria-live="polite">{distance}</output></div>
 </div>;
}
export function TripReferenceFields({trip}:{trip?:DemoTrip}={}) {
 return <>
 <div className="wide charge-heading"><h3>Passenger & booking details</h3></div>
 <Field label="Passenger(s)" wide><textarea name="passengers" defaultValue={trip?.reference?.passengers} rows={2} maxLength={2000} placeholder="Passenger names or group details"/></Field>
 <Field label="Reserved by"><input name="reservedBy" defaultValue={trip?.reference?.reservedBy} maxLength={200}/></Field><Field label="Department"><input name="department" defaultValue={trip?.reference?.department} maxLength={200}/></Field>
 <Field label="Destination details / stops" wide><textarea name="itinerary" aria-label={trip?"Edit destination":undefined} defaultValue={trip?.itinerary||trip?.destination} rows={4} maxLength={2000} placeholder="Record the complete trip itinerary, including pickup, destinations, stops and return details" required/></Field>
 <Field label="Charge location / site"><input name="chargeSite" defaultValue={trip?.reference?.chargeSite} maxLength={200}/></Field><Field label="Approved by (customer / reference)"><input name="customerApprovedBy" defaultValue={trip?.reference?.customerApprovedBy} maxLength={200} placeholder="Customer reference only"/></Field>
 <Field label="Remarks" wide><textarea name="remarks" defaultValue={trip?.reference?.remarks} rows={2} maxLength={2000}/></Field>
 </>;
}
