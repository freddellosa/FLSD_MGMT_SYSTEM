-- REVIEW ONLY. Synthetic trip-reader contract for the existing primary disposable database.
-- A separately approved runner must verify the creation proof and this file's hash.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO pg_catalog;
DO $target$
BEGIN
  IF current_database() <> 'flsd_main_adapter_test'
     OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1'
     OR inet_server_port() IS DISTINCT FROM 5432
     OR current_user <> 'postgres' OR pg_is_in_recovery()
     OR current_setting('server_version_num')::int <> 180007
     OR NOT EXISTS (
       SELECT 1 FROM pg_database d JOIN pg_roles r ON r.oid=d.datdba
       WHERE d.datname=current_database() AND d.oid=16394::oid
         AND r.oid=16392::oid AND r.rolname='flsd_test_owner_b813e7439f4c'
         AND NOT (r.rolcanlogin OR r.rolsuper OR r.rolcreatedb OR r.rolcreaterole
           OR r.rolinherit OR r.rolreplication OR r.rolbypassrls)
         AND NOT EXISTS (SELECT 1 FROM pg_auth_members WHERE member=r.oid)
         AND shobj_description(r.oid,'pg_authid')='FLSD_DISPOSABLE_ROLE:b813e743-9f4c-4121-b8ab-b01ca51b9335:OWNER'
         AND shobj_description(d.oid,'pg_database')='FLSD_DISPOSABLE:b813e743-9f4c-4121-b8ab-b01ca51b9335:flsd_main_adapter_test'
     )
  THEN RAISE EXCEPTION 'Trip-reader disposable identity mismatch'; END IF;
END $target$;

SELECT pg_advisory_xact_lock(176661,1);
DO $collision$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='flsd_operational')
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='flsd_trip_review_reader_75435c870a31')
  THEN RAISE EXCEPTION 'Trip-reader name already in use'; END IF;
END $collision$;

CREATE ROLE flsd_trip_review_reader_75435c870a31
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
COMMENT ON ROLE flsd_trip_review_reader_75435c870a31 IS
  'FLSD_SYNTHETIC_TRIP_READER_V1:b813e743-9f4c-4121-b8ab-b01ca51b9335';
GRANT CONNECT ON DATABASE flsd_main_adapter_test TO flsd_trip_review_reader_75435c870a31;
ALTER ROLE flsd_trip_review_reader_75435c870a31 IN DATABASE flsd_main_adapter_test
  SET search_path TO pg_catalog;
ALTER ROLE flsd_trip_review_reader_75435c870a31 IN DATABASE flsd_main_adapter_test
  SET default_transaction_read_only TO on;
SET LOCAL ROLE flsd_test_owner_b813e7439f4c;

CREATE SCHEMA flsd_operational;
COMMENT ON SCHEMA flsd_operational IS
  'FLSD_SYNTHETIC_TRIP_READER_V1:b813e743-9f4c-4121-b8ab-b01ca51b9335';

CREATE TABLE flsd_operational.authority_meta (
  authority_id text PRIMARY KEY CHECK (authority_id='flsd-synthetic-trip-review'),
  contract_version integer NOT NULL CHECK (contract_version=1)
);
INSERT INTO flsd_operational.authority_meta VALUES ('flsd-synthetic-trip-review',1);

CREATE TABLE flsd_operational.staff_user (
  authority_id text NOT NULL REFERENCES flsd_operational.authority_meta(authority_id),
  id uuid NOT NULL,
  role text NOT NULL CHECK (role IN ('OWNER','ADMIN','BILLING','OPERATIONS','VIEWER')),
  active boolean NOT NULL,
  PRIMARY KEY (authority_id,id)
);

CREATE TABLE flsd_operational.staff_authorization (
  authority_id text NOT NULL,
  staff_id uuid NOT NULL,
  revision bigint NOT NULL CHECK (revision>0),
  PRIMARY KEY (authority_id,staff_id),
  FOREIGN KEY (authority_id,staff_id) REFERENCES flsd_operational.staff_user(authority_id,id)
);

