import {describe, expect, it} from 'vitest';
import {emptyDemo, executeDemo, type DemoState, type DemoAction} from '../demo/store';
import {buildProjectionPlan} from '../pilot/entity-projections';
import {reviewOperationalReplay, validateOperationalEnvelope, type ExpectedOperationalVersion, type OperationalReviewActor, type OperationalReviewReceipt} from './operational-envelope';

const key='12345678-1234-4234-8234-123456789abc';
const otherKey='12345678-1234-4234-8234-123456789abd';
const actor: OperationalReviewActor={authority:'SYNTHETIC',id:'staff-1',role:'BILLING',active:true};
function input(amount=100000n, operationId=key) {
 const workspace=emptyDemo();
 return {schemaVersion:1,operationId,expectedVersions:[],action:{type:'CREATE_TRIP',trip:{customerId:'c1',workflow:'DIRECT',amount,charges:{base:amount,fuel:0n,toll:0n,parking:0n,others:0n,othersNote:''},date:'2026-11-17',itinerary:'Synthetic atomicity trip',vehicle:workspace.vehicles[0].label,driver:workspace.drivers[0].label}}};
}

/** Test-local proposed transaction fixture only. It is not an adapter, server or financial ledger.
 * Reuses real domain transitions and projection planner; copy/publish models rollback.
 * Promise serialization below simulates a queue, not PostgreSQL locking/concurrency. */
function fixture(initial:DemoState=emptyDemo()) {
 type State={workspace:DemoState; projection:ReturnType<typeof buildProjectionPlan>|null; receipts:Record<string,OperationalReviewReceipt>; audit:{operationId:string;actorId:string;entityId:string}[]};
 let state:State={workspace:structuredClone(initial),projection:null,receipts:{},audit:[]};
 let currentActor={...actor}, failStage=0, lostResponse=false, tail=Promise.resolve();
 const run=async(inputValue:unknown)=>{
  const captured=validateOperationalEnvelope(inputValue);
  let release!:()=>void;const previous=tail;tail=new Promise<void>(resolve=>{release=resolve;});await previous;
  try {
   const next=structuredClone(state), verifiedFixtureActor={...currentActor};
   const versions:ExpectedOperationalVersion[]=[...next.workspace.trips.map(t=>({kind:'TRIP' as const,id:t.id,version:String(t.version??1)})),...next.workspace.documents.filter(d=>d.type==='SOA').map(d=>({kind:'SOA' as const,id:d.id,version:String(d.version)}))];
   const reviewed=reviewOperationalReplay(captured,verifiedFixtureActor,next.receipts[captured.operationId]??null,versions);
   if(reviewed.status==='REPLAY_REVIEW_ONLY')return {...reviewed,replayed:true};
   let stage=0;const checkpoint=()=>{if(++stage===failStage)throw new Error('Synthetic failure at stage '+stage);};
   next.workspace=executeDemo(next.workspace,captured.action,captured.operationId,verifiedFixtureActor.role,{allowZeroDailyTrips:true});checkpoint();
   next.projection=buildProjectionPlan(state.workspace,next.workspace);checkpoint();
   const event=next.workspace.events.at(-1)!;
   const entity=next.workspace.trips.find(t=>t.id===event.entityId)??next.workspace.documents.find(d=>d.id===event.entityId)!;
   const result={entityId:entity.id,version:String(entity.version??1)};
   next.receipts[captured.operationId]={operationId:captured.operationId,authority:verifiedFixtureActor.authority,actorId:verifiedFixtureActor.id,commandType:captured.action.type,digest:reviewed.digest,result};checkpoint();
   next.audit.push({operationId:captured.operationId,actorId:verifiedFixtureActor.id,entityId:entity.id});checkpoint();
   // A committed operation must have a single matching audit and history event.
   if(Object.keys(next.receipts).length!==next.audit.length || next.audit.some(a=>next.receipts[a.operationId]?.actorId!==a.actorId || next.receipts[a.operationId]?.result.entityId!==a.entityId))throw new Error('Synthetic atomic receipt/audit mismatch');
   checkpoint();state=next;
   if(lostResponse){lostResponse=false;throw new Error('Synthetic committed response lost');}
   return {status:'SYNTHETIC_COMMIT_ONLY' as const,result:structuredClone(result),replayed:false,executionAuthorized:false as const,postingEnabled:false as const};
  } finally {release();}
 };
 return {run,snapshot:()=>structuredClone(state),setActor:(value:OperationalReviewActor)=>{currentActor={...value};},fail:(stage:number)=>{failStage=stage;},loseNextResponse:()=>{lostResponse=true;}};
}

