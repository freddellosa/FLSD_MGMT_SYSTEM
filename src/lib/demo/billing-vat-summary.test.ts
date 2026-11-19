import {describe, expect, it} from 'vitest';
import {billingVatSummary, renderBillingVatSummary} from './billing-vat-summary';
import {createDemoSeed, type DemoTrip} from './store';
import {renderInvoiceHtml} from './invoice-renderer';
import {renderSoaHtml} from './soa-renderer';
import {genericFormat} from './invoice-formats';
const trip = (treatment: 'INCLUDED' | 'ADDED' | 'NONE'): DemoTrip => ({
 id: 't', customerId: 'c2', date: '2026-11-17', origin: '', destination: '', vehicle: '', driver: '', workflow: 'CORPORATE',
 amount: treatment === 'ADDED' ? 1180000n : 1060000n,
 charges: {base: 900000n, otFee: 100000n, fuel: 50000n, toll: 10000n, parking: 0n, others: 0n, othersNote: ''},
 reference: {passengers: '', reservedBy: '', department: '', destinationDetails: '', chargeSite: '', remarks: '', customerApprovedBy: '', externalSoaReference: '', odoOut: '', odoIn: '', withholdingReference: 0n, vatTreatment: treatment, vatReference: treatment === 'INCLUDED' ? 107143n : treatment === 'ADDED' ? 120000n : 0n}
});
describe('Read-only document VAT summary', () => {
 it('extracts inclusive VAT with exact residual net and keeps gross unchanged', () => {
  const t=trip('INCLUDED'), before=structuredClone(t);
  expect(billingVatSummary([t],t.amount)).toEqual({net:892857n,vat:107143n,expenses:60000n,gross:1060000n});
  expect(t).toEqual(before);
 });
 it('adds exclusive VAT once and aggregates mixed treatments', () => {
  const a=trip('ADDED'), b=trip('INCLUDED'), c=trip('NONE');
  expect(billingVatSummary([a,b,c],a.amount+b.amount+c.amount)).toEqual({net:2892857n,vat:227143n,expenses:180000n,gross:3300000n});
 });
 it.each(['missing-reference','missing-charges','unknown','mismatch','snapshot','withholding'] as const)('retains recorded amounts without inferred net for %s', kind => {
  const t=trip('INCLUDED');
  if(kind==='missing-reference')t.reference=undefined;
  if(kind==='missing-charges')t.charges=undefined;
  if(kind==='unknown')t.reference!.vatTreatment='UNCONFIRMED';
  if(kind==='mismatch')t.reference!.vatReference=1n;
  if(kind==='withholding')t.reference!.withholdingReference=1n;
  expect(billingVatSummary([t],kind==='snapshot'?1n:t.amount)).toBeNull();
  expect(renderBillingVatSummary([t],kind==='snapshot'?1n:t.amount)).toContain('Recorded amounts retained');
 });
 it('does not create a summary for an empty document', () => { expect(billingVatSummary([],0n)).toBeNull(); });
 it('renders the same breakdown in flow/canvas/Access invoices and SOA without changing snapshots', () => {
  const state=createDemoSeed(), t=trip('INCLUDED'); state.trips=[t];
  const invoice=state.documents.find(d=>d.type==='INVOICE')!;
  invoice.tripIds=[t.id];invoice.amountSnapshot=t.amount;
  const before=structuredClone(state);
  for(const layout of ['FLOW','CANVAS','ACCESS'] as const){
   const format=genericFormat();format.layout=layout;
   if(layout==='CANVAS')format.canvas=[{id:'seller',field:'seller',label:'',text:'',x:0,y:0,width:100,height:20,fontSize:10},{id:'invoice',field:'invoice',label:'',text:'',x:0,y:20,width:100,height:20,fontSize:10},{id:'customer',field:'customer',label:'',text:'',x:0,y:40,width:100,height:20,fontSize:10},{id:'total',field:'total',label:'',text:'',x:0,y:60,width:100,height:20,fontSize:10},{id:'vat',field:'vat',label:'',text:'',x:0,y:80,width:100,height:80,fontSize:10}];
   const html=renderInvoiceHtml(invoice,state,format);
   expect(html).toContain('Base + OT excluding VAT');expect(html).toContain('8,928.57');expect(html).toContain('1,071.43');expect(html).toContain('10,600.00');
  }
  expect(renderSoaHtml({...invoice,type:'SOA'},state)).toContain('8,928.57');
  expect(state).toEqual(before);
 });
});
