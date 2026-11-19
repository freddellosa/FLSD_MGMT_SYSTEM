import { describe, expect, it } from "vitest";
import { preflightTrips, parseLegacyDate } from "./trips";
describe("legacy trips preflight", () => {
 it("excludes historical trips without counting them as errors",()=>{
  expect(preflightTrips([{TripID:1,DateOfTrip_Start:"2024-12-31"},{TripID:2,DateOfTrip_Start:"2025-01-01"}])).toMatchObject({accepted:1,excludedBefore2025:1,rejected:0});
 });
 it("rejects duplicate ids and invalid dates",()=>{
  const result=preflightTrips([{TripID:"A",DateOfTrip_Start:"2025-02-01"},{TripID:"A",DateOfTrip_Start:"2026-02-01"},{TripID:"C",DateOfTrip_Start:"nonsense"}]);
  expect(result).toMatchObject({accepted:1,rejected:2});
  expect(result.issues.map(x=>x.field)).toContain("TripID");
 });
 it("accepts Excel date serials",()=>expect(parseLegacyDate(45658)?.getUTCFullYear()).toBe(2025));
 it("does not mutate imported data",()=>{
  const row={TripID:1,DateOfTrip_Start:"2025-01-01"}; preflightTrips([row]); expect(row.TripID).toBe(1);
 });
});
describe("strict date safety", () => {
 it("rejects impossible dates instead of rolling them into another month", () => {
  expect(parseLegacyDate("2025-02-30")).toBeNull();
  expect(parseLegacyDate("2025-13-01")).toBeNull();
 });
 it("rejects ambiguous non-ISO strings", () => expect(parseLegacyDate("03-04-2025")).toBeNull());
 it("handles Access US date with AM/PM", () => expect(parseLegacyDate("12/31/2025 11:45 PM")?.toISOString()).toBe("2025-12-31T23:45:00.000Z"));
 it("does not import duplicate IDs after a malformed first record", () => {
  const result = preflightTrips([{TripID:"T-1",DateOfTrip_Start:"invalid"},{TripID:"T-1",DateOfTrip_Start:"2025-04-01"}]);
  expect(result.rejected).toBe(2);
 });
});