describe('Synthetic operational transaction failure matrix',()=>{
 it.each([1,2,3,4,5])('rolls back every domain/projection/receipt/audit change at stage %s',async stage=>{
  const f=fixture(),before=f.snapshot();f.fail(stage);
  await expect(f.run(input())).rejects.toThrow('Synthetic failure');expect(f.snapshot()).toEqual(before);
  f.fail(0);const result=await f.run(input());
  expect(result).toMatchObject({replayed:false,executionAuthorized:false,postingEnabled:false});
  const after=f.snapshot();expect(after.workspace.trips).toHaveLength(1);expect(after.audit).toHaveLength(1);expect(Object.keys(after.receipts)).toHaveLength(1);
 });
 it('commits domain history, typed projection, receipt and audit together',async()=>{
  const f=fixture(),result=await f.run(input()),s=f.snapshot();
  expect(s.workspace.events).toHaveLength(1);expect(s.projection!.batches.some(b=>b.table==='pilot_trips')).toBe(true);
  expect(s.audit[0]).toEqual({operationId:key,actorId:actor.id,entityId:result.result!.entityId});
  expect(s.workspace.payments).toEqual([]);expect(s.workspace.allocations).toEqual([]);
 });
 it('reconciles a lost commit response by same-key replay without duplicate history or numbering',async()=>{
  const f=fixture();f.loseNextResponse();await expect(f.run(input())).rejects.toThrow('committed response lost');
  const committed=f.snapshot(),replayed=await f.run(input());
  expect(replayed.replayed).toBe(true);expect(f.snapshot()).toEqual(committed);
  expect(replayed.result).toEqual(committed.receipts[key].result);
 });
 it('rejects changed input after an uncertain commit without overwriting success',async()=>{
  const f=fixture();f.loseNextResponse();await expect(f.run(input())).rejects.toThrow();const before=f.snapshot();
  await expect(f.run(input(200000n))).rejects.toThrow('receipt conflict');expect(f.snapshot()).toEqual(before);
 });
 it('checks active/current permission before uncertain replay',async()=>{
  const f=fixture();await f.run(input());const before=f.snapshot();
  f.setActor({...actor,role:'VIEWER'});await expect(f.run(input())).rejects.toThrow('Forbidden');
  f.setActor({...actor,active:false});await expect(f.run(input())).rejects.toThrow('Forbidden');expect(f.snapshot()).toEqual(before);
 });
 it('does not expose a different actor or authority receipt',async()=>{
  const f=fixture();await f.run(input());const before=f.snapshot();
  f.setActor({...actor,id:'staff-2'});await expect(f.run(input())).rejects.toThrow('receipt conflict');
  f.setActor({...actor,authority:'OTHER'});await expect(f.run(input())).rejects.toThrow('receipt conflict');expect(f.snapshot()).toEqual(before);
 });
 it('serializes duplicate synthetic submissions into one change and one replay',async()=>{
  const f=fixture(),results=await Promise.all([f.run(input()),f.run(input())]);
  expect(results.map(r=>r.replayed)).toEqual([false,true]);expect(f.snapshot().workspace.trips).toHaveLength(1);expect(f.snapshot().audit).toHaveLength(1);
 });
 it('serializes distinct synthetic operations without losing either history',async()=>{
  const f=fixture();await Promise.all([f.run(input()),f.run(input(200000n,otherKey))]);
  const s=f.snapshot();expect(s.workspace.trips).toHaveLength(2);expect(s.audit).toHaveLength(2);expect(s.workspace.trips[0].id).not.toBe(s.workspace.trips[1].id);
 });
 it('retains zero daily activity without creating customer money',async()=>{
  const f=fixture();await f.run(input(0n));const s=f.snapshot();
  expect(s.workspace.trips[0].amount).toBe(0n);expect(s.workspace.payments).toEqual([]);expect(s.workspace.allocations).toEqual([]);expect(s.workspace.refunds).toEqual([]);
 });
 it('leaves state untouched on domain validation rejection',async()=>{
  const f=fixture(),e=input();e.action.trip.customerId='missing';const before=f.snapshot();
  await expect(f.run(e)).rejects.toThrow();expect(f.snapshot()).toEqual(before);
 });
 it('releases the synthetic queue after failure so another operation can succeed',async()=>{
  const f=fixture();f.fail(3);await expect(f.run(input())).rejects.toThrow();f.fail(0);
  await expect(f.run(input(200000n,otherKey))).resolves.toMatchObject({replayed:false});expect(f.snapshot().audit).toHaveLength(1);
 });
 it('returns and exposes only detached copies',async()=>{
  const f=fixture(),result=await f.run(input());result.result!.entityId='tampered';const snapshot=f.snapshot();snapshot.audit.length=0;
  expect(f.snapshot().audit).toHaveLength(1);expect(f.snapshot().receipts[key].result.entityId).not.toBe('tampered');
 });
});

