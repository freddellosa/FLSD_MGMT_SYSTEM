import {createHash, randomUUID} from 'node:crypto';
import type {PrismaClient, Prisma} from '@prisma/client';
import {confirmPaymentAllocationInTransaction, type LockedInvoice, type LockedPayment} from '../domain/payment-transaction';
import {requirePermission} from '../security/permissions';
import type {CandidateAllocationAcceptancePort} from './candidate-allocation-acceptance';

const prefix = '70000000-0000-4000-8000-0000000000';
const staffId = prefix + '01';
const customerId = prefix + '02';
const invoiceId = prefix + '05';
const paymentId = prefix + '06';
const receivableId = prefix + '14';
const roleName = 'flsd_batch7_candidate_writer';
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

class UnboundCandidateKey extends Error {
  constructor() { super('Reserved legacy allocation key has no scope binding'); }
}
class CandidateKeyRace extends Error {}

function required<T>(rows: T[]): T {
  if (rows.length !== 1) throw new Error('Candidate allocation data mismatch');
  return rows[0];
}

type Db = Prisma.TransactionClient;
type Session = {id:string; revision:bigint; role:'OWNER'|'ADMIN'|'BILLING'};

async function authorize(db: Db, digest: string) {
  const session = required(await db.$queryRaw<Session[]>`
    SELECT s.id::text, a.revision, u.role::text
    FROM flsd_batch7_commit_rehearsal.staff_session s
    JOIN flsd_batch7_commit_rehearsal.staff_authorization a ON a.staff_id=s.staff_id
    JOIN flsd_batch7_commit_rehearsal."StaffUser" u ON u.id=a.staff_id
    WHERE s.token_digest=decode(${digest},'hex') AND s.staff_id=${staffId}::uuid
      AND s.revoked_at IS NULL AND u.active AND a.revision>0
      AND u.role::text IN ('OWNER','ADMIN','BILLING')
      AND s.issued_at<=statement_timestamp() AND s.expires_at>statement_timestamp()
  `);
  requirePermission(session.role,'payment:write');
  return session;
}

function retryable(error: unknown) {
  const e = error as {code?:string; meta?:{code?:string}} | null;
  return error instanceof CandidateKeyRace || e?.code==='P2034' ||
    (e?.code==='P2010' && ['40001','40P01'].includes(e.meta?.code ?? ''));
}

