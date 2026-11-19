import type {PrismaClient} from '@prisma/client';
import {describe,expect,it,vi} from 'vitest';
import {createDisposableCombinedAllocation} from './disposable-combined-allocation';

const command={customerId:'customer',paymentId:'payment',idempotencyKey:'operation',reason:'Synthetic review',
  allocations:[{invoiceId:'invoice',cashCentavos:1n,withheldCentavos:0n}]};

describe('Combined disposable allocation binding',()=>{
  it('uses the locked credential session ID for financial discovery in the same transaction',async()=>{
    const session={id:'verified-session',staffId:'staff',role:'BILLING',active:true,revision:1n,
      issuedAt:1n,expiresAt:10n,checkedAt:2n,revokedAt:null};
    const query=vi.fn<(...args:unknown[])=>Promise<unknown>>()
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([{id:session.staffId}])
      .mockResolvedValueOnce([{}])
      .mockResolvedValueOnce([session])
      .mockResolvedValueOnce([{id:session.staffId}])
      .mockResolvedValueOnce([]);
    const db={$executeRaw:vi.fn(),$queryRaw:query};
    const transact=vi.fn(async (work:(db:unknown)=>Promise<unknown>)=>work(db));
    const client={$transaction:transact} as unknown as Pick<PrismaClient,'$transaction'>;
    const run=createDisposableCombinedAllocation(client,{schemaOid:'17600',roleOid:'17599'});
    await expect(run(async()=> 'a'.repeat(64),command)).rejects.toThrow('Synthetic allocation scope unavailable');
    expect(transact).toHaveBeenCalledOnce();
    expect(query.mock.calls[0]).toContain('flsd_combined_write_rehearsal');
    expect(query.mock.calls[4]).toContain(session.id);
    expect(db.$executeRaw).toHaveBeenCalledOnce();
  });
});
