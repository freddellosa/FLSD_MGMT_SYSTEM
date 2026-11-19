import { fromCentavos, toCentavos } from './billing';

export type InvoiceSnapshot = { gross: string; vat: string; withholding: string };
export function invoiceTotals(items: Array<{amount: string}>, vat: string = '0.00', withholding: string = '0.00'): InvoiceSnapshot {
  if (!items.length) throw new Error('Invoice must contain billed trips');
  const gross = items.reduce((sum, item) => {
    const cents = toCentavos(item.amount);
    if (cents < 0n) throw new Error('Negative billed item');
    return sum + cents;
  }, 0n);
  const vatCents = toCentavos(vat), withholdingCents = toCentavos(withholding);
  if (vatCents < 0n || withholdingCents < 0n || withholdingCents > gross + vatCents) throw new Error('Invalid tax amounts');
  return {gross: fromCentavos(gross), vat: fromCentavos(vatCents), withholding: fromCentavos(withholdingCents)};
}
export function validateSerial(serial: string): string {
  const normalized = serial.trim();
  if (!/^\d{1,20}$/.test(normalized)) throw new Error('Official invoice serial must contain digits only');
  return normalized;
}
export function canReplaceInvoice(state: string): boolean { return state === 'CANCELLED' || state === 'SPOILED'; }
export function canAllocatePayment(state: string): boolean { return state === 'PRINTED'; }
