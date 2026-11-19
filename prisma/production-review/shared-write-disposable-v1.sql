-- REVIEW ONLY. Single-invoice, single-receivable synthetic allocation rehearsal.
-- Only the guarded installer may complete this transaction.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path TO pg_catalog;
DO $target$
BEGIN
  IF current_database()<>'flsd_main_adapter_test'
     OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1'
     OR inet_server_port() IS DISTINCT FROM 5432 OR current_user<>'postgres'
     OR pg_is_in_recovery() OR current_setting('server_version_num')::int<>180007
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
  THEN RAISE EXCEPTION 'Shared-write disposable identity mismatch'; END IF;
END $target$;

SELECT pg_advisory_xact_lock(176661,1);
DO $collision$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_namespace WHERE nspname='flsd_shared_write_rehearsal')
     OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='flsd_shared_write_runner_75435c870a31')
  THEN RAISE EXCEPTION 'Shared-write rehearsal name already in use'; END IF;
END $collision$;

CREATE ROLE flsd_shared_write_runner_75435c870a31
  LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD NULL;
COMMENT ON ROLE flsd_shared_write_runner_75435c870a31 IS
  'FLSD_SYNTHETIC_SHARED_WRITE_V1:b813e743-9f4c-4121-b8ab-b01ca51b9335';
GRANT CONNECT ON DATABASE flsd_main_adapter_test TO flsd_shared_write_runner_75435c870a31;
ALTER ROLE flsd_shared_write_runner_75435c870a31 IN DATABASE flsd_main_adapter_test SET search_path TO pg_catalog;
SET LOCAL ROLE flsd_test_owner_b813e7439f4c;

CREATE SCHEMA flsd_shared_write_rehearsal;
COMMENT ON SCHEMA flsd_shared_write_rehearsal IS
  'FLSD_SYNTHETIC_SHARED_WRITE_V1:b813e743-9f4c-4121-b8ab-b01ca51b9335';
CREATE TABLE flsd_shared_write_rehearsal.authority_meta (
  authority_id text PRIMARY KEY CHECK (authority_id='flsd-synthetic-shared-write'),
  contract_version integer NOT NULL CHECK (contract_version=1)
);
INSERT INTO flsd_shared_write_rehearsal.authority_meta VALUES ('flsd-synthetic-shared-write',1);

CREATE TABLE flsd_shared_write_rehearsal.staff_authorization (
  authority_id text NOT NULL REFERENCES flsd_shared_write_rehearsal.authority_meta(authority_id),
  staff_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  active boolean NOT NULL,
  role text NOT NULL CHECK (role IN ('OWNER','ADMIN','BILLING','OPERATIONS','VIEWER')),
  lock_guard boolean NOT NULL DEFAULT true CHECK (lock_guard),
  PRIMARY KEY (authority_id,staff_id)
);
CREATE TABLE flsd_shared_write_rehearsal.staff_session (
  authority_id text NOT NULL,
  session_id uuid NOT NULL,
  staff_id uuid NOT NULL,
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>issued_at),
  revoked_at timestamptz CHECK (revoked_at>=issued_at),
  PRIMARY KEY (authority_id,session_id),
  FOREIGN KEY (authority_id,staff_id) REFERENCES flsd_shared_write_rehearsal.staff_authorization(authority_id,staff_id)
);
CREATE INDEX staff_session_staff ON flsd_shared_write_rehearsal.staff_session (authority_id,staff_id);

