-- CreateEnum
CREATE TYPE "StaffRole" AS ENUM ('OWNER', 'ADMIN', 'BILLING', 'OPERATIONS', 'VIEWER');

-- CreateEnum
CREATE TYPE "InvoiceState" AS ENUM ('DRAFT', 'PRINT_PENDING', 'PRINTED', 'CANCELLED', 'SPOILED');

-- CreateEnum
CREATE TYPE "SoaState" AS ENUM ('DRAFT', 'ISSUED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentState" AS ENUM ('RECORDED', 'VOIDED');

-- CreateEnum
CREATE TYPE "ImportState" AS ENUM ('VALIDATED', 'APPLIED', 'REJECTED');

-- CreateTable
CREATE TABLE "StaffUser" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "StaffRole" NOT NULL DEFAULT 'VIEWER',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StaffUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Customer" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "tin" TEXT,
    "billingAddress" TEXT,
    "includeInManagementRevenue" BOOLEAN NOT NULL DEFAULT true,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Customer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vehicle" (
    "id" UUID NOT NULL,
    "plateNumber" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Vehicle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Driver" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "employeeCode" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "Driver_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Trip" (
    "id" UUID NOT NULL,
    "legacyTripId" TEXT,
    "tripStart" TIMESTAMP(3) NOT NULL,
    "tripEnd" TIMESTAMP(3),
    "customerId" UUID NOT NULL,
    "vehicleId" UUID,
    "driverId" UUID,
    "passengerName" TEXT,
    "origin" TEXT,
    "destination" TEXT,
    "serviceType" TEXT,
    "tripStatus" TEXT,
    "chargeAmount" DECIMAL(18,2) NOT NULL,
    "vatAmount" DECIMAL(18,2),
    "withholdingAmount" DECIMAL(18,2),
    "legacySoaNumber" TEXT,
    "legacyPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Trip_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StatementOfAccount" (
    "id" UUID NOT NULL,
    "soaNumber" TEXT NOT NULL,
    "customerId" UUID NOT NULL,
    "status" "SoaState" NOT NULL DEFAULT 'DRAFT',
    "issuedAt" TIMESTAMP(3),
    "legacyStatus" TEXT,
    "poNumber" TEXT,
    "department" TEXT,
    "requestor" TEXT,
    "site" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StatementOfAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SoaTrip" (
    "soaId" UUID NOT NULL,
    "tripId" UUID NOT NULL,
    "amountAtBilling" DECIMAL(18,2) NOT NULL,

    CONSTRAINT "SoaTrip_pkey" PRIMARY KEY ("soaId","tripId")
);

-- CreateTable
CREATE TABLE "OfficialInvoice" (
    "id" UUID NOT NULL,
    "soaId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "serialNumber" TEXT,
    "state" "InvoiceState" NOT NULL DEFAULT 'DRAFT',
    "invoiceDate" TIMESTAMP(3),
    "printedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancellationReason" TEXT,
    "replacedInvoiceId" UUID,
    "grossAmount" DECIMAL(18,2) NOT NULL,
    "vatAmount" DECIMAL(18,2) NOT NULL,
    "withholdingAmount" DECIMAL(18,2) NOT NULL DEFAULT 0,
    "legacyInvoiceNumber" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OfficialInvoice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InvoiceSerialBatch" (
    "id" UUID NOT NULL,
    "startSerial" BIGINT NOT NULL,
    "endSerial" BIGINT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "InvoiceSerialBatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Payment" (
    "id" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "reference" TEXT,
    "paymentMethod" TEXT,
    "state" "PaymentState" NOT NULL DEFAULT 'RECORDED',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PaymentAllocation" (
    "paymentId" UUID NOT NULL,
    "invoiceId" UUID NOT NULL,
    "amount" DECIMAL(18,2) NOT NULL,
    "withheldTax" DECIMAL(18,2) NOT NULL DEFAULT 0,

    CONSTRAINT "PaymentAllocation_pkey" PRIMARY KEY ("paymentId","invoiceId")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "actorId" UUID,
    "action" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "before" JSONB,
    "after" JSONB,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ImportBatch" (
    "id" UUID NOT NULL,
    "sourceName" TEXT NOT NULL,
    "sourceSha256" TEXT NOT NULL,
    "status" "ImportState" NOT NULL DEFAULT 'VALIDATED',
    "acceptedRows" INTEGER NOT NULL DEFAULT 0,
    "rejectedRows" INTEGER NOT NULL DEFAULT 0,
    "report" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ImportBatch_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "StaffUser_email_key" ON "StaffUser"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Customer_normalizedName_key" ON "Customer"("normalizedName");

-- CreateIndex
CREATE UNIQUE INDEX "Vehicle_plateNumber_key" ON "Vehicle"("plateNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Driver_employeeCode_key" ON "Driver"("employeeCode");

-- CreateIndex
CREATE UNIQUE INDEX "Trip_legacyTripId_key" ON "Trip"("legacyTripId");

-- CreateIndex
CREATE INDEX "Trip_tripStart_idx" ON "Trip"("tripStart");

-- CreateIndex
CREATE INDEX "Trip_customerId_tripStart_idx" ON "Trip"("customerId", "tripStart");

-- CreateIndex
CREATE UNIQUE INDEX "StatementOfAccount_soaNumber_key" ON "StatementOfAccount"("soaNumber");

-- CreateIndex
CREATE INDEX "SoaTrip_tripId_idx" ON "SoaTrip"("tripId");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialInvoice_serialNumber_key" ON "OfficialInvoice"("serialNumber");

-- CreateIndex
CREATE UNIQUE INDEX "OfficialInvoice_replacedInvoiceId_key" ON "OfficialInvoice"("replacedInvoiceId");

-- CreateIndex
CREATE INDEX "OfficialInvoice_soaId_state_idx" ON "OfficialInvoice"("soaId", "state");

-- CreateIndex
CREATE INDEX "InvoiceSerialBatch_startSerial_endSerial_idx" ON "InvoiceSerialBatch"("startSerial", "endSerial");

-- CreateIndex
CREATE INDEX "AuditEvent_entityType_entityId_createdAt_idx" ON "AuditEvent"("entityType", "entityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ImportBatch_sourceName_sourceSha256_key" ON "ImportBatch"("sourceName", "sourceSha256");

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_vehicleId_fkey" FOREIGN KEY ("vehicleId") REFERENCES "Vehicle"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Trip" ADD CONSTRAINT "Trip_driverId_fkey" FOREIGN KEY ("driverId") REFERENCES "Driver"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StatementOfAccount" ADD CONSTRAINT "StatementOfAccount_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoaTrip" ADD CONSTRAINT "SoaTrip_soaId_fkey" FOREIGN KEY ("soaId") REFERENCES "StatementOfAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SoaTrip" ADD CONSTRAINT "SoaTrip_tripId_fkey" FOREIGN KEY ("tripId") REFERENCES "Trip"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialInvoice" ADD CONSTRAINT "OfficialInvoice_soaId_fkey" FOREIGN KEY ("soaId") REFERENCES "StatementOfAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialInvoice" ADD CONSTRAINT "OfficialInvoice_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfficialInvoice" ADD CONSTRAINT "OfficialInvoice_replacedInvoiceId_fkey" FOREIGN KEY ("replacedInvoiceId") REFERENCES "OfficialInvoice"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Customer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_paymentId_fkey" FOREIGN KEY ("paymentId") REFERENCES "Payment"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaymentAllocation" ADD CONSTRAINT "PaymentAllocation_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "OfficialInvoice"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "StaffUser"("id") ON DELETE SET NULL ON UPDATE CASCADE;

