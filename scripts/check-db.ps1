# Read-only PostgreSQL connectivity check. Prompts for password; does not save it.
$psql = "C:\Program Files\PostgreSQL\18\bin\psql.exe"
if (!(Test-Path $psql)) { throw "psql.exe not found at expected location" }
& $psql -h localhost -p 5432 -U flsd_dev -d flsd_management_dev -c "SELECT current_database(), current_user, version();"
if ($LASTEXITCODE -ne 0) { throw "Database connectivity check failed. Check flsd_dev password and LOGIN privileges." }
