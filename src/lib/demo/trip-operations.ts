/** Operational labels and edits never change customer debt or collection history. */
import type { DemoState,DemoTrip } from './store';
import { tripDurationMinutes,type TripSchedule } from '../domain/trip-encoding';
import { needsTaxReview } from '../domain/trip-reference';
export const operationalStatuses=['SCHEDULED','COMPLETED','CANCELLED'] as const;
export type OperationalStatus=typeof operationalStatuses[number];
export const operationLabel=(trip:DemoTrip)=>trip.operationalStatus?trip.operationalStatus[0]+trip.operationalStatus.slice(1).toLowerCase():'Not set';
export const tripRoute=(trip:Pick<DemoTrip,'origin'|'destination'|'itinerary'>)=>trip.itinerary||[trip.origin,trip.destination].filter(Boolean).join(' → ');
export type TripOperationalEdit={itinerary:string;origin:string;vehicle:string;driver:string;schedule?:TripSchedule;operationalStatus:OperationalStatus;passengers:string;remarks:string;reason:string};
export function validateOperationalEdit(input:TripOperationalEdit){
 if(typeof input.itinerary!=='string'||!input.itinerary.trim()||input.itinerary.length>2000)throw new Error('Destination / itinerary is required (maximum 2000 characters)');
 for(const [value,label,max] of [[input.origin,'Pickup location',2000],[input.passengers,'Passengers',2000],[input.remarks,'Remarks',2000],[input.reason,'Change reason',200]] as const)if(typeof value!=='string'||value.length>max)throw new Error(`${label} exceeds allowed length`);
 if(!input.reason.trim())throw new Error('Change reason required');
 if(!operationalStatuses.includes(input.operationalStatus))throw new Error('Invalid operational status');
 if(input.schedule)tripDurationMinutes(input.schedule);
}
export function billingLabel(state:DemoState,tripId:string){
 const invoice=state.documents.find(d=>d.type==='INVOICE'&&(!d.invoiceState||d.invoiceState==='ACTIVE')&&d.tripIds.includes(tripId));if(invoice)return 'Invoice issued';
 const soa=state.documents.find(d=>d.type==='SOA'&&d.stage!=='VOIDED'&&d.tripIds.includes(tripId));return soa?`${soa.stage==='FINAL'?'Final':'Draft'} SOA`:'Unbilled';
}
export type TripFilters={query?:string;status?:string;customerId?:string;from?:string;to?:string;workflow?:string};
export function tripOperationsSummary(state:DemoState){return {total:state.trips.length,scheduled:state.trips.filter(t=>t.operationalStatus==='SCHEDULED').length,completed:state.trips.filter(t=>t.operationalStatus==='COMPLETED').length,cancelled:state.trips.filter(t=>t.operationalStatus==='CANCELLED').length,unclassified:state.trips.filter(t=>!t.operationalStatus).length,completedRevenue:state.trips.filter(t=>t.operationalStatus==='COMPLETED'&&!needsTaxReview(t.reference)).reduce((n,t)=>n+t.amount,0n)};}
