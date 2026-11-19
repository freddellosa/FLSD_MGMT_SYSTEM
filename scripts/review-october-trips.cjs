// Selected-check preflight of the newly supplied October copy against existing exported masters.
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
  const {parseCsv} = require('../src/lib/migration/csv.ts'), {stageAccessTrips, accessMoney} = require('../src/lib/migration/access-staging.ts');
  const input = path.join(root, 'migration-input'), data = {}, inventory = [];
  const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  for (const [kind, fileName] of [['trips', 'FMS_Trips_Tbl Oct2026.csv'], ['customer', 'Company_Tbl.csv'], ['vehicle', 'Vehicle_Tbl.csv'], ['driver', 'Driver_Tbl.csv']]) {
    const bytes = fs.readFileSync(path.join(input, fileName)); if (bytes.length > 30 * 1024 * 1024) throw new Error('Export exceeds offline review bound');
    data[kind] = parseCsv(new TextDecoder('utf-8', {fatal: true}).decode(bytes), {strictQuotes: true});
    inventory.push({kind, fileName, sha256: sha(bytes), rows: data[kind].length});
  }
  const references = {customer: {idColumn: 'CompanyID', rows: data.customer}, vehicle: {idColumn: 'VehicleID', rows: data.vehicle}, driver: {idColumn: 'DriverID', rows: data.driver}};
  const {reviewMonthlyBilling} = require('../src/lib/migration/monthly-billing.ts');
  const factsPath = path.join(input, 'review', 'owner-monthly-billing-confirmation.json');
  const factsBytes = fs.existsSync(factsPath) ? fs.readFileSync(factsPath) : null;
  const facts = factsBytes ? JSON.parse(factsBytes.toString('utf8')) : null;
  if (facts && (facts.kind !== 'OWNER_MONTHLY_BILLING_REVIEW' || facts.importEnabled !== false || facts.sourceSha256 !== inventory.find(f => f.kind === 'trips').sha256)) throw new Error('Monthly source confirmation is stale');
  const monthlyBilling = reviewMonthlyBilling(data.trips, facts?.definitions ?? []);
  const report = stageAccessTrips({trips: data.trips, minYear: 2026, columns: {id: 'tmpInvoiceNo', startDate: 'DateOfTrip_Start', agreedCharge: 'InvoiceTotAmt',
    customer: 'CompanyID', vehicle: 'VehicleID', driver: 'DriverID', vat: 'Evat'}, references, monthlyUsageEvidence: monthlyBilling.flatMap(c => c.usageEvidence)});
  const rejectedTripEvidence = report.rows.filter(r => r.status === 'REJECTED').map(r => ({sourceTrip: r.sourceId, row: r.row,
    sourceStatus: data.trips[r.row - 2].Status, sourceGross: data.trips[r.row - 2].InvoiceTotAmt, errors: r.errors}));
  const zeroGrossRejectedRows = rejectedTripEvidence.filter(r => { try { return accessMoney(r.sourceGross) === 0n; } catch { return false; } }).length;
  const monthlyZeroUsageRows = report.rows.filter(r => r.billingRole === 'MONTHLY_USAGE' && r.agreedCentavos === 0n).length;
  for (const f of inventory) if (sha(fs.readFileSync(path.join(input, f.fileName))) !== f.sha256) throw new Error('Source changed during October preflight');
  fs.writeFileSync(path.join(input, 'review', 'october-trip-preflight.json'), JSON.stringify({kind: 'OCTOBER_TRIP_SELECTED_CHECKS', version: 1,
    importEnabled: false, inventory, report, rejectedTripEvidence, zeroGrossRejectedRows, monthlyZeroUsageRows, monthlyBilling, notes: ['Evat is recorded VAT; agreed gross is retained, not taxed twice.', 'Blank/absent legacy withholding does not create a withholding transaction.', 'Owner-confirmed monthly usage is operational history; its fixed charge is counted only on the designated customer/month row.', 'Selected checks do not approve historical contract tax treatment, schedules or import.']}, (_, value) => typeof value === 'bigint' ? value.toString() : value, 2));
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
  const referenceSummary = report.relationshipChecks.every(r => r.matched === report.rows.length)
    ? 'All ' + report.rows.length + ' customer, vehicle and driver references matched supplied masters.' : 'Reference mismatches remain in row diagnostics.';
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>October trip source checks</title><style>body{font:14px/1.5 system-ui,sans-serif;margin:24px;color:#18243b;background:#f5f7fb}main{max-width:1300px;margin:auto}section{background:white;padding:18px;margin:16px 0;border:1px solid #d5dce8;border-radius:8px}.scroll{overflow:auto}table{border-collapse:collapse;width:100%}td,th{padding:8px;text-align:left;vertical-align:top;border-bottom:1px solid #d5dce8;overflow-wrap:anywhere}th{background:#edf2f8}.notice{font-weight:650;color:#714600}</style></head><body><main><h1>October trip source checks</h1><p class="notice">Read-only source evidence · Import disabled</p><section aria-label="October selected checks"><h2>Selected checks</h2><p>${report.counts.VALIDATED} passed selected checks; ${report.counts.REVIEW} retain review gates; ${report.counts.REJECTED} fail selected checks.</p><p>${monthlyZeroUsageRows} confirmed zero-charge monthly usage records are linked to the designated fixed-charge row. ${zeroGrossRejectedRows} rejected rows have recorded zero gross. They remain in historical evidence: no row is deleted, no replacement charge is invented and no paid balance is inferred. ${referenceSummary}</p><p>Passing selected checks does not approve contracts, schedules, document links or import.</p></section><section><h2>Original row evidence</h2><div class="scroll"><table aria-label="October trip checks"><thead><tr><th>Source Trip ID</th><th>Logical record</th><th>Original trip status</th><th>Check status</th><th>Review findings</th></tr></thead><tbody>${report.rows.map(r => `<tr><td>${esc(r.sourceId)}</td><td>${esc(r.row)}</td><td>${esc(data.trips[r.row - 2].Status)}</td><td>${esc(r.status)}</td><td>${[...r.errors, ...r.review].map(esc).join('<br>')}</td></tr>`).join('')}</tbody></table></div></section></main></body></html>`;
  fs.writeFileSync(path.join(input, 'review', 'october-trip-preflight.html'), html);
  console.log(JSON.stringify({importEnabled: false, counts: report.counts, referenceIssues: report.referenceIssues.length, relationships: report.relationshipChecks,
    zeroGrossRejectedRows, monthlyZeroUsageRows, monthlyCycles: monthlyBilling.length, sourceHashesUnchanged: inventory.length}));
} catch (error) { console.error(error instanceof Error ? error.message : 'October preflight failed'); process.exitCode = 1; }
finally { if (priorLoader) require.extensions['.ts'] = priorLoader; else delete require.extensions['.ts']; }
