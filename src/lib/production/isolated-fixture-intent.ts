import {openSync,writeFileSync,fsyncSync,closeSync,realpathSync,readFileSync,lstatSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {resolve} from 'node:path';
import {validateIsolatedTarget,type IsolatedSchemaTarget} from './isolated-schema-target';
import {validateDisposableConfig,type DisposableConfig} from './disposable-postgres';
export function readInstalledIsolatedTarget(config:DisposableConfig,runId?:string):IsolatedSchemaTarget{
 validateDisposableConfig(config);
 if(runId!==undefined&&!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(runId))throw new Error('Invalid isolated run identity');
 const path=resolve(runId===undefined?'artifacts/main-adapter-isolated-installed.json':`artifacts/main-adapter-isolated-installed-${runId}.json`);
 if(process.cwd()!=='D:\\FLSD-Batch7-Validation'||realpathSync(path)!==path||!lstatSync(path).isFile()||lstatSync(path).size>16384)throw new Error('Isolated installation proof missing');
 const target=validateIsolatedTarget(JSON.parse(readFileSync(path,'utf8')),config);
 if(runId!==undefined&&target.runId!==runId)throw new Error('Isolated installation receipt run mismatch');
 return target;
}
/** Once per run: retained after every failure/success. No automatic restart or overwrite. */
export function writeIsolatedFixtureIntent(config:DisposableConfig,target:IsolatedSchemaTarget,actorId:string,sessionHash:string,payload:string){
 validateDisposableConfig(config);const t=validateIsolatedTarget(target,config),artifacts=resolve('artifacts');
 if(process.cwd()!=='D:\\FLSD-Batch7-Validation'||realpathSync(artifacts)!==artifacts||! /^[0-9a-f-]{36}$/.test(actorId)||! /^[0-9a-f]{64}$/.test(sessionHash))throw new Error('Isolated fixture identity mismatch');
 const path=resolve(artifacts,'main-adapter-isolated-fixture-'+t.runId+'.json');
 let fd:number;try{fd=openSync(path,'wx',0o600);}catch{throw new Error('FLSD_FIXTURE_ISOLATED_ATTEMPT_RECORDED');}
 try{writeFileSync(fd,JSON.stringify({kind:'ISOLATED_FIXTURE_INTENT_NOT_COMMIT_PROOF',config,target:t,actorId,sessionHash,payloadSha256:createHash('sha256').update(payload).digest('hex')}),'utf8');fsyncSync(fd);}finally{closeSync(fd);}
}
