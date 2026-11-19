import {createHash} from 'node:crypto';
import {describe,expect,it,vi} from 'vitest';
import {
  assertSharedTransactionDiscoveryUnchanged,
  assertSharedTransactionLockAcquisition,
  buildSharedTransactionLockPlan,
  type SharedTransactionDiscovery,
  type SharedTransactionLock,
} from './shared-transaction-lock-plan';

const evidence=(value:string)=>createHash('sha256').update(value).digest('hex');
const discovery=(resources:SharedTransactionDiscovery['resources'], evidenceText='initial dependencies',operationKey='command-1'):SharedTransactionDiscovery=>({
  authority:'office-a',actorId:'billing-1',operationKey,dependencyDigest:evidence(evidenceText),resources,
});

/** Exercises assertions against an injected acquisition trace, without modeling PostgreSQL locking. */
function attempt(initial:SharedTransactionDiscovery, rediscover:()=>SharedTransactionDiscovery) {
  const plan=buildSharedTransactionLockPlan(initial);
  const acquired:SharedTransactionLock[]=[];
  const apply=vi.fn();
  return {
    acquired, apply,
    run() {
      for(const lock of plan.locks) acquired.push(lock);
      assertSharedTransactionLockAcquisition(plan,acquired);
      assertSharedTransactionDiscoveryUnchanged(plan,rediscover());
      apply();
    },
  };
}

