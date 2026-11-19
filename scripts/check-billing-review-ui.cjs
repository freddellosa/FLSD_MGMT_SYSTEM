// Inspect only explicitly selected private review copies inside the loopback browser page.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {chromium} = require('playwright');
(async () => {
  let browser;
  try {
    const root = path.resolve(__dirname, '..');
    if (root !== 'D:\\FLSD-Batch7-Validation' || process.argv.length !== 2) throw new Error('Validation workspace, no arguments required');
    const output = path.join(root, 'migration-input', 'review');
    const packetPath = path.join(output, 'billing-mapping-proposals.generated.json');
    const generated = JSON.parse(fs.readFileSync(packetPath, 'utf8'));
    if (!/^billing-mapping-decisions(?:\.[a-f0-9]{16})?\.json$/.test(generated.decisionFileName)) throw new Error('Invalid decision filename');
    const decisionsPath = path.join(output, generated.decisionFileName);
    const decisions = JSON.parse(fs.readFileSync(decisionsPath, 'utf8'));
    const hash = filename => crypto.createHash('sha256').update(fs.readFileSync(filename)).digest('hex');
    const before = [hash(packetPath), hash(decisionsPath)];
    const count = value => decisions.items.filter(d => d.decision === value).length;
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [], api = [], remote = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => {const url = new URL(r.url()); if (url.pathname.startsWith('/api/')) api.push(r.url()); if (/^https?:$/.test(url.protocol) && url.origin !== 'http://127.0.0.1:3002') remote.push(r.url());});
    await page.goto('http://127.0.0.1:3002/billing-review');
    await page.getByLabel('Generated billing review packet').setInputFiles(packetPath);
    await page.getByLabel('Recorded billing decisions').setInputFiles(decisionsPath);
    await page.getByRole('button', {name: 'Review selected files'}).click();
    const summary = page.getByRole('region', {name: 'Billing decision summary'});
    await summary.waitFor();
    if (!(await summary.innerText()).includes(count('PENDING') + ' pending; ' + count('CONFIRM_CANDIDATE_IDENTITY') + ' identity confirmations; ' + count('REJECT_CANDIDATE') + ' rejected candidates')) throw new Error('Actual review count mismatch');
    const table = page.getByRole('table', {name: 'Billing review cases'});
    const outstanding = count('PENDING') + count('KEEP_UNRESOLVED') + count('REJECT_CANDIDATE');
    if (await table.locator('tbody tr').count() !== outstanding) throw new Error('Outstanding row count mismatch');
    await page.getByLabel('Search evidence').fill('49523');
    if (await table.locator('tbody tr').count() !== 1 || !(await table.innerText()).includes('CompanyID 68')) throw new Error('Explicit invoice ownership missing');
    await page.getByLabel('Search evidence').fill('');
    await page.getByLabel('Show cases').selectOption('confirmed');
    if (await table.locator('tbody tr').count() !== count('CONFIRM_CANDIDATE_IDENTITY')) throw new Error('Confirmed row count mismatch');
    await page.getByLabel('Show cases').selectOption('references');
    if (await table.locator('tbody tr').count() !== generated.packet.counts.retainedPartialReferences) throw new Error('Reference-only row count mismatch');
    await page.getByLabel('Show cases').selectOption('outstanding');
    await page.screenshot({path: path.join(output, 'billing-review-browser.png')});
    await page.setViewportSize({width: 390, height: 844});
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Mobile page overflow');
    await page.getByRole('button', {name: 'Clear review files'}).click();
    if (await summary.count()) throw new Error('Private view not cleared');
    if (errors.length || api.length || remote.length || hash(packetPath) !== before[0] || hash(decisionsPath) !== before[1]) throw new Error('Unexpected request, error or source mutation');
    console.log(JSON.stringify({outstanding, confirmations: count('CONFIRM_CANDIDATE_IDENTITY'), rejected: count('REJECT_CANDIDATE'), partialReferences: generated.packet.counts.retainedPartialReferences, desktop: true, mobile: true, cleared: true, apiRequests: 0, remoteRequests: 0, browserErrors: 0, inputFilesUnchanged: true}));
  } catch {console.error('Local billing review UI verification failed; private source contents omitted.'); process.exitCode = 1;}
  finally {if (browser) await browser.close();}
})();
