import {requireBusinessDate} from './business-date';
import {moneyGuard} from './trip-payments';

type InvoiceExpectation={invoiceId:string;customerId:string;expectedCentavos:bigint|null};
export type Form2307Evidence={
  certificateId:string;
  customerId:string;
  issuedDate:string;
  attachmentId:string;
  certifiedCentavos:bigint;
  invoices:readonly {invoiceId:string;certifiedCentavos:bigint}[];
};

/** Reconciles scoped evidence for review. Actual cash and effective allocations are untouched. */
export function reconcileWithholdingEvidence(invoice:InvoiceExpectation,certificates:readonly Form2307Evidence[]){
  if(invoice.expectedCentavos!==null)moneyGuard(invoice.expectedCentavos);
  const seen=new Set<string>();
  const attachments=new Set<string>();
  let evidencedCentavos=0n;
  for(const record of certificates){
    if(!record.certificateId.trim()||!record.attachmentId.trim()||seen.has(record.certificateId)){
      throw new Error('Unique certificate and protected attachment references are required');
    }
    seen.add(record.certificateId);
    requireBusinessDate(record.issuedDate,'Certificate date');
    moneyGuard(record.certifiedCentavos,true);
    const invoiceIds=new Set<string>();
    let certified=0n;
    for(const line of record.invoices){
      if(!line.invoiceId.trim()||invoiceIds.has(line.invoiceId))throw new Error('Duplicate or missing invoice evidence');
      invoiceIds.add(line.invoiceId);
      moneyGuard(line.certifiedCentavos,true);
      certified+=line.certifiedCentavos;
      if(line.invoiceId===invoice.invoiceId){
        if(record.customerId!==invoice.customerId)throw new Error('Certificate customer scope mismatch');
        evidencedCentavos+=line.certifiedCentavos;
        attachments.add(record.attachmentId);
      }
    }
    if(certified!==record.certifiedCentavos)throw new Error('Certificate amount and invoice evidence do not reconcile');
  }
  const differenceCentavos=invoice.expectedCentavos===null?null:evidencedCentavos-invoice.expectedCentavos;
  return {expectedCentavos:invoice.expectedCentavos,evidencedCentavos,differenceCentavos,
    status:differenceCentavos===null?'EXPECTATION_UNREVIEWED':differenceCentavos===0n?'MATCHED':differenceCentavos<0n?'SHORT':'EXCESS',
    attachmentIds:[...attachments]};
}
