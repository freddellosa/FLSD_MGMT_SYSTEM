import {describe, expect, it, vi} from 'vitest';
import {reviewAuthenticatedOperationalCommand} from './authenticated-operational-review';
import {reviewOperationalReplay, validateOperationalEnvelope, validateOperationalReviewEnvelope, type OperationalReviewActor} from './operational-envelope';
import {createTripOperationalReviewProvider, type TripReviewSnapshot} from './trip-operational-review-provider';

const authority = 'flsd-office';
const actor: OperationalReviewActor = {authority, id:'staff-1', role:'BILLING', active:true};
const operationId = '12345678-1234-4234-8234-123456789abc';
const request = new Request('http://localhost/commands', {headers:{'x-role':'OWNER'}});
const trip = {authority, id:'trip-1', customerId:'customer-a', vehicleId:'vehicle-1', driverId:'driver-1', version:'3'};
const inputTrip = {customerId:'customer-b', vehicleId:'vehicle-1', driverId:'driver-1', amount:100n};
const create = {schemaVersion:2, operationId, action:{type:'CREATE_TRIP', trip:inputTrip}, expectedVersions:[]};
const edit = {
  schemaVersion:2, operationId,
  action:{type:'EDIT_TRIP', tripId:trip.id, expectedVersion:3, edit:inputTrip, replacement:inputTrip},
  expectedVersions:[{kind:'TRIP' as const, id:trip.id, version:'3'}],
};
const directory = (id: string, active = true) => ({id, active, authority});

function setup() {
  const snapshot = {
    findVerifiedActor:vi.fn<TripReviewSnapshot['findVerifiedActor']>().mockResolvedValue(actor),
    findTrip:vi.fn<TripReviewSnapshot['findTrip']>().mockResolvedValue(trip),
    findCustomer:vi.fn<TripReviewSnapshot['findCustomer']>().mockImplementation(async (_,id)=>directory(id)),
    findVehicle:vi.fn<TripReviewSnapshot['findVehicle']>().mockResolvedValue(directory('vehicle-1')),
    findDriver:vi.fn<TripReviewSnapshot['findDriver']>().mockResolvedValue(directory('driver-1')),
    findReceipt:vi.fn<TripReviewSnapshot['findReceipt']>().mockResolvedValue(null),
  };
  const provider = createTripOperationalReviewProvider(authority, {readSnapshot:read=>read(snapshot)});
  return {snapshot, review:(input:unknown)=>reviewAuthenticatedOperationalCommand(provider,request,input)};
}

