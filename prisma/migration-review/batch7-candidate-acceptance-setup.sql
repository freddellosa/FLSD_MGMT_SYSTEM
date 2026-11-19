-- Offline review packet. Requires separate approval for execution.
-- Supply session_digest and session_id as psql variables. Keep the raw token out of SQL.
\set ON_ERROR_STOP on
BEGIN ISOLATION LEVEL SERIALIZABLE;
SET LOCAL search_path TO pg_catalog;
SELECT pg_advisory_xact_lock(176661,1);

DO $guard$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_database d CROSS JOIN pg_namespace n
    WHERE d.datname=current_database() AND d.datname='flsd_main_adapter_test' AND d.oid=16394
      AND inet_server_addr()='127.0.0.1'::inet AND inet_server_port()=5432
      AND n.nspname='flsd_batch7_commit_rehearsal' AND n.oid=19396 AND n.nspowner=16392
      AND obj_description(n.oid,'pg_namespace')='FLSD_SYNTHETIC_BATCH7_COMMITTED_V1'
  ) OR EXISTS (SELECT 1 FROM pg_roles WHERE rolname='flsd_batch7_candidate_writer') THEN
    RAISE EXCEPTION 'Candidate provisioning target or role mismatch';
  END IF;
END
$guard$;

LOCK TABLE flsd_batch7_commit_rehearsal.staff_authorization, flsd_batch7_commit_rehearsal.staff_session,
  flsd_batch7_commit_rehearsal."StaffUser", flsd_batch7_commit_rehearsal."FinancialOperation",
  flsd_batch7_commit_rehearsal."PaymentAllocation", flsd_batch7_commit_rehearsal.operation_scope
  IN ACCESS EXCLUSIVE MODE NOWAIT;

SELECT set_config('flsd_acceptance.session_digest', :'session_digest', true),
       set_config('flsd_acceptance.session_id', :'session_id', true)
\gset setup_

DO $fixture$
BEGIN
  IF current_setting('flsd_acceptance.session_digest') !~ '^[a-f0-9]{64}$'
     OR current_setting('flsd_acceptance.session_id') !~ '^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$'
     OR EXISTS (SELECT 1 FROM flsd_batch7_commit_rehearsal.staff_session)
     OR EXISTS (
       SELECT 1 FROM pg_attribute
       WHERE attrelid='flsd_batch7_commit_rehearsal.staff_authorization'::regclass
         AND attname='lock_guard' AND NOT attisdropped
     )
     OR (SELECT count(*) FROM flsd_batch7_commit_rehearsal."FinancialOperation")<>2
     OR (SELECT count(*) FROM flsd_batch7_commit_rehearsal.operation_scope)<>1
     OR NOT EXISTS (
       SELECT 1 FROM flsd_batch7_commit_rehearsal."FinancialOperation" o
       JOIN flsd_batch7_commit_rehearsal.operation_scope s ON s.operation_id=o.id
       JOIN flsd_batch7_commit_rehearsal.invoice_reservation v ON v.operation_id=o.id
       JOIN flsd_batch7_commit_rehearsal."PaymentAllocation" p
         ON (p."paymentId",p."invoiceId")=(s.payment_id,s.invoice_id)
       WHERE o.id='70000000-0000-4000-8000-000000000007' AND o."idempotencyKey"='candidate-bound'
         AND o."allocatedCash"=6.00 AND p.amount=10.01 AND p."withheldTax"=0
     )
     OR NOT EXISTS (
       SELECT 1 FROM flsd_batch7_commit_rehearsal."FinancialOperation" o
       WHERE o.id='70000000-0000-4000-8000-000000000008' AND o."idempotencyKey"='candidate-unbound'
         AND o."allocatedCash"=4.01
     )
     OR NOT EXISTS (
       SELECT 1 FROM flsd_batch7_commit_rehearsal.staff_authorization a
       JOIN flsd_batch7_commit_rehearsal."StaffUser" u ON u.id=a.staff_id
       WHERE a.staff_id='70000000-0000-4000-8000-000000000001' AND a.revision=1
         AND u.email='batch7@example.invalid' AND u."passwordHash"='DISABLED' AND u.role='BILLING' AND u.active
     ) THEN
    RAISE EXCEPTION 'Candidate provisioning fixture mismatch';
  END IF;
END
$fixture$;

CREATE ROLE flsd_batch7_candidate_writer NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
COMMENT ON ROLE flsd_batch7_candidate_writer IS 'FLSD_SYNTHETIC_BATCH7_ACCEPTANCE_V1';
GRANT CONNECT ON DATABASE flsd_main_adapter_test TO flsd_batch7_candidate_writer;
GRANT USAGE ON SCHEMA flsd_batch7_commit_rehearsal TO flsd_batch7_candidate_writer;

