// Pure allowlist classifier. Never returns raw process text, SQL, credentials or URLs.
const phases = ['CONFIG_INPUT','CONFIG_READY','SUITE_LOADED','FIXTURE_BEGIN','FIXTURE_READY','DIAGNOSTIC_INPUT','DIAGNOSTIC_CONFIG','DIAGNOSTIC_CONNECT','DIAGNOSTIC_ISOLATION','DIAGNOSTIC_PERMISSIONS','DIAGNOSTIC_STATE','DIAGNOSTIC_COMPLETE'];
const categories = ['FIXTURE_PROVENANCE_UNRECORDED','FIXTURE_RESUME_REFUSED','SUCCESS','AUTHENTICATION_FAILED','SERVER_UNAVAILABLE','PERMISSION_DENIED','SCHEMA_NOT_READY','ISOLATION_MISMATCH','FIXTURE_ALREADY_INITIALIZED','CREDENTIAL_INPUT_INVALID','DEPENDENCY_OR_MODULE_MISSING','CONFIG_STARTUP_FAILED','ASSERTION_FAILED','TRANSACTION_CONFLICT','TIMEOUT','UNKNOWN_FAILURE'];
function category(text) {
 if(/FLSD_FIXTURE_PROVENANCE_UNRECORDED/.test(text))return 'FIXTURE_PROVENANCE_UNRECORDED';
 if(/FLSD_FIXTURE_/.test(text))return 'FIXTURE_RESUME_REFUSED';
 if(/FLSD_SAFE_CREDENTIAL_INPUT|Unexpected token.*JSON|Unexpected end of JSON|EAGAIN|EBADF|Invalid transient test credential/i.test(text))return 'CREDENTIAL_INPUT_INVALID';
 if(/\bP1000\b|\b28P01\b|\b28000\b|password authentication failed|Authentication failed against|fe_sendauth|Authentication required/i.test(text))return 'AUTHENTICATION_FAILED';
 if(/\bP1001\b|ECONNREFUSED|Can't reach database server|could not connect/i.test(text))return 'SERVER_UNAVAILABLE';
 if(/\b42501\b|\bP1010\b|permission denied|access denied/i.test(text))return 'PERMISSION_DENIED';
 if(/\b42P01\b|\b3F000\b|\bP2021\b|relation .*does not exist|schema .*does not exist/i.test(text))return 'SCHEMA_NOT_READY';
 if(/identity\/ownership mismatch|schema provenance mismatch|Creation provenance|creation proof|Dedicated application|Only explicitly owned/i.test(text))return 'ISOLATION_MISMATCH';
 if(/\b23505\b|Unique constraint failed|duplicate key value|FIXTURE_ALREADY_INITIALIZED/i.test(text))return 'FIXTURE_ALREADY_INITIALIZED';
 if(/MODULE_NOT_FOUND|ERR_MODULE_NOT_FOUND|Cannot find module|Cannot find package/i.test(text))return 'DEPENDENCY_OR_MODULE_MISSING';
 if(/\b40001\b|\b40P01\b|\bP2034\b|could not serialize|deadlock detected/i.test(text))return 'TRANSACTION_CONFLICT';
 if(/ETIMEDOUT|timed out|TimeoutError|\bP1002\b/i.test(text))return 'TIMEOUT';
 if(/failed to load config|Startup Error|ConfigError|Config.*failed/i.test(text))return 'CONFIG_STARTUP_FAILED';
 if(/AssertionError|expect\(.*\)|Tests\s+\d+ failed/i.test(text))return 'ASSERTION_FAILED';
 return 'UNKNOWN_FAILURE';
}
function safeReport(input) {
 const text=(typeof input.stdout==='string'?input.stdout:'')+'\n'+(typeof input.stderr==='string'?input.stderr:'');
 const observed=[];
 for(const m of text.matchAll(/FLSD_SAFE_PHASE:([A-Z_]+)/g))if(phases.includes(m[1])&&!observed.includes(m[1]))observed.push(m[1]);
 let result=category(text);
 const explicit=[...text.matchAll(/FLSD_SAFE_CATEGORY:([A-Z_]+)/g)].map(m=>m[1]).filter(x=>categories.includes(x));
 if(explicit.length)result=explicit.at(-1);
 const exitCode=Number.isInteger(input.exitCode)&&input.exitCode>=0&&input.exitCode<=255?input.exitCode:null;
 if(exitCode===0)result='SUCCESS';
 const counts={passed:0,failed:0,skipped:0};
 const plain=text.replace(/\x1b\[[0-9;]*m/g,'');
 const testLine=/^\s*Tests\s+([^\r\n]+)/m.exec(plain)?.[1]??'';
 for(const [key] of Object.entries(counts)){const match=new RegExp('(\\d+) '+key).exec(testLine);if(match&&Number(match[1])<=100000)counts[key]=Number(match[1]);}
 const state=/FLSD_SAFE_STATE:(EMPTY|PRESENT|INCONSISTENT)/.exec(text)?.[1];
 let fixture;
 // Reconstruct an allowlisted report; never forward the marker's arbitrary JSON.
 const marker=/^FLSD_SAFE_FIXTURE:([^\r\n]{1,4096})$/m.exec(text)?.[1];
 if(marker&&input.mode==='DIAGNOSTIC_READ_ONLY')try{fixture=require('./main-fixture-review.cjs').reviewFixture(JSON.parse(marker));}catch{}
 const resume=input.mode==='DIAGNOSTIC_READ_ONLY'&&/^FLSD_SAFE_RESUME:IDENTITY_VERIFIED_PRISTINE$/m.test(text)?'IDENTITY_VERIFIED_PRISTINE':undefined;
 return {kind:'SANITIZED_MAIN_ADAPTER_RESULT',mode:input.mode==='DIAGNOSTIC_READ_ONLY'?'DIAGNOSTIC_READ_ONLY':'CONNECTED_TESTS',exitCode,category:result,phases:observed,tests:counts,...(state?{fixtureState:state}:{}),...(fixture?{fixture}:{}),...(resume?{fixtureResume:resume}:{}),rawOutputIncluded:false};
}
module.exports={safeReport,category};
