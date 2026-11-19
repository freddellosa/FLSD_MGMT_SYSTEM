import {describe,expect,it} from 'vitest';
import {acceptCandidateAllocation,type CandidateAllocationAcceptancePort} from './candidate-allocation-acceptance';

const id=(suffix:string)=>'70000000-0000-4000-8000-0000000000'+suffix;
type Facts=Awaited<ReturnType<CandidateAllocationAcceptancePort['inspect']>>;

function fixture(fault?:'replay-write'|'unbound-accepted'|'history-rewritten'|'opening-lost'){
  const state:Facts={
    historySha256:'a'.repeat(64),operationCount:2,eventCount:2,auditCount:1,reservationCount:1,scopeCount:1,
    allocatedCentavos:1001n,receivedCentavos:10001n,pendingRefundCentavos:2500n,completedRefundCentavos:500n,
    payableCentavos:7000n,reservation:{operationId:id('07'),invoiceId:id('05'),receivableId:id('14')},latestEffect:null,
  };
  const unbound=new Error('Unbound key');
  const port:CandidateAllocationAcceptancePort={
    inspect:async()=>structuredClone(state),
    isUnboundKeyRefusal:error=>error===unbound,
    async allocate(command){
      if(command.idempotencyKey==='candidate-bound'){
        if(fault==='replay-write') state.auditCount++;
        return {operationId:id('07'),allocatedCashCentavos:600n,replayed:true};
      }
      if(command.idempotencyKey==='candidate-unbound' && fault!=='unbound-accepted') throw unbound;
      if(state.latestEffect) return {operationId:id('15'),allocatedCashCentavos:2001n,replayed:true};
      state.operationCount++;
      state.eventCount++;
      state.auditCount++;
      state.scopeCount++;
      state.allocatedCentavos=fault==='opening-lost'?2001n:state.allocatedCentavos+2001n;
      if(fault==='history-rewritten') state.historySha256='b'.repeat(64);
      state.latestEffect={operationId:id('15'),cashCentavos:2001n,actorId:id('01'),invoiceId:id('05'),receivableId:id('14')};
      return {operationId:id('15'),allocatedCashCentavos:2001n,replayed:false};
    },
  };
  return port;
}

describe('Upgraded candidate allocation acceptance',()=>{
  it('verifies preservation, new effects and both idempotent replays',async()=>{
    await expect(acceptCandidateAllocation(fixture())).resolves.toEqual({
      status:'BATCH7_CANDIDATE_ALLOCATION_ACCEPTANCE_VERIFIED',operationId:id('15'),
    });
  });

  it.each(['replay-write','unbound-accepted','history-rewritten','opening-lost'] as const)(
    'fails acceptance for %s',async fault=>{
      await expect(acceptCandidateAllocation(fixture(fault))).rejects.toThrow();
    },
  );
});
