import type {DemoTrip} from './store';
import {manualTripTotal, tripVat} from '../domain/trip-reference';
import {tripChargeTotal} from '../domain/trip-encoding';
import {formatAmount} from './display';

/** Display projection only. Unknown or inconsistent recorded treatment is never inferred. */
export function billingVatSummary(trips: readonly DemoTrip[], snapshot: bigint) {
  let net = 0n, vat = 0n, expenses = 0n, gross = 0n;
  if (!trips.length) return null;
  try {
    for (const trip of trips) {
      const c = trip.charges, r = trip.reference;
      if (!c || !r || r.withholdingReference !== 0n || !['ADDED', 'INCLUDED', 'NONE'].includes(r.vatTreatment ?? '')) return null;
      if (r.vatTreatment === 'NONE' ? r.vatReference !== 0n : tripVat(c, r.vatTreatment!) !== r.vatReference) return null;
      if (manualTripTotal(c, r) !== trip.amount) return null;
      const service = c.base + (c.otFee ?? 0n);
      if (r.vatTreatment === 'INCLUDED' && r.vatReference > service) return null;
      net += service - (r.vatTreatment === 'INCLUDED' ? r.vatReference : 0n);
      vat += r.vatReference;
      expenses += tripChargeTotal(c) - service;
      gross += trip.amount;
    }
  } catch { return null; }
  if (gross !== snapshot || net + vat + expenses !== gross) return null;
  return {net, vat, expenses, gross};
}

export function renderBillingVatSummary(trips: readonly DemoTrip[], snapshot: bigint) {
  const summary = billingVatSummary(trips, snapshot);
  if (!summary) return '<p class="small">Recorded amounts retained. A VAT-exclusive breakdown is unavailable for records with unspecified or inconsistent tax treatment.</p>';
  return '<section aria-label="Net charges and VAT summary" style="break-inside:avoid"><h3>Net charges and VAT summary · PHP</h3><table style="width:100%;border-collapse:collapse"><tbody>' +
    ([['Base + OT excluding VAT', summary.net], ['VAT', summary.vat], ['Expenses excluded from VAT calculation', summary.expenses], ['Total', summary.gross]] as const)
      .map(([label, value]) => '<tr><td>' + label + '</td><td style="text-align:right;white-space:nowrap">' + formatAmount(value) + '</td></tr>').join('') +
    '</tbody></table><p class="small">Included VAT is extracted from the entered Base + OT quote. This summary is a breakdown of the total, not an additional charge.</p></section>';
}
