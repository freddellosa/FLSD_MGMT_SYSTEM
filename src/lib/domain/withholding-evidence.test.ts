import {describe,expect,it} from 'vitest';
import {reconcileWithholdingEvidence} from './withholding-evidence';

const invoice={invoiceId:'invoice-a',customerId:'customer',expectedCentavos:2001n};
const certificate={certificateId:'fixture-2307',customerId:'customer',issuedDate:'2026-11-19',attachmentId:'protected-file',
  certifiedCentavos:3001n,invoices:[{invoiceId:'invoice-a',certifiedCentavos:2001n},{invoiceId:'invoice-b',certifiedCentavos:1000n}]};
describe('Form 2307 evidence review',()=>{
  it('reconciles exact amounts and protected attachment references without assuming unknown expectations',()=>{
    expect(reconcileWithholdingEvidence(invoice,[certificate])).toMatchObject({
      status:'MATCHED',evidencedCentavos:2001n,differenceCentavos:0n,attachmentIds:['protected-file'],
    });
    expect(reconcileWithholdingEvidence({...invoice,expectedCentavos:null},[certificate])).toMatchObject({
      status:'EXPECTATION_UNREVIEWED',differenceCentavos:null,
    });
    expect(reconcileWithholdingEvidence(invoice,[])).toMatchObject({status:'SHORT',differenceCentavos:-2001n});
  });
  it('refuses duplicated certificates, foreign customer evidence and mismatched totals',()=>{
    expect(()=>reconcileWithholdingEvidence(invoice,[certificate,certificate])).toThrow('Unique certificate');
    expect(()=>reconcileWithholdingEvidence(invoice,[{...certificate,customerId:'other'}])).toThrow('customer scope');
    expect(()=>reconcileWithholdingEvidence(invoice,[{...certificate,certifiedCentavos:3000n}])).toThrow('do not reconcile');
  });
});
