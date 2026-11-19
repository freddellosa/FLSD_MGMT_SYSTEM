-- psql 18 script. Each \gexec CREATE DATABASE is a separate autocommit command.
-- No BEGIN/--single-transaction wrapper is permitted around this creation sequence.
\set ON_ERROR_STOP on
\set AUTOCOMMIT on
\set ECHO none
\set ECHO_HIDDEN off
SELECT set_config('flsd_test.run_id', :'run_id', false),set_config('flsd_test.owner_role', :'owner_role', false),set_config('flsd_test.app_role', :'app_role', false),set_config('flsd_test.admin_role', :'admin_role', false);
DO $$ BEGIN
 IF inet_server_port() IS DISTINCT FROM 5432 OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR current_database()<>'postgres' OR current_user<>current_setting('flsd_test.admin_role') OR pg_is_in_recovery() OR current_setting('transaction_read_only')<>'off' OR current_setting('server_version_num')::int/10000<>18 THEN RAISE EXCEPTION 'Wrong server, identity, version or write mode'; END IF;
 IF NOT pg_try_advisory_lock(73785219460319) THEN RAISE EXCEPTION 'Creation sequence busy: STOP'; END IF;
 IF EXISTS(SELECT 1 FROM pg_database WHERE datname IN ('flsd_main_adapter_test','flsd_main_restore_test')) THEN RAISE EXCEPTION 'A proposed database exists: STOP'; END IF;
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN (current_setting('flsd_test.owner_role'),current_setting('flsd_test.app_role'))) THEN RAISE EXCEPTION 'A proposed new role exists: STOP'; END IF;
END $$;
\echo FLSD_STAGE:LOCKED_ABSENCE_VERIFIED
SELECT format('CREATE ROLE %I NOLOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', :'owner_role') \gexec
\echo FLSD_STAGE:OWNER_CREATED
SELECT format('COMMENT ON ROLE %I IS %L', :'owner_role','FLSD_DISPOSABLE_ROLE:'||:'run_id'||':OWNER') \gexec
SELECT format('CREATE ROLE %I LOGIN PASSWORD NULL NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT', :'app_role') \gexec
\echo FLSD_STAGE:APP_CREATED
SELECT format('COMMENT ON ROLE %I IS %L', :'app_role','FLSD_DISPOSABLE_ROLE:'||:'run_id'||':APP') \gexec
SELECT format('CREATE DATABASE %I OWNER %I TEMPLATE template0 ALLOW_CONNECTIONS false','flsd_main_adapter_test', :'owner_role') \gexec
\echo FLSD_STAGE:PRIMARY_CREATED
SELECT format('COMMENT ON DATABASE %I IS %L','flsd_main_adapter_test','FLSD_DISPOSABLE:'||:'run_id'||':flsd_main_adapter_test') \gexec
REVOKE ALL ON DATABASE flsd_main_adapter_test FROM PUBLIC;
SELECT format('GRANT CONNECT ON DATABASE flsd_main_adapter_test TO %I', :'app_role') \gexec
SELECT format('CREATE DATABASE %I OWNER %I TEMPLATE template0 ALLOW_CONNECTIONS false','flsd_main_restore_test', :'owner_role') \gexec
\echo FLSD_STAGE:RESTORE_CREATED
SELECT format('COMMENT ON DATABASE %I IS %L','flsd_main_restore_test','FLSD_DISPOSABLE:'||:'run_id'||':flsd_main_restore_test') \gexec
REVOKE ALL ON DATABASE flsd_main_restore_test FROM PUBLIC;
DO $$ DECLARE d record;r record; BEGIN
 IF (SELECT count(*) FROM pg_roles WHERE rolname IN(current_setting('flsd_test.owner_role'),current_setting('flsd_test.app_role')))<>2 OR (SELECT count(*) FROM pg_database WHERE datname IN('flsd_main_adapter_test','flsd_main_restore_test'))<>2 THEN RAISE EXCEPTION 'Created object set incomplete'; END IF;
 FOR r IN SELECT * FROM pg_roles WHERE rolname IN(current_setting('flsd_test.owner_role'),current_setting('flsd_test.app_role')) LOOP
  IF r.rolsuper OR r.rolcreatedb OR r.rolcreaterole OR r.rolreplication OR r.rolbypassrls OR r.rolinherit OR r.rolcanlogin<>(r.rolname=current_setting('flsd_test.app_role')) OR EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid) THEN RAISE EXCEPTION 'Unexpected new role privilege or membership'; END IF;
 END LOOP;
 FOR d IN SELECT * FROM pg_database WHERE datname IN('flsd_main_adapter_test','flsd_main_restore_test') LOOP
  IF pg_get_userbyid(d.datdba)<>current_setting('flsd_test.owner_role') OR d.datallowconn OR shobj_description(d.oid,'pg_database') IS DISTINCT FROM ('FLSD_DISPOSABLE:'||current_setting('flsd_test.run_id')||':'||d.datname) OR EXISTS(SELECT 1 FROM aclexplode(d.datacl) WHERE grantee=0) THEN RAISE EXCEPTION 'New database owner/marker/ACL mismatch'; END IF;
 END LOOP;
 IF has_database_privilege(current_setting('flsd_test.app_role'),'flsd_main_adapter_test','CREATE') OR has_database_privilege(current_setting('flsd_test.app_role'),'flsd_main_adapter_test','TEMP') OR NOT has_database_privilege(current_setting('flsd_test.app_role'),'flsd_main_adapter_test','CONNECT') OR has_database_privilege(current_setting('flsd_test.app_role'),'flsd_main_restore_test','CONNECT') THEN RAISE EXCEPTION 'Unexpected application database privilege'; END IF;
END $$;
ALTER DATABASE flsd_main_adapter_test ALLOW_CONNECTIONS true;
ALTER DATABASE flsd_main_restore_test ALLOW_CONNECTIONS true;
\echo FLSD_STAGE:POSTCONDITIONS_VERIFIED
SELECT 'FLSD_RESULT:'||json_build_object('runId',current_setting('flsd_test.run_id'),'serverVersion',current_setting('server_version'),'verifiedDatabases',(SELECT json_agg(json_build_object('name',datname,'oid',oid::text) ORDER BY datname) FROM pg_database WHERE datname IN('flsd_main_adapter_test','flsd_main_restore_test')),'verifiedRoles',(SELECT json_agg(json_build_object('name',rolname,'oid',oid::text) ORDER BY rolname) FROM pg_roles WHERE rolname IN(current_setting('flsd_test.owner_role'),current_setting('flsd_test.app_role'))))::text;
SELECT pg_advisory_unlock(73785219460319);
