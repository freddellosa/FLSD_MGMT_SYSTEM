import { describe, expect, it } from 'vitest';
import { formatTripDuration, tripChargeTotal, tripDurationMinutes, type TripCharges } from './trip-encoding';
import { MAX_CENTAVOS } from './trip-payments';
const charges:TripCharges={base:1000000n,fuel:150025n,toll:80010n,parking:20000n,others:9965n,othersNote:'Additional customer charge'};
const schedule={startDate:'2026-11-14',startTime:'22:15',endDate:'2026-11-16',endTime:'01:45'};
describe('Trip duration and charge breakdown',()=>{
 it('totals base and itemized customer charges to exact centavos',()=>expect(tripChargeTotal(charges)).toBe(1260000n));
 it('supports no additional charges',()=>expect(tripChargeTotal({...charges,fuel:0n,toll:0n,parking:0n,others:0n})).toBe(1000000n));
 it('rejects negative line items',()=>expect(()=>tripChargeTotal({...charges,toll:-1n})).toThrow());
 it('rejects aggregate overflow',()=>expect(()=>tripChargeTotal({...charges,base:MAX_CENTAVOS})).toThrow());
 it('computes overnight and multi-day elapsed hours',()=>{expect(tripDurationMinutes(schedule)).toBe(1650);expect(formatTripDuration(1650)).toBe('27 h 30 min (27.50 hours)');});
 it('computes minute precision without rounding hours up',()=>expect(formatTripDuration(61)).toBe('1 h 1 min (1.02 hours)'));
 it('handles leap days',()=>expect(tripDurationMinutes({startDate:'2028-02-28',startTime:'23:30',endDate:'2028-02-29',endTime:'00:30'})).toBe(60));
 it.each(['2026-02-30','2026-02-29','2026-13-01','not-a-date'])('rejects invalid date %s',startDate=>expect(()=>tripDurationMinutes({...schedule,startDate})).toThrow());
 it.each(['24:00','12:60','','9:30'])('rejects invalid time %s',startTime=>expect(()=>tripDurationMinutes({...schedule,startTime})).toThrow());
 it('rejects equal and reversed end times',()=>{expect(()=>tripDurationMinutes({...schedule,endDate:'2026-11-14',endTime:'22:15'})).toThrow('after');expect(()=>tripDurationMinutes({...schedule,endDate:'2026-11-14',endTime:'22:14'})).toThrow('after');});
});