CREATE TABLE flsd_operational.staff_session (
  authority_id text NOT NULL,
  session_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  token_digest bytea NOT NULL CHECK (octet_length(token_digest)=32),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>issued_at),
  revoked_at timestamptz CHECK (revoked_at>=issued_at),
  PRIMARY KEY (authority_id,session_id),
  UNIQUE (authority_id,token_digest),
  FOREIGN KEY (authority_id,staff_id) REFERENCES flsd_operational.staff_authorization(authority_id,staff_id)
);
CREATE INDEX staff_session_staff ON flsd_operational.staff_session (authority_id,staff_id);
CREATE INDEX staff_session_expiry ON flsd_operational.staff_session (expires_at);

CREATE TABLE flsd_operational.customer (
  authority_id text NOT NULL REFERENCES flsd_operational.authority_meta(authority_id),
  id uuid NOT NULL,
  active boolean NOT NULL,
  PRIMARY KEY (authority_id,id)
);
CREATE TABLE flsd_operational.vehicle (
  authority_id text NOT NULL REFERENCES flsd_operational.authority_meta(authority_id),
  id uuid NOT NULL,
  active boolean NOT NULL,
  PRIMARY KEY (authority_id,id)
);
CREATE TABLE flsd_operational.driver (
  authority_id text NOT NULL REFERENCES flsd_operational.authority_meta(authority_id),
  id uuid NOT NULL,
  active boolean NOT NULL,
  PRIMARY KEY (authority_id,id)
);

CREATE TABLE flsd_operational.trip (
  authority_id text NOT NULL,
  id uuid NOT NULL,
  customer_id uuid NOT NULL,
  vehicle_id uuid,
  driver_id uuid,
  version bigint NOT NULL CHECK (version>0),
  PRIMARY KEY (authority_id,id),
  FOREIGN KEY (authority_id,customer_id) REFERENCES flsd_operational.customer(authority_id,id),
  FOREIGN KEY (authority_id,vehicle_id) REFERENCES flsd_operational.vehicle(authority_id,id),
  FOREIGN KEY (authority_id,driver_id) REFERENCES flsd_operational.driver(authority_id,id)
);
CREATE INDEX trip_customer ON flsd_operational.trip (authority_id,customer_id);
CREATE INDEX trip_vehicle ON flsd_operational.trip (authority_id,vehicle_id);
CREATE INDEX trip_driver ON flsd_operational.trip (authority_id,driver_id);

CREATE TABLE flsd_operational.operational_receipt (
  authority_id text NOT NULL,
  operation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  command_kind text NOT NULL CHECK (command_kind IN ('CREATE_TRIP','EDIT_TRIP')),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  result_entity_id uuid NOT NULL,
  result_version bigint NOT NULL CHECK (result_version>0),
  committed_at timestamptz NOT NULL,
  PRIMARY KEY (authority_id,operation_id),
  FOREIGN KEY (authority_id,actor_id) REFERENCES flsd_operational.staff_user(authority_id,id),
  FOREIGN KEY (authority_id,result_entity_id) REFERENCES flsd_operational.trip(authority_id,id)
);
CREATE INDEX operational_receipt_actor ON flsd_operational.operational_receipt (authority_id,actor_id);
CREATE INDEX operational_receipt_trip ON flsd_operational.operational_receipt (authority_id,result_entity_id);

