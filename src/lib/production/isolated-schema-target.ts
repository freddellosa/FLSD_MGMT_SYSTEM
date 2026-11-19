/** Only per-run schemas in the approved PRIMARY database. No identifier discovery. */
export type IsolatedSchemaTarget={runId:string;parentRunId:string;schema:string;appRole:string;schemaOid:string;appOid:string};
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function validateIsolatedTarget(value:unknown,parent:{database:string;runId:string}):IsolatedSchemaTarget{
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Isolated schema identity mismatch');
 const t=value as IsolatedSchemaTarget;
 if(Object.keys(t).sort().join(',')!=='appOid,appRole,parentRunId,runId,schema,schemaOid'||parent.database!=='flsd_main_adapter_test'||!uuid.test(t.runId)||t.parentRunId!==parent.runId||t.runId===parent.runId||t.schema!=='flsd_iso_'+t.runId.replaceAll('-','')||t.appRole!=='flsd_iso_app_'+t.runId.replaceAll('-','')||[t.schemaOid,t.appOid].some(v=>typeof v!=='string'||! /^[1-9]\d{0,9}$/.test(v)||BigInt(v)>4294967295n))throw new Error('Isolated schema identity mismatch');
 return structuredClone(t);
}
/** Only internal SQL templates use this token; never rewrite arbitrary qualified SQL. */
export function schemaSql(schema:string,sql:string){
 if(schema!=='flsd_adapter_test'&&!/^flsd_iso_[0-9a-f]{32}$/.test(schema))throw new Error('Unsafe schema target');
 // Inspect control words outside constant SQL strings (e.g. the 'CREATE' privilege).
 const structure=sql.replace(/'(?:''|[^'])*'/g,"''");
 if(!sql.includes('__FLSD_SCHEMA__')||/flsd_adapter_test|flsd_main_restore_test|\bpublic\s*\.|\bflsd_iso_[0-9a-f]+\b/i.test(sql)||/\b(?:RESET|COPY|CREATE|ALTER|DROP|TRUNCATE|GRANT|REVOKE|CALL)\b|^\s*(?:DO|SET)\b/i.test(structure)||sql.includes(';')||sql.includes('--')||sql.includes('/*'))throw new Error('Cross-schema or non-template SQL refused');
 for(const m of structure.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+([A-Za-z_]\w*)/gi))if(m[1]!=='__FLSD_SCHEMA__'&&m[1].toUpperCase()!=='SET')throw new Error('Cross-schema relation refused');
 return sql.replaceAll('__FLSD_SCHEMA__',schema);
}
