import { describe, it, expect } from "vitest";
import { assertSoaEligible, toCentavos, fromCentavos, remainingReceivable, normalizeCustomerName } from "./billing";
describe("financial invariants", () => {
 it("converts money without floating point arithmetic", () => { expect(toCentavos("123.45")).toBe(12345n); expect(fromCentavos(-105n)).toBe("-1.05"); });
 it("rejects excessive precision", () => expect(() => toCentavos("1.234")).toThrow());
 it("prevents double billing", () => expect(() => assertSoaEligible([{tripId:"t",customerId:"c",amountCentavos:100n,soaId:"existing"}],{customerId:"c",tripIds:["t"]})).toThrow());
 it("prevents mixing customer trips", () => expect(() => assertSoaEligible([{tripId:"t",customerId:"other",amountCentavos:100n}],{customerId:"c",tripIds:["t"]})).toThrow());
 it("totals selected trips", () => expect(assertSoaEligible([{tripId:"a",customerId:"c",amountCentavos:100n},{tripId:"b",customerId:"c",amountCentavos:250n}],{customerId:"c",tripIds:["a","b"]})).toBe(350n));
 it("accounts for withholding and partial collections", () => expect(remainingReceivable(10000n,[{amountCentavos:7000n,withheldCentavos:500n}])).toBe(2500n));
 it("rejects over-allocation", () => expect(() => remainingReceivable(100n,[{amountCentavos:101n,withheldCentavos:0n}])).toThrow());
 it("normalizes company names", () => expect(normalizeCustomerName("  Lizardbear   inc ")).toBe("LIZARDBEAR INC"));
});
