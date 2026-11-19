-- Foundation controls that the Prisma candidate does not express.
-- Apply only after the candidate baseline under the guarded synthetic search path.
CREATE UNIQUE INDEX one_active_invoice_per_soa
ON flsd_batch7_commit_rehearsal."OfficialInvoice" ("soaId")
WHERE state IN ('DRAFT','PRINT_PENDING','PRINTED');
ALTER TABLE flsd_batch7_commit_rehearsal."InvoiceSerialBatch"
  ADD CONSTRAINT valid_serial_range CHECK ("startSerial">0 AND "endSerial">="startSerial");
CREATE SEQUENCE flsd_batch7_commit_rehearsal.flsd_soa_number_seq START WITH 1 INCREMENT BY 1;
