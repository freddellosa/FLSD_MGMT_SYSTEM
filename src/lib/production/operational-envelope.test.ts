import {describe, expect, it} from 'vitest';
import {reviewOperationalReplay as review, validateOperationalEnvelope as validate, type OperationalReviewActor, type OperationalReviewReceipt} from './operational-envelope';
const operationId='12345678-1234-4234-8234-123456789abc';
const actor: OperationalReviewActor={authority:'SYNTHETIC',id:'staff-1',role:'BILLING',active:true};
const envelope=()=>({schemaVersion:1,operationId,action:{type:'CREATE_SOA',tripIds:['t2','t1']},expectedVersions:[{kind:'TRIP',id:'t2',version:'9007199254740993'},{kind:'TRIP',id:'t1',version:'1'}]});
const current=[{kind:'TRIP' as const,id:'t1',version:'1'},{kind:'TRIP' as const,id:'t2',version:'9007199254740993'}];
function receipt(): OperationalReviewReceipt {
 return {operationId,authority:actor.authority,actorId:actor.id,commandType:'CREATE_SOA',digest:review(envelope(),actor,null,current).digest,result:{entityId:'soa-1',version:'1'}};
}
describe('Disconnected operational envelope and receipt review',()=>{
 it('validates exact large versions while retaining all execution gates',()=>{
  expect(review(envelope(),actor,null,current)).toMatchObject({status:'VALIDATED_REVIEW_ONLY',result:null,executionAuthorized:false,postingEnabled:false});
 });
 it('canonicalizes target ordering without mutating the input',()=>{
  const e=envelope(),before=structuredClone(e),a=review(e,actor,null,current);
  e.action.tripIds.reverse();e.expectedVersions.reverse();
  expect(review(e,actor,null,current).digest).toBe(a.digest);e.action.tripIds.reverse();e.expectedVersions.reverse();expect(e).toEqual(before);
 });
 it('replays an exact committed request before stale current-version rejection',()=>{
  const stored=receipt(),result=review(envelope(),actor,stored,[]);
  expect(result).toMatchObject({status:'REPLAY_REVIEW_ONLY',result:{entityId:'soa-1',version:'1'},executionAuthorized:false});
  result.result!.entityId='changed';expect(stored.result.entityId).toBe('soa-1');
 });
 it.each([{active:false},{role:'OPERATIONS' as const},{role:'VIEWER' as const}])('checks current permission/active state before replay %j',change=>{
  expect(()=>review(envelope(),{...actor,...change},receipt(),current)).toThrow('Forbidden');
 });
 it.each(['actor','authority','payload','type','key'] as const)('rejects a conflicting %s receipt',field=>{
  const r=receipt();if(field==='actor')r.actorId='staff-2';if(field==='authority')r.authority='OTHER';if(field==='payload')r.digest='0'.repeat(64);if(field==='type')r.commandType='FINALIZE_SOA';if(field==='key')r.operationId='12345678-1234-4234-8234-123456789abd';
  expect(()=>review(envelope(),actor,r,current)).toThrow('receipt conflict');
 });
 it('rejects changed expected versions under the same operation key',()=>{
  const e=envelope();e.expectedVersions[0].version='2';expect(()=>review(e,actor,receipt(),current)).toThrow('receipt conflict');
 });
 it('rejects stale targets without a committed receipt',()=>{expect(()=>review(envelope(),actor,null,[])).toThrow('Stale');});
 it.each(['actorId','role','balance','capabilities','postingEnabled'])('rejects nested client %s',field=>{
  expect(()=>validate({...envelope(),action:{...envelope().action,[field]:'forged'}})).toThrow();
  expect(()=>validate({...envelope(),[field]:'forged'})).toThrow();
 });
 it.each(['0','01','1.5','9223372036854775808'])('rejects invalid exact version %s',v=>{
  const e=envelope();e.expectedVersions[0].version=v;expect(()=>validate(e)).toThrow('version');
 });
 it('rejects duplicate, missing and unrelated target coverage',()=>{
  const e=envelope();e.expectedVersions.push(e.expectedVersions[0]);expect(()=>validate(e)).toThrow('Duplicate');
  expect(()=>validate({...envelope(),expectedVersions:[]})).toThrow('coverage');
  const unrelated=envelope();unrelated.expectedVersions[0].id='other';expect(()=>validate(unrelated)).toThrow('coverage');
 });
 it('rejects duplicate selections and bounded-list overflow',()=>{
  expect(()=>validate({...envelope(),action:{type:'CREATE_SOA',tripIds:['t1','t1']}})).toThrow('Unique');
  expect(()=>validate({...envelope(),action:{type:'CREATE_SOA',tripIds:Array(501).fill('t')}})).toThrow('Too many');
 });
 it('rejects unsupported schema, keys, UUID and money commands',()=>{
  expect(()=>validate({...envelope(),schemaVersion:2})).toThrow();
  expect(()=>validate({...envelope(),operationId:'not-uuid'})).toThrow();
  expect(()=>validate({...envelope(),extra:true})).toThrow();
  expect(()=>validate({...envelope(),action:{type:'ALLOCATE',paymentId:'p',tripId:'t',amount:1n}})).toThrow('Unsupported');
 });
 it('keeps zero-charge trip input valid but cannot execute it or attach a payment',()=>{
  const e={...envelope(),action:{type:'CREATE_TRIP',trip:{amount:0n}},expectedVersions:[]};
  expect(review(e,actor,null,[]).executionAuthorized).toBe(false);
  expect(()=>validate({...e,action:{...e.action,payment:{amount:1n}}})).toThrow('receipt commands');
 });
 it.each([0.01,-1n,1000000000000000000n])('rejects unsafe amount %s',amount=>{
  expect(()=>validate({...envelope(),action:{type:'CREATE_TRIP',trip:{amount}},expectedVersions:[]})).toThrow();
 });
 it('checks edit embedded version against the explicit target version',()=>{
  const e={...envelope(),action:{type:'EDIT_TRIP',tripId:'t1',expectedVersion:2,edit:{}},expectedVersions:[{kind:'TRIP',id:'t1',version:'1'}]};
  expect(()=>validate(e)).toThrow('Conflicting');
 });
 it('requires exactly one invoice source with its expected version',()=>{
  expect(()=>validate({...envelope(),action:{type:'CREATE_INVOICE',tripId:'t1',soaId:'s1',invoiceDate:'2026-11-17'}})).toThrow('Exactly one');
  expect(()=>validate({...envelope(),action:{type:'CREATE_INVOICE',soaId:'s1',expectedSoaVersion:2,invoiceDate:'2026-11-17'},expectedVersions:[{kind:'SOA',id:'s1',version:'1'}]})).toThrow('Conflicting');
 });
 it('detects duplicate current snapshot targets',()=>{expect(()=>review(envelope(),actor,null,[...current,current[0]])).toThrow('snapshot');});
 it('does not return extra stored result fields',()=>{
  const r=receipt();Object.assign(r.result,{balance:500n});expect(()=>review(envelope(),actor,r,current)).toThrow('receipt conflict');
 });
 it('bounds total text as well as individual fields',()=>{
  const e={...envelope(),action:{type:'CREATE_TRIP',trip:{notes:Array(300).fill('x'.repeat(4000))}},expectedVersions:[]};
  expect(()=>validate(e)).toThrow('text too long');
 });
 it('rejects cyclic and non-plain input without hashing it',()=>{
  const e=envelope() as unknown as Record<string,unknown>;e.action=e;expect(()=>validate(e)).toThrow();
  expect(()=>validate({...envelope(),action:new Date()})).toThrow();
 });
});
