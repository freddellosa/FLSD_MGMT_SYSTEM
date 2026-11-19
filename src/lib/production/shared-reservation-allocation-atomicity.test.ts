import {describe,expect,it} from 'vitest';
import {runAuthorizedBatch7Allocation} from './authorized-batch7-allocation';
import type {SyntheticLockedAllocationEffects} from './locked-batch7-allocation';
import type {SharedDependencyEvidence} from './shared-transaction-evidence';
import {runSyntheticSharedWrite,type SyntheticSharedWriteTransaction} from './synthetic-shared-write-coordinator';

const authority='flsd-synthetic-shared-write';
const customerId='customer-1';
const paymentId='payment-1';
const tripId='trip-1';
const receivableId='receivable-1';
const stages=['reservation','event','projections','receipt','audit','before commit'] as const;
type Stage=typeof stages[number];
type Command=Parameters<typeof runSyntheticSharedWrite>[1];
type Receipt=NonNullable<Awaited<ReturnType<SyntheticLockedAllocationEffects['findReceipt']>>>;
type Link={invoiceId:string;receivableId:string;operationId:string};
type State={
  revision:bigint;
  allocated:bigint;
  outstanding:bigint;
  reservation:Link|null;
  events:(Link & {paymentId:string;cashCentavos:bigint})[];
  receipts:Map<string,Receipt>;
  audit:(Link & {actorId:string;key:string})[];
};
const command=(key='allocation-1',invoiceId='invoice-1',cashCentavos=6001n):Command=>({
  paymentId,customerId,idempotencyKey:key,reason:'Synthetic receipt allocation',
  allocations:[{invoiceId,cashCentavos,withheldCentavos:0n}],
});

