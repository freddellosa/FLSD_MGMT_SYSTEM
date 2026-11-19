-- PR-1 REVIEW ONLY. Not a migration or authority-switch approval. Never applied by current tooling.
BEGIN;
DO $$ BEGIN RAISE EXCEPTION 'REVIEW_ONLY: schema, financial integration and disposable rehearsal approval required'; END $$;
CREATE SCHEMA flsd_core_review;
CREATE TABLE flsd_core_review.repository_meta (
  id INTEGER PRIMARY KEY CHECK(id=1), schema_version TEXT NOT NULL CHECK(schema_version='PR-1'),
  marker TEXT NOT NULL CHECK(marker='FLSD_REVIEW_ONLY'), revision BIGINT NOT NULL CHECK(revision>=0)
);
INSERT INTO flsd_core_review.repository_meta VALUES(1,'PR-1','FLSD_REVIEW_ONLY',0);
CREATE TABLE flsd_core_review.drivers (
  id TEXT PRIMARY KEY, version BIGINT NOT NULL CHECK(version>0), business_number TEXT UNIQUE, legacy_business_number TEXT, visibility TEXT NOT NULL DEFAULT 'REVIEW_HOLD' CHECK(visibility='REVIEW_HOLD'),
  display_name TEXT,
  last_name TEXT,
  first_name TEXT,
  middle_name TEXT,
  hire_date DATE,
  active BOOLEAN
);
CREATE TABLE flsd_core_review.vehicles (
  id TEXT PRIMARY KEY, version BIGINT NOT NULL CHECK(version>0), business_number TEXT UNIQUE, legacy_business_number TEXT, visibility TEXT NOT NULL DEFAULT 'REVIEW_HOLD' CHECK(visibility='REVIEW_HOLD'),
  make_model TEXT,
  vehicle_type TEXT,
  plate_number TEXT,
  color TEXT,
  seat_count INTEGER CHECK(seat_count>=0),
  active BOOLEAN,
  fuel_type TEXT
);
CREATE TABLE flsd_core_review.customers (
  id TEXT PRIMARY KEY, version BIGINT NOT NULL CHECK(version>0), business_number TEXT UNIQUE, legacy_business_number TEXT, visibility TEXT NOT NULL DEFAULT 'REVIEW_HOLD' CHECK(visibility='REVIEW_HOLD'),
  registered_name TEXT,
  billing_address TEXT,
  tin TEXT,
  business_style TEXT,
  requires_requestor BOOLEAN,
  requires_po BOOLEAN,
  active BOOLEAN, vat_classification TEXT
);
CREATE TABLE flsd_core_review.trips (
  id TEXT PRIMARY KEY, version BIGINT NOT NULL CHECK(version>0), business_number TEXT UNIQUE, legacy_business_number TEXT, visibility TEXT NOT NULL DEFAULT 'REVIEW_HOLD' CHECK(visibility='REVIEW_HOLD'),
  service_start_local TIMESTAMP WITHOUT TIME ZONE,
  service_end_local TIMESTAMP WITHOUT TIME ZONE,
  service_type TEXT,
  passenger_name TEXT,
  department TEXT,
  reserved_by TEXT,
  destination TEXT,
  charge_location TEXT,
  remarks TEXT,
  customer_id TEXT REFERENCES flsd_core_review.customers(id), vehicle_id TEXT REFERENCES flsd_core_review.vehicles(id), driver_id TEXT REFERENCES flsd_core_review.drivers(id), legacy_soa_reference TEXT, workflow TEXT
);
CREATE TABLE flsd_core_review.trip_charges (
  id TEXT PRIMARY KEY REFERENCES flsd_core_review.trips(id) ON DELETE RESTRICT,
  recorded_vat NUMERIC(18,2) CHECK(recorded_vat>=0),
  fuel_amount NUMERIC(18,2) CHECK(fuel_amount>=0),
  toll_amount NUMERIC(18,2) CHECK(toll_amount>=0),
  parking_amount NUMERIC(18,2) CHECK(parking_amount>=0),
  meal_amount NUMERIC(18,2) CHECK(meal_amount>=0),
  lodging_amount NUMERIC(18,2) CHECK(lodging_amount>=0),
  agreed_gross NUMERIC(18,2) CHECK(agreed_gross>=0),
  base_amount NUMERIC(18,2) CHECK(base_amount>=0),
  ot_amount NUMERIC(18,2) CHECK(ot_amount>=0)
);
CREATE TABLE flsd_core_review.statements_of_account (
  id TEXT PRIMARY KEY, version BIGINT NOT NULL CHECK(version>0), business_number TEXT UNIQUE, legacy_business_number TEXT, visibility TEXT NOT NULL DEFAULT 'REVIEW_HOLD' CHECK(visibility='REVIEW_HOLD'),
  created_date_local TIMESTAMP WITHOUT TIME ZONE,
  original_customer_name TEXT,
  original_customer_address TEXT,
  original_customer_tin TEXT,
  po_number TEXT,
  source_status TEXT,
  approved_date_local TIMESTAMP WITHOUT TIME ZONE,
  received_date_local TIMESTAMP WITHOUT TIME ZONE,
  department TEXT,
  requestor TEXT,
  site TEXT,
  customer_id TEXT REFERENCES flsd_core_review.customers(id), lifecycle_state TEXT, legacy_invoice_reference TEXT
);
CREATE TABLE flsd_core_review.invoices (
  id TEXT PRIMARY KEY, version BIGINT NOT NULL CHECK(version>0), business_number TEXT UNIQUE, legacy_business_number TEXT, visibility TEXT NOT NULL DEFAULT 'REVIEW_HOLD' CHECK(visibility='REVIEW_HOLD'),
  source_invoice_date_local TIMESTAMP WITHOUT TIME ZONE,
  original_customer_name TEXT,
  recorded_vat NUMERIC(18,2) CHECK(recorded_vat>=0),
  recorded_gross NUMERIC(18,2) CHECK(recorded_gross>=0),
  source_status TEXT,
  customer_id TEXT REFERENCES flsd_core_review.customers(id), soa_id TEXT REFERENCES flsd_core_review.statements_of_account(id), lifecycle_state TEXT, current_serial_number TEXT, replacement_invoice_id TEXT REFERENCES flsd_core_review.invoices(id)
);
-- No receipts, allocations, refunds, custody balances or second financial ledger are created here.
-- Shared Batch 7 financial schema/repository integration remains subject to PA-1 review before any operational cutover.
CREATE TABLE flsd_core_review.import_batches (
  id TEXT PRIMARY KEY, source_namespace TEXT NOT NULL, manifest_sha256 CHAR(64) NOT NULL,
  source_snapshot_sha256 CHAR(64) NOT NULL, mapping_sha256 CHAR(64) NOT NULL,
  expected_rows BIGINT NOT NULL CHECK(expected_rows>0), chunk_size INTEGER NOT NULL CHECK(chunk_size BETWEEN 1 AND 100),
  state TEXT NOT NULL CHECK(state IN ('LOADING','RECONCILING')),
  UNIQUE(source_namespace,manifest_sha256)
);
CREATE TABLE flsd_core_review.import_file_versions (
  source_namespace TEXT NOT NULL, source_kind TEXT NOT NULL, file_sha256 CHAR(64) NOT NULL,
  filename TEXT NOT NULL, row_count BIGINT NOT NULL CHECK(row_count>=0),
  PRIMARY KEY(source_namespace,source_kind,file_sha256)
);
CREATE TABLE flsd_core_review.import_source_rows (
  source_namespace TEXT NOT NULL, source_kind TEXT NOT NULL, file_sha256 CHAR(64) NOT NULL,
  logical_row BIGINT NOT NULL CHECK(logical_row>=2), source_key TEXT NOT NULL, evidence_sha256 CHAR(64) NOT NULL,
  payload JSONB NOT NULL CHECK(jsonb_typeof(payload)='object' AND NOT (payload ?| ARRAY['SSSNo','SSS_Rate'])),
  PRIMARY KEY(source_namespace,source_kind,file_sha256,logical_row),
  FOREIGN KEY(source_namespace,source_kind,file_sha256) REFERENCES flsd_core_review.import_file_versions(source_namespace,source_kind,file_sha256)
);
CREATE TABLE flsd_core_review.legacy_entity_mappings (
  source_namespace TEXT NOT NULL, source_kind TEXT NOT NULL, source_key TEXT NOT NULL,
  source_evidence_sha256 CHAR(64) NOT NULL, mapping_sha256 CHAR(64) NOT NULL,
  driver_id TEXT UNIQUE REFERENCES flsd_core_review.drivers(id), vehicle_id TEXT UNIQUE REFERENCES flsd_core_review.vehicles(id),
  customer_id TEXT UNIQUE REFERENCES flsd_core_review.customers(id), trip_id TEXT UNIQUE REFERENCES flsd_core_review.trips(id),
  soa_id TEXT UNIQUE REFERENCES flsd_core_review.statements_of_account(id), invoice_id TEXT UNIQUE REFERENCES flsd_core_review.invoices(id),
  PRIMARY KEY(source_namespace,source_kind,source_key),
  CHECK(num_nonnulls(driver_id,vehicle_id,customer_id,trip_id,soa_id,invoice_id)=1),
  CHECK((source_kind='Driver_tbl' AND driver_id IS NOT NULL) OR (source_kind='vehicle_tbl' AND vehicle_id IS NOT NULL) OR
    (source_kind='company_tbl' AND customer_id IS NOT NULL) OR (source_kind='Trips_Tbl' AND trip_id IS NOT NULL) OR
    (source_kind='SOA_Tbl' AND soa_id IS NOT NULL) OR (source_kind='Invoice_Tbl' AND invoice_id IS NOT NULL))
);
-- Requires the reviewed shared Batch 7 actor authority. No separate user or customer-payment ledger.
CREATE TABLE flsd_core_review.import_operations (
  operation_id TEXT PRIMARY KEY, actor_id UUID NOT NULL REFERENCES public."StaffUser"(id),
  request_digest CHAR(64) NOT NULL, batch_id TEXT REFERENCES flsd_core_review.import_batches(id),
  chunk_index INTEGER CHECK(chunk_index>=0), result JSONB NOT NULL, committed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(batch_id,chunk_index)
);
CREATE TABLE flsd_core_review.import_audit (
  operation_id TEXT PRIMARY KEY REFERENCES flsd_core_review.import_operations(operation_id),
  actor_id UUID NOT NULL REFERENCES public."StaffUser"(id), action TEXT NOT NULL, subjects JSONB NOT NULL
);
CREATE TABLE flsd_core_review.entity_revisions (
  id TEXT PRIMARY KEY, version BIGINT NOT NULL CHECK(version>0), operation_id TEXT NOT NULL REFERENCES flsd_core_review.import_operations(operation_id) DEFERRABLE INITIALLY DEFERRED,
  driver_id TEXT REFERENCES flsd_core_review.drivers(id), vehicle_id TEXT REFERENCES flsd_core_review.vehicles(id),
  customer_id TEXT REFERENCES flsd_core_review.customers(id), trip_id TEXT REFERENCES flsd_core_review.trips(id),
  soa_id TEXT REFERENCES flsd_core_review.statements_of_account(id), invoice_id TEXT REFERENCES flsd_core_review.invoices(id),
  snapshot JSONB NOT NULL CHECK(jsonb_typeof(snapshot)='object'),
  CHECK(num_nonnulls(driver_id,vehicle_id,customer_id,trip_id,soa_id,invoice_id)=1)
);
CREATE UNIQUE INDEX history_driver_version ON flsd_core_review.entity_revisions(driver_id,version) WHERE driver_id IS NOT NULL;
CREATE UNIQUE INDEX history_vehicle_version ON flsd_core_review.entity_revisions(vehicle_id,version) WHERE vehicle_id IS NOT NULL;
CREATE UNIQUE INDEX history_customer_version ON flsd_core_review.entity_revisions(customer_id,version) WHERE customer_id IS NOT NULL;
CREATE UNIQUE INDEX history_trip_version ON flsd_core_review.entity_revisions(trip_id,version) WHERE trip_id IS NOT NULL;
CREATE UNIQUE INDEX history_soa_version ON flsd_core_review.entity_revisions(soa_id,version) WHERE soa_id IS NOT NULL;
CREATE UNIQUE INDEX history_invoice_version ON flsd_core_review.entity_revisions(invoice_id,version) WHERE invoice_id IS NOT NULL;
CREATE TABLE flsd_core_review.soa_trip_memberships (
  soa_id TEXT NOT NULL REFERENCES flsd_core_review.statements_of_account(id), trip_id TEXT NOT NULL REFERENCES flsd_core_review.trips(id),
  membership_revision BIGINT NOT NULL CHECK(membership_revision>0), amount_at_billing NUMERIC(18,2) CHECK(amount_at_billing>=0),
  current_membership BOOLEAN NOT NULL, PRIMARY KEY(soa_id,trip_id,membership_revision)
);
CREATE UNIQUE INDEX one_current_soa_per_trip ON flsd_core_review.soa_trip_memberships(trip_id) WHERE current_membership;
CREATE TABLE flsd_core_review.business_number_counters (
  kind TEXT PRIMARY KEY CHECK(kind IN ('TRIP','DRIVER','VEHICLE','COMPANY','SOA')),
  next_value BIGINT CHECK(next_value>0), revision BIGINT NOT NULL CHECK(revision>=0)
);
CREATE INDEX trips_customer_service ON flsd_core_review.trips(customer_id,service_start_local,id);
-- Runtime roles, immutable-history grants, all shared financial FKs/enforcement and the single authority cutover remain review gates.
-- There is deliberately no ACTIVE state, activation SQL, financial posting path or automatic pilot migration registration.
COMMIT;