CREATE TABLE flsd_shared_write_rehearsal.customer (
  authority_id text NOT NULL REFERENCES flsd_shared_write_rehearsal.authority_meta(authority_id),
  id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  PRIMARY KEY (authority_id,id)
);
CREATE TABLE flsd_shared_write_rehearsal.trip (
  authority_id text NOT NULL,
  id uuid NOT NULL,
  customer_id uuid NOT NULL,
  version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  lock_guard boolean NOT NULL DEFAULT true CHECK (lock_guard),
  PRIMARY KEY (authority_id,id),
  UNIQUE (authority_id,id,customer_id),
  FOREIGN KEY (authority_id,customer_id) REFERENCES flsd_shared_write_rehearsal.customer(authority_id,id)
);
CREATE TABLE flsd_shared_write_rehearsal.payment (
  authority_id text NOT NULL,
  id uuid NOT NULL,
  customer_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  state text NOT NULL CHECK (state IN ('RECORDED','VOIDED')),
  allocation_scope text NOT NULL CHECK (allocation_scope='CUSTOMER'),
  received numeric(18,2) NOT NULL CHECK (received>0 AND received<'Infinity'::numeric),
  allocated numeric(18,2) NOT NULL DEFAULT 0 CHECK (allocated>=0 AND allocated<=received),
  PRIMARY KEY (authority_id,id),
  UNIQUE (authority_id,id,customer_id),
  FOREIGN KEY (authority_id,customer_id) REFERENCES flsd_shared_write_rehearsal.customer(authority_id,id)
);
CREATE TABLE flsd_shared_write_rehearsal.refund (
  authority_id text NOT NULL,
  id uuid NOT NULL,
  payment_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  state text NOT NULL CHECK (state IN ('RESERVED','COMPLETED')),
  amount numeric(18,2) NOT NULL CHECK (amount>0 AND amount<'Infinity'::numeric),
  lock_guard boolean NOT NULL DEFAULT true CHECK (lock_guard),
  PRIMARY KEY (authority_id,id),
  FOREIGN KEY (authority_id,payment_id,customer_id) REFERENCES flsd_shared_write_rehearsal.payment(authority_id,id,customer_id)
);
CREATE INDEX refund_payment ON flsd_shared_write_rehearsal.refund (authority_id,payment_id);

CREATE TABLE flsd_shared_write_rehearsal.trip_receivable (
  authority_id text NOT NULL,
  id uuid NOT NULL,
  customer_id uuid NOT NULL,
  trip_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  eligible boolean NOT NULL,
  payable numeric(18,2) NOT NULL CHECK (payable>=0 AND payable<'Infinity'::numeric),
  allocated numeric(18,2) NOT NULL DEFAULT 0 CHECK (allocated>=0 AND allocated<=payable),
  outstanding numeric(18,2) GENERATED ALWAYS AS (payable-allocated) STORED,
  PRIMARY KEY (authority_id,id),
  UNIQUE (authority_id,id,customer_id),
  UNIQUE (authority_id,trip_id),
  FOREIGN KEY (authority_id,trip_id,customer_id) REFERENCES flsd_shared_write_rehearsal.trip(authority_id,id,customer_id)
);
CREATE TABLE flsd_shared_write_rehearsal.invoice (
  authority_id text NOT NULL,
  id uuid NOT NULL,
  customer_id uuid NOT NULL,
  receivable_id uuid NOT NULL,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  eligible boolean NOT NULL,
  lock_guard boolean NOT NULL DEFAULT true CHECK (lock_guard),
  PRIMARY KEY (authority_id,id),
  UNIQUE (authority_id,id,customer_id,receivable_id),
  FOREIGN KEY (authority_id,receivable_id,customer_id) REFERENCES flsd_shared_write_rehearsal.trip_receivable(authority_id,id,customer_id)
);