function documentScene(withSoa=false) {
 let state=emptyDemo();
 for(const [index,customerId] of ['c2','c2','c4'].entries()) {
  state=executeDemo(state,{type:'CREATE_TRIP',trip:{customerId,workflow:'CORPORATE',amount:BigInt(index+1)*100000n,date:'2026-11-17',itinerary:'Synthetic membership '+index,vehicle:state.vehicles[0].label,driver:state.drivers[0].label}},'seed-'+index,'BILLING');
 }
 const ids=state.trips.map(t=>t.id);
 if(withSoa)state=executeDemo(state,{type:'CREATE_SOA',tripIds:[ids[0]]},'seed-soa','BILLING');
 const f=fixture(state);let sequence=0;
 const command=(action:DemoAction)=>{
  const s=f.snapshot().workspace,expectedVersions:ExpectedOperationalVersion[]=[];
  const trip=(id:string)=>expectedVersions.push({kind:'TRIP',id,version:String(s.trips.find(t=>t.id===id)!.version??1)});
  const soa=(id:string)=>expectedVersions.push({kind:'SOA',id,version:String(s.documents.find(d=>d.id===id)!.version)});
  if(action.type==='EDIT_TRIP')trip(action.tripId);
  if(action.type==='CREATE_SOA'||action.type==='EDIT_SOA')action.tripIds.forEach(trip);
  if(action.type==='EDIT_SOA'||action.type==='FINALIZE_SOA')soa(action.soaId);
  if(action.type==='CREATE_INVOICE'){if(action.tripId)trip(action.tripId);else soa(action.soaId!);}
  return {schemaVersion:1,operationId:'dddddddd-1234-4234-8234-'+String(++sequence).padStart(12,'0'),action,expectedVersions};
 };
 const edit=(tripId=ids[0]):Extract<DemoAction,{type:'EDIT_TRIP'}>=>{
  const t=f.snapshot().workspace.trips.find(t=>t.id===tripId)!;
  return {type:'EDIT_TRIP',tripId,expectedVersion:t.version??1,edit:{origin:'Synthetic pickup',itinerary:'Synthetic corrected itinerary',vehicle:t.vehicle,driver:t.driver,operationalStatus:'COMPLETED',passengers:'',remarks:'',reason:'Synthetic correction'}};
 };
 return {f,ids,command,edit,soaId:state.documents.find(d=>d.type==='SOA')?.id};
}

