// Independently verify the newest synthetic artifact set and its local HTML in installed Edge.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const {pathToFileURL} = require('node:url');
const ts = require('typescript');
const {chromium} = require('playwright');
const root = path.resolve(__dirname, '..');
const previousLoader = require.extensions['.ts'];

(async () => {
  let browser;
  try {
    if (root !== 'D:\\FLSD-Batch7-Validation' || process.argv.length !== 3 || process.argv[2] !== '--latest') throw new Error('Use --latest from the validation workspace');
    const workspace = fs.realpathSync(root);
    const within = filename => { const relative = path.relative(workspace, fs.realpathSync(filename)); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Artifact outside validation workspace'); return fs.realpathSync(filename); };
    const parent = within(path.join(root, 'artifacts', 'offline-review-demo'));
    const runs = fs.readdirSync(parent).filter(v => /^\d{4}-\d{2}-\d{2}T[\d-Z]+-[a-f0-9]{6}$/.test(v)).sort();
    if (!runs.length) throw new Error('No synthetic artifacts found');
    const output = within(path.join(parent, runs[runs.length - 1]));
    const inventory = JSON.parse(fs.readFileSync(within(path.join(output, 'inventory.json')), 'utf8'));
    const expectedNames = ['match.json', 'match.html', 'orphan.json', 'orphan.html', 'invalid_money.json', 'invalid_money.html', 'comparison.json'];
    if (inventory.kind !== 'SYNTHETIC_OFFLINE_REVIEW' || inventory.version !== 1 || inventory.importEnabled !== false || inventory.files.length !== expectedNames.length) throw new Error('Unexpected artifact inventory');
    const names = new Set();
    for (const file of inventory.files) {
      if (!expectedNames.includes(file.name) || names.has(file.name)) throw new Error('Unexpected artifact file');
      names.add(file.name);
      const bytes = fs.readFileSync(within(path.join(output, file.name)));
      if (bytes.length !== file.bytes || crypto.createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error('Artifact hash or size mismatch');
    }
    const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
    require.extensions['.ts'] = (module, filename) => {
      const relative = path.relative(lib, fs.realpathSync(filename));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Trusted local library required');
      module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, filename);
    };
    const {assertReviewIntegrity} = require('../src/lib/migration/review-report.ts');
    for (const name of ['match', 'orphan', 'invalid_money']) assertReviewIntegrity(JSON.parse(fs.readFileSync(within(path.join(output, name + '.json')), 'utf8')));
    const comparison = JSON.parse(fs.readFileSync(within(path.join(output, 'comparison.json')), 'utf8'));
    if (comparison.status !== 'MATCH' || comparison.importEnabled !== false || comparison.policyStatus !== 'PENDING') throw new Error('Comparison gate mismatch');
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}});
    const remoteRequests = [], errors = [];
    page.on('request', request => { if (/^https?:/i.test(request.url())) remoteRequests.push(request.url()); });
    page.on('pageerror', error => errors.push(error.message));
    for (const [name, status] of [['match', 'REVIEWED'], ['orphan', 'REVIEW'], ['invalid_money', 'REJECTED']]) {
      await page.goto(pathToFileURL(within(path.join(output, name + '.html'))).href);
      await page.getByRole('heading', {name: 'FLSD offline review', exact: true}).waitFor();
      const statusText = await page.getByRole('region', {name: 'Review status'}).innerText();
      if (!statusText.includes('Structure: ' + status) || !statusText.includes('Policy: PENDING')) throw new Error('HTML status mismatch');
      if (await page.locator('script,iframe,form').count()) throw new Error('Active content in HTML');
      if (name === 'match') {
        const count = await page.getByRole('table', {name: 'Candidate evidence'}).locator('tbody tr').count();
        if (count !== 5) throw new Error('HTML candidate count mismatch');
        await page.screenshot({path: path.join(output, 'match-preview.png'), fullPage: true});
      }
      if (name === 'orphan' && !(await page.locator('body').innerText()).includes('ORPHAN')) throw new Error('Missing relationship diagnostic');
      if (name === 'invalid_money' && !(await page.locator('body').innerText()).includes('Partial totals: accepted candidates only')) throw new Error('Missing partial total label');
    }
    await page.setViewportSize({width: 390, height: 844});
    await page.goto(pathToFileURL(within(path.join(output, 'match.html'))).href);
    if (!await page.getByRole('table', {name: 'Candidate evidence'}).isVisible()) throw new Error('Mobile table missing');
    if (remoteRequests.length || errors.length) throw new Error('HTML made remote requests or encountered browser errors');
    console.log(JSON.stringify({hashesVerified: names.size,reportEnvelopesVerified: 3,desktopReports: 3,mobileReports: 1,remoteRequests: 0,browserErrors: 0,output: path.relative(root, output)}));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Artifact verification failed'); process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    if (previousLoader) require.extensions['.ts'] = previousLoader; else delete require.extensions['.ts'];
  }
})();