CREATE TABLE flsd_shared_write_rehearsal.financial_operation (
  authority_id text NOT NULL,
  operation_id uuid NOT NULL,
  operation_key text NOT NULL CHECK (operation_key ~ '^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$'),
  command_kind text NOT NULL CHECK (command_kind='ALLOCATE_PAYMENT'),
  request_digest bytea NOT NULL CHECK (octet_length(request_digest)=32),
  actor_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  payment_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  receivable_id uuid NOT NULL,
  cash numeric(18,2) NOT NULL CHECK (cash>0 AND cash<'Infinity'::numeric),
  PRIMARY KEY (authority_id,operation_id),
  UNIQUE (authority_id,operation_key),
  UNIQUE (authority_id,operation_id,customer_id,invoice_id,receivable_id),
  FOREIGN KEY (authority_id,actor_id) REFERENCES flsd_shared_write_rehearsal.staff_authorization(authority_id,staff_id),
  FOREIGN KEY (authority_id,payment_id,customer_id) REFERENCES flsd_shared_write_rehearsal.payment(authority_id,id,customer_id),
  FOREIGN KEY (authority_id,invoice_id,customer_id,receivable_id) REFERENCES flsd_shared_write_rehearsal.invoice(authority_id,id,customer_id,receivable_id)
);
CREATE INDEX operation_payment ON flsd_shared_write_rehearsal.financial_operation (authority_id,payment_id);
CREATE INDEX operation_receivable ON flsd_shared_write_rehearsal.financial_operation (authority_id,receivable_id);

