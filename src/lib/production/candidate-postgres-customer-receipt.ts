import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {Prisma, PrismaClient} from '@prisma/client';
import {recordCustomerReceiptInTransaction, type CustomerReceiptCommand} from '../domain/customer-receipt-transaction';
import type {LockedInvoice} from '../domain/payment-transaction';
import {requirePermission, type Role} from '../security/permissions';
import {verifyPassword} from '../pilot/password';

type Input = Omit<CustomerReceiptCommand,'actor'>;
type Db = Prisma.TransactionClient;
type Identity = {databaseOid:string; schemaOid:string; roleOid:string};
type Session = {id:string; staffId:string; revision:bigint; role:Role};
type Invoice = LockedInvoice & {receivableId:string;serialNumber:string|null};
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const hash = (text:string) => createHash('sha256').update(text).digest('hex');
class ReceiptKeyRace extends Error {}
export class ReceiptReferenceConflict extends Error {
  constructor(){super('A receipt with this payment reference is already recorded.');}
}
export class ReceiptKeyConflict extends Error {
  constructor(){super('Receipt key unavailable');}
}
const targets={
  qa:{database:'flsd_batch7_receipt_qa_rehearsal',role:'flsd_batch7_receipt_qa_writer',marker:'FLSD_BATCH7_RECEIPT_QA_ONLY'},
  adapter:{database:'flsd_batch7_receipt_adapter_rehearsal',role:'flsd_batch7_receipt_adapter_writer',marker:'FLSD_BATCH7_RECEIPT_ADAPTER_ONLY'},
  browser:{database:'flsd_batch7_receipt_browser_rehearsal',role:'flsd_batch7_receipt_browser_writer',marker:'FLSD_BATCH7_RECEIPT_BROWSER_ONLY'},
  office:{database:'flsd_batch7_receipt_office_rehearsal',role:'flsd_batch7_receipt_office_writer',marker:'FLSD_BATCH7_RECEIPT_OFFICE_ONLY'},
} as const;

async function authorize(db:Db, digest:string) {
  const [session] = await db.$queryRaw<Session[]>`
    SELECT s.id::text, a.staff_id::text AS "staffId", a.revision, u.role::text
    FROM flsd_batch7_commit_rehearsal.staff_session s
    JOIN flsd_batch7_commit_rehearsal.staff_authorization a ON a.staff_id=s.staff_id
    JOIN flsd_batch7_commit_rehearsal."StaffUser" u ON u.id=a.staff_id
    WHERE s.token_digest=decode(${digest},'hex') AND s.revoked_at IS NULL AND u.active
      AND s.issued_at<=statement_timestamp() AND s.expires_at>statement_timestamp()
    FOR SHARE OF a
  `;
  if (!session || (session.role!=='OWNER' && session.role!=='ADMIN' && session.role!=='BILLING')) {
    throw new Error('Forbidden');
  }
  requirePermission(session.role,'payment:write');
  return {...session,role:session.role};
}

function retryable(error:unknown) {
  const e = error as {code?:string; meta?:{code?:string}} | null;
  return error instanceof ReceiptKeyRace || e?.code==='P2034' || (e?.code==='P2010' && ['40001','40P01'].includes(e.meta?.code ?? ''));
}

