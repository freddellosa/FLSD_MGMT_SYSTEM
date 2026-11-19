/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS CLI installs a bounded local TypeScript loader. */
// Read-only current-source/current-decision verification. No report regeneration or execution adapter.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), priorLoader = require.extensions['.ts'];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
try {
  if (process.argv.length !== 2) throw new Error('Usage: node scripts/check-billing-mapping-review.cjs (no arguments)');
  if (root !== 'D:\\FLSD-Batch7-Validation') throw new Error('Validation workspace required');
  const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
  require.extensions['.ts'] = (module, filename) => {
    const relative = path.relative(lib, fs.realpathSync(filename));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Trusted local library required');
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, filename);
  };
  const {canonicalReviewJson} = require('../src/lib/migration/review-report.ts');
  const {buildBillingMappingProposals, billingMappingReviewProgress} = require('../src/lib/migration/billing-mapping-proposals.ts');
  const {readAccessBillingSources, assertSourcesUnchanged} = require('./lib/access-billing-sources.cjs');
  const output = fs.realpathSync(path.join(root, 'migration-input', 'review')), reads = [];
  const read = filename => {
    // Decision filenames come from a review artifact, never from a user-provided path.
    if (path.basename(filename) !== filename) throw new Error('Local review filename required');
    const target = fs.realpathSync(path.join(output, filename));
    if (path.dirname(target) !== output) throw new Error('Review file must remain in the review directory');
    const bytes = fs.readFileSync(target);
    if (bytes.length > 30 * 1024 * 1024) throw new Error('Review artifact exceeds offline bound');
    reads.push({target, sha256: sha(bytes)});
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
  };
  const generated = read('billing-mapping-proposals.generated.json'), scope = read('billing-scope-review.json');
  if (scope.importEnabled !== false || scope.review?.kind !== 'LEGACY_BILLING_SCOPE_REVIEW') throw new Error('Expected disabled scope review');
  if (typeof generated.decisionFileName !== 'string' || !/^billing-mapping-decisions(?:\.[a-f0-9]{16})?\.json$/.test(generated.decisionFileName)) throw new Error('Invalid current decision filename');
  const {source, inventory, tripReview, ownerReviewFacts} = readAccessBillingSources(root);
  if (tripReview.status !== 'VALIDATED') throw new Error('Trip partition preflight requires review');
  const fingerprints = [{kind: 'trips', sha256: tripReview.aggregateSha256, rows: source.trips.length, partitions: tripReview.partitions},
    ...inventory.filter(f => f.kind !== 'trips').map(f => ({kind: f.kind, sha256: f.sha256, rows: f.rows}))];
  const packet = buildBillingMappingProposals({...source, from: scope.review.from, through: scope.review.through}, fingerprints);
  if (packet.scopeReviewSha256 !== sha(canonicalReviewJson(scope.review)) || canonicalReviewJson(generated.packet) !== canonicalReviewJson(packet)) throw new Error('Generated review is stale against current source/rules; refresh the scope and proposal reports first');
  const progress = billingMappingReviewProgress(packet, read(generated.decisionFileName));
  assertSourcesUnchanged(root, inventory);
  for (const f of ownerReviewFacts) if (sha(fs.readFileSync(path.join(output, f.fileName))) !== f.sha256) throw new Error('Owner evidence changed during verification');
  for (const f of reads) if (sha(fs.readFileSync(f.target)) !== f.sha256) throw new Error('Review file changed during verification');
  console.log(JSON.stringify({...progress, decisionFileName: generated.decisionFileName, sourceFilesVerified: inventory.length,
    note: 'Current review evidence only. Pending=0 does not clear source, customer-contract, database or release gates.'}, null, 2));
} catch {
  // Malformed local JSON must never echo source lines or personal fields into logs.
  console.error('Billing review verification failed. Check command usage, current source/report evidence and decision entries; no files were changed.');
  process.exitCode = 1;
} finally { if (priorLoader) require.extensions['.ts'] = priorLoader; else delete require.extensions['.ts']; }
