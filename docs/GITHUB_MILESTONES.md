# FLSD milestones

This index records outcomes from the local validation workspace. The public source baseline is the first source checkpoint in GitHub. Historical rows describe accumulated work and evidence. They do not represent reconstructed commits or release tags.

| Milestone | Delivered scope | Verification and limits |
| --- | --- | --- |
| Domain and office foundation | Shared payment and allocation rules, trip encoding, customer and fleet controls, SOA, invoice and collections workflows | Offline rules and isolated browser workflows; financial activation pending |
| Isolated persistence | Authenticated pilot, exact financial projections, operation and audit records, protected evidence | Disposable PostgreSQL and read-only identity checks; protected data stayed outside the pilot |
| Legacy review and migration preparation | Source contracts, mapping and reconciliation tooling, typed review and synthetic rehearsal scripts | Historical records and manual decisions remain controlled; no live import approval |
| Batch 7 receipts and recovery | Multi-invoice payments, exact cash allocation, authorized corrections, protected Form 2307 evidence and backup/restore rehearsals | Isolated office and payments candidates reconciled; connected release acceptance pending |
| Independent QA follow-up | E1 through E9 workflow retests and UI corrections, plus E10 loopback HTTPS isolation | Latest application-fix validation passed 1,123 unit tests, 20 standalone checks, TypeScript, scoped lint, optimized build and focused Edge. E10 release verification, connected office confirmation and deferred physical print remain open |
| Public source baseline | Application source, schemas, review migrations, reusable scripts, tests, build setup and public handoff | Publishing the baseline does not activate posting, designate a database or approve deployment |

## Record each new milestone

1. Create a branch and commit the reviewed source, relevant tests and supporting documentation.
2. Record changed behavior, validation commands and results, remaining issues, and any required approval in the pull request.
3. After review, merge according to the repository's rules and tag the accepted commit with a meaningful milestone name. Mark a GitHub release only for an explicitly approved release.
4. Keep database files, environment files, workstation-specific access scripts, private records, exports, credentials, and raw QA evidence in controlled storage. Summarize sanitized evidence and link to it where the intended reviewers have access.

See the [QA and deployment handoff](RELEASE_QA_HANDOFF.md) for the individual findings and remaining gates.
