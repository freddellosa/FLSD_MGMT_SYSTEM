/** Pure validation for preprinted BIR invoice serial stock. */
export type SerialRange = { start: bigint; end: bigint };
export function parseSerialRange(start: string, end: string): SerialRange {
  if (!/^\d{1,18}$/.test(start) || !/^\d{1,18}$/.test(end)) throw new Error('Serial range must contain positive integers');
  const range = {start: BigInt(start), end: BigInt(end)};
  if (range.start < 1n || range.end < range.start) throw new Error('Invalid serial range');
  return range;
}
export function rangesOverlap(a: SerialRange, b: SerialRange): boolean {
  return a.start <= b.end && b.start <= a.end;
}
export function remainingStock(range: SerialRange, used: readonly bigint[]): bigint {
  const unique = new Set(used.filter(serial => serial >= range.start && serial <= range.end).map(String));
  return range.end - range.start + 1n - BigInt(unique.size);
}
