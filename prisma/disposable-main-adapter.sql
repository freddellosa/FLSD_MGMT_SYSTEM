-- Only newly created Owner-authorized disposable databases, bound to a run UUID.
-- Invoked through the guarded local script, never a production migration.
\set ON_ERROR_STOP on
SELECT set_config('flsd_test.run_id', :'run_id', false);
BEGIN;
SELECT format('SET LOCAL ROLE %I', :'owner_role') \gexec
DO $$
DECLARE d record;
BEGIN
 SELECT datname,pg_get_userbyid(datdba) AS owner,shobj_description(oid,'pg_database') AS marker INTO d FROM pg_database WHERE datname=current_database();
 IF inet_server_port() IS DISTINCT FROM 5432 OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1' OR d.datname NOT IN ('flsd_main_adapter_test','flsd_main_restore_test') OR d.owner IS DISTINCT FROM current_user OR
 d.marker IS DISTINCT FROM ('FLSD_DISPOSABLE:'||current_setting('flsd_test.run_id')||':'||d.datname) THEN
  RAISE EXCEPTION 'Disposable ownership/provenance mismatch';
 END IF;
 IF EXISTS(SELECT 1 FROM pg_namespace WHERE nspname='flsd_adapter_test') THEN RAISE EXCEPTION 'Schema already exists; no overwrite permitted'; END IF;
END $$;
CREATE SCHEMA flsd_adapter_test;
CREATE TABLE flsd_adapter_test.meta(id int PRIMARY KEY CHECK(id=1),run_id uuid NOT NULL,marker text NOT NULL CHECK(marker='FLSD_SYNTHETIC_ADAPTER_V1'));
INSERT INTO flsd_adapter_test.meta VALUES(1,current_setting('flsd_test.run_id')::uuid,'FLSD_SYNTHETIC_ADAPTER_V1');
CREATE TABLE flsd_adapter_test.actors(id uuid PRIMARY KEY,role text NOT NULL CHECK(role IN ('OWNER','ADMIN','BILLING','OPERATIONS','VIEWER')),active boolean NOT NULL);
CREATE TABLE flsd_adapter_test.sessions(token_hash text PRIMARY KEY CHECK(token_hash~'^[0-9a-f]{64}$'),actor_id uuid NOT NULL REFERENCES flsd_adapter_test.actors(id),expires_at timestamptz NOT NULL);
CREATE TABLE flsd_adapter_test.workspace(id int PRIMARY KEY CHECK(id=1),revision bigint NOT NULL DEFAULT 0 CHECK(revision>=0),payload jsonb NOT NULL);
CREATE TABLE flsd_adapter_test.records(kind text NOT NULL CHECK(kind IN ('TRIP','SOA','INVOICE')),id text NOT NULL,version bigint NOT NULL CHECK(version>0),customer_id text NOT NULL,amount numeric(18,2) NOT NULL CHECK(amount>=0),payload jsonb NOT NULL,PRIMARY KEY(kind,id));
CREATE TABLE flsd_adapter_test.operations(operation_id uuid PRIMARY KEY,actor_id uuid NOT NULL REFERENCES flsd_adapter_test.actors(id),digest text NOT NULL CHECK(digest~'^[0-9a-f]{64}$'),receipt jsonb NOT NULL);
CREATE TABLE flsd_adapter_test.audit(operation_id uuid PRIMARY KEY REFERENCES flsd_adapter_test.operations(operation_id),actor_id uuid NOT NULL REFERENCES flsd_adapter_test.actors(id),event jsonb NOT NULL);
CREATE TABLE flsd_adapter_test.history(operation_id uuid PRIMARY KEY REFERENCES flsd_adapter_test.operations(operation_id),payload jsonb NOT NULL);
CREATE FUNCTION flsd_adapter_test.immutable_history() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'Immutable synthetic operation history'; END $$;
CREATE TRIGGER immutable_operations BEFORE UPDATE OR DELETE ON flsd_adapter_test.operations FOR EACH ROW EXECUTE FUNCTION flsd_adapter_test.immutable_history();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON flsd_adapter_test.audit FOR EACH ROW EXECUTE FUNCTION flsd_adapter_test.immutable_history();
CREATE TRIGGER immutable_history BEFORE UPDATE OR DELETE ON flsd_adapter_test.history FOR EACH ROW EXECUTE FUNCTION flsd_adapter_test.immutable_history();
CREATE FUNCTION flsd_adapter_test.require_atomic_history() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM flsd_adapter_test.audit a WHERE a.operation_id=NEW.operation_id AND a.actor_id=NEW.actor_id) OR NOT EXISTS(SELECT 1 FROM flsd_adapter_test.history h WHERE h.operation_id=NEW.operation_id) THEN RAISE EXCEPTION 'Operation requires atomic audit and history'; END IF;
 RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER atomic_history AFTER INSERT ON flsd_adapter_test.operations DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flsd_adapter_test.require_atomic_history();
REVOKE ALL ON SCHEMA flsd_adapter_test FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA flsd_adapter_test FROM PUBLIC;
SELECT format('GRANT USAGE ON SCHEMA flsd_adapter_test TO %I', :'app_role') \gexec
SELECT format('GRANT SELECT ON ALL TABLES IN SCHEMA flsd_adapter_test TO %I', :'app_role') \gexec
SELECT format('GRANT INSERT ON flsd_adapter_test.actors,flsd_adapter_test.sessions,flsd_adapter_test.workspace,flsd_adapter_test.records,flsd_adapter_test.operations,flsd_adapter_test.audit,flsd_adapter_test.history TO %I', :'app_role') \gexec
SELECT format('GRANT UPDATE ON flsd_adapter_test.actors,flsd_adapter_test.workspace,flsd_adapter_test.records TO %I', :'app_role') \gexec
COMMIT;
