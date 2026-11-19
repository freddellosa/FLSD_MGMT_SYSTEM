/** Pure proposal for a specifically confirmed same-date overnight record. Never a global date-repair rule. */
import {parseLegacyDate} from './trips';
export function proposeConfirmedNextDayEnd(recordedStart: string, recordedEnd: string) {
  const start = parseLegacyDate(recordedStart), end = parseLegacyDate(recordedEnd);
  if (!start || !end) throw new Error('Valid original local date/time required');
  if (start.toISOString().slice(0, 10) !== end.toISOString().slice(0, 10) || end.getTime() >= start.getTime()) throw new Error('Only confirmed same-date end-before-start cases are eligible');
  const proposed = new Date(end.getTime()); proposed.setUTCDate(proposed.getUTCDate() + 1);
  if (proposed.getUTCFullYear() > 2100 || proposed.getTime() <= start.getTime()) throw new Error('Proposed calendar date outside reviewed range');
  return {recordedStart, recordedEnd, proposedEndLocal: proposed.toISOString().slice(0, 19), endTimePreserved: true as const,
    change: 'END_CALENDAR_DATE_PLUS_ONE' as const, applyEnabled: false as const};
}
