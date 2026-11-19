# FLSD Batch 7 QA and deployment handoff

## Current status

**Ready for broader staging QA. Production activation remains pending.** The original independent QA verdict was **PARTIAL**. Subsequent focused checks closed the tested workflow and UI gaps through E9. E10 passed a local HTTPS isolation test and still requires verification on the designated release host. The office receipt confirmation passed a mocked-success browser test and still needs a connected check against the saved receipt. Physical printing is deferred until production deployment at the Owner's direction.

Playwright with Microsoft Edge is the available browser regression setup. A second human or tool-assisted walkthrough can provide independent acceptance evidence. Claude in Chrome is optional for running the regression suite.

## Application scope

FLSD supports trip entry, corporate SOAs and invoicing, collections, receipt allocation and reversals, reports, customer and fleet records, WTS import and rollback, and Form 2307 evidence. The project uses Next.js, TypeScript, Prisma and PostgreSQL. The isolated pilot and standalone office receipt candidate exercise different paths through the shared payment and allocation architecture.

Amounts are handled in integer centavos in domain logic and exact numeric values in storage. A receipt, its allocation, a tax document, cash custody and a remittance represent separate events. Financial corrections preserve history through audited reversals and voids. Form 2307 is evidence only under the current reviewed scope. Accounting approval is required for unresolved withholding, VAT, advances, refunds, revenue recognition and SOA-only cash posting rules.

## QA results and evidence boundaries

| Finding | Latest engineering result | Coverage |
| --- | --- | --- |
| E1 / S1 | Pass | Authenticated Admin attempts to create an Owner returned 403 with and without a password. The user roster remained unchanged. |
| E2 / D1, D2, D3, D6, D10 | Pass in the tested workflows | Edge covered overnight invoice dates, cancellation confirmation and dismissal, draft SOA void and trip release, Manila date reset, outstanding search, counts, Final SOA UI limits and invoice numbering. |
| E2 / WTS | Pass | Fictional workbook preview, exact import, duplicate refusal, audited rollback, reimport with a new ID and rollback refusal after SOA history. |
| E2 / Billing role | Pass | Edge verified Billing permissions, a two-invoice receipt, exact reconciliation, protected Form 2307 evidence and sign-out. |
| E3 / D11, D12 | Pass | On the schema-4 candidate, direct HTTP refused future-dated direct receipts, invoice settlements and customer receipts, plus separate date and time edits on an invoiced trip. Every refusal preserved state and SQL digests. Valid controls saved. |
| E4 | Pass | A real two-tab stale receipt returned 409, wrote nothing and disabled submission until refresh. Draft retention and error clearing were verified. |
| E5 / D7 | Fixed and verified | Duplicate-name and over-allocation errors were linked to their inputs. Invalid submissions returned 400, preserved drafts and wrote nothing. |
| E6 | Fixed and verified | Activity shows Manila time, the recorded user target name and labeled detail fields. Issued invoice numbers and stored audit data were preserved. |
| E7 | Fixed and verified | Voided receipts remain searchable and labeled in history with no payment actions. Trip history includes invoice-linked receipts. Financial totals retain their existing treatment of voids. |
| E8 | Fixed and verified | Form 2307 clears fields and attachment after success. Cancelled or available forms are labeled and excluded from new certificate allocations. |
| E9 | Pilot workflows verified. Office display verified with a mock | Customer removal uses in-app confirmation and preserves referenced records. Evidence labels and trip payment history are distinct. Office confirmation shows the saved payment reference. A new receipt number sequence is outside this change. |
| E10 | Local HTTPS pass. Release verification open | Edge exercised actual pilot and office cookie handlers with in-memory authentication. Sign-in and sign-out were independent by name and path. Changing the port alone did not isolate cookies. The QA cookies omitted Secure and were sent over loopback HTTP. |

The latest application-fix validation passed **1,123 unit tests across 92 files**, **20 standalone checks**, TypeScript, scoped ESLint, an optimized build and focused Edge tests. The subsequent E10 harness and **29 focused automated tests** passed. The complete browser suite has not been rerun against the final combined candidate. Historical connected rehearsal and restore checks are evidence for their individual disposable targets.

