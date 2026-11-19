import { describe, expect, it } from 'vitest';
import { formatKilometers, manualTripTotal, needsTaxReview, readTripReference, tripKilometers, tripVat, normalizeOtHours, validateTripReference, type TripReference } from './trip-reference';
const reference:TripReference={passengers:'Demo group',reservedBy:'Demo reserver',department:'Operations',destinationDetails:'Stop 1\nStop 2',chargeSite:'SITE-A',remarks:'Fictional reference',customerApprovedBy:'Demo customer representative',externalSoaReference:'LEGACY-001',billedVehicleClass:'VAN',odoOut:'10000.25',odoIn:'10125.75',vatReference:0n,withholdingReference:0n,vatTreatment:'NONE'};
const charges={base:1000000n,fuel:10000n,toll:0n,parking:0n,others:0n,othersNote:'',food:20000n,lodging:30000n};
describe('Legacy-form references and manual VAT',()=>{
 it('computes distance exactly including decimal readings',()=>expect(formatKilometers(tripKilometers(reference.odoOut,reference.odoIn)!)).toBe('125.50 km'));
 it('does not fabricate distance for unknown readings',()=>{expect(tripKilometers('','')).toBeNull();expect(tripKilometers('100','')).toBeNull();});
 it('accepts a zero distance',()=>expect(tripKilometers('100','100')).toBe(0n));
 it.each([['','100'],['100','99'],['-1','100'],['1.001','2'],['abc','100']])('rejects invalid odometer pair %s / %s',(out,inside)=>expect(()=>tripKilometers(out,inside)).toThrow());
 it('preserves booking references without treating them as authorization',()=>expect(()=>validateTripReference(reference)).not.toThrow());
 it('limits text and rejects unsupported billing classes',()=>{expect(()=>validateTripReference({...reference,remarks:'x'.repeat(2001)})).toThrow();expect(()=>validateTripReference({...reference,billedVehicleClass:'BUS' as TripReference['billedVehicleClass']})).toThrow();});
 it('leaves VAT off unless explicitly entered',()=>{const form=new FormData();form.set('vatReference','1200');expect(readTripReference(form).vatReference).toBe(0n);expect(manualTripTotal(charges,reference)).toBe(1060000n);});
 it('computes VAT from entered base and explicit treatment, ignoring a supplied tax value',()=>{const form=new FormData();form.set('vatEnabled','on');form.set('baseAmount','10000');form.set('vatReference','9999');form.set('vatTreatment','ADDED');expect(readTripReference(form).vatReference).toBe(120000n);expect(readTripReference(form).vatTreatment).toBe('ADDED');});
 it('adds entered VAT once when explicitly selected',()=>expect(manualTripTotal(charges,{vatReference:120000n,vatTreatment:'ADDED'})).toBe(1180000n));
 it('does not add already-included VAT again',()=>expect(manualTripTotal(charges,{vatReference:120000n,vatTreatment:'INCLUDED'})).toBe(1060000n));
 it('rejects included VAT greater than the total and negative tax',()=>{expect(()=>manualTripTotal(charges,{vatReference:2000000n,vatTreatment:'INCLUDED'})).toThrow();expect(()=>manualTripTotal(charges,{vatReference:-1n,vatTreatment:'ADDED'})).toThrow();});
 it('requires review for unknown VAT basis or withholding but not explicit manual VAT',()=>{expect(needsTaxReview({...reference,vatReference:120000n,vatTreatment:'ADDED'})).toBe(false);expect(needsTaxReview({...reference,vatReference:120000n,vatTreatment:'UNCONFIRMED'})).toBe(true);expect(needsTaxReview({...reference,withholdingReference:10000n})).toBe(true);});
});


describe('Owner-approved base + OT VAT calculation',()=>{
 it('extracts VAT from a rounded quote and preserves gross including untaxed expenses',()=>{
  const c={base:900000n,otFee:100000n,fuel:50000n,toll:10000n,parking:0n,food:0n,lodging:0n,others:0n,othersNote:''};
  const vat=tripVat(c,'INCLUDED');
  expect(vat).toBe(107143n);
  expect(c.base+c.otFee-vat).toBe(892857n);
  expect(manualTripTotal(c,{vatReference:vat,vatTreatment:'INCLUDED'})).toBe(1060000n);
 });
 it('adds VAT to a new exclusive base and OT amount without taxing expenses',()=>{
  const c={base:900000n,otFee:100000n,fuel:50000n,toll:10000n,parking:0n,others:0n,othersNote:''};
  const vat=tripVat(c,'ADDED');
  expect(vat).toBe(120000n);
  expect(manualTripTotal(c,{vatReference:vat,vatTreatment:'ADDED'})).toBe(1180000n);
 });
 const withOt={...charges,base:1000000n,otFee:100000n,fuel:500000n};
 it('computes 12% of base plus OT only',()=>expect(tripVat(withOt,'ADDED')).toBe(132000n));
 it('does not tax fuel, toll, parking, food, lodging or others',()=>expect(tripVat({...withOt,fuel:999999n,toll:12345n,parking:8888n,food:5000n,lodging:7000n,others:5555n},'ADDED')).toBe(132000n));
 it('extracts already-included VAT from base plus OT without a second addition',()=>{const c={...charges,base:1000000n,otFee:120000n};expect(tripVat(c,'INCLUDED')).toBe(120000n);expect(manualTripTotal(c,{vatReference:tripVat(c,'INCLUDED'),vatTreatment:'INCLUDED'})).toBe(1180000n);});
 it('rounds centavos consistently, half up',()=>{expect(tripVat({...charges,base:5n,otFee:0n},'ADDED')).toBe(1n);expect(tripVat({...charges,base:4n,otFee:0n},'ADDED')).toBe(0n);expect(tripVat({...charges,base:14n,otFee:0n},'INCLUDED')).toBe(2n);});
 it('requires explicit VAT treatment',()=>expect(()=>tripVat(withOt,'')).toThrow());
 it('stores OT hours without changing the fee or VAT',()=>{const f=new FormData();f.set('otHours','9.7');f.set('baseAmount','10000');f.set('otFee','1000');f.set('vatEnabled','on');f.set('vatTreatment','ADDED');const r=readTripReference(f);expect(r.otHours).toBe('9.7');expect(r.vatReference).toBe(132000n);expect(r.vatRate).toBe('12');expect(r.vatBasis).toBe('BASE_PLUS_OT');});
 it.each(['-1','abc','1.001','1.25'])('rejects invalid saved OT hours %s',otHours=>expect(()=>validateTripReference({...reference,otHours})).toThrow('OT hours'));
});


describe('Single-decimal OT references',()=>{
 it('normalizes whole hours without rounding fractional input',()=>{expect(normalizeOtHours('2')).toBe('2.0');expect(normalizeOtHours('002.5')).toBe('2.5');expect(normalizeOtHours('')).toBe('');});
 it('does not capture removed external SOA fields on new entry',()=>{const f=new FormData();f.set('externalSoaReference','ignored');expect(readTripReference(f).externalSoaReference).toBe('');});
});