/** Clone/publish fixture. Shared domain and binding code run unchanged; PostgreSQL is absent. */
function fixture() {
  let state:State={revision:1n,allocated:1000n,outstanding:7000n,reservation:null,events:[],receipts:new Map(),audit:[]};
  let queue=Promise.resolve();
  const snapshot=()=>structuredClone(state);

  async function run(input:Command, options:{fail?:Stage;loseResponse?:boolean;changeDiscovery?:boolean;failLock?:boolean;
    authorization?:'valid'|'revokedAtLock'|'expiresAfterEffects';hideReceipt?:boolean;staffId?:string}={}) {
    const request=structuredClone(input);
    const before=queue;
    let release!:()=>void;
    queue=new Promise<void>(resolve=>{release=resolve;});
    await before;
    try {
      const draft=snapshot();
      const invoiceId=request.allocations[0].invoiceId;
      const saved=draft.receipts.get(request.idempotencyKey)??null;
      const revision=draft.revision.toString();
      const resource=<K extends SharedDependencyEvidence['resources'][number]['kind']>(kind:K,id:string,value='ACTIVE')=>
        ({kind,id,customerId,revision,state:value});
      const evidence:SharedDependencyEvidence={
        authority,operationKey:request.idempotencyKey,
        actor:{id:options.staffId??'billing-1',role:'BILLING',active:true,authorizationRevision:'1'},
        session:{id:options.staffId?'session-'+options.staffId:'session-1',expiresAt:'2026-11-19T11:00:00.000000Z',revokedAt:null},
        resources:[
          resource('CUSTOMER',customerId),resource('TRIP',tripId),resource('REFUND','refund-1'),
          {...resource('PAYMENT',paymentId,'RECORDED'),amounts:[
            {name:'received',centavos:10001n},{name:'allocated',centavos:draft.allocated},
            {name:'completedRefunds',centavos:500n},{name:'reservedRefunds',centavos:2500n},
          ]},
          {...resource('TRIP_RECEIVABLE',receivableId),eligible:true,amounts:[{name:'outstanding',centavos:draft.outstanding}]},
          ...[...new Set([invoiceId,...(draft.reservation?[draft.reservation.invoiceId]:[])])]
            .map(id=>({...resource('INVOICE',id,'PRINTED'),eligible:true})),
        ],
        relationships:[
          {role:'PAYMENT_REFUND',from:{kind:'PAYMENT',id:paymentId},to:{kind:'REFUND',id:'refund-1'}},
          {role:'INVOICE_RECEIVABLE',from:{kind:'INVOICE',id:invoiceId},to:{kind:'TRIP_RECEIVABLE',id:receivableId}},
          {role:'RECEIVABLE_TRIP',from:{kind:'TRIP_RECEIVABLE',id:receivableId},to:{kind:'TRIP',id:tripId}},
          ...(draft.reservation?[{role:'ACTIVE_INVOICE_RESERVATION',from:{kind:'TRIP_RECEIVABLE' as const,id:receivableId},
            to:{kind:'INVOICE' as const,id:draft.reservation.invoiceId}}]:[]),
        ],
        absences:draft.reservation?[]:[{predicate:'ACTIVE_INVOICE_RESERVATION',
          subject:{kind:'TRIP_RECEIVABLE',id:receivableId},parent:{kind:'CUSTOMER',id:customerId},parentRevision:revision}],
        receipt:saved?{actorId:saved.actorId,kind:saved.kind,requestDigest:saved.requestDigest,result:{kind:'PAYMENT',id:paymentId}}:null,
      };
      const observed=options.changeDiscovery?{
        ...evidence,actor:{...evidence.actor,authorizationRevision:'2'},
      }:evidence;
      const checkpoint=(stage:Stage)=>{
        if(options.fail===stage)throw new Error('Synthetic failure after '+stage);
      };
      const discovery:Awaited<ReturnType<SyntheticSharedWriteTransaction['discover']>>={
        evidence,
        payment:{authority,id:paymentId,customerId,state:'RECORDED',allocationScope:'CUSTOMER',refundIds:['refund-1'],
          receivedCentavos:10001n,allocationsCentavos:draft.allocated,completedRefundsCentavos:500n,pendingRefundsCentavos:2500n},
        invoices:[{authority,id:invoiceId,customerId,eligible:true,receivableIds:[receivableId]}],
        receivables:[{authority,id:receivableId,customerId,tripId,eligible:true,outstandingCentavos:draft.outstanding}],
      };
      let discoveries=0;
      const transaction:SyntheticSharedWriteTransaction={
        discover:async()=>({...discovery,evidence:discoveries++===0?evidence:observed}),
        acquire:async lock=>{
          if(options.failLock && lock.kind==='CUSTOMER') throw new Error('Synthetic lock failed');
        },
        effects:{
          findReceipt:async scope=>{
            const receipt=draft.receipts.get(scope.key);
            return receipt&&options.hideReceipt?{...receipt,resultVisible:false}:receipt??null;
          },
          appendAllocationAndAudit:async value=>{
            const operationId='finance-'+request.idempotencyKey;
            const [attribution]=value.attributions;
            if(value.attributions.length!==1||attribution.invoiceId!==invoiceId||attribution.receivableId!==receivableId) {
              throw new Error('Synthetic attribution mismatch');
            }
            if(draft.reservation && draft.reservation.invoiceId!==invoiceId) throw new Error('Receivable reserved by another invoice');
            const link={...attribution,operationId};
            draft.reservation??=link;
            checkpoint('reservation');
            draft.events.push({...link,paymentId,cashCentavos:value.totalCashCentavos});
            checkpoint('event');
            draft.allocated+=value.totalCashCentavos;
            draft.outstanding-=value.totalCashCentavos;
            draft.revision++;
            checkpoint('projections');
            if(draft.receipts.has(request.idempotencyKey)) throw new Error('Synthetic operation key already committed');
            draft.receipts.set(request.idempotencyKey,{
              authority:value.authority,key:request.idempotencyKey,actorId:value.command.actor.id,customerId,paymentId,
              kind:'ALLOCATE_PAYMENT',requestDigest:value.payloadDigest,resultVisible:true,operationId,allocatedCashCentavos:value.totalCashCentavos,
            });
            checkpoint('receipt');
            draft.audit.push({...link,actorId:value.command.actor.id,key:request.idempotencyKey});
            checkpoint('audit');
            return operationId;
          },
        },
      };
      const commit=(result:Awaited<ReturnType<typeof runSyntheticSharedWrite>>)=>{
        if (!result.replayed) {
          checkpoint('before commit');
          state=draft;
        }
        return result;
      };
      let sessionReads=0;
      const result=options.authorization
        ?await runAuthorizedBatch7Allocation(async work=>commit(await work({
          ...transaction,
          locateStaff:async()=>evidence.actor.id,
          readSession:async()=>{
            sessionReads++;
            return {
              id:evidence.session.id,actor:{...evidence.actor,authority},revision:1n,issuedAt:1n,expiresAt:10n,
              checkedAt:options.authorization==='expiresAfterEffects'&&sessionReads===3?10n:2n,
              revokedAt:options.authorization==='revokedAtLock'?2n:null,
            };
          },
        })),{authority,readServerToken:async()=>(options.staffId?'b':'a').repeat(64)},request)
        :await runSyntheticSharedWrite(async work=>commit(await work(transaction)),request);
      if(options.loseResponse)throw new Error('Synthetic response lost after commit');
      return result;
    } finally {release();}
  }
  return {run,snapshot};
}

