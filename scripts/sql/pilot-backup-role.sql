-- Nonproduction pilot provisioning review. Run only on the verified isolated pilot cluster.
\set ON_ERROR_STOP on
BEGIN;
SET LOCAL search_path=pg_catalog;
SELECT pg_advisory_xact_lock(55437,8042);
DO $guard$ BEGIN
 IF current_user<>'flsd_pilot_admin' OR session_user<>current_user OR current_database()<>'flsd_pilot_validation'
   OR inet_server_addr() IS DISTINCT FROM '127.0.0.1'::inet OR inet_server_port() IS DISTINCT FROM 55437
   OR pg_is_in_recovery() OR current_setting('server_version_num')::int/10000<>18
   OR NOT EXISTS(SELECT 1 FROM public.pilot_meta WHERE id=1 AND marker='FLSD_ISOLATED_PILOT_ONLY' AND schema_version=3)
   OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname='flsd_pilot_backup')
 THEN RAISE EXCEPTION 'Pilot backup provisioning identity or role mismatch'; END IF;
END $guard$;
CREATE ROLE flsd_pilot_backup NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 2;
COMMENT ON ROLE flsd_pilot_backup IS 'FLSD_PILOT_BACKUP_ONLY';
ALTER ROLE flsd_pilot_backup IN DATABASE flsd_pilot_validation SET default_transaction_read_only=on;
GRANT CONNECT ON DATABASE flsd_pilot_validation TO flsd_pilot_backup;
GRANT USAGE ON SCHEMA public TO flsd_pilot_backup;
GRANT SELECT ON TABLE public.pilot_allocations,public.pilot_attachments,public.pilot_audit,public.pilot_customer_formats,
 public.pilot_customers,public.pilot_document_trips,public.pilot_documents,public.pilot_drivers,public.pilot_import_batches,
 public.pilot_invoice_formats,public.pilot_login_attempts,public.pilot_meta,public.pilot_operations,public.pilot_receipts,
 public.pilot_refunds,public.pilot_remittances,public.pilot_sessions,public.pilot_settings,public.pilot_trips,public.pilot_users,
 public.pilot_vehicles,public.pilot_workspace TO flsd_pilot_backup;
COMMIT;
-- Capture these nonsecret OIDs before separately configuring authentication.
SELECT current_database() AS database, (SELECT oid FROM pg_database WHERE datname=current_database()) AS database_oid,
 oid AS backup_role_oid FROM pg_roles WHERE rolname='flsd_pilot_backup';
