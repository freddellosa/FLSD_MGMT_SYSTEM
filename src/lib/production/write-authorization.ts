import {createHash} from 'node:crypto';
import {requirePermission,roles} from '../security/permissions';
import {assertOperationalReviewPermission,type OperationalReviewActor,type OperationalReviewEnvelope} from './operational-envelope';
import {
  assertSharedTransactionDiscoveryUnchanged,buildSharedTransactionLockPlan,
  type SharedTransactionDiscovery,type SharedTransactionLock,type SharedTransactionLockPlan,
} from './shared-transaction-lock-plan';

type Intent = {kind:'ALLOCATION'} | {kind:'OPERATIONAL'; action:OperationalReviewEnvelope['action']};
type Credential = Readonly<{authority:string;digest:string}>;
type Session = Readonly<{
  id:string;
  actor:OperationalReviewActor;
  revision:bigint;
  issuedAt:bigint;
  expiresAt:bigint;
  revokedAt:bigint|null;
  checkedAt:bigint;
}>;

export interface WriteAuthorizationTransaction {
  locateStaff(credential:Credential):Promise<string|null>;
  acquire(lock:SharedTransactionLock):Promise<void>;
  /** Read the exact credential and sample the database clock in integer microseconds. */
  readSession(credential:Credential):Promise<Session|null>;
}

type BusinessWork<Tx,T> = {
  discover(tx:Tx,actor:Readonly<OperationalReviewActor>):Promise<SharedTransactionDiscovery>;
  /** Re-read scope and dependencies, including current replay-result visibility. */
  revalidate(tx:Tx,actor:Readonly<OperationalReviewActor>):Promise<{
    allowed:boolean;
    discovery:SharedTransactionDiscovery;
    apply(context:{
      plan:SharedTransactionLockPlan;
      acquired:readonly SharedTransactionLock[];
      session:Session;
    }):Promise<T>;
  }>;
};

/** The transaction owner verifies repository identity and returns only after commit. */
export async function runWriteAuthorized<Tx extends WriteAuthorizationTransaction,T>(
  transact:(work:(tx:Tx)=>Promise<T>)=>Promise<T>,
  input:{authority:string;operationKey:string;intent:Intent;readServerToken():Promise<string|null>},
  work:BusinessWork<Tx,T>,
):Promise<T> {
  const {authority,operationKey}=input;
  const intent=structuredClone(input.intent);
  const token=await input.readServerToken();
  if (typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token)) throw new Error('Forbidden');
  const credential=Object.freeze({authority,digest:createHash('sha256').update(token,'ascii').digest('hex')});
  return transact(async tx=>{
    const staffId=await tx.locateStaff(credential);
    if (!staffId) throw new Error('Forbidden');
    const staffLock:SharedTransactionLock={authority,id:staffId,kind:'STAFF_AUTHORIZATION',mode:'SHARE'};
    await tx.acquire(staffLock);

    async function authorize(previous?:Session) {
      const session=await tx.readSession(credential);
      if (!session || session.actor.id!==staffId || session.actor.authority!==authority || session.actor.active!==true ||
          !roles.includes(session.actor.role) || session.revision<=0n || session.revokedAt!==null ||
          session.checkedAt<session.issuedAt || session.checkedAt>=session.expiresAt ||
          (previous && (previous.id!==session.id || previous.revision!==session.revision ||
            previous.actor.role!==session.actor.role || previous.issuedAt!==session.issuedAt ||
            previous.expiresAt!==session.expiresAt))) throw new Error('Forbidden');
      if (intent.kind==='ALLOCATION') requirePermission(session.actor.role,'payment:write');
      else assertOperationalReviewPermission(session.actor,intent.action);
      return {...session,actor:Object.freeze({...session.actor})};
    }

    const initial=await authorize();
    const discovery=await work.discover(tx,initial.actor);
    if (discovery.authority!==authority || discovery.actorId!==staffId || discovery.operationKey!==operationKey) {
      throw new Error('Forbidden');
    }
    const plan=buildSharedTransactionLockPlan(discovery);
    const acquired:SharedTransactionLock[]=[staffLock];
    for (const lock of plan.locks.slice(1)) {
      await tx.acquire(lock);
      acquired.push(lock);
    }

    const current=await authorize(initial);
    const verified=await work.revalidate(tx,current.actor);
    if (verified.allowed!==true) throw new Error('Forbidden');
    assertSharedTransactionDiscoveryUnchanged(plan,verified.discovery);
    const result=await verified.apply({plan,acquired,session:current});
    await authorize(current);
    return result;
  });
}
