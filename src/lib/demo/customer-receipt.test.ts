import {describe, expect, it} from 'vitest';
import {demoTotals, emptyDemo, executeDemo, tripBalance, type DemoAction} from './store';
import type {ReceiptSplit} from './customer-receipt';
import {invoiceWithholding} from './form-2307';

function fixture() {
  let state = emptyDemo();
  let sequence = 0;
  const run = (action: DemoAction) => {
    state = executeDemo(state, action, String(++sequence), 'BILLING');
  };
  const invoice = (customerId: string) => {
    run({type:'CREATE_TRIP',trip:{customerId,date:'2026-11-14',workflow:'CORPORATE',amount:10000n,
      driver:state.drivers[0].label,vehicle:state.vehicles[0].label,origin:'Office',destination:'Depot'}});
    const trip = state.trips.at(-1)!;
    run({type:'CREATE_SOA',tripIds:[trip.id]});
    const soaId = state.documents.at(-1)!.id;
    run({type:'FINALIZE_SOA',soaId,expectedVersion:1});
    run({type:'CREATE_INVOICE',soaId,expectedSoaVersion:2,invoiceDate:trip.date});
    return state.documents.at(-1)!;
  };
  const first = invoice('c1'), second = invoice('c1'), foreign = invoice('accenture');
  const action = {type:'RECORD_CUSTOMER_RECEIPT',customerId:'c1',receivedDate:'2026-11-14',
    method:'BANK_TRANSFER',reference:'Fictional transfer',amount:14001n,splits:[
      {invoiceId:first.id,expectedVersion:first.version,amount:10000n},
      {invoiceId:second.id,expectedVersion:second.version,amount:4001n},
    ]} as const;
  return {state,first,second,foreign,action:{...action,splits:[...action.splits]}};
}

const capability = {allowCustomerReceipts:true} as const;

describe('customer receipts in the shared pilot aggregate', () => {
  it('posts one receipt, settles one invoice, partially pays another, and reconciles after reversal', () => {
    const {state, first, second, action} = fixture();
    const next = executeDemo(state, action, 'receipt', 'BILLING', capability);
    expect(next.payments).toHaveLength(1);
    expect(next.allocations).toHaveLength(2);
    expect(tripBalance(next, first.tripIds[0])).toBe(0n);
    expect(tripBalance(next, second.tripIds[0])).toBe(5999n);
    expect(demoTotals(next).outstanding).toBe(demoTotals(state).outstanding - 14001n);
    expect(executeDemo(next, action, 'receipt', 'BILLING', capability)).toEqual(next);
    const reversal = {type:'REVERSE',allocationId:next.allocations[1].id,amount:1n,reason:'Correct application'} as const;
    const corrected = executeDemo(next, reversal, 'reversal', 'BILLING', capability);
    expect(demoTotals(corrected).outstanding).toBe(16000n);
    expect(corrected.payments).toEqual(next.payments);
    expect(corrected.events.at(-1)?.detail).toContain('Correct application');
    expect(() => executeDemo(corrected, action, 'new receipt', 'BILLING', capability)).toThrow('already recorded');
    expect(() => executeDemo(corrected, {...action,reference:'Different receipt'}, 'new receipt', 'BILLING', capability)).toThrow('Invoice changed');
  });

  it('rejects over-allocation, cross-customer allocation, duplicate invoices, and unauthorized writes', () => {
    const {state, foreign, action} = fixture();
    const first = action.splits[0];
    const submit = (splits: ReceiptSplit[], amount: bigint) =>
      executeDemo(state, {...action,splits,amount}, 'receipt', 'BILLING', capability);
    expect(() => submit([{...first,amount:10001n}],10001n)).toThrow();
    expect(() => submit([{...first,invoiceId:foreign.id,expectedVersion:foreign.version}],10000n)).toThrow('eligible');
    expect(() => submit([first,first],20000n)).toThrow('Duplicate invoice');
    expect(() => executeDemo(state, action, 'receipt', 'VIEWER', capability)).toThrow('Forbidden');
    expect(() => executeDemo(state, action, 'receipt', 'BILLING')).toThrow('schema upgrade');
    expect(state.payments).toHaveLength(0);
  });

  it('reconciles Form 2307 separately from cash and keeps superseded evidence', () => {
    const {state,first,second,foreign} = fixture();
    const recorded = executeDemo(state,{type:'SET_WITHHOLDING_EXPECTATION',invoiceId:first.id,
      amount:200n,reason:'Expected from fictional billing profile'},'expect','BILLING',capability);
    expect(invoiceWithholding(recorded,first.id,'c1')).toMatchObject({received:false,status:'SHORT'});
    const certificate = {type:'REGISTER_FORM_2307',customerId:'c1',reference:'QA-001',
      issuedDate:'2026-11-14',periodStart:'2026-10-01',periodEnd:'2026-10-31',amount:150n,
      lines:[{invoiceId:first.id,amount:100n},{invoiceId:second.id,amount:50n}],
      file:{name:'fictional.txt',type:'text/plain',size:2,data:'data:text/plain;base64,b2s='},
    } as const;
    const action = {...certificate,lines:[...certificate.lines]};
    expect(() => executeDemo(recorded,action,'evidence','VIEWER',capability)).toThrow('Forbidden');
    expect(() => executeDemo(recorded,{...action,lines:[{invoiceId:foreign.id,amount:150n}]},'evidence','BILLING',capability)).toThrow('selected customer');
    expect(() => executeDemo(recorded,{...action,amount:151n},'evidence','BILLING',capability)).toThrow('do not reconcile');
    const received = executeDemo(recorded,action,'evidence','BILLING',capability);
    expect(invoiceWithholding(received,first.id,'c1')).toMatchObject({received:true,evidencedCentavos:100n,differenceCentavos:-100n});
    const replaced = executeDemo(received,{...action,amount:250n,lines:[{invoiceId:first.id,amount:200n},action.lines[1]],
      supersedesId:received.certificates2307![0].certificateId,reason:'Correct invoice amount'},'replace','ADMIN',capability);
    expect(invoiceWithholding(replaced,first.id,'c1')).toMatchObject({received:true,status:'MATCHED'});
    expect(replaced.collectionEvidence).toHaveLength(2);
    expect(replaced.certificates2307).toHaveLength(2);
    expect(demoTotals(replaced)).toEqual(demoTotals(state));
  });
});
