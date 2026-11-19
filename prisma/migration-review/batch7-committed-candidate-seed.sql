-- Synthetic candidate seed only.
INSERT INTO flsd_batch7_commit_rehearsal."StaffUser" (id,email,"displayName","passwordHash",role,"updatedAt")
VALUES ('70000000-0000-4000-8000-000000000001','batch7@example.invalid','Synthetic Billing','DISABLED','BILLING','2026-01-02 00:00:00');
INSERT INTO flsd_batch7_commit_rehearsal."Customer" (id,name,"normalizedName","updatedAt")
VALUES ('70000000-0000-4000-8000-000000000002','Synthetic customer','synthetic customer','2026-01-02 00:00:00');
INSERT INTO flsd_batch7_commit_rehearsal."Trip" (id,"customerId","tripStart","tripStatus","chargeAmount","updatedAt")
VALUES ('70000000-0000-4000-8000-000000000003','70000000-0000-4000-8000-000000000002','2026-01-01','COMPLETED',70.00,'2026-01-02 00:00:00');
INSERT INTO flsd_batch7_commit_rehearsal."StatementOfAccount" (id,"customerId","soaNumber","updatedAt")
VALUES ('70000000-0000-4000-8000-000000000004','70000000-0000-4000-8000-000000000002','BATCH7-SYNTHETIC','2026-01-02 00:00:00');
INSERT INTO flsd_batch7_commit_rehearsal."SoaTrip" ("soaId","tripId","amountAtBilling")
VALUES ('70000000-0000-4000-8000-000000000004','70000000-0000-4000-8000-000000000003',70.00);
INSERT INTO flsd_batch7_commit_rehearsal."OfficialInvoice" (id,"customerId","soaId",state,"grossAmount","vatAmount","updatedAt")
VALUES ('70000000-0000-4000-8000-000000000005','70000000-0000-4000-8000-000000000002',
        '70000000-0000-4000-8000-000000000004','PRINTED',70.00,0.00,'2026-01-02 00:00:00');
INSERT INTO flsd_batch7_commit_rehearsal."Payment" (id,"customerId","receivedAt",amount)
VALUES ('70000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000002','2026-01-02',100.01);
INSERT INTO flsd_batch7_commit_rehearsal."PaymentAllocation" ("paymentId","invoiceId",amount)
VALUES ('70000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000005',10.01);

INSERT INTO flsd_batch7_commit_rehearsal."FinancialOperation"
  (id,"idempotencyKey","requestDigest","operationType","paymentId","actorId","allocatedCash",receipt)
VALUES
 ('70000000-0000-4000-8000-000000000007','candidate-bound',
  encode(sha256(convert_to('{"operationType":"ALLOCATE_PAYMENT","actorId":"70000000-0000-4000-8000-000000000001","actorRole":"BILLING","reason":"Synthetic canonical allocation","paymentId":"70000000-0000-4000-8000-000000000006","customerId":"70000000-0000-4000-8000-000000000002","allocations":[["70000000-0000-4000-8000-000000000005","600","0"]]}','UTF8')),'hex'),
  'ALLOCATE_PAYMENT','70000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000001',6.00,
  '{"operationId":"70000000-0000-4000-8000-000000000007","allocatedCashCentavos":"600"}'),
 ('70000000-0000-4000-8000-000000000008','candidate-unbound',repeat('a',64),'ALLOCATE_PAYMENT',
  '70000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000001',4.01,
  '{"operationId":"70000000-0000-4000-8000-000000000008","allocatedCashCentavos":"401"}');

INSERT INTO flsd_batch7_commit_rehearsal."PaymentAllocationEvent"
  (id,"operationId","paymentId","invoiceId","cashDelta",action,reason,"actorId")
VALUES
 ('70000000-0000-4000-8000-000000000009','70000000-0000-4000-8000-000000000007',
  '70000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000005',6.00,
  'ALLOCATE','Synthetic canonical allocation','70000000-0000-4000-8000-000000000001'),
 ('70000000-0000-4000-8000-000000000010',NULL,
  '70000000-0000-4000-8000-000000000006','70000000-0000-4000-8000-000000000005',4.01,
  'ALLOCATE','Synthetic legacy event','70000000-0000-4000-8000-000000000001');

INSERT INTO flsd_batch7_commit_rehearsal."PaymentRefund" (id,"paymentId",amount,state,reason,"createdById","completedAt")
VALUES
 ('70000000-0000-4000-8000-000000000011','70000000-0000-4000-8000-000000000006',25.00,'PENDING',
  'Synthetic refund reservation','70000000-0000-4000-8000-000000000001',NULL),
 ('70000000-0000-4000-8000-000000000012','70000000-0000-4000-8000-000000000006',5.00,'COMPLETED',
  'Synthetic completed refund','70000000-0000-4000-8000-000000000001','2026-01-03 00:00:00');

INSERT INTO flsd_batch7_commit_rehearsal."AuditEvent" (id,"actorId",action,"entityType","entityId",reason,after)
VALUES ('70000000-0000-4000-8000-000000000013','70000000-0000-4000-8000-000000000001',
  'PAYMENT_ALLOCATION_CONFIRMED','Payment','70000000-0000-4000-8000-000000000006',
  'Synthetic canonical allocation','{"operationId":"70000000-0000-4000-8000-000000000007","allocatedCashCentavos":"600"}');
