import {describe, expect, it} from 'vitest';
import {proposeConfirmedNextDayEnd} from './confirmed-next-day';
describe('Owner-confirmed specific next-day end proposals', () => {
  it('changes only the calendar date and preserves the recorded end time', () => {
    expect(proposeConfirmedNextDayEnd('10/15/2026 19:00:00', '10/15/2026 5:45:00')).toMatchObject({proposedEndLocal: '2026-10-16T05:45:00', endTimePreserved: true, applyEnabled: false});
  });
  it.each([
    ['9/30/2026 19:00:00', '9/30/2026 5:30:00', '2026-10-01T05:30:00'],
    ['12/31/2026 20:00:00', '12/31/2026 6:00:00', '2027-01-01T06:00:00'],
    ['2/28/2028 20:00:00', '2/28/2028 6:00:00', '2028-02-29T06:00:00'],
  ])('handles the calendar boundary %s without timezone conversion', (start, end, expected) => {
    expect(proposeConfirmedNextDayEnd(start, end).proposedEndLocal).toBe(expected);
  });
  it('honors the explicitly confirmed 13:00-to-next-day-12:00 case', () => {
    expect(proposeConfirmedNextDayEnd('10/2/2026 13:00:00', '10/2/2026 12:00:00').proposedEndLocal).toBe('2026-10-03T12:00:00');
  });
  it.each([
    ['10/2/2026 13:00:00', '10/3/2026 12:00:00'],
    ['10/2/2026 08:00:00', '10/2/2026 17:00:00'],
    ['10/2/2026 08:00:00', '10/2/2026 08:00:00'],
    ['invalid', '10/2/2026 08:00:00'],
  ])('rejects already corrected, same-day valid/equal or invalid input %s', (start, end) => {
    expect(() => proposeConfirmedNextDayEnd(start, end)).toThrow();
  });
});
