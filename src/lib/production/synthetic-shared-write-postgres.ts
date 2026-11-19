import {randomUUID} from 'node:crypto';
import {Prisma,type PrismaClient} from '@prisma/client';
import {fromCentavos,toCentavos} from '../domain/billing';
import type {SharedDependencyEvidence} from './shared-transaction-evidence';
import type {SyntheticSharedWriteTransaction,WithSyntheticSharedWriteTransaction} from './synthetic-shared-write-coordinator';

const sharedAuthority='flsd-synthetic-shared-write';
const sessionId='10000000-0000-4000-8000-000000000002';
const marker='FLSD_SYNTHETIC_SHARED_WRITE_V1:b813e743-9f4c-4121-b8ab-b01ca51b9335';
function only<T>(rows:T[],message:string):T {
  if(rows.length!==1) throw new Error(message);
  return rows[0];
}

type Source={
  customerRevision:string; paymentRevision:string; paymentState:'RECORDED'|'VOIDED';
  received:string; allocated:string; invoiceRevision:string; invoiceEligible:boolean;
  receivableId:string; receivableRevision:string; receivableEligible:boolean; outstanding:string;
  tripId:string; tripVersion:string; reservedInvoice:string|null; reservedRevision:string|null;
};
type Receipt={
  operationId:string; actorId:string; customerId:string; paymentId:string; invoiceId:string;
  receivableId:string; kind:string; requestDigest:string; cash:string;
};
type Evidence=SharedDependencyEvidence;

