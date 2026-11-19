import {describe,expect,it,vi} from 'vitest';
import {applyLockedBatch7Allocation,type SyntheticLockedAllocationEffects} from './locked-batch7-allocation';
import {buildSharedDependencyDiscovery,type SharedDependencyEvidence} from './shared-transaction-evidence';
import {buildSharedTransactionLockPlan} from './shared-transaction-lock-plan';

type Input = Parameters<typeof applyLockedBatch7Allocation>[0];
const authority='office-a',customerId='customer-1',operationKey='allocation-1';
const ref=<K extends SharedDependencyEvidence['resources'][number]['kind']>(kind:K,id:string)=>({kind,id});
const row=<K extends SharedDependencyEvidence['resources'][number]['kind']>(kind:K,id:string,state='ACTIVE')=>({
  ...ref(kind,id),customerId,revision:'9007199254740993',state,
});

function setup() {
  const evidence:SharedDependencyEvidence={
    authority,operationKey,actor:{id:'billing-1',role:'BILLING',active:true,authorizationRevision:'1'},
    session:{id:'session-1',expiresAt:'2026-11-19T11:00:00.000001Z',revokedAt:null},
    resources:[
      row('CUSTOMER',customerId),row('TRIP','trip-1'),row('REFUND','refund-1'),
      {...row('PAYMENT','payment-1','RECORDED'),amounts:[
        {name:'received',centavos:10001n},{name:'allocated',centavos:1000n},
        {name:'completedRefunds',centavos:500n},{name:'reservedRefunds',centavos:2500n},
      ]},
      {...row('INVOICE','invoice-1','PRINTED'),eligible:true},
      {...row('TRIP_RECEIVABLE','receivable-1'),eligible:true,amounts:[{name:'outstanding',centavos:7000n}]},
    ],
    relationships:[
      {role:'PAYMENT_REFUND',from:ref('PAYMENT','payment-1'),to:ref('REFUND','refund-1')},
      {role:'INVOICE_RECEIVABLE',from:ref('INVOICE','invoice-1'),to:ref('TRIP_RECEIVABLE','receivable-1')},
      {role:'RECEIVABLE_TRIP',from:ref('TRIP_RECEIVABLE','receivable-1'),to:ref('TRIP','trip-1')},
    ],
    absences:[{predicate:'OTHER_ACTIVE_INVOICE',subject:ref('TRIP_RECEIVABLE','receivable-1'),
      parent:ref('CUSTOMER',customerId),parentRevision:'9007199254740993'}],
    receipt:null,
  };
  const command:Input['command']={paymentId:'payment-1',customerId,idempotencyKey:operationKey,reason:'Synthetic allocation',
    allocations:[{invoiceId:'invoice-1',cashCentavos:6001n,withheldCentavos:0n}]};
  const payment:Input['payment']={authority,id:command.paymentId,customerId,state:'RECORDED',allocationScope:'CUSTOMER',refundIds:['refund-1'],
    receivedCentavos:10001n,allocationsCentavos:1000n,completedRefundsCentavos:500n,pendingRefundsCentavos:2500n};
  const invoices:Input['invoices']=[{authority,id:'invoice-1',customerId,eligible:true,receivableIds:['receivable-1']}];
  const receivables:Input['receivables']=[{authority,id:'receivable-1',customerId,tripId:'trip-1',eligible:true,outstandingCentavos:7000n}];
  const effects={
    findReceipt:vi.fn<SyntheticLockedAllocationEffects['findReceipt']>().mockResolvedValue(null),
    appendAllocationAndAudit:vi.fn<SyntheticLockedAllocationEffects['appendAllocationAndAudit']>().mockResolvedValue('batch7-operation-1'),
  };
  const withPlan=(facts:SharedDependencyEvidence)=> {
    const plan=buildSharedTransactionLockPlan(buildSharedDependencyDiscovery(facts));
    return {plan,acquired:plan.locks,evidence:facts};
  };
  const input={...withPlan(evidence),command,payment,invoices,receivables,effects};
  const apply=async (overrides:Partial<Input>={})=>applyLockedBatch7Allocation({...input,...overrides});
  return {evidence,command,payment,invoices,receivables,effects,withPlan,input,apply};
}

describe('Canonical dependency evidence',()=>{
  it('ignores collection order and preserves changes in relationship roles and exact values',()=>{
    const {evidence}=setup();
    const original=buildSharedDependencyDiscovery(evidence).dependencyDigest;
    const permuted={
      ...evidence,resources:[...evidence.resources].reverse().map(row=>({...row,amounts:row.amounts?.slice().reverse()})),
      relationships:[...evidence.relationships].reverse(),
    };
    expect(buildSharedDependencyDiscovery(permuted).dependencyDigest).toBe(original);
    expect(buildSharedDependencyDiscovery({...evidence,relationships:evidence.relationships.map((edge,i)=>i===0?{...edge,role:'PRIOR_REFUND'}:edge)}).dependencyDigest).not.toBe(original);
    const changed=evidence.resources.map(row=>row.kind==='PAYMENT'?{...row,amounts:row.amounts?.map(value=>value.name==='received'?{...value,centavos:10002n}:value)}:row);
    expect(buildSharedDependencyDiscovery({...evidence,resources:changed}).dependencyDigest).not.toBe(original);
  });
  it('refuses duplicate relations, missing coordination and stale absence evidence',()=>{
    const {evidence}=setup();
    expect(()=>buildSharedDependencyDiscovery({...evidence,relationships:[...evidence.relationships,evidence.relationships[0]]})).toThrow('relationship');
    expect(()=>buildSharedDependencyDiscovery({...evidence,resources:evidence.resources.filter(row=>row.kind!=='CUSTOMER')})).toThrow('customer coordination');
    expect(()=>buildSharedDependencyDiscovery({...evidence,absences:[{...evidence.absences[0],parentRevision:'1'}]})).toThrow('absence');
  });
});

