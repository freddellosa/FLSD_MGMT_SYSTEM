import {validateAttachments,type DemoAttachment} from './attachments';
﻿/** DEMONSTRATION ONLY. Immutable session memory; no database, network or real posting. */
import { manualTripTotal, needsTaxReview, tripVat, validateTripReference, type TripReference } from '../domain/trip-reference';
import { tripDurationMinutes, tripChargeTotal, type TripCharges, type TripSchedule } from '../domain/trip-encoding';
import {customerPaymentTerm,type PaymentTerm} from '../domain/payment-terms';
import { businessDate, requireBusinessDate as validDate } from '../domain/business-date';
import { availableCredit, type PaymentSnapshot } from '../domain/financial-ledger';
import {planCustomerReceipt, type ReceiptSplit} from './customer-receipt';
import {activeCertificates, invoiceWithholding, type PilotCertificate} from './form-2307';
import { assertSoaEligible } from '../domain/billing';
import { acceptRemittance, assertAllocationReversal, assertPaymentVoid, assertRefundReservation, assertTripAllocation, assertTripScope, classifyReceipt, moneyGuard, refundTransition, reservesRefund, type RemittanceState, type TripRefundState } from '../domain/trip-payments';
import { requirePermission, type Role } from '../security/permissions';
import { mapWtsRows, type WtsSourceRow } from '../domain/wts-import';
import { activeInvoice, billingReservation, changeInvoice, invoiceActionTypes, requireInvoiceServiceDate, type InvoiceLifecycleAction, type PrintState } from './invoice-lifecycle';
import { customerInput,userInput,defaultDashboard,seedDemoUsers,validateDashboard,type DashboardConfig,type DemoCustomer,type DemoUser,type CustomerInput,type UserInput } from './workspace-settings';
import { genericFormat,validateInvoiceFormat,type InvoiceFormat,type InvoiceFormatInput } from './invoice-formats';
import { vehicleInput,driverInput,type DemoVehicle,type DemoDriver,type VehicleInput,type DriverInput } from './catalogs';
import { operationalStatuses,validateOperationalEdit,type OperationalStatus,type TripOperationalEdit } from './trip-operations';
export const customers = [{id:'c1',name:'Santos Family'},{id:'c2',name:'Northstar Logistics'},{id:'c3',name:'Marisol Events'},{id:'c4',name:'Pacific Medical Group'},{id:'accenture',name:'Accenture Inc.'}];
export const vehicles = ['Toyota Coaster · ABC 1234','Toyota Hiace · DEF 5678','Nissan Urvan · GHI 9012'];
export const drivers = ['Miguel Reyes','Carlo Mendoza','Jun Bautista'];
export type Method = 'CASH' | 'BANK_TRANSFER' | 'GCASH';
export type Purpose = 'SETTLEMENT' | 'ADVANCE' | 'DEPOSIT';
export type DemoExecutionContext = {allowZeroDailyTrips?: true; allowCustomerReceipts?: true};
export type WithholdingRecords = {customerReceipts?: true; certificates2307?: PilotCertificate[]; withholdingExpectations?: Record<string,bigint>};
export type DemoTrip = {id:string;version?:number;operationalStatus?:OperationalStatus;customerId:string;date:string;origin:string;destination:string;vehicle:string;driver:string;itinerary?:string;amount:bigint;workflow:'DIRECT'|'CORPORATE';schedule?:TripSchedule;charges?:TripCharges;reference?:TripReference};
export type DemoPayment = {id:string;tripId:string|null;customerId:string;amount:bigint;excess:bigint;purpose:Purpose;method:Method;collector:'OFFICE'|'DRIVER';driver:string;reference:string;receivedDate?:string;depositDate?:string;depositReference?:string;state:'RECORDED'|'VOIDED'};
export type DemoAllocation = {id:string;paymentId:string;tripId:string;invoiceId?:string;amount:bigint;reversed:bigint};
export type DemoRefund = {id:string;paymentId:string;amount:bigint;method:Method;recipient:string;reason:string;state:TripRefundState;approvedBy?:Role;reference?:string};
export type DemoRemittance = {id:string;paymentId:string;tendered:bigint;accepted:bigint;state:RemittanceState;reference:string};
export type DemoDocument = {id:string;type:'SOA'|'INVOICE';customerId:string;tripIds:string[];soaId?:string;soaVersion?:number;version:number;amountSnapshot:bigint;stage?:'DRAFT'|'FINAL'|'VOIDED';voidReason?:string;invoiceNumber?:string;invoiceDate?:string;paymentTerm?:PaymentTerm;receivedDate?:string;receiptReference?:string;description?:string;invoiceState?:'ACTIVE'|'AVAILABLE'|'CANCELLED';printState?:PrintState;assignmentHistory?:{soaId?:string;customerId:string;tripIds:string[];amountSnapshot:bigint;invoiceDate?:string;paymentTerm?:PaymentTerm;reason:string}[];taxStatus:'PENDING_ACCOUNTANT_REVIEW';status:'DEMO_ISSUED'};
export type DemoEvent = {actorId?:string;actorName?:string;occurredAt?:string;id:string;actor:Role;action:string;entityId:string;detail:string};
export type ImportBatch={id:string;version:number;fileName:string;digest:string;tripIds:string[];state:"ACTIVE"|"ROLLED_BACK";archivedTrips?:DemoTrip[]};
export type DemoState = WithholdingRecords & {commandResult?:{entityId:string;action:string};protectedTripIds?:string[];invoiceLockedTripIds?:string[];collectionEvidence:{id:string;invoiceId:string;paymentIds:string[];files:DemoAttachment[]}[];importBatches:ImportBatch[];vehicles:DemoVehicle[];drivers:DemoDriver[];invoiceFormats:InvoiceFormat[];customers:DemoCustomer[];users:DemoUser[];dashboard:DashboardConfig;trips:DemoTrip[];payments:DemoPayment[];allocations:DemoAllocation[];refunds:DemoRefund[];remittances:DemoRemittance[];documents:DemoDocument[];events:DemoEvent[];operations:Record<string,string>;sequence:number;invoiceStock:{first:number;last:number;next:number}};
export type NewDemoTrip = Omit<DemoTrip,'id'|'origin'|'destination'> & {origin?:string;destination?:string};
export type PaymentFields = {tripId:string;amount:bigint;purpose:Purpose;method:Method;collector:'OFFICE'|'DRIVER';driver:string;reference:string;receivedDate?:string};
export type DemoAction =
 | InvoiceLifecycleAction
 | {type:'CATALOG_STATE';kind:'CUSTOMER'|'VEHICLE'|'DRIVER';id:string;expectedVersion:number;active?:boolean;remove?:boolean}
 | {type:'ROLLBACK_WTS';batchId:string;expectedVersion:number;reason:string}
 | {type:'SAVE_VEHICLE';vehicleId?:string;expectedVersion?:number;vehicle:VehicleInput}
 | {type:'SAVE_DRIVER';driverId?:string;expectedVersion?:number;driver:DriverInput}
 | {type:'SAVE_INVOICE_FORMAT';formatId?:string;expectedVersion?:number;format:InvoiceFormatInput}
 | {type:'ASSIGN_INVOICE_FORMAT';customerId:string;expectedVersion:number;formatId:string}
 | {type:'EDIT_TRIP';tripId:string;expectedVersion:number;edit:TripOperationalEdit;replacement?:NewDemoTrip}
 | {type:'SAVE_CUSTOMER';customerId?:string;expectedVersion?:number;customer:CustomerInput}
 | {type:'SAVE_DEMO_USER';userId?:string;expectedVersion?:number;user:UserInput}
 | {type:'SAVE_DASHBOARD';expectedVersion:number;config:DashboardConfig}
 | {type:'SETTLE_INVOICE';files?:DemoAttachment[];invoiceId:string;expectedVersion:number;allocations:{tripId:string;amount:bigint;expectedBalance:bigint}[];method:Method;reference:string;receivedDate?:string}
 | {type:'IMPORT_WTS';digest:string;rows:WtsSourceRow[];fileName?:string}
 | {type:'CREATE_TRIP';trip:NewDemoTrip;payment?:Omit<PaymentFields,'tripId'>}
 | ({type:'RECEIVE'} & PaymentFields)
 | {type:'RECORD_CUSTOMER_RECEIPT';customerId:string;amount:bigint;receivedDate:string;method:Method;reference:string;depositDate?:string;depositReference?:string;splits:ReceiptSplit[]}
 | {type:'SET_WITHHOLDING_EXPECTATION';invoiceId:string;amount:bigint;reason:string}
 | {type:'REGISTER_FORM_2307';customerId:string;reference:string;issuedDate:string;periodStart:string;periodEnd:string;amount:bigint;lines:{invoiceId:string;amount:bigint}[];file:DemoAttachment;supersedesId?:string;reason?:string}
 | {type:'ALLOCATE';paymentId:string;tripId:string;amount:bigint}
 | {type:'REVERSE';allocationId:string;amount:bigint;reason:string}
 | {type:'VOID';paymentId:string;reason:string}
 | {type:'REQUEST_REFUND';paymentId:string;amount:bigint;method:Method;recipient:string;reason:string}
 | {type:'REFUND_STATE';refundId:string;next:TripRefundState;reference:string}
 | {type:'TENDER';paymentId:string;amount:bigint;reference:string}
 | {type:'ACCEPT';remittanceId:string;counted:bigint;reference:string}
 | {type:'CREATE_SOA';tripIds:string[]}
 | {type:'EDIT_SOA';soaId:string;tripIds:string[];expectedVersion:number}
 | {type:'FINALIZE_SOA';soaId:string;expectedVersion:number}
 | {type:'VOID_SOA';soaId:string;expectedVersion:number;reason:string}
 | {type:'RECORD_INVOICE_RECEIPT';invoiceId:string;receivedDate:string;reference:string;expectedVersion:number}
 | {type:'CREATE_INVOICE';soaId?:string;tripId?:string;expectedSoaVersion?:number;invoiceDate?:string};
