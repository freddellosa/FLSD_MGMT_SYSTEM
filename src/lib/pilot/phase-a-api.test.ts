import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe,expect,it,vi} from 'vitest';
import {POST as postUsers} from '../../app/api/pilot/users/route';
import {POST as postWorkspace} from '../../app/api/pilot/workspace/route';
import {emptyDemo,executeDemo,vehicles,drivers,demoTotals,type DemoAction,type DemoState} from '../demo/store';
import {customerPaymentTerm,invoiceDueDate} from '../demo/overview';
import {encodeWire} from './wire';
import {publicWorkspace} from './workspace';
import {buildProjectionPlan} from './entity-projections';
import {unbilledCorporateTrips} from '../demo/billing-register';

const mock=vi.hoisted(()=>({actor:{id:'',role:'ADMIN'},target:undefined as {role:string;version:number}|undefined,
  read:vi.fn(),write:vi.fn(),persist:vi.fn()}));
vi.mock('./auth',()=>({actorIn:async()=>mock.actor}));
vi.mock('./database',()=>({
  assertPilotDatabase:async()=>{},
  pilotDatabase:()=>({$transaction:(work:(db:unknown)=>unknown)=>work({$queryRaw:mock.read,$executeRaw:mock.write})}),
  pilotSerializable:(work:(db:unknown)=>unknown)=>work({$queryRaw:mock.read,$executeRaw:mock.write}),
  retryablePilotError:()=>false,
}));
vi.mock('./projection-repository',()=>({persistProjections:mock.persist}));
vi.mock('./evidence-repository',()=>({hydrateEvidence:async()=>{},storageState:(state:DemoState)=>state}));
const origin='http://127.0.0.1:3001';
const targetId='b93e5f46-eef9-4c6e-a8e9-ed9b8977721d';
function request(path:string,payload:unknown){
  return new Request(origin+path,{method:'POST',headers:{origin,'content-type':'application/json'},body:encodeWire(payload)});
}
function users(payload:Record<string,unknown>){
  return postUsers(request('/api/pilot/users',{operationId:randomUUID(),name:'Disposable QA identity',
    email:'fictional@flsd.test',role:'VIEWER',active:true,...payload}));
}
function fixture(){
  let state=emptyDemo();
  const trip={customerId:'c2',date:'2026-11-18',workflow:'CORPORATE' as const,amount:2000n,vehicle:vehicles[0],driver:drivers[0],itinerary:'QA service',
    schedule:{startDate:'2026-11-18',startTime:'23:00',endDate:'2026-11-19',endTime:'03:00'}};
  function run(action:DemoAction){state=executeDemo(state,action,randomUUID(),'BILLING');return state;}
  run({type:'CREATE_TRIP',trip});
  const tripId=state.trips[0].id;
  run({type:'CREATE_SOA',tripIds:[tripId]});
  const soaId=state.documents[0].id;
  run({type:'FINALIZE_SOA',soaId,expectedVersion:1});
  return {trip,tripId,soaId,run,get state(){return state;}};
}
function workspace(action:DemoAction){
  return postWorkspace(request('/api/pilot/workspace',{operationId:randomUUID(),revision:7,action}));
}
it('refuses Admin creation of an Owner before checking the password',async()=>{
  for(const password of [undefined,'Fictional workspace account']) {
    const result=await users({role:'OWNER',password});
    expect(result.status).toBe(403);
  }
  expect(mock.write).not.toHaveBeenCalled();
});
let state:DemoState;
beforeEach(()=>{
  vi.useFakeTimers({toFake:['Date']});vi.setSystemTime(new Date('2026-11-19T12:00:00Z'));
  mock.actor={id:randomUUID(),role:'ADMIN'};
  mock.target=undefined;
  mock.read.mockReset().mockImplementation(async (parts:TemplateStringsArray)=>{
    const sql=parts.join('?');
    if(sql.includes('FROM pilot_users WHERE id='))return mock.target?[{email:'fictional@flsd.test',active:true,...mock.target}]:[];
    if(sql.includes('FROM pilot_operations'))return [];
    if(sql.includes('FROM pilot_workspace'))return [{id:1,revision:7,state:JSON.parse(encodeWire(state))}];
    return [];
  });
  mock.write.mockReset().mockResolvedValue(1);
  mock.persist.mockReset();
  state=emptyDemo();
});

