import { describe, expect, it } from 'vitest';
import { parseSerialRange, rangesOverlap, remainingStock } from './serial-stock';
describe('official invoice serial stock', () => {
  it('rejects zero, reversed, nonnumeric, and unsafe-length ranges', () => {
    for (const [start,end] of [['0','5'],['6','5'],['A','3'],['1234567890123456789','1234567890123456789']]) {
      expect(() => parseSerialRange(start,end)).toThrow();
    }
  });
  it('detects shared endpoints as overlapping', () => {
    expect(rangesOverlap(parseSerialRange('100','200'),parseSerialRange('200','300'))).toBe(true);
    expect(rangesOverlap(parseSerialRange('100','199'),parseSerialRange('200','300'))).toBe(false);
  });
  it('counts unique used serials within a batch', () => {
    expect(remainingStock(parseSerialRange('10','12'),[10n,10n,11n,99n])).toBe(1n);
  });
});
