import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {PrismaClient} from '@prisma/client';
import {createRehearsalControl,rehearseWriteAuthorization} from './rehearsal';

const names=['revocation','downgrade','commandFirst'] as const;
const schema='flsd_write_auth_rehearsal';
const role='flsd_write_auth_runner_75435c870a31';
const marker='FLSD_SYNTHETIC_WRITE_AUTH_V1:b813e743-9f4c-4121-b8ab-b01ca51b9335';
const authority='flsd-synthetic-write-auth';
const oid=(value:unknown)=>typeof value==='string'&&/^[1-9][0-9]{0,9}$/.test(value)&&Number(value)<=4294967295;
const password=(value:unknown):value is string=>typeof value==='string'&&value.length>0&&value.length<=1024;

async function main() {
  if(process.argv[2]==='fixture'){
    const fixtures=Object.fromEntries(names.map(name=>[name,{
      staffId:randomUUID(),customerId:randomUUID(),sessionId:randomUUID(),operationKey:randomUUID(),token:randomBytes(32).toString('hex'),
    }]));
    const sql=Object.values(fixtures).map(f=>{
      const digest=createHash('sha256').update(f.token,'ascii').digest('hex');
      return [
        `INSERT INTO ${schema}.staff_authorization (authority_id,staff_id,role,active) VALUES ('${authority}','${f.staffId}','BILLING',true);`,
        `INSERT INTO ${schema}.staff_session VALUES ('${authority}','${f.sessionId}','${f.staffId}',decode('${digest}','hex'),transaction_timestamp(),transaction_timestamp()+interval '2 hours',NULL);`,
        `INSERT INTO ${schema}.customer (authority_id,id) VALUES ('${authority}','${f.customerId}');`,
      ].join(' ');
    }).join(' ');
    return {fixtures,sql};
  }
  if(process.argv[2]!=='verify'||process.env.FLSD_SYNTHETIC_WRITE_AUTH!=='VERIFIED_LOCAL_RUN') throw new Error();
  const chunks:Buffer[]=[];
  let size=0;
  for await(const value of process.stdin){
    const chunk=Buffer.from(value);
    size+=chunk.length;
    if(size>32768) throw new Error();
    chunks.push(chunk);
  }
  const {adminPassword,rolePassword,schemaOid,roleOid,fixtures}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if(!password(adminPassword)||!password(rolePassword)||!oid(schemaOid)||!oid(roleOid)||
      !fixtures||!names.every(name=>Object.hasOwn(fixtures,name))) throw new Error();
  const client=(user:string,secret:string)=>new PrismaClient({log:[],datasources:{db:{
    url:`postgresql://${user}:${encodeURIComponent(secret)}@127.0.0.1:5432/flsd_main_adapter_test?schema=${schema}&connection_limit=1`,
  }}});
  const admin=client('postgres',adminPassword),writer=client(role,rolePassword);
  try{
    const control=createRehearsalControl(work=>admin.$transaction(async db=>{
      await db.$executeRaw`SET LOCAL search_path TO pg_catalog`;
      const rows=await db.$queryRaw<unknown[]>`
        SELECT 1 FROM pg_database d JOIN pg_namespace n ON n.nspowner=d.datdba
        JOIN pg_roles r ON r.rolname=${role}
        WHERE current_user='postgres' AND session_user=current_user AND d.datname=current_database()
          AND d.datname='flsd_main_adapter_test' AND d.oid=16394::oid AND d.datdba=16392::oid
          AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=5432
          AND current_setting('server_version_num')='180007' AND NOT pg_is_in_recovery()
          AND shobj_description(d.oid,'pg_database')='FLSD_DISPOSABLE:b813e743-9f4c-4121-b8ab-b01ca51b9335:flsd_main_adapter_test'
          AND n.nspname=${schema} AND n.oid=${schemaOid}::oid AND obj_description(n.oid,'pg_namespace')=${marker}
          AND r.oid=${roleOid}::oid AND shobj_description(r.oid,'pg_authid')=${marker}`;
      if(rows.length!==1) throw new Error();
      await work(db);
    },{timeout:15000}));
    await rehearseWriteAuthorization(writer,{schemaOid,roleOid},control,fixtures);
    return {status:'WRITE_AUTHORIZATION_CONNECTED_VERIFIED',rawOutputIncluded:false};
  }finally{
    await Promise.allSettled([admin.$disconnect(),writer.$disconnect()]);
  }
}

main().then(result=>process.stdout.write(JSON.stringify(result)+'\n')).catch(()=>{
  process.stdout.write('{"status":"WRITE_AUTHORIZATION_WORKER_REFUSED","rawOutputIncluded":false}\n');
  process.exitCode=1;
});
