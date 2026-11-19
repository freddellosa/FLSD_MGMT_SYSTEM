/** Accenture WTS preflight. No database, formulas, invoice assignment or payment creation. */
import type { NewDemoTrip } from '../demo/store';
import { tripChargeTotal } from './trip-encoding';
import { normalizeOtHours, validateTripReference } from './trip-reference';

export type WtsSourceRow = { row:number; cells:Record<string,string> };
export type WtsPreviewRow = { row:number; trip?:NewDemoTrip; errors:string[]; warnings:string[] };
export const wtsHeaders:Record<string,string> = {
 F:'Trip Ticket #',H:'Requester',I:'Approver',J:'Date of Service',K:'Origin',M:'Destination/s',V:'Workforce',X:'WBS',Y:"Passenger's Name",
 AG:'Odometer Start Reading',AH:'Odometer End Reading',AO:'Total No. of OT',AV:'Rental Fee',AW:'Fuel Charge',AX:'Total OT Charge',AY:'Night Differential',
 AZ:'Meal Allowance',BA:'Lodging Charge',BB:'Waiting Time Charge',BC:'Total Toll Fee',BD:'Total Parking Fee',BE:'Total Other Fees',BG:'VAT Amount',BI:'Total Charge',BL:'Billing Remarks',
};
export const normalizedHeader=(v:string)=>v.toLowerCase().replace(/[^a-z0-9]/g,'');
/** Exact rational conversion; tolerate only Excel binary artifacts, never meaningful sub-cent charges. */
export function wtsMoney(value:string):bigint {
 const match=/^(\d{1,15})(?:\.(\d{1,20}))?$/.exec(value.trim()||'0');
 if(!match)throw new Error('Invalid monetary value');
 const fraction=match[2]??'',denominator=10n**BigInt(fraction.length);
 const numerator=(BigInt(match[1])*denominator+BigInt(fraction||'0'))*100n;
 const cents=(numerator+denominator/2n)/denominator;
 const error=numerator-cents*denominator;
 if((error<0n?-error:error)*1000000n>denominator)throw new Error('Amount has meaningful precision below one centavo');
 if(cents>99999999999999n)throw new Error('Amount exceeds import limit');
 return cents;
}
function serviceDate(value:string):string {
 let date=value.trim();
 if(/^\d{5}$/.test(date))date=new Date(Date.UTC(1899,11,30)+Number(date)*86400000).toISOString().slice(0,10);
 if(!/^\d{4}-\d{2}-\d{2}$/.test(date)||!Number.isFinite(Date.parse(date))||new Date(date).toISOString().slice(0,10)!==date)throw new Error('Invalid service date');
 return date;
}
export function mapWtsRows(rows:WtsSourceRow[]):WtsPreviewRow[] {
 if(!rows.length||rows.length>1000)throw new Error('Import must contain between 1 and 1,000 trips');
 return rows.map(({row,cells:c})=>{
  const result:WtsPreviewRow={row,errors:[],warnings:[]};
  try {
   const amount=(key:string)=>wtsMoney(c[key]??'0');
   if(amount('AY')||amount('BB'))throw new Error('Night differential / waiting charges have no matching trip field; review source before import');
   const charges={base:amount('AV'),fuel:amount('AW'),otFee:amount('AX'),food:amount('AZ'),lodging:amount('BA'),toll:amount('BC'),parking:amount('BD'),others:amount('BE'),othersNote:''};
   const total=amount('BI'),vat=amount('BG');
   if(total<=0n)throw new Error('Total charge must be positive');
   if(tripChargeTotal(charges)+vat!==total)throw new Error('Charge breakdown plus VAT does not match total charge');
   // Imported VAT is evidence only until treatment is confirmed; never infer added/included policy.
   const itinerary=[c.K,c.M].filter(v=>v?.trim()).join(' → ').trim();
   if(!itinerary||itinerary.length>2000)throw new Error('Trip itinerary is missing or too long');
   const reference={passengers:c.Y??'',reservedBy:c.H??'',department:c.V??'',destinationDetails:itinerary,chargeSite:c.X??'',remarks:c.BL??'',customerApprovedBy:c.I??'',externalSoaReference:'',
    odoOut:c.AG??'',odoIn:c.AH??'',otHours:normalizeOtHours(c.AO??''),vatReference:vat,withholdingReference:0n,vatTreatment:vat?'UNCONFIRMED' as const:'NONE' as const};
   validateTripReference(reference);
   if(vat)result.warnings.push('Imported VAT requires accounting review before billing or collection');
   result.warnings.push('Vehicle, driver and full start/end schedule are unassigned; no master records or overnight dates were invented');
   result.trip={customerId:'accenture',date:serviceDate(c.J??''),itinerary,vehicle:'',driver:'',amount:total,workflow:'CORPORATE',charges,reference};
  }catch(error){result.errors.push(error instanceof Error?error.message:'Invalid WTS row');}
  return result;
 });
}
