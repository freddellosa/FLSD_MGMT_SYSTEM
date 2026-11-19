import {createHash} from 'node:crypto';
import {describe,expect,it} from 'vitest';
import {actor,cases,ids,largeVersion,prepareSyntheticTripReaderFixture,replayTrip} from '../../../tests/main-trip-reader/fixture';
import {reviewOperationalReplay} from './operational-envelope';

describe('Synthetic connected trip-reader fixture',()=>{
  it('uses unique transient tokens and emits only their digests in the approved namespace',()=>{
    const {sql,tokens}=prepareSyntheticTripReaderFixture();
    expect(new Set(Object.values(tokens)).size).toBe(cases.length);
    for(const kind of cases){
      expect(tokens[kind]).toMatch(/^[0-9a-f]{64}$/);
      expect(sql).not.toContain(tokens[kind]);
      expect(sql).toContain(createHash('sha256').update(tokens[kind]).digest('hex'));
    }
    expect([...sql.matchAll(/^INSERT INTO ([^.]+)\./gm)].map(match=>match[1])).toEqual(Array(8).fill('flsd_operational'));
    expect(sql).not.toMatch(/\b(?:DELETE FROM|UPDATE|TRUNCATE|DROP|COMMIT)\b/);
  });
  it('includes separate denied session cases and an exact version bound to a committed receipt',()=>{
    const {sql}=prepareSyntheticTripReaderFixture();
    expect(sql).toContain("statement_timestamp()-interval '1 minute'");
    expect(sql).toContain("statement_timestamp()+interval '1 hour',statement_timestamp()");
    expect(sql).toContain(`'${ids.inactive}','BILLING',false`);
    expect(sql).toContain(`'${ids.viewer}','VIEWER',true`);
    const digest=reviewOperationalReplay(replayTrip,actor,null,[]).digest;
    expect(sql).toContain(`decode('${digest}','hex'),'${ids.trip}',${largeVersion}`);
  });
});
