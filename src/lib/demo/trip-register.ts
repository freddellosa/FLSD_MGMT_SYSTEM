/** Presentation and sorting for the isolated demo trip register. */
import { tripRoute } from './trip-operations';
import { tripStatus, type DemoState } from './store';
export const tripColumns = [
 {key:'id',label:'TripID'}, {key:'date',label:'Date of trip'}, {key:'passenger',label:'Passenger'},
 {key:'itinerary',label:'Itinerary'}, {key:'chargeLocation',label:'Charge location'}, {key:'workflow',label:'Workflow'}, {key:'settlement',label:'Settlement status'}, {key:'amount',label:'Amount'},
] as const;
export type TripColumn = typeof tripColumns[number]['key'];
export type TripRegisterRow = {id:string;date:string;passenger:string;itinerary:string;chargeLocation:string;workflow:string;settlement:string;amount:bigint};
export type TripSort = {key:TripColumn;direction:'asc'|'desc'};
export function tripRegisterRows(state:DemoState,readSettlement:boolean):TripRegisterRow[] {
 return state.trips.map(t=>({id:t.id,date:t.date,passenger:t.reference?.passengers??'',itinerary:tripRoute(t)||t.reference?.destinationDetails||'',chargeLocation:t.reference?.chargeSite??'',workflow:t.workflow==='DIRECT'?'Direct pay':'Corporate',settlement:readSettlement?tripStatus(state,t):'Restricted',amount:t.amount}));
}
const collator=new Intl.Collator('en',{numeric:true,sensitivity:'base'});
export function sortTripRows(rows:readonly TripRegisterRow[],sort:TripSort):TripRegisterRow[] {
 return [...rows].sort((a,b)=>{
  const left=a[sort.key],right=b[sort.key];
  const order=typeof left==='bigint'&&typeof right==='bigint'?(left<right?-1:left>right?1:0):collator.compare(String(left),String(right));
  return order===0?collator.compare(a.id,b.id):sort.direction==='asc'?order:-order;
 });
}

