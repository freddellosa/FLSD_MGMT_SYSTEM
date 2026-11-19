import {createRequire} from 'node:module';
import {describe,it,expect} from 'vitest';
const local=createRequire(import.meta.url);
const {reviewFixture}=local('../../../scripts/lib/main-fixture-review.cjs');
const {safeReport}=local('../../../scripts/lib/main-adapter-diagnostics.cjs');
const initialized=()=>({workspace:'1',actors:'1',sessions:'1',operations:'0',audit:'0',history:'0',records:'0',expired_sessions:'0',viewer_actors:'0',billing_actors:'1',orphan_links:'0',revision:'0',history_matches_workspace:false});
describe('Existing connected fixture review',()=>{
 it('identifies the deterministic workspace collision without permitting reuse',()=>{
  expect(reviewFixture(initialized())).toMatchObject({collision:'WORKSPACE_PRIMARY_KEY_1',state:'PRESENT',reuse:'REQUIRES_REVIEW',origin:'NOT_RECORDED'});
 });
 it('retains progressed fixture metadata without requiring an empty database',()=>{
  expect(reviewFixture({...initialized(),operations:'2',audit:'2',history:'2',records:'2',revision:'2',history_matches_workspace:true,expired_sessions:'1',viewer_actors:'1',billing_actors:'0'})).toMatchObject({state:'PRESENT',reuse:'REQUIRES_REVIEW',counts:{expired_sessions:'1',viewer_actors:'1'}});
 });
 it.each([{audit:'1'},{revision:'1'},{orphan_links:'1'},{records:'1'}])('fails closed for inconsistent initial state %j',change=>{
  expect(reviewFixture({...initialized(),...change}).state).toBe('INCONSISTENT');
 });
 it('distinguishes genuinely empty fixture tables',()=>{
  const v=initialized();for(const k of Object.keys(v))if(typeof v[k as keyof typeof v]==='string')(v as Record<string,unknown>)[k]='0';
  expect(reviewFixture({...v,revision:null})).toMatchObject({state:'EMPTY',collision:'NOT_CONFIRMED'});
 });
 it('requires history matching the current workspace for progressed state',()=>{
  expect(reviewFixture({...initialized(),operations:'1',audit:'1',history:'1',revision:'1'}).state).toBe('INCONSISTENT');
 });
 it('rejects arbitrary metadata and strips unknown secret fields',()=>{
  expect(reviewFixture({...initialized(),revision:'PRIVATE'})).toBeNull();
  expect(JSON.stringify(reviewFixture({...initialized(),password:'PRIVATE',payload:'PRIVATE'}))).not.toContain('PRIVATE');
 });
 it('sanitizes metadata again at the output boundary',()=>{
  const marker='FLSD_SAFE_FIXTURE:'+JSON.stringify({...initialized(),password:'PRIVATE'});
  const report=safeReport({exitCode:0,mode:'DIAGNOSTIC_READ_ONLY',stdout:marker});
  expect(report.fixture.collision).toBe('WORKSPACE_PRIMARY_KEY_1');expect(JSON.stringify(report)).not.toContain('PRIVATE');
  expect(safeReport({exitCode:1,mode:'CONNECTED_TESTS',stdout:marker}).fixture).toBeUndefined();
 });
});
