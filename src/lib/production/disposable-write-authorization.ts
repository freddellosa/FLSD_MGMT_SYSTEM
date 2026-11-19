import {Prisma,type PrismaClient} from '@prisma/client';
import type {WriteAuthorizationTransaction} from './write-authorization';

export const authorizationRehearsalAuthority='flsd-synthetic-write-auth';
export const combinedWriteAuthority='flsd-synthetic-combined-write';
type Session=NonNullable<Awaited<ReturnType<WriteAuthorizationTransaction['readSession']>>>;
type SessionRow=Omit<Session,'actor'> & {staffId:string;role:Session['actor']['role'];active:boolean};

export function createDisposableWriteAuthorization(
  client:Pick<PrismaClient,'$transaction'>,
  {schemaOid,roleOid}:{schemaOid:string;roleOid:string},
  target:'authorization'|'combined'='authorization',
) {
  const combined=target==='combined';
  const authority=combined?combinedWriteAuthority:authorizationRehearsalAuthority;
  const namespace=combined?'flsd_combined_write_rehearsal':'flsd_write_auth_rehearsal';
  const schema=combined?Prisma.sql`flsd_combined_write_rehearsal`:Prisma.sql`flsd_write_auth_rehearsal`;
  const login=combined?'flsd_combined_write_runner_75435c870a31':'flsd_write_auth_runner_75435c870a31';
  const marker=(combined?'FLSD_SYNTHETIC_COMBINED_WRITE_V1:':'FLSD_SYNTHETIC_WRITE_AUTH_V1:')+'b813e743-9f4c-4121-b8ab-b01ca51b9335';
  if (![schemaOid,roleOid].every(value=>/^[1-9][0-9]{0,9}$/.test(value)&&Number(value)<=4294967295)) {
    throw new Error('Invalid disposable installation identity');
  }
  return async function transact<T>(work:(tx:WriteAuthorizationTransaction,db:Prisma.TransactionClient)=>Promise<T>):Promise<T>{
    for (let attempt=0;;attempt++) {
      try {
        return await client.$transaction(async db=>{
          await db.$executeRaw`SET LOCAL search_path TO pg_catalog`;
          const identity=await db.$queryRaw<unknown[]>`
            SELECT 1 FROM pg_database d JOIN pg_namespace n ON n.nspowner=d.datdba
            JOIN pg_roles r ON r.rolname=current_user
            WHERE d.datname=current_database() AND d.datname='flsd_main_adapter_test' AND d.oid=16394::oid
              AND d.datdba=16392::oid AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=5432
              AND NOT pg_is_in_recovery() AND current_setting('server_version_num')='180007'
              AND current_setting('transaction_isolation')='serializable'
              AND shobj_description(d.oid,'pg_database')='FLSD_DISPOSABLE:b813e743-9f4c-4121-b8ab-b01ca51b9335:flsd_main_adapter_test'
              AND n.nspname=${namespace} AND n.oid=${schemaOid}::oid
              AND obj_description(n.oid,'pg_namespace')=${marker}
              AND current_user=session_user AND r.rolname=${login} AND r.oid=${roleOid}::oid
              AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
              AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
              AND shobj_description(r.oid,'pg_authid')=${marker}`;
          if (identity.length!==1) throw new Error('Disposable write authorization identity mismatch');
          return work({
            async locateStaff(credential){
              if (credential.authority!==authority) return null;
              const rows=await db.$queryRaw<{id:string}[]>`
                SELECT staff_id::text id FROM ${schema}.staff_session
                WHERE authority_id=${authority} AND token_digest=decode(${credential.digest},'hex')`;
              return rows.length===1?rows[0].id:null;
            },
            async acquire(lock){
              if (lock.authority!==authority) throw new Error('Forbidden');
              if (lock.kind==='OPERATION') {
                await db.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${authority+'|'+lock.id},0::bigint))::text`;
                return;
              }
              let rows:unknown[];
              if (lock.kind==='STAFF_AUTHORIZATION') {
                rows=await db.$queryRaw`SELECT 1 FROM ${schema}.staff_authorization
                  WHERE authority_id=${authority} AND staff_id=${lock.id}::uuid FOR SHARE`;
              } else if (lock.kind==='CUSTOMER') {
                rows=await db.$queryRaw`SELECT 1 FROM ${schema}.customer
                  WHERE authority_id=${authority} AND id=${lock.id}::uuid FOR UPDATE`;
              } else throw new Error('Unsupported disposable authorization lock');
              if (rows.length!==1) throw new Error('Forbidden');
            },
            async readSession(credential){
              if (credential.authority!==authority) return null;
              const rows=await db.$queryRaw<SessionRow[]>`
                SELECT s.session_id::text id,a.staff_id::text "staffId",a.role,a.active,a.revision,
                  (extract(epoch FROM s.issued_at)*1000000)::bigint "issuedAt",
                  (extract(epoch FROM s.expires_at)*1000000)::bigint "expiresAt",
                  (extract(epoch FROM s.revoked_at)*1000000)::bigint "revokedAt",
                  (extract(epoch FROM clock_timestamp())*1000000)::bigint "checkedAt"
                FROM ${schema}.staff_session s
                JOIN ${schema}.staff_authorization a USING (authority_id,staff_id)
                WHERE s.authority_id=${authority} AND s.token_digest=decode(${credential.digest},'hex')`;
              if (rows.length!==1) return null;
              const {staffId,role,active,...session}=rows[0];
              return {...session,actor:{id:staffId,role,active,authority}};
            },
          },db);
        },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,timeout:15000});
      } catch(error) {
        const aborted=error instanceof Prisma.PrismaClientKnownRequestError && (error.code==='P2034' ||
          (error.code==='P2010' && ['40001','40P01'].includes(String(error.meta?.code))));
        if (!aborted || attempt===2) throw error;
      }
    }
  };
}
