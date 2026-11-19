/** Money is handled as integer centavos to avoid floating point rounding. */
export type TripCharge = { tripId: string; customerId: string; amountCentavos: bigint; soaId?: string | null };
export type SoaDraft = { customerId: string; tripIds: string[] };
export type Allocation = { amountCentavos: bigint; withheldCentavos: bigint };
export function assertSoaEligible(trips: TripCharge[], draft: SoaDraft): bigint {
  if (!draft.customerId || !draft.tripIds.length) throw new Error("Customer and at least one trip are required");
  const unique = new Set(draft.tripIds);
  if (unique.size !== draft.tripIds.length) throw new Error("Duplicate trip selection");
  if (trips.length !== unique.size || trips.some(t => !unique.has(t.tripId))) throw new Error("Some selected trips do not exist");
  let total = 0n;
  for (const trip of trips) {
    if (trip.customerId !== draft.customerId) throw new Error("Cannot mix customers in one SOA");
    if (trip.soaId) throw new Error("Trip already assigned to an SOA");
    if (trip.amountCentavos < 0n) throw new Error("Negative trip charge requires separate adjustment");
    total += trip.amountCentavos;
  }
  return total;
}
export function toCentavos(value: string): bigint {
  if (!/^-?\d+(\.\d{1,2})?$/.test(value.trim())) throw new Error("Invalid currency amount");
  const [whole, fraction = ""] = value.trim().split(".");
  const negative = whole.startsWith("-");
  const magnitude = BigInt(whole.replace("-", "")) * 100n + BigInt(fraction.padEnd(2,"0"));
  return negative ? -magnitude : magnitude;
}
export function fromCentavos(value: bigint): string {
  const abs = value < 0n ? -value : value;
  return `${value < 0n ? "-" : ""}${abs / 100n}.${String(abs % 100n).padStart(2,"0")}`;
}
export function remainingReceivable(invoiceCentavos: bigint, allocations: Allocation[]): bigint {
  if (invoiceCentavos < 0n) throw new Error("Invalid invoice amount");
  let applied = 0n;
  for (const allocation of allocations) {
    if (allocation.amountCentavos < 0n || allocation.withheldCentavos < 0n) throw new Error("Invalid payment allocation");
    applied += allocation.amountCentavos + allocation.withheldCentavos;
  }
  if (applied > invoiceCentavos) throw new Error("Payment allocations exceed invoice balance");
  return invoiceCentavos - applied;
}
export function normalizeCustomerName(name: string): string {
  const normalized = name.trim().replace(/\s+/g," ").toLocaleUpperCase("en");
  if (!normalized || normalized.length > 200) throw new Error("Invalid customer name");
  return normalized;
}