function receiptTransaction(client:Pick<PrismaClient,'$transaction'>,identity:Identity,mode:keyof typeof targets){
  const targetIdentity=targets[mode];
  const {databaseOid,schemaOid,roleOid}=identity;
  if (![databaseOid,schemaOid,roleOid].every(oid=>/^[1-9][0-9]{0,9}$/.test(oid)&&BigInt(oid)<=4294967295n)) {
    throw new Error('Invalid receipt rehearsal identity');
  }
  return async <T>(work:(db:Db)=>Promise<T>)=>{
    for (let attempt=1; ; attempt++) {
      try {
        return await client.$transaction(async db=>{
          await db.$executeRaw`SET LOCAL search_path TO pg_catalog`;
          const [target]=await db.$queryRaw<{verified:boolean}[]>`
            SELECT EXISTS (
              SELECT 1 FROM pg_database d CROSS JOIN pg_namespace n CROSS JOIN pg_roles r
              WHERE d.datname=current_database() AND d.datname=${targetIdentity.database}
                AND d.oid=${databaseOid}::oid AND shobj_description(d.oid,'pg_database')=${targetIdentity.marker}
                AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=55437 AND NOT pg_is_in_recovery()
                AND n.nspname='flsd_batch7_commit_rehearsal' AND n.oid=${schemaOid}::oid
                AND r.rolname=current_user AND r.rolname=session_user AND r.oid=${roleOid}::oid
                AND r.rolname=${targetIdentity.role}
                AND shobj_description(r.oid,'pg_authid')=${targetIdentity.marker}
                AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit)
                AND NOT EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid)
                AND current_setting('transaction_isolation')='serializable'
            ) AS verified
          `;
          if (!target?.verified) throw new Error('Receipt rehearsal identity refused');
          return work(db);
        },{isolationLevel:'Serializable'});
      } catch (error) {
        if (attempt===3 || !retryable(error)) throw error;
      }
    }
  };
}

