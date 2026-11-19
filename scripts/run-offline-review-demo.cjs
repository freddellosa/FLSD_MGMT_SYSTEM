// Synthetic-only artifact runner. No source-data path, database or network options.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ts = require('typescript');
const root = path.resolve(__dirname, '..');
const previousLoader = require.extensions['.ts'];

try {
  if (root !== 'D:\\FLSD-Batch7-Validation') throw new Error('Validation workspace required');
  if (process.argv.length !== 3 || process.argv[2] !== '--synthetic') throw new Error('Use --synthetic; real-data inputs are not supported');
  const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
  const isWithin = (parent, child) => { const relative = path.relative(parent, child); return !relative.startsWith('..') && !path.isAbsolute(relative); };
  require.extensions['.ts'] = (module, filename) => {
    if (!isWithin(lib, fs.realpathSync(filename))) throw new Error('Trusted local library required');
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, filename);
  };
  const {syntheticReviewRequest} = require('../src/lib/migration/synthetic-review.ts');
  const {buildReviewReport, sealReviewReport, canonicalReviewJson, assertReviewIntegrity} = require('../src/lib/migration/review-report.ts');
  const {renderReviewHtml} = require('../src/lib/migration/review-html.ts');
  const {buildComparisonReport} = require('../src/lib/migration/comparison-report.ts');
  const artifacts = [];
  for (const scenario of ['MATCH', 'ORPHAN', 'INVALID_MONEY']) {
    const envelope = sealReviewReport(buildReviewReport(syntheticReviewRequest(scenario)));
    assertReviewIntegrity(envelope);
    artifacts.push({name: scenario.toLowerCase() + '.json', content: canonicalReviewJson(envelope)});
    artifacts.push({name: scenario.toLowerCase() + '.html', content: renderReviewHtml(envelope)});
  }
  const comparison = buildComparisonReport(syntheticReviewRequest(), syntheticReviewRequest());
  if (comparison.status !== 'MATCH' || comparison.importEnabled !== false) throw new Error('Synthetic comparison failed');
  artifacts.push({name: 'comparison.json', content: canonicalReviewJson(comparison)});
  // Verify every existing parent resolves inside the workspace before creating a child.
  const workspace = fs.realpathSync(root);
  let output = workspace;
  for (const segment of ['artifacts', 'offline-review-demo', new Date().toISOString().replace(/[:.]/g, '-') + '-' + crypto.randomBytes(3).toString('hex')]) {
    if (!isWithin(workspace, fs.realpathSync(output))) throw new Error('Artifact parent outside validation workspace');
    const next = path.join(output, segment);
    if (fs.existsSync(next)) {
      if (!isWithin(workspace, fs.realpathSync(next))) throw new Error('Artifact path outside validation workspace');
    } else fs.mkdirSync(next);
    output = fs.realpathSync(next);
  }
  const inventory = [];
  for (const artifact of artifacts) {
    const filename = path.join(output, artifact.name);
    fs.writeFileSync(filename, artifact.content, {encoding: 'utf8', flag: 'wx'});
    const bytes = fs.readFileSync(filename);
    if (!bytes.equals(Buffer.from(artifact.content, 'utf8'))) throw new Error('Artifact round-trip mismatch');
    inventory.push({name: artifact.name, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')});
  }
  fs.writeFileSync(path.join(output, 'inventory.json'), JSON.stringify({kind: 'SYNTHETIC_OFFLINE_REVIEW', version: 1, importEnabled: false, files: inventory}, null, 2), {flag: 'wx'});
  console.log(JSON.stringify({syntheticOnly: true, importEnabled: false, output: path.relative(root, output), artifacts: inventory.length + 1, comparison: comparison.status}));
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Synthetic offline review failed');
  process.exitCode = 1;
} finally {
  if (previousLoader) require.extensions['.ts'] = previousLoader;
  else delete require.extensions['.ts'];
}
