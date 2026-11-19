/** Trip encoding calculations. Philippine local dates/times; exact customer charges. */
import { toCentavos } from './billing';
import { moneyGuard } from './trip-payments';
export type TripSchedule = { startDate: string; startTime: string; endDate: string; endTime: string };
export const chargeKeys = ['base', 'fuel', 'toll', 'parking', 'others'] as const;
export type TripCharges = Record<typeof chargeKeys[number], bigint> & { othersNote: string; food?: bigint; lodging?: bigint; otFee?: bigint };
export function tripChargeTotal(charges: TripCharges): bigint {
  let total = 0n;
  for (const key of chargeKeys) total += moneyGuard(charges[key]);
  return moneyGuard(total + moneyGuard(charges.food??0n) + moneyGuard(charges.lodging??0n) + moneyGuard(charges.otFee??0n));
}
export function readTripCharges(form: FormData): TripCharges {
  const value = (key: string) => String(form.get(key) ?? '').trim();
  return { base: toCentavos(value('baseAmount') || '0'), fuel: toCentavos(value('fuel') || '0'), toll: toCentavos(value('toll') || '0'), parking: toCentavos(value('parking') || '0'), others: toCentavos(value('others') || '0'), othersNote: value('othersNote'), otFee: toCentavos(value('otFee') || '0'), food: toCentavos(value('food') || '0'), lodging: toCentavos(value('lodging') || '0') };
}
function localMinutes(date: string, time: string): number {
  if (!/^[1-9]\d{3}-\d{2}-\d{2}$/.test(date) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new Error('Enter valid trip dates and times');
  const timestamp = Date.parse(`${date}T${time}:00+08:00`);
  if (!Number.isFinite(timestamp) || new Date(timestamp + 8 * 60 * 60 * 1000).toISOString().slice(0, 16) !== `${date}T${time}`) throw new Error('Enter valid trip dates and times');
  return timestamp / 60000;
}
export function tripDurationMinutes(schedule: TripSchedule): number {
  const duration = localMinutes(schedule.endDate, schedule.endTime) - localMinutes(schedule.startDate, schedule.startTime);
  if (duration <= 0) throw new Error('Trip end must be after trip start');
  return duration;
}
export function formatTripDuration(minutes: number): string {
  if (!Number.isSafeInteger(minutes) || minutes <= 0) throw new Error('Invalid trip duration');
  return `${Math.floor(minutes / 60)} h ${minutes % 60} min (${(minutes / 60).toFixed(2)} hours)`;
}