describe('Shared operational and Batch 7 lock planning',()=>{
  it('uses the full ranked order, merges duplicate IDs, and sorts bytewise within a class',()=>{
    const plan=buildSharedTransactionLockPlan(discovery({
      INVOICE_STOCK:['stock'], SOA:['soa'], VEHICLE:['vehicle'], CUSTOMER:['a','A','a'], DRIVER:['driver'],
      PAYMENT:['pay'], INVOICE:['invoice'], TRIP_RECEIVABLE:['recv'], TRIP:['trip'], REMITTANCE:['custody'],
      REFUND:['refund'], BUSINESS_COUNTER:['counter'],
    }));
    expect(plan.locks.map(({kind,id})=>[kind,id])).toEqual([
      ['STAFF_AUTHORIZATION','billing-1'],['OPERATION','command-1'],['CUSTOMER','A'],['CUSTOMER','a'],
      ['VEHICLE','vehicle'],['DRIVER','driver'],['PAYMENT','pay'],['TRIP','trip'],['TRIP_RECEIVABLE','recv'],
      ['SOA','soa'],['INVOICE','invoice'],['REFUND','refund'],['REMITTANCE','custody'],
      ['BUSINESS_COUNTER','counter'],['INVOICE_STOCK','stock'],
    ]);
    expect(plan.locks.map(({mode})=>mode)).toEqual(['SHARE','EXCLUSIVE_KEY',...Array(13).fill('UPDATE')]);
  });

  it('uses both removed and proposed SOA member locks and refuses newly discovered members',()=>{
    const start=discovery({CUSTOMER:['c1'],TRIP:['trip-removed','trip-kept','trip-added'],TRIP_RECEIVABLE:['rec-removed','rec-kept','rec-added'],SOA:['s1']},'old, kept, new');
    const fresh=vi.fn(()=>({
      ...start,resources:{...start.resources,TRIP:['trip-kept','trip-added','trip-removed','trip-phantom']},
    }));
    const work=attempt(start,fresh);
    expect(()=>work.run()).toThrow('dependencies changed');
    expect(work.acquired.filter(({kind})=>kind==='TRIP').map(({id})=>id)).toEqual(['trip-added','trip-kept','trip-removed']);
    expect(work.apply).not.toHaveBeenCalled();
    const retry=attempt(fresh(),fresh);
    expect(()=>retry.run()).not.toThrow();
    expect(retry.apply).toHaveBeenCalledOnce();
  });

  it('orders invoice cancellation and allocation identically on the resources they share',()=>{
    const shared={CUSTOMER:['c1'],PAYMENT:['pay1'],TRIP_RECEIVABLE:['recv1'],INVOICE:['inv1']};
    const cancel=buildSharedTransactionLockPlan(discovery({...shared,SOA:['s1'],INVOICE_STOCK:['serial1']},'cancel','cancel-key'));
    const allocation=buildSharedTransactionLockPlan(discovery({...shared,REFUND:['refund1']},'allocate','allocation-key'));
    const overlap=(locks:readonly SharedTransactionLock[])=>locks.filter(lock=>Object.hasOwn(shared,lock.kind));
    expect(overlap(cancel.locks)).toEqual(overlap(allocation.locks));
    expect(overlap(cancel.locks).map(({kind})=>kind)).toEqual(['CUSTOMER','PAYMENT','TRIP_RECEIVABLE','INVOICE']);
  });

  it('uses the same sorted customer and master locks for opposing trip reassignments',()=>{
    const move=discovery({CUSTOMER:['c2','c1'],VEHICLE:['v2','v1'],DRIVER:['d2','d1'],TRIP:['trip-1']},'c2->c1');
    const back=discovery({CUSTOMER:['c1','c2'],VEHICLE:['v1','v2'],DRIVER:['d1','d2'],TRIP:['trip-1']},'c1->c2','command-2');
    const first=buildSharedTransactionLockPlan(move);
    expect(first.locks.slice(2)).toEqual(buildSharedTransactionLockPlan(back).locks.slice(2));
    expect(()=>assertSharedTransactionDiscoveryUnchanged(first,{...back,operationKey:move.operationKey})).toThrow('dependencies changed');
  });

  it('refuses changed authorization evidence even when the physical lock set is unchanged',()=>{
    const start=discovery({CUSTOMER:['c1'],TRIP:['trip-1']},'actor-revision-9:active');
    const work=attempt(start,()=>({...start,dependencyDigest:evidence('actor-revision-10:revoked')}));
    expect(()=>work.run()).toThrow('dependencies changed');
    expect(work.apply).not.toHaveBeenCalled();
  });

  it('uses one operation lock identity for the same authority/key even with a different actor or kind',()=>{
    const first=buildSharedTransactionLockPlan(discovery({CUSTOMER:['c1'],TRIP:['trip-1']}));
    const second=buildSharedTransactionLockPlan({...discovery({CUSTOMER:['c1'],PAYMENT:['pay1']}),actorId:'staff-2'});
    const foreign=buildSharedTransactionLockPlan({...discovery({CUSTOMER:['c1']}),authority:'office-b'});
    expect(first.locks[1]).toEqual(second.locks[1]);
    expect(first.locks[1]).not.toEqual(foreign.locks[1]);
  });

  it('refuses missing, reordered, extra and wrong-authority acquisition evidence',()=>{
    const plan=buildSharedTransactionLockPlan(discovery({CUSTOMER:['c1'],PAYMENT:['p1']}));
    const [staff,operation,customer,payment]=plan.locks;
    for(const trace of [[staff,operation,payment,customer],[staff,operation,customer],[...plan.locks,payment],
      [staff,operation,{...customer,authority:'office-b'},payment]]) {
      expect(()=>assertSharedTransactionLockAcquisition(plan,trace)).toThrow('differ from acquisition plan');
    }
  });

  it('rejects missing or malformed coordination data and snapshots input arrays',()=>{
    expect(()=>buildSharedTransactionLockPlan(discovery({CUSTOMER:[]}))).toThrow('customer coordination');
    expect(()=>buildSharedTransactionLockPlan(discovery({CUSTOMER:['c1'],TRIP:['labels are not IDs']}))).toThrow('resource IDs');
    expect(()=>buildSharedTransactionLockPlan({...discovery({CUSTOMER:['c1']}),dependencyDigest:'not-a-sha'})).toThrow('transaction identity');
    const ids=['c1'];
    const original=discovery({CUSTOMER:ids});
    const plan=buildSharedTransactionLockPlan(original);
    ids.push('c2');
    expect(plan.locks.at(-1)?.id).toBe('c1');
    expect(()=>assertSharedTransactionDiscoveryUnchanged(plan,original)).toThrow('dependencies changed');
  });
});
