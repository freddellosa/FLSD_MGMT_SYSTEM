/** Counter proposals only. Durable reservation must share the existing server transaction/idempotency protocol. */
export type BusinessNumberKind = 'TRIP' | 'DRIVER' | 'VEHICLE' | 'COMPANY' | 'SOA';
export type BusinessNumberCounter = {kind: BusinessNumberKind; next: bigint | null; revision: number};
const kinds: readonly string[] = ['TRIP', 'DRIVER', 'VEHICLE', 'COMPANY', 'SOA'];
const max = 9223372036854775807n;
function kind(value: BusinessNumberKind) {if (!kinds.includes(value)) throw new Error('Unsupported number series; official invoice stock is separate');}

/** Call only with the complete reviewed imported/live business-number set, never a partial sample. */
export function seedBusinessNumberCounter(series: BusinessNumberKind, existing: readonly string[]): BusinessNumberCounter {
  kind(series);
  if (!Array.isArray(existing) || existing.length > 1000000) throw new Error('Bounded reviewed business-number list required');
  let highest = 0n;
  const seen = new Set<string>();
  for (const value of existing) {
    if (typeof value !== 'string' || !/^\d{1,19}$/.test(value) || seen.has(value)) throw new Error('Unique integer business numbers required; retain nonnumeric legacy keys separately for review');
    seen.add(value);
    const number = BigInt(value);
    if (number < 1n || number > max) throw new Error('Business number outside reviewed counter range');
    if (number > highest) highest = number;
  }
  return {kind: series, next: highest === max ? null : highest + 1n, revision: 0};
}

/** Pure transition, not a database allocation or proof of concurrency safety. Never use client counters as authority. */
export function proposeBusinessNumber(counter: BusinessNumberCounter, expectedRevision: number) {
  kind(counter.kind);
  if (!Number.isSafeInteger(counter.revision) || counter.revision < 0 || counter.revision !== expectedRevision || counter.revision === Number.MAX_SAFE_INTEGER) throw new Error('Current counter revision required');
  if (counter.next === null) throw new Error('Business number series exhausted');
  if (typeof counter.next !== 'bigint' || counter.next < 1n || counter.next > max) throw new Error('Invalid authoritative counter value');
  return {kind: counter.kind, businessNumber: counter.next.toString(),
    nextCounter: {kind: counter.kind, next: counter.next === max ? null : counter.next + 1n, revision: counter.revision + 1},
    executionAuthorized: false as const,
    note: 'Commit counter, entity, operation receipt and audit atomically with locking/unique constraints; apply no state from client input.'};
}
