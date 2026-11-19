-- Receipt-bearing projection of the candidate, layered on the foundation fixture.
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
CREATE TABLE flsd_batch7_upgrade_review."PaymentAllocationEvent" (
  id uuid PRIMARY KEY,
  "operationId" uuid REFERENCES flsd_batch7_upgrade_review."FinancialOperation"(id),
  "paymentId" uuid NOT NULL REFERENCES flsd_batch7_upgrade_review."Payment"(id),
  "invoiceId" uuid NOT NULL REFERENCES flsd_batch7_upgrade_review."OfficialInvoice"(id),
  "cashDelta" numeric(18,2) NOT NULL,
  "withheldTaxDelta" numeric(18,2) NOT NULL DEFAULT 0
);
INSERT INTO flsd_batch7_upgrade_review."FinancialOperation"
  (id,"idempotencyKey","requestDigest","operationType","paymentId","actorId","allocatedCash",receipt)
VALUES ('70000000-0000-4000-8000-000000000007','legacy-unbound',repeat('a',64),'ALLOCATE_PAYMENT',
        '70000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000001',6.00,
        '{"operationId":"70000000-0000-4000-8000-000000000007","allocatedCashCentavos":"600"}');
INSERT INTO flsd_batch7_upgrade_review."PaymentAllocationEvent" (id,"operationId","paymentId","invoiceId","cashDelta")
VALUES ('70000000-0000-4000-8000-000000000008',NULL,
        '70000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000005',4.01);
UPDATE flsd_batch7_upgrade_review.baseline_kind SET kind='RECEIPT_BEARING' WHERE kind='FOUNDATION';