/** Synthetic receipt rehearsal only. Credentials are resolved by the server. */
export function createCandidatePostgresCustomerReceipt(
  client:Pick<PrismaClient,'$transaction'>, identity:Identity, readServerToken:()=>Promise<string|null>,
  mode:keyof typeof targets='adapter',
) {
  const transact=receiptTransaction(client,identity,mode);
  return async (input:Input) => {
    const command=structuredClone(input);
    if (!uuid.test(command.customerId) || !/^[a-z0-9-]{1,160}$/.test(command.key) ||
        !Array.isArray(command.allocations) || command.allocations.some(row=>!uuid.test(row.invoiceId))) {
      throw new Error('Invalid receipt references');
    }
    const token=await readServerToken();
    if (!token || !/^[a-f0-9]{64}$/.test(token)) throw new Error('Forbidden');
    const digest=hash(token);
    return transact(async db=>{
          await db.$queryRaw`SELECT true FROM pg_advisory_xact_lock_shared(176661,1)`;
          const session=await authorize(db,digest);
          await db.$queryRaw`SELECT true FROM pg_advisory_xact_lock(176662,hashtext(${command.key}))`;
          await db.$queryRaw`SELECT true FROM pg_advisory_xact_lock(176663,hashtext(${command.customerId}))`;
          let invoices:Invoice[]=[];
          const result=await recordCustomerReceiptInTransaction({
            async findReceipt(key,requestDigest) {
              const [prior]=await db.$queryRaw<{paymentId:string;operationId:string;allocatedCentavos:bigint;matches:boolean}[]>`
                SELECT o.id::text AS "operationId", o."paymentId"::text AS "paymentId",
                  (o."allocatedCash"*100)::bigint AS "allocatedCentavos",
                  (o."actorId"=${session.staffId}::uuid AND o."operationType"='RECORD_CUSTOMER_RECEIPT'
                   AND o."requestDigest"=${requestDigest} AND p.customer_id=${command.customerId}::uuid
                   AND o.receipt=jsonb_build_object('paymentId',o."paymentId"::text,'operationId',o.id::text,
                     'allocatedCentavos',((o."allocatedCash"*100)::bigint)::text)
                   AND (SELECT array_agg(s.invoice_id ORDER BY s.invoice_id) FROM flsd_batch7_commit_rehearsal.operation_scope s
                        WHERE s.operation_id=o.id)=${command.allocations.map(row=>row.invoiceId).sort()}::uuid[]) IS TRUE AS matches
                FROM flsd_batch7_commit_rehearsal."FinancialOperation" o
                LEFT JOIN flsd_batch7_commit_rehearsal.payment_scope p ON p.payment_id=o."paymentId"
                WHERE o."idempotencyKey"=${key}
              `;
              if (!prior) return null;
              if (!prior.matches) throw new ReceiptKeyConflict();
              return {paymentId:prior.paymentId,operationId:prior.operationId,allocatedCentavos:prior.allocatedCentavos};
            },
            async lockInvoices(ids) {
              invoices=await invoiceBalances(db,[...ids]);
              return invoices;
            },
            async appendReceiptAndAllocations(receipt,requestDigest) {
              if(mode!=='adapter'){
                const [duplicate]=await db.$queryRaw<{exists:boolean}[]>`
                  SELECT EXISTS (
                    SELECT 1 FROM flsd_batch7_commit_rehearsal."Payment"
                    WHERE "customerId"=${receipt.customerId}::uuid AND state='RECORDED'
                      AND "paymentMethod"=${receipt.method} AND lower(btrim(reference))=lower(btrim(${receipt.reference}))
                  ) AS exists
                `;
                if(duplicate?.exists)throw new ReceiptReferenceConflict();
              }
              const paymentId=randomUUID(),operationId=randomUUID(),allocatedCentavos=receipt.receivedCentavos;
              const data=JSON.stringify({paymentId,operationId,allocatedCentavos:allocatedCentavos.toString()});
              const cents=allocatedCentavos.toString();
              await db.$executeRaw`
                INSERT INTO flsd_batch7_commit_rehearsal."Payment" (id,"customerId","receivedAt",amount,reference,"paymentMethod")
                VALUES (${paymentId}::uuid,${receipt.customerId}::uuid,${receipt.receivedDate}::date,${cents}::numeric/100,${receipt.reference},${receipt.method})
              `;
              await db.$executeRaw`
                INSERT INTO flsd_batch7_commit_rehearsal.payment_scope (payment_id,customer_id,evidence_ref)
                VALUES (${paymentId}::uuid,${receipt.customerId}::uuid,${receipt.reference})
              `;
              const inserted=await db.$executeRaw`
                INSERT INTO flsd_batch7_commit_rehearsal."FinancialOperation"
                  (id,"idempotencyKey","requestDigest","operationType","paymentId","actorId","allocatedCash",receipt)
                VALUES (${operationId}::uuid,${receipt.key},${requestDigest},'RECORD_CUSTOMER_RECEIPT',
                  ${paymentId}::uuid,${session.staffId}::uuid,${cents}::numeric/100,${data}::jsonb)
                ON CONFLICT ("idempotencyKey") DO NOTHING
              `;
              if (inserted!==1) throw new ReceiptKeyRace('Receipt key unavailable');
              const receivables=new Map(invoices.map(invoice=>[invoice.id,invoice.receivableId]));
              for (const row of receipt.allocations) {
                const lineCents=row.cashCentavos.toString();
                await db.$executeRaw`
                  INSERT INTO flsd_batch7_commit_rehearsal.operation_scope
                    (operation_id,payment_id,customer_id,invoice_id,receivable_id,evidence_ref)
                  VALUES (${operationId}::uuid,${paymentId}::uuid,${receipt.customerId}::uuid,
                    ${row.invoiceId}::uuid,${receivables.get(row.invoiceId)!}::uuid,${receipt.reference})
                `;
                await db.$executeRaw`
                  INSERT INTO flsd_batch7_commit_rehearsal."PaymentAllocation" ("paymentId","invoiceId",amount)
                  VALUES (${paymentId}::uuid,${row.invoiceId}::uuid,${lineCents}::numeric/100)
                `;
                await db.$executeRaw`
                  INSERT INTO flsd_batch7_commit_rehearsal."PaymentAllocationEvent"
                    (id,"operationId","paymentId","invoiceId","cashDelta",action,reason,"actorId")
                  VALUES (${randomUUID()}::uuid,${operationId}::uuid,${paymentId}::uuid,${row.invoiceId}::uuid,
                    ${lineCents}::numeric/100,'ALLOCATE',${receipt.reference},${session.staffId}::uuid)
                `;
              }
              await db.$executeRaw`
                INSERT INTO flsd_batch7_commit_rehearsal."AuditEvent" (id,"actorId",action,"entityType","entityId",reason,after)
                VALUES (${randomUUID()}::uuid,${session.staffId}::uuid,'RECORD_CUSTOMER_RECEIPT','Payment',
                  ${paymentId},${receipt.reference},${data}::jsonb)
              `;
              return {paymentId,operationId,allocatedCentavos};
            },
          },{...command,actor:{id:session.staffId,role:session.role}},hash);
          const latest=await authorize(db,digest);
          if (latest.id!==session.id || latest.staffId!==session.staffId || latest.revision!==session.revision ||
              latest.role!==session.role) throw new Error('Forbidden');
          return result;
    });
  };
}