describe('Synthetic trip-edit and SOA conflict matrix',()=>{
 it.each([1,2,3,4,5])('rolls back a trip edit and history at stage %s',async stage=>{
  const {f,command,edit}=documentScene(),before=f.snapshot();f.fail(stage);
  await expect(f.run(command(edit()))).rejects.toThrow('Synthetic failure');expect(f.snapshot()).toEqual(before);
 });
 it.each([1,2,3,4,5])('rolls back selected SOA membership at stage %s',async stage=>{
  const {f,ids,command}=documentScene(),before=f.snapshot();f.fail(stage);
  await expect(f.run(command({type:'CREATE_SOA',tripIds:ids.slice(0,2)}))).rejects.toThrow('Synthetic failure');expect(f.snapshot()).toEqual(before);
 });
 it.each([1,2,3,4,5])('rolls back SOA finalization and its receipt at stage %s',async stage=>{
  const {f,command,soaId}=documentScene(true),before=f.snapshot();f.fail(stage);
  await expect(f.run(command({type:'FINALIZE_SOA',soaId:soaId!,expectedVersion:1}))).rejects.toThrow('Synthetic failure');expect(f.snapshot()).toEqual(before);
 });
 it('replays a committed trip edit before its old expected version becomes a stale new request',async()=>{
  const {f,command,edit}=documentScene(),e=command(edit());await f.run(e);const committed=f.snapshot();
  expect((await f.run(e)).replayed).toBe(true);expect(f.snapshot()).toEqual(committed);
  await expect(f.run({...e,operationId:otherKey})).rejects.toThrow('Stale');expect(f.snapshot()).toEqual(committed);
 });
 it('rejects two stale edits rather than losing the first change',async()=>{
  const {f,command,edit}=documentScene(),a=command(edit()),b=command(edit());
  const results=await Promise.allSettled([f.run(a),f.run(b)]);
  expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);expect(f.snapshot().audit).toHaveLength(1);
 });
 it('rejects a cross-customer membership and preserves all state',async()=>{
  const {f,ids,command}=documentScene(),before=f.snapshot();
  await expect(f.run(command({type:'CREATE_SOA',tripIds:[ids[0],ids[2]]}))).rejects.toThrow();expect(f.snapshot()).toEqual(before);
 });
 it('does not reserve the same selected trip in two queued SOAs',async()=>{
  const {f,ids,command}=documentScene(),a=command({type:'CREATE_SOA',tripIds:[ids[0]]}),b=command({type:'CREATE_SOA',tripIds:[ids[0]]});
  const results=await Promise.allSettled([f.run(a),f.run(b)]);expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);
  expect(f.snapshot().workspace.documents).toHaveLength(1);expect(f.snapshot().audit).toHaveLength(1);
 });
 it('allows only one of a membership edit and finalization using the same SOA version',async()=>{
  const {f,ids,command,soaId}=documentScene(true);
  const edit=command({type:'EDIT_SOA',soaId:soaId!,expectedVersion:1,tripIds:ids.slice(0,2)}),final=command({type:'FINALIZE_SOA',soaId:soaId!,expectedVersion:1});
  const results=await Promise.allSettled([f.run(edit),f.run(final)]);expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);
  const soa=f.snapshot().workspace.documents[0];expect(soa).toMatchObject({stage:'DRAFT',version:2,amountSnapshot:300000n});
 });
 it('preserves billed amounts when a replacement attempts a financial trip edit',async()=>{
  const {f,ids,command,edit}=documentScene(true),a=edit(),t=f.snapshot().workspace.trips[0];
  a.replacement={customerId:t.customerId,workflow:t.workflow,amount:200000n,date:t.date,itinerary:t.itinerary,vehicle:t.vehicle,driver:t.driver};
  const before=f.snapshot();await expect(f.run(command(a))).rejects.toThrow('payment/billing history');expect(f.snapshot()).toEqual(before);
  expect(f.snapshot().workspace.documents[0].tripIds).toEqual([ids[0]]);
 });
 it('retains finalized snapshot while allowing a permitted operational-only trip correction',async()=>{
  const {f,command,edit,soaId}=documentScene(true);await f.run(command({type:'FINALIZE_SOA',soaId:soaId!,expectedVersion:1}));
  const documents=f.snapshot().workspace.documents;await f.run(command(edit()));
  expect(f.snapshot().workspace.documents).toEqual(documents);expect(f.snapshot().workspace.trips[0].version).toBe(2);
 });
 it('commits a finalization with lost response once and replays the old expected version',async()=>{
  const {f,command,soaId}=documentScene(true),e=command({type:'FINALIZE_SOA',soaId:soaId!,expectedVersion:1});f.loseNextResponse();
  await expect(f.run(e)).rejects.toThrow('response lost');const committed=f.snapshot();
  expect((await f.run(e)).replayed).toBe(true);expect(f.snapshot()).toEqual(committed);expect(committed.workspace.documents[0].stage).toBe('FINAL');
 });
 it('reserves invoice stock once for competing invoice requests on one final SOA',async()=>{
  const {f,command,soaId}=documentScene(true);await f.run(command({type:'FINALIZE_SOA',soaId:soaId!,expectedVersion:1}));
  const stock=f.snapshot().workspace.invoiceStock.next;
  const make=()=>command({type:'CREATE_INVOICE',soaId:soaId!,expectedSoaVersion:2,invoiceDate:'2026-11-17'});
  const results=await Promise.allSettled([f.run(make()),f.run(make())]);expect(results.map(r=>r.status)).toEqual(['fulfilled','rejected']);
  const s=f.snapshot();expect(s.workspace.invoiceStock.next).toBe(stock+1);expect(s.workspace.documents.filter(d=>d.type==='INVOICE')).toHaveLength(1);
  expect(s.workspace.payments).toEqual([]);expect(s.workspace.allocations).toEqual([]);
 });
});