REVOKE ALL ON SCHEMA flsd_operational FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA flsd_operational FROM PUBLIC;
GRANT USAGE ON SCHEMA flsd_operational TO flsd_trip_review_reader_75435c870a31;
GRANT SELECT (authority_id,contract_version) ON flsd_operational.authority_meta TO flsd_trip_review_reader_75435c870a31;
GRANT SELECT (authority_id,id,role,active) ON flsd_operational.staff_user TO flsd_trip_review_reader_75435c870a31;
GRANT SELECT (authority_id,staff_id) ON flsd_operational.staff_authorization TO flsd_trip_review_reader_75435c870a31;
GRANT SELECT (authority_id,staff_id,token_digest,issued_at,expires_at,revoked_at) ON flsd_operational.staff_session TO flsd_trip_review_reader_75435c870a31;
GRANT SELECT (authority_id,id,active) ON flsd_operational.customer,flsd_operational.vehicle,flsd_operational.driver TO flsd_trip_review_reader_75435c870a31;
GRANT SELECT (authority_id,id,customer_id,vehicle_id,driver_id,version) ON flsd_operational.trip TO flsd_trip_review_reader_75435c870a31;
GRANT SELECT (authority_id,operation_id,actor_id,command_kind,request_digest,result_entity_id,result_version) ON flsd_operational.operational_receipt TO flsd_trip_review_reader_75435c870a31;
RESET ROLE;

DO $access$
DECLARE
  reader oid := 'flsd_trip_review_reader_75435c870a31'::regrole;
  owner_oid oid := 'flsd_test_owner_b813e7439f4c'::regrole;
  scope oid := 'flsd_operational'::regnamespace;
BEGIN
  IF NOT has_database_privilege(reader,current_database(),'CONNECT')
     OR has_database_privilege(reader,current_database(),'CREATE,TEMPORARY')
     OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=reader)
     OR EXISTS (SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(reader,n.oid,'CREATE'))
     OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname IN (
       'flsd_adapter_test','flsd_iso_6e7999015d634d3aa2b8944b0fbdb1b9','flsd_iso_75435c870a3142b79761738db6c5c866'
     ) AND has_schema_privilege(reader,n.oid,'USAGE'))
  THEN RAISE EXCEPTION 'Trip-reader database or namespace privileges refused'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c WHERE CASE
      WHEN c.oid='pg_catalog.pg_settings'::regclass AND c.relkind='v' THEN
        has_table_privilege(reader,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(reader,c.oid,'INSERT,REFERENCES')
        OR EXISTS (
          SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a
          WHERE col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped
            AND a.grantee IN (0,reader) AND a.privilege_type='UPDATE'
        )
      WHEN c.relkind IN ('r','p','v','m','f') THEN
        has_table_privilege(reader,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(reader,c.oid,'INSERT,UPDATE,REFERENCES')
      WHEN c.relkind='S' THEN has_sequence_privilege(reader,c.oid,'USAGE,UPDATE')
      ELSE false
    END
  ) OR EXISTS (SELECT 1 FROM pg_largeobject_metadata l WHERE has_largeobject_privilege(reader,l.oid,'UPDATE'))
    OR EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.prosecdef
        AND has_schema_privilege(reader,p.pronamespace,'USAGE')
        AND has_function_privilege(reader,p.oid,'EXECUTE')
    )
  THEN RAISE EXCEPTION 'Trip-reader effective write capability refused'; END IF;

  IF EXISTS (SELECT 1 FROM pg_namespace n WHERE n.oid=scope AND n.nspowner<>owner_oid)
     OR EXISTS (
       SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
       WHERE n.oid=scope AND a.grantee<>owner_oid
         AND (a.grantee<>reader OR a.privilege_type<>'USAGE' OR a.is_grantable)
     )
     OR EXISTS (
       SELECT 1 FROM pg_class c LEFT JOIN LATERAL aclexplode(c.relacl) a ON true
       WHERE c.relnamespace=scope AND (c.relowner<>owner_oid OR a.grantee<>owner_oid)
     )
     OR EXISTS (
       SELECT 1 FROM pg_attribute c JOIN pg_class t ON t.oid=c.attrelid
       CROSS JOIN LATERAL aclexplode(c.attacl) a
       WHERE t.relnamespace=scope AND a.grantee<>owner_oid
         AND (a.grantee<>reader OR a.privilege_type<>'SELECT' OR a.is_grantable)
     )
  THEN RAISE EXCEPTION 'Trip-reader object owner or ACL mismatch'; END IF;
END $access$;
COMMIT;
