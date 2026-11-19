import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import type {Prisma,PrismaClient} from '@prisma/client';
import {authorizationRehearsalAuthority as authority,createDisposableWriteAuthorization} from '../../src/lib/production/disposable-write-authorization';
import {runWriteAuthorized,type WriteAuthorizationTransaction} from '../../src/lib/production/write-authorization';

type Change='REVOKE'|'DOWNGRADE';
type Fixture={staffId:string;customerId:string;operationKey:string;token:string};
type CommandTransaction=WriteAuthorizationTransaction & {db:Prisma.TransactionClient};
type Control={
  /** Uses an independent, identity-checked connection. Resolves after the change commits. */
  change(fixture:Fixture,change:Change,beforeLock:()=>void,beforeCommit:()=>Promise<void>):Promise<void>;
};

/** The launcher must pin the independent administrator connection and transaction before invoking this port. */
export function createRehearsalControl(
  transact:(work:(db:Prisma.TransactionClient)=>Promise<void>)=>Promise<void>,
):Control {
  return {
    change:({staffId,token},change,beforeLock,beforeCommit)=>transact(async db=>{
      beforeLock();
      const rows=await db.$queryRaw<unknown[]>`
        SELECT 1 FROM flsd_write_auth_rehearsal.staff_authorization
        WHERE authority_id=${authority} AND staff_id=${staffId}::uuid FOR UPDATE`;
      if(rows.length!==1) throw new Error('Disposable staff fence missing');
      if(change==='REVOKE'){
        const digest=createHash('sha256').update(token,'ascii').digest('hex');
        const count=await db.$executeRaw`UPDATE flsd_write_auth_rehearsal.staff_session SET revoked_at=clock_timestamp()
          WHERE authority_id=${authority} AND staff_id=${staffId}::uuid
            AND token_digest=decode(${digest},'hex') AND revoked_at IS NULL`;
        if(count!==1) throw new Error('Disposable session change refused');
      }
      const role=change==='DOWNGRADE'?'VIEWER':'BILLING';
      const count=await db.$executeRaw`UPDATE flsd_write_auth_rehearsal.staff_authorization
        SET revision=revision+1,role=${role}
        WHERE authority_id=${authority} AND staff_id=${staffId}::uuid AND role='BILLING' AND active`;
      if(count!==1) throw new Error('Disposable staff change refused');
      await beforeCommit();
    }),
  };
}

function barrier() {
  let release!:()=>void;
  const promise=new Promise<void>(resolve=>{release=resolve;});
  return {promise,release};
}

