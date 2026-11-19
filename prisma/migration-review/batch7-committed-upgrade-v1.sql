-- Reviewed additive DDL for the committed synthetic candidate. Run inside the pinned upgrade transaction only.
ALTER TABLE flsd_batch7_commit_rehearsal."Customer" ADD COLUMN batch7_revision bigint NOT NULL DEFAULT 1 CHECK (batch7_revision>0);
ALTER TABLE flsd_batch7_commit_rehearsal."Payment" ADD COLUMN batch7_revision bigint NOT NULL DEFAULT 1 CHECK (batch7_revision>0);
ALTER TABLE flsd_batch7_commit_rehearsal."Trip" ADD COLUMN batch7_revision bigint NOT NULL DEFAULT 1 CHECK (batch7_revision>0);
ALTER TABLE flsd_batch7_commit_rehearsal."OfficialInvoice" ADD COLUMN batch7_revision bigint NOT NULL DEFAULT 1 CHECK (batch7_revision>0);
ALTER TABLE flsd_batch7_commit_rehearsal."Trip" ADD UNIQUE (id,"customerId");
ALTER TABLE flsd_batch7_commit_rehearsal."Payment" ADD UNIQUE (id,"customerId");
ALTER TABLE flsd_batch7_commit_rehearsal."OfficialInvoice" ADD UNIQUE (id,"customerId");
ALTER TABLE flsd_batch7_commit_rehearsal."FinancialOperation" ADD UNIQUE (id,"paymentId");

CREATE TABLE flsd_batch7_commit_rehearsal.staff_authorization (
  staff_id uuid PRIMARY KEY REFERENCES flsd_batch7_commit_rehearsal."StaffUser"(id),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0)
);
CREATE TABLE flsd_batch7_commit_rehearsal.staff_session (
  id uuid PRIMARY KEY,
  staff_id uuid NOT NULL REFERENCES flsd_batch7_commit_rehearsal.staff_authorization(staff_id),
  token_digest bytea NOT NULL UNIQUE CHECK (octet_length(token_digest)=32),
  issued_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL CHECK (expires_at>issued_at),
  revoked_at timestamptz CHECK (revoked_at>=issued_at)
);
CREATE TABLE flsd_batch7_commit_rehearsal.payment_scope (
  payment_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref)<>''),
  UNIQUE (payment_id,customer_id),
  FOREIGN KEY (payment_id,customer_id) REFERENCES flsd_batch7_commit_rehearsal."Payment"(id,"customerId")
);
CREATE TABLE flsd_batch7_commit_rehearsal.receivable (
  id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  trip_id uuid NOT NULL UNIQUE,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  payable numeric(18,2) NOT NULL CHECK (payable>=0 AND payable<'Infinity'::numeric),
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref)<>''),
  UNIQUE (id,customer_id),
  FOREIGN KEY (trip_id,customer_id) REFERENCES flsd_batch7_commit_rehearsal."Trip"(id,"customerId")
);
CREATE TABLE flsd_batch7_commit_rehearsal.invoice_attribution (
  invoice_id uuid PRIMARY KEY,
  customer_id uuid NOT NULL,
  receivable_id uuid NOT NULL,
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref)<>''),
  UNIQUE (invoice_id,customer_id,receivable_id),
  FOREIGN KEY (invoice_id,customer_id) REFERENCES flsd_batch7_commit_rehearsal."OfficialInvoice"(id,"customerId"),
  FOREIGN KEY (receivable_id,customer_id) REFERENCES flsd_batch7_commit_rehearsal.receivable(id,customer_id)
);
CREATE TABLE flsd_batch7_commit_rehearsal.operation_scope (
  operation_id uuid PRIMARY KEY,
  payment_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  receivable_id uuid NOT NULL,
  evidence_ref text NOT NULL CHECK (btrim(evidence_ref)<>''),
  UNIQUE (operation_id,invoice_id,customer_id,receivable_id),
  FOREIGN KEY (operation_id,payment_id) REFERENCES flsd_batch7_commit_rehearsal."FinancialOperation"(id,"paymentId"),
  FOREIGN KEY (payment_id,customer_id) REFERENCES flsd_batch7_commit_rehearsal.payment_scope(payment_id,customer_id),
  FOREIGN KEY (invoice_id,customer_id,receivable_id)
    REFERENCES flsd_batch7_commit_rehearsal.invoice_attribution(invoice_id,customer_id,receivable_id)
);
CREATE TABLE flsd_batch7_commit_rehearsal.invoice_reservation (
  receivable_id uuid PRIMARY KEY,
  operation_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  FOREIGN KEY (operation_id,invoice_id,customer_id,receivable_id)
    REFERENCES flsd_batch7_commit_rehearsal.operation_scope(operation_id,invoice_id,customer_id,receivable_id)
);

-- Scope is established only by the separate explicit fixture evidence file.