ALTER TABLE flsd_batch7_commit_rehearsal.staff_authorization ADD COLUMN lock_guard boolean NOT NULL DEFAULT false CHECK (NOT lock_guard);
GRANT SELECT (staff_id,revision), UPDATE (lock_guard) ON flsd_batch7_commit_rehearsal.staff_authorization TO flsd_batch7_candidate_writer;
GRANT SELECT (id,active,role) ON flsd_batch7_commit_rehearsal."StaffUser" TO flsd_batch7_candidate_writer;
GRANT SELECT ON flsd_batch7_commit_rehearsal.staff_session,
  flsd_batch7_commit_rehearsal."Payment", flsd_batch7_commit_rehearsal."PaymentAllocation",
  flsd_batch7_commit_rehearsal."PaymentRefund", flsd_batch7_commit_rehearsal."OfficialInvoice",
  flsd_batch7_commit_rehearsal.payment_scope, flsd_batch7_commit_rehearsal.receivable,
  flsd_batch7_commit_rehearsal.invoice_attribution, flsd_batch7_commit_rehearsal.invoice_reservation
  TO flsd_batch7_candidate_writer;
GRANT SELECT, INSERT ON flsd_batch7_commit_rehearsal."FinancialOperation",
  flsd_batch7_commit_rehearsal."PaymentAllocationEvent", flsd_batch7_commit_rehearsal."AuditEvent",
  flsd_batch7_commit_rehearsal.operation_scope TO flsd_batch7_candidate_writer;
GRANT UPDATE (amount) ON flsd_batch7_commit_rehearsal."PaymentAllocation" TO flsd_batch7_candidate_writer;

DO $privileges$
DECLARE
  writer constant text := 'flsd_batch7_candidate_writer';
BEGIN
  IF has_database_privilege(writer,current_database(),'CREATE')
     OR EXISTS (
       WITH sequences AS MATERIALIZED (
         SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE c.relkind='S' AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
       )
       SELECT 1 FROM sequences
       WHERE has_sequence_privilege(writer,oid,'USAGE, SELECT, UPDATE')
     )
     OR EXISTS (
       SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
       WHERE p.prosecdef AND n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
         AND has_schema_privilege(writer,n.oid,'USAGE')
         AND has_function_privilege(writer,p.oid,'EXECUTE')
     )
     OR EXISTS (
       SELECT 1 FROM pg_namespace n
       WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
         AND has_schema_privilege(writer,n.oid,'CREATE')
     )
     OR EXISTS (
       WITH relations AS MATERIALIZED (
         SELECT c.oid,c.relname,n.oid AS schema_oid
         FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname !~ '^pg_' AND n.nspname<>'information_schema'
           AND c.relkind IN ('r','p','v','m','f')
       )
       SELECT 1 FROM relations c
       WHERE (
           has_table_privilege(writer,c.oid,'UPDATE, DELETE, TRUNCATE, TRIGGER, REFERENCES')
           OR has_any_column_privilege(writer,c.oid,'REFERENCES')
           OR (has_any_column_privilege(writer,c.oid,'SELECT') AND
             (c.schema_oid<>19396 OR c.relname NOT IN ('StaffUser','staff_authorization','staff_session','Payment',
               'PaymentAllocation','PaymentRefund','OfficialInvoice','payment_scope','receivable','invoice_attribution',
               'invoice_reservation','FinancialOperation','PaymentAllocationEvent','AuditEvent','operation_scope')))
           OR (has_any_column_privilege(writer,c.oid,'INSERT') AND
             (c.schema_oid<>19396 OR c.relname NOT IN ('FinancialOperation','PaymentAllocationEvent','AuditEvent','operation_scope')))
           OR EXISTS (
             SELECT 1 FROM pg_attribute a
             WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
               AND ((has_column_privilege(writer,c.oid,a.attnum,'UPDATE') AND
                 (c.schema_oid<>19396 OR (c.relname,a.attname) NOT IN (('staff_authorization','lock_guard'),('PaymentAllocation','amount'))))
               OR (c.schema_oid=19396 AND c.relname='StaffUser' AND a.attname NOT IN ('id','active','role')
                 AND has_column_privilege(writer,c.oid,a.attnum,'SELECT'))
               OR (c.schema_oid=19396 AND c.relname='staff_authorization' AND a.attname NOT IN ('staff_id','revision')
                 AND has_column_privilege(writer,c.oid,a.attnum,'SELECT')))
           )
         )
     ) THEN
    RAISE EXCEPTION 'Candidate writer has unexpected effective privileges';
  END IF;
END
$privileges$;

INSERT INTO flsd_batch7_commit_rehearsal.staff_session (id,staff_id,token_digest,issued_at,expires_at)
SELECT current_setting('flsd_acceptance.session_id')::uuid,'70000000-0000-4000-8000-000000000001',
       decode(current_setting('flsd_acceptance.session_digest'),'hex'), t, t+interval '15 minutes'
FROM (SELECT statement_timestamp() AS t) clock;

COMMIT;
SELECT oid::text AS writer_role_oid FROM pg_roles WHERE rolname='flsd_batch7_candidate_writer';
