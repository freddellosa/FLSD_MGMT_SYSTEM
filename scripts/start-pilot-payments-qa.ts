import {createHash,createHmac,pbkdf2Sync,randomBytes} from 'node:crypto';
import {execFileSync,spawn} from 'node:child_process';
import {existsSync,readFileSync,realpathSync,writeFileSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';
import {createServer} from 'node:net';

const root='D:\\FLSD-Batch7-Validation';
const stage=join(root,'artifacts','qa-remediation-phase-payments');
const database='flsd_pilot_qa_phase_payments', writer=database+'_app';
const marker='ISOLATED_PHASE_PAYMENTS_QA_ONLY';
const origin='http://127.0.0.1:3101';
const runtime=join(stage,'.pilot','runtime.json');

function scramVerifier(password:string){
  const salt=randomBytes(16);
  const key=pbkdf2Sync(password,salt,4096,32,'sha256');
  const client=createHmac('sha256',key).update('Client Key').digest();
  const stored=createHash('sha256').update(client).digest('base64');
  const server=createHmac('sha256',key).update('Server Key').digest('base64');
  return 'SCRAM-SHA-256$4096:'+salt.toString('base64')+'$'+stored+':'+server;
}

async function main(){
  if(process.argv[2]!=='--start-verified-fictional-candidate'||resolve('.')!==root||
    realpathSync(stage).toLowerCase()!==stage.toLowerCase()||existsSync(runtime)||
    realpathSync(dirname(runtime)).toLowerCase()!==dirname(runtime).toLowerCase())throw Error();
  await new Promise<void>((resolvePort,reject)=>{
    const server=createServer();
    server.once('error',reject);
    server.listen(3101,'127.0.0.1',()=>server.close(error=>error?reject(error):resolvePort()));
  });
  const evidence=JSON.parse(readFileSync(join(stage,'connected-phase-payments.json'),'utf8'));
  if(evidence.status!=='PHASE_PAYMENTS_CONNECTED_CANDIDATE_VERIFIED'||evidence.databaseOid!=='26236'||!evidence.synthetic)throw Error();
  const config=JSON.parse(readFileSync(join(root,'.pilot','maintenance.json'),'utf8'));
  if(config.marker!=='FLSD_ISOLATED_PILOT_ONLY'||config.host!=='127.0.0.1'||config.port!==55437||
    config.database!=='flsd_pilot_validation'||config.user!=='flsd_pilot_admin'||!config.password)throw Error();
  const env={...process.env};
  for(const key of Object.keys(env))if(/^PG/i.test(key))delete env[key];
  Object.assign(env,{PGPASSWORD:config.password,PGCONNECT_TIMEOUT:'5',PGHOSTADDR:'127.0.0.1'});
  const pg=(sql:string)=>execFileSync('C:\\Program Files\\PostgreSQL\\18\\bin\\psql.exe',
    ['-X','-qAt','-w','-v','ON_ERROR_STOP=on','-h','127.0.0.1','-p','55437','-U',config.user,'-d',database,'-f','-'],
    {env,input:sql,encoding:'utf8',stdio:['pipe','pipe','pipe'],windowsHide:true,timeout:30000});
  const guard=`DO $$ BEGIN
    IF current_database()<>'${database}' OR current_user<>'flsd_pilot_admin'
      OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet OR inet_server_port() IS DISTINCT FROM 55437
      OR NOT EXISTS(SELECT 1 FROM pg_database WHERE datname=current_database() AND oid=26236
        AND shobj_description(oid,'pg_database')='${marker}')
      OR NOT EXISTS(SELECT 1 FROM public.pilot_meta WHERE id=1 AND schema_version=4 AND marker='FLSD_ISOLATED_PILOT_ONLY')
      OR NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${writer}' AND NOT rolsuper AND NOT rolcreaterole
        AND NOT rolcreatedb AND NOT rolreplication AND NOT rolbypassrls AND NOT rolinherit
        AND shobj_description(oid,'pg_authid')='${marker}')
      THEN RAISE EXCEPTION 'Payments candidate identity refused'; END IF;
    END $$;\n`;
  const password=randomBytes(32).toString('hex');
  const expiresAt=new Date(Date.now()+48*60*60*1000).toISOString();
  pg(guard+`ALTER ROLE ${writer} LOGIN PASSWORD '${scramVerifier(password)}' VALID UNTIL '${expiresAt}';`);
  writeFileSync(runtime,JSON.stringify({marker:config.marker,host:config.host,port:config.port,database,user:writer,password}),{flag:'wx'});
  const child=spawn(process.execPath,[join(root,'node_modules','next','dist','bin','next'),'start','--hostname','127.0.0.1','--port','3101'],{
    cwd:stage,env:{...process.env,FLSD_REVIEW_BUILD:'1',NEXT_TELEMETRY_DISABLED:'1'},windowsHide:true,stdio:'ignore',detached:true,
  });
  child.unref();
  for(let attempt=0;attempt<30;attempt++){
    try{
      const response=await fetch(origin+'/pilot',{signal:AbortSignal.timeout(1000),redirect:'error'});
      if(response.ok&&child.exitCode===null){
        console.log(JSON.stringify({status:'PAYMENTS_QA_READY',url:origin+'/pilot',databaseOid:evidence.databaseOid,expiresAt}));
        return;
      }
    }catch{}
    await new Promise(resolve=>setTimeout(resolve,500));
  }
  child.kill();
  throw Error();
}

main().catch(()=>{
  console.error('Payments QA launch stopped');
  process.exitCode=1;
});