export function bindDisposableFinancialRows(
  tx:Prisma.TransactionClient,target:'shared'|'combined',readSessionId:()=>string,
):SyntheticSharedWriteTransaction {
  const authority=target==='combined'?'flsd-synthetic-combined-write':sharedAuthority;
  const schema=target==='combined'?Prisma.sql`flsd_combined_write_rehearsal`:Prisma.sql`flsd_shared_write_rehearsal`;
  const tables={
    CUSTOMER:Prisma.sql`${schema}.customer`,
    PAYMENT:Prisma.sql`${schema}.payment`,
    TRIP:Prisma.sql`${schema}.trip`,
    TRIP_RECEIVABLE:Prisma.sql`${schema}.trip_receivable`,
    INVOICE:Prisma.sql`${schema}.invoice`,
    REFUND:Prisma.sql`${schema}.refund`,
  };
  let snapshot:{command:Parameters<SyntheticSharedWriteTransaction['discover']>[0];source:Source;receipt:Receipt|null}|undefined;
  return {
    async discover(command) {
      const sessionId=readSessionId();
      const actor=only(await tx.$queryRaw<(Evidence['actor'] & {expiresAt:string})[]>`
        SELECT a.staff_id::text id,a.role,a.active,a.revision::text "authorizationRevision",
          to_char(s.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') "expiresAt"
        FROM ${schema}.staff_session s
        JOIN ${schema}.staff_authorization a USING (authority_id,staff_id)
        WHERE s.authority_id=${authority} AND s.session_id=${sessionId}::uuid
          AND s.issued_at<=clock_timestamp() AND s.expires_at>clock_timestamp() AND s.revoked_at IS NULL
          AND a.active AND a.role IN ('OWNER','ADMIN','BILLING')`, 'Synthetic session unavailable');
      const {customerId,paymentId,idempotencyKey}=command;
      const invoiceId=command.allocations[0].invoiceId;
      const row=only(await tx.$queryRaw<Source[]>`
        SELECT c.revision::text "customerRevision",p.revision::text "paymentRevision",p.state "paymentState",
          p.received::text,p.allocated::text,i.revision::text "invoiceRevision",i.eligible "invoiceEligible",
          r.id::text "receivableId",r.revision::text "receivableRevision",r.eligible "receivableEligible",
          r.outstanding::text,t.id::text "tripId",t.version::text "tripVersion",
          ri.id::text "reservedInvoice",ri.revision::text "reservedRevision"
        FROM ${schema}.customer c
        JOIN ${schema}.payment p ON (p.authority_id,p.customer_id)=(c.authority_id,c.id)
        JOIN ${schema}.invoice i ON (i.authority_id,i.customer_id)=(c.authority_id,c.id)
        JOIN ${schema}.trip_receivable r ON (r.authority_id,r.id,r.customer_id)=(i.authority_id,i.receivable_id,c.id)
        JOIN ${schema}.trip t ON (t.authority_id,t.id,t.customer_id)=(r.authority_id,r.trip_id,c.id)
        LEFT JOIN ${schema}.invoice_reservation ir ON (ir.authority_id,ir.receivable_id)=(r.authority_id,r.id)
        LEFT JOIN ${schema}.invoice ri ON (ri.authority_id,ri.id)=(ir.authority_id,ir.invoice_id)
        WHERE c.authority_id=${authority} AND c.id=${customerId}::uuid AND p.id=${paymentId}::uuid AND i.id=${invoiceId}::uuid
          AND p.allocation_scope='CUSTOMER'`, 'Synthetic allocation scope unavailable');
      const refunds=await tx.$queryRaw<{id:string;revision:string;state:string;amount:string}[]>`
        SELECT id::text,revision::text,state,amount::text FROM ${schema}.refund
        WHERE authority_id=${authority} AND customer_id=${customerId}::uuid AND payment_id=${paymentId}::uuid`;
      const [receipt=null]=await tx.$queryRaw<Receipt[]>`
        SELECT operation_id::text "operationId",actor_id::text "actorId",customer_id::text "customerId",
          payment_id::text "paymentId",invoice_id::text "invoiceId",receivable_id::text "receivableId",
          command_kind kind,encode(request_digest,'hex') "requestDigest",cash::text
        FROM ${schema}.financial_operation WHERE authority_id=${authority} AND operation_key=${idempotencyKey}`;
      snapshot={command,source:row,receipt};
      const sum=(state:string)=>refunds.filter(refund=>refund.state===state)
        .reduce((total,refund)=>total+toCentavos(refund.amount),0n);
      const received=toCentavos(row.received),allocated=toCentavos(row.allocated),outstanding=toCentavos(row.outstanding);
      const completedRefunds=sum('COMPLETED'),reservedRefunds=sum('RESERVED');
      const ref=<K extends Evidence['resources'][number]['kind']>(kind:K,id:string)=>({kind,id});
      const resource=(reference:ReturnType<typeof ref>,revision:string,state='ACTIVE')=>({...reference,customerId,revision,state});
      const customer=ref('CUSTOMER',customerId),payment=ref('PAYMENT',paymentId),invoice=ref('INVOICE',invoiceId);
      const receivable=ref('TRIP_RECEIVABLE',row.receivableId),trip=ref('TRIP',row.tripId);
      const reserved=row.reservedInvoice?ref('INVOICE',row.reservedInvoice):null;
      const evidence:Evidence={
        authority,operationKey:idempotencyKey,actor:{id:actor.id,active:actor.active,role:actor.role,authorizationRevision:actor.authorizationRevision},
        session:{id:sessionId,expiresAt:actor.expiresAt,revokedAt:null},
        resources:[
          resource(customer,row.customerRevision),resource(trip,row.tripVersion),
          {...resource(invoice,row.invoiceRevision),eligible:row.invoiceEligible},
          {...resource(receivable,row.receivableRevision),eligible:row.receivableEligible,amounts:[{name:'outstanding',centavos:outstanding}]},
          {...resource(payment,row.paymentRevision,row.paymentState),amounts:Object.entries({received,allocated,completedRefunds,reservedRefunds})
            .map(([name,centavos])=>({name,centavos}))},
          ...refunds.map(refund=>({...resource(ref('REFUND',refund.id),refund.revision,refund.state),amounts:[{name:'refund',centavos:toCentavos(refund.amount)}]})),
          ...(reserved && reserved.id!==invoiceId && row.reservedRevision?[resource(reserved,row.reservedRevision)]:[]),
        ],
        relationships:[
          {role:'INVOICE_RECEIVABLE',from:invoice,to:receivable},{role:'RECEIVABLE_TRIP',from:receivable,to:trip},
          ...refunds.map(refund=>({role:'PAYMENT_REFUND',from:payment,to:ref('REFUND',refund.id)})),
          ...(reserved?[{role:'ACTIVE_INVOICE_RESERVATION',from:receivable,to:reserved}]:[]),
        ],
        absences:reserved?[]:[{predicate:'ACTIVE_INVOICE_RESERVATION',subject:receivable,parent:customer,parentRevision:row.customerRevision}],
        receipt:receipt?{actorId:receipt.actorId,kind:receipt.kind,requestDigest:receipt.requestDigest,result:ref('PAYMENT',receipt.paymentId)}:null,
      };
      return {
        evidence,
        payment:{authority,id:paymentId,customerId,state:row.paymentState,allocationScope:'CUSTOMER',refundIds:refunds.map(refund=>refund.id),
          receivedCentavos:received,allocationsCentavos:allocated,completedRefundsCentavos:completedRefunds,pendingRefundsCentavos:reservedRefunds},
        invoices:[{authority,id:invoiceId,customerId,eligible:row.invoiceEligible,receivableIds:[row.receivableId]}],
        receivables:[{authority,id:row.receivableId,customerId,tripId:row.tripId,eligible:row.receivableEligible,outstandingCentavos:outstanding}],
      };
    },
    async acquire(lock) {
      if(lock.authority!==authority) throw new Error('Synthetic lock scope mismatch');
      if(lock.kind==='OPERATION'){
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${authority+'|'+lock.id},0::bigint))::text`;
        return;
      }
      if(lock.kind==='STAFF_AUTHORIZATION'){
        only(await tx.$queryRaw<unknown[]>`SELECT 1 FROM ${schema}.staff_authorization
          WHERE authority_id=${authority} AND staff_id=${lock.id}::uuid FOR SHARE`,'Synthetic staff lock unavailable');
        return;
      }
      if(!Object.hasOwn(tables,lock.kind)) throw new Error('Unsupported synthetic resource lock');
      const table=tables[lock.kind as keyof typeof tables];
      only(await tx.$queryRaw<unknown[]>`SELECT 1 FROM ${table} WHERE authority_id=${authority} AND id=${lock.id}::uuid FOR UPDATE`,
        'Synthetic resource lock unavailable');
    },
    effects:{
      async findReceipt(scope) {
        if(!snapshot) throw new Error('Synthetic discovery required');
        const {receipt,command,source}=snapshot;
        if(!receipt) return null;
        return {...receipt,authority,key:command.idempotencyKey,allocatedCashCentavos:toCentavos(receipt.cash),
          resultVisible:receipt.customerId===scope.customerId && receipt.paymentId===scope.paymentId &&
            receipt.invoiceId===command.allocations[0].invoiceId && receipt.receivableId===source.receivableId};
      },
      async appendAllocationAndAudit(input) {
        if(!snapshot) throw new Error('Synthetic discovery required');
        const {source}=snapshot;
        const {customerId,paymentId,idempotencyKey,actor,reason}=input.command;
        const [{invoiceId,receivableId}]=input.attributions;
        if(source.reservedInvoice && source.reservedInvoice!==invoiceId) throw new Error('Receivable reserved by another invoice');
        const operationId=randomUUID(),cash=fromCentavos(input.totalCashCentavos);
        if(!source.reservedInvoice){
          await tx.$executeRaw`INSERT INTO ${schema}.invoice_reservation
            VALUES (${authority},${customerId}::uuid,${invoiceId}::uuid,${receivableId}::uuid,${operationId}::uuid)`;
        }
        await tx.$executeRaw`INSERT INTO ${schema}.allocation_event VALUES (${authority},${operationId}::uuid,${cash}::numeric)`;
        const customerCount=await tx.$executeRaw`UPDATE ${schema}.customer SET revision=revision+1
          WHERE authority_id=${authority} AND id=${customerId}::uuid AND revision=${source.customerRevision}::bigint`;
        const paymentCount=await tx.$executeRaw`UPDATE ${schema}.payment SET revision=revision+1,allocated=allocated+${cash}::numeric
          WHERE authority_id=${authority} AND id=${paymentId}::uuid AND revision=${source.paymentRevision}::bigint`;
        const receivableCount=await tx.$executeRaw`UPDATE ${schema}.trip_receivable SET revision=revision+1,allocated=allocated+${cash}::numeric
          WHERE authority_id=${authority} AND id=${receivableId}::uuid AND revision=${source.receivableRevision}::bigint`;
        if(customerCount!==1 || paymentCount!==1 || receivableCount!==1) throw new Error('Synthetic projection revision mismatch');
        await tx.$executeRaw`INSERT INTO ${schema}.financial_operation VALUES
          (${authority},${operationId}::uuid,${idempotencyKey},'ALLOCATE_PAYMENT',decode(${input.payloadDigest},'hex'),
           ${actor.id}::uuid,${customerId}::uuid,${paymentId}::uuid,${invoiceId}::uuid,${receivableId}::uuid,${cash}::numeric)`;
        await tx.$executeRaw`INSERT INTO ${schema}.allocation_audit VALUES (${authority},${operationId}::uuid,${actor.id}::uuid,${reason})`;
        return operationId;
      },
    },
  };
}

export function bindSyntheticSharedWritePostgres(
  client:Pick<PrismaClient,'$transaction'>,
  identity:{schemaOid:string;roleOid:string},
):WithSyntheticSharedWriteTransaction {
  const {schemaOid,roleOid}=identity;
  if(![schemaOid,roleOid].every(oid=>/^[1-9][0-9]{0,9}$/.test(oid)&&Number(oid)<=4294967295)){
    throw new Error('Invalid synthetic installation identity');
  }
  return async work=>{
    for(let attempt=0;;attempt++){
      try {
        return await client.$transaction(async tx=>{
          await tx.$executeRaw`SET LOCAL search_path TO pg_catalog`;
          only(await tx.$queryRaw<unknown[]>`
            SELECT 1 FROM pg_database d JOIN pg_namespace n ON n.nspowner=d.datdba
            JOIN pg_roles r ON r.rolname=current_user
            WHERE current_database()='flsd_main_adapter_test' AND d.datname=current_database()
              AND d.oid=16394::oid AND d.datdba=16392::oid AND host(inet_server_addr())='127.0.0.1'
              AND inet_server_port()=5432 AND NOT pg_is_in_recovery() AND current_setting('server_version_num')='180007'
              AND current_setting('transaction_isolation')='serializable'
              AND shobj_description(d.oid,'pg_database')='FLSD_DISPOSABLE:b813e743-9f4c-4121-b8ab-b01ca51b9335:flsd_main_adapter_test'
              AND n.nspname='flsd_shared_write_rehearsal' AND n.oid=${schemaOid}::oid AND obj_description(n.oid,'pg_namespace')=${marker}
              AND current_user=session_user AND r.rolname='flsd_shared_write_runner_75435c870a31' AND r.oid=${roleOid}::oid
              AND r.rolcanlogin AND NOT (r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
              AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid) AND shobj_description(r.oid,'pg_authid')=${marker}`,
          'Synthetic PostgreSQL identity mismatch');
          return work(bindDisposableFinancialRows(tx,'shared',()=>sessionId));
        },{isolationLevel:Prisma.TransactionIsolationLevel.Serializable,timeout:15000});
      } catch(error) {
        const rollback=error instanceof Prisma.PrismaClientKnownRequestError && (error.code==='P2034' ||
          (error.code==='P2010' && ['40001','40P01'].includes(String(error.meta?.code))));
        if(!rollback || attempt===2) throw error;
      }
    }
  };
}
