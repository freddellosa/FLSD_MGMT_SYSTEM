// Pure metadata review. No SQL, credentials, payloads or automatic reuse decisions.
const countKeys=['workspace','actors','sessions','operations','audit','history','records','expired_sessions','viewer_actors','billing_actors','orphan_links'];
function reviewFixture(value){
 if(!value||typeof value!=='object')return null;
 const counts={};
 for(const key of countKeys){if(typeof value[key]!=='string'||!/^\d{1,18}$/.test(value[key]))return null;counts[key]=BigInt(value[key]).toString();}
 if(value.revision!==null&&(typeof value.revision!=='string'||!/^\d{1,18}$/.test(value.revision)))return null;
 if(typeof value.history_matches_workspace!=='boolean')return null;
 const empty=countKeys.filter(k=>!['expired_sessions','viewer_actors','billing_actors','orphan_links'].includes(k)).every(k=>counts[k]==='0');
 const consistent=counts.workspace==='1'&&counts.actors!=='0'&&counts.sessions!=='0'&&counts.operations===counts.audit&&counts.operations===counts.history&&counts.orphan_links==='0'&&value.revision===counts.operations&&(counts.operations==='0'?counts.records==='0':value.history_matches_workspace);
 return {counts,revision:value.revision,historyMatchesWorkspace:value.history_matches_workspace,collision:counts.workspace==='1'?'WORKSPACE_PRIMARY_KEY_1':'NOT_CONFIRMED',state:empty?'EMPTY':consistent?'PRESENT':'INCONSISTENT',reuse:'REQUIRES_REVIEW',origin:'NOT_RECORDED'};
}
module.exports={reviewFixture};
