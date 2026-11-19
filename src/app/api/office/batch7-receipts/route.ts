import {officeReceiptBinding} from '@/lib/production/candidate-office-receipt-binding';
import {officeSessionToken,postOfficeReceipt} from '@/lib/production/candidate-office-receipt-http';
import {createCandidatePostgresCustomerReceipt,readCandidateOfficeBalances} from '@/lib/production/candidate-postgres-customer-receipt';
import {failure,localRequest,response} from '@/lib/pilot/http';

export const runtime='nodejs';
export const dynamic='force-dynamic';
export async function GET(req:Request){
  const target=officeReceiptBinding();
  if(!target||(target.mode!=='browser'&&target.mode!=='qa'))return response({error:'Receipt route unavailable'},404);
  try{
    localRequest(req);
    return response(await readCandidateOfficeBalances(target.client,target.identity,target.mode,officeSessionToken(req)));
  }catch(error){
    if(error instanceof Error&&error.message==='Forbidden')return response({error:'Receipt authorization required'},403);
    return failure(error);
  }
}

export async function POST(req:Request){
  const target=officeReceiptBinding();
  if(!target)return response({error:'Receipt route unavailable'},404);
  return postOfficeReceipt(req,token=>createCandidatePostgresCustomerReceipt(target.client,target.identity,async()=>token,target.mode));
}