/** Called only by a separately guarded launcher with distinct synthetic fixtures per schedule. */
export async function rehearseWriteAuthorization(
  client:Pick<PrismaClient,'$transaction'>,
  identity:{schemaOid:string;roleOid:string},
  control:Control,
  fixtures:{revocation:Fixture;downgrade:Fixture;commandFirst:Fixture},
) {
  const inputs=Object.values(fixtures);
  const uuid=/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
  if(inputs.length!==3 || inputs.some(fixture=>!uuid.test(fixture.staffId)||!uuid.test(fixture.customerId)||
      !/^[a-f0-9]{64}$/.test(fixture.token)||!/^[a-zA-Z0-9][A-Za-z0-9_.:-]{0,151}$/.test(fixture.operationKey)) ||
      (['staffId','customerId','operationKey','token'] as const).some(key=>new Set(inputs.map(fixture=>fixture[key])).size!==3) ||
      inputs.some(fixture=>fixture.operationKey===fixtures.commandFirst.operationKey+'-replay')){
    throw new Error('Invalid disposable rehearsal fixtures');
  }
  const transact=createDisposableWriteAuthorization(client,identity);
  function command(fixture:Fixture,hooks:{beforeStaffLock?:()=>Promise<void>;afterStaffLock?:()=>Promise<void>}={}) {
    const {customerId,operationKey,token}=fixture;
    const digest=createHash('sha256').update(JSON.stringify([authority,fixture.staffId,operationKey,customerId])).digest('hex');
    const wrap=<T>(work:(tx:CommandTransaction)=>Promise<T>)=>
      transact((tx,db)=>work({...tx,db,async acquire(lock){
        if(lock.kind==='STAFF_AUTHORIZATION') await hooks.beforeStaffLock?.();
        await tx.acquire(lock);
        if(lock.kind==='STAFF_AUTHORIZATION') await hooks.afterStaffLock?.();
      }}));
    async function inspect(db:Prisma.TransactionClient,actorId:string) {
      const [customer]=await db.$queryRaw<{revision:bigint}[]>`
        SELECT revision FROM flsd_write_auth_rehearsal.customer WHERE authority_id=${authority} AND id=${customerId}::uuid`;
      const [receipt]=await db.$queryRaw<{actorId:string;customerId:string;digest:string}[]>`
        SELECT staff_id::text "actorId",customer_id::text "customerId",encode(request_digest,'hex') digest
        FROM flsd_write_auth_rehearsal.receipt WHERE authority_id=${authority} AND operation_key=${operationKey}`;
      if (!customer) throw new Error('Forbidden');
      const discovery={authority,actorId,operationKey,resources:{CUSTOMER:[customerId]},
        dependencyDigest:createHash('sha256').update(JSON.stringify([customer.revision.toString(),receipt??null])).digest('hex')};
      return {discovery,receipt,revision:customer.revision};
    }
    return runWriteAuthorized<CommandTransaction,'REPLAYED'|'COMMITTED'>(wrap,
      {authority,operationKey,intent:{kind:'ALLOCATION'},readServerToken:async()=>token},{
      discover:async({db},actor)=>(await inspect(db,actor.id)).discovery,
      revalidate:async({db},actor)=>{
        const {discovery,receipt,revision}=await inspect(db,actor.id);
        return {discovery,allowed:actor.id===fixture.staffId&&(!receipt||
          (receipt.actorId===actor.id&&receipt.customerId===customerId&&receipt.digest===digest)),
        async apply(){
          if(receipt) return 'REPLAYED';
          const count=await db.$executeRaw`UPDATE flsd_write_auth_rehearsal.customer SET revision=revision+1
            WHERE authority_id=${authority} AND id=${customerId}::uuid AND revision=${revision}`;
          if(count!==1) throw new Error('Disposable customer revision changed');
          await db.$executeRaw`INSERT INTO flsd_write_auth_rehearsal.receipt
            (authority_id,operation_key,staff_id,customer_id,request_digest)
            VALUES (${authority},${operationKey},${actor.id}::uuid,${customerId}::uuid,decode(${digest},'hex'))`;
          return 'COMMITTED';
        }};
      },
    });
  }
  for(const [fixture,change] of [[fixtures.revocation,'REVOKE'],[fixtures.downgrade,'DOWNGRADE']] as const){
    const staged=barrier(),allowCommit=barrier(),atStaff=barrier();
    const admin=control.change(fixture,change,()=>{},async()=>{staged.release();await allowCommit.promise;});
    try {
      await Promise.race([staged.promise,admin.then(()=>{throw new Error('Mutation did not stage');})]);
      const denied=assert.rejects(command(fixture,{beforeStaffLock:async()=>{atStaff.release();}}),/^Error: Forbidden$/);
      await Promise.race([atStaff.promise,denied.then(()=>{throw new Error('Command did not reach staff fence');})]);
      allowCommit.release();
      await Promise.all([admin,denied]);
      await transact(async (_tx,db)=>{
        const rows=await db.$queryRaw<{revision:bigint;hasReceipt:boolean}[]>`
          SELECT c.revision,EXISTS (
            SELECT 1 FROM flsd_write_auth_rehearsal.receipt r
            WHERE r.authority_id=c.authority_id AND r.operation_key=${fixture.operationKey}
          ) "hasReceipt" FROM flsd_write_auth_rehearsal.customer c
          WHERE c.authority_id=${authority} AND c.id=${fixture.customerId}::uuid`;
        assert.deepEqual(rows,[{revision:1n,hasReceipt:false}]);
      });
    } finally {
      allowCommit.release();
      await Promise.allSettled([admin]);
    }
  }
  const {commandFirst:fixture}=fixtures;
  const replayFixture={...fixture,operationKey:fixture.operationKey+'-replay'};
  assert.equal(await command(replayFixture),'COMMITTED');
  assert.equal(await command(replayFixture),'REPLAYED');
  const locked=barrier(),allowCommand=barrier(),adminStarted=barrier();
  const first=command(fixture,{afterStaffLock:async()=>{locked.release();await allowCommand.promise;}});
  let admin:Promise<void>|undefined;
  try {
    await Promise.race([locked.promise,first.then(()=>{throw new Error('Command did not lock staff');})]);
    admin=control.change(fixture,'REVOKE',adminStarted.release,async()=>{});
    await Promise.race([adminStarted.promise,admin.then(()=>{throw new Error('Mutation did not reach staff fence');})]);
    allowCommand.release();
    assert.equal(await first,'COMMITTED');
    await admin;
    await assert.rejects(command(fixture),/^Error: Forbidden$/);
  } finally {
    allowCommand.release();
    await Promise.allSettled([first,admin]);
  }
}