CREATE TABLE flsd_shared_write_rehearsal.invoice_reservation (
  authority_id text NOT NULL,
  customer_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  receivable_id uuid NOT NULL,
  created_by_operation uuid NOT NULL,
  PRIMARY KEY (authority_id,receivable_id),
  FOREIGN KEY (authority_id,invoice_id,customer_id,receivable_id)
    REFERENCES flsd_shared_write_rehearsal.invoice(authority_id,id,customer_id,receivable_id),
  FOREIGN KEY (authority_id,created_by_operation,customer_id,invoice_id,receivable_id)
    REFERENCES flsd_shared_write_rehearsal.financial_operation(authority_id,operation_id,customer_id,invoice_id,receivable_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE flsd_shared_write_rehearsal.allocation_event (
  authority_id text NOT NULL,
  operation_id uuid NOT NULL,
  cash_delta numeric(18,2) NOT NULL CHECK (cash_delta>0 AND cash_delta<'Infinity'::numeric),
  PRIMARY KEY (authority_id,operation_id),
  FOREIGN KEY (authority_id,operation_id) REFERENCES flsd_shared_write_rehearsal.financial_operation(authority_id,operation_id)
    DEFERRABLE INITIALLY DEFERRED
);
CREATE TABLE flsd_shared_write_rehearsal.allocation_audit (
  authority_id text NOT NULL,
  operation_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  reason text NOT NULL CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  PRIMARY KEY (authority_id,operation_id),
  FOREIGN KEY (authority_id,operation_id) REFERENCES flsd_shared_write_rehearsal.financial_operation(authority_id,operation_id)
    DEFERRABLE INITIALLY DEFERRED,
  FOREIGN KEY (authority_id,actor_id) REFERENCES flsd_shared_write_rehearsal.staff_authorization(authority_id,staff_id)
);

CREATE FUNCTION flsd_shared_write_rehearsal.refuse_history_change() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog AS $immutable$
BEGIN
  RAISE EXCEPTION 'Synthetic allocation history is immutable';
END $immutable$;
CREATE TRIGGER immutable_operation BEFORE UPDATE OR DELETE ON flsd_shared_write_rehearsal.financial_operation
  FOR EACH ROW EXECUTE FUNCTION flsd_shared_write_rehearsal.refuse_history_change();
CREATE TRIGGER immutable_reservation BEFORE UPDATE OR DELETE ON flsd_shared_write_rehearsal.invoice_reservation
  FOR EACH ROW EXECUTE FUNCTION flsd_shared_write_rehearsal.refuse_history_change();
CREATE TRIGGER immutable_event BEFORE UPDATE OR DELETE ON flsd_shared_write_rehearsal.allocation_event
  FOR EACH ROW EXECUTE FUNCTION flsd_shared_write_rehearsal.refuse_history_change();
CREATE TRIGGER immutable_audit BEFORE UPDATE OR DELETE ON flsd_shared_write_rehearsal.allocation_audit
  FOR EACH ROW EXECUTE FUNCTION flsd_shared_write_rehearsal.refuse_history_change();

CREATE FUNCTION flsd_shared_write_rehearsal.verify_revision_advance() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog AS $revision$
BEGIN
  IF NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'Synthetic coordination revision must advance once';
  END IF;
  RETURN NEW;
END $revision$;
CREATE TRIGGER customer_revision BEFORE UPDATE ON flsd_shared_write_rehearsal.customer
  FOR EACH ROW EXECUTE FUNCTION flsd_shared_write_rehearsal.verify_revision_advance();
CREATE TRIGGER payment_revision BEFORE UPDATE ON flsd_shared_write_rehearsal.payment
  FOR EACH ROW EXECUTE FUNCTION flsd_shared_write_rehearsal.verify_revision_advance();
CREATE TRIGGER receivable_revision BEFORE UPDATE ON flsd_shared_write_rehearsal.trip_receivable
  FOR EACH ROW EXECUTE FUNCTION flsd_shared_write_rehearsal.verify_revision_advance();

CREATE FUNCTION flsd_shared_write_rehearsal.verify_allocation_effects() RETURNS trigger
LANGUAGE plpgsql SET search_path TO pg_catalog AS $verify$
DECLARE
  scope_id text := NEW.authority_id;
  payment_key uuid;
  receivable_key uuid;
BEGIN
  IF TG_TABLE_NAME='financial_operation' THEN
    payment_key := NEW.payment_id;
    receivable_key := NEW.receivable_id;
    IF NOT EXISTS (
      SELECT 1 FROM flsd_shared_write_rehearsal.allocation_event e
      WHERE e.authority_id=scope_id AND e.operation_id=NEW.operation_id AND e.cash_delta=NEW.cash
    ) OR NOT EXISTS (
      SELECT 1 FROM flsd_shared_write_rehearsal.allocation_audit a
      WHERE a.authority_id=scope_id AND a.operation_id=NEW.operation_id AND a.actor_id=NEW.actor_id
    ) OR NOT EXISTS (
      SELECT 1 FROM flsd_shared_write_rehearsal.invoice_reservation r
      WHERE r.authority_id=scope_id AND r.receivable_id=receivable_key
        AND r.invoice_id=NEW.invoice_id AND r.customer_id=NEW.customer_id
    ) OR NOT EXISTS (
      SELECT 1 FROM flsd_shared_write_rehearsal.payment p
      JOIN flsd_shared_write_rehearsal.invoice i ON i.authority_id=p.authority_id
      JOIN flsd_shared_write_rehearsal.trip_receivable r ON r.authority_id=i.authority_id AND r.id=i.receivable_id
      WHERE p.authority_id=scope_id AND p.id=payment_key AND p.state='RECORDED' AND i.id=NEW.invoice_id
        AND i.eligible AND r.eligible
    )
    THEN RAISE EXCEPTION 'Synthetic allocation effects incomplete or ineligible'; END IF;
  ELSIF TG_TABLE_NAME='payment' THEN
    payment_key := NEW.id;
  ELSIF TG_TABLE_NAME='refund' THEN
    payment_key := NEW.payment_id;
  ELSIF TG_TABLE_NAME='trip_receivable' THEN
    receivable_key := NEW.id;
  ELSE
    RAISE EXCEPTION 'Unexpected synthetic projection trigger';
  END IF;

  IF payment_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM flsd_shared_write_rehearsal.payment p
    WHERE p.authority_id=scope_id AND p.id=payment_key
      AND p.allocated=COALESCE((
        SELECT sum(e.cash_delta) FROM flsd_shared_write_rehearsal.financial_operation o
        JOIN flsd_shared_write_rehearsal.allocation_event e USING (authority_id,operation_id)
        WHERE o.authority_id=scope_id AND o.payment_id=payment_key
      ),0)
      AND p.allocated+COALESCE((
        SELECT sum(r.amount) FROM flsd_shared_write_rehearsal.refund r
        WHERE r.authority_id=scope_id AND r.payment_id=payment_key
      ),0)<=p.received
  ) THEN RAISE EXCEPTION 'Synthetic payment projection or available credit mismatch'; END IF;

  IF receivable_key IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM flsd_shared_write_rehearsal.trip_receivable r
    WHERE r.authority_id=scope_id AND r.id=receivable_key
      AND r.allocated=COALESCE((
        SELECT sum(e.cash_delta) FROM flsd_shared_write_rehearsal.financial_operation o
        JOIN flsd_shared_write_rehearsal.allocation_event e USING (authority_id,operation_id)
        WHERE o.authority_id=scope_id AND o.receivable_id=receivable_key
      ),0)
  ) THEN RAISE EXCEPTION 'Synthetic receivable projection mismatch'; END IF;
  RETURN NEW;
