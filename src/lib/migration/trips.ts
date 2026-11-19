/** Read-only migration preflight. Never writes to a database. */
export type LegacyTripRow = Record<string, unknown>;
export type TripIssue = { row: number; field: string; message: string };
export type TripPreflight = { accepted: number; excludedBefore2025: number; rejected: number; issues: TripIssue[] };

function asText(value: unknown): string { return value == null ? "" : String(value).trim(); }

/** Parse known ISO/US Access date formats and Excel date serials; reject ambiguous formats. */
export function parseLegacyDate(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : new Date(value.getTime());
  if (typeof value === "number") {
    if (!Number.isInteger(value) || value < 1 || value > 100000) return null;
    return new Date(Date.UTC(1899, 11, 30) + value * 86400000);
  }
  const raw = asText(value);
  if (!raw) return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(raw)
    ?? /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?)?$/i.exec(raw);
  if (!match) return null;
  const iso = /^\d{4}-/.test(raw);
  const year = Number(iso ? match[1] : match[3]);
  const month = Number(iso ? match[2] : match[1]);
  const day = Number(iso ? match[3] : match[2]);
  let hour = Number(match[4] ?? 0);
  const minute = Number(match[5] ?? 0);
  const second = Number(match[6] ?? 0);
  const ampm = iso ? undefined : match[7]?.toUpperCase();
  if (ampm) {
    if (hour < 1 || hour > 12) return null;
    hour = (hour % 12) + (ampm === "PM" ? 12 : 0);
  }
  if (year < 1900 || year > 2100 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59 || second > 59) return null;
  const d = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() + 1 !== month || d.getUTCDate() !== day) return null;
  return d;
}

export function preflightTrips(rows: LegacyTripRow[], minYear = 2025): TripPreflight {
  const issues: TripIssue[] = [];
  const ids = new Set<string>();
  let accepted = 0, excludedBefore2025 = 0, rejected = 0;
  rows.forEach((r, index) => {
    const row = index + 2;
    const tripId = asText(r.TripID ?? r.TripId ?? r.ID);
    const date = parseLegacyDate(r.DateOfTrip_Start ?? r.tripStart);
    if (date && date.getUTCFullYear() < minYear) { excludedBefore2025++; return; }
    const rowIssues: TripIssue[] = [];
    if (!tripId) rowIssues.push({ row, field: "TripID", message: "Missing legacy trip identifier" });
    else if (ids.has(tripId)) rowIssues.push({ row, field: "TripID", message: "Duplicate legacy trip identifier" });
    if (!date) rowIssues.push({ row, field: "DateOfTrip_Start", message: "Missing or invalid trip start date" });
    if (tripId) ids.add(tripId);
    if (rowIssues.length) { rejected++; issues.push(...rowIssues); }
    else accepted++;
  });
  return { accepted, excludedBefore2025, rejected, issues };
}
