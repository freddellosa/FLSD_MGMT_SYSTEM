import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFileSync,writeFileSync} from 'node:fs';
import {chromium, type Page} from 'playwright';
import {encodeWire,decodeWire} from '../src/lib/pilot/wire';
import {tripBalance, type DemoState} from '../src/lib/demo/store';

const origin='http://127.0.0.1:3101';
const verifyUpload=process.argv[2]==='--fictional-payments-browser-upload';
const verifyReversal=process.argv[2]==='--fictional-payments-browser-reversal';
const evidence='artifacts/qa-remediation-phase-payments/browser-payments'+(verifyUpload?'-upload':verifyReversal?'-reversal':'')+'.json';
let step='PREFLIGHT';
async function main(){
  if(!verifyUpload&&!verifyReversal&&process.argv[2]!=='--fictional-payments-browser')throw Error();
  const {url,temporaryPassword,accounts}=JSON.parse(readFileSync('.pilot-owner-access/claude-payments-qa-accounts/credentials.json','utf8')) as
    {url:string;temporaryPassword:string;accounts:{role:string;email:string}[]};
  assert.equal(url,origin+'/pilot');
  const browser=await chromium.launch({channel:'msedge'});
  const checks:string[]=[];
  type Snapshot={actor:{role:string};revision:number;state:DemoState};
  const snapshot=async(page:Page)=>{
    const response=await page.request.get(origin+'/api/pilot/workspace');
    assert.equal(response.status(),200);
    return decodeWire<Snapshot>(await response.text());
  };
  try {
    for(const account of accounts){
      step='ROLE_'+account.role;
      const context=await browser.newContext();
      try{
        const page=await context.newPage();
        page.setDefaultTimeout(10000);
        await page.goto(url);
        step=account.role+'_LOGIN_FIELDS';
        await page.getByLabel('Pilot email').fill(account.email);
        await page.getByLabel('Pilot password').fill(temporaryPassword);
        await page.getByRole('button',{name:'Sign in',exact:true}).click();
        step=account.role+'_SIGN_IN';
        await page.getByRole('button',{name:'Sign out',exact:true}).waitFor();
        assert.equal((await snapshot(page)).actor.role,account.role);
        assert.ok((await context.cookies()).some(cookie=>cookie.name==='flsd_payments_qa_session'));
        const nav=page.getByRole('navigation',{name:'Main navigation'});
        if(account.role==='OPERATIONS'){
          assert.equal(await nav.getByRole('button',{name:'Collections',exact:true}).count(),0);
          const operational=await snapshot(page);
          assert.equal(operational.state.payments.length,0);
          assert.equal(operational.state.certificates2307,undefined);
        }else{
          step=account.role+'_COLLECTIONS_NAVIGATION';
          await nav.getByRole('button',{name:'Collections',exact:true}).click();
          await page.getByRole('heading',{name:'Form 2307 reconciliation'}).waitFor();
          const canWrite=account.role!=='VIEWER';
          assert.equal(await page.getByRole('heading',{name:'Record a customer payment'}).count(),Number(canWrite));
          const before=await snapshot(page);
          const certificate=before.state.certificates2307?.[0];
          assert.ok(certificate);
          step=account.role+'_CERTIFICATE_RECONCILIATION';
          await page.locator('label').filter({hasText:'Certificate customer'}).locator('select').selectOption(certificate.customerId);
          step=account.role+'_CERTIFICATE_TABLE';
          const table=page.getByRole('table',{name:'Withholding reconciliation'});
          await table.getByRole('link',{name:'Download evidence'}).first().waitFor();
          step=account.role+'_PROTECTED_DOWNLOAD';
          assert.equal((await page.request.get(origin+'/api/pilot/evidence/'+certificate.attachmentId)).status(),200);
          assert.equal((await browser.newContext().then(async anonymous=>{
            try{return (await anonymous.request.get(origin+'/api/pilot/evidence/'+certificate.attachmentId)).status();}
            finally{await anonymous.close();}
          })),401);
          if(account.role==='BILLING'&&verifyUpload){
            step='BROWSER_FORM_2307_UPLOAD';
            const invoice=before.state.documents.find(d=>d.id===certificate.invoices[0].invoiceId)!;
            await page.getByText('Register or correct a certificate',{exact:true}).click();
            const form=page.getByRole('button',{name:'Save certificate',exact:true}).locator('xpath=ancestor::form');
            await form.getByLabel('Certificate reference',{exact:true}).fill(certificate.reference);
            await form.getByLabel('Certificate date',{exact:true}).fill(certificate.issuedDate);
            await form.getByLabel('Tax period start',{exact:true}).fill(certificate.periodStart);
            await form.getByLabel('Tax period end',{exact:true}).fill(certificate.periodEnd);
            await form.getByLabel('Certified total (PHP)',{exact:true}).fill('20.00');
            await form.getByLabel('Certified for invoice '+invoice.invoiceNumber,{exact:true}).fill('20.00');
            const attachment=Buffer.from('Fictional browser evidence');
            await form.getByLabel('Supporting document',{exact:true}).setInputFiles({
              name:'fictional-browser-evidence.txt',mimeType:'text/plain',buffer:attachment,
            });
            await form.locator('select[name="supersedes"]').selectOption(certificate.certificateId);
            await form.getByLabel('Correction reason',{exact:true}).fill('Fictional browser evidence correction');
            const committed=page.waitForResponse(r=>r.url()===origin+'/api/pilot/workspace'&&r.request().method()==='POST');
            await form.getByRole('button',{name:'Save certificate',exact:true}).click();
            assert.equal((await committed).status(),200);
            const after=await snapshot(page);
            const corrected=after.state.certificates2307?.at(-1);
            assert.equal(corrected?.supersedesId,certificate.certificateId);
            assert.equal(corrected?.certifiedCentavos,2000n);
            const file=await page.request.get(origin+'/api/pilot/evidence/'+corrected!.attachmentId);
            assert.equal(file.status(),200);
            assert.deepEqual(await file.body(),attachment);
            assert.deepEqual(after.state.payments,before.state.payments);
            assert.deepEqual(after.state.allocations,before.state.allocations);
            checks.push('Form 2307 browser upload, protected download and historical correction without a cash change');
          }
          if(account.role==='BILLING'&&!verifyUpload){
            step='BROWSER_CUSTOMER_RECEIPT';
            const invoice=before.state.documents.find(d=>d.id===certificate.invoices[0].invoiceId)!;
            const receiptForm=page.getByRole('heading',{name:'Record a customer payment'}).locator('..');
            await receiptForm.locator('label').filter({hasText:'Customer'}).locator('select').selectOption(certificate.customerId);
            await receiptForm.getByLabel('Amount received (PHP)',{exact:true}).fill('0.01');
            await receiptForm.getByLabel('Receipt reference',{exact:true}).fill('QA browser '+randomUUID());
            await receiptForm.getByLabel(new RegExp('Invoice '+invoice.invoiceNumber+' .*outstanding')).fill('0.01');
            const committed=page.waitForResponse(r=>r.url()===origin+'/api/pilot/workspace'&&r.request().method()==='POST');
            await receiptForm.getByRole('button',{name:'Record payment'}).click();
            assert.equal((await committed).status(),200);
            const after=await snapshot(page);
            const receipt=after.state.payments.at(-1)!;
            assert.equal(receipt.amount,1n);
            assert.equal(receipt.tripId,null);
            const split=after.state.allocations.find(a=>a.paymentId===receipt.id)!;
            assert.equal(split.invoiceId,invoice.id);
            assert.equal(tripBalance(after.state,split.tripId),tripBalance(before.state,split.tripId)-1n);
            const correct=async(action:unknown,revision:number)=>{
              const r=await page.request.post(origin+'/api/pilot/workspace',{headers:{origin,'content-type':'application/json'},
                data:encodeWire({operationId:randomUUID(),revision,action})});
              assert.equal(r.status(),200);
              return decodeWire<Snapshot>(await r.text());
            };
            let reversed:Snapshot;
            if(verifyReversal){
              try{
              step='RECEIPT_HISTORY_AND_BROWSER_REVERSAL';
              await page.getByRole('table',{name:'Customer payment history'}).getByRole('row').filter({hasText:receipt.id}).waitFor();
              await nav.getByRole('button',{name:'Trips',exact:true}).click();
              await page.getByRole('button',{name:'View '+split.tripId,exact:true}).click();
              await page.getByText(/Allocation history/).click();
              await page.locator('.history-card').filter({hasText:split.id}).getByRole('button',{name:'Reverse allocation'}).click();
              await page.getByLabel('Correction reason').fill('Fictional browser test rollback');
              const reversedPost=page.waitForResponse(r=>r.url()===origin+'/api/pilot/workspace'&&r.request().method()==='POST');
              await page.getByRole('button',{name:'Reverse demo allocation'}).click();
              assert.equal((await reversedPost).status(),200);
              reversed=await snapshot(page);
              assert.equal(reversed.state.allocations.find(a=>a.id===split.id)?.reversed,1n);
              checks.push('Receipt history and audited reversal through office controls');
              }catch(error){
                const current=await snapshot(page);
                const allocation=current.state.allocations.find(a=>a.id===split.id)!;
                const restored=allocation.reversed===0n
                  ?await correct({type:'REVERSE',allocationId:split.id,amount:1n,reason:'Fictional browser test rollback'},current.revision)
                  :current;
                await correct({type:'VOID',paymentId:receipt.id,reason:'Fictional browser test rollback'},restored.revision);
                throw error;
              }
            }else{
              reversed=await correct({type:'REVERSE',allocationId:split.id,amount:1n,reason:'Fictional browser test rollback'},after.revision);
            }
            const restored=await correct({type:'VOID',paymentId:receipt.id,reason:'Fictional browser test rollback'},reversed.revision);
            assert.equal(tripBalance(restored.state,split.tripId),tripBalance(before.state,split.tripId));
            checks.push('Receipt UI submission, invoice attribution and reversal reconciliation');
          }
        }
        step=account.role+'_LOGOUT';
        await page.getByRole('button',{name:'Sign out',exact:true}).click();
        await page.getByRole('button',{name:'Sign in',exact:true}).waitFor();
        assert.equal((await page.request.get(origin+'/api/pilot/workspace')).status(),401);
        checks.push(account.role+' login, navigation, scoped visibility and logout');
      }finally{await context.close();}
    }
  }finally{await browser.close();}
  const result={status:'PAYMENTS_BROWSER_VERIFIED',url,checks,independent:false};
  writeFileSync(evidence,JSON.stringify(result,null,2)+'\n',{flag:'wx'});
  console.log(JSON.stringify(result));
}
main().catch((error:unknown)=>{
  const failure=error as {name?:string;actual?:unknown;expected?:unknown};
  console.error(JSON.stringify({status:'PAYMENTS_BROWSER_STOPPED',step,kind:failure.name,
    ...(typeof failure.actual==='number'&&typeof failure.expected==='number'?{actual:failure.actual,expected:failure.expected}:{})}));
  process.exitCode=1;
});