export const emptyDemo = (): DemoState => ({collectionEvidence:[],importBatches:[],vehicles:vehicles.map((label,i)=>({id:'vehicle-'+i,label,version:1,model:label.split(' · ')[0],plate:label.split(' · ')[1],capacity:'',notes:''})),drivers:drivers.map((label,i)=>({id:'driver-'+i,label,name:label,version:1,phone:'',license:'',notes:''})),invoiceFormats:[genericFormat()],customers:customers.map(c=>({...c,version:1,tin:'',invoiceFormatId:'FORMAT-GENERIC',contact:'',email:'',phone:'',address:''})),users:seedDemoUsers(),dashboard:defaultDashboard(),trips:[],payments:[],allocations:[],refunds:[],remittances:[],documents:[],events:[],operations:{},sequence:0,invoiceStock:{first:1001,last:9999,next:1001}});
const sum = <T,>(items:T[], value:(item:T)=>bigint) => items.reduce((n,item)=>n+value(item),0n);
function find<T extends {id:string}>(items:T[], id:string):T { const item=items.find(i=>i.id===id); if(!item) throw new Error('Record not found'); return item; }
function text(value:string, name:string) { if(!value.trim() || value.length>200) throw new Error(`${name} is required (maximum 200 characters)`); }
function channel(method:Method) { if(!['CASH','BANK_TRANSFER','GCASH'].includes(method)) throw new Error('Invalid payment channel'); }
const id = (s:DemoState,prefix:string) => `${prefix}-${String(++s.sequence).padStart(4,'0')}`;
function soaTrips(s:DemoState,ids:string[],customerId?:string,exceptSoaId?:string):DemoTrip[] {
 if(!ids.length||new Set(ids).size!==ids.length)throw new Error('Select at least one unique trip');
 const ts=ids.map(tripId=>find(s.trips,tripId));
 if(ts.some(t=>t.workflow!=='CORPORATE'))throw new Error('Select corporate trips for SOA');
 if(ts.some(t=>needsTaxReview(t.reference)))throw new Error('VAT / withholding treatment requires accounting review before billing');
 assertSoaEligible(ts.map(t=>({tripId:t.id,customerId:t.customerId,amountCentavos:t.amount,soaId:s.documents.some(d=>billingReservation(d)&&d.id!==exceptSoaId&&d.tripIds.includes(t.id))?'reserved':null})),{customerId:customerId??ts[0].customerId,tripIds:ids});
 moneyGuard(sum(ts,t=>t.amount),true);return ts;
}
function assertEditableSoa(s:DemoState,soa:DemoDocument,version:number) {
 if(soa.type!=='SOA')throw new Error('SOA required');
 if(soa.version!==version)throw new Error('SOA changed; reload before saving');
 if(soa.stage==='VOIDED')throw new Error('Voided SOA is retained for history');
 if(s.documents.some(d=>activeInvoice(d)&&d.soaId===soa.id))throw new Error('Invoiced SOA is locked');
 if(s.allocations.some(a=>soa.tripIds.includes(a.tripId)&&a.amount-a.reversed>0n))throw new Error('SOA with settlement cannot be edited');
}
export function paymentSnapshot(s:DemoState,p:DemoPayment):PaymentSnapshot {
 return {receivedCentavos:p.amount,allocationsCentavos:sum(s.allocations.filter(a=>a.paymentId===p.id),a=>a.amount-a.reversed),completedRefundsCentavos:sum(s.refunds.filter(r=>r.paymentId===p.id&&r.state==='COMPLETED'),r=>r.amount),pendingRefundsCentavos:sum(s.refunds.filter(r=>r.paymentId===p.id&&reservesRefund(r.state)),r=>r.amount)};
}
export function refundAvailable(s:DemoState,p:DemoPayment) {
 const snap=paymentSnapshot(s,p); const n=p.excess-snap.completedRefundsCentavos-snap.pendingRefundsCentavos;
 if(n<0n) throw new Error('Refund-only credit overcommitted'); return n;
}
export function advanceAvailable(s:DemoState,p:DemoPayment) { return availableCredit(paymentSnapshot(s,p))-refundAvailable(s,p); }
export function tripBalance(s:DemoState,tripId:string) { const t=find(s.trips,tripId); return t.amount-sum(s.allocations.filter(a=>a.tripId===tripId),a=>a.amount-a.reversed); }
export function driverHeld(s:DemoState,p:DemoPayment) { return p.state==='RECORDED'&&p.method==='CASH'&&p.collector==='DRIVER' ? p.amount-sum(s.remittances.filter(r=>r.paymentId===p.id),r=>r.accepted):0n; }
export function pendingTender(s:DemoState,p:DemoPayment) { return sum(s.remittances.filter(r=>r.paymentId===p.id&&r.state==='TENDERED'),r=>r.tendered); }
export function tripStatus(s:DemoState,t:DemoTrip) {
 if(needsTaxReview(t.reference))return 'Tax review pending';
 if(t.amount===0n)return 'No charge recorded';
 const ps=s.payments.filter(p=>p.tripId===t.id&&p.state==='RECORDED');
 if(ps.some(p=>refundAvailable(s,p)>0n || paymentSnapshot(s,p).pendingRefundsCentavos>0n)) return 'Refund due';
 if(tripBalance(s,t.id)===0n) return 'Settled';
 if(ps.some(p=>advanceAvailable(s,p)>0n)) return 'Advance held';
 return tripBalance(s,t.id)<t.amount?'Partially paid':'Unpaid';
}
export const isRecordedReceiptAsOf=(p:DemoPayment,today:string)=>p.state==='RECORDED'&&(!p.receivedDate||p.receivedDate<=today);
export function demoTotals(s:DemoState,today=businessDate()) {
 const recorded=s.payments.filter(p=>p.state==='RECORDED');const approvedTrips=s.trips.filter(t=>!needsTaxReview(t.reference));
 return {charges:sum(approvedTrips,t=>t.amount),collections:sum(recorded.filter(p=>isRecordedReceiptAsOf(p,today)),p=>p.amount),outstanding:sum(approvedTrips,t=>tripBalance(s,t.id)),advances:sum(recorded,p=>advanceAvailable(s,p)),refundCredit:sum(recorded,p=>refundAvailable(s,p)),reserved:sum(recorded,p=>paymentSnapshot(s,p).pendingRefundsCentavos),refunded:sum(recorded,p=>paymentSnapshot(s,p).completedRefundsCentavos),driverCash:sum(recorded,p=>driverHeld(s,p)),remitted:sum(s.remittances,r=>r.accepted)};
}
function eligible(s:DemoState,t:DemoTrip) { if(t.amount===0n)throw new Error('No charge to collect for this zero-charge trip'); if(needsTaxReview(t.reference))throw new Error('VAT / withholding treatment requires accounting review before collection or billing'); if(t.workflow==='CORPORATE'&&!s.documents.some(d=>activeInvoice(d)&&d.tripIds.includes(t.id))) throw new Error('Corporate collection requires a demo-issued invoice'); }
function receive(s:DemoState,a:PaymentFields) {
 const today=businessDate(),receivedDate=a.receivedDate??today;
 validDate(receivedDate,'Collection date');
 if(receivedDate>today)throw new Error('Collection date cannot be in the future');
 const t=find(s.trips,a.tripId); eligible(s,t); moneyGuard(a.amount,true); channel(a.method);
 if(!['SETTLEMENT','ADVANCE','DEPOSIT'].includes(a.purpose)) throw new Error('Invalid receipt purpose');
 if(!['OFFICE','DRIVER'].includes(a.collector)) throw new Error('Invalid collector');
 if(t.workflow==='CORPORATE'&&a.purpose!=='SETTLEMENT') throw new Error('Corporate advances await accounting policy');
 if(a.collector==='DRIVER'&&!s.drivers.some(d=>d.label===a.driver)) throw new Error('Select collecting driver');
 text(a.reference,'Collection reference / evidence');
 const ps=s.payments.filter(p=>p.tripId===t.id&&p.state==='RECORDED');
 const capacity=tripBalance(s,t.id)-sum(ps,p=>advanceAvailable(s,p));
 if(capacity<0n) throw new Error('Trip funds exceed agreed charge');
 const classified=classifyReceipt(a.amount,capacity,a.purpose);
 if(t.workflow==='CORPORATE'&&classified.excess>0n) throw new Error('Corporate excess policy unresolved; enter only invoice balance');
 const p:DemoPayment={...a,receivedDate,id:id(s,'PAY'),customerId:t.customerId,excess:classified.excess,state:'RECORDED'};
 s.payments.push(p);
 if(classified.applied>0n) s.allocations.push({id:id(s,'ALLOC'),paymentId:p.id,tripId:t.id,amount:classified.applied,reversed:0n});
 return p.id;
}