END $verify$;

CREATE CONSTRAINT TRIGGER operation_effects AFTER INSERT ON flsd_shared_write_rehearsal.financial_operation
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flsd_shared_write_rehearsal.verify_allocation_effects();
CREATE CONSTRAINT TRIGGER payment_projection AFTER INSERT OR UPDATE ON flsd_shared_write_rehearsal.payment
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flsd_shared_write_rehearsal.verify_allocation_effects();
CREATE CONSTRAINT TRIGGER refund_projection AFTER INSERT ON flsd_shared_write_rehearsal.refund
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flsd_shared_write_rehearsal.verify_allocation_effects();
CREATE CONSTRAINT TRIGGER receivable_projection AFTER INSERT OR UPDATE ON flsd_shared_write_rehearsal.trip_receivable
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION flsd_shared_write_rehearsal.verify_allocation_effects();

REVOKE ALL ON SCHEMA flsd_shared_write_rehearsal FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA flsd_shared_write_rehearsal FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA flsd_shared_write_rehearsal FROM PUBLIC;
GRANT USAGE ON SCHEMA flsd_shared_write_rehearsal TO flsd_shared_write_runner_75435c870a31;
GRANT SELECT ON ALL TABLES IN SCHEMA flsd_shared_write_rehearsal TO flsd_shared_write_runner_75435c870a31;
GRANT INSERT ON flsd_shared_write_rehearsal.invoice_reservation,flsd_shared_write_rehearsal.financial_operation,
  flsd_shared_write_rehearsal.allocation_event,flsd_shared_write_rehearsal.allocation_audit TO flsd_shared_write_runner_75435c870a31;
GRANT UPDATE (revision) ON flsd_shared_write_rehearsal.customer TO flsd_shared_write_runner_75435c870a31;
GRANT UPDATE (revision,allocated) ON flsd_shared_write_rehearsal.payment,flsd_shared_write_rehearsal.trip_receivable
  TO flsd_shared_write_runner_75435c870a31;
GRANT UPDATE (lock_guard) ON flsd_shared_write_rehearsal.staff_authorization,flsd_shared_write_rehearsal.trip,
  flsd_shared_write_rehearsal.invoice,flsd_shared_write_rehearsal.refund TO flsd_shared_write_runner_75435c870a31;
RESET ROLE;

DO $access$
DECLARE
  runner_oid oid := 'flsd_shared_write_runner_75435c870a31'::regrole;
  owner_oid oid := 'flsd_test_owner_b813e7439f4c'::regrole;
  scope_oid oid := 'flsd_shared_write_rehearsal'::regnamespace;
