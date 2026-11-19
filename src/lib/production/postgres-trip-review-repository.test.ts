import {createHash} from 'node:crypto';
import {Prisma} from '@prisma/client';
import {describe,expect,it,vi} from 'vitest';
import {reviewAuthenticatedOperationalCommand} from './authenticated-operational-review';
import {createCookieAuthenticatedTripReviewProvider} from './cookie-authenticated-trip-review';
import {createPostgresTripReviewRepository} from './postgres-trip-review-repository';
import {createTripOperationalReviewProvider} from './trip-operational-review-provider';

const authority='flsd-office';
const target={authority,database:'synthetic_review',databaseOid:'16399',databaseRole:'synthetic_reader'};
const staff='c619b10d-ba81-45af-8be8-b9c098cc8387';
const customer='6b5a7580-1408-4e82-88b7-e10b71c42931';
const vehicle='6173679a-2b05-486e-ae83-593f2a395729';
const driver='9aba79b0-de41-4d09-9786-62f6a65e6842';
const operation='a2a6c89f-a57a-4cc0-b622-46a77db2474a';
const trip='0853af2b-3cad-4ea1-b335-d0f1006526a1';
const token='ab'.repeat(32);
const request=new Request('http://localhost/commands',{headers:{'x-role':'OWNER'}});
const create={
  schemaVersion:2,operationId:operation,expectedVersions:[],
  action:{type:'CREATE_TRIP',trip:{customerId:customer,vehicleId:vehicle,driverId:driver,amount:100n}},
};

function setup() {
  const source={
    $executeRaw:vi.fn(async (parts:TemplateStringsArray)=>{ expect(parts.join('')).toMatch(/^SET (?:TRANSACTION|LOCAL) /); }),
    $queryRaw:vi.fn(async (query:TemplateStringsArray | Prisma.Sql, ...args:unknown[])=>{
      const sql='sql' in query ? query.sql : query.join('?');
      const values='sql' in query ? query.values : args;
      if(sql.includes('authority_meta')) return [{verified:true}];
      if(sql.includes('staff_session')) return [{authority,id:staff,role:'BILLING',active:true}];
      if(sql.includes('operational_receipt')) return [];
      if(sql.includes('flsd_operational.trip')) return [{authority,id:trip,customerId:customer,vehicleId:vehicle,driverId:driver,version:'9007199254740993'}];
      return [{authority,id:values.at(-1),active:true}];
    }),
  };
  const transaction=vi.fn(async (read:(arg:typeof source)=>Promise<unknown>)=>read(source));
  const readToken=vi.fn<() => string | null>().mockReturnValue(token);
  const client={$transaction:transaction} as unknown as Parameters<typeof createPostgresTripReviewRepository>[0];
  const repository=createPostgresTripReviewRepository(client,target,readToken);
  const provider=createTripOperationalReviewProvider(authority,repository);
  return {source,transaction,readToken,repository,client,review:()=>reviewAuthenticatedOperationalCommand(provider,request,create)};
}

