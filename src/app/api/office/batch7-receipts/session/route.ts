import {officeReceiptBinding} from '@/lib/production/candidate-office-receipt-binding';
import {officeReceiptCookie,officeSessionToken} from '@/lib/production/candidate-office-receipt-http';
import {candidateOfficeSignIn,revokeCandidateOfficeSession} from '@/lib/production/candidate-postgres-customer-receipt';
import {body,failure,localRequest,response} from '@/lib/pilot/http';

export const runtime='nodejs';
export const dynamic='force-dynamic';
const cookie='; HttpOnly; SameSite=Strict; Path=/api/office/batch7-receipts; Max-Age=';
let windowStart=0;
let loginAttempts=0;

export async function POST(req:Request){
  const target=officeReceiptBinding();
  if(target?.mode!=='qa')return response({error:'Receipt route unavailable'},404);
  try{
    localRequest(req,true);
    const input=await body<{email?:unknown;password?:unknown}>(req);
    if(!input||typeof input.email!=='string'||input.email.length>200||typeof input.password!=='string'||input.password.length>128){
      return response({error:'Invalid sign-in details'},400);
    }
    const now=Date.now();
    if(now-windowStart>=60000){windowStart=now;loginAttempts=0;}
    if(loginAttempts>=20)return response({error:'Too many sign-in attempts. Try again in one minute.'},429);
    loginAttempts++;
    const token=await candidateOfficeSignIn(target.client,target.identity,input.email.trim().toLowerCase(),input.password);
    if(!token)return response({error:'Invalid email or password'},401);
    return response({ok:true},200,{'Set-Cookie':officeReceiptCookie+'='+token+cookie+'14400'});
  }catch(error){return failure(error);}
}

export async function DELETE(req:Request){
  const target=officeReceiptBinding();
  if(target?.mode!=='qa')return response({error:'Receipt route unavailable'},404);
  try{
    localRequest(req,true);
    await revokeCandidateOfficeSession(target.client,target.identity,officeSessionToken(req));
    return response({ok:true},200,{'Set-Cookie':officeReceiptCookie+'='+cookie+'0'});
  }catch(error){return failure(error);}
}