Successive isolated runs matched the recovered pilot's 22 table digests and preserved the prior candidate builds. Temporary servers were stopped and their newly created writer logins retired. Disposable evidence is retained separately from production. No financial data from a QA fixture should be migrated into the operational system.

## Before activation

1. **Designate and approve the HTTPS staging host.** Record the app origins and HTTPS routing. Verify the candidate sets and clears appropriately scoped Secure cookies. Test HTTP handling, separate sign-in and sign-out, same-host port behavior and role enforcement with the release configuration.
2. **Verify office receipt confirmation against PostgreSQL.** Use an explicitly approved disposable target and fictional invoices. Compare the visible payment reference against the saved receipt and audit record. Confirm exact allocations, closing receivables and safe behavior on a duplicate or stale submission.
3. **Run staging regression.** Record the release commit, build, target identity, test matrix, results and outstanding issues. Cover role access, trip encoding, SOA states, invoice stock, receipts, reversal, WTS, Form 2307 and protected attachments.
4. **Designate the operational PostgreSQL target and approved legacy snapshot.** Record target host, database, OID and schema, identified by the Owner. Record source timestamp and checksums, row counts, document and sequence boundaries, rejects and attachment coverage. Handle deployment credentials through the approved credential store.
5. **Rehearse migration, reconciliation and recovery.** Compare opening receivables, new charges, payments, allocations and approved adjustments to closing receivables. Verify recoverability, backup schedules, archive integrity, attachment restoration, authorization and observed recovery time. Retain evidence for the release candidate and separately authorized disposable rehearsal.
6. **Record explicit activation approval.** Identify the Owner, accountant, release operator, activation window, go or hold criteria and rollback authority. Define the system-of-record boundary. Hold new posting if identity, reconciliation, authorization or recovery evidence fails.
7. **Check physical printing during production deployment.** Use fictional documents with the intended printer, stationery, paper size and scaling. Record invoice and SOA alignment, margins and page breaks. Physical print acceptance is deferred and remains unverified.

If a problem occurs before posting, preserve the candidate evidence and follow the approved legacy workflow. If a problem occurs after posting, suspend new writes, preserve all post-cutover transactions and reconcile them before any system-of-record change. The Owner and accountant approve how to handle that reconciliation.

## After deployment

Staff can edit permitted operational records through the app. Financial changes use the existing role checks, version checks and audited correction workflows. Application code can continue to change through reviewed development, staging validation and a controlled release. Record the release version and any required migration or rollback steps for every production update.

## Decisions and inputs still needed

| Input | Needed for |
| --- | --- |
| Approved HTTPS staging URL and app origins | Final E10 and connected application acceptance |
| Authorization and target identity for the office receipt confirmation run | Closing the connected E9 check |
| Owner-designated operational database and approved legacy export fingerprint | Migration rehearsal and reconciliation |
| Owner and accountant decisions on unresolved policies and release acceptance | Activation approval |
| Printer and stationery availability during production deployment | Deferred physical print acceptance |

## Evidence index

The following are workspace-relative references. The handoff can be published independently of the private QA workspace.

- Original independent report and checkpoint history are recorded in `artifacts/independent-qa-2026-11-20.md`, `docs/QA_DEFECT_TRACKER.md`, and `docs/SESSION_HANDOFF.md`.
- E1 and E4 evidence is under `artifacts/qa-independent-e1-e4/`. E2 and WTS evidence is under `artifacts/qa-independent-e2/` and `artifacts/qa-independent-wts/`. Billing-role evidence is under `artifacts/qa-independent-billing/`.
- E3 server evidence is in `artifacts/qa-independent-e3/e3-server.json`.
- E5 and E6 fix evidence is in `artifacts/qa-independent-e5-e6-fix/fix-browser.json`. E7 through E9 fix evidence is in `artifacts/qa-independent-e7-e9-fix/fix-browser.json`.
- E10 local HTTPS evidence is in `artifacts/qa-e10-https/e10-https.json`. The proposed cutover sequence is tracked separately in `docs/BATCH7_CUTOVER_PACKAGE.md`.

Repository publication scope for this handoff is documentation. Keep credentials, raw customer records, database files, operational exports and private evidence in their designated controlled storage.
