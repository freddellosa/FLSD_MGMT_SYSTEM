# Controlled baseline migration

Generate and review the initial SQL from `prisma/schema.prisma` in a fresh EMPTY development database using `prisma migrate dev --name domain_baseline`. Do not apply to live Access or production. Then apply the separate reviewed `202611140002_constraints.sql` using psql on the same development database. Back up before any migration. No migrations were executed in the author's environment.
