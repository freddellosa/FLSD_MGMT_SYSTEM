-- Guarded synthetic catalog and seed acceptance, before commit.
DO $accept$
DECLARE
  ns oid := 'flsd_batch7_commit_rehearsal'::regnamespace;
  actual text[];
BEGIN
  SELECT array_agg(relname::text ORDER BY relname COLLATE "C") INTO actual
  FROM pg_class WHERE relnamespace=ns AND relkind='r';
  IF actual IS DISTINCT FROM ARRAY[
    'AuditEvent','Customer','Driver','FinancialOperation','ImportBatch','InvoiceSerialBatch','OfficialInvoice',
    'Payment','PaymentAllocation','PaymentAllocationEvent','PaymentAttachment','PaymentRefund',
    'SoaTrip','StaffUser','StatementOfAccount','Trip','UnmatchedPaymentCase','Vehicle'
  ] THEN RAISE EXCEPTION 'Candidate table inventory mismatch'; END IF;

  SELECT array_agg(t.typname::text ORDER BY t.typname COLLATE "C") INTO actual
  FROM pg_type t WHERE t.typnamespace=ns AND t.typtype='e';
  IF actual IS DISTINCT FROM ARRAY[
    'AttachmentState','ImportState','InvoiceState','PaymentState','RefundState','SoaState','StaffRole','UnmatchedCaseState'
  ] THEN RAISE EXCEPTION 'Candidate enum inventory mismatch'; END IF;

  IF EXISTS(SELECT 1 FROM pg_class WHERE relnamespace=ns AND relowner<>16392::oid)
     OR EXISTS(SELECT 1 FROM pg_namespace n CROSS JOIN LATERAL aclexplode(n.nspacl) a
       WHERE n.oid=ns AND a.grantee<>16392::oid)
     OR EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
       WHERE c.relnamespace=ns AND a.grantee<>16392::oid)
     OR EXISTS(SELECT 1 FROM pg_class c JOIN pg_attribute v ON v.attrelid=c.oid
       CROSS JOIN LATERAL aclexplode(v.attacl) a WHERE c.relnamespace=ns AND a.grantee<>16392::oid)
     OR EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid
       JOIN pg_class ref ON ref.oid=k.confrelid WHERE c.relnamespace=ns AND ref.relnamespace<>ns)
     OR NOT EXISTS(SELECT 1 FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
       WHERE c.relnamespace=ns AND c.relname='one_active_invoice_per_soa' AND i.indisunique AND i.indisvalid AND i.indpred IS NOT NULL)
     OR NOT EXISTS(SELECT 1 FROM pg_constraint k WHERE k.conrelid='flsd_batch7_commit_rehearsal."InvoiceSerialBatch"'::regclass
       AND k.conname='valid_serial_range' AND k.convalidated)
     OR NOT EXISTS(SELECT 1 FROM pg_sequence WHERE seqrelid='flsd_batch7_commit_rehearsal.flsd_soa_number_seq'::regclass
       AND seqstart=1 AND seqincrement=1)
  THEN RAISE EXCEPTION 'Candidate ownership, dependency or foundation control mismatch'; END IF;

  IF (SELECT count(*) FROM flsd_batch7_commit_rehearsal."FinancialOperation")<>2
     OR (SELECT count(*) FROM flsd_batch7_commit_rehearsal."PaymentAllocationEvent" WHERE "operationId" IS NULL)<>1
     OR NOT EXISTS(
       SELECT 1 FROM flsd_batch7_commit_rehearsal."FinancialOperation" o
       JOIN flsd_batch7_commit_rehearsal."PaymentAllocationEvent" e ON e."operationId"=o.id
       JOIN flsd_batch7_commit_rehearsal."PaymentAllocation" a ON (a."paymentId",a."invoiceId")=(e."paymentId",e."invoiceId")
       JOIN flsd_batch7_commit_rehearsal."Payment" p ON p.id=o."paymentId"
       WHERE o."idempotencyKey"='candidate-bound' AND o."requestDigest"~'^[0-9a-f]{64}$'
         AND o."allocatedCash"=6.00 AND e."cashDelta"=o."allocatedCash" AND a.amount=10.01 AND p.amount=100.01
     )
     OR (SELECT sum(amount) FROM flsd_batch7_commit_rehearsal."PaymentRefund") IS DISTINCT FROM 30.00
  THEN RAISE EXCEPTION 'Candidate seed reconciliation mismatch'; END IF;
END $accept$;