describe('Cookie-authenticated trip review composition',()=>{
  const cookieName='__Host-flsd-test-session';
  const reviewRequest=(cookie: string) => new Request('https://flsd.test/commands',{headers:{
    cookie,authorization:`Bearer ${token}`,'x-role':'OWNER',
  }});

  it('uses the configured cookie and current database actor',async()=>{
    const {source,client}=setup();
    const provider=createCookieAuthenticatedTripReviewProvider(client,target,cookieName);
    const request=reviewRequest(`other=${token}; ${cookieName}=${token}`);
    await expect(reviewAuthenticatedOperationalCommand(provider,request,create)).resolves.toMatchObject({status:'VALIDATED_REVIEW_ONLY'});
    expect(source.$queryRaw.mock.calls[1].slice(1)).toEqual([authority,createHash('sha256').update(token).digest()]);
    source.$queryRaw.mockClear();
    source.$queryRaw.mockResolvedValueOnce([{verified:true}])
      .mockResolvedValueOnce([{authority,id:staff,role:'VIEWER',active:true}]);
    await expect(reviewAuthenticatedOperationalCommand(provider,request,create)).rejects.toThrow('Forbidden');
    expect(source.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it.each([
    `pilot_session=${token}`, `${cookieName}="${token}"`,
    `${cookieName}=${token}; ${cookieName}=${token}`, `${cookieName}; ${cookieName}=${token}`,
    `${cookieName}=${token}; other=x, ${cookieName}=${token}`,
  ])('refuses ambiguous or unrelated credentials before session lookup', async cookie=>{
    const {source,client}=setup();
    const provider=createCookieAuthenticatedTripReviewProvider(client,target,cookieName);
    await expect(reviewAuthenticatedOperationalCommand(provider,reviewRequest(cookie),create)).rejects.toThrow('Forbidden');
    expect(source.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('requires a dedicated host-bound cookie configuration',()=>{
    const {transaction,client}=setup();
    expect(()=>createCookieAuthenticatedTripReviewProvider(client,target,'pilot_session')).toThrow();
    expect(transaction).not.toHaveBeenCalled();
  });
});

describe('PostgreSQL trip review query adapter',()=>{
  it('opens a single read-only repeatable-read snapshot and binds hashes and directory IDs as parameters',async()=>{
    const {source,transaction,readToken,review}=setup();
    expect(transaction).not.toHaveBeenCalled();
    await expect(review()).resolves.toMatchObject({status:'VALIDATED_REVIEW_ONLY',postingEnabled:false});
    expect(transaction).toHaveBeenCalledWith(expect.any(Function),{isolationLevel:'RepeatableRead'});
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(source.$executeRaw.mock.calls.map(([parts])=>parts.join(''))).toEqual([
      'SET TRANSACTION READ ONLY','SET LOCAL search_path TO pg_catalog',
    ]);
    expect(source.$executeRaw.mock.invocationCallOrder[1]).toBeLessThan(source.$queryRaw.mock.invocationCallOrder[0]);
    expect(readToken).toHaveBeenCalledWith(request);
    const [identity,...queries]=source.$queryRaw.mock.calls;
    expect(identity.slice(1)).toEqual([target.database,target.databaseOid,target.databaseRole,authority]);
    const [session,...resources]=queries;
    expect(session[0]).toEqual(expect.arrayContaining([expect.stringContaining('s.revoked_at IS NULL AND u.active = true')]));
    expect(session[0]).toEqual(expect.arrayContaining([expect.stringContaining('s.expires_at > statement_timestamp()')]));
    expect(session.slice(1)).toEqual([authority,createHash('sha256').update(token).digest()]);
    expect(JSON.stringify(source.$queryRaw.mock.calls)).not.toContain(token);
    expect(resources.map(([parts,...args])=>('sql' in parts ? parts : Prisma.sql(parts,...args)).values)).toEqual([
      [authority,customer],[authority,vehicle],[authority,driver],[authority,operation],
    ]);
  });

  it('fails closed on target verification before session or business reads',async()=>{
    const {source,readToken,review}=setup();
    source.$queryRaw.mockResolvedValueOnce([{verified:false}]);
    await expect(review()).rejects.toThrow('target verification failed');
    expect(source.$queryRaw).toHaveBeenCalledTimes(1);
    expect(readToken).not.toHaveBeenCalled();
  });

  it.each([null,'invalid-token'])('denies missing and malformed credentials before a session lookup (%s)',async value=>{
    const {source,readToken,review}=setup();
    readToken.mockReturnValue(value);
    await expect(review()).rejects.toThrow('Forbidden');
    expect(source.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('denies unresolved sessions and detects duplicate rows instead of proceeding',async()=>{
    const {source,review}=setup();
    source.$queryRaw.mockResolvedValueOnce([{verified:true}]).mockResolvedValueOnce([]);
    await expect(review()).rejects.toThrow('Forbidden');
    expect(source.$queryRaw).toHaveBeenCalledTimes(2);
    const actorRow={authority,id:staff,role:'BILLING',active:true};
    source.$queryRaw.mockResolvedValueOnce([{verified:true}]).mockResolvedValueOnce([actorRow,actorRow]);
    await expect(review()).rejects.toThrow('data integrity mismatch');
    expect(source.$queryRaw).toHaveBeenCalledTimes(4);
  });

  it('rejects foreign and malformed lookups without querying and retains exact version strings',async()=>{
    const {source,repository}=setup();
    await repository.readSnapshot(async snapshot=>{
      expect(await snapshot.findTrip('other-office',trip)).toBeNull();
      expect(await snapshot.findVehicle(authority,'a legacy label')).toBeNull();
      expect(await snapshot.findReceipt('other-office',operation)).toBeNull();
      expect(source.$queryRaw).toHaveBeenCalledTimes(1);
      expect(await snapshot.findTrip(authority,trip)).toMatchObject({id:trip,version:'9007199254740993'});
      const [,query]=source.$queryRaw.mock.calls;
      expect(query.slice(1)).toEqual([authority,trip]);
    });
  });
});
