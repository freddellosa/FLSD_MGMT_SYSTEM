/** Pure, database-independent financial guards. All money is integer centavos. */
export type PaymentSnapshot = {
  receivedCentavos: bigint;
  allocationsCentavos: bigint;
  completedRefundsCentavos: bigint;
  pendingRefundsCentavos: bigint;
};
export function availableCredit(p: PaymentSnapshot): bigint {
  for (const n of Object.values(p)) if (n < 0n) throw new Error('Negative financial component');
  const available = p.receivedCentavos - p.allocationsCentavos - p.completedRefundsCentavos - p.pendingRefundsCentavos;
  if (available < 0n) throw new Error('Payment overcommitted');
  return available;
}
export function assertCreditAvailable(p: PaymentSnapshot, requestedCentavos: bigint): void {
  if (requestedCentavos <= 0n) throw new Error('Amount must be positive');
  if (requestedCentavos > availableCredit(p)) throw new Error('Insufficient unapplied credit');
}
export type ProposedAllocation = {invoiceId: string; customerId: string; cashCentavos: bigint; withheldCentavos: bigint; outstandingCentavos: bigint};
export function validateAllocationProposal(customerId: string, payment: PaymentSnapshot, allocations: ProposedAllocation[]): bigint {
  const seen = new Set<string>();
  let cash = 0n;
  for (const a of allocations) {
    if (!a.invoiceId || seen.has(a.invoiceId)) throw new Error('Duplicate or missing invoice');
    seen.add(a.invoiceId);
    if (a.customerId !== customerId) throw new Error('Cross-customer allocation');
    if (a.cashCentavos < 0n || a.withheldCentavos < 0n || a.outstandingCentavos < 0n) throw new Error('Negative amount');
    if (a.cashCentavos + a.withheldCentavos <= 0n) throw new Error('Zero allocation');
    if (a.cashCentavos + a.withheldCentavos > a.outstandingCentavos) throw new Error('Invoice overallocated');
    cash += a.cashCentavos;
  }
  if (cash > availableCredit(payment)) throw new Error('Payment cash overallocated');
  return cash;
}
export type RefundStatus = 'PENDING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
export function nextRefundStatus(current: RefundStatus, next: RefundStatus): RefundStatus {
  if (current !== 'PENDING' || !['COMPLETED', 'FAILED', 'CANCELLED'].includes(next)) throw new Error('Invalid refund transition');
  return next;
}
export type SoaReleaseFacts = {soaCancelled: boolean; linkedInvoiceCount: number; unreconciledInvoiceCount: number; unreconciledPaymentCount: number};
export function canReleaseSoaTrip(f: SoaReleaseFacts): boolean {
  if ([f.linkedInvoiceCount, f.unreconciledInvoiceCount, f.unreconciledPaymentCount].some(n => !Number.isInteger(n) || n < 0)) throw new Error('Invalid reconciliation counts');
  return f.soaCancelled && f.unreconciledInvoiceCount === 0 && f.unreconciledPaymentCount === 0;
}
export function isUnmatchedResolved(unmatchedCashCentavos: bigint, outstandingReferenceCount: number): boolean {
  if (unmatchedCashCentavos < 0n || !Number.isInteger(outstandingReferenceCount) || outstandingReferenceCount < 0) throw new Error('Invalid unmatched state');
  return unmatchedCashCentavos === 0n && outstandingReferenceCount === 0;
}