describe('Offline trip review provider',()=>{
  it('binds production receipts to stable selections and preserves the legacy command boundary',()=>{
    const v1={...create,schemaVersion:1,action:{type:'CREATE_TRIP',trip:{customerId:'customer-b',vehicle:'vehicle-1',driver:'driver-1',amount:100n}}};
    expect(validateOperationalEnvelope(v1).schemaVersion).toBe(1);
    expect(()=>validateOperationalEnvelope(create)).toThrow('Invalid operation envelope');
    expect(validateOperationalReviewEnvelope(create)).toEqual(create);
    const original=reviewOperationalReplay(create,actor,null,[]);
    const legacy=reviewOperationalReplay(v1,actor,null,[]);
    expect(original.digest).not.toBe(legacy.digest);
    expect(()=>reviewOperationalReplay(create,actor,{
      operationId,authority,actorId:actor.id,commandType:'CREATE_TRIP',digest:legacy.digest,result:{entityId:trip.id,version:'1'},
    },[])).toThrow('receipt conflict');
    expect(reviewOperationalReplay({...create,action:{...create.action,trip:{...inputTrip,driverId:'driver-2'}}},actor,null,[]).digest).not.toBe(original.digest);
  });

  it.each([
    {...create,action:{...create.action,trip:{...inputTrip,vehicleId:''}}},
    {...create,action:{...create.action,trip:{...inputTrip,driverId:42}}},
    {...edit,action:{...edit.action,edit:{...inputTrip,driver:'Legacy label'}}},
    {...edit,action:{...edit.action,replacement:{...inputTrip,vehicleId:'Van Label'}}},
  ])('rejects missing, malformed or mixed selectors before provider reads %#',input=>{
    const {snapshot,review}=setup();
    expect(()=>review(input)).toThrow('Stable');
    expect(snapshot.findVerifiedActor).not.toHaveBeenCalled();
  });

  it('uses verified authority and exact stored IDs across customers',async()=>{
    const {snapshot,review}=setup();
    await expect(review(create)).resolves.toMatchObject({status:'VALIDATED_REVIEW_ONLY',postingEnabled:false});
    await expect(review(edit)).resolves.toMatchObject({status:'VALIDATED_REVIEW_ONLY',executionAuthorized:false});
    expect(snapshot.findVerifiedActor).toHaveBeenCalledWith(authority,request);
    expect(snapshot.findCustomer).toHaveBeenCalledWith(authority,'customer-a');
    expect(snapshot.findCustomer).toHaveBeenCalledWith(authority,'customer-b');
    expect(snapshot.findVehicle).toHaveBeenCalledWith(authority,'vehicle-1');
    expect(snapshot.findDriver).toHaveBeenCalledWith(authority,'driver-1');
    expect(snapshot.findReceipt).toHaveBeenCalledWith(authority,operationId);
  });

  it.each([null,{...actor,authority:'other-office'},{...actor,role:'VIEWER' as const}])('rejects unverified, foreign or read-only actors before business reads (%j)',async verified=>{
    const {snapshot,review}=setup();
    snapshot.findVerifiedActor.mockResolvedValue(verified);
    await expect(review(create)).rejects.toThrow('Forbidden');
    expect(snapshot.findCustomer).not.toHaveBeenCalled();
    expect(snapshot.findReceipt).not.toHaveBeenCalled();
  });

  it('refuses a foreign trip and legacy label fields before a master lookup',async()=>{
    const {snapshot,review}=setup();
    snapshot.findTrip.mockResolvedValueOnce({...trip,authority:'other-office'});
    await expect(review(edit)).rejects.toThrow('Forbidden');
    expect(()=>review({...create,action:{...create.action,trip:{...inputTrip,vehicle:'Van 1'}}})).toThrow('Stable');
    expect(snapshot.findVehicle).not.toHaveBeenCalled();
    expect(snapshot.findReceipt).not.toHaveBeenCalled();
  });

  it('permits retaining inactive links and prevents new assignments to inactive records',async()=>{
    const {snapshot,review}=setup();
    snapshot.findCustomer.mockImplementation(async (_,id)=>directory(id,false));
    snapshot.findVehicle.mockResolvedValue(directory('vehicle-1',false));
    snapshot.findDriver.mockResolvedValue(directory('driver-1',false));
    await expect(review({...edit,action:{...edit.action,replacement:{...inputTrip,customerId:trip.customerId}}})).resolves.toMatchObject({status:'VALIDATED_REVIEW_ONLY'});
    await expect(review(edit)).rejects.toThrow('Forbidden');
    await expect(review(create)).rejects.toThrow('Forbidden');
  });

  it('rejects stale versions and rechecks the current customer of an authorized replay result',async()=>{
    const {snapshot,review}=setup();
    snapshot.findTrip.mockResolvedValue({...trip,version:'4'});
    await expect(review(edit)).rejects.toThrow('Stale');
    snapshot.findReceipt.mockResolvedValue({
      operationId,authority,actorId:actor.id,commandType:'EDIT_TRIP',
      digest:reviewOperationalReplay(edit,actor,null,edit.expectedVersions).digest,
      result:{entityId:trip.id,version:'4'},
    });
    await expect(review(edit)).resolves.toMatchObject({status:'REPLAY_REVIEW_ONLY'});
    snapshot.findTrip.mockResolvedValueOnce(trip).mockResolvedValueOnce({...trip,customerId:'missing-customer'});
    snapshot.findCustomer.mockImplementation(async (_,id)=>id==='missing-customer'?null:directory(id));
    await expect(review(edit)).rejects.toThrow('Forbidden');
  });

  it('excludes document actions from the trip provider before receipt lookup',async()=>{
    const {snapshot,review}=setup();
    expect(()=>review({...edit,action:{type:'CREATE_SOA',tripIds:[trip.id]}})).toThrow('Version 2 supports trip commands only');
    await expect(review({...create,schemaVersion:1,action:{type:'CREATE_TRIP',trip:{customerId:'customer-b',vehicle:'Van 1',driver:'Driver 1',amount:100n}}})).rejects.toThrow('Forbidden');
    expect(snapshot.findReceipt).not.toHaveBeenCalled();
  });
});