BEGIN
  IF has_database_privilege(runner_oid,current_database(),'CREATE,TEMPORARY')
     OR EXISTS (SELECT 1 FROM pg_auth_members WHERE member=runner_oid)
     OR EXISTS (SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(runner_oid,n.oid,'CREATE'))
     OR EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspname IN (
       'flsd_adapter_test','flsd_operational','flsd_iso_6e7999015d634d3aa2b8944b0fbdb1b9','flsd_iso_75435c870a3142b79761738db6c5c866'
     ) AND has_schema_privilege(runner_oid,n.oid,'USAGE'))
  THEN RAISE EXCEPTION 'Synthetic writer database or namespace privileges refused'; END IF;

  IF EXISTS (
    SELECT 1 FROM pg_class c WHERE c.relnamespace<>scope_oid AND CASE
      WHEN c.oid='pg_catalog.pg_settings'::regclass AND c.relkind='v' THEN
        has_table_privilege(runner_oid,c.oid,'INSERT,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(runner_oid,c.oid,'INSERT,REFERENCES')
        OR EXISTS (
          SELECT 1 FROM pg_attribute col CROSS JOIN LATERAL aclexplode(col.attacl) a
          WHERE col.attrelid=c.oid AND col.attnum>0 AND NOT col.attisdropped
            AND a.grantee IN (0,runner_oid) AND a.privilege_type='UPDATE'
        )
      WHEN c.relkind IN ('r','p','v','m','f') THEN
        has_table_privilege(runner_oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
        OR has_any_column_privilege(runner_oid,c.oid,'INSERT,UPDATE,REFERENCES')
      WHEN c.relkind='S' THEN has_sequence_privilege(runner_oid,c.oid,'USAGE,UPDATE')
      ELSE false
    END
  ) OR EXISTS (SELECT 1 FROM pg_largeobject_metadata l WHERE has_largeobject_privilege(runner_oid,l.oid,'UPDATE'))
    OR EXISTS (
      SELECT 1 FROM pg_proc p WHERE p.prosecdef
        AND has_schema_privilege(runner_oid,p.pronamespace,'USAGE')
        AND has_function_privilege(runner_oid,p.oid,'EXECUTE')
    )
  THEN RAISE EXCEPTION 'Synthetic writer external privileges refused'; END IF;

  IF EXISTS (SELECT 1 FROM pg_namespace n WHERE n.oid=scope_oid AND n.nspowner<>owner_oid)
     OR EXISTS (
       SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
       WHERE n.oid=scope_oid AND a.grantee<>owner_oid
         AND (a.grantee<>runner_oid OR a.privilege_type<>'USAGE' OR a.is_grantable)
     )
     OR EXISTS (
       SELECT 1 FROM pg_class t LEFT JOIN LATERAL aclexplode(t.relacl) a ON true
       WHERE t.relnamespace=scope_oid AND (t.relowner<>owner_oid OR
         (a.grantee<>owner_oid AND (a.grantee<>runner_oid OR a.is_grantable OR
           (a.privilege_type<>'SELECT' AND NOT (
             a.privilege_type='INSERT' AND t.relname IN ('invoice_reservation','financial_operation','allocation_event','allocation_audit')
           )))))
     )
     OR EXISTS (
       SELECT 1 FROM pg_attribute c JOIN pg_class t ON t.oid=c.attrelid
       CROSS JOIN LATERAL aclexplode(c.attacl) a WHERE t.relnamespace=scope_oid AND a.grantee<>owner_oid
         AND (a.grantee<>runner_oid OR a.is_grantable OR a.privilege_type<>'UPDATE' OR NOT (
           (c.attname='lock_guard' AND t.relname IN ('staff_authorization','trip','invoice','refund'))
           OR (c.attname='revision' AND t.relname IN ('customer','payment','trip_receivable'))
           OR (c.attname='allocated' AND t.relname IN ('payment','trip_receivable'))
         ))
     )
     OR EXISTS (
       SELECT 1 FROM pg_proc p CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) a
       WHERE p.pronamespace=scope_oid AND (p.proowner<>owner_oid OR a.grantee<>owner_oid)
     )
  THEN RAISE EXCEPTION 'Synthetic writer object owner or ACL mismatch'; END IF;
END $access$;