describe('Phase B workflow regressions',()=>{
  it('D3 releases only a draft SOA, retaining its membership and audit history',async()=>{
    const f=fixture();
    state=f.state;
    const rejected=await workspace({type:'VOID_SOA',soaId:f.soaId,expectedVersion:2,reason:'Fictional correction'});
    expect(rejected.status).toBe(400);
    expect(mock.persist).not.toHaveBeenCalled();
    state=f.run({type:'CREATE_INVOICE',soaId:f.soaId,expectedSoaVersion:2,invoiceDate:'2026-11-19'});
    const invoice=state.documents.at(-1)!;
    state=f.run({type:'CANCEL_INVOICE',invoiceId:invoice.id,expectedVersion:1,
      reason:'Fictional cancellation',confirmedInvoiceNumber:invoice.invoiceNumber});
    const draft=state.documents.find(d=>d.id===f.soaId)!;
    const action={type:'VOID_SOA',soaId:draft.id,expectedVersion:draft.version,reason:'Release fictional trips'} as const;
    expect((await workspace(action)).status).toBe(200);
    const after=f.run(action);
    expect(after.documents.find(d=>d.id===draft.id)).toMatchObject({
      ...draft,stage:'VOIDED',version:draft.version+1,voidReason:action.reason,
    });
    expect(after.events.at(-1)?.action).toBe('VOID_SOA');
    expect(unbilledCorporateTrips(after).map(t=>t.id)).toContain(f.tripId);
    expect(buildProjectionPlan(state,after).memberships).toContainEqual({documentId:draft.id,tripIds:[]});
    expect(after.documents.find(d=>d.id===invoice.id)?.invoiceNumber).toBe(invoice.invoiceNumber);
    expect(after.payments).toEqual(state.payments);
  });
  it('D4 refuses an invalid new TIN and preserves an unchanged legacy entry',async()=>{
    const customer={name:'Fictional customer',email:'',phone:'',contact:'',address:'',tin:'abc'};
    expect((await workspace({type:'SAVE_CUSTOMER',customer})).status).toBe(400);
    const older=structuredClone(state);
    older.customers[0].tin='abc';
    const saved=executeDemo(older,{type:'SAVE_CUSTOMER',customerId:older.customers[0].id,
      expectedVersion:older.customers[0].version,customer:{...customer,name:'Fictional renamed customer'}},'update','ADMIN');
    expect(saved.customers[0].tin).toBe('abc');
  });
  it('D13 and D14 project SOA and service charges for Operations while excluding settlement details',()=>{
    const f=fixture();
    state=f.run({type:'CREATE_INVOICE',soaId:f.soaId,expectedSoaVersion:2,invoiceDate:'2026-11-19'});
    const invoice=state.documents.at(-1)!;
    state=f.run({type:'SETTLE_INVOICE',invoiceId:invoice.id,expectedVersion:1,reference:'Fictional receipt',
      method:'BANK_TRANSFER',allocations:[{tripId:f.tripId,amount:100n,expectedBalance:2000n}]});
    const operations=publicWorkspace(state,{id:randomUUID(),email:'ops@flsd.test',name:'Fictional Operations',role:'OPERATIONS',version:1});
    expect(operations.trips[0].amount).toBe(2000n);
    expect(operations.documents).toEqual([state.documents[0]]);
    expect(operations.invoiceLockedTripIds).toEqual([f.tripId]);
    expect(operations.payments).toEqual([]);
    expect(operations.allocations).toEqual([]);
    expect(operations.events).toEqual([]);
  });
});

it('captures approved billing profile terms on issue and preserves the snapshot after a profile change',async()=>{
  const f=fixture();
  state=f.state;
  const customer=state.customers.find(c=>c.id==='c2')!;
  const save={type:'SAVE_CUSTOMER',customerId:customer.id,expectedVersion:customer.version,
    customer:{...customer,paymentTerm:{days:45,basis:'RECEIVED_DATE'}}} as const;
  mock.actor.role='BILLING';
  expect((await workspace(save)).status).toBe(403);
  const profiled=executeDemo(state,save,'profile','ADMIN');
  const issued=executeDemo(profiled,{type:'CREATE_INVOICE',soaId:f.soaId,expectedSoaVersion:2,
    invoiceDate:'2026-11-19'},'issue','BILLING');
  const invoice=issued.documents.at(-1)!;
  expect(invoice.paymentTerm).toEqual({days:45,basis:'RECEIVED_DATE'});
  expect(invoiceDueDate(invoice,invoice.paymentTerm)).toBeNull();
  const edited=executeDemo(issued,{...save,expectedVersion:customer.version+1,
    customer:{...customer,paymentTerm:{days:30,basis:'INVOICE_DATE'}}},'later-profile','ADMIN');
  expect(edited.documents.at(-1)?.paymentTerm).toEqual(invoice.paymentTerm);
  const acknowledged=executeDemo(edited,{type:'RECORD_INVOICE_RECEIPT',invoiceId:invoice.id,expectedVersion:invoice.version,
    receivedDate:'2026-11-20',reference:''},'received','BILLING');
  expect(invoiceDueDate(acknowledged.documents.at(-1)!,invoice.paymentTerm)).toBe('2027-01-04');
});
afterEach(()=>vi.useRealTimers());

