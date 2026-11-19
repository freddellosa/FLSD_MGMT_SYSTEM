import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {Prisma,PrismaClient} from '@prisma/client';
import {reviewAuthenticatedOperationalCommand} from '../../src/lib/production/authenticated-operational-review';
import {createPostgresTripReviewRepository} from '../../src/lib/production/postgres-trip-review-repository';
import {createTripOperationalReviewProvider} from '../../src/lib/production/trip-operational-review-provider';
import {authority,cases,createTrip,database,databaseOid,databaseRole,ids,largeVersion,marker,prepareSyntheticTripReaderFixture,replayTrip,type SyntheticTokens} from './fixture';

const oid = (input:unknown): input is string => typeof input==='string' && /^[1-9][0-9]{0,9}$/.test(input) && BigInt(input)<=4294967295n;
const token = (input:unknown): input is string => typeof input==='string' && /^[0-9a-f]{64}$/.test(input);
let phase='INPUT';

async function verifyConnectedReader() {
  if(process.env.FLSD_SYNTHETIC_TRIP_READER!=='VERIFIED_LOCAL_RUN') throw new Error();
  const raw=readFileSync(0,'utf8');
  if(raw.length>16384) throw new Error();
  const input=JSON.parse(raw);
  if(typeof input.password!=='string'||!input.password.length||input.password.length>1024||
      !oid(input.schemaOid)||!oid(input.roleOid)||!input.tokens||Object.keys(input.tokens).length!==cases.length||
      !cases.every(key=>token(input.tokens[key]))) throw new Error();
  const tokens=input.tokens as SyntheticTokens;
  const client=new PrismaClient({
    datasources:{db:{url:`postgresql://${databaseRole}:${encodeURIComponent(input.password)}@127.0.0.1:5432/${database}?schema=flsd_operational&connection_limit=1`}},
    log:[],
  });
  try {
    phase='CATALOG_AND_ROLE';
    await client.$transaction(async db=>{
      await db.$executeRaw`SET TRANSACTION READ ONLY`;
      await db.$executeRaw`SET LOCAL search_path TO pg_catalog`;
      const rows=await db.$queryRaw<{verified:boolean}[]>`
        SELECT EXISTS(
          SELECT 1 FROM pg_database d JOIN pg_roles r ON r.rolname=current_user
          CROSS JOIN pg_namespace n
          WHERE d.datname=current_database() AND d.datname=${database} AND d.oid=${databaseOid}::oid
            AND host(inet_server_addr())='127.0.0.1' AND inet_server_port()=5432
            AND current_setting('server_version_num')::int=180007
            AND current_setting('transaction_read_only')='on'
            AND current_setting('transaction_isolation')='repeatable read'
            AND r.rolname=${databaseRole} AND r.oid=${input.roleOid}::oid AND NOT r.rolinherit
            AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls)
            AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
            AND shobj_description(r.oid,'pg_authid')=${marker}
            AND n.nspname='flsd_operational' AND n.oid=${input.schemaOid}::oid AND n.nspowner=16392::oid
            AND obj_description(n.oid,'pg_namespace')=${marker}
            AND NOT has_database_privilege(r.oid,d.oid,'CREATE,TEMPORARY')
            AND NOT has_schema_privilege(r.oid,n.oid,'CREATE')
            AND NOT EXISTS (
              SELECT 1 FROM pg_namespace blocked
              WHERE blocked.nspname IN ('flsd_adapter_test','flsd_iso_6e7999015d634d3aa2b8944b0fbdb1b9','flsd_iso_75435c870a3142b79761738db6c5c866')
                AND has_schema_privilege(r.oid,blocked.oid,'USAGE')
            )
            AND NOT EXISTS (
              SELECT 1 FROM pg_class t WHERE t.relnamespace=n.oid AND t.relkind='r'
                AND (has_table_privilege(r.oid,t.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER,MAINTAIN,REFERENCES')
                  OR has_any_column_privilege(r.oid,t.oid,'INSERT,UPDATE,REFERENCES'))
            )
            AND has_column_privilege(r.oid,'flsd_operational.staff_session','token_digest','SELECT')
            AND NOT has_column_privilege(r.oid,'flsd_operational.staff_session','session_id','SELECT')
        ) AS verified`;
      assert.deepEqual(rows,[{verified:true}]);
    },{isolationLevel:Prisma.TransactionIsolationLevel.RepeatableRead});

    const repository=createPostgresTripReviewRepository(client,{authority,database,databaseOid,databaseRole},request=>request.headers.get('x-synthetic-session'));
    const provider=createTripOperationalReviewProvider(authority,repository);
    const request=(value:string)=>new Request('http://127.0.0.1/synthetic-trip-review',{headers:{'x-synthetic-session':value}});
    const review=(value:string,command:unknown=createTrip)=>reviewAuthenticatedOperationalCommand(provider,request(value),command);
    let passed=1;
    phase='VALID_REVIEW';
    assert.equal((await review(tokens.valid)).status,'VALIDATED_REVIEW_ONLY');
    passed++;
    phase='BOUND_REPLAY';
    const replay=await review(tokens.valid,replayTrip);
    assert.equal(replay.status,'REPLAY_REVIEW_ONLY');
    assert.deepEqual(replay.result,{entityId:ids.trip,version:largeVersion});
    passed++;
    phase='SESSION_AND_ROLE_REFUSALS';
    for(const invalid of [tokens.expired,tokens.revoked,tokens.inactive,tokens.viewer,'invalid-token']){
      await assert.rejects(review(invalid),/^Error: Forbidden$/);
      passed++;
    }
    phase='INACTIVE_MASTER';
    await assert.rejects(review(tokens.valid,{...createTrip,action:{...createTrip.action,trip:{...createTrip.action.trip,vehicleId:ids.inactiveVehicle}}}),/^Error: Forbidden$/);
    passed++;
    phase='EXACT_VERSION_AND_AUTHORITY';
    await repository.readSnapshot(async snapshot=>{
      assert.equal((await snapshot.findTrip(authority,ids.trip))?.version,largeVersion);
      assert.equal(await snapshot.findTrip('foreign-authority',ids.trip),null);
    });
    passed++;
    return {status:'TRIP_READER_CONNECTED_VERIFIED',passed,failed:0,rawOutputIncluded:false};
  } finally {
    await client.$disconnect();
  }
}

async function main() {
  if(process.cwd()!=='D:\\FLSD-Batch7-Validation') throw new Error();
  const action=process.argv[2];
  if(action==='fixture') {
    process.stdout.write(JSON.stringify(prepareSyntheticTripReaderFixture()));
  } else if(action==='verify') {
    process.stdout.write(JSON.stringify(await verifyConnectedReader()));
  } else {
    throw new Error();
  }
}

void main().catch(()=>{
  process.stdout.write(JSON.stringify({status:'TRIP_READER_STAGE_FAILED',phase,rawOutputIncluded:false}));
  process.exitCode=1;
});
