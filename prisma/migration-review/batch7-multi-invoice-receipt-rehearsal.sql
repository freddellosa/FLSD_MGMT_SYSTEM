-- Apply only inside the guarded fresh receipt rehearsal transaction.
DO $guard$
BEGIN
  IF current_database() <> 'flsd_batch7_receipt_rehearsal'
     OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet
     OR inet_server_port() IS DISTINCT FROM 55437
     OR current_user <> 'flsd_pilot_admin'
     OR NOT EXISTS (
       SELECT 1 FROM pg_database
       WHERE datname=current_database() AND
         shobj_description(oid,'pg_database')='FLSD_BATCH7_RECEIPT_REHEARSAL_ONLY'
     )
  THEN RAISE EXCEPTION 'Fresh fictional receipt rehearsal required'; END IF;
END $guard$;

-- The four-column unique key referenced by invoice_reservation stays intact.
-- An operation can attribute each invoice and each receivable at most once.
ALTER TABLE flsd_batch7_commit_rehearsal.operation_scope
  DROP CONSTRAINT operation_scope_pkey,
  ADD PRIMARY KEY (operation_id, invoice_id),
  ADD UNIQUE (operation_id, receivable_id);

GRANT USAGE ON SCHEMA flsd_batch7_commit_rehearsal TO flsd_batch7_receipt_rehearsal_writer;
GRANT INSERT ON flsd_batch7_commit_rehearsal."Payment",
  flsd_batch7_commit_rehearsal.payment_scope,
  flsd_batch7_commit_rehearsal."FinancialOperation",
  flsd_batch7_commit_rehearsal.operation_scope,
  flsd_batch7_commit_rehearsal."PaymentAllocation",
  flsd_batch7_commit_rehearsal."PaymentAllocationEvent",
  flsd_batch7_commit_rehearsal."AuditEvent"
  TO flsd_batch7_receipt_rehearsal_writer;
