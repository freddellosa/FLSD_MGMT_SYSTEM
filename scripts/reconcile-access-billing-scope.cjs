// Read-only service-period reconciliation of explicitly supplied exported copies.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), priorLoader = require.extensions['.ts'];
try {
  if (root !== 'D:\\FLSD-Batch7-Validation') throw new Error('Validation workspace required');
  const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
  require.extensions['.ts'] = (module, filename) => {
    const relative = path.relative(lib, fs.realpathSync(filename));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Trusted local library required');
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, filename);
  };
  const {scopeLegacyBilling, triageBillingDiagnostics} = require('../src/lib/migration/legacy-billing-scope.ts');
  const {renderLegacyBillingHtml} = require('../src/lib/migration/legacy-billing-html.ts');
  const {canonicalReviewJson} = require('../src/lib/migration/review-report.ts');
  const {readAccessBillingSources, assertSourcesUnchanged, archiveGeneratedFile} = require('./lib/access-billing-sources.cjs');
  const input = path.join(root, 'migration-input'), out = path.join(input, 'review');
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const previousPath = path.join(out, 'billing-source-review.json'), previousBytes = fs.readFileSync(previousPath);
  const previous = JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(previousBytes));
  if (previous.kind !== 'ACCESS_BILLING_SOURCE_REVIEW' || previous.version !== 1 || previous.importEnabled !== false || !Array.isArray(previous.exceptions)) throw new Error('Expected prior offline billing evidence');
  const {source, inventory, tripReview, ownerReviewFacts} = readAccessBillingSources(root);
  for (const file of inventory) {
    const old = previous.inventory.find(f => f.fileName === file.fileName);
    if (old && old.sha256 !== file.sha256) throw new Error('Source changed since prior billing review; refresh that evidence first');
  }
  assertSourcesUnchanged(root, inventory);
  fs.writeFileSync(path.join(out, 'trip-partition-preflight.json'), JSON.stringify({importEnabled: false, status: tripReview.status,
    aggregateSha256: tripReview.aggregateSha256, partitions: tripReview.partitions, issues: tripReview.issues}, null, 2));
  if (tripReview.status !== 'VALIDATED') throw new Error('Trip partitions require review; current scope reports were preserved');
  const review = scopeLegacyBilling({...source, from: '2026-09-01', through: '2026-10-31'});
  const diagnostics = triageBillingDiagnostics(review, previous.exceptions);
  const issueCounts = Object.fromEntries([...new Set(review.groups.flatMap(g => g.issues))].sort().map(code => [code, review.groups.filter(g => g.issues.includes(code)).length]));
  const report = {review, diagnostics, provenance: {sourceFiles: inventory, tripPartitions: tripReview.partitions, ownerReviewFacts, priorBillingReportSha256: sha(previousBytes)},
    createdAt: new Date().toISOString(), importEnabled: false};
  assertSourcesUnchanged(root, inventory);
  if (sha(fs.readFileSync(previousPath)) !== report.provenance.priorBillingReportSha256) throw new Error('Prior evidence changed during review');
  const currentPath = path.join(out, 'billing-scope-review.json');
  if (fs.existsSync(currentPath)) {
    const oldReport = JSON.parse(fs.readFileSync(currentPath, 'utf8'));
    if (canonicalReviewJson(oldReport.review) !== canonicalReviewJson(review) || canonicalReviewJson(oldReport.provenance.sourceFiles) !== canonicalReviewJson(inventory)) {
      archiveGeneratedFile(currentPath); archiveGeneratedFile(path.join(out, 'billing-scope-review.html'));
    }
  }
  fs.writeFileSync(currentPath, JSON.stringify(report, null, 2));
  fs.writeFileSync(path.join(out, 'billing-scope-review.html'), renderLegacyBillingHtml(review, diagnostics));
  console.log(JSON.stringify({importEnabled: false, sourceHashesUnchanged: inventory.length, coverage: review.coverage, counts: review.counts,
    priorDiagnosticScope: diagnostics.counts, issueCounts,
    grossComparisons: {matchingGroups: review.groups.filter(g => g.monetaryEvidence.comparison === 'MATCH').length, differingGroups: review.groups.filter(g => g.monetaryEvidence.comparison === 'DIFFERENT').length},
    referencedPaidGroups: review.groups.filter(g => g.referencedInvoice?.status.payment === 'PAID_AS_RECORDED').length,
    supportingPaidInvoiceRows: review.groups.reduce((n, g) => n + g.invoices.filter(i => i.status.payment === 'PAID_AS_RECORDED').length, 0),
    structurallyConsistentGroups: review.groups.filter(g => g.status === 'EVIDENCE_CONSISTENT').length, receiptsCreated: 0, allocationsCreated: 0}));
} catch (error) { console.error(error instanceof Error ? error.message : 'Offline billing scope review failed'); process.exitCode = 1; }
finally { if (priorLoader) require.extensions['.ts'] = priorLoader; else delete require.extensions['.ts']; }
