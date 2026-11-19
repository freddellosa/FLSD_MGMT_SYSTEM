-- Review and apply ONLY after the Prisma baseline migration on the empty dev database.
-- Concurrent SOA numbers use a PostgreSQL sequence, not MAX()+1.
CREATE SEQUENCE IF NOT EXISTS flsd_soa_number_seq START WITH 1 INCREMENT BY 1;
-- Only one active invoice (DRAFT/PRINT_PENDING/PRINTED) per SOA.
CREATE UNIQUE INDEX IF NOT EXISTS flsd_one_active_invoice_per_soa
ON "OfficialInvoice" ("soaId") WHERE state IN ('DRAFT','PRINT_PENDING','PRINTED');
-- One trip may be attached to at most one SOA, including cancelled history.
-- This conservative constraint avoids accidental rebilling; cancellation release requires explicit audited design.
CREATE UNIQUE INDEX IF NOT EXISTS flsd_one_soa_per_trip ON "SoaTrip" ("tripId");
ALTER TABLE "Trip" ADD CONSTRAINT flsd_trip_nonnegative_charge CHECK ("chargeAmount" >= 0);
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT flsd_allocation_nonnegative CHECK (amount >= 0 AND "withheldTax" >= 0);
