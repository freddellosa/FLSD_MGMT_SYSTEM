// Offline generator only. No PostgreSQL process, connection, password or SQL execution.
// eslint-disable-next-line @typescript-eslint/no-require-imports -- Loaded synchronously by the CommonJS preparer.
const {createHash}=require('node:crypto');
const migrationHash='0B73853CB8A5D82651785FF35C9C9F9DC898205429C3AAE50708A1A7E8426FDC';
const sha256=value=>createHash('sha256').update(value).digest('hex').toUpperCase();
function buildPlan(proof,runId,source,guard){
 const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
 if(!uuid.test(runId)||!uuid.test(proof.runId)||runId===proof.runId||proof.host!=='127.0.0.1'||proof.port!==5432||proof.proofVersion!==2||proof.createdByThisRun!==true||proof.expectedOwner!=='flsd_test_owner_'+proof.runId.replaceAll('-','').slice(0,12)||proof.user!=='flsd_test_app_'+proof.runId.replaceAll('-','').slice(0,12)||! /^[a-z_][a-z0-9_]{0,62}$/.test(proof.adminUser))throw new Error('Invalid isolated plan provenance');
 const database=proof.verifiedDatabases?.find(d=>d.name==='flsd_main_adapter_test');
 if(!database||! /^[1-9]\d{0,9}$/.test(String(database.oid))||proof.migrationSha256!==migrationHash||sha256(source)!==migrationHash)throw new Error('Migration/identity evidence changed');
 // Guard is supplied by the existing proven PS generator, never accepted as arbitrary CLI text.
 if(typeof guard!=='string'||!guard.includes("current_database()<>'flsd_main_adapter_test'")||!guard.includes('IF false AND')||guard.includes("current_database()<>'flsd_main_restore_test'"))throw new Error('Wrong same-session database guard');
 const suffix=runId.replaceAll('-',''),schema='flsd_iso_'+suffix,appRole='flsd_iso_app_'+suffix;
 const start=source.indexOf('CREATE SCHEMA flsd_adapter_test;'),end=source.indexOf('REVOKE ALL ON SCHEMA flsd_adapter_test FROM PUBLIC;');
 if(start<0||end<=start)throw new Error('Reviewed DDL boundaries unavailable');
 const ddl=source.slice(start,end).replaceAll('flsd_adapter_test',schema);
 const owner=proof.expectedOwner;
 const collision=`DO $collision$ BEGIN IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='${schema}') OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${appRole}') THEN RAISE EXCEPTION 'Isolated schema/role already exists; no reuse or overwrite'; END IF; END $collision$;`;
 const header=`\\set ON_ERROR_STOP on\nBEGIN;\nSET LOCAL search_path TO pg_catalog;\n${guard}\nSELECT pg_advisory_xact_lock(176661,1);\n${collision}\n`;
 const preflight=`\\set ON_ERROR_STOP on\nBEGIN READ ONLY;\nSET LOCAL search_path TO pg_catalog;\n${guard}\n${collision}\nSELECT 'ISOLATED_NAMES_UNUSED_READ_ONLY';\nROLLBACK;\n`;
 const sql=header+`CREATE ROLE ${appRole} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
COMMENT ON ROLE ${appRole} IS 'FLSD_ISOLATED_APP:${proof.runId}:${runId}';
SET LOCAL ROLE ${owner};
SELECT set_config('flsd_test.run_id','${runId}',true);
${ddl}
COMMENT ON SCHEMA ${schema} IS 'FLSD_ISOLATED:${proof.runId}:${runId}:${schema}';
REVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA ${schema} FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA ${schema} FROM PUBLIC;
GRANT USAGE ON SCHEMA ${schema} TO ${appRole};
GRANT SELECT ON ALL TABLES IN SCHEMA ${schema} TO ${appRole};
GRANT INSERT ON ${schema}.actors,${schema}.sessions,${schema}.workspace,${schema}.records,${schema}.operations,${schema}.audit,${schema}.history TO ${appRole};
GRANT UPDATE ON ${schema}.actors,${schema}.workspace,${schema}.records TO ${appRole};
RESET ROLE;
GRANT CONNECT ON DATABASE flsd_main_adapter_test TO ${appRole};
ALTER ROLE ${appRole} IN DATABASE flsd_main_adapter_test SET search_path TO pg_catalog,${schema};
DO $privileges$
DECLARE
 app_oid oid := '${appRole}'::regrole;
 owner_oid oid := '${owner}'::regrole;
 isolated_oid oid := '${schema}'::regnamespace;
 settings_view_oid oid := 'pg_catalog.pg_settings'::regclass;
BEGIN
 IF has_schema_privilege(app_oid,'flsd_adapter_test','USAGE')
    OR NOT has_schema_privilege(app_oid,isolated_oid,'USAGE')
    OR has_database_privilege(app_oid,current_database(),'CREATE,TEMPORARY')
    OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=app_oid)
 THEN RAISE EXCEPTION 'Isolated application role privilege mismatch'; END IF;

 IF EXISTS(SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(app_oid,n.oid,'CREATE'))
    OR EXISTS(
      SELECT 1 FROM pg_class c WHERE c.relnamespace<>isolated_oid AND
        CASE
          WHEN c.oid=settings_view_oid AND c.relkind='v' THEN
            -- PostgreSQL's built-in UPDATE rule changes settings in the current session.
            has_table_privilege(app_oid,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR has_any_column_privilege(app_oid,c.oid,'INSERT,REFERENCES')
            OR EXISTS(
              SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a
              WHERE col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped
                AND a.grantee IN (0,app_oid) AND a.privilege_type='UPDATE'
            )
          WHEN c.relkind IN('r','p','v','m','f') THEN
            has_table_privilege(app_oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
            OR has_any_column_privilege(app_oid,c.oid,'INSERT,UPDATE,REFERENCES')
          WHEN c.relkind='S' THEN has_sequence_privilege(app_oid,c.oid,'USAGE,UPDATE')
          ELSE false
        END
    )
    OR EXISTS(SELECT 1 FROM pg_largeobject_metadata l WHERE has_largeobject_privilege(app_oid,l.oid,'UPDATE'))
 THEN RAISE EXCEPTION 'Cross-schema write capability refused'; END IF;

 IF EXISTS(
   SELECT 1 FROM pg_proc p
   WHERE p.prosecdef AND p.pronamespace<>isolated_oid
     AND has_schema_privilege(app_oid,p.pronamespace,'USAGE')
     AND has_function_privilege(app_oid,p.oid,'EXECUTE')
 ) THEN RAISE EXCEPTION 'External security-definer capability refused'; END IF;

 -- Check actual ACLs after default privileges and the explicit grants have been applied.
 IF EXISTS(SELECT 1 FROM pg_namespace n WHERE n.oid=isolated_oid AND n.nspowner<>owner_oid)
    OR EXISTS(SELECT 1 FROM pg_class c WHERE c.relnamespace=isolated_oid AND c.relowner<>owner_oid)
    OR EXISTS(SELECT 1 FROM pg_proc p WHERE p.pronamespace=isolated_oid AND p.proowner<>owner_oid)
    OR EXISTS(
      SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
      WHERE n.oid=isolated_oid AND a.grantee<>owner_oid
        AND (a.grantee<>app_oid OR a.privilege_type<>'USAGE' OR a.is_grantable)
    )
    OR EXISTS(
      SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
      WHERE c.relnamespace=isolated_oid AND a.grantee<>owner_oid AND (
        a.grantee<>app_oid OR a.is_grantable OR NOT (
          a.privilege_type='SELECT'
          OR (a.privilege_type='INSERT' AND c.relname IN('actors','sessions','workspace','records','operations','audit','history'))
          OR (a.privilege_type='UPDATE' AND c.relname IN('actors','workspace','records'))
        )
      )
    )
    OR EXISTS(
      SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
      WHERE p.pronamespace=isolated_oid AND a.grantee<>owner_oid
    )
 THEN RAISE EXCEPTION 'Isolated object ownership or ACL mismatch'; END IF;
END $privileges$;
COMMIT;
-- Store verified installation evidence only after a separately authorized successful execution.
SELECT json_build_object('runId','${runId}','parentRunId','${proof.runId}','schema','${schema}','appRole','${appRole}','schemaOid',(SELECT oid::text FROM pg_namespace WHERE nspname='${schema}'),'appOid',(SELECT oid::text FROM pg_roles WHERE rolname='${appRole}'));
`;
 return {version:3,status:'PREPARED_OFFLINE_NOT_EXECUTED',database:'flsd_main_adapter_test',host:'127.0.0.1',port:5432,parentRunId:proof.runId,databaseOid:String(database.oid),runId,schema,appRole,sourceMigrationSha256:migrationHash,sqlSha256:sha256(sql),preflightSha256:sha256(preflight),sql,preflight};
}
module.exports={buildPlan};
