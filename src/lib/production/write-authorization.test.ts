import {describe,expect,it,vi} from 'vitest';
import {runWriteAuthorized,type WriteAuthorizationTransaction} from './write-authorization';
import type {SharedTransactionLock} from './shared-transaction-lock-plan';

function fixture() {
  const session={
    id:'staff-session',actor:{id:'staff-1',authority:'office',active:true,role:'BILLING' as 'BILLING'|'VIEWER'},
    revision:1n,issuedAt:1n,expiresAt:10n,revokedAt:null as bigint|null,checkedAt:2n,
  };
  const locks:SharedTransactionLock['kind'][]=[];
  const tx={
    locateStaff:vi.fn<WriteAuthorizationTransaction['locateStaff']>().mockResolvedValue('staff-1'),
    acquire:vi.fn(async (lock:SharedTransactionLock)=>{locks.push(lock.kind);}),
    readSession:vi.fn(async()=>structuredClone(session)),
  };
  const discovery={authority:'office',actorId:'staff-1',operationKey:'allocation-1',dependencyDigest:'a'.repeat(64),
    resources:{CUSTOMER:['customer-1'],PAYMENT:['payment-1']}};
  let staged=false,committed=false;
  const apply=vi.fn(async()=>{staged=true;return 'result';});
  const work={discover:vi.fn(async()=>discovery),revalidate:vi.fn(async()=>({allowed:true,discovery,apply}))};
  const transact=vi.fn(async (run:(value:typeof tx)=>Promise<string>)=>{
    try {
      const result=await run(tx);
      committed=staged;
      return result;
    } finally {
      staged=false;
    }
  });
  const input={authority:'office',operationKey:'allocation-1',intent:{kind:'ALLOCATION' as const},
    readServerToken:vi.fn(async()=>'1'.repeat(64))};
  return {tx,session,work,locks,discovery,transact,input,apply,committed:()=>committed,
    run:()=>runWriteAuthorized(transact,input,work)};
}

describe('Write transaction authorization contract',()=>{
  it('uses a digest and acquires staff before discovery, then operation and resources',async()=>{
    const f=fixture();
    f.work.discover.mockImplementationOnce(async()=>{
      expect(f.locks).toEqual(['STAFF_AUTHORIZATION']);
      return f.discovery;
    });
    await expect(f.run()).resolves.toBe('result');
    expect(f.locks).toEqual(['STAFF_AUTHORIZATION','OPERATION','CUSTOMER','PAYMENT']);
    expect(f.tx.locateStaff).toHaveBeenCalledWith({authority:'office',digest:expect.stringMatching(/^[a-f0-9]{64}$/)});
    expect(f.tx.locateStaff.mock.calls[0][0].digest).not.toBe('1'.repeat(64));
    expect(f.tx.readSession).toHaveBeenCalledTimes(3);
    expect(f.committed()).toBe(true);
  });

  it('rejects malformed credentials before entering the transaction',async()=>{
    const f=fixture();
    f.input.readServerToken.mockResolvedValueOnce('invalid');
    await expect(f.run()).rejects.toThrow('Forbidden');
    expect(f.transact).not.toHaveBeenCalled();
  });

  it.each(['revocation','role change','expiry'] as const)('denies after %s during a lock wait',async change=>{
    const f=fixture();
    let resume!:()=>void, reached!:()=>void;
    const wait=new Promise<void>(resolve=>{resume=resolve;});
    const waiting=new Promise<void>(resolve=>{reached=resolve;});
    f.tx.acquire.mockImplementation(async lock=>{
      if(lock.kind===(change==='expiry'?'PAYMENT':'STAFF_AUTHORIZATION')){
        reached();
        await wait;
      }
    });
    const pending=f.run();
    await waiting;
    if(change==='revocation') f.session.revokedAt=2n;
    if(change==='role change') f.session.actor.role='VIEWER';
    if(change==='expiry') f.session.checkedAt=f.session.expiresAt;
    resume();
    await expect(pending).rejects.toThrow('Forbidden');
    expect(f.apply).not.toHaveBeenCalled();
    if(change!=='expiry') expect(f.work.discover).not.toHaveBeenCalled();
  });

  it('rolls back staged effects when the credential expires before completion',async()=>{
    const f=fixture();
    f.tx.readSession.mockResolvedValueOnce(structuredClone(f.session)).mockResolvedValueOnce(structuredClone(f.session))
      .mockResolvedValueOnce({...f.session,checkedAt:10n});
    await expect(f.run()).rejects.toThrow('Forbidden');
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.committed()).toBe(false);
  });

  it('denies a replay when current result scope is inaccessible',async()=>{
    const f=fixture();
    f.work.revalidate.mockResolvedValueOnce({allowed:false,discovery:f.discovery,apply:f.apply});
    await expect(f.run()).rejects.toThrow('Forbidden');
    expect(f.apply).not.toHaveBeenCalled();
  });

  it('withholds the result when the transaction owner cannot confirm commit',async()=>{
    const f=fixture();
    f.transact.mockImplementationOnce(async run=>{
      await run(f.tx);
      throw new Error('Commit outcome unknown');
    });
    await expect(f.run()).rejects.toThrow('Commit outcome unknown');
    expect(f.apply).toHaveBeenCalledOnce();
    expect(f.transact).toHaveBeenCalledOnce();
  });

  it('refuses an expanded lock plan before applying or returning replay',async()=>{
    const f=fixture();
    f.work.revalidate.mockResolvedValueOnce({allowed:true,apply:f.apply,
      discovery:{...f.discovery,resources:{...f.discovery.resources,CUSTOMER:['customer-1','customer-2']}}});
    await expect(f.run()).rejects.toThrow('dependencies changed');
    expect(f.apply).not.toHaveBeenCalled();
  });
});
