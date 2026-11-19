// Current-source business-review packet only. Never changes Owner decisions, source copies or application/database state.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), ts = require('typescript'), {spawnSync} = require('node:child_process');
const root = path.resolve(__dirname, '..'), prior = require.extensions['.ts'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
try {
  if (root !== 'D:\\FLSD-Batch7-Validation' || process.argv.length !== 2) throw new Error('Fixed review workspace/no arguments required');
  const output = path.join(root, 'migration-input', 'review'), input = path.join(root, 'migration-input');
  if (fs.realpathSync(output) !== output || fs.realpathSync(input) !== input) throw new Error('Local input/review directories required');
  const verification = spawnSync(process.execPath, [path.join(__dirname, 'check-billing-mapping-review.cjs')], {encoding: 'utf8', windowsHide: true, timeout: 30000});
  if (verification.status !== 0) throw new Error('Current billing evidence must verify first');
  const progress = JSON.parse(verification.stdout), reads = [];
  const read = name => {
    if (path.basename(name) !== name) throw new Error('Local review filename required');
    const filename = path.join(output, name);
    if (fs.realpathSync(filename) !== filename || fs.statSync(filename).size > 30 * 1024 * 1024) throw new Error('Bounded local report required');
    const bytes = fs.readFileSync(filename); reads.push({filename, sha256: sha(bytes)});
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  };
  const normalized = read('normalized-source.generated.json'), cases = read('six-table-exceptions.generated.json'), billing = read('billing-exception-worklist.json');
  const ownerFacts = read('owner-decisions-2026-11-16.json'), generated = read('billing-mapping-proposals.generated.json');
  const currentDecisions = read(progress.decisionFileName);
  if (normalized.importEnabled !== false || normalized.executionAuthorized !== false || cases.evidenceSha256 !== normalized.worklistSha256 || billing.evidenceSha256 !== progress.evidenceSha256 || generated.decisionFileName !== progress.decisionFileName) throw new Error('Stale source or decision packet');
  const allowed = ['Driver_Tbl.csv', 'Vehicle_Tbl.csv', 'Company_Tbl.csv', 'Trips_Tbl.csv', 'FMS_Trips_Tbl Oct2026.csv', 'FMS_SOA_Tbl.csv', 'FMS_invoice_tbl.csv'];
  if (normalized.files.length !== 7 || new Set(normalized.files.map(f => f.id)).size !== 7 || normalized.files.some(f => !allowed.includes(f.id))) throw new Error('Exact seven-copy source inventory required');
  for (const file of normalized.files) {
    const filename = path.join(input, file.id);
    if (fs.realpathSync(filename) !== filename || sha(fs.readFileSync(filename)) !== file.sha256) throw new Error('Source version changed');
    reads.push({filename, sha256: file.sha256});
  }
  const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
  require.extensions['.ts'] = (module, filename) => {
    const relative = path.relative(lib, fs.realpathSync(filename));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Trusted local library required');
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText, filename);
  };
  const {readAccessBillingSources, assertSourcesUnchanged, archiveGeneratedFile} = require('./lib/access-billing-sources.cjs');
  const {source, inventory} = readAccessBillingSources(root), {parseLegacyDate} = require('../src/lib/migration/trips.ts');
  const {billingMappingReviewProgress} = require('../src/lib/migration/billing-mapping-proposals.ts');
  if (JSON.stringify(billingMappingReviewProgress(generated.packet, currentDecisions).counts) !== JSON.stringify(progress.counts)) throw new Error('Decision progress changed during review');
  const {accessMoney} = require('../src/lib/migration/access-staging.ts');
  const {stageSixTableCsv} = require('../src/lib/migration/six-table-contract.ts');
  const vehicle = stageSixTableCsv('vehicle_tbl', fs.readFileSync(path.join(input, 'Vehicle_Tbl.csv'), 'utf8')).rows.find(r => r.sourceKey === '37')?.payload;
  const sourceDates = cases.cases.filter(c => c.code === 'SERVICE_END_BEFORE_START').map(c => ({tripId: c.source.sourceKey, file: c.source.fileId, logicalRow: c.source.row, caseSha256: c.caseId,
    recordedStart: c.evidence.find(e => e.field === 'DateOfTrip_Start')?.value, recordedEnd: c.evidence.find(e => e.field === 'DateOfTrip_End')?.value,
    status: 'UNRESOLVED_NO_DATE_CORRECTION', guidance: 'Review overnight versus date/time entry error; no automatic next-day rule.'}));
  let overnightReview = null;
  if (fs.existsSync(path.join(output, 'owner-overnight-confirmation.json'))) {
    const owner = read('owner-overnight-confirmation.json'), proposed = read('overnight-corrections.generated.json');
    const ownerSha256 = reads.find(r => r.filename === path.join(output, 'owner-overnight-confirmation.json')).sha256;
    const {evidenceSha256, ...proposalBody} = proposed;
    const {canonicalReviewJson} = require('../src/lib/migration/canonical-review-json.ts');
    const {proposeConfirmedNextDayEnd} = require('../src/lib/migration/confirmed-next-day.ts');
    if (owner.kind !== 'OWNER_CONFIRMED_NEXT_DAY_REVIEW' || owner.scope !== 'EXACT_LISTED_SOURCE_CASES_ONLY' || owner.preserveRecordedEndTime !== true || owner.applyEnabled !== false || owner.cases.length !== 34 ||
      proposed.ownerConfirmationSha256 !== ownerSha256 || sha(canonicalReviewJson(proposalBody)) !== evidenceSha256 || proposed.applyEnabled !== false || proposed.count !== sourceDates.length || proposed.proposals.length !== sourceDates.length) throw new Error('Recorded overnight review is stale or inconsistent');
    for (const item of sourceDates) {
      const confirmed = owner.cases.find(c => c.tripId === item.tripId && c.caseSha256 === item.caseSha256);
      const proposal = proposed.proposals.find(p => p.tripId === item.tripId && p.caseSha256 === item.caseSha256);
      if (!confirmed || !proposal || proposal.proposedEndLocal !== proposeConfirmedNextDayEnd(item.recordedStart, item.recordedEnd).proposedEndLocal) throw new Error('Date case differs from exact Owner confirmation');
      item.status = 'OWNER_CONFIRMED_PENDING_SOURCE_CORRECTION'; item.proposedEndLocal = proposal.proposedEndLocal;
      item.guidance = 'Owner confirmed next-day end date for this exact case; preserve end time. Original source remains unchanged.';
    }
    overnightReview = {status: 'DATE_TREATMENT_CONFIRMED_SOURCE_CORRECTION_PENDING', confirmedTrips: sourceDates.length, ownerConfirmationSha256: ownerSha256, correctionProposalSha256: evidenceSha256, sourceCorrectionApplied: false};
  }
  const billingCases = billing.items.map(item => {
    const invoice = source.invoices.find(r => r.InvoiceNo === item.originalInvoiceReference), start = invoice && parseLegacyDate(invoice.DateOfTrip_Start);
    const soa = source.soas.find(r => r.SOANo === item.sourceSoa), trips = source.trips.filter(r => r.SOANo === item.sourceSoa);
    if (!soa || soa.InvoiceNo !== item.originalInvoiceReference || JSON.stringify(trips.map(t => t.tmpInvoiceNo).sort()) !== JSON.stringify(item.trips.map(t => t.sourceTrip).sort()) ||
      trips.reduce((total, t) => total + accessMoney(t.InvoiceTotAmt), 0n) !== accessMoney(item.amounts.tripGross) ||
      (invoice && accessMoney(invoice.InvoiceTotAmt) !== accessMoney(item.amounts.invoiceGross))) throw new Error('Billing worklist differs from current source membership/amount evidence');
    const beforeWindow = !!start && start.toISOString().slice(0, 10) < normalized.sourceValidation.serviceScope.from;
    return {soaId: item.sourceSoa, invoiceReference: item.originalInvoiceReference, tripIds: item.trips.map(t => t.sourceTrip),
      sourceTripGross: item.amounts.tripGross, sourceInvoiceGross: item.amounts.invoiceGross, recordedDifference: item.amounts.difference ?? null,
      recordedServiceStart: invoice?.DateOfTrip_Start ?? null, recordedServiceEnd: invoice?.DateOfTrip_End ?? null,
      category: beforeWindow ? 'PARTIAL_SERVICE_PERIOD_EVIDENCE' : !invoice ? 'UNASSIGNED_INVOICE_REFERENCE' : item.sourceSoa === '4233' ? 'CANCELLED_INVOICE_RELATIONSHIP' : 'CUSTOMER_OR_MEMBERSHIP_REVIEW',
      reviewQuestion: beforeWindow ? 'The invoice service period begins before this test window. Preserve amounts and partial-period context; full membership remains unverified. No balancing correction or extra August import is required for current development.' : item.reviewQuestion,
      status: 'SOURCE_EVIDENCE_REVIEW_NOT_FINANCIALLY_CLEARED'};
  });
  let customerReview = null;
  if (fs.existsSync(path.join(output, 'owner-customer-cancelled-link-confirmation.json'))) {
    const owner = read('owner-customer-cancelled-link-confirmation.json'), plan = read('six-table-import-plan.generated.json');
    const ownerSha256 = reads.find(r => r.filename === path.join(output, 'owner-customer-cancelled-link-confirmation.json')).sha256;
    if (owner.kind !== 'OWNER_CUSTOMER_AND_CANCELLED_LINK_REVIEW' || owner.version !== 1 || owner.scope !== 'EXACT_TWO_TRIPS_AND_CANCELLED_DOCUMENT_LINK' ||
      owner.applyEnabled !== false || owner.importEnabled !== false || owner.executionAuthorized !== false || owner.sourceChangesApplied !== false ||
      owner.sourcePlanSha256AtReview !== plan.evidenceSha256 || plan.evidenceSha256 !== normalized.sourcePlanSha256 || owner.tripCustomerDecisions.length !== 2) throw new Error('Customer confirmation is stale or inconsistent');
    const expected = [['77740', '34', '68', '4251'], ['77920', '7', '47', '4262']];
    for (const [tripId, original, confirmed, soaId] of expected) {
      const decision = owner.tripCustomerDecisions.find(d => d.tripId === tripId), trip = source.trips.find(t => t.tmpInvoiceNo === tripId);
      const record = plan.records.find(r => r.table === 'Trips_Tbl' && r.sourceKey === tripId);
      const file = normalized.files.find(f => f.id === decision?.sourceFile);
      if (!decision || !trip || !record || decision.originalCompanyId !== original || decision.confirmedCompanyId !== confirmed || decision.preservedSoaId !== soaId ||
        decision.status !== 'OWNER_CONFIRMED_PENDING_SOURCE_CORRECTION' || trip.CompanyID !== original || trip.SOANo !== soaId || !source.customers.some(c => c.CompanyID === confirmed) ||
        !file || file.sha256 !== decision.sourceFileSha256 || record.fileId !== decision.sourceFile || record.row !== decision.logicalRow || record.evidenceSha256 !== decision.sourceEvidenceSha256) throw new Error('Customer correction differs from confirmed source evidence');
    }
    const link = owner.cancelledDocumentDecision, soa = source.soas.find(s => s.SOANo === '4233'), invoice = source.invoices.find(i => i.InvoiceNo === '49501');
    if (!link || link.soaId !== '4233' || link.invoiceId !== '49501' || link.recordedStatus !== 'Cancelled' || link.relationshipConfirmed !== true ||
      link.replacementInvoiceSelected !== null || link.status !== 'OWNER_CONFIRMED_KEEP_CANCELLED_HISTORY' || soa?.InvoiceNo !== '49501' || invoice?.Status !== 'Cancelled') throw new Error('Cancelled history differs from Owner confirmation');
    for (const [table, key, evidence] of [['SOA_Tbl', '4233', link.sourceSoa], ['Invoice_Tbl', '49501', link.sourceInvoice]]) {
      const record = plan.records.find(r => r.table === table && r.sourceKey === key);
      if (!record || !evidence || ['table', 'sourceKey', 'fileId', 'row', 'evidenceSha256'].some(k => record[k] !== evidence[k])) throw new Error('Cancelled document evidence changed');
    }
    customerReview = {ownerConfirmationSha256: ownerSha256, tripCustomerDecisions: owner.tripCustomerDecisions, cancelledDocumentDecision: link, sourceChangesApplied: false};
    const cancelled = billingCases.find(c => c.soaId === '4233');
    cancelled.status = link.status; cancelled.reviewQuestion = 'Owner confirmed SOA 4233 links to cancelled invoice 49501. Retain cancelled history; no replacement selected or financial event created.';
    const membership = billingCases.find(c => c.soaId === '4262');
    membership.status = 'OWNER_CONFIRMED_PENDING_SOURCE_CORRECTION'; membership.reviewQuestion = 'Owner confirmed Trip 77920 belongs to Company 47. Source Company 7 remains unchanged pending correction; amounts and SOA membership retained.';
  }
  const packet = {kind: 'STEP4_RECONCILIATION_REVIEW', version: 1, status: 'REVIEW_REQUIRES_BUSINESS_INPUT', importEnabled: false, executionAuthorized: false, correctionApplyEnabled: false,
    sourcePlanSha256: normalized.sourcePlanSha256, sourceValidationSha256: normalized.sourceValidation.evidenceSha256, sourceCaseWorklistSha256: cases.evidenceSha256,
    billingPacketSha256: progress.evidenceSha256, decisionFileName: progress.decisionFileName, decisionFileSha256: reads.find(r => r.filename === path.join(output, progress.decisionFileName)).sha256,
    counts: {sourceDateCases: sourceDates.length, billingCases: billingCases.length, priorIdentityConfirmations: progress.counts.recordedIdentityConfirmations,
      rejectedIdentityCandidates: progress.counts.rejectedCandidates, acceptedPartialSoaReferences: progress.counts.retainedPartialReferences, ownerConfirmedDateCases: overnightReview?.confirmedTrips ?? 0, sourceDateCorrectionsApplied: 0},
    customerReview, overnightReview, sourceDates, inactiveVehicle: vehicle ? {vehicleId: '37', recordedModel: vehicle.MakeModel, recordedActive: vehicle.Active, recordedPlate: vehicle.PlateNo,
      suppliedTripReferences: source.trips.filter(t => t.VehicleID === '37').length, recommendation: 'Retain inactive/quarantined evidence; no made-up plate and no source deletion.'} : null,
    billingCases, separateTripOwnership: billing.correctionProposal,
    confirmedRulesRetained: {evatMeansVat: ownerFacts.evatMeansVat, vatBasis: ownerFacts.vat.basis, expenseExclusions: ownerFacts.vat.expensesExcluded,
      preserveHistoricalPaidStatus: ownerFacts.historicalInvoiceStatus.preserveSourceValue, fabricateReceipts: false, fabricateAllocations: false,
      absentNewFeatureHistoryNotRequested: ownerFacts.absentLegacyRecords, missingSoaReferencesNeedIndividualApproval: false},
    pendingFinancialFacts: ['Customer VAT classification and inclusive/exclusive basis need explicit applicable-period evidence; zero Evat is not classification.',
      'Historical status reporting remains separate from actual live receivable/collection eligibility; no current balance or cash evidence is fabricated.'],
    unresolvedQuestions: ['Confirm treatment of the 34 reversed trip end times; original dates remain unchanged.', 'Confirm Trip 77740 customer 34 versus invoice customer 68; invoice ownership to 68 is already confirmed.',
      'Confirm Trip 77920 customer 7 versus SOA customer 47; no trip or membership is moved.', 'Confirm original replacement relationship for cancelled invoice 49501; invoice 49500 is not substituted automatically.'].filter(q => q.startsWith('Confirm treatment of the 34') ? !overnightReview : !customerReview)};
  packet.counts.ownerConfirmedTripCustomers = customerReview?.tripCustomerDecisions.length ?? 0;
  packet.counts.confirmedCancelledLinks = customerReview ? 1 : 0;
  packet.counts.sourceCustomerCorrectionsApplied = 0;
  if (customerReview) packet.separateTripOwnership = {originalProposal: billing.correctionProposal, status: 'OWNER_CONFIRMED_PENDING_SOURCE_CORRECTION', tripId: '77740', confirmedCompanyId: '68', preservedSoaId: '4251'};
  const cell = value => String(value ?? '(not supplied)').replace(/[&<>"'`|\[\]\\*_{}\r\n]/g, c => `&#${c.charCodeAt(0)};`);
  const markdown = ['# Step 4 source and business review', '', 'Review only. No corrections, imports, financial approval or database writes.', '',
    '## New source-backed context', '',
    '- Invoice 49458 begins 2026-08-03; invoice 49524 begins 2026-08-29, before the September/October test window. Preserve partial-period context, not a balancing amount. Full membership remains unverified.',
    '- Vehicle37 is inactive in the supplied master and has no supplied-trip references. Keep its blank plate quarantined; no immediate source edit is required for current development.',
    '- SOAs4219,4256,4264 have unassigned invoice references. Preserve that absence; do not create invoices just to fill blanks.', '',
    '## Date/time source cases', '', overnightReview ? 'Owner confirmed next-day end dates for all34exactcases. Proposed values below preserve end times. Source correction is NOT applied.' : 'Date treatment awaits Owner evidence; no next-day rule is assumed.', '',
    '| Trip ID | File / logical row | Original start | Original end | Proposed end local |', '| --- | --- | --- | --- | --- |',
    ...sourceDates.map(c => `| ${cell(c.tripId)} | ${cell(c.file)} / ${c.logicalRow} | ${cell(c.recordedStart)} | ${cell(c.recordedEnd)} | ${cell(c.proposedEndLocal ?? null)} |`), '',
    '## Seven billing source cases', '', '| SOA | Invoice ref | Included trip gross | Recorded invoice gross | Review category | Question |', '| --- | --- | --- | --- | --- | --- |',
    ...billingCases.map(c => `| ${cell(c.soaId)} | ${cell(c.invoiceReference)} | ${cell(c.sourceTripGross)} | ${cell(c.sourceInvoiceGross)} | ${cell(c.category)} | ${cell(c.reviewQuestion)} |`), '',
    '## Separate ownership and financial decisions', '', ...packet.unresolvedQuestions.map(q => '- ' + cell(q)), ...packet.pendingFinancialFacts.map(q => '- ' + cell(q)), '',
    customerReview ? 'Owner confirmed Trip 77740 → Company 68 (source 34), Trip 77920 → Company 47 (source 7), and SOA 4233 → cancelled invoice 49501. Two customer corrections remain unapplied. No replacement invoice selected. Existing identity decisions, including the rejected Company 34 candidate, remain unchanged.' : 'Invoice49523 ownership toCompany68 is confirmed. Trip77740 ownership/membership is separate. No existing Owner decision file was changed.',
    'The49missingSOAs remain accepted partial-export references. No nonexistent historic receipts/refunds/withholding/deposits/custody records are requested.', '',
    `Current billing evidence: ${packet.billingPacketSha256}`, `Current decision file: ${cell(packet.decisionFileName)}`, ''].join('\n');
  assertSourcesUnchanged(root, inventory);
  for (const read of reads) if (sha(fs.readFileSync(read.filename)) !== read.sha256) throw new Error('Input/review changed during packet preparation');
  const reports = [['step4-review.generated.json', JSON.stringify(packet, null, 2) + '\n'], ['step4-review.generated.md', markdown]];
  if (customerReview) {
    const columns = ['tripId', 'originalCompanyId', 'confirmedCompanyId', 'preservedSoaId', 'sourceFile', 'sourceFileSha256', 'logicalRow', 'sourceEvidenceSha256', 'status'];
    reports.push(['customer-corrections.generated.csv', [...[columns.join(',')], ...customerReview.tripCustomerDecisions.map(d => columns.map(k => '"' + String(d[k]).replaceAll('"', '""') + '"').join(','))].join('\r\n') + '\r\n']);
  }
  for (const [name, content] of reports) {
    const filename = path.join(output, name);
    if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error('Local generated report required');
    if (!fs.existsSync(filename) || fs.readFileSync(filename, 'utf8') !== content) {archiveGeneratedFile(filename); fs.writeFileSync(filename, content);}
  }
  console.log(JSON.stringify({kind: packet.kind, status: packet.status, counts: packet.counts, sourceHashesUnchanged: true, ownerDecisionsUnchanged: true, importEnabled: false, executionAuthorized: false}));
} catch {console.error('Step-4 review preparation failed; no source correction, import or database action was performed.'); process.exitCode = 1;}
finally {if (prior) require.extensions['.ts'] = prior; else delete require.extensions['.ts'];}
