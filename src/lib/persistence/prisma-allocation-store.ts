/** REVIEW ONLY. Not connected to routes. Do not enable until database and auth approvals. */
import { randomUUID } from 'node:crypto';
import { Prisma, type PrismaClient } from '../../../generated/batch7-client';
import type { AllocationStore, AllocationTransaction, LockedPayment, LockedInvoice } from '../domain/payment-transaction';

const MAX_RETRIES = 3;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function uuid(id: string): string { if (!UUID.test(id)) throw new Error('Invalid UUID'); return id; }
function cents(value: unknown): bigint {
  const s = String(value);
  if (!/^-?\d+(?:\.\d{1,2})?$/.test(s)) throw new Error('Invalid monetary value');
  const negative = s.startsWith('-');
  const [whole, frac=''] = (negative ? s.slice(1) : s).split('.');
  const n = BigInt(whole) * 100n + BigInt(frac.padEnd(2,'0'));
  return negative ? -n : n;
}
function money(n: bigint): Prisma.Decimal {
  const sign = n < 0n ? '-' : '';
  const abs = n < 0n ? -n : n;
  return new Prisma.Decimal(`${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2,'0')}`);
}

function isIdempotencyConflict(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;

  const error = e as {
    code?: unknown;
    meta?: { target?: unknown };
  };

  if (error.code !== 'P2002') return false;

  const target = error.meta?.target;

  return Array.isArray(target)
    && target.length === 1
    && target[0] === 'idempotencyKey';
}

function isRetryable(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const code = 'code' in e ? String(e.code) : '';
  return code === 'P2034' || code === '40001' || code === '40P01';
}

/** Explicit opt-in gate: constructing the store cannot enable posting. */
export function createPrismaAllocationStore(prisma: PrismaClient, options: { enablePosting: boolean }): AllocationStore {
  if (!options.enablePosting) throw new Error('Financial posting disabled: database migration and security review required');
  return {
    async serializable<T>(fn: (tx: AllocationTransaction) => Promise<T>): Promise<T> {
      for (let attempt=0; attempt<MAX_RETRIES; attempt++) {
        try {
          return await prisma.$transaction(async db => fn(makeTransaction(db)), {
            isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
            maxWait: 5000,
            timeout: 15000,
          });
        } catch(e) {
          // A competing request may have committed the same idempotency key.
          // Re-run the callback in a fresh transaction: findOperation checks the
          // persisted request digest and operation type before replaying.
          // Never blindly treat arbitrary unique conflicts as successful posts.
          const uniqueConflict = isIdempotencyConflict(e);
          if ((!isRetryable(e) && !uniqueConflict) || attempt === MAX_RETRIES-1) throw e;
        }
      }
      throw new Error('Unreachable retry state');
    },
  };
}
function makeTransaction(db: Prisma.TransactionClient): AllocationTransaction {
  return {
    async findOperation(key, payloadDigest) {
      const op = await db.financialOperation.findUnique({ where: { idempotencyKey: key } });
      if (!op) return null;
      if (op.requestDigest !== payloadDigest || op.operationType !== 'ALLOCATE_PAYMENT') throw new Error('Idempotency key reused for different operation');
      return { operationId: op.id, allocatedCashCentavos: cents(op.allocatedCash) };
    },
    async lockPayment(paymentId): Promise<LockedPayment> {
      uuid(paymentId);
      await db.$queryRaw`SELECT id FROM "Payment" WHERE id = ${paymentId}::uuid FOR UPDATE`;
      const p = await db.payment.findUnique({where:{id:paymentId}, include:{allocations:true,refunds:true}});
      if (!p) throw new Error('Payment missing');
      const allocations = p.allocations.reduce((n,a)=>n+cents(a.amount),0n);
      const completed = p.refunds.filter(r=>r.state==='COMPLETED').reduce((n,r)=>n+cents(r.amount),0n);
      const pending = p.refunds.filter(r=>r.state==='PENDING').reduce((n,r)=>n+cents(r.amount),0n);
      return { customerId:p.customerId, state:p.state as LockedPayment['state'], receivedCentavos:cents(p.amount), allocationsCentavos:allocations, completedRefundsCentavos:completed, pendingRefundsCentavos:pending };
    },
    async lockInvoices(idsSorted): Promise<LockedInvoice[]> {
      const ids = [...idsSorted].map(uuid);
      if (new Set(ids).size !== ids.length || ids.some((id,i)=>i>0 && ids[i-1].localeCompare(id)>0)) throw new Error('Invoice locks must be sorted and unique');
      // Lock one at a time in deterministic order, including across concurrent payments.
      for (const id of ids) await db.$queryRaw`SELECT id FROM "OfficialInvoice" WHERE id = ${id}::uuid FOR UPDATE`;
      const invoices = await db.officialInvoice.findMany({where:{id:{in:ids}},include:{payments:true}});
      return invoices.map(i=>{
        // Fail closed: tax/invoice settlement semantics are not approved for live posting.
        if (cents(i.withholdingAmount)!==0n || i.payments.some(a=>cents(a.withheldTax)!==0n)) throw new Error('Withholding accounting requires approval');
        const allocated = i.payments.reduce((n,a)=>n+cents(a.amount),0n);
        return {id:i.id,customerId:i.customerId,outstandingCentavos:cents(i.grossAmount)+cents(i.vatAmount)-allocated,eligible:i.state==='PRINTED'};
      });
    },
    async appendAllocationAndAudit({command,totalCashCentavos,payloadDigest}) {
      // Conservative gate: do not accept withholding until its accounting semantics are verified.
      if (command.allocations.some(a=>a.withheldCentavos!==0n)) throw new Error('Withholding allocation not enabled');
      const operationId = randomUUID();
      const receipt = {operationId,allocatedCashCentavos:totalCashCentavos.toString()};
      await db.financialOperation.create({data:{id:operationId,idempotencyKey:command.idempotencyKey,requestDigest:payloadDigest,operationType:'ALLOCATE_PAYMENT',paymentId:command.paymentId,actorId:command.actor.id,allocatedCash:money(totalCashCentavos),receipt}});
      for (const allocation of command.allocations) {
        await db.paymentAllocationEvent.create({data:{operationId,paymentId:command.paymentId,invoiceId:allocation.invoiceId,cashDelta:money(allocation.cashCentavos),withheldTaxDelta:money(0n),action:'ALLOCATE',reason:command.reason,actorId:command.actor.id}});
        await db.paymentAllocation.upsert({where:{paymentId_invoiceId:{paymentId:command.paymentId,invoiceId:allocation.invoiceId}},create:{paymentId:command.paymentId,invoiceId:allocation.invoiceId,amount:money(allocation.cashCentavos),withheldTax:money(0n)},update:{amount:{increment:money(allocation.cashCentavos)}}});
      }
      await db.auditEvent.create({data:{actorId:command.actor.id,action:'PAYMENT_ALLOCATION_CONFIRMED',entityType:'Payment',entityId:command.paymentId,reason:command.reason,after:receipt}});
      return operationId;
    },
  };
}