describe('Phase A direct pilot API regressions on an injected transaction',()=>{
  it.each([
    {targetRole:'OWNER',fields:{id:targetId,version:1,role:'OWNER',name:'changed'}},
    {targetRole:'OWNER',fields:{id:targetId,version:1,role:'VIEWER',active:false}},
    {targetRole:'OWNER',fields:{id:targetId,version:1,role:'OWNER',password:'Synthetic only password'}},
    {targetRole:'ADMIN',fields:{id:targetId,version:1,role:'OWNER'}},
    {targetRole:undefined,fields:{role:'OWNER',password:'Synthetic only password'}},
  ])('S1 refuses Admin Owner mutations before any receipt or account write',async ({targetRole,fields})=>{
    mock.target=targetRole===undefined?undefined:{role:targetRole,version:1};
    if(targetRole==='ADMIN')mock.actor.id=targetId;
    const response=await users(fields);
    expect(response.status).toBe(403);
    expect(mock.read.mock.calls.some(([parts])=>parts.join('').includes('FROM pilot_operations'))).toBe(false);
    expect(mock.write.mock.calls.map(([parts])=>parts.join(''))).toEqual(
      fields.role==='OWNER'?[]:[expect.stringContaining('INSERT INTO pilot_workspace')],
    );
  });
  it('S1 still permits an Owner to manage an Owner and Admin to manage Billing',async()=>{
    mock.target={role:'OWNER',version:3};
    mock.actor.role='OWNER';
    expect((await users({id:targetId,version:3,role:'OWNER'})).status).toBe(200);
    mock.target={role:'BILLING',version:3};
    mock.actor.role='ADMIN';
    expect((await users({id:targetId,version:3,role:'BILLING'})).status).toBe(200);
  });
  it('D1 rejects invoice dates before the last service day and preserves due-date rules',async()=>{
    const f=fixture();
    state=f.state;
    const command={type:'CREATE_INVOICE',soaId:f.soaId,expectedSoaVersion:2,invoiceDate:'2026-11-18'} as const;
    const response=await workspace(command);
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/latest trip service date/);
    expect(mock.persist).not.toHaveBeenCalled();
    const invoice=f.run({...command,invoiceDate:'2026-11-19'}).documents.at(-1)!;
    expect(invoiceDueDate(invoice,customerPaymentTerm('c2'))).toBe('2026-12-19');
    expect(invoiceDueDate(invoice,customerPaymentTerm('accenture'))).toBe('2027-01-18');
  });
  it.each([undefined,'OTHER-SERIAL'])('D2 rejects cancellation with missing or wrong confirmation %s',async confirmedInvoiceNumber=>{
    const f=fixture();
    state=f.run({type:'CREATE_INVOICE',soaId:f.soaId,expectedSoaVersion:2,invoiceDate:'2026-11-19'});
    const invoice=state.documents.at(-1)!;
    const response=await workspace({type:'CANCEL_INVOICE',invoiceId:invoice.id,expectedVersion:1,reason:'Fictional correction',confirmedInvoiceNumber});
    expect(response.status).toBe(400);
    expect(mock.persist).not.toHaveBeenCalled();
  });
  it('D11 rejects future settlement and excludes existing future receipts from as-of totals',async()=>{
    const f=fixture();
    state=f.run({type:'CREATE_INVOICE',soaId:f.soaId,expectedSoaVersion:2,invoiceDate:'2026-11-19'});
    const invoice=state.documents.at(-1)!;
    const settlement={type:'SETTLE_INVOICE',invoiceId:invoice.id,expectedVersion:1,
      allocations:[{tripId:f.tripId,amount:100n,expectedBalance:2000n}],method:'CASH',reference:'Fictional evidence'} as const;
    const response=await workspace({...settlement,allocations:[...settlement.allocations],receivedDate:'2026-11-20'});
    expect(response.status).toBe(400);
    expect(mock.persist).not.toHaveBeenCalled();
    const recorded=f.run({...settlement,allocations:[...settlement.allocations],receivedDate:'2026-11-19'});
    const historic=structuredClone(recorded);
    historic.payments[0].receivedDate='2026-11-20';
    expect(demoTotals(historic,'2026-11-19').collections).toBe(0n);
    expect(demoTotals(historic,'2026-11-20').collections).toBe(100n);
    expect(historic.payments[0].receivedDate).toBe('2026-11-20');
  });
  it('D12 rejects direct schedule and replacement edits until the active invoice is cancelled',async()=>{
    const f=fixture();
    state=f.run({type:'CREATE_INVOICE',soaId:f.soaId,expectedSoaVersion:2,invoiceDate:'2026-11-19'});
    const invoice=state.documents.at(-1)!;
    const schedule={...f.trip.schedule,endTime:'04:00'};
    const edit={origin:'',itinerary:'QA service',vehicle:f.trip.vehicle,driver:f.trip.driver,operationalStatus:'COMPLETED',
      passengers:'',remarks:'New note',reason:'Fictional correction'} as const;
    const action={type:'EDIT_TRIP',tripId:f.tripId,expectedVersion:1,edit} as const;
    expect((await workspace({...action,edit:{...edit,schedule}})).status).toBe(400);
    expect((await workspace({...action,replacement:{...f.trip,schedule}})).status).toBe(400);
    expect(mock.persist).not.toHaveBeenCalled();
    expect(executeDemo(state,action,'note-only','BILLING').trips[0].schedule).toEqual(f.trip.schedule);
    f.run({type:'CANCEL_INVOICE',invoiceId:invoice.id,expectedVersion:1,reason:'Fictional correction',confirmedInvoiceNumber:invoice.invoiceNumber});
    expect(f.run({...action,edit:{...edit,schedule}}).trips[0].schedule).toEqual(schedule);
  });
});
