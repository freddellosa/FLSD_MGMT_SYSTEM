import { describe,expect,it } from 'vitest';
import { createDemoSeed,executeDemo,demoTotals,drivers,vehicles,type DemoAction } from './store';
import { defaultDashboard,moveWidget,type DashboardConfig,type CustomerInput } from './workspace-settings';
import { corporateInvoiceRows,customerName } from './billing-register';
import { overviewReport,customerPaymentTerm } from './overview';
import { can,type Role } from '../security/permissions';
const customer:CustomerInput={name:'New demo customer',contact:'Demo contact',email:'contact@example.test',phone:'555-0100',address:'Demo address'};
const user={name:'New demo user',email:'new@example.test',role:'OPERATIONS' as const,active:true};
describe('Session workspace settings authorization and integrity',()=>{
 it.each(['BILLING','OPERATIONS','VIEWER'] as Role[])('rejects %s user and dashboard mutations at the common boundary',role=>{
  const s=createDemoSeed();
  for(const action of [{type:'SAVE_DEMO_USER',user},{type:'SAVE_DASHBOARD',expectedVersion:1,config:defaultDashboard()}] as DemoAction[])expect(()=>executeDemo(s,action,'denied',role)).toThrow('Forbidden');
 });
 it.each(['OWNER','ADMIN','BILLING','OPERATIONS'] as Role[])('lets %s create, edit and delete an unreferenced customer',role=>{
  const initial=createDemoSeed();
  const created=executeDemo(initial,{type:'SAVE_CUSTOMER',customer},'create-customer',role);
  const record=created.customers.at(-1)!;
  const edited=executeDemo(created,{type:'SAVE_CUSTOMER',customerId:record.id,expectedVersion:record.version,customer:{...customer,name:'Renamed customer'}},'edit-customer',role);
  expect(edited.customers.at(-1)).toMatchObject({id:record.id,name:'Renamed customer',version:2});
  const deleted=executeDemo(edited,{type:'CATALOG_STATE',kind:'CUSTOMER',id:record.id,expectedVersion:2,remove:true},'delete-customer',role);
  expect(deleted.customers).toEqual(initial.customers);
  const linked=initial.trips[0].customerId;
  const referenced=initial.customers.find(c=>c.id===linked)!;
  expect(()=>executeDemo(initial,{type:'CATALOG_STATE',kind:'CUSTOMER',id:linked,expectedVersion:referenced.version,remove:true},'delete-referenced',role)).toThrow('Referenced records cannot be deleted');
 });
 it('denies customer creation, edit and deletion to Viewer',()=>{
  const initial=createDemoSeed();
  const created=executeDemo(initial,{type:'SAVE_CUSTOMER',customer},'create-customer','OWNER');
  const record=created.customers.at(-1)!;
  const actions:DemoAction[]=[
   {type:'SAVE_CUSTOMER',customer},
   {type:'SAVE_CUSTOMER',customerId:record.id,expectedVersion:record.version,customer:{...customer,name:'Renamed customer'}},
   {type:'CATALOG_STATE',kind:'CUSTOMER',id:record.id,expectedVersion:record.version,remove:true},
  ];
  for(const [i,action] of actions.entries())expect(()=>executeDemo(created,action,`viewer-${i}`,'VIEWER')).toThrow('Forbidden');
 });
 it.each(['OWNER','ADMIN'] as Role[])('%s can manage directories without changing financial totals or permission policy',role=>{
  const s=createDemoSeed(),before=demoTotals(s);
  const a=executeDemo(s,{type:'SAVE_CUSTOMER',customer},'customer',role);
  const b=executeDemo(a,{type:'SAVE_DEMO_USER',user},'user',role);
  expect(demoTotals(b)).toEqual(before);expect(b.payments).toEqual(s.payments);expect(b.allocations).toEqual(s.allocations);expect(b.documents).toEqual(s.documents);expect(b.events.at(-1)?.actor).toBe(role);
  expect(can('OPERATIONS','payment:write')).toBe(false);
 });
 it('adds a stable customer available to trip encoding with confirmed default terms',()=>{
  const s=executeDemo(createDemoSeed(),{type:'SAVE_CUSTOMER',customer},'c','ADMIN'),c=s.customers.at(-1)!;
  const next=executeDemo(s,{type:'CREATE_TRIP',trip:{customerId:c.id,date:'2026-11-15',itinerary:'New customer journey',workflow:'DIRECT',amount:10001n,driver:drivers[0],vehicle:vehicles[0]}},'trip','BILLING');
  expect(next.trips.at(-1)?.customerId).toBe(c.id);expect(customerName(c.id,next)).toBe(customer.name);expect(customerPaymentTerm(c.id).days).toBe(30);
 });
 it('renames an existing customer through projections while retaining IDs, charge history and Accenture terms',()=>{
  const s=createDemoSeed(),c=s.customers.find(c=>c.id==='c2')!;
  const next=executeDemo(s,{type:'SAVE_CUSTOMER',customerId:c.id,expectedVersion:c.version,customer:{...c,name:'Updated Northstar demo'}},'rename','ADMIN');
  expect(next.trips).toEqual(s.trips);expect(next.documents).toEqual(s.documents);expect(corporateInvoiceRows(next)[0].customer).toBe('Updated Northstar demo');
  const accenture=next.customers.find(c=>c.id==='accenture')!;
  const renamed=executeDemo(next,{type:'SAVE_CUSTOMER',customerId:accenture.id,expectedVersion:accenture.version,customer:{...accenture,name:'Accenture updated demo'}},'rename-a','OWNER');
  expect(customerPaymentTerm(renamed.customers.find(c=>c.id==='accenture')!.id).days).toBe(60);
 });
 it('normalizes user email and edits a user without creating identity or changing the command actor',()=>{
  let s=executeDemo(createDemoSeed(),{type:'SAVE_DEMO_USER',user:{...user,email:' NEW@example.test '}},'add','ADMIN');const u=s.users.at(-1)!;
  s=executeDemo(s,{type:'SAVE_DEMO_USER',userId:u.id,expectedVersion:u.version,user:{...u,role:'OWNER',active:false}},'edit','ADMIN');
  expect(s.users.at(-1)).toMatchObject({id:u.id,role:'OWNER',active:false,email:'new@example.test',version:2});expect(s.events.at(-1)?.actor).toBe('ADMIN');
  expect(()=>executeDemo(s,{type:'SAVE_CUSTOMER',customer},'not-authenticated-by-directory','VIEWER')).toThrow('Forbidden');
 });
 it('rejects stale customer/user versions with no partial audit changes',()=>{
  const s=createDemoSeed(),c=s.customers[0],u=s.users[0];
  expect(()=>executeDemo(s,{type:'SAVE_CUSTOMER',customerId:c.id,expectedVersion:0,customer:c},'stale-c','OWNER')).toThrow('changed');
  expect(()=>executeDemo(s,{type:'SAVE_DEMO_USER',userId:u.id,expectedVersion:0,user:u},'stale-u','ADMIN')).toThrow('changed');
  expect(s.operations['stale-c']).toBeUndefined();expect(s.operations['stale-u']).toBeUndefined();
 });
 it.each(['duplicate-customer','duplicate-user','empty-name','invalid-email','invalid-role','invalid-active'] as const)('rejects %s atomically',kind=>{
  const s=createDemoSeed(),before=structuredClone(s);let action:DemoAction={type:'SAVE_CUSTOMER',customer};
  if(kind==='duplicate-customer')action={type:'SAVE_CUSTOMER',customer:{...customer,name:'  SANTOS FAMILY '}};
  if(kind==='duplicate-user')action={type:'SAVE_DEMO_USER',user:{...user,email:'OWNER@EXAMPLE.TEST'}};
  if(kind==='empty-name')action={type:'SAVE_CUSTOMER',customer:{...customer,name:' '}};
  if(kind==='invalid-email')action={type:'SAVE_CUSTOMER',customer:{...customer,email:'bad'}};
  if(kind==='invalid-role')action={type:'SAVE_DEMO_USER',user:{...user,role:'SUPERUSER' as Role}};
  if(kind==='invalid-active')action={type:'SAVE_DEMO_USER',user:{...user,active:'yes' as unknown as boolean}};
  expect(()=>executeDemo(s,action,'invalid','OWNER')).toThrow();expect(s).toEqual(before);
 });
 it('replays identical saves once, rejects key reuse and checks permission before replay',()=>{
  const s=createDemoSeed(),action:DemoAction={type:'SAVE_CUSTOMER',customer};const next=executeDemo(s,action,'once','OWNER');
  expect(executeDemo(next,action,'once','OWNER')).toBe(next);expect(()=>executeDemo(next,{...action,customer:{...customer,name:'Different'}},'once','OWNER')).toThrow('different payload');
  expect(()=>executeDemo(next,action,'once','VIEWER')).toThrow('Forbidden');
 });
 it('moves any section across metrics, summaries and charts and saves title/size/visibility without changing reports',()=>{
  const s=createDemoSeed(),before=overviewReport(s,'2026-11-15');let config=moveWidget(s.dashboard,'share-previous','charges');
  config={...config,density:'comfortable',widgets:config.widgets.map(w=>w.id==='overdue'?{...w,title:'Payment follow-up',span:12,visible:false}:w)};
  const next=executeDemo(s,{type:'SAVE_DASHBOARD',expectedVersion:1,config},'layout','OWNER');
  expect(next.dashboard.widgets[0].id).toBe('share-previous');expect(next.dashboard.version).toBe(2);expect(next.dashboard.widgets.find(w=>w.id==='overdue')).toMatchObject({title:'Payment follow-up',span:12,visible:false});expect(overviewReport(next,'2026-11-15')).toEqual(before);
  expect(s.dashboard).toEqual(defaultDashboard());
 });
 it('rejects Admin dashboard saves, including replay',()=>{
  const action:DemoAction={type:'SAVE_DASHBOARD',expectedVersion:1,config:defaultDashboard()},s=executeDemo(createDemoSeed(),action,'layout','OWNER');
  expect(()=>executeDemo(s,action,'layout','ADMIN')).toThrow('Forbidden');
 });
 it('rejects stale dashboard saves and leaves the last saved arrangement intact',()=>{
  const action:DemoAction={type:'SAVE_DASHBOARD',expectedVersion:1,config:defaultDashboard()},s=executeDemo(createDemoSeed(),action,'first','OWNER');
  expect(()=>executeDemo(s,action,'stale','OWNER')).toThrow('changed');expect(s.dashboard.version).toBe(2);
 });
 it.each(['duplicate','missing','unknown','width','title','density','visibility'] as const)('rejects malformed %s layout',kind=>{
  const s=createDemoSeed(),config=defaultDashboard();
  if(kind==='duplicate')config.widgets[1].id=config.widgets[0].id;
  if(kind==='missing')config.widgets.pop();
  if(kind==='unknown')config.widgets[0].id='unknown' as typeof config.widgets[0]['id'];
  if(kind==='width')config.widgets[0].span=5 as 3;
  if(kind==='title')config.widgets[0].title='x'.repeat(81);
  if(kind==='density')config.density='invalid' as DashboardConfig['density'];
  if(kind==='visibility')config.widgets[0].visible=1 as unknown as boolean;
  expect(()=>executeDemo(s,{type:'SAVE_DASHBOARD',expectedVersion:1,config},'bad','OWNER')).toThrow();expect(s.dashboard).toEqual(defaultDashboard());
 });
 it('ignores external or same-target drag IDs without altering the current layout',()=>{
  const config=defaultDashboard();expect(moveWidget(config,'outside','charges')).toBe(config);expect(moveWidget(config,'charges','outside')).toBe(config);expect(moveWidget(config,'charges','charges')).toBe(config);
 });
});