describe('Batch 7 over verified, already-locked synthetic rows',()=>{
  it('reuses Batch 7 centavos and writes one operation with explicit receivable attribution',async()=>{
    const {apply,effects}=setup();
    await expect(apply()).resolves.toEqual({operationId:'batch7-operation-1',allocatedCashCentavos:6001n,replayed:false});
    expect(effects.appendAllocationAndAudit).toHaveBeenCalledOnce();
    expect(effects.appendAllocationAndAudit.mock.calls[0][0]).toMatchObject({
      authority,totalCashCentavos:6001n,attributions:[{invoiceId:'invoice-1',receivableId:'receivable-1'}],
      command:{actor:{id:'billing-1',role:'BILLING'}},
    });
  });
  it('refuses missing acquired locks and changed authorization before looking up a receipt',async()=>{
    const {apply,input,effects,evidence,withPlan}=setup();
    await expect(apply({acquired:input.acquired.slice(0,-1)})).rejects.toThrow('locks differ');
    const revoked={...evidence,session:{...evidence.session,revokedAt:'2026-11-19T10:00:00.000001Z'}};
    await expect(apply({evidence:revoked})).rejects.toThrow('dependencies changed');
    await expect(apply(withPlan(revoked))).rejects.toThrow('actor forbidden');
    expect(effects.findReceipt).not.toHaveBeenCalled();
  });
  it('rejects foreign scope, missing attribution and a multi-receivable split',async()=>{
    const {apply,invoices,receivables,effects}=setup();
    await expect(apply({receivables:[{...receivables[0],authority:'foreign-office'}]})).rejects.toThrow('Cross-authority');
    await expect(apply({invoices:[{...invoices[0],receivableIds:[]}]})).rejects.toThrow('exactly one');
    await expect(apply({invoices:[{...invoices[0],receivableIds:['receivable-1','receivable-2']}]})).rejects.toThrow('exactly one');
    expect(effects.appendAllocationAndAudit).not.toHaveBeenCalled();
  });
  it('detects a changed invoice relationship even when the original IDs are still locked',async()=>{
    const {evidence,apply,effects}=setup();
    await expect(apply({evidence:{...evidence,relationships:evidence.relationships.map(edge=>edge.role==='INVOICE_RECEIVABLE'?{...edge,role:'HISTORICAL_ATTRIBUTION'}:edge)}})).rejects.toThrow('dependencies changed');
    expect(effects.findReceipt).not.toHaveBeenCalled();
  });
  it('keeps refund reservations, exact evidenced amounts, and withholding gates in force',async()=>{
    const {apply,command,payment,effects}=setup();
    await expect(apply({command:{...command,allocations:[{...command.allocations[0],cashCentavos:6002n}]}})).rejects.toThrow('cash overallocated');
    await expect(apply({payment:{...payment,pendingRefundsCentavos:0n}})).rejects.toThrow('balance differs');
    await expect(apply({payment:{...payment,refundIds:[]}})).rejects.toThrow('refund scope differs');
    await expect(apply({command:{...command,allocations:[{...command.allocations[0],withheldCentavos:1n}]}})).rejects.toThrow('Withholding');
    await expect(apply({payment:{...payment,allocationScope:'REFUND_ONLY'}})).rejects.toThrow('allocation scope');
    expect(effects.appendAllocationAndAudit).not.toHaveBeenCalled();
  });
  it('returns only a verified matching replay and never appends a second allocation',async()=>{
    const {apply,effects,evidence,withPlan}=setup();
    await apply();
    const requestDigest=effects.appendAllocationAndAudit.mock.calls[0][0].payloadDigest;
    const kind='ALLOCATE_PAYMENT',actorId=evidence.actor.id;
    const scoped={authority,key:operationKey,actorId,customerId,paymentId:'payment-1',kind,requestDigest,
      resultVisible:true,operationId:'batch7-operation-1',allocatedCashCentavos:6001n};
    const bound=withPlan({...evidence,receipt:{kind,actorId,requestDigest,result:ref('PAYMENT','payment-1')}});
    effects.findReceipt.mockResolvedValue(scoped);
    await expect(apply(bound)).resolves.toMatchObject({replayed:true,operationId:'batch7-operation-1'});
    effects.findReceipt.mockResolvedValue({...scoped,resultVisible:false});
    await expect(apply(bound)).rejects.toThrow('receipt scope or digest mismatch');
    expect(effects.appendAllocationAndAudit).toHaveBeenCalledTimes(1);
  });
});
