-- Run only against the isolated pilot with flsd_pilot_reader.
-- No financial changes. Keep any displayed customer data private.
\set ON_ERROR_STOP on
BEGIN READ ONLY;

SELECT current_database() AS database_name, current_user AS database_user,
       current_setting('transaction_read_only') AS read_only;

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
ORDER BY table_name;

SELECT id, name, tin, address, active
FROM public.pilot_customers
WHERE archived = false
ORDER BY name
LIMIT 100;

SELECT id, customer_id, service_date, workflow, amount
FROM public.pilot_trips
WHERE archived = false
ORDER BY service_date DESC, id
LIMIT 100;

COMMIT;
