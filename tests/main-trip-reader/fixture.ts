import {createHash,randomBytes} from 'node:crypto';
import {reviewOperationalReplay,type OperationalReviewActor} from '../../src/lib/production/operational-envelope';

export const authority='flsd-synthetic-trip-review';
export const database='flsd_main_adapter_test';
export const databaseOid='16394';
export const databaseRole='flsd_trip_review_reader_75435c870a31';
export const marker='FLSD_SYNTHETIC_TRIP_READER_V1:b813e743-9f4c-4121-b8ab-b01ca51b9335';
export const largeVersion='9007199254740993';
export const ids={
  billing:'10000000-0000-4000-8000-000000000001', inactive:'10000000-0000-4000-8000-000000000002', viewer:'10000000-0000-4000-8000-000000000003',
  customer:'20000000-0000-4000-8000-000000000001', otherCustomer:'20000000-0000-4000-8000-000000000002',
  vehicle:'30000000-0000-4000-8000-000000000001', inactiveVehicle:'30000000-0000-4000-8000-000000000002',
  driver:'40000000-0000-4000-8000-000000000001', trip:'50000000-0000-4000-8000-000000000001',
  replay:'60000000-0000-4000-8000-000000000001', fresh:'60000000-0000-4000-8000-000000000002',
};
export const cases=['valid','expired','revoked','inactive','viewer'] as const;
export type SyntheticTokens=Record<typeof cases[number],string>;
export const actor:OperationalReviewActor={authority,id:ids.billing,role:'BILLING',active:true};
export const createTrip={
  schemaVersion:2,operationId:ids.fresh,expectedVersions:[],
  action:{type:'CREATE_TRIP',trip:{customerId:ids.otherCustomer,vehicleId:ids.vehicle,driverId:ids.driver,amount:10001n}},
};
export const replayTrip={...createTrip,operationId:ids.replay};

export function prepareSyntheticTripReaderFixture() {
  const tokens:SyntheticTokens={
    valid:randomBytes(32).toString('hex'),expired:randomBytes(32).toString('hex'),
    revoked:randomBytes(32).toString('hex'),inactive:randomBytes(32).toString('hex'),viewer:randomBytes(32).toString('hex'),
  };
  const sessionRows=cases.map((kind,index)=>{
    const staff=kind==='inactive'?ids.inactive:kind==='viewer'?ids.viewer:ids.billing;
    const expires=kind==='expired'?"statement_timestamp()-interval '1 minute'":"statement_timestamp()+interval '1 hour'";
    const revoked=kind==='revoked'?'statement_timestamp()':'NULL';
    const digest=createHash('sha256').update(tokens[kind]).digest('hex');
    return `('${authority}','70000000-0000-4000-8000-00000000000${index+1}','${staff}',decode('${digest}','hex'),statement_timestamp()-interval '2 minutes',${expires},${revoked})`;
  });
  const replayDigest=reviewOperationalReplay(replayTrip,actor,null,[]).digest;
  const sql=`
INSERT INTO flsd_operational.staff_user (authority_id,id,role,active) VALUES
 ('${authority}','${ids.billing}','BILLING',true),('${authority}','${ids.inactive}','BILLING',false),('${authority}','${ids.viewer}','VIEWER',true);
INSERT INTO flsd_operational.staff_authorization (authority_id,staff_id,revision) VALUES
 ('${authority}','${ids.billing}',1),('${authority}','${ids.inactive}',1),('${authority}','${ids.viewer}',1);
INSERT INTO flsd_operational.staff_session (authority_id,session_id,staff_id,token_digest,issued_at,expires_at,revoked_at)
 VALUES ${sessionRows.join(',\n')};
INSERT INTO flsd_operational.customer (authority_id,id,active) VALUES
 ('${authority}','${ids.customer}',true),('${authority}','${ids.otherCustomer}',true);
INSERT INTO flsd_operational.vehicle (authority_id,id,active) VALUES
 ('${authority}','${ids.vehicle}',true),('${authority}','${ids.inactiveVehicle}',false);
INSERT INTO flsd_operational.driver (authority_id,id,active) VALUES ('${authority}','${ids.driver}',true);
INSERT INTO flsd_operational.trip (authority_id,id,customer_id,vehicle_id,driver_id,version) VALUES
 ('${authority}','${ids.trip}','${ids.otherCustomer}','${ids.vehicle}','${ids.driver}',${largeVersion});
INSERT INTO flsd_operational.operational_receipt
 (authority_id,operation_id,actor_id,command_kind,request_digest,result_entity_id,result_version,committed_at) VALUES
 ('${authority}','${ids.replay}','${ids.billing}','CREATE_TRIP',decode('${replayDigest}','hex'),'${ids.trip}',${largeVersion},statement_timestamp());
`;
  return {sql,tokens};
}
