/** Offline design: transaction orchestration behind an unimplemented persistence adapter.
 * All amounts are integer centavos; never call this without a server-side authorized actor.
 * The adapter MUST provide a single SERIALIZABLE database transaction, stable lock ordering,
 * and atomic ledger+audit writes. No database integration is included in this package.
 */
import { availableCredit, validateAllocationProposal, type PaymentSnapshot, type ProposedAllocation } from './financial-ledger';

export type AuthorizedActor = { id: string; role: 'OWNER' | 'ADMIN' | 'BILLING' };
export type AllocationRequest = { invoiceId: string; cashCentavos: bigint; withheldCentavos: bigint };
export type PaymentAllocationCommand = {
  paymentId: string; customerId: string; idempotencyKey: string; actor: AuthorizedActor;
  allocations: AllocationRequest[]; reason: string;
};
export type PaymentAllocationReceipt = { operationId: string; allocatedCashCentavos: bigint; replayed: boolean };
export type LockedPayment = PaymentSnapshot & { customerId: string; state: 'RECORDED' | 'VOIDED' };
export type LockedInvoice = { id: string; customerId: string; outstandingCentavos: bigint; eligible: boolean };
export interface AllocationTransaction {
  /** Find a committed operation with same idempotency key. If same key but different payload, throw. */
  findOperation(key: string, payloadDigest: string): Promise<{ operationId: string; allocatedCashCentavos: bigint } | null>;
  /** Lock payment and invoices in deterministic order, or equivalent SERIALIZABLE protection. */
  lockPayment(paymentId: string): Promise<LockedPayment>;
  lockInvoices(idsSorted: string[]): Promise<LockedInvoice[]>;
  /** Must write allocation events and audit in same transaction, without overwriting history. */
  appendAllocationAndAudit(input: { command: PaymentAllocationCommand; totalCashCentavos: bigint; payloadDigest: string }): Promise<string>;
}
export interface AllocationStore {
  /** Must retry PostgreSQL serialization conflicts (P2034/40001) in a bounded manner. */
  serializable<T>(fn: (tx: AllocationTransaction) => Promise<T>): Promise<T>;
}
function assertNonempty(value: string, name: string) {
  if (!value || !value.trim()) throw new Error(`${name} required`);
}
function canonicalPayload(command: PaymentAllocationCommand): string {
  // Stable canonical representation for idempotency. Digest is computed by persistence layer
  // using SHA-256; this string is NOT a cryptographic hash.
  return JSON.stringify({operationType: "ALLOCATE_PAYMENT", actorId: command.actor.id, actorRole: command.actor.role, reason: command.reason, paymentId: command.paymentId, customerId: command.customerId,
    allocations: [...command.allocations].sort((a,b)=>a.invoiceId.localeCompare(b.invoiceId))
      .map(a=>[a.invoiceId,a.cashCentavos.toString(),a.withheldCentavos.toString()])});
}
export async function confirmPaymentAllocation(
  store: AllocationStore,
  command: PaymentAllocationCommand,
  sha256: (value: string) => string,
): Promise<PaymentAllocationReceipt> {
  const prepared = prepareAllocation(command, sha256);
  return store.serializable(tx => applyAllocation(tx, prepared.command, prepared.digest));
}

/** Pure transaction-scoped entry point for a future reviewed common coordinator.
 * Caller owns authentication, SERIALIZABLE/lock protocol, commit and retry.
 * Does not open a transaction, connect a provider or enable posting.
 */
export async function confirmPaymentAllocationInTransaction(
  tx: AllocationTransaction,
  command: PaymentAllocationCommand,
  sha256: (value: string) => string,
): Promise<PaymentAllocationReceipt> {
  const prepared = prepareAllocation(command, sha256);
  return applyAllocation(tx, prepared.command, prepared.digest);
}

function prepareAllocation(input: PaymentAllocationCommand, sha256: (value: string) => string) {
  const command = structuredClone(input);
  for (const [key, val] of Object.entries({paymentId:command.paymentId,customerId:command.customerId,idempotencyKey:command.idempotencyKey,actorId:command.actor.id,reason:command.reason})) assertNonempty(val,key);
  if (!['OWNER','ADMIN','BILLING'].includes(command.actor.role)) throw new Error('Unauthorized role');
  if (!command.allocations.length) throw new Error('At least one allocation required');
  const digest = sha256(canonicalPayload(command));
  assertNonempty(digest,'payload digest');
  return {command, digest};
}

async function applyAllocation(tx: AllocationTransaction, command: PaymentAllocationCommand, digest: string): Promise<PaymentAllocationReceipt> {
    const prior = await tx.findOperation(command.idempotencyKey, digest);
    if (prior) return {...prior,replayed:true};
    const payment = await tx.lockPayment(command.paymentId);
    if (payment.customerId !== command.customerId || payment.state !== 'RECORDED') throw new Error('Payment not eligible');
    const ids = command.allocations.map(a=>a.invoiceId);
    if (new Set(ids).size !== ids.length) throw new Error('Duplicate invoice');
    const invoices = await tx.lockInvoices([...ids].sort());
    if (invoices.length !== ids.length) throw new Error('Invoice missing');
    const byId = new Map(invoices.map(i=>[i.id,i]));
    const proposed: ProposedAllocation[] = command.allocations.map(a=>{
      const invoice = byId.get(a.invoiceId);
      if (!invoice || !invoice.eligible) throw new Error('Invoice not eligible');
      return {...a,customerId:invoice.customerId,outstandingCentavos:invoice.outstandingCentavos};
    });
    // Explicit credit check and cross-customer/overpayment checks are all under locks.
    availableCredit(payment);
    const totalCashCentavos = validateAllocationProposal(command.customerId,payment,proposed);
    const operationId = await tx.appendAllocationAndAudit({command,totalCashCentavos,payloadDigest:digest});
    return {operationId,allocatedCashCentavos:totalCashCentavos,replayed:false};
}
