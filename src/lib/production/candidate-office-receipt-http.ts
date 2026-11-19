import {body, failure, localRequest, PilotError, response} from '../pilot/http';
import {StaleReceiptBalance} from '../domain/customer-receipt-transaction';
import {MAX_CENTAVOS} from '../domain/trip-payments';
import {ReceiptKeyConflict, ReceiptReferenceConflict, type createCandidatePostgresCustomerReceipt} from './candidate-postgres-customer-receipt';

export const officeReceiptCookie='flsd_batch7_office_receipt';
type RecordReceipt=ReturnType<typeof createCandidatePostgresCustomerReceipt>;
type Command=Parameters<RecordReceipt>[0];
const id=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const key=/^[a-z0-9-]{1,160}$/;
const cents=(value:unknown):value is bigint=>typeof value==='bigint'&&value>0n&&value<=MAX_CENTAVOS;
const object=(value:unknown):value is Record<string,unknown>=>Boolean(value)&&typeof value==='object'&&!Array.isArray(value);

function parseCommand(input:unknown):Command{
  if(!object(input)||Object.keys(input).some(k=>!['key','customerId','receivedCentavos','receivedDate','method','reference','allocations'].includes(k))){
    throw new PilotError(400,'Invalid receipt input');
  }
  const {customerId,receivedCentavos,receivedDate,method,reference,allocations}=input;
  if(typeof input.key!=='string'||!key.test(input.key)||typeof customerId!=='string'||!id.test(customerId)||
    !cents(receivedCentavos)||typeof receivedDate!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)||
    (method!=='CASH'&&method!=='BANK_TRANSFER'&&method!=='GCASH')||typeof reference!=='string'||!reference.trim()||
    reference.length>200||!Array.isArray(allocations)||!allocations.length||allocations.length>1000){
    throw new PilotError(400,'Invalid receipt input');
  }
  return {key:input.key,customerId,receivedCentavos,receivedDate,method,reference:reference.trim(),
    allocations:allocations.map(row=>{
      if(!object(row)||Object.keys(row).some(k=>!['invoiceId','cashCentavos','expectedOutstandingCentavos'].includes(k))||
        typeof row.invoiceId!=='string'||!id.test(row.invoiceId)||!cents(row.cashCentavos)||!cents(row.expectedOutstandingCentavos)){
        throw new PilotError(400,'Invalid invoice allocation or expected balance');
      }
      return {invoiceId:row.invoiceId,cashCentavos:row.cashCentavos,expectedOutstandingCentavos:row.expectedOutstandingCentavos,withheldCentavos:0n};
    }),
  };
}

export function officeSessionToken(req:Request){
    const cookies=(req.headers.get('cookie')??'').split(';').map(part=>part.trim()).filter(part=>part.startsWith(officeReceiptCookie+'='));
    const token=cookies[0]?.slice(officeReceiptCookie.length+1)??'';
    if(cookies.length!==1||!/^[a-f0-9]{64}$/.test(token))throw new PilotError(401,'Sign in required');
    return token;
}

export async function postOfficeReceipt(req:Request, recordForToken:(token:string)=>RecordReceipt){
  try{
    localRequest(req,true);
    const token=officeSessionToken(req);
    const command=parseCommand(await body(req));
    const receipt=await recordForToken(token)(command);
    return response(receipt,receipt.replayed?200:201);
  }catch(error){
    if(error instanceof StaleReceiptBalance)return response({error:error.message,code:'STALE_BALANCE'},409);
    if(error instanceof ReceiptKeyConflict||error instanceof ReceiptReferenceConflict)return response({error:error.message},409);
    if(error instanceof Error){
      if(error.message==='Forbidden')return response({error:'Receipt authorization required'},403);
      if(['Invoice not eligible','Invoice lock set is incomplete','Cross-customer allocation','Invoice overallocated','Duplicate invoice',
        'Payment cash overallocated','Collection date must be a valid date','Collection date cannot be in the future',
        'Allocate the full receipt. Unapplied corporate cash requires review.'].includes(error.message)){
        return response({error:'Receipt could not be allocated. Review the invoice balances and payment details.'},422);
      }
    }
    return failure(error);
  }
}
