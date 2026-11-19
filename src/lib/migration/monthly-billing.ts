/** Owner-declared historical monthly cycles. Exact source evidence; no posting or price allocation. */
import {accessMoney, type AccessRow} from './access-staging';
import {fromCentavos} from '../domain/billing';
import {parseLegacyDate} from './trips';
export type MonthlyBillingDefinition = {customerId: string; month: string; fixedChargeTripId: string; contractTerm: 'ANNUAL'; billingUnit: 'CUSTOMER'};
export type MonthlyUsageEvidence = {sourceTripId: string; customerId: string; month: string; fixedChargeTripId: string};
export function reviewMonthlyBilling(trips: readonly AccessRow[], definitions: readonly MonthlyBillingDefinition[]) {
  const identities = new Map<string, AccessRow>();
  for (const trip of trips) { if (!trip.tmpInvoiceNo?.trim() || identities.has(trip.tmpInvoiceNo)) throw new Error('Unique source Trip IDs required for monthly review'); identities.set(trip.tmpInvoiceNo, trip); }
  const cycles = new Set<string>();
  return definitions.map(definition => {
    const key = JSON.stringify([definition.customerId, definition.month]);
    if (!definition.customerId?.trim() || !/^\d{4}-(0[1-9]|1[0-2])$/.test(definition.month) || definition.contractTerm !== 'ANNUAL' || definition.billingUnit !== 'CUSTOMER' || cycles.has(key)) throw new Error('Invalid or duplicate monthly customer cycle');
    cycles.add(key);
    const fixed = identities.get(definition.fixedChargeTripId);
    const month = (row: AccessRow) => parseLegacyDate(row.DateOfTrip_Start)?.toISOString().slice(0, 7);
    if (!fixed || fixed.CompanyID !== definition.customerId || month(fixed) !== definition.month) throw new Error('Monthly charge row must match customer and month');
    const fixedGross = accessMoney(fixed.InvoiceTotAmt), fixedBase = accessMoney(fixed.BaseAmount);
    if (fixedGross <= 0n || fixedBase <= 0n) throw new Error('Designated monthly charge must contain a positive recorded fixed rate');
    const members = trips.filter(t => t.CompanyID === definition.customerId && month(t) === definition.month);
    const usage = members.filter(t => t.tmpInvoiceNo !== definition.fixedChargeTripId);
    let extrasGross = 0n;
    const usageRows = usage.map(t => {
      const gross = accessMoney(t.InvoiceTotAmt), base = accessMoney(t.BaseAmount);
      if (base !== 0n) throw new Error('Additional base charges need review before confirming one monthly fixed-rate row');
      extrasGross += gross;
      return {sourceTripId: t.tmpInvoiceNo, role: 'MONTHLY_USAGE' as const, recordedExtraGross: fromCentavos(gross),
        zeroGross: gross === 0n, fixedChargeTripId: definition.fixedChargeTripId, hasRecordedExtraCharge: gross > 0n, receivableCreated: false};
    });
    return {definition: {...definition}, fixedCharge: {sourceTripId: definition.fixedChargeTripId, recordedBase: fromCentavos(fixedBase), recordedGross: fromCentavos(fixedGross)},
      usageRows, usageEvidence: usageRows.map(t => ({sourceTripId: t.sourceTripId, customerId: definition.customerId, month: definition.month, fixedChargeTripId: definition.fixedChargeTripId})),
      totals: {fixedGross: fromCentavos(fixedGross), recordedExtrasGross: fromCentavos(extrasGross), combinedRecordedGross: fromCentavos(fixedGross + extrasGross)},
      fixedChargeCounted: 1, receiptsCreated: 0, allocationsCreated: 0, importEnabled: false as const,
      notes: ['Monthly fixed charge remains on its designated row once; it is not repeated or spread across usage trips.',
        'Recorded OT/other charge amounts remain on their original usage rows; gross is not taxed again.',
        'Zero-gross usage is operational history, not Paid status or an additional receivable.',
        'Annual contract start/end and future monthly prices are not inferred from this one source period.']};
  });
}
