// Invoked by the guarded offline PowerShell wrapper; never starts PostgreSQL.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {buildPlan}=require('./lib/main-isolated-schema-plan.cjs');
let input='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{input+=x;if(input.length>65536){console.error('Offline preparation input refused.');process.exitCode=1;process.stdin.destroy();}});
process.stdin.on('end',()=>{try{
 if(process.cwd()!=='D:\\FLSD-Batch7-Validation')throw new Error();
 const request=JSON.parse(input.replace(/^\ufeff/,''));
 const root=process.cwd(),artifacts=path.resolve('artifacts');if(fs.realpathSync(artifacts)!==artifacts)throw new Error();
 const source=fs.readFileSync('prisma/disposable-main-adapter.sql','utf8');
 const plan=buildPlan(request.proof,crypto.randomUUID(),source,request.guard);
 const prefix=path.join(root,'artifacts','main-adapter-isolated-'+plan.runId);
 for(const [suffix,value] of [['.sql',plan.sql],['-preflight.sql',plan.preflight],['.json',JSON.stringify(plan,null,2)]]){
  const fd=fs.openSync(prefix+suffix,'wx',0o600);try{fs.writeFileSync(fd,value,'utf8');fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
 }
 console.log(JSON.stringify({status:plan.status,runId:plan.runId,schema:plan.schema,appRole:plan.appRole,plan:prefix+'.json',databaseCommandsExecuted:0}));
}catch{console.error('Offline plan preparation failed; preserve partial files, no overwrite or cleanup.');process.exitCode=1;}});
