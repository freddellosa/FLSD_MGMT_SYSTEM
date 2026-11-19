# FLSD Management System

Source baseline for the FLSD transport and invoicing application. It covers trips, corporate statements of account, invoices, collections, receipt allocations and reversals, WTS import, and Form 2307 evidence. Built with Next.js, TypeScript, Prisma and PostgreSQL.

## Local setup

Use Node.js 24 and the installed package manager. The root demonstration runs with fictional, in-memory data. Begin with the offline checks before configuring any database.

```powershell
npm ci
npm run db:generate
npx --no-install prisma generate --schema prisma/schema.ISOLATED.prisma
npm test
node --test offline-integration.test.cjs scripts/invoicing-postgres-backup.test.cjs
npm run typecheck
npm run build
npm run dev
```

Open http://127.0.0.1:3000 for the demonstration. Client generation creates local files under dependencies and `generated/`. Keep the generated files out of commits. The reviewed SQL and QA scripts require a separately approved, correctly identified disposable environment. Review the applicable script and deployment gate before running database-connected commands.

## Project status

- [QA and deployment handoff](docs/RELEASE_QA_HANDOFF.md)
- [Milestones and publication process](docs/GITHUB_MILESTONES.md)

This source baseline supports staging QA. Production activation requires separate approval of the HTTPS configuration, database target, reconciliation and rollback plan. The repository contains code and synthetic test fixtures. Runtime configuration, database copies, private QA evidence and operational exports belong in controlled storage.