describe('Shared reservation and Batch 7 commit boundary',()=>{
  it('serializes two staff allocations against the same reserved payment credit',async()=>{
    const store=fixture();
    const primary=command('primary','invoice-1',4000n);
    const competing=command('competing','invoice-1',2002n);
    const [first,second]=await Promise.allSettled([
      store.run(primary,{authorization:'valid'}),
      store.run(competing,{authorization:'valid',staffId:'billing-2'}),
    ]);
    expect(first).toMatchObject({status:'fulfilled',value:{allocatedCashCentavos:4000n,replayed:false}});
    expect(second).toMatchObject({status:'rejected',reason:expect.objectContaining({message:'Payment cash overallocated'})});
    const after=store.snapshot();
    expect(after.allocated).toBe(5000n);
    expect(after.outstanding).toBe(3000n);
    expect(after.events).toHaveLength(1);
    expect(after.receipts.size).toBe(1);
    expect(after.audit).toMatchObject([{actorId:'billing-1',key:'primary'}]);
    await expect(store.run(primary,{authorization:'valid',staffId:'billing-2'})).rejects.toThrow('Forbidden');
    expect(store.snapshot()).toEqual(after);
  });

  it('commits and replays a staff-authorized allocation exactly once',async()=>{
    const store=fixture();
    const first=await store.run(command(),{authorization:'valid'});
    const after=store.snapshot();
    await expect(store.run(command(),{authorization:'valid'})).resolves.toMatchObject({operationId:first.operationId,replayed:true});
    expect(after.events).toHaveLength(1);
    expect(store.snapshot()).toEqual(after);
  });

  it('rolls back all staged financial effects if authorization expires before commit',async()=>{
    const store=fixture(),before=store.snapshot();
    await expect(store.run(command(),{authorization:'expiresAfterEffects'})).rejects.toThrow('Forbidden');
    expect(store.snapshot()).toEqual(before);
  });

  it('withholds committed replay after revocation or loss of result visibility',async()=>{
    const store=fixture();
    await store.run(command(),{authorization:'valid'});
    const before=store.snapshot();
    await expect(store.run(command(),{authorization:'revokedAtLock'})).rejects.toThrow('Forbidden');
    await expect(store.run(command(),{authorization:'valid',hideReceipt:true})).rejects.toThrow('Forbidden');
    expect(store.snapshot()).toEqual(before);
  });
  it.each(stages)('rolls back the entire staged transaction after %s and permits a fresh retry',async stage=>{
    const store=fixture(),before=store.snapshot();
    await expect(store.run(command(),{fail:stage})).rejects.toThrow('Synthetic failure after '+stage);
    expect(store.snapshot()).toEqual(before);
    await expect(store.run(command())).resolves.toMatchObject({replayed:false});
    expect(store.snapshot().receipts.size).toBe(1);
  });

  it('commits one reservation, event, exact projection, scoped receipt and audit together',async()=>{
    const store=fixture(),result=await store.run(command()),after=store.snapshot();
    const link={invoiceId:'invoice-1',receivableId,operationId:result.operationId};
    expect(after.reservation).toEqual(link);
    expect(after.events).toEqual([{...link,paymentId,cashCentavos:6001n}]);
    expect(after.audit).toEqual([{...link,actorId:'billing-1',key:'allocation-1'}]);
    expect(after.receipts.get('allocation-1')).toMatchObject({authority,paymentId,operationId:result.operationId,allocatedCashCentavos:6001n});
    expect([after.allocated,after.outstanding,after.revision]).toEqual([7001n,999n,2n]);
  });

  it('replays a lost response without another reservation or allocation',async()=>{
    const store=fixture();
    await expect(store.run(command(),{loseResponse:true})).rejects.toThrow('response lost after commit');
    const committed=store.snapshot();
    await expect(store.run(command())).resolves.toMatchObject({replayed:true,allocatedCashCentavos:6001n});
    expect(store.snapshot()).toEqual(committed);
    await expect(store.run(command('allocation-1','invoice-1',6000n))).rejects.toThrow('receipt scope or digest mismatch');
    expect(store.snapshot()).toEqual(committed);
  });

  it('does not publish any effects when authorized dependencies change before application',async()=>{
    const store=fixture(),before=store.snapshot();
    await expect(store.run(command(),{changeDiscovery:true})).rejects.toThrow('dependencies changed');
    expect(store.snapshot()).toEqual(before);
  });

  it('stops before effects when an ordered lock fails',async()=>{
    const store=fixture(),before=store.snapshot();
    await expect(store.run(command(),{failLock:true})).rejects.toThrow('Synthetic lock failed');
    expect(store.snapshot()).toEqual(before);
  });

  it('refuses commands outside the one-invoice rehearsal',async()=>{
    const store=fixture(),before=store.snapshot();
    const input=command();
    await expect(store.run({...input,allocations:[...input.allocations,...input.allocations]}))
      .rejects.toThrow('requires one invoice');
    expect(store.snapshot()).toEqual(before);
  });

  it('serializes duplicate submissions in the fixture and produces a single commit',async()=>{
    const store=fixture(),results=await Promise.all([store.run(command()),store.run(command())]);
    expect(results.map(result=>result.replayed)).toEqual([false,true]);
    expect(store.snapshot().events).toHaveLength(1);
  });

  it('rejects a competing invoice reservation atomically even when enough payment credit remains',async()=>{
    const store=fixture();
    await store.run(command('first','invoice-1',2000n));
    const first=store.snapshot();
    await expect(store.run(command('second','invoice-2',2000n),{authorization:'valid'})).rejects.toThrow('Receivable reserved by another invoice');
    expect(store.snapshot()).toEqual(first);
  });
});
