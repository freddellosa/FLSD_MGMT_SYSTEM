-- Run through the future guarded read-only capture launcher.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY;
SET LOCAL search_path TO pg_catalog;
DO $guard$
BEGIN
  IF current_user<>'postgres' OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1'
    OR inet_server_port() IS DISTINCT FROM 5432 OR current_setting('server_version_num')<>'180007'
    OR pg_is_in_recovery() OR NOT EXISTS (
      SELECT 1 FROM pg_database d JOIN pg_namespace n ON n.nspowner=d.datdba
      WHERE d.datname=current_database() AND d.datdba=16392::oid
        AND (d.datname,d.oid) IN (('flsd_main_adapter_test',16394::oid),('flsd_main_restore_test',16395::oid))
        AND shobj_description(d.oid,'pg_database')='FLSD_DISPOSABLE:b813e743-9f4c-4121-b8ab-b01ca51b9335:'||d.datname
        AND n.nspname='flsd_batch7_commit_rehearsal'
        AND obj_description(n.oid,'pg_namespace')='FLSD_SYNTHETIC_BATCH7_COMMITTED_V1'
    ) THEN RAISE EXCEPTION 'Batch 7 catalog capture identity refused'; END IF;
END $guard$;

WITH scope AS (
  SELECT oid,nspname,nspowner,nspacl FROM pg_namespace WHERE nspname='flsd_batch7_commit_rehearsal'
), relations AS (
  SELECT c.oid,c.relname,c.relkind,c.relowner,c.relacl,c.relrowsecurity,c.relforcerowsecurity
  FROM pg_class c JOIN scope n ON n.oid=c.relnamespace
), acl_sources AS (
  SELECT 'schema'::text kind,nspname::text name,nspacl acl FROM scope
  UNION ALL
  SELECT 'relation',relname,relacl FROM relations
  UNION ALL
  SELECT 'column',c.relname||'.'||a.attname,a.attacl FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid
  WHERE a.attnum>0 AND NOT a.attisdropped
  UNION ALL
  SELECT 'type',t.typname,t.typacl FROM pg_type t JOIN scope n ON n.oid=t.typnamespace
  UNION ALL
  SELECT 'routine',p.proname||'('||pg_get_function_identity_arguments(p.oid)||')',p.proacl
  FROM pg_proc p JOIN scope n ON n.oid=p.pronamespace
  UNION ALL
  SELECT 'defaults',pg_get_userbyid(d.defaclrole)||':'||d.defaclobjtype::text,d.defaclacl
  FROM pg_default_acl d CROSS JOIN scope n
  WHERE d.defaclnamespace=n.oid OR (d.defaclnamespace=0 AND d.defaclrole=n.nspowner)
), contract AS (
  SELECT jsonb_build_object(
    'owner',(SELECT pg_get_userbyid(nspowner) FROM scope),
    'relations',(SELECT jsonb_agg(jsonb_build_array(relname,relkind,pg_get_userbyid(relowner),relrowsecurity,relforcerowsecurity)
      ORDER BY relname COLLATE "C") FROM relations),
    'columns',(SELECT jsonb_agg(jsonb_build_array(c.relname,a.attnum,a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,a.attidentity,a.attgenerated,pg_get_expr(d.adbin,d.adrelid)) ORDER BY c.relname COLLATE "C",a.attnum)
      FROM relations c JOIN pg_attribute a ON a.attrelid=c.oid LEFT JOIN pg_attrdef d ON (d.adrelid,d.adnum)=(a.attrelid,a.attnum)
      WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped),
    'constraints',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,pg_get_constraintdef(k.oid),
      k.convalidated,k.condeferrable,k.condeferred) ORDER BY c.relname COLLATE "C",k.conname COLLATE "C")
      FROM relations c JOIN pg_constraint k ON k.conrelid=c.oid),
    'externalForeignKeys',(SELECT jsonb_agg(jsonb_build_array(c.relname,k.conname,n.nspname,ref.relname)
      ORDER BY c.relname COLLATE "C",k.conname COLLATE "C")
      FROM relations c JOIN pg_constraint k ON k.conrelid=c.oid JOIN pg_class ref ON ref.oid=k.confrelid
      JOIN pg_namespace n ON n.oid=ref.relnamespace CROSS JOIN scope s WHERE n.oid<>s.oid),
    'indexes',(SELECT jsonb_agg(jsonb_build_array(c.relname,pg_get_indexdef(c.oid),i.indisvalid,i.indisready)
      ORDER BY c.relname COLLATE "C") FROM relations c JOIN pg_index i ON i.indexrelid=c.oid),
    'enums',(SELECT jsonb_agg(jsonb_build_array(t.typname,pg_get_userbyid(t.typowner),e.enumlabel)
      ORDER BY t.typname COLLATE "C",e.enumsortorder)
      FROM scope n JOIN pg_type t ON t.typnamespace=n.oid JOIN pg_enum e ON e.enumtypid=t.oid),
    'sequences',(SELECT jsonb_agg(jsonb_build_array(c.relname,format_type(s.seqtypid,NULL),s.seqstart,s.seqincrement,
      s.seqmin,s.seqmax,s.seqcache,s.seqcycle) ORDER BY c.relname COLLATE "C")
      FROM relations c JOIN pg_sequence s ON s.seqrelid=c.oid),
    'triggers',(SELECT jsonb_agg(jsonb_build_array(c.relname,t.tgname,pg_get_triggerdef(t.oid),t.tgenabled)
      ORDER BY c.relname COLLATE "C",t.tgname COLLATE "C") FROM relations c JOIN pg_trigger t ON t.tgrelid=c.oid
      WHERE NOT t.tgisinternal),
    'routines',(SELECT jsonb_agg(jsonb_build_array(pg_get_functiondef(p.oid),pg_get_userbyid(p.proowner),p.prosecdef)
      ORDER BY p.proname COLLATE "C",pg_get_function_identity_arguments(p.oid) COLLATE "C")
      FROM scope n JOIN pg_proc p ON p.pronamespace=n.oid WHERE p.prokind IN ('f','p','w')),
    'acl',(SELECT jsonb_agg(v ORDER BY v::text COLLATE "C") FROM (
      SELECT jsonb_build_array(s.kind,s.name,pg_get_userbyid(a.grantor),
        CASE WHEN a.grantee=0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
        a.privilege_type,a.is_grantable) v
      FROM acl_sources s CROSS JOIN LATERAL aclexplode(s.acl) a) items)
  ) body
)
SELECT jsonb_build_object(
  'status','BATCH7_COMMITTED_CATALOG_CAPTURED_READ_ONLY','database',current_database(),
  'databaseOid',(SELECT oid::text FROM pg_database WHERE datname=current_database()),
  'schemaOid',(SELECT oid::text FROM scope),
  'catalogSha256',encode(sha256(convert_to(body::text,'UTF8')),'hex'),'catalog',body
)
FROM contract;
ROLLBACK;
