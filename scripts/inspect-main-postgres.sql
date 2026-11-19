-- Run in an already authenticated local SQL client connected to postgres on 127.0.0.1:5432.
-- Read-only metadata inspection. No passwords, server configuration or writes.
BEGIN READ ONLY;
SELECT current_database() AS maintenance_database,current_user AS inspection_role,
       host(inet_server_addr()) AS server_address,inet_server_port() AS server_port,
       current_setting('server_version') AS server_version,
       current_setting('transaction_read_only') AS read_only;
SELECT datname AS proposed_database,pg_get_userbyid(datdba) AS owner
FROM pg_database
WHERE datname IN ('flsd_main_adapter_test','flsd_main_restore_test')
ORDER BY datname;
SELECT rolcreatedb,rolsuper FROM pg_roles WHERE rolname=current_user;
ROLLBACK;
-- If either target row appears: STOP. Do not create/modify either; request different names.
