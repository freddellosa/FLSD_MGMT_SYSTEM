/** Pure financial rules. No persistence, authentication, tax or revenue posting. */
import { availableCredit, type PaymentSnapshot } from './financial-ledger';
export const MAX_CENTAVOS = 999999999999999999n;
export function moneyGuard(n: bigint, positive = false): bigint {
  if (typeof n !== 'bigint' || n < 0n || n > MAX_CENTAVOS || (positive && n === 0n)) throw new Error('Enter a valid positive amount within the currency limit');
  return n;
}
export function assertTripScope(payment: { customerId: string; restrictedTripId: string | null }, trip: { id: string; customerId: string }) {
  if (payment.customerId !== trip.customerId) throw new Error('Cross-customer allocation is prohibited');
  if (payment.restrictedTripId !== null && payment.restrictedTripId !== trip.id) throw new Error('Direct payment cannot be used on another trip');
}
export function classifyReceipt(amount: bigint, capacity: bigint, purpose: 'SETTLEMENT' | 'ADVANCE' | 'DEPOSIT') {
  moneyGuard(amount, true); moneyGuard(capacity);
  const eligible = amount < capacity ? amount : capacity;
  return { applied: purpose === 'SETTLEMENT' ? eligible : 0n, advance: purpose === 'SETTLEMENT' ? 0n : eligible, excess: amount - eligible };
}
export function assertTripAllocation(snapshot: PaymentSnapshot, requested: bigint, outstanding: bigint, refundOnlyUnreserved: bigint) {
  moneyGuard(requested, true); moneyGuard(outstanding); moneyGuard(refundOnlyUnreserved);
  const credit = availableCredit(snapshot);
  if (refundOnlyUnreserved > credit || requested > credit - refundOnlyUnreserved) throw new Error('Advance unavailable: reserved or refund-only funds cannot be allocated');
  if (requested > outstanding) throw new Error('Allocation exceeds trip balance');
}
export function assertRefundReservation(snapshot: PaymentSnapshot, requested: bigint, refundableUnreserved: bigint) {
  moneyGuard(requested, true); moneyGuard(refundableUnreserved);
  if (requested > availableCredit(snapshot) || requested > refundableUnreserved) throw new Error('Refund exceeds unreserved excess credit');
}
export type TripRefundState = 'REQUESTED' | 'APPROVED' | 'PROCESSING' | 'RECONCILIATION_REQUIRED' | 'COMPLETED' | 'REJECTED' | 'CANCELLED' | 'FAILED';
export const reservesRefund = (state: TripRefundState) => ['REQUESTED', 'APPROVED', 'PROCESSING', 'RECONCILIATION_REQUIRED'].includes(state);
export function refundTransition(current: TripRefundState, next: TripRefundState, role: string): TripRefundState {
  if (!['OWNER', 'ADMIN', 'BILLING'].includes(role)) throw new Error('Only Owner, Admin or Billing may manage refunds');
  const transitions: Record<TripRefundState, TripRefundState[]> = {
    REQUESTED: ['APPROVED', 'REJECTED', 'CANCELLED'], APPROVED: ['PROCESSING', 'CANCELLED'],
    PROCESSING: ['COMPLETED', 'FAILED', 'RECONCILIATION_REQUIRED'], RECONCILIATION_REQUIRED: ['COMPLETED', 'FAILED'],
    COMPLETED: [], FAILED: [], REJECTED: [], CANCELLED: [],
  };
  if (!transitions[current].includes(next)) throw new Error('Invalid refund transition or duplicate refund');
  return next;
}
export function assertAllocationReversal(original: bigint, reversed: bigint, requested: bigint) {
  moneyGuard(original, true); moneyGuard(reversed); moneyGuard(requested, true);
  if (reversed > original || requested > original - reversed) throw new Error('Reversal exceeds original allocation');
}
export function assertPaymentVoid(facts: { allocated: bigint; reserved: bigint; refunded: bigint; hasCustodyHistory: boolean }) {
  if (facts.allocated !== 0n || facts.reserved !== 0n || facts.refunded !== 0n || facts.hasCustodyHistory) throw new Error('Reverse and reconcile payment dependencies before voiding');
}
export type RemittanceState = 'TENDERED' | 'ACCEPTED' | 'PARTIAL' | 'REJECTED';
export function acceptRemittance(state: RemittanceState, tendered: bigint, counted: bigint, held: bigint): RemittanceState {
  moneyGuard(tendered, true); moneyGuard(counted); moneyGuard(held);
  if (state !== 'TENDERED') throw new Error('Remittance already closed');
  if (counted > tendered || counted > held) throw new Error('Counted cash exceeds tendered or driver-held cash');
  return counted === 0n ? 'REJECTED' : counted === tendered ? 'ACCEPTED' : 'PARTIAL';
}
