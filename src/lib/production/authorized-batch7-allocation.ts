import {applyLockedBatch7Allocation} from './locked-batch7-allocation';
import {buildSharedDependencyDiscovery} from './shared-transaction-evidence';
import type {SyntheticSharedWriteTransaction} from './synthetic-shared-write-coordinator';
import {runWriteAuthorized,type WriteAuthorizationTransaction} from './write-authorization';

type Command=Parameters<typeof applyLockedBatch7Allocation>[0]['command'];
type Result=Awaited<ReturnType<typeof applyLockedBatch7Allocation>>;
type Transaction=WriteAuthorizationTransaction & Pick<SyntheticSharedWriteTransaction,'discover'|'effects'>;

/** Compose the two contracts against a single transaction. The binding owns database identity and commit. */
export async function runAuthorizedBatch7Allocation(
  transact:(work:(tx:Transaction)=>Promise<Result>)=>Promise<Result>,
  credentials:{authority:string;readServerToken():Promise<string|null>},
  input:Command,
):Promise<Result>{
  const command=structuredClone(input);
  if(command.allocations.length!==1 || command.allocations[0].withheldCentavos!==0n){
    throw new Error('Allocation requires one invoice and zero withholding');
  }
  return runWriteAuthorized<Transaction,Result>(transact,{
    ...credentials,operationKey:command.idempotencyKey,intent:{kind:'ALLOCATION'},
  },{
    async discover(tx){
      return buildSharedDependencyDiscovery((await tx.discover(command)).evidence);
    },
    async revalidate(tx){
      const observed=await tx.discover(command);
      return {
        allowed:true,
        discovery:buildSharedDependencyDiscovery(observed.evidence),
        async apply({plan,acquired,session}){
          const {actor,authority,session:observedSession}=observed.evidence;
          if(authority!==session.actor.authority || actor.id!==session.actor.id ||
              actor.role!==session.actor.role || actor.active!==session.actor.active ||
              actor.authorizationRevision!==session.revision.toString() || observedSession.id!==session.id){
            throw new Error('Forbidden');
          }
          return applyLockedBatch7Allocation({...observed,plan,acquired,command,effects:{
            findReceipt:async scope=>{
              const receipt=await tx.effects.findReceipt(scope);
              if(receipt && (receipt.resultVisible!==true || receipt.actorId!==scope.actorId ||
                  receipt.authority!==scope.authority || receipt.customerId!==scope.customerId ||
                  receipt.paymentId!==scope.paymentId)) throw new Error('Forbidden');
              return receipt;
            },
            appendAllocationAndAudit:value=>tx.effects.appendAllocationAndAudit(value),
          }});
        },
      };
    },
  });
}
