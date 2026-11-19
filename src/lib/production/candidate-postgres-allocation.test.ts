import {createHash} from 'node:crypto';
import type {PrismaClient} from '@prisma/client';
import {describe, expect, it} from 'vitest';
import {acceptCandidateAllocation} from './candidate-allocation-acceptance';
import {createCandidatePostgresAllocationPort} from './candidate-postgres-allocation';

const id = (n: string) => '70000000-0000-4000-8000-0000000000'+n;
const token = 'b'.repeat(64);
const command = {
  paymentId:id('06'), customerId:id('02'), idempotencyKey:'candidate-bound',
  reason:'Synthetic canonical allocation', allocations:[{invoiceId:id('05'), cashCentavos:600n, withheldCentavos:0n}],
};
const digest = createHash('sha256').update(JSON.stringify({
  operationType:'ALLOCATE_PAYMENT',actorId:id('01'),actorRole:'BILLING',reason:command.reason,
  paymentId:id('06'),customerId:id('02'),allocations:[[id('05'),'600','0']],
})).digest('hex');

function setup(options: {identity?:boolean; authorized?:boolean; failAudit?:boolean; conflict?:boolean; expire?:boolean} = {}) {
  type Receipt = {id:string; digest:string; key:string; cash:bigint};
  let saved: Receipt | undefined;
  let amount = 1001n;
  const writes: string[] = [];
  const traces: string[][] = [];
  const client = {
    async $transaction<T>(work: (db:unknown) => Promise<T>, settings:unknown) {
      expect(settings).toEqual({isolationLevel:'Serializable'});
      const trace: string[] = [];
      traces.push(trace);
      let staged = saved;
      let projected = amount;
      let currentReads = 0;
      const db = {
        async $queryRaw(template:TemplateStringsArray, ...params:unknown[]) {
          const sql = template.join('?');
          if (sql.includes('AS verified')) { trace.push('identity'); return [{verified:options.identity!==false}]; }
          if (sql.includes('FOR SHARE OF a')) { trace.push('staff fence'); return [{staff_id:id('01')}]; }
          if (sql.includes('s.expires_at>statement_timestamp()')) {
            trace.push('session');
            currentReads++;
            expect(params).toContain(createHash('sha256').update(token).digest('hex'));
            return options.authorized===false || (options.expire && currentReads===2) ? [] :
              [{id:id('16'),role:'BILLING',revision:1n}];
          }
          if (sql.includes('pg_advisory_xact_lock')) {
            trace.push(sql.includes('176662') ? 'key' : sql.includes('176663') ? 'customer' : 'upgrade');
            return [{ok:true}];
          }
          if (sql.includes('SELECT r.id')) { trace.push('scope'); return [{id:id('14')}]; }
          if (sql.includes('AS "receiptValid"')) {
            trace.push('receipt');
            const fields = {actorId:id('01'),kind:'ALLOCATE_PAYMENT',receiptValid:true,visible:true,bound:true};
            if (params.at(-1)==='candidate-unbound') return [{...fields,bound:false}];
            if (params.at(-1)==='candidate-bound') return [{...fields,id:id('07'),digest,cash:600n}];
            return staged?.key===params.at(-1) ? [{...fields,...staged}] : [];
          }
          if (sql.includes('AS "allocationsCentavos"')) return [{
            customerId:id('02'),state:'RECORDED',receivedCentavos:10001n,allocationsCentavos:projected,
            pendingRefundsCentavos:2500n,completedRefundsCentavos:500n,
          }];
          if (sql.includes('AS "outstandingCentavos"')) return [{
            id:id('05'),customerId:id('02'),eligible:true,outstandingCentavos:7000n-projected,
          }];
          if (sql.includes('AS history')) return [{
            history:'opening rows',operationCount:staged?3:2,eventCount:staged?3:2,auditCount:staged?2:1,
            reservationCount:1,scopeCount:staged?2:1,allocatedCentavos:projected,receivedCentavos:10001n,
            pendingRefundCentavos:2500n,completedRefundCentavos:500n,payableCentavos:7000n,
            reservation:{operationId:id('07'),invoiceId:id('05'),receivableId:id('14')},
          }];
          if (sql.includes('a.after=o.receipt')) return staged ? [{
            operationId:staged.id,cashCentavos:staged.cash,actorId:id('01'),invoiceId:id('05'),receivableId:id('14'),
          }] : [];
          throw new Error('Unexpected query');
        },
        async $executeRaw(template:TemplateStringsArray, ...params:string[]) {
          const sql = template.join('?');
          if (sql.startsWith('SET')) { trace.push(sql); return 0; }
          const relation = /flsd_batch7_commit_rehearsal\.(\S+)/.exec(sql)?.[1];
          if (!relation) throw new Error('Unexpected mutation');
          writes.push(relation);
          if (relation==='"FinancialOperation"') {
            if (options.conflict) { options.conflict=false; throw {code:'P2010',meta:{code:'40001'}}; }
            const [id,key,digest,,,cash] = params;
            staged = {id,key,digest,cash:BigInt(cash)};
          }
          if (relation==='"PaymentAllocation"') {
            expect(sql).toContain('SET amount=amount+');
            projected += BigInt(params[0]);
          }
          if (relation==='"AuditEvent"' && options.failAudit) throw new Error('Synthetic audit failure');
          return 1;
        },
      };
      const result = await work(db);
      saved = staged;
      amount = projected;
      return result;
    },
  } as unknown as Pick<PrismaClient,'$transaction'>;
  return {port:createCandidatePostgresAllocationPort(client,'20000',async()=>token),writes,traces};
}

