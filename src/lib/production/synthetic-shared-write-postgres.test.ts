import {Prisma,type PrismaClient} from '@prisma/client';
import {describe,expect,it,vi} from 'vitest';
import {bindSyntheticSharedWritePostgres} from './synthetic-shared-write-postgres';

const identity={schemaOid:'17101',roleOid:'17102'};

function fixture() {
  const tx={$executeRaw:vi.fn(),$queryRaw:vi.fn()};
  const transaction=vi.fn(async (work:(value:typeof tx)=>Promise<unknown>)=>work(tx));
  const client={$transaction:transaction} as unknown as Pick<PrismaClient,'$transaction'>;
  return {tx,transaction,client};
}

describe('Disposable shared-write PostgreSQL binding',()=>{
  it('refuses invalid OIDs before requesting a transaction',()=>{
    const {client,transaction}=fixture();
    expect(()=>bindSyntheticSharedWritePostgres(client,{...identity,roleOid:'4294967296'})).toThrow('identity');
    expect(transaction).not.toHaveBeenCalled();
  });

  it('refuses the transaction callback after a failed identity probe',async()=>{
    const {tx,client,transaction}=fixture();
    tx.$queryRaw.mockResolvedValue([]);
    const work=vi.fn();
    await expect(bindSyntheticSharedWritePostgres(client,identity)(work)).rejects.toThrow('identity mismatch');
    expect(work).not.toHaveBeenCalled();
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    expect(transaction).toHaveBeenCalledWith(expect.any(Function),expect.objectContaining({isolationLevel:'Serializable'}));
  });

  it('uses a fresh guarded transaction after a known serialization rollback',async()=>{
    const {tx,client,transaction}=fixture();
    tx.$queryRaw.mockResolvedValue([{}]);
    const work=vi.fn().mockRejectedValueOnce(new Prisma.PrismaClientKnownRequestError('rollback',{
      code:'P2010',clientVersion:'test',meta:{code:'40001'},
    })).mockResolvedValueOnce({replayed:true});
    await expect(bindSyntheticSharedWritePostgres(client,identity)(work)).resolves.toMatchObject({replayed:true});
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('propagates an uncertain failure without retry',async()=>{
    const {tx,client,transaction}=fixture();
    tx.$queryRaw.mockResolvedValue([{}]);
    const work=vi.fn().mockRejectedValue(new Error('connection lost'));
    await expect(bindSyntheticSharedWritePostgres(client,identity)(work)).rejects.toThrow('connection lost');
    expect(transaction).toHaveBeenCalledTimes(1);
  });
});
