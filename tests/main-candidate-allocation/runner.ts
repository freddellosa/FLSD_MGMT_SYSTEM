import {createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID} from 'node:crypto';
import {PrismaClient, type Prisma} from '@prisma/client';
import {acceptCandidateAllocation} from '../../src/lib/production/candidate-allocation-acceptance';
import {createCandidatePostgresAllocationPort} from '../../src/lib/production/candidate-postgres-allocation';

const schema='flsd_batch7_commit_rehearsal';
const role='flsd_batch7_candidate_writer';
const roleOid='20051';
const staff='70000000-0000-4000-8000-000000000001';
const digest=(token:string)=>createHash('sha256').update(token,'ascii').digest('hex');

function scramVerifier(password:string){
  const salt=randomBytes(16);
  const salted=pbkdf2Sync(password,salt,4096,32,'sha256');
  const clientKey=createHmac('sha256',salted).update('Client Key').digest();
  const stored=createHash('sha256').update(clientKey).digest('base64');
  const server=createHmac('sha256',salted).update('Server Key').digest('base64');
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}

async function main() {
  if(process.env.FLSD_CANDIDATE_ACCEPTANCE!=='PINNED_LOCAL_ONLY') throw new Error();
  const chunks:Buffer[]=[];
  let size=0;
  for await(const input of process.stdin){
    const chunk=Buffer.from(input);
    size+=chunk.length;
    if(size>8192) throw new Error();
    chunks.push(chunk);
  }
  const {password,setupToken}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(typeof password!=='string'||!password||password.length>1024||
      (setupToken!==null&&(typeof setupToken!=='string'||!/^[a-f0-9]{64}$/.test(setupToken)))) throw new Error();
  const writerPassword=randomBytes(32).toString('hex');
  const client=(user:string,secret:string)=>new PrismaClient({log:[],datasources:{db:{
    url:`postgresql://${user}:${encodeURIComponent(secret)}@127.0.0.1:5432/flsd_main_adapter_test?schema=${schema}&connection_limit=1&connect_timeout=5`,
  }}});
  const admin=client('postgres',password);
  const writer=client(role,writerPassword);
  const guarded=<T>(work:(db:Prisma.TransactionClient,login:boolean)=>Promise<T>)=>admin.$transaction(async db=>{
    await db.$executeRaw`SET LOCAL search_path TO pg_catalog`;
    await db.$executeRaw`SET LOCAL lock_timeout TO '5s'`;
    await db.$queryRaw`SELECT true FROM pg_advisory_xact_lock(176661,1)`;
    const rows=await db.$queryRaw<{login:boolean}[]>`
      SELECT r.rolcanlogin AS login
      FROM pg_database d CROSS JOIN pg_roles r CROSS JOIN pg_namespace n
      WHERE current_user='postgres' AND session_user=current_user
        AND d.datname=current_database() AND d.datname='flsd_main_adapter_test' AND d.oid=16394 AND d.datdba=16392
        AND shobj_description(d.oid,'pg_database')='FLSD_DISPOSABLE:b813e743-9f4c-4121-b8ab-b01ca51b9335:flsd_main_adapter_test'
        AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=5432 AND NOT pg_is_in_recovery()
        AND n.nspname=${schema} AND n.oid=19396 AND n.nspowner=16392
        AND obj_description(n.oid,'pg_namespace')='FLSD_SYNTHETIC_BATCH7_COMMITTED_V1'
        AND r.rolname=${role} AND r.oid=${roleOid}::oid
        AND shobj_description(r.oid,'pg_authid')='FLSD_SYNTHETIC_BATCH7_ACCEPTANCE_V1'
        AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
        AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
    `;
    if(rows.length!==1) throw new Error('Identity guard failed');
    return work(db,rows[0].login);
  },{isolationLevel:'Serializable',timeout:12000});

  let enableAttempted=false;
  let enabled=false;
  let result;
  let phase='PREFLIGHT';
  try{
    const token=await guarded(async (db,login)=>{
      if(login) throw new Error('Role already enabled');
      const opening=await db.$queryRaw<{ready:boolean}[]>`
        SELECT (SELECT count(*) FROM flsd_batch7_commit_rehearsal."FinancialOperation")=2
          AND EXISTS (
            SELECT 1 FROM flsd_batch7_commit_rehearsal."PaymentAllocation"
            WHERE "paymentId"='70000000-0000-4000-8000-000000000006'
              AND "invoiceId"='70000000-0000-4000-8000-000000000005' AND amount=10.01
          ) AS ready
      `;
      if(opening[0]?.ready!==true) throw new Error('Opening state mismatch');
      const live=await db.$queryRaw<{matches:boolean}[]>`
        SELECT token_digest=decode(${setupToken===null?'':digest(setupToken)},'hex') AS matches
        FROM flsd_batch7_commit_rehearsal.staff_session
        WHERE staff_id=${staff}::uuid AND revoked_at IS NULL AND issued_at<=statement_timestamp()
          AND expires_at>statement_timestamp()
      `;
      let current=setupToken;
      if(live.length===0){
        current=randomBytes(32).toString('hex');
        await db.$executeRaw`
          INSERT INTO flsd_batch7_commit_rehearsal.staff_session(id,staff_id,token_digest,issued_at,expires_at)
          VALUES (${randomUUID()}::uuid,${staff}::uuid,decode(${digest(current)},'hex'),
            statement_timestamp(),statement_timestamp()+interval '15 minutes')
        `;
      }else if(live.length!==1||!live[0].matches||current===null) throw new Error('Existing session token unavailable');
      const expiry=new Date(Date.now()+180000).toISOString();
      const verifier=scramVerifier(writerPassword);
      if(!/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/.test(verifier)||
        !/^[0-9T:.Z-]+$/.test(expiry)) throw new Error();
      // ALTER ROLE requires literals here. Both literals are internally generated and validated.
      enableAttempted=true;
      await db.$executeRawUnsafe(`ALTER ROLE flsd_batch7_candidate_writer LOGIN CONNECTION LIMIT 1 PASSWORD '${verifier}' VALID UNTIL '${expiry}'`);
      return current;
    });
    enabled=true;
    phase='ACCEPTANCE';
    result=await acceptCandidateAllocation(createCandidatePostgresAllocationPort(writer,roleOid,async()=>token));
  }catch{
    return {status:'CANDIDATE_ACCEPTANCE_REFUSED',phase,cleanup:await cleanup()};
  }
  const status=await cleanup();
  return status==='NOLOGIN_VERIFIED' ? {...result,cleanup:status} :
    {status:'CANDIDATE_ACCEPTANCE_CLEANUP_UNVERIFIED',operationId:result.operationId,cleanup:status};

  async function cleanup(){
    await Promise.allSettled([writer.$disconnect()]);
    try{
      if(!enableAttempted) return 'LOGIN_UNCHANGED';
      await guarded(async (db,login)=>{
        if(login && !enabled) throw new Error('Login commit uncertain');
        if(login) await db.$executeRaw`ALTER ROLE flsd_batch7_candidate_writer NOLOGIN PASSWORD NULL`;
      });
      return 'NOLOGIN_VERIFIED';
    }catch{
      return 'MANUAL_ROLE_STATE_RECONCILIATION_REQUIRED';
    }finally{
      await admin.$disconnect();
    }
  }
}

main().then(result=>{
  process.stdout.write(JSON.stringify(result)+'\n');
  if(result.status!=='BATCH7_CANDIDATE_ALLOCATION_ACCEPTANCE_VERIFIED') process.exitCode=1;
}).catch(()=>{
  process.stdout.write('{"status":"CANDIDATE_ACCEPTANCE_WORKER_REFUSED"}\n');
  process.exitCode=1;
});