function invoiceBalances(db:Db,ids:string[]|null){
  return db.$queryRaw<Invoice[]>`
                SELECT i.id::text, i."customerId"::text, r.id::text AS "receivableId", i."serialNumber",
                  (i.state='PRINTED' AND NOT EXISTS (
                    SELECT 1 FROM flsd_batch7_commit_rehearsal.invoice_attribution other
                    WHERE other.receivable_id=r.id AND other.invoice_id<>i.id
                  ) AND NOT EXISTS (
                    SELECT 1 FROM flsd_batch7_commit_rehearsal.invoice_reservation v
                    WHERE v.receivable_id=r.id AND v.invoice_id<>i.id
                  )) AS eligible,
                  ((r.payable-coalesce(sum(a.amount+a."withheldTax"),0))*100)::bigint AS "outstandingCentavos"
                FROM flsd_batch7_commit_rehearsal.invoice_attribution t
                JOIN flsd_batch7_commit_rehearsal."OfficialInvoice" i ON i.id=t.invoice_id
                JOIN flsd_batch7_commit_rehearsal.receivable r ON r.id=t.receivable_id
                LEFT JOIN flsd_batch7_commit_rehearsal."PaymentAllocation" a ON a."invoiceId"=i.id
                WHERE (${ids}::uuid[] IS NULL OR i.id=ANY(${ids}::uuid[])) GROUP BY i.id,r.id
              `;
}

export function readCandidateOfficeBalances(client:Pick<PrismaClient,'$transaction'>,identity:Identity,mode:'office'|'browser'|'qa',token:string){
  return receiptTransaction(client,identity,mode)(async db=>{
    await authorize(db,hash(token));
    const invoices=(await invoiceBalances(db,null)).filter(row=>row.eligible&&row.outstandingCentavos>0n);
    const ids=[...new Set(invoices.map(row=>row.customerId))];
    const customers=await db.$queryRaw<{id:string;name:string}[]>`
      SELECT id::text,name FROM flsd_batch7_commit_rehearsal."Customer" WHERE id=ANY(${ids}::uuid[])
    `;
    const names=new Map(customers.map(row=>[row.id,row.name]));
    return invoices.map(({id,customerId,serialNumber,outstandingCentavos})=>({
      id,customerId,customerName:names.get(customerId)??customerId,serialNumber,outstandingCentavos,
    }));
  });
}

export function candidateOfficeSignIn(client:Pick<PrismaClient,'$transaction'>,identity:Identity,email:string,password:string){
  return receiptTransaction(client,identity,'qa')(async db=>{
    const [account]=await db.$queryRaw<{id:string;hash:string;role:Role;active:boolean}[]>`
      SELECT u.id::text,u."passwordHash" AS hash,u.role::text,u.active
      FROM flsd_batch7_commit_rehearsal."StaffUser" u JOIN flsd_batch7_commit_rehearsal.staff_authorization a ON a.staff_id=u.id
      WHERE lower(u.email)=${email} AND u.email LIKE 'office.qa.%@example.invalid'
      FOR SHARE OF a
    `;
    const fallback='scrypt$'+'0'.repeat(32)+'$'+'0'.repeat(128);
    if(!await verifyPassword(password,account?.hash??fallback)||!account?.active)return null;
    const token=randomBytes(32).toString('hex');
    await db.$executeRaw`
      INSERT INTO flsd_batch7_commit_rehearsal.staff_session (id,staff_id,token_digest,issued_at,expires_at)
      VALUES (${randomUUID()}::uuid,${account.id}::uuid,decode(${hash(token)},'hex'),statement_timestamp(),statement_timestamp()+interval '4 hours')
    `;
    return token;
  });
}

export function revokeCandidateOfficeSession(client:Pick<PrismaClient,'$transaction'>,identity:Identity,token:string){
  return receiptTransaction(client,identity,'qa')(db=>db.$executeRaw`
    UPDATE flsd_batch7_commit_rehearsal.staff_session SET revoked_at=statement_timestamp()
    WHERE token_digest=decode(${hash(token)},'hex') AND revoked_at IS NULL
  `);
}
