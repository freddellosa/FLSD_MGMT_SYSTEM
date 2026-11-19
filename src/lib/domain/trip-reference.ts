/** Optional operational fields from the legacy trip form. Not approval authority. */
import { readTripCharges, tripChargeTotal, type TripCharges } from './trip-encoding';
import { fromCentavos, toCentavos } from './billing';
import { moneyGuard } from './trip-payments';
export type TripReference = {
 passengers:string;reservedBy:string;department:string;destinationDetails:string;chargeSite:string;remarks:string;customerApprovedBy:string;externalSoaReference:string;
 billedVehicleClass?:''|'VIOS'|'VAN'|'INNOVA';otHours?:string;vatRate?:'12';vatBasis?:'BASE_PLUS_OT';odoOut:string;odoIn:string;vatReference:bigint;withholdingReference:bigint;vatTreatment?:'NONE'|'INCLUDED'|'ADDED'|'UNCONFIRMED';
};
const textKeys=['passengers','reservedBy','department','destinationDetails','chargeSite','remarks','customerApprovedBy','externalSoaReference'] as const;
export function readTripReference(form:FormData):TripReference {
 const value=(key:string)=>String(form.get(key)??'').trim();
 return {passengers:value('passengers'),reservedBy:value('reservedBy'),department:value('department'),destinationDetails:value('destinationDetails'),chargeSite:value('chargeSite'),remarks:value('remarks'),customerApprovedBy:value('customerApprovedBy'),externalSoaReference:'',otHours:normalizeOtHours(value('otHours')),odoOut:value('odoOut'),odoIn:value('odoIn'),vatReference:form.get('vatEnabled')==='on'?tripVat(readTripCharges(form),value('vatTreatment')):0n,vatRate:form.get('vatEnabled')==='on'?'12':undefined,vatBasis:form.get('vatEnabled')==='on'?'BASE_PLUS_OT':undefined,vatTreatment:form.get('vatEnabled')==='on'?(value('vatTreatment')||'UNCONFIRMED') as TripReference['vatTreatment']:'NONE',withholdingReference:toCentavos(value('withholdingReference')||'0')};
}
function odometer(value:string):bigint {
 if(!/^\d{1,9}(?:\.\d{1,2})?$/.test(value)) throw new Error('Odometer must be nonnegative kilometers with up to two decimal places');
 return toCentavos(value);
}
export function tripKilometers(odoOut:string,odoIn:string):bigint|null {
 if(odoOut==='') {if(odoIn!=='')throw new Error('Enter odometer out before odometer in');return null;}
 const start=odometer(odoOut);if(odoIn==='')return null;
 const end=odometer(odoIn);if(end<start)throw new Error('Odometer in cannot be below odometer out');return end-start;
}
export const formatKilometers=(hundredths:bigint)=>`${fromCentavos(hundredths)} km`;
export function validateTripReference(reference:TripReference) {
 for(const key of textKeys) if(typeof reference[key]!=='string'||reference[key].length>(['passengers','destinationDetails','remarks'].includes(key)?2000:200))throw new Error(`${key} exceeds the allowed text length`);
 if(reference.billedVehicleClass!==undefined&&!['','VIOS','VAN','INNOVA'].includes(reference.billedVehicleClass))throw new Error('Invalid billed vehicle class');
 if(reference.vatTreatment!==undefined&&!['NONE','INCLUDED','ADDED','UNCONFIRMED'].includes(reference.vatTreatment))throw new Error('Invalid VAT treatment');
 if(reference.otHours!==undefined)normalizeOtHours(reference.otHours);
 if(reference.vatRate!==undefined&&reference.vatRate!=='12')throw new Error('Unsupported VAT rate');
 if(reference.vatBasis!==undefined&&reference.vatBasis!=='BASE_PLUS_OT')throw new Error('Unsupported VAT basis');
 tripKilometers(reference.odoOut,reference.odoIn);moneyGuard(reference.vatReference);moneyGuard(reference.withholdingReference);
}
export function needsTaxReview(reference?:TripReference) {return Boolean(reference&&(reference.withholdingReference!==0n||(reference.vatReference!==0n&&!['INCLUDED','ADDED'].includes(reference.vatTreatment??''))));}

export function manualTripTotal(charges:TripCharges,reference?:Pick<TripReference,'vatReference'|'vatTreatment'>):bigint {
 const subtotal=tripChargeTotal(charges);if(!reference)return subtotal;
 moneyGuard(reference.vatReference);
 if(reference.vatTreatment==='INCLUDED'&&reference.vatReference>subtotal)throw new Error('Included VAT cannot exceed the charge subtotal');
 return reference.vatTreatment==='ADDED'?moneyGuard(subtotal+reference.vatReference):subtotal;
}

/** Owner-confirmed 12% VAT, on base + OT fee only. Round to nearest centavo, half up. */
export function tripVat(charges:TripCharges,treatment:string):bigint {
 const basis=moneyGuard(moneyGuard(charges.base)+moneyGuard(charges.otFee??0n));
 const denominator=treatment==='INCLUDED'?112n:100n;
 if(!['ADDED','INCLUDED'].includes(treatment))throw new Error('Choose whether VAT is added or included');
 return moneyGuard((basis*12n+denominator/2n)/denominator);
}

export function normalizeOtHours(value:string):string {
 if(value==='')return '';
 if(!/^\d{1,6}(?:\.\d)?$/.test(value))throw new Error('OT hours must be nonnegative with at most one decimal place');
 const [whole,fraction='0']=value.split('.');return `${BigInt(whole)}.${fraction}`;
}
