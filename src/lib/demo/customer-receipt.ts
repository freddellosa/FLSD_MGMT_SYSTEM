import {validateAllocationProposal} from '../domain/financial-ledger';
import {moneyGuard} from '../domain/trip-payments';

export type ReceiptInvoice = {
  id: string;
  customerId: string;
  version: number;
  trips: {id: string; balance: bigint}[];
};

export type ReceiptSplit = {invoiceId: string; expectedVersion: number; amount: bigint};

export function planCustomerReceipt(customerId: string, amount: bigint, splits: ReceiptSplit[], invoices: ReceiptInvoice[]) {
  moneyGuard(amount, true);
  if (!Array.isArray(splits) || !splits.length || splits.length > 1000) throw new Error('Select at least one invoice');
  const seen = new Set<string>();
  const eligible = new Map(invoices.map(invoice => [invoice.id, invoice]));
  const proposals = splits.map(split => {
    const invoice = eligible.get(split.invoiceId);
    if (!invoice) throw new Error('Invoice is not eligible');
    if (invoice.version !== split.expectedVersion) throw new Error('Invoice changed. Refresh before recording payment.');
    if (seen.has(invoice.id)) throw new Error('Duplicate invoice');
    seen.add(invoice.id);
    moneyGuard(split.amount, true);
    return {invoice, invoiceId: invoice.id, customerId: invoice.customerId,
      cashCentavos: split.amount, withheldCentavos: 0n,
      outstandingCentavos: invoice.trips.reduce((total, trip) => total + trip.balance, 0n)};
  });
  const allocated = validateAllocationProposal(customerId, {
    receivedCentavos: amount, allocationsCentavos: 0n, pendingRefundsCentavos: 0n, completedRefundsCentavos: 0n,
  }, proposals);
  if (allocated !== amount) throw new Error('Allocate the full receipt');
  return proposals.flatMap(({invoice, cashCentavos}) => {
    let remaining = cashCentavos;
    return invoice.trips.flatMap(trip => {
      const applied = remaining < trip.balance ? remaining : trip.balance;
      remaining -= applied;
      return applied > 0n ? [{invoiceId: invoice.id, tripId: trip.id, amount: applied}] : [];
    });
  });
}
