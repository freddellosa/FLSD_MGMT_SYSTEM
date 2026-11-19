'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {randomUUID}=require('node:crypto');
const {chromium}=require('playwright');

const origin='http://127.0.0.1:3001';
const workspace='D:\\FLSD-Batch7-Validation';
const target=path.join(workspace,'.pilot-owner-access','claude-qa-accounts','credentials.json');
const roles=['OWNER','ADMIN','BILLING','OPERATIONS','VIEWER'];
const financeRoles=new Set(['OWNER','ADMIN','BILLING','VIEWER']);
const managers=new Set(['OWNER','ADMIN']);
let phase='PREFLIGHT';
let currentRole;

async function run(){
  if(process.argv[2]!=='--verified-isolated-pilot'||process.cwd()!==workspace||
     fs.realpathSync(target).toLowerCase()!==target.toLowerCase())throw Error();
  const credentials=JSON.parse(fs.readFileSync(target,'utf8'));
  if(credentials.url!==origin+'/pilot'||typeof credentials.temporaryPassword!=='string'||
    !Array.isArray(credentials.accounts)||credentials.accounts.length!==roles.length)throw Error();
  const browser=await chromium.launch({channel:'msedge'});
  const contexts=[];
  const signedIn=[];
  const results=[];
  try{
    for(const role of roles){
      currentRole=role;
      phase='ROLE_NAVIGATION_AND_AUTHORIZATION';
      const email='qa.'+role.toLowerCase()+'@flsd.test';
      const account=credentials.accounts.find(a=>a.role===role&&a.email===email);
      if(!account)throw Error();
      const context=await browser.newContext({baseURL:origin,viewport:{width:1366,height:850}});
      contexts.push(context);
      const page=await context.newPage();
      await page.goto('/pilot');
      await page.getByLabel('Pilot email').fill(account.email);
      await page.getByLabel('Pilot password').fill(credentials.temporaryPassword);
      await page.getByRole('button',{name:'Sign in',exact:true}).click();
      const nav=page.getByRole('navigation',{name:'Main navigation'});
      await nav.waitFor({state:'visible',timeout:15000});
      assert.equal(await page.locator('.pilot-actor-label').textContent(),'Fictional QA '+role+' - '+role);
      const navigation=async name=>await nav.getByRole('button',{name,exact:true}).count();
      assert.equal(await navigation('Trips'),1);
      assert.equal(await navigation('Settings'),managers.has(role)?1:0);
      assert.equal(await navigation('Activity'),managers.has(role)?1:0);
      assert.equal(await navigation('Invoices'),financeRoles.has(role)?1:0);
      assert.equal(await navigation('Reports'),financeRoles.has(role)?1:0);
      await nav.getByRole('button',{name:'Trips',exact:true}).click();
      await page.getByRole('table',{name:'Trip register',exact:true}).waitFor();
      assert.equal(await page.getByRole('button',{name:'New trip',exact:true}).count(),role==='VIEWER'?0:1);
      const response=await page.request.get('/api/pilot/workspace');
      assert.equal(response.status(),200);
      const {actor,revision,state}=await response.json();
      assert.equal(actor.role,role);
      assert.equal(actor.email,account.email);
      assert.equal((await page.request.get('/api/pilot/users')).status(),managers.has(role)?200:403);
      assert.equal((await page.request.get('/api/pilot/evidence/QA-NONEXISTENT')).status(),financeRoles.has(role)?404:403);
      if(!managers.has(role)) assert.equal(state.events.length,0);
      if(role==='OPERATIONS'){
        for(const key of ['payments','allocations','refunds','remittances','collectionEvidence']) assert.equal(state[key].length,0);
      }
      const action=role==='OPERATIONS'?{type:'CREATE_SOA',tripIds:[]}:{
        type:'SAVE_DRIVER',driver:{name:'QA authorization probe',phone:'',license:'',notes:''},
      };
      // Deliberately stale revision prevents writes even if the permission guard were to regress.
      const crossOrigin=managers.has(role);
      const rejected=await page.request.post('/api/pilot/workspace',{
        headers:{Origin:crossOrigin?'https://invalid.example':origin},
        data:{operationId:randomUUID(),revision:revision-1,action},
      });
      assert.equal(rejected.status(),403);
      signedIn.push({page,id:actor.id,role});
      results.push({role,browserSignIn:true,navigation:true,restrictedRequestDenied:true});
    }
    phase='SESSION_ISOLATION_AND_LOGOUT';
    assert.equal(new Set(signedIn.map(item=>item.id)).size,roles.length);
    for(const [index,{page,role}] of signedIn.entries()){
      currentRole=role;
      await page.getByRole('button',{name:'Sign out',exact:true}).click();
      await page.getByLabel('Pilot email').waitFor({state:'visible'});
      assert.equal((await page.request.get('/api/pilot/workspace')).status(),401);
      for(const other of signedIn.slice(index+1)){
        const response=await other.page.request.get('/api/pilot/workspace');
        assert.equal(response.status(),200);
        assert.equal((await response.json()).actor.id,other.id);
      }
      Object.assign(results[index],{logout:true,isolatedSession:true});
    }
    const evidence={status:'QA_MULTI_ROLE_BROWSER_SMOKE_VERIFIED',browser:'Microsoft Edge',at:new Date().toISOString(),
      scope:'isolated-pilot',independentClaudeRun:false,results};
    fs.writeFileSync(path.join(workspace,'artifacts','claude-invoicing-qa','multi-role-provisioning-smoke.json'),
      JSON.stringify(evidence,null,2)+'\n',{flag:'wx'});
    console.log(JSON.stringify(evidence));
  }finally{
    for(const context of contexts){
      await context.request.post('/api/pilot/logout',{headers:{Origin:origin}}).catch(()=>{});
      await context.close();
    }
    await browser.close();
  }
}
run().catch(()=>{
  console.error(JSON.stringify({status:'QA_BROWSER_VERIFICATION_STOPPED',phase,role:currentRole}));
  process.exitCode=1;
});
