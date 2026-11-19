import type {WtsPreviewRow,WtsSourceRow} from '../domain/wts-import';
import {tripKilometers,formatKilometers} from '../domain/trip-reference';
import type {NewDemoTrip} from './store';
type Cell=string|number|bigint;
type Column={key:string;label:string;money?:boolean;financial?:boolean;value:(t:NewDemoTrip|undefined,row:WtsPreviewRow,source?:WtsSourceRow)=>Cell};
const text=(s:string|undefined)=>s?.trim()||'Not recorded';
export const wtsPreviewColumns:Column[]=[
 {key:'row',label:'Row',value:(_,r)=>r.row},{key:'tripId',label:'Trip ID',value:()=> 'Assigned on import'},{key:'date',label:'Date',value:t=>text(t?.date)},
 {key:'customer',label:'Customer',value:t=>t?'Accenture Inc.':'Not available'},{key:'passenger',label:'Passenger',value:t=>text(t?.reference?.passengers)},
 {key:'itinerary',label:'Itinerary',value:t=>text(t?.itinerary)},{key:'chargeLocation',label:'Charge location',value:t=>text(t?.reference?.chargeSite)},
 {key:'department',label:'Department',value:t=>text(t?.reference?.department)},{key:'reservedBy',label:'Reserved by',value:t=>text(t?.reference?.reservedBy)},
 {key:'vehicle',label:'Vehicle',value:t=>t?.vehicle||'Unassigned'},{key:'driver',label:'Driver',value:t=>t?.driver||'Unassigned'},
 {key:'amount',label:'Amount',money:true,financial:true,value:t=>t?.amount??'Not available'},
 ...([['base','Base'],['otFee','OT fee'],['fuel','Fuel'],['toll','Toll'],['parking','Parking'],['food','Food'],['lodging','Lodging'],['others','Others']] as const).map(([key,label])=>({key,label,money:true,financial:true,value:(t:NewDemoTrip|undefined)=>t?.charges?.[key]??'Not available'})),
 {key:'vat',label:'VAT',money:true,financial:true,value:t=>t?.reference?.vatReference??'Not available'},
 {key:'withholding',label:'Withholding reference',money:true,financial:true,value:t=>t?.reference?.withholdingReference??'Not available'},
 {key:'vatTreatment',label:'VAT treatment',financial:true,value:t=>t?.reference?.vatTreatment==='UNCONFIRMED'?'Pending accounting review':t?.reference?.vatTreatment==='NONE'?'Not applied':text(t?.reference?.vatTreatment)},
 {key:'workflow',label:'Workflow',value:t=>t?'Corporate':'Not available'},{key:'settlement',label:'Settlement status',value:()=> 'Pending import'},
 {key:'startTime',label:'Start time',value:t=>text(t?.schedule?.startTime)},{key:'endDate',label:'End date',value:t=>text(t?.schedule?.endDate)},{key:'endTime',label:'End time',value:t=>text(t?.schedule?.endTime)},
 {key:'otHours',label:'OT hours',value:t=>text(t?.reference?.otHours)},
 {key:'odoOut',label:'Odometer out',value:t=>text(t?.reference?.odoOut)},{key:'odoIn',label:'Odometer in',value:t=>text(t?.reference?.odoIn)},
 {key:'distance',label:'Distance',value:t=>{if(!t?.reference)return 'Not recorded';const d=tripKilometers(t.reference.odoOut,t.reference.odoIn);return d===null?'Not recorded':formatKilometers(d);}},
 {key:'approvedBy',label:'Customer approval reference',value:t=>text(t?.reference?.customerApprovedBy)},
 {key:'remarks',label:'Remarks',value:t=>text(t?.reference?.remarks)},{key:'otherDescription',label:'Other charge description',value:t=>text(t?.charges?.othersNote)},
 {key:'vehicleClass',label:'Billed vehicle class',value:t=>text(t?.reference?.billedVehicleClass)},
 {key:'soa',label:'External SOA reference',value:t=>text(t?.reference?.externalSoaReference)},
 {key:'sourceTicket',label:'Source trip ticket (not imported)',value:(_,__,source)=>text(source?.cells.F)},
 {key:'night',label:'Night differential (unmapped)',financial:true,value:(_,__,source)=>text(source?.cells.AY)},
 {key:'waiting',label:'Waiting charge (unmapped)',financial:true,value:(_,__,source)=>text(source?.cells.BB)},
];
export function wtsPreviewRows(rows:WtsPreviewRow[],sourceRows:WtsSourceRow[]){const sources=new Map(sourceRows.map(r=>[r.row,r]));return rows.map(r=>({id:'row-'+r.row,row:r,values:Object.fromEntries(wtsPreviewColumns.map(c=>[c.key,c.value(r.trip,r,sources.get(r.row))])) as Record<string,Cell>}));}
