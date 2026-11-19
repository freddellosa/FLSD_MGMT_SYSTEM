import type {PrismaClient} from '@prisma/client';
import {runAuthorizedBatch7Allocation} from './authorized-batch7-allocation';
import {combinedWriteAuthority,createDisposableWriteAuthorization} from './disposable-write-authorization';
import {bindDisposableFinancialRows} from './synthetic-shared-write-postgres';

export function createDisposableCombinedAllocation(
  client:Pick<PrismaClient,'$transaction'>,
  identity:{schemaOid:string;roleOid:string},
){
  const transact=createDisposableWriteAuthorization(client,identity,'combined');
  return (readServerToken:()=>Promise<string|null>,command:Parameters<typeof runAuthorizedBatch7Allocation>[2],
    options:{replayOnly?:boolean}={})=>
    runAuthorizedBatch7Allocation(work=>transact(async (authorization,db)=>{
      let sessionId:string|undefined;
      const finance=bindDisposableFinancialRows(db,'combined',()=>{
        if(!sessionId) throw new Error('Forbidden');
        return sessionId;
      });
      return work({
        ...authorization,...finance,
        effects:options.replayOnly?{
          findReceipt:scope=>finance.effects.findReceipt(scope),
          async appendAllocationAndAudit(){throw new Error('Continuation requires an existing receipt');},
        }:finance.effects,
        async readSession(credential){
          const session=await authorization.readSession(credential);
          sessionId=session?.id;
          return session;
        },
      });
    }),{authority:combinedWriteAuthority,readServerToken},command);
}