const fresh = {
  ...command,idempotencyKey:'candidate-acceptance-allocation',reason:'Synthetic allocation after upgrade',
  allocations:[{invoiceId:id('05'),cashCentavos:2001n,withheldCentavos:0n}],
};

describe('Candidate PostgreSQL allocation port with injected transaction', () => {
  it('runs acceptance, preserving the opening allocation and executing zero writes on replay or refusal', async () => {
    const {port,writes,traces} = setup();
    await expect(acceptCandidateAllocation(port)).resolves.toMatchObject({status:'BATCH7_CANDIDATE_ALLOCATION_ACCEPTANCE_VERIFIED'});
    expect(writes).toEqual(['"FinancialOperation"','operation_scope','"PaymentAllocation"','"PaymentAllocationEvent"','"AuditEvent"']);
    expect(traces[0]).toContain('SET TRANSACTION READ ONLY');
    expect(traces[1]).toEqual(['SET LOCAL search_path TO pg_catalog','identity','upgrade','staff fence',
      'session','key','customer','scope','receipt','session']);
  });

  it.each([{identity:false},{authorized:false}])('refuses before financial writes when verification fails (%j)', async options => {
    const {port,writes} = setup(options);
    await expect(port.allocate(fresh)).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it('rejects changes to replay payload and allocations exceeding credit or receivable', async () => {
    const {port,writes} = setup();
    await expect(port.allocate({...command,reason:'different'})).rejects.toThrow('Candidate receipt mismatch');
    await expect(port.allocate({...fresh,allocations:[{...fresh.allocations[0],cashCentavos:6000n}]})).rejects.toThrow();
    await expect(port.allocate({...fresh,allocations:[{...fresh.allocations[0],cashCentavos:8000n}]})).rejects.toThrow();
    expect(writes).toEqual([]);
  });

  it.each([{failAudit:true},{expire:true}])('does not commit staged effects on audit or final authorization failure (%j)', async options => {
    const {port} = setup(options);
    await expect(port.allocate(fresh)).rejects.toThrow();
    await expect(port.inspect()).resolves.toMatchObject({allocatedCentavos:1001n,latestEffect:null,operationCount:2});
  });

  it('retries a raw serialization failure in a fresh transaction', async () => {
    const {port,traces} = setup({conflict:true});
    await expect(port.allocate(fresh)).resolves.toMatchObject({allocatedCashCentavos:2001n,replayed:false});
    expect(traces).toHaveLength(2);
    await expect(port.inspect()).resolves.toMatchObject({allocatedCentavos:3002n,operationCount:3});
  });
});