function zeroDailyTripAllowed(trip:NewDemoTrip,context?:DemoExecutionContext) {
 return context?.allowZeroDailyTrips===true&&trip.amount===0n&&!!trip.charges&&tripChargeTotal(trip.charges)===0n;
}
function rejectRetiredArrangement(trip:NewDemoTrip) {
 if((trip as NewDemoTrip&{arrangement?:unknown}).arrangement!==undefined)throw new Error('The contract-selection workflow was retired. Reload and encode a normal trip.');
}
const financialFingerprint=(t:NewDemoTrip)=>JSON.stringify({customerId:t.customerId,workflow:t.workflow,amount:t.amount,charges:t.charges,vat:t.reference?.vatReference??0n,vatTreatment:t.reference?.vatTreatment,vatBasis:t.reference?.vatBasis,withholding:t.reference?.withholdingReference??0n},(_,v)=>typeof v==='bigint'?v.toString():v);
function validateNewTrip(s:DemoState,a:NewDemoTrip,previous?:DemoTrip,context?:DemoExecutionContext){ const sameFinancial=previous&&financialFingerprint(a)===financialFingerprint(previous);rejectRetiredArrangement(a);moneyGuard(a.amount,!zeroDailyTripAllowed(a,context));if(a.reference)validateTripReference(a.reference);
  const customerVat=s.customers.find(c=>c.id===a.customerId)?.vatStatus;
  if(!sameFinancial&&customerVat==='NON_VAT'&&((a.reference?.vatReference??0n)!==0n||['ADDED','INCLUDED'].includes(a.reference?.vatTreatment??'')))throw new Error('Non-VAT customers cannot have VAT applied');
  if(!sameFinancial&&customerVat==='VAT'&&(a.reference?.vatBasis!=='BASE_PLUS_OT'||!['ADDED','INCLUDED'].includes(a.reference?.vatTreatment??'')))throw new Error('VAT customer requires explicit added or included VAT on base plus OT');
  if(a.operationalStatus!==undefined&&!operationalStatuses.includes(a.operationalStatus))throw new Error('Invalid operational status');
  if(a.operationalStatus!==undefined&&a.operationalStatus!=='COMPLETED')throw new Error('This register records completed trips only');
  if(a.schedule) { tripDurationMinutes(a.schedule); if(a.date!==a.schedule.startDate) throw new Error('Trip date must match start date'); }
  if(!sameFinancial&&a.reference?.vatBasis==='BASE_PLUS_OT'&&(!a.charges||a.reference.vatReference!==tripVat(a.charges,a.reference.vatTreatment??'')))throw new Error('VAT must equal 12% of base plus OT fee only');
  if(a.charges) { if(!sameFinancial&&manualTripTotal(a.charges,a.reference)!==a.amount) throw new Error('Trip total must equal charge breakdown'); if(a.charges.othersNote.length>2000) throw new Error('Other charge description exceeds 2000 characters'); }
  if(!s.customers.some(c=>c.id===a.customerId&&(c.active!==false||previous?.customerId===c.id))||!s.vehicles.some(v=>v.label===a.vehicle&&(v.active!==false||previous?.vehicle===v.label))||!s.drivers.some(d=>d.label===a.driver&&(d.active!==false||previous?.driver===d.label))) throw new Error('Choose valid customer, vehicle and driver');
  if(!['DIRECT','CORPORATE'].includes(a.workflow)) throw new Error('Invalid workflow');
  if(!/^\d{4}-\d{2}-\d{2}$/.test(a.date)||!Number.isFinite(Date.parse(a.date))||new Date(a.date).toISOString().slice(0,10)!==a.date) throw new Error('Invalid trip date');
  if(a.itinerary!==undefined){if(!a.itinerary.trim()||a.itinerary.length>2000)throw new Error('Whole trip itinerary is required (maximum 2000 characters)');}else{text(a.origin??'','Origin');text(a.destination??'','Destination');}

}
export function requireDemoActionPermission(role:Role,action:DemoAction){
 if(['SAVE_INVOICE_FORMAT','ASSIGN_INVOICE_FORMAT'].includes(action.type)&&!['OWNER','ADMIN'].includes(role))throw new Error('Forbidden');
 if(action.type==='SAVE_DASHBOARD'&&role!=='OWNER')throw new Error('Forbidden');
 if(action.type==='SAVE_CUSTOMER'||(action.type==='CATALOG_STATE'&&action.kind==='CUSTOMER')){
  requirePermission(role,'customer:write');
  if(action.type==='SAVE_CUSTOMER'&&(action.customer?.vatStatus!==undefined||action.customer?.paymentTerm!==undefined))requirePermission(role,'customer:vat');
  return;
 }
 requirePermission(role,action.type==='SAVE_DEMO_USER'?'user:manage':['CATALOG_STATE','SAVE_DASHBOARD','SAVE_VEHICLE','SAVE_DRIVER','SAVE_INVOICE_FORMAT','ASSIGN_INVOICE_FORMAT'].includes(action.type)?'master:write':['ROLLBACK_WTS','CREATE_TRIP','IMPORT_WTS','EDIT_TRIP'].includes(action.type)?'trip:write':['CREATE_SOA','EDIT_SOA','FINALIZE_SOA','VOID_SOA'].includes(action.type)?'soa:write':['CREATE_INVOICE','RECORD_INVOICE_RECEIPT',...invoiceActionTypes].includes(action.type)?'invoice:write':'payment:write');
 if(action.type==='CREATE_TRIP'&&action.payment) requirePermission(role,'payment:write');
 if(['INVOICE_PRINT_RESULT','INSPECT_INVOICE_FORM'].includes(action.type))requirePermission(role,'invoice:print');
}
/** Pure atomic demo transaction. Role selector is simulated, NOT production authentication. */
export function executeDemo(state:DemoState,action:DemoAction,key:string,role:Role,context?:DemoExecutionContext):DemoState {
 requireDemoActionPermission(role,action);
 if(!key.trim()||key.length>160) throw new Error('Valid operation key required');
 const digest=JSON.stringify({action,role},(_,v)=>typeof v==='bigint'?v.toString():v);
 if(Object.hasOwn(state.operations,key)) { if(state.operations[key]!==digest) throw new Error('Operation key reused with different payload'); return state; }
 const s=structuredClone(state); let subject='';
 switch(action.type) {
 case 'CATALOG_STATE': {
  if(!['CUSTOMER','VEHICLE','DRIVER'].includes(action.kind))throw new Error('Invalid directory');
  const rows=action.kind==='CUSTOMER'?s.customers:action.kind==='VEHICLE'?s.vehicles:s.drivers;
  const r=find(rows as {id:string;version:number;active?:boolean;label?:string}[],action.id);if(r.version!==action.expectedVersion)throw new Error('Record changed; reopen editor');
  if(action.remove){const used=action.kind==='CUSTOMER'?s.trips.some(t=>t.customerId===r.id)||s.documents.some(d=>d.customerId===r.id||d.assignmentHistory?.some(h=>h.customerId===r.id)):s.trips.some(t=>action.kind==='VEHICLE'?t.vehicle===r.label:t.driver===r.label)||s.payments.some(p=>p.driver===r.label);if(used||s.importBatches.some(b=>b.archivedTrips?.some(t=>action.kind==='CUSTOMER'?t.customerId===r.id:action.kind==='VEHICLE'?t.vehicle===r.label:t.driver===r.label)))throw new Error('Referenced records cannot be deleted. Set to inactive instead');rows.splice(rows.findIndex(v=>v.id===r.id),1);}
  else {if(typeof action.active!=='boolean')throw new Error('Choose Active or Inactive');r.active=action.active;r.version++;}subject=r.id;break;
 }
 case 'ROLLBACK_WTS': {
  const b=find(s.importBatches,action.batchId);text(action.reason,'Rollback reason');if(b.state!=='ACTIVE'||b.version!==action.expectedVersion)throw new Error('Import batch changed');
  if(s.payments.some(p=>p.tripId!==null&&b.tripIds.includes(p.tripId))||s.allocations.some(a=>b.tripIds.includes(a.tripId))||s.documents.some(d=>d.tripIds.some(id=>b.tripIds.includes(id))||d.assignmentHistory?.some(h=>h.tripIds.some(id=>b.tripIds.includes(id)))))throw new Error('Rollback blocked: imported trips have payment or billing history');
  b.archivedTrips=s.trips.filter(t=>b.tripIds.includes(t.id));if(b.archivedTrips.length!==b.tripIds.length)throw new Error('Import batch is incomplete');s.trips=s.trips.filter(t=>!b.tripIds.includes(t.id));b.state='ROLLED_BACK';b.version++;subject=b.id;break;
 }
 case 'SAVE_VEHICLE': {
  const input=vehicleInput(action.vehicle);
  if(s.vehicles.some(v=>v.id!==action.vehicleId&&v.plate===input.plate))throw new Error('Vehicle plate already exists');
  if(action.vehicleId){const v=find(s.vehicles,action.vehicleId);if(v.version!==action.expectedVersion)throw new Error('Vehicle changed; reopen editor');Object.assign(v,input,{version:v.version+1});subject=v.id;}
  else {subject=id(s,'VEHICLE');s.vehicles.push({...input,id:subject,label:subject,version:1});}break;
 }
 case 'SAVE_DRIVER': {
  const input=driverInput(action.driver);
  if(action.driverId){const d=find(s.drivers,action.driverId);if(d.version!==action.expectedVersion)throw new Error('Driver changed; reopen editor');Object.assign(d,input,{version:d.version+1});subject=d.id;}
  else {subject=id(s,'DRIVER');s.drivers.push({...input,id:subject,label:subject,version:1});}break;
 }
 case 'SAVE_INVOICE_FORMAT': {
  validateInvoiceFormat(action.format);
  const {name,paper,margin,fontSize,accent,sellerName,sellerAddress,sellerTin,footer,fields,layout,canvas,offsetX,offsetY}=action.format;
  const input={layout,offsetX,offsetY,canvas:canvas?.map(({id,field,label,text,x,y,width,height,fontSize})=>({id,field,label,text,x,y,width,height,fontSize})),name:name.trim(),paper,margin,fontSize,accent,sellerName,sellerAddress,sellerTin,footer,fields:fields.map(({id,visible,span})=>({id,visible,span}))};
  if(s.invoiceFormats.some(f=>f.id!==action.formatId&&f.name.toLowerCase()===action.format.name.trim().toLowerCase()))throw new Error('Format name already exists');
  if(action.formatId){const f=find(s.invoiceFormats,action.formatId);if(f.version!==action.expectedVersion)throw new Error('Format changed; reopen editor');Object.assign(f,input,{version:f.version+1});subject=f.id;}
  else {subject=id(s,'FORMAT');s.invoiceFormats.push({...input,id:subject,version:1});}break;
 }
 case 'ASSIGN_INVOICE_FORMAT': {
  const c=find(s.customers,action.customerId);find(s.invoiceFormats,action.formatId);if(c.version!==action.expectedVersion)throw new Error('Customer changed; retry assignment');c.invoiceFormatId=action.formatId;c.version++;subject=c.id;break;
 }
 case 'EDIT_TRIP': {
  const trip=find(s.trips,action.tripId),edit=action.edit;
  if(edit.operationalStatus!=='COMPLETED')throw new Error('This register records completed trips only');
  if((trip.version??1)!==action.expectedVersion)throw new Error('Trip changed; reopen the editor');
  validateOperationalEdit(edit);
  if(s.documents.some(d=>activeInvoice(d)&&d.tripIds.includes(trip.id))){
   const differs=(schedule?:TripSchedule)=>schedule?.startDate!==trip.schedule?.startDate||
    schedule?.startTime!==trip.schedule?.startTime||schedule?.endDate!==trip.schedule?.endDate||schedule?.endTime!==trip.schedule?.endTime;
   if((edit.schedule&&differs(edit.schedule))||(action.replacement&&
    (action.replacement.date!==trip.date||differs(action.replacement.schedule)))){
    throw new Error('Service dates and times are locked by an active invoice; cancel the invoice before correcting the trip');
   }
  }
  if(!s.vehicles.some(v=>v.label===edit.vehicle)||!s.drivers.some(d=>d.label===edit.driver))throw new Error('Choose valid vehicle and driver');
  trip.itinerary=edit.itinerary.trim();trip.origin=edit.origin.trim();trip.vehicle=edit.vehicle;trip.driver=edit.driver;trip.operationalStatus=edit.operationalStatus;
  if(edit.schedule){trip.schedule=edit.schedule;trip.date=edit.schedule.startDate;}
  if(trip.reference){trip.reference.passengers=edit.passengers.trim();trip.reference.remarks=edit.remarks.trim();}
  else if(edit.passengers.trim()||edit.remarks.trim())trip.reference={passengers:edit.passengers.trim(),remarks:edit.remarks.trim(),reservedBy:'',department:'',destinationDetails:'',chargeSite:'',customerApprovedBy:'',externalSoaReference:'',odoOut:'',odoIn:'',vatReference:0n,withholdingReference:0n,vatTreatment:'NONE'};
  if(action.replacement){const a=action.replacement;validateNewTrip(s,a,find(state.trips,trip.id),context);
   if(financialFingerprint(a)!==financialFingerprint(find(state.trips,trip.id))&&(needsTaxReview(find(state.trips,trip.id).reference)||s.payments.some(p=>p.tripId===trip.id)||s.documents.some(d=>d.tripIds.includes(trip.id)||d.assignmentHistory?.some(h=>h.tripIds.includes(trip.id)))))throw new Error('Trip financial details have payment/billing history or unresolved tax review; reconcile before correction');
   Object.assign(trip,{customerId:a.customerId,workflow:a.workflow,amount:a.amount,charges:a.charges,reference:a.reference,schedule:a.schedule,date:a.date,itinerary:a.itinerary,origin:a.origin??'',destination:a.destination??'',vehicle:a.vehicle,driver:a.driver});
  }
  trip.version=(trip.version??1)+1;subject=trip.id;break;
 }
 case 'SAVE_CUSTOMER': {
  const input=customerInput(action.customer,s.customers.find(c=>c.id===action.customerId)?.tin);
  if(s.customers.some(c=>c.id!==action.customerId&&c.name.toLocaleLowerCase('en')===input.name.toLocaleLowerCase('en')))throw new Error('Customer name already exists');
  if(action.customerId){const c=find(s.customers,action.customerId);if(c.version!==action.expectedVersion)throw new Error('Customer changed; reopen editor');Object.assign(c,input,{version:c.version+1});subject=c.id;}
  else {subject=id(s,'CUSTOMER');s.customers.push({...input,id:subject,version:1,invoiceFormatId:'FORMAT-GENERIC'});}break;
 }
 case 'SAVE_DEMO_USER': {
  const input=userInput(action.user);
  if(s.users.some(u=>u.id!==action.userId&&u.email===input.email))throw new Error('User email already exists');
  if(action.userId){const u=find(s.users,action.userId);if(u.version!==action.expectedVersion)throw new Error('User changed; reopen editor');Object.assign(u,input,{version:u.version+1});subject=u.id;}
  else {subject=id(s,'USER');s.users.push({...input,id:subject,version:1});}break;
 }
 case 'SAVE_DASHBOARD': {
  validateDashboard(action.config);
  if(s.dashboard.version!==action.expectedVersion||action.config.version!==action.expectedVersion)throw new Error('Dashboard changed; reload settings');
  s.dashboard={...action.config,widgets:action.config.widgets.map(w=>({...w,title:w.title.trim()})),version:s.dashboard.version+1};subject='dashboard';break;
 }
 case 'SETTLE_INVOICE': {
  validateAttachments(action.files??[]);const paymentIds:string[]=[];
  const invoice=find(s.documents,action.invoiceId);
  if(!activeInvoice(invoice)||invoice.version!==action.expectedVersion)throw new Error('Invoice changed or inactive; reopen settlement');
  if(!action.allocations.length||new Set(action.allocations.map(a=>a.tripId)).size!==action.allocations.length)throw new Error('Select unique invoice trip allocations');
  for(const a of action.allocations){
   if(!invoice.tripIds.includes(a.tripId))throw new Error('Trip is outside this invoice');
   if(tripBalance(s,a.tripId)!==a.expectedBalance)throw new Error('Settlement balance changed; reopen settlement');
   moneyGuard(a.amount,true);
   if(a.amount>a.expectedBalance)throw new Error('Collection exceeds trip balance');
   const held=sum(s.payments.filter(p=>p.tripId===a.tripId&&p.state==='RECORDED'),p=>advanceAvailable(s,p));
   if(a.amount>a.expectedBalance-held)throw new Error('Apply the existing advance before collecting the remaining invoice balance');
   paymentIds.push(receive(s,{tripId:a.tripId,amount:a.amount,purpose:'SETTLEMENT',method:action.method,collector:'OFFICE',driver:'',reference:action.reference,receivedDate:action.receivedDate}));
  }
  if(action.files?.length)s.collectionEvidence.push({id:id(s,'EVIDENCE'),invoiceId:invoice.id,paymentIds,files:action.files.map(({name,type,size,data})=>({name,type,size,data}))});
  invoice.version++;subject=invoice.id;break;
 }
 case 'UPDATE_INVOICE_DETAILS':case 'INVOICE_PRINT_RESULT':case 'INSPECT_INVOICE_FORM':case 'CLEAR_INVOICE_ASSIGNMENT':case 'CANCEL_INVOICE':case 'REASSIGN_INVOICE':subject=changeInvoice(s,action);break;
 case 'IMPORT_WTS': {
  if(!/^[a-f0-9]{64}$/.test(action.digest))throw new Error('Invalid workbook fingerprint');
  if(s.importBatches.some(b=>b.digest===action.digest&&b.state==='ACTIVE'))throw new Error('This workbook was already imported in this demo session');
  const preview=mapWtsRows(action.rows);
  if(preview.some(row=>row.errors.length||!row.trip))throw new Error('Resolve all WTS row errors before importing');
  const tripIds:string[]=[];for(const row of preview){const a=row.trip!;if(!s.customers.some(c=>c.id===a.customerId&&c.active!==false))throw new Error('Import customer is inactive');const tripId=id(s,'TRIP');tripIds.push(tripId);s.trips.push({...a,operationalStatus:'COMPLETED',version:1,origin:'',destination:'',id:tripId});}
  const batchId=id(s,'IMPORT');s.importBatches.push({id:batchId,version:1,digest:action.digest,fileName:(action.fileName??'Accenture WTS').slice(0,200),tripIds,state:'ACTIVE'});subject=action.digest;break;
 }
 case 'CREATE_TRIP': {
  const a=action.trip;validateNewTrip(s,a,undefined,context);
  if(a.amount===0n&&action.payment)throw new Error('Record zero-charge daily activity without an initial receipt');
  subject=id(s,'TRIP');s.trips.push({...a,version:1,operationalStatus:'COMPLETED',origin:a.origin?.trim()??'',destination:a.destination?.trim()??'',itinerary:a.itinerary?.trim(),id:subject});
  if(action.payment) receive(s,{...action.payment,tripId:subject}); break;
 }
 case 'RECEIVE': subject=receive(s,action);break;
 case 'SET_WITHHOLDING_EXPECTATION': {
  if(!context?.allowCustomerReceipts)throw new Error('Withholding evidence requires the reviewed pilot schema upgrade');
  const invoice=find(s.documents,action.invoiceId);
  if(!activeInvoice(invoice))throw new Error('Select an issued invoice');
  moneyGuard(action.amount);text(action.reason,'Review reason');
  (s.withholdingExpectations??={})[invoice.id]=action.amount;
  subject=invoice.id;break;
 }
 case 'REGISTER_FORM_2307': {
  if(!context?.allowCustomerReceipts)throw new Error('Withholding evidence requires the reviewed pilot schema upgrade');
  const {customerId,reference,issuedDate,periodStart,periodEnd,amount,lines,file,supersedesId}=action;
  text(reference,'Certificate reference');validDate(issuedDate,'Certificate date');
  validDate(periodStart,'Tax period start');validDate(periodEnd,'Tax period end');
  if(periodStart>periodEnd||issuedDate>businessDate())throw new Error('Invalid certificate date or tax period');
  if(!Array.isArray(lines)||!lines.length)throw new Error('Select at least one invoice');
  const records=(s.certificates2307??=[]);
  const active=activeCertificates(records).filter(record=>record.customerId===customerId);
  if(supersedesId){
   if(!active.some(record=>record.certificateId===supersedesId))throw new Error('Select an active certificate for this customer');
   text(action.reason??'','Correction reason');
  }
  if(active.some(record=>record.certificateId!==supersedesId&&record.reference.toLowerCase()===reference.trim().toLowerCase()))throw new Error('Certificate reference already recorded for this customer');
  const invoices=lines.map(line=>find(s.documents,line.invoiceId));
  if(invoices.some(invoice=>!activeInvoice(invoice)||invoice.customerId!==customerId))throw new Error('Certificate invoices must be issued for the selected customer');
  validateAttachments([file]);
  subject=id(s,'FORM2307');
  s.collectionEvidence.push({id:subject,invoiceId:invoices[0].id,paymentIds:[],files:[file]});
  records.push({certificateId:subject,customerId,reference:reference.trim(),issuedDate,periodStart,periodEnd,attachmentId:subject+'-0',certifiedCentavos:amount,
   invoices:lines.map(line=>({invoiceId:line.invoiceId,certifiedCentavos:line.amount})),supersedesId});
  invoiceWithholding(s,invoices[0].id,customerId);
  break;
 }
 case 'RECORD_CUSTOMER_RECEIPT': {
  if(!context?.allowCustomerReceipts)throw new Error('Customer receipts require the reviewed pilot schema upgrade');
  const {customerId,amount,receivedDate,method,reference,depositDate,depositReference,splits}=action;
  channel(method);text(reference,'Receipt reference');validDate(receivedDate,'Collection date');
  if(receivedDate>businessDate())throw new Error('Collection date cannot be in the future');
  if(depositDate!==undefined){
   validDate(depositDate,'Deposit date');
   if(depositDate<receivedDate||depositDate>businessDate())throw new Error('Deposit date must be between collection and today');
  }
  if(depositReference!==undefined)text(depositReference,'Deposit reference');
  if(s.payments.some(p=>p.tripId===null&&p.state==='RECORDED'&&p.customerId===customerId&&p.method===method&&p.reference.trim().toLowerCase()===reference.trim().toLowerCase()))throw new Error('A customer receipt with this payment reference is already recorded');
  if(!Array.isArray(splits))throw new Error('Select at least one invoice');
  const requestedInvoices=new Set(splits.map(row=>row.invoiceId));
  const invoices=s.documents.filter(d=>activeInvoice(d)&&Boolean(d.soaId)&&d.customerId===customerId&&requestedInvoices.has(d.id));
  const planned=planCustomerReceipt(customerId,amount,splits,invoices.map(invoice=>({
   id:invoice.id,customerId:invoice.customerId,version:invoice.version,
   trips:[...invoice.tripIds].sort().map(tripId=>{
    const trip=find(s.trips,tripId);
    if(trip.amount>0n)eligible(s,trip);
    if(s.payments.some(p=>p.tripId===tripId&&p.state==='RECORDED'&&advanceAvailable(s,p)>0n))throw new Error('Apply existing trip advances before recording this receipt');
    return {id:tripId,balance:tripBalance(s,tripId)};
   }),
  })));
  subject=id(s,'PAY');
  s.payments.push({id:subject,tripId:null,customerId,amount,receivedDate,method,reference:reference.trim(),depositDate,depositReference,excess:0n,purpose:'SETTLEMENT',collector:'OFFICE',driver:'',state:'RECORDED'});
  for(const row of planned)s.allocations.push({...row,id:id(s,'ALLOC'),paymentId:subject,reversed:0n});
  for(const invoice of invoices)invoice.version++;
  break;
 }
 case 'ALLOCATE': {
  const p=find(s.payments,action.paymentId),t=find(s.trips,action.tripId); if(p.state!=='RECORDED') throw new Error('Payment voided'); eligible(s,t);
  if(p.tripId===null)throw new Error('Customer receipt corrections require invoice scope');
  // Demo receipts are intentionally bound to the selected trip for both workflows.
  assertTripScope({customerId:p.customerId,restrictedTripId:p.tripId},t);
  assertTripAllocation(paymentSnapshot(s,p),action.amount,tripBalance(s,t.id),refundAvailable(s,p));
  subject=id(s,'ALLOC');s.allocations.push({id:subject,paymentId:p.id,tripId:t.id,amount:action.amount,reversed:0n});break;
 }
 case 'REVERSE': {
  const a=find(s.allocations,action.allocationId);text(action.reason,'Reversal reason');assertAllocationReversal(a.amount,a.reversed,action.amount);a.reversed+=action.amount;
  if(a.invoiceId)find(s.documents,a.invoiceId).version++;
  subject=a.id;break;
 }
 case 'VOID': {
  const p=find(s.payments,action.paymentId); if(p.state!=='RECORDED') throw new Error('Payment already voided');text(action.reason,'Correction reason');const snap=paymentSnapshot(s,p);
  assertPaymentVoid({allocated:snap.allocationsCentavos,reserved:snap.pendingRefundsCentavos,refunded:snap.completedRefundsCentavos,hasCustodyHistory:p.method==='CASH'||s.remittances.some(r=>r.paymentId===p.id)});
  p.state='VOIDED';subject=p.id;break;
 }
 case 'REQUEST_REFUND': {
  const p=find(s.payments,action.paymentId);if(p.state!=='RECORDED') throw new Error('Payment voided');channel(action.method);text(action.recipient,'Recipient');text(action.reason,'Refund reason');
  assertRefundReservation(paymentSnapshot(s,p),action.amount,refundAvailable(s,p));
  subject=id(s,'REF');s.refunds.push({...action,id:subject,state:'REQUESTED'});break;
 }
 case 'REFUND_STATE': {
  const r=find(s.refunds,action.refundId);const next=refundTransition(r.state,action.next,role);text(action.reference,'Approval / payout / reconciliation evidence');
  if(next==='COMPLETED') {
   const p=find(s.payments,r.paymentId);
   // No office float or cross-channel funding policy is invented in this demo.
   if(driverHeld(s,p)>0n) throw new Error('Reconcile driver cash remittance before demo refund completion');
  }
  r.state=next;r.reference=action.reference;if(next==='APPROVED') r.approvedBy=role;subject=r.id;break;
 }
 case 'TENDER': {
  const p=find(s.payments,action.paymentId);moneyGuard(action.amount,true);text(action.reference,'Tender reference');
  if(action.amount>driverHeld(s,p)-pendingTender(s,p)) throw new Error('Tender exceeds unreserved driver cash');
  subject=id(s,'REM');s.remittances.push({id:subject,paymentId:p.id,tendered:action.amount,accepted:0n,state:'TENDERED',reference:action.reference});break;
 }
 case 'ACCEPT': {
  const r=find(s.remittances,action.remittanceId),p=find(s.payments,r.paymentId);text(action.reference,'Office acknowledgment / discrepancy note');
  r.state=acceptRemittance(r.state,r.tendered,action.counted,driverHeld(s,p));r.accepted=action.counted;r.reference=action.reference;subject=r.id;break;
 }
 case 'CREATE_SOA': {
  const ts=soaTrips(s,action.tripIds);
  subject=id(s,'SOA-DEMO');s.documents.push({id:subject,type:'SOA',customerId:ts[0].customerId,tripIds:ts.map(t=>t.id),amountSnapshot:sum(ts,t=>t.amount),version:1,stage:'DRAFT',taxStatus:'PENDING_ACCOUNTANT_REVIEW',status:'DEMO_ISSUED'});break;
 }
 case 'EDIT_SOA': {
  const soa=find(s.documents,action.soaId);assertEditableSoa(s,soa,action.expectedVersion);
  const ts=soaTrips(s,action.tripIds,soa.customerId,soa.id);
  soa.tripIds=ts.map(t=>t.id);soa.amountSnapshot=sum(ts,t=>t.amount);soa.stage='DRAFT';soa.version++;subject=soa.id;break;
 }
 case 'FINALIZE_SOA': {
  const soa=find(s.documents,action.soaId);assertEditableSoa(s,soa,action.expectedVersion);
  if(soa.stage!=='DRAFT')throw new Error('SOA is already final');soaTrips(s,soa.tripIds,soa.customerId,soa.id);
  soa.stage='FINAL';soa.version++;subject=soa.id;break;
 }
 case 'VOID_SOA': {
  const soa=find(s.documents,action.soaId);assertEditableSoa(s,soa,action.expectedVersion);
  if(soa.stage!=='DRAFT')throw new Error('Only a draft SOA may be voided');
  text(action.reason,'Void reason');
  soa.stage='VOIDED';soa.voidReason=action.reason.trim();soa.version++;subject=soa.id;break;
 }
 case 'CREATE_INVOICE': {
  if(Boolean(action.soaId)===Boolean(action.tripId))throw new Error('Select exactly one invoice source');
  const source=action.soaId?find(s.documents,action.soaId):null;
  if(source&&source.type!=='SOA')throw new Error('SOA source required');
  if(source){
   if(s.documents.some(d=>activeInvoice(d)&&d.soaId===source.id))throw new Error('SOA already invoiced');
   if(source.stage!=='FINAL')throw new Error('Finalize the SOA before creating an invoice');
   if(action.expectedSoaVersion!==source.version)throw new Error('SOA changed; reload before invoicing');
  }
  const ts=source?source.tripIds.map(t=>find(s.trips,t)):[find(s.trips,action.tripId!)];
  if(ts.some(t=>needsTaxReview(t.reference)))throw new Error('VAT / withholding treatment requires accounting review before billing');
  if(!source&&ts[0].workflow!=='DIRECT')throw new Error('Corporate invoice requires SOA');
  if(s.documents.some(d=>activeInvoice(d)&&d.tripIds.some(t=>ts.some(tr=>tr.id===t))))throw new Error('Trip already invoiced');
  requireInvoiceServiceDate(action.invoiceDate??'',ts);
  if(!Number.isSafeInteger(s.invoiceStock.next)||s.invoiceStock.next<s.invoiceStock.first||s.invoiceStock.next>s.invoiceStock.last)throw new Error('Demo invoice stock exhausted or invalid');
  const invoiceNumber=`DEMO-INV-${String(s.invoiceStock.next).padStart(7,'0')}`;
  if(s.documents.some(d=>d.invoiceNumber===invoiceNumber))throw new Error('Invoice number already assigned');
  subject=id(s,'INV-DEMO');s.documents.push({id:subject,type:'INVOICE',customerId:ts[0].customerId,tripIds:ts.map(t=>t.id),soaId:source?.id,soaVersion:source?.version,amountSnapshot:source?.amountSnapshot??sum(ts,t=>t.amount),invoiceNumber,invoiceDate:action.invoiceDate,paymentTerm:customerPaymentTerm(ts[0].customerId,find(s.customers,ts[0].customerId).paymentTerm),version:1,taxStatus:'PENDING_ACCOUNTANT_REVIEW',status:'DEMO_ISSUED'});s.invoiceStock.next++;break;
 }
 case 'RECORD_INVOICE_RECEIPT': {
  const invoice=find(s.documents,action.invoiceId);if(invoice.type!=='INVOICE')throw new Error('Invoice required');
  if(!activeInvoice(invoice))throw new Error('Invoice is no longer actively assigned');
  if(invoice.version!==action.expectedVersion)throw new Error('Invoice changed; reload before recording receipt');
  validDate(action.receivedDate,'Customer received date');
  if(action.receivedDate<(invoice.invoiceDate??''))throw new Error('Received date cannot precede invoice date');
  if(action.reference.length>200)throw new Error('Receipt reference exceeds 200 characters');
  invoice.receivedDate=action.receivedDate;invoice.receiptReference=action.reference.trim();invoice.version++;subject=invoice.id;break;
 }
 }
 s.operations={...s.operations,[key]:digest};
 s.events.push({id:id(s,'EVT'),actor:role,action:action.type,entityId:subject,detail:JSON.stringify(action,(k,v)=>k==='data'?'[attachment content omitted]':typeof v==='bigint'?v.toString():v)});
 assertDemoIntegrity(s,context);return s;
}
export function assertDemoIntegrity(s:DemoState,context?:DemoExecutionContext) {
 for(const b of s.importBatches){if(b.state==='ACTIVE'&&b.tripIds.some(id=>!s.trips.some(t=>t.id===id)))throw new Error('Missing active import trip');if(b.state==='ROLLED_BACK'&&(!b.archivedTrips||b.archivedTrips.length!==b.tripIds.length||b.tripIds.some(id=>s.trips.some(t=>t.id===id))))throw new Error('Invalid rollback archive');}
 for(const e of s.collectionEvidence){validateAttachments(e.files);const invoice=find(s.documents,e.invoiceId);if(e.paymentIds.some(id=>!s.payments.some(p=>p.id===id&&p.tripId!==null&&(invoice.tripIds.includes(p.tripId)||invoice.assignmentHistory?.some(h=>h.tripIds.includes(p.tripId!))))))throw new Error('Evidence payment scope mismatch');}

 if(!s.invoiceFormats.some(f=>f.id==='FORMAT-GENERIC')||new Set(s.invoiceFormats.map(f=>f.id)).size!==s.invoiceFormats.length)throw new Error('Invalid format library');
 for(const f of s.invoiceFormats)validateInvoiceFormat(f);
 if(s.customers.some(c=>c.invoiceFormatId&&!s.invoiceFormats.some(f=>f.id===c.invoiceFormatId)))throw new Error('Unknown customer invoice format');
 validateDashboard(s.dashboard);
 if(new Set(s.customers.map(c=>c.id)).size!==s.customers.length||new Set(s.users.map(u=>u.id)).size!==s.users.length)throw new Error('Duplicate directory identity');
 for(const c of s.customers){customerInput(c,c.tin);if(!Number.isSafeInteger(c.version)||c.version<1)throw new Error('Invalid customer version');}
 for(const u of s.users){userInput(u);if(!Number.isSafeInteger(u.version)||u.version<1)throw new Error('Invalid user version');}
 if(s.trips.some(t=>!s.customers.some(c=>c.id===t.customerId)))throw new Error('Trip customer missing');
 const soaMembership=new Set<string>();const invoiceMembership=new Set<string>();const invoiceNumbers=new Set<string>();const invoicedSoas=new Set<string>();
 for(const d of s.documents){
  if(!Number.isSafeInteger(d.version)||d.version<1||!d.tripIds.length||new Set(d.tripIds).size!==d.tripIds.length)throw new Error('Invalid document version or membership');
  const trips=d.tripIds.map(tripId=>find(s.trips,tripId));
  if(trips.some(t=>t.customerId!==d.customerId))throw new Error('Document customer mismatch');
  if(d.amountSnapshot!==sum(trips,t=>t.amount))throw new Error('Document amount snapshot mismatch');moneyGuard(d.amountSnapshot,true);
  if(d.type==='SOA'){
   if(!['DRAFT','FINAL','VOIDED'].includes(d.stage??''))throw new Error('Invalid SOA stage');
   if(d.stage==='VOIDED'){text(d.voidReason??'','Void reason');continue;}
   for(const t of trips){if(t.workflow!=='CORPORATE'||soaMembership.has(t.id))throw new Error('Duplicate SOA membership');soaMembership.add(t.id);}
  }else{
   if(!d.invoiceNumber||invoiceNumbers.has(d.invoiceNumber))throw new Error('Invalid or duplicate invoice number');invoiceNumbers.add(d.invoiceNumber);validDate(d.invoiceDate??'','Invoice date');
   if(d.receivedDate){validDate(d.receivedDate,'Customer received date');if(d.receivedDate<(d.invoiceDate??''))throw new Error('Invalid invoice received date');}
   if(!activeInvoice(d))continue;
   if(trips.some(t=>t.workflow==='CORPORATE')){
    if(!d.soaId||invoicedSoas.has(d.soaId))throw new Error('Corporate invoice requires exactly one unique SOA');
    const soa=find(s.documents,d.soaId);
    if(soa.type!=='SOA'||soa.stage!=='FINAL'||d.soaVersion!==soa.version||d.tripIds.length!==soa.tripIds.length||d.tripIds.some(t=>!soa.tripIds.includes(t)))throw new Error('Invoice / SOA relationship mismatch');invoicedSoas.add(d.soaId);
   }
   for(const t of trips){if(invoiceMembership.has(t.id))throw new Error('Duplicate trip invoicing');invoiceMembership.add(t.id);}
  }
 }
 for(const t of s.trips) {if(t.operationalStatus!==undefined&&!operationalStatuses.includes(t.operationalStatus))throw new Error('Invalid operational status');if(t.version!==undefined&&(!Number.isSafeInteger(t.version)||t.version<1))throw new Error('Invalid trip version');rejectRetiredArrangement(t);moneyGuard(t.amount,!zeroDailyTripAllowed(t,context));moneyGuard(tripBalance(s,t.id));}
 for(const p of s.payments) {
  if(p.tripId!==null&&find(s.trips,p.tripId).amount===0n)throw new Error('Zero-charge trips have no standalone receipt scope');
  moneyGuard(p.amount,true);moneyGuard(p.excess);if(p.excess>p.amount) throw new Error('Excess exceeds receipt');
  const snap=paymentSnapshot(s,p);availableCredit(snap);moneyGuard(refundAvailable(s,p));moneyGuard(advanceAvailable(s,p));moneyGuard(driverHeld(s,p));
  if(pendingTender(s,p)>driverHeld(s,p)) throw new Error('Cash tender overcommitted');
  for(const a of s.allocations.filter(a=>a.paymentId===p.id)) {
   assertTripScope({customerId:p.customerId,restrictedTripId:p.tripId},find(s.trips,a.tripId));
   if(p.tripId===null){
    const invoice=find(s.documents,a.invoiceId??'');
    if(invoice.type!=='INVOICE'||invoice.customerId!==p.customerId||!(invoice.tripIds.includes(a.tripId)||invoice.assignmentHistory?.some(h=>h.tripIds.includes(a.tripId))))throw new Error('Receipt invoice scope mismatch');
   }
   if(a.reversed>a.amount) throw new Error('Excess reversal');
  }
 }
}
export function createDemoSeed():DemoState {
 let s=emptyDemo();let key=0;
 const run=(a:DemoAction)=>{s=executeDemo(s,a.type==='RECEIVE'?{...a,receivedDate:'2026-11-14'}:a,`seed-${++key}`,'BILLING');};
 const add=(customerId:string,date:string,origin:string,destination:string,amount:bigint,workflow:DemoTrip['workflow'],driver=drivers[0])=>{
  run({type:'CREATE_TRIP',trip:{customerId,date,origin,destination,amount,workflow,driver,operationalStatus:'COMPLETED',vehicle:vehicles[key%vehicles.length]}});return s.trips[s.trips.length-1].id;
 };
 const a=add('c1','2026-11-14','Quezon City','Tagaytay',1000000n,'DIRECT');
 run({type:'RECEIVE',tripId:a,amount:400000n,purpose:'SETTLEMENT',method:'CASH',collector:'DRIVER',driver:drivers[0],reference:'DEMO driver collection 001'});
 const b=add('c3','2026-11-15','Makati','Batangas',1850000n,'DIRECT',drivers[1]);
 run({type:'RECEIVE',tripId:b,amount:500000n,purpose:'DEPOSIT',method:'BANK_TRANSFER',collector:'OFFICE',driver:'',reference:'DEMO verified bank transfer 002'});
 const c=add('c2','2026-11-13','Pasig','Clark',2400000n,'CORPORATE');
 add('c2','2026-11-16','Manila','Subic',1600000n,'CORPORATE',drivers[2]);
 run({type:'CREATE_SOA',tripIds:[c]});const soa=s.documents[s.documents.length-1].id;
 run({type:'FINALIZE_SOA',soaId:soa,expectedVersion:1});
 run({type:'CREATE_INVOICE',soaId:soa,expectedSoaVersion:2,invoiceDate:'2026-11-14'});
 run({type:'RECEIVE',tripId:c,amount:1000000n,purpose:'SETTLEMENT',method:'BANK_TRANSFER',collector:'OFFICE',driver:'',reference:'DEMO corporate collection 003'});
 const e=add('c1','2026-11-12','Manila','Baguio',1200000n,'DIRECT',drivers[1]);
 run({type:'RECEIVE',tripId:e,amount:1300000n,purpose:'SETTLEMENT',method:'GCASH',collector:'OFFICE',driver:'',reference:'DEMO GCash 004'});
 const p=s.payments[s.payments.length-1];run({type:'REQUEST_REFUND',paymentId:p.id,amount:100000n,method:'GCASH',recipient:'Santos demo recipient',reason:'Excess above agreed trip amount'});
 add('c4','2026-11-17','Ortigas','Laguna',950000n,'CORPORATE');

 return s;
}