/** Synthetic acceptance only. The caller supplies a dedicated, endpoint-pinned Prisma client. */
export function createCandidatePostgresAllocationPort(
  client: Pick<PrismaClient,'$transaction'>,
  roleOid: string,
  readServerToken: () => Promise<string|null>,
): CandidateAllocationAcceptancePort {
  if (!/^[1-9][0-9]{0,9}$/.test(roleOid) || BigInt(roleOid)>4294967295n) throw new Error('Invalid candidate role OID');

  async function transact<T>(readOnly: boolean, work: (db: Db) => Promise<T>): Promise<T> {
    for (let attempt=1; ; attempt++) {
      try {
        return await client.$transaction(async db => {
          if (readOnly) await db.$executeRaw`SET TRANSACTION READ ONLY`;
          await db.$executeRaw`SET LOCAL search_path TO pg_catalog`;
          const identity = required(await db.$queryRaw<{verified:boolean}[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_database d CROSS JOIN pg_namespace n CROSS JOIN pg_roles r
              WHERE d.datname=current_database() AND d.datname='flsd_main_adapter_test' AND d.oid=16394
                AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=5432
                AND n.nspname='flsd_batch7_commit_rehearsal' AND n.oid=19396 AND n.nspowner=16392
                AND obj_description(n.oid,'pg_namespace')='FLSD_SYNTHETIC_BATCH7_COMMITTED_V1'
                AND r.rolname=current_user AND r.rolname=session_user AND r.rolname=${roleName} AND r.oid=${roleOid}::oid
                AND shobj_description(r.oid,'pg_authid')='FLSD_SYNTHETIC_BATCH7_ACCEPTANCE_V1'
                AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
                AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
                AND current_setting('transaction_isolation')='serializable'
            ) AS verified
          `);
          if (!identity.verified) throw new Error('Candidate allocation target verification failed');
          return work(db);
        }, {isolationLevel:'Serializable'});
      } catch (error) {
        if (attempt===3 || !retryable(error)) throw error;
      }
    }
  }

  return {
    isUnboundKeyRefusal: error => error instanceof UnboundCandidateKey,
    async allocate(input) {
      const command = structuredClone(input);
      const [allocation] = command.allocations;
      if (command.paymentId!==paymentId || command.customerId!==customerId ||
          command.allocations.length!==1 || allocation.invoiceId!==invoiceId ||
          allocation.withheldCentavos!==0n || typeof allocation.cashCentavos!=='bigint' ||
          !/^[a-z0-9-]{1,160}$/.test(command.idempotencyKey)) throw new Error('Unsupported candidate allocation');
      const token = await readServerToken();
      if (typeof token!=='string' || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Forbidden');
      const digest = sha256(token);

      return transact(false, async db => {
        await db.$queryRaw`SELECT true FROM pg_advisory_xact_lock_shared(176661,1)`;
        required(await db.$queryRaw<{staff_id:string}[]>`
          SELECT a.staff_id FROM flsd_batch7_commit_rehearsal.staff_authorization a
          JOIN flsd_batch7_commit_rehearsal.staff_session s ON s.staff_id=a.staff_id
          WHERE a.staff_id=${staffId}::uuid AND s.token_digest=decode(${digest},'hex') FOR SHARE OF a
        `);
        const session = await authorize(db,digest);
        await db.$queryRaw`SELECT true FROM pg_advisory_xact_lock(176662, hashtext(${command.idempotencyKey}))`;
        await db.$queryRaw`SELECT true FROM pg_advisory_xact_lock(176663, hashtext(${customerId}))`;
        required(await db.$queryRaw<{id:string}[]>`
          SELECT r.id FROM flsd_batch7_commit_rehearsal.payment_scope p
          JOIN flsd_batch7_commit_rehearsal.invoice_attribution i USING (customer_id)
          JOIN flsd_batch7_commit_rehearsal.receivable r ON (r.id,r.customer_id)=(i.receivable_id,i.customer_id)
          JOIN flsd_batch7_commit_rehearsal.invoice_reservation v
            ON (v.receivable_id,v.invoice_id,v.customer_id)=(r.id,i.invoice_id,i.customer_id)
          WHERE (p.payment_id,p.customer_id,i.invoice_id,r.id)=
            (${paymentId}::uuid,${customerId}::uuid,${invoiceId}::uuid,${receivableId}::uuid)
            AND NOT EXISTS (
              SELECT 1 FROM flsd_batch7_commit_rehearsal.invoice_attribution other
              WHERE other.receivable_id=r.id AND other.invoice_id<>i.invoice_id
            )
        `);
        const result = await confirmPaymentAllocationInTransaction({
          async findOperation(key, requestDigest) {
            const rows = await db.$queryRaw<{
              id:string; actorId:string; kind:string; digest:string; cash:bigint; bound:boolean;
              visible:boolean; receiptValid:boolean;
            }[]>`
              SELECT o.id::text, o."actorId"::text, o."operationType" AS kind, o."requestDigest" AS digest,
                (o."allocatedCash"*100)::bigint AS cash, s.operation_id IS NOT NULL AS bound,
                ((s.payment_id,s.customer_id,s.invoice_id,s.receivable_id)=
                  (${paymentId}::uuid,${customerId}::uuid,${invoiceId}::uuid,${receivableId}::uuid)) AS visible,
                o.receipt=jsonb_build_object('operationId',o.id::text,
                  'allocatedCashCentavos',(o."allocatedCash"*100)::bigint::text) AS "receiptValid"
              FROM flsd_batch7_commit_rehearsal."FinancialOperation" o
              LEFT JOIN flsd_batch7_commit_rehearsal.operation_scope s ON s.operation_id=o.id
              WHERE o."idempotencyKey"=${key}
            `;
            if (!rows.length) return null;
            const prior = required(rows);
            if (!prior.bound) throw new UnboundCandidateKey();
            if (!prior.visible || !prior.receiptValid || prior.actorId!==staffId || prior.kind!=='ALLOCATE_PAYMENT' ||
                prior.digest!==requestDigest || prior.cash!==allocation.cashCentavos) throw new Error('Candidate receipt mismatch');
            return {operationId:prior.id, allocatedCashCentavos:prior.cash};
          },
          async lockPayment(id) {
            return required(await db.$queryRaw<LockedPayment[]>`
              SELECT p."customerId"::text, p.state::text, (p.amount*100)::bigint AS "receivedCentavos",
                (100*coalesce((SELECT sum(a.amount) FROM flsd_batch7_commit_rehearsal."PaymentAllocation" a
                  WHERE a."paymentId"=p.id),0))::bigint AS "allocationsCentavos",
                (100*coalesce(sum(f.amount) FILTER (WHERE f.state='PENDING'),0))::bigint AS "pendingRefundsCentavos",
                (100*coalesce(sum(f.amount) FILTER (WHERE f.state='COMPLETED'),0))::bigint AS "completedRefundsCentavos"
              FROM flsd_batch7_commit_rehearsal."Payment" p
              LEFT JOIN flsd_batch7_commit_rehearsal."PaymentRefund" f ON f."paymentId"=p.id
              WHERE p.id=${id}::uuid GROUP BY p.id
            `);
          },
          async lockInvoices() {
            return db.$queryRaw<LockedInvoice[]>`
              SELECT i.id::text, i."customerId"::text, i.state='PRINTED' AS eligible,
                (100*(r.payable-coalesce(sum(a.amount+a."withheldTax"),0)))::bigint AS "outstandingCentavos"
              FROM flsd_batch7_commit_rehearsal."OfficialInvoice" i
              JOIN flsd_batch7_commit_rehearsal.receivable r ON r.id=${receivableId}::uuid
              LEFT JOIN flsd_batch7_commit_rehearsal."PaymentAllocation" a ON a."invoiceId"=i.id
              WHERE i.id=${invoiceId}::uuid GROUP BY i.id,r.id
            `;
          },
          async appendAllocationAndAudit({totalCashCentavos, payloadDigest}) {
            const operationId = randomUUID();
            const receipt = JSON.stringify({operationId,allocatedCashCentavos:totalCashCentavos.toString()});
            const cents = totalCashCentavos.toString();
            const inserted = await db.$executeRaw`
              INSERT INTO flsd_batch7_commit_rehearsal."FinancialOperation"
                (id,"idempotencyKey","requestDigest","operationType","paymentId","actorId","allocatedCash",receipt)
              VALUES (${operationId}::uuid,${command.idempotencyKey},${payloadDigest},'ALLOCATE_PAYMENT',
                ${paymentId}::uuid,${staffId}::uuid,${cents}::numeric/100,${receipt}::jsonb)
              ON CONFLICT ("idempotencyKey") DO NOTHING
            `;
            if (inserted!==1) throw new CandidateKeyRace();
            await db.$executeRaw`
              INSERT INTO flsd_batch7_commit_rehearsal.operation_scope
                (operation_id,payment_id,customer_id,invoice_id,receivable_id,evidence_ref)
              VALUES (${operationId}::uuid,${paymentId}::uuid,${customerId}::uuid,${invoiceId}::uuid,
                ${receivableId}::uuid,'SYNTHETIC-CANDIDATE-ACCEPTANCE')
            `;
            const updated = await db.$executeRaw`
              UPDATE flsd_batch7_commit_rehearsal."PaymentAllocation" SET amount=amount+${cents}::numeric/100
              WHERE "paymentId"=${paymentId}::uuid AND "invoiceId"=${invoiceId}::uuid
            `;
            if (updated!==1) throw new Error('Opening allocation projection missing');
            await db.$executeRaw`
              INSERT INTO flsd_batch7_commit_rehearsal."PaymentAllocationEvent"
                (id,"operationId","paymentId","invoiceId","cashDelta",action,reason,"actorId")
              VALUES (${randomUUID()}::uuid,${operationId}::uuid,${paymentId}::uuid,${invoiceId}::uuid,
                ${cents}::numeric/100,'ALLOCATE',${command.reason},${staffId}::uuid)
            `;
            await db.$executeRaw`
              INSERT INTO flsd_batch7_commit_rehearsal."AuditEvent" (id,"actorId",action,"entityType","entityId",reason,after)
              VALUES (${randomUUID()}::uuid,${staffId}::uuid,'PAYMENT_ALLOCATION_CONFIRMED','Payment',${paymentId},${command.reason},${receipt}::jsonb)
            `;
            return operationId;
          },
        }, {...command,actor:{id:staffId,role:session.role}}, sha256);
        const current = await authorize(db,digest);
        if (current.id!==session.id || current.revision!==session.revision || current.role!==session.role) throw new Error('Forbidden');
        return result;
      });
    },
    inspect: () => transact(true, inspectCandidate),
  };
}

type Facts = Awaited<ReturnType<CandidateAllocationAcceptancePort['inspect']>>;

async function inspectCandidate(db: Db): Promise<Facts> {
  const {history, ...facts} = required(await db.$queryRaw<(Omit<Facts,'historySha256'|'latestEffect'> & {history:string})[]>`
    SELECT
      jsonb_build_array(
        (SELECT jsonb_agg(to_jsonb(o) ORDER BY id) FROM flsd_batch7_commit_rehearsal."FinancialOperation" o
          WHERE id IN (${prefix+'07'}::uuid,${prefix+'08'}::uuid)),
        (SELECT jsonb_agg(to_jsonb(e) ORDER BY id) FROM flsd_batch7_commit_rehearsal."PaymentAllocationEvent" e
          WHERE id IN (${prefix+'09'}::uuid,${prefix+'10'}::uuid)))::text AS history,
      (SELECT count(*)::int FROM flsd_batch7_commit_rehearsal."FinancialOperation") AS "operationCount",
      (SELECT count(*)::int FROM flsd_batch7_commit_rehearsal."PaymentAllocationEvent") AS "eventCount",
      (SELECT count(*)::int FROM flsd_batch7_commit_rehearsal."AuditEvent") AS "auditCount",
      (SELECT count(*)::int FROM flsd_batch7_commit_rehearsal.invoice_reservation) AS "reservationCount",
      (SELECT count(*)::int FROM flsd_batch7_commit_rehearsal.operation_scope) AS "scopeCount",
      (a.amount*100)::bigint AS "allocatedCentavos", (p.amount*100)::bigint AS "receivedCentavos",
      (SELECT (100*sum(amount))::bigint FROM flsd_batch7_commit_rehearsal."PaymentRefund"
        WHERE "paymentId"=p.id AND state='PENDING') AS "pendingRefundCentavos",
      (SELECT (100*sum(amount))::bigint FROM flsd_batch7_commit_rehearsal."PaymentRefund"
        WHERE "paymentId"=p.id AND state='COMPLETED') AS "completedRefundCentavos",
      (r.payable*100)::bigint AS "payableCentavos",
      jsonb_build_object('operationId',v.operation_id,'invoiceId',v.invoice_id,'receivableId',v.receivable_id) AS reservation
    FROM flsd_batch7_commit_rehearsal."Payment" p
    JOIN flsd_batch7_commit_rehearsal."PaymentAllocation" a ON a."paymentId"=p.id
    JOIN flsd_batch7_commit_rehearsal.invoice_reservation v ON v.invoice_id=a."invoiceId"
    JOIN flsd_batch7_commit_rehearsal.receivable r ON r.id=v.receivable_id
    WHERE p.id=${paymentId}::uuid AND a."invoiceId"=${invoiceId}::uuid
  `);
  const effects = await db.$queryRaw<NonNullable<Facts['latestEffect']>[]>`
    SELECT o.id::text AS "operationId", (e."cashDelta"*100)::bigint AS "cashCentavos",
      s.invoice_id::text AS "invoiceId", s.receivable_id::text AS "receivableId", e."actorId"::text
    FROM flsd_batch7_commit_rehearsal."FinancialOperation" o
    JOIN flsd_batch7_commit_rehearsal.operation_scope s ON (s.operation_id,s.payment_id)=(o.id,o."paymentId")
    JOIN flsd_batch7_commit_rehearsal."PaymentAllocationEvent" e ON
      (e."operationId",e."paymentId",e."invoiceId",e."actorId")=(o.id,s.payment_id,s.invoice_id,o."actorId")
    JOIN flsd_batch7_commit_rehearsal."AuditEvent" a ON a.after=o.receipt AND a."actorId"=o."actorId"
      AND a."entityId"=s.payment_id::text AND a."entityType"='Payment' AND a.action='PAYMENT_ALLOCATION_CONFIRMED'
    WHERE o."idempotencyKey"='candidate-acceptance-allocation' AND o."operationType"='ALLOCATE_PAYMENT'
      AND e.action='ALLOCATE' AND e."cashDelta"=o."allocatedCash" AND e."withheldTaxDelta"=0 AND a.reason=e.reason
  `;
  return {...facts, historySha256:sha256(history), latestEffect:effects.length ? required(effects) : null};
}
