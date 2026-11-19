// Offline proposals from explicit, previously fingerprinted CSV copies. No execution adapter.
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
  const {canonicalReviewJson} = require('../src/lib/migration/review-report.ts');
  const {buildBillingMappingProposals, initialBillingMappingDecisions, validateBillingMappingDecisions} = require('../src/lib/migration/billing-mapping-proposals.ts');
  const {renderBillingMappingHtml} = require('../src/lib/migration/billing-mapping-html.ts');
  const {readAccessBillingSources, assertSourcesUnchanged, archiveGeneratedFile} = require('./lib/access-billing-sources.cjs');
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const input = path.join(root, 'migration-input'), output = path.join(input, 'review');
  const scopePath = path.join(output, 'billing-scope-review.json'), scopeBytes = fs.readFileSync(scopePath), scope = JSON.parse(scopeBytes.toString('utf8'));
  if (scope.importEnabled !== false || scope.review?.kind !== 'LEGACY_BILLING_SCOPE_REVIEW') throw new Error('Expected prior disabled scope review');
  const {source, inventory, tripReview} = readAccessBillingSources(root);
  if (tripReview.status !== 'VALIDATED') throw new Error('Trip partition preflight requires review');
  const normalize = rows => rows.map(f => ({fileName: f.fileName, sha256: f.sha256, rows: f.rows})).sort((a, b) => a.fileName < b.fileName ? -1 : a.fileName > b.fileName ? 1 : 0);
  if (canonicalReviewJson(normalize(inventory)) !== canonicalReviewJson(normalize(scope.provenance.sourceFiles))) throw new Error('Source differs from reviewed scope evidence');
  const fingerprints = [{kind: 'trips', sha256: tripReview.aggregateSha256, rows: source.trips.length, partitions: tripReview.partitions},
    ...inventory.filter(f => f.kind !== 'trips').map(f => ({kind: f.kind, sha256: f.sha256, rows: f.rows}))];
  const packet = buildBillingMappingProposals({...source, from: scope.review.from, through: scope.review.through}, fingerprints);
  if (packet.scopeReviewSha256 !== sha(canonicalReviewJson(scope.review))) throw new Error('Scope review no longer matches source/rules');
  const baseDecisionPath = path.join(output, 'billing-mapping-decisions.json');
  const baseBytes = fs.existsSync(baseDecisionPath) ? fs.readFileSync(baseDecisionPath) : null;
  let decisionFileName = 'billing-mapping-decisions.json';
  if (baseBytes) {
    try { validateBillingMappingDecisions(packet, JSON.parse(baseBytes.toString('utf8'))); }
    catch { decisionFileName = 'billing-mapping-decisions.' + packet.evidenceSha256.slice(0, 16) + '.json'; }
  }
  const decisionPath = path.join(output, decisionFileName);
  const existingBytes = fs.existsSync(decisionPath) ? fs.readFileSync(decisionPath) : null;
  let decisionState = 'Created entirely pending', decisionSummary, reviewedDecisions;
  if (!existingBytes) {
    const decisions = initialBillingMappingDecisions(packet);
    fs.writeFileSync(decisionPath, JSON.stringify(decisions, null, 2), {flag: 'wx'});
    decisionSummary = validateBillingMappingDecisions(packet, decisions);
    reviewedDecisions = decisions;
  } else {
    decisionState = 'Existing review edits preserved';
    try { const decisions = JSON.parse(existingBytes.toString('utf8')); decisionSummary = validateBillingMappingDecisions(packet, decisions); reviewedDecisions = decisions; }
    catch { decisionState = 'Existing file preserved; stale or invalid review entries need attention'; decisionSummary = {importEnabled: false, executionAuthorized: false, validation: 'REVIEW_REQUIRED'}; }
  }
  if (typeof decisionSummary.pending === 'number') decisionState += ': ' + decisionSummary.pending + ' pending, ' + decisionSummary.recordedIdentityConfirmations + ' recorded identity confirmations; execution disabled';
  assertSourcesUnchanged(root, inventory);
  if (!fs.readFileSync(scopePath).equals(scopeBytes)) throw new Error('Scope evidence changed during proposal generation');
  if (existingBytes && !fs.readFileSync(decisionPath).equals(existingBytes)) throw new Error('Existing review decisions changed unexpectedly');
  if (baseBytes && !fs.readFileSync(baseDecisionPath).equals(baseBytes)) throw new Error('Previous revision decisions changed unexpectedly');
  const generatedPath = path.join(output, 'billing-mapping-proposals.generated.json');
  if (fs.existsSync(generatedPath) && JSON.parse(fs.readFileSync(generatedPath, 'utf8')).packet.evidenceSha256 !== packet.evidenceSha256) {
    archiveGeneratedFile(generatedPath); archiveGeneratedFile(path.join(output, 'billing-mapping-review.html'));
  }
  fs.writeFileSync(generatedPath, JSON.stringify({packet, decisionState, decisionFileName, decisionSummary, generatedAt: new Date().toISOString()}, null, 2));
  fs.writeFileSync(path.join(output, 'billing-mapping-review.html'), renderBillingMappingHtml(packet, decisionState, decisionFileName, reviewedDecisions));
  console.log(JSON.stringify({importEnabled: false, executionAuthorized: false, counts: packet.counts, missingMonths: packet.monthsWithoutSuppliedTrips,
    decisionState, decisionFileName, decisionSummary, sourceHashesUnchanged: inventory.length}));
} catch (error) { console.error(error instanceof Error ? error.message : 'Mapping review generation failed'); process.exitCode = 1; }
finally { if (priorLoader) require.extensions['.ts'] = priorLoader; else delete require.extensions['.ts']; }
