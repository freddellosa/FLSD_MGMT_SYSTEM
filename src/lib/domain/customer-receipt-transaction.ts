import {businessDate,requireBusinessDate} from './business-date';
import {validateAllocationProposal} from './financial-ledger';
import type {AllocationRequest,AuthorizedActor,LockedInvoice} from './payment-transaction';
import {moneyGuard} from './trip-payments';
import {requirePermission} from '../security/permissions';

export type CustomerReceiptCommand={
  customerId:string;
  key:string;
  actor:AuthorizedActor;
  receivedCentavos:bigint;
  receivedDate:string;
  method:'CASH'|'BANK_TRANSFER'|'GCASH';
  reference:string;
  allocations:(AllocationRequest & {expectedOutstandingCentavos?:bigint})[];
};
export class StaleReceiptBalance extends Error {
  constructor(){super('An invoice balance changed. Refresh before recording payment.');}
}
type CommittedReceipt={paymentId:string;operationId:string;allocatedCentavos:bigint};
export interface CustomerReceiptTransaction {
  /** Read the authorized scoped receipt under the shared operation lock, or refuse an incompatible replay. */
  findReceipt(key:string,digest:string):Promise<CommittedReceipt|null>;
  lockInvoices(ids:readonly string[]):Promise<LockedInvoice[]>;
  /** Append one Batch 7 payment and its allocation events, projections, receipt and audit atomically. */
  appendReceiptAndAllocations(command:CustomerReceiptCommand,digest:string):Promise<CommittedReceipt>;
}

/** Caller owns verified staff identity, customer lock, Serializable commit and retries. */
export async function recordCustomerReceiptInTransaction(
  tx:CustomerReceiptTransaction,input:CustomerReceiptCommand,sha256:(value:string)=>string,today=businessDate(),
) {
  const command=structuredClone(input);
  requirePermission(command.actor.role,'payment:write');
  for(const value of [command.customerId,command.key,command.actor.id,command.reference]){
    if(typeof value!=='string'||!value.trim()||value.length>200)throw new Error('Customer, operation, actor and receipt reference required');
  }
  moneyGuard(command.receivedCentavos,true);
  if(!['CASH','BANK_TRANSFER','GCASH'].includes(command.method))throw new Error('Invalid office receipt method');
  requireBusinessDate(command.receivedDate,'Collection date');
  if(command.receivedDate>today)throw new Error('Collection date cannot be in the future');
  if(!command.allocations.length||command.allocations.length>1000)throw new Error('Select at least one invoice');
  if(command.allocations.some(a=>typeof a.invoiceId!=='string'||!a.invoiceId||a.withheldCentavos!==0n)){
    throw new Error('Select valid invoices. Withholding allocation awaits accounting approval.');
  }
  for(const row of command.allocations){
    moneyGuard(row.cashCentavos,true);
    if(row.expectedOutstandingCentavos!==undefined)moneyGuard(row.expectedOutstandingCentavos);
  }
  command.allocations.sort((a,b)=>a.invoiceId<b.invoiceId?-1:a.invoiceId>b.invoiceId?1:0);
  const ids=command.allocations.map(a=>a.invoiceId);
  if(new Set(ids).size!==ids.length)throw new Error('Duplicate invoice');
  const digest=sha256(JSON.stringify({
    type:'RECORD_CUSTOMER_RECEIPT',customerId:command.customerId,actorId:command.actor.id,actorRole:command.actor.role,
    receivedDate:command.receivedDate,receivedCentavos:command.receivedCentavos.toString(),method:command.method,reference:command.reference,
    allocations:command.allocations.map(a=>a.expectedOutstandingCentavos===undefined
      ?[a.invoiceId,a.cashCentavos.toString()]
      :[a.invoiceId,a.cashCentavos.toString(),a.expectedOutstandingCentavos.toString()]),
  }));
  const prior=await tx.findReceipt(command.key,digest);
  if(prior)return {...prior,replayed:true};
  const locked=await tx.lockInvoices(ids);
  const byId=new Map(locked.map(invoice=>[invoice.id,invoice]));
  if(locked.length!==ids.length||byId.size!==ids.length)throw new Error('Invoice lock set is incomplete');
  const proposed=command.allocations.map(allocation=>{
    const invoice=byId.get(allocation.invoiceId);
    if(!invoice?.eligible)throw new Error('Invoice not eligible');
    if(invoice.customerId===command.customerId && allocation.expectedOutstandingCentavos!==undefined &&
      allocation.expectedOutstandingCentavos!==invoice.outstandingCentavos)throw new StaleReceiptBalance();
    return {...allocation,customerId:invoice.customerId,outstandingCentavos:invoice.outstandingCentavos};
  });
  const allocated=validateAllocationProposal(command.customerId,{
    receivedCentavos:command.receivedCentavos,allocationsCentavos:0n,pendingRefundsCentavos:0n,completedRefundsCentavos:0n,
  },proposed);
  if(allocated!==command.receivedCentavos)throw new Error('Allocate the full receipt. Unapplied corporate cash requires review.');
  return {...await tx.appendReceiptAndAllocations(command,digest),replayed:false};
}
