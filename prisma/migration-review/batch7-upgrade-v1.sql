-- Review draft. Requires the caller's guarded transaction and a verified synthetic baseline.
-- The installer must set search_path to pg_catalog; all objects below are qualified.
DO $target$
BEGIN
  IF current_database()<>'flsd_main_adapter_test' OR host(inet_server_addr()) IS DISTINCT FROM '127.0.0.1'
     OR inet_server_port() IS DISTINCT FROM 5432 OR current_setting('server_version_num')<>'180007'
     OR current_setting('transaction_isolation')<>'serializable' OR pg_is_in_recovery()
     OR NOT EXISTS (
       SELECT 1 FROM pg_database d JOIN pg_namespace n ON n.nspowner=d.datdba
       WHERE d.datname=current_database() AND d.oid=16394::oid AND d.datdba=16392::oid
         AND shobj_description(d.oid,'pg_database')='FLSD_DISPOSABLE:b813e743-9f4c-4121-b8ab-b01ca51b9335:flsd_main_adapter_test'
         AND n.nspname='flsd_batch7_upgrade_review'
         AND obj_description(n.oid,'pg_namespace')='FLSD_SYNTHETIC_BATCH7_UPGRADE_V1'
     )
  THEN RAISE EXCEPTION 'Batch 7 upgrade review target refused'; END IF;
  IF (SELECT count(*) FROM flsd_batch7_upgrade_review.baseline_kind)<>1
     OR NOT EXISTS (SELECT 1 FROM flsd_batch7_upgrade_review.baseline_kind b
       WHERE (b.kind='FOUNDATION' AND to_regclass('flsd_batch7_upgrade_review."FinancialOperation"') IS NULL)
          OR (b.kind='RECEIPT_BEARING' AND to_regclass('flsd_batch7_upgrade_review."FinancialOperation"') IS NOT NULL))
  THEN RAISE EXCEPTION 'Batch 7 baseline mismatch'; END IF;
END
$target$;

DO $registry$
BEGIN
  IF (SELECT kind FROM flsd_batch7_upgrade_review.baseline_kind)='FOUNDATION' THEN
    CREATE TABLE flsd_batch7_upgrade_review."FinancialOperation" (
      id uuid PRIMARY KEY,
      "idempotencyKey" varchar(160) NOT NULL UNIQUE,
      "requestDigest" varchar(64) NOT NULL,
      "operationType" varchar(40) NOT NULL,
      "paymentId" uuid NOT NULL REFERENCES flsd_batch7_upgrade_review."Payment"(id),
      "actorId" uuid NOT NULL,
      "allocatedCash" numeric(18,2) NOT NULL,
      receipt jsonb NOT NULL,
      "createdAt" timestamp(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX ON flsd_batch7_upgrade_review."FinancialOperation" ("paymentId","createdAt");
  END IF;
END
$registry$;

ALTER TABLE flsd_batch7_upgrade_review."Customer" ADD COLUMN batch7_revision bigint NOT NULL DEFAULT 1 CHECK (batch7_revision>0);
ALTER TABLE flsd_batch7_upgrade_review."Payment" ADD COLUMN batch7_revision bigint NOT NULL DEFAULT 1 CHECK (batch7_revision>0);
ALTER TABLE flsd_batch7_upgrade_review."Trip" ADD COLUMN batch7_revision bigint NOT NULL DEFAULT 1 CHECK (batch7_revision>0);
ALTER TABLE flsd_batch7_upgrade_review."OfficialInvoice" ADD COLUMN batch7_revision bigint NOT NULL DEFAULT 1 CHECK (batch7_revision>0);
ALTER TABLE flsd_batch7_upgrade_review."Trip" ADD UNIQUE (id,"customerId");
ALTER TABLE flsd_batch7_upgrade_review."Payment" ADD UNIQUE (id,"customerId");
ALTER TABLE flsd_batch7_upgrade_review."OfficialInvoice" ADD UNIQUE (id,"customerId");
ALTER TABLE flsd_batch7_upgrade_review."FinancialOperation" ADD UNIQUE (id,"paymentId");

CREATE TABLE flsd_batch7_upgrade_review.staff_authorization (
  staff_id uuid PRIMARY KEY REFERENCES flsd_batch7_upgrade_review."StaffUser"(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0)
);
CREATE TABLE flsd_batch7_upgrade_review.staff_session (
  id uuid PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES flsd_batch7_upgrade_review.staff_authorization(staff_id),
  token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest)=32),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>issued_at),
  revoked_at timestamptz CHECK (revoked_at>=issued_at)
);
CREATE TABLE flsd_batch7_upgrade_review.payment_scope (
  payment_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref)<>''),
  UNIQUE (payment_id,customer_id),
  FOREIGN KEY (payment_id,customer_id) REFERENCES flsd_batch7_upgrade_review."Payment"(id,"customerId")
);
CREATE TABLE flsd_batch7_upgrade_review.receivable (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  trip_id uuid NOT NULL UNIQUE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  payable numeric(18,2) NOT NULL CHECK (payable>=0 AND payable<'Infinity'::numeric),
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref)<>''),
  UNIQUE (id,customer_id),
  FOREIGN KEY (trip_id,customer_id) REFERENCES flsd_batch7_upgrade_review."Trip"(id,"customerId")
);
CREATE TABLE flsd_batch7_upgrade_review.invoice_attribution (
  invoice_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  receivable_id uuid NOT NULL,
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref)<>''),
  UNIQUE (invoice_id,customer_id,receivable_id),
  FOREIGN KEY (invoice_id,customer_id) REFERENCES flsd_batch7_upgrade_review."OfficialInvoice"(id,"customerId"),
  FOREIGN KEY (receivable_id,customer_id) REFERENCES flsd_batch7_upgrade_review.receivable(id,customer_id)
);
CREATE TABLE flsd_batch7_upgrade_review.operation_scope (
  operation_id uuid PRIMARY KEY,
  payment_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  receivable_id uuid NOT NULL,
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref)<>''),
  UNIQUE (operation_id,invoice_id,customer_id,receivable_id),
  FOREIGN KEY (operation_id,payment_id) REFERENCES flsd_batch7_upgrade_review."FinancialOperation"(id,"paymentId"),
  FOREIGN KEY (payment_id,customer_id) REFERENCES flsd_batch7_upgrade_review.payment_scope(payment_id,customer_id),
  FOREIGN KEY (invoice_id,customer_id,receivable_id)
    REFERENCES flsd_batch7_upgrade_review.invoice_attribution(invoice_id,customer_id,receivable_id)
);
CREATE TABLE flsd_batch7_upgrade_review.invoice_reservation (
  receivable_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  FOREIGN KEY (operation_id,invoice_id,customer_id,receivable_id)
    REFERENCES flsd_batch7_upgrade_review.operation_scope(operation_id,invoice_id,customer_id,receivable_id)
);

-- Empty evidence tables are intentional. Never infer scope from history or activate posting here.
