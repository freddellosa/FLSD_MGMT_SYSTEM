import {defineConfig} from 'vitest/config';
import {readFileSync} from 'node:fs';
let transientPassword='';
process.stderr.write('FLSD_SAFE_PHASE:CONFIG_INPUT\n');
if(process.env.FLSD_MAIN_ADAPTER_CREDENTIAL_STDIN==='1'){
 let input;
 try{const raw=readFileSync(0,'utf8');if(raw.length>16384)throw new Error();input=JSON.parse(raw.replace(/^\ufeff/,''));}catch{throw new Error('FLSD_SAFE_CREDENTIAL_INPUT');}
 if(!input||Object.keys(input).join(',')!=='testPassword'||typeof input.testPassword!=='string'||!input.testPassword.length||input.testPassword.length>1024)throw new Error('FLSD_SAFE_CREDENTIAL_INPUT');
 transientPassword=input.testPassword;
}
process.stderr.write('FLSD_SAFE_PHASE:CONFIG_READY\n');
const suite=process.env.FLSD_MAIN_ADAPTER_SUITE;
if(suite!==undefined&&suite!=='ISOLATED_SCHEMA')throw new Error('Isolated suite selection refused');
export default defineConfig({test:{include:[suite==='ISOLATED_SCHEMA'?'tests/main-isolated-adapter/**/*.test.ts':'tests/main-adapter/**/*.test.ts'],provide:{adapterTestPassword:transientPassword},cache:false,fileParallelism:false,maxWorkers:1,testTimeout:30000,hookTimeout:30000}});
declare module 'vitest' {export interface ProvidedContext {adapterTestPassword:string}}
