-- Apply after the pinned foundation in the dedicated rehearsal schema.
CREATE TABLE flsd_batch7_upgrade_review.baseline_kind (
  kind text PRIMARY KEY CHECK (kind IN ('FOUNDATION','RECEIPT_BEARING'))
);
INSERT INTO flsd_batch7_upgrade_review.baseline_kind VALUES ('FOUNDATION');
INSERT INTO flsd_batch7_upgrade_review."StaffUser" (id,email,"displayName","passwordHash",role,"updatedAt")
VALUES ('70000000-0000-4000-8000-000000000001','batch7@example.invalid','Synthetic Billing','DISABLED','BILLING','2026-01-02 00:00:00');
INSERT INTO flsd_batch7_upgrade_review."Customer" (id,name,"normalizedName","updatedAt")
VALUES ('70000000-0000-4000-8000-000000000002','Synthetic customer','synthetic customer','2026-01-02 00:00:00');
INSERT INTO flsd_batch7_upgrade_review."Trip" (id,"customerId","tripStart","tripStatus","chargeAmount","updatedAt")
VALUES ('70000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000002','2026-01-01','COMPLETED',70.00,'2026-01-02 00:00:00');
INSERT INTO flsd_batch7_upgrade_review."StatementOfAccount" (id,"customerId","soaNumber","updatedAt")
VALUES ('70000000-0000-4000-8000-000000000004','70000000-0000-4000-8000-000000000002','BATCH7-SYNTHETIC','2026-01-02 00:00:00');
INSERT INTO flsd_batch7_upgrade_review."SoaTrip" ("soaId","tripId","amountAtBilling")
VALUES ('70000000-0000-4000-8000-000000000004','70000000-0000-4000-8000-000000000003',70.00);
INSERT INTO flsd_batch7_upgrade_review."OfficialInvoice" (id,"customerId","soaId",state,"grossAmount","vatAmount","updatedAt")
VALUES ('70000000-0000-4000-8000-000000000005','70000000-0000-4000-8000-000000000002',
        '70000000-0000-4000-8000-000000000004','PRINTED',70.00,0.00,'2026-01-02 00:00:00');
INSERT INTO flsd_batch7_upgrade_review."Payment" (id,"customerId","receivedAt",amount)
VALUES ('70000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000002','2026-01-02',100.01);
INSERT INTO flsd_batch7_upgrade_review."PaymentAllocation" ("paymentId","invoiceId",amount)
VALUES ('70000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000005',10.01);
