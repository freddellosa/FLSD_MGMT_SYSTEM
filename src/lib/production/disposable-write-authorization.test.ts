import type {PrismaClient} from '@prisma/client';
import {describe,expect,it,vi} from 'vitest';
import {createDisposableWriteAuthorization} from './disposable-write-authorization';

function fixture() {
  const db={$executeRaw:vi.fn(),$queryRaw:vi.fn()};
  const transaction=vi.fn(async (work:(tx:typeof db)=>Promise<unknown>)=>work(db));
  return {db,transaction,client:{$transaction:transaction} as unknown as Pick<PrismaClient,'$transaction'>};
}

describe('Disposable write authorization binding',()=>{
  it('refuses invalid installation identity before opening a transaction',()=>{
    const f=fixture();
    expect(()=>createDisposableWriteAuthorization(f.client,{schemaOid:'0',roleOid:'17228'})).toThrow('installation identity');
    expect(f.transaction).not.toHaveBeenCalled();
  });

  it('does not run rehearsal work if the database identity probe fails',async()=>{
    const f=fixture();
    f.db.$queryRaw.mockResolvedValueOnce([]);
    const work=vi.fn();
    await expect(createDisposableWriteAuthorization(f.client,{schemaOid:'17229',roleOid:'17228'})(work))
      .rejects.toThrow('identity mismatch');
    expect(work).not.toHaveBeenCalled();
    expect(f.db.$queryRaw).toHaveBeenCalledOnce();
  });

  it('rejects cross-authority credentials and locks before sending their queries',async()=>{
    const f=fixture();
    f.db.$queryRaw.mockResolvedValueOnce([{}]);
    await createDisposableWriteAuthorization(f.client,{schemaOid:'17229',roleOid:'17228'})(async tx=>{
      const credential={authority:'other-office',digest:'0'.repeat(64)};
      await expect(tx.locateStaff(credential)).resolves.toBeNull();
      await expect(tx.readSession(credential)).resolves.toBeNull();
      await expect(tx.acquire({authority:credential.authority,id:'customer',kind:'CUSTOMER',mode:'UPDATE'}))
        .rejects.toThrow('Forbidden');
    });
    expect(f.db.$queryRaw).toHaveBeenCalledOnce();
  });
});
