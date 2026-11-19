// Actual supplied-copy browser check. File selections stay in browser memory; no API writes.
const fs = require('node:fs'), path = require('node:path');
const {chromium} = require('playwright');
(async () => {
  let browser;
  try {
    const root = path.resolve(__dirname, '..'); if (root !== 'D:\\FLSD-Batch7-Validation') throw new Error('Validation workspace required');
    browser = await chromium.launch({channel: 'msedge', headless: true});
    const page = await browser.newPage({viewport: {width: 1440, height: 1000}, acceptDownloads: true}), errors = [], api = [];
    page.on('pageerror', e => errors.push(e.message));
    page.on('request', r => { if (new URL(r.url()).pathname.startsWith('/api/')) api.push(r.url()); });
    await page.goto('http://127.0.0.1:3002/import-preflight');
    await page.getByLabel('Choose an exported Trips CSV file').setInputFiles(path.join(root, 'migration-input', 'FMS_Trips_Tbl Oct2026.csv'));
    for (const [kind, filename] of [['customer', 'Company_Tbl.csv'], ['vehicle', 'Vehicle_Tbl.csv'], ['driver', 'Driver_Tbl.csv']]) {
      await page.getByLabel('Optional ' + kind + ' CSV export', {exact: true}).setInputFiles(path.join(root, 'migration-input', filename));
      await page.getByLabel(kind + ' export ID column').waitFor();
    }
    await page.getByLabel('Review annual monthly fixed-rate billing').check();
    await page.getByLabel('Monthly customer source ID').fill('59');
    await page.getByLabel('Monthly billing period').fill('2026-10');
    await page.getByLabel('Monthly fixed-rate Trip ID').fill('78390');
    const summary = page.getByRole('region', {name: 'Monthly charge summary'});
    await summary.waitFor();
    const text = await summary.innerText();
    if (!text.includes('105521.07') || !text.includes('24 usage trips; 11 zero-charge operational records')) throw new Error('Actual monthly source summary mismatch');
    const pending = page.waitForEvent('download'); await page.getByRole('button', {name: 'Download preflight report', exact: true}).click();
    const download = await pending;
    const destination = path.join(root, 'migration-input', 'review', 'browser-monthly-preflight.json'); await download.saveAs(destination);
    const result = JSON.parse(fs.readFileSync(destination, 'utf8'));
    if (result.report.importEnabled !== false || result.report.counts.REJECTED !== 0 || result.report.counts.VALIDATED !== 210 || result.monthlyBilling[0].fixedChargeCounted !== 1) throw new Error('Actual source preflight outcomes mismatch');
    await page.setViewportSize({width: 390, height: 844});
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Monthly preflight mobile overflow');
    if (api.length || errors.length) throw new Error('Monthly source review made API calls or raised browser errors');
    console.log(JSON.stringify({actualSourceTrips: result.report.rows.length, monthlyUsageRows: result.monthlyBilling[0].usageRows.length, zeroUsageRows: 11, fixedChargeCounted: 1, rejected: 0, apiRequests: 0, browserErrors: 0, mobile: true}));
  } catch (error) { console.error(error instanceof Error ? error.message : 'Monthly source UI failed'); process.exitCode = 1; }
  finally { if (browser) await browser.close(); }
})();
