import { describe,expect,it } from 'vitest';
import { createDemoSeed,emptyDemo,executeDemo,tripBalance,drivers,vehicles } from './store';
import { customerPaymentTerm,invoiceDueDate,overviewReport } from './overview';
describe('Office overview exact projections and contract dates',()=>{
 it('reports unknown terms without inventing overdue or expected dates',()=>{
  const r=overviewReport(createDemoSeed(),'2026-11-15',{});expect(r.invoices).toHaveLength(1);expect(r.invoices[0].balance).toBe(1400000n);expect(r.overdue).toEqual([]);expect(r.invoices[0].dueDate).toBeNull();
 });
 it('counts trips without active invoices including draft SOAs and direct trips',()=>{
  let s=createDemoSeed();const id=s.trips.find(t=>t.workflow==='CORPORATE'&&!s.documents.some(d=>d.tripIds.includes(t.id)))!.id;
  const before=overviewReport(s,'2026-11-15');s=executeDemo(s,{type:'CREATE_SOA',tripIds:[id]},'draft','BILLING');const after=overviewReport(s,'2026-11-15');expect(after.unbilledCount).toBe(5);expect(after.unbilledAmount).toBe(before.unbilledAmount);
 });
 it('uses outstanding balance, excludes settled/cancelled/available assignments and never double counts SOAs',()=>{
  let s=createDemoSeed();const d=s.documents.find(d=>d.type==='INVOICE')!,id=d.tripIds[0];
  s=executeDemo(s,{type:'RECEIVE',tripId:id,amount:tripBalance(s,id),method:'GCASH',purpose:'SETTLEMENT',collector:'OFFICE',driver:'',reference:'Final'},'paid','BILLING');expect(overviewReport(s,'2026-11-15').invoices).toEqual([]);
  const inactive=createDemoSeed();inactive.documents.find(d=>d.type==='INVOICE')!.invoiceState='AVAILABLE';expect(overviewReport(inactive,'2026-11-15').invoices).toEqual([]);
 });
 it('uses calendar days from the selected contractual basis across leap and year boundaries',()=>{
  expect(invoiceDueDate({invoiceDate:'2024-02-28'},{days:2,basis:'INVOICE_DATE'})).toBe('2024-03-01');
  expect(invoiceDueDate({invoiceDate:'2026-12-20',receivedDate:'2026-12-31'},{days:30,basis:'RECEIVED_DATE'})).toBe('2027-01-30');
  expect(invoiceDueDate({invoiceDate:'2026-11-01'},{days:30,basis:'RECEIVED_DATE'})).toBeNull();
 });
 it('does not call a due-today invoice overdue',()=>{
  const s=createDemoSeed(),terms={c2:{days:1,basis:'INVOICE_DATE' as const}};
  expect(overviewReport(s,'2026-11-15',terms).overdue).toHaveLength(0);expect(overviewReport(s,'2026-11-16',terms).overdue).toHaveLength(1);
 });
 it.each([-1,1.5,3651,NaN])('rejects invalid contract days %s',days=>expect(()=>invoiceDueDate({invoiceDate:'2026-11-14'},{days,basis:'INVOICE_DATE'})).toThrow('whole days'));
 it('rejects invalid dates and runtime contract basis',()=>{
  expect(()=>invoiceDueDate({invoiceDate:'2026-02-30'},{days:1,basis:'INVOICE_DATE'})).toThrow('date');
  expect(()=>invoiceDueDate({invoiceDate:'2026-11-14'},{days:1,basis:'OTHER' as 'INVOICE_DATE'})).toThrow('basis');
 });
 it('agreed-charge revenue reconciles by month, customer and workflow independently of receipts',()=>{
  const s=createDemoSeed(),r=overviewReport(s,'2026-11-15');const year=r.years[0];const total=s.trips.reduce((n,t)=>n+t.amount,0n);
  expect(year.year).toBe(2026);expect(year.months[10]).toBe(total);expect(year.months.reduce((n,v)=>n+v,0n)).toBe(total);expect(year.customers.reduce((n,c)=>n+c.amount,0n)).toBe(total);expect(year.corporate+year.direct).toBe(total);expect(r.years[1].months.every(n=>n===0n)).toBe(true);
 });
 it('applies confirmed 30-day invoice terms to every customer except Accenture at 60 days',()=>{
  for(const id of ['c1','c2','c3','c4','new-customer'])expect(customerPaymentTerm(id)).toEqual({days:30,basis:'INVOICE_DATE'});
  expect(customerPaymentTerm('accenture')).toEqual({days:60,basis:'INVOICE_DATE'});
  expect(invoiceDueDate({invoiceDate:'2026-11-15',receivedDate:'2026-12-01'},customerPaymentTerm('c2'))).toBe('2026-12-15');
  expect(invoiceDueDate({invoiceDate:'2026-11-15',receivedDate:'2026-12-01'},customerPaymentTerm('accenture'))).toBe('2027-01-14');
 });
 it('automatically forecasts balances from invoice date and treats day 30 as due, day 31 as overdue',()=>{
  const s=createDemoSeed(),r=overviewReport(s,'2026-12-14');
  expect(r.invoices[0].dueDate).toBe('2026-12-14');expect(r.overdue).toHaveLength(0);
  expect(overviewReport(s,'2026-12-15').overdue[0].balance).toBe(1400000n);
  let accenture=executeDemo(emptyDemo(),{type:'CREATE_TRIP',trip:{customerId:'accenture',date:'2026-11-14',workflow:'CORPORATE',amount:10001n,vehicle:vehicles[0],driver:drivers[0],itinerary:'Term test'}},'a-trip','BILLING');
  accenture=executeDemo(accenture,{type:'CREATE_SOA',tripIds:[accenture.trips[0].id]},'a-soa','BILLING');
  accenture=executeDemo(accenture,{type:'FINALIZE_SOA',soaId:accenture.documents[0].id,expectedVersion:1},'a-final','BILLING');
  accenture=executeDemo(accenture,{type:'CREATE_INVOICE',soaId:accenture.documents[0].id,expectedSoaVersion:2,invoiceDate:'2026-11-14'},'a-inv','BILLING');
  const a=overviewReport(accenture,'2027-01-13');expect(a.invoices[0].dueDate).toBe('2027-01-13');expect(a.overdue).toHaveLength(0);expect(overviewReport(accenture,'2027-01-14').overdue).toHaveLength(1);
 });
});
