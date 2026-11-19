// Private file-only visual review. No app/API/database/remote requests or dependency downloads.
const fs = require('node:fs'), path = require('node:path'), {pathToFileURL} = require('node:url'), {chromium} = require('playwright');
(async () => {
  let browser;
  try {
    const root = path.resolve(__dirname, '..');
    if (root !== 'D:\\FLSD-Batch7-Validation' || process.argv.length !== 2) throw new Error('Fixed validation workspace/no arguments required');
    const output = path.join(root, 'migration-input', 'review');
    if (fs.realpathSync(output) !== output) throw new Error('Local review directory required');
    const report = JSON.parse(fs.readFileSync(path.join(output, 'normalized-source.generated.json'), 'utf8'));
    const worklist = JSON.parse(fs.readFileSync(path.join(output, 'six-table-exceptions.generated.json'), 'utf8'));
    const plan = JSON.parse(fs.readFileSync(path.join(output, 'six-table-import-plan.generated.json'), 'utf8'));
    if (report.importEnabled !== false || report.executionAuthorized !== false || report.status !== 'SOURCE_SHAPE_CHECKED_DESTINATION_UNBOUND' ||
      worklist.evidenceSha256 !== report.worklistSha256 || plan.evidenceSha256 !== report.sourcePlanSha256) throw new Error('Matching disabled review artifacts required');
    const htmlPath = path.join(output, 'normalized-source.generated.html');
    if (fs.lstatSync(htmlPath).isSymbolicLink()) throw new Error('Local report required');
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), errors = [], remote = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {if (/^https?:/i.test(request.url())) remote.push(request.url());});
    await page.goto(pathToFileURL(htmlPath).href);
    await page.getByRole('heading', {name: 'Historical source review', exact: true}).waitFor();
    const rows = await page.getByRole('table', {name: 'Source exception worklist', exact: true}).locator('tbody tr').count();
    const files = await page.getByRole('table', {name: 'Source file inventory', exact: true}).locator('tbody tr').count();
    if (rows !== report.counts.sourceCases || files !== report.files.length) throw new Error('Displayed row/file counts differ');
    const text = await page.getByRole('region', {name: 'Review totals', exact: true}).innerText();
    for (const count of [report.counts.normalizedRows, report.counts.sourceCases, report.counts.policyHeldRows, report.counts.destinationUnboundRows]) if (!text.includes(String(count))) throw new Error('Summary count missing');
    const cases = await page.getByRole('table', {name: 'Source exception worklist', exact: true}).innerText();
    if (worklist.cases.some(c => !cases.includes(c.source.sourceKey))) throw new Error('Source record ID missing');
    if (await page.locator('script,form,iframe,img,link,[onerror],[onload],[onclick]').count()) throw new Error('Active content found');
    await page.screenshot({path: path.join(output, 'normalized-source.desktop.png')});
    await page.getByRole('link', {name: 'Open review holds', exact: true}).click();
    const referenceSummary = page.getByText(plan.retainedMissingSoaKeys.length + ' missing SOA keys retained as partial-export references', {exact: true});
    await referenceSummary.click();
    if (!await page.getByText('Accepted reference-only context; no placeholder parents or individual approvals are created.', {exact: true}).isVisible()) throw new Error('Reference context unavailable');
    await page.setViewportSize({width: 390, height: 844});
    await page.evaluate(() => window.scrollTo(0, 0));
    if (await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) throw new Error('Mobile page overflows');
    await page.screenshot({path: path.join(output, 'normalized-source.mobile.png')});
    if (errors.length || remote.length) throw new Error('Browser errors or remote requests');
    console.log(JSON.stringify({sourceCases: rows, files, desktopAndMobile: true, pageErrors: errors.length, remoteRequests: remote.length, activeContent: 0, importEnabled: false, executionAuthorized: false}));
  } catch {console.error('Private source-review preview check failed; no import or database action occurred.'); process.exitCode = 1;}
  finally {await browser?.close();}
})();
