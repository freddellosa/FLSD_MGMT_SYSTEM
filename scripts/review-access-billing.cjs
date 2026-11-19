// Offline inspection of the explicitly supplied billing copies. No DB, Access or network adapter.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), previous = require.extensions['.ts'];
try {
  if (root !== 'D:\\FLSD-Batch7-Validation') throw new Error('Validation workspace required');
  const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
  require.extensions['.ts'] = (module, filename) => {
    const relative = path.relative(lib, fs.realpathSync(filename));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Trusted library required');
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, filename);
  };
  const {parseCsv} = require('../src/lib/migration/csv.ts');
  const {accessMoney} = require('../src/lib/migration/access-staging.ts');
  const {parseLegacyDate} = require('../src/lib/migration/trips.ts');
  const {fromCentavos} = require('../src/lib/domain/billing.ts');
  const input = path.join(root, 'migration-input');
  const inventory = [], data = {};
  for (const [kind, name, required] of [
    ['invoices', 'FMS_invoice_tbl.csv', ['InvoiceNo', 'InvoiceDate', 'SOANo', 'Status']],
    ['soas', 'FMS_SOA_Tbl.csv', ['SOANo']],
    ['trips', 'Trips_Tbl.csv', ['tmpInvoiceNo', 'CompanyID', 'SOANo']],
  ]) {
    const filename = path.join(input, name), bytes = fs.readFileSync(filename);
    if (bytes.length > 30 * 1024 * 1024) throw new Error('Billing review size limit exceeded');
    const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
    let rows, problem;
    try {
      rows = parseCsv(new TextDecoder('utf-8', {fatal: true}).decode(bytes), {strictQuotes: true});
      const columns = Object.keys(rows[0] ?? {});
      if (required.some(c => !columns.includes(c))) { problem = 'REQUIRED_HEADERS_UNMAPPED'; rows = undefined; }
      if (columns.some(c => /password|secret|token|credential/i.test(c))) throw new Error('Credential column detected');
    } catch { problem = 'CSV_HEADERS_OR_STRUCTURE_UNMAPPED'; rows = undefined; }
    inventory.push({kind, fileName: name, sha256, bytes: bytes.length, status: rows ? 'PARSED' : problem,
      ...(rows ? {rows: rows.length, columns: Object.keys(rows[0] ?? {})} : {})});
    if (rows) data[kind] = rows;
  }
  if (!data.invoices || !data.trips) throw new Error('Invoice/trip headers or structure require review');
  const invoices = data.invoices, trips = data.trips;
  const profile = (rows, field) => {
    const counts = new Map(); let blank = 0;
    for (const row of rows) { const value = row[field] ?? ''; if (!value.trim()) blank++; else counts.set(value, (counts.get(value) ?? 0) + 1); }
    return {blank, distinct: counts.size, duplicateGroups: [...counts.values()].filter(n => n > 1).length};
  };
  const dateProfile = (field, rows = invoices) => {
    const dates = rows.map(r => parseLegacyDate(r[field])).map(d => d ? d.toISOString().slice(0, 10) : null);
    const valid = dates.filter(Boolean).sort();
    return {field, first: valid[0] ?? null, last: valid.at(-1) ?? null, invalidOrBlank: dates.length - valid.length,
      inTestWindow: valid.filter(v => v >= '2026-09-01' && v <= '2026-10-31').length};
  };
  const categories = rows => {
    const groups = new Map(); for (const r of rows) groups.set(r.Status || '[blank]', (groups.get(r.Status || '[blank]') ?? 0) + 1);
    return [...groups].map(([sourceStatus, count]) => ({sourceStatus, count}));
  };
  const statusCounts = categories(invoices);
  const tripKeys = new Set(trips.map(r => r.tmpInvoiceNo)), tripSoas = new Set(trips.map(r => r.SOANo).filter(v => v?.trim() && !/^0+(?:\.0+)?$/.test(v)));
  const amountProfile = ['Amount', 'Evat', 'InvoiceTotAmt', 'CheckAmt', 'Less_wh_tx'].map(field => {
    let blank = 0, invalid = 0, nonzero = 0, sum = 0n;
    for (const r of invoices) { if (!r[field]?.trim()) { blank++; continue; } try { const n = accessMoney(r[field]); sum += n; if (n !== 0n) nonzero++; } catch { invalid++; } }
    return {field, blank, invalid, nonzero, total: fromCentavos(sum), interpretation: 'SOURCE_EVIDENCE_ONLY'};
  });
  const soaGroups = new Map();
  for (const [index, r] of invoices.entries()) {
    const key = r.SOANo; if (!key?.trim() || /^0+(?:\.0+)?$/.test(key)) continue;
    const group = soaGroups.get(key) ?? {rows: [], customers: new Set()};
    group.rows.push(index + 2); group.customers.add(r.ChargeTo); soaGroups.set(key, group);
  }
  const linkExceptions = [];
  for (const [sourceSoa, group] of soaGroups) {
    const rows = group.rows.filter(row => !['cancel', 'cancelled'].includes(invoices[row - 2].Status.trim().toLowerCase()));
    if (rows.length > 1) linkExceptions.push({code: 'MULTIPLE_NON_CANCELLED_INVOICE_ROWS', sourceSoa, rows});
  }
  let soaReview = null;
  if (data.soas) {
    const soas = data.soas, soaIndex = new Map(), invoiceIndex = new Map(invoices.map(r => [r.InvoiceNo, r]));
    for (const r of soas) { const group = soaIndex.get(r.SOANo) ?? []; group.push(r); soaIndex.set(r.SOANo, group); }
    let uniqueSoaMatches = 0, missingSoaMatches = 0, ambiguousSoaMatches = 0, customerLabelMismatches = 0;
    invoices.forEach((r, index) => {
      const matches = soaIndex.get(r.SOANo) ?? [];
      if (!matches.length) { missingSoaMatches++; linkExceptions.push({code: 'INVOICE_SOA_NOT_IN_EXPORT', file: 'FMS_invoice_tbl.csv', row: index + 2, sourceInvoice: r.InvoiceNo, sourceSoa: r.SOANo}); }
      else if (matches.length > 1) { ambiguousSoaMatches++; linkExceptions.push({code: 'AMBIGUOUS_SOA_KEY', file: 'FMS_invoice_tbl.csv', row: index + 2, sourceSoa: r.SOANo}); }
      else { uniqueSoaMatches++; if (r.ChargeTo !== matches[0].ChargeTo) { customerLabelMismatches++; linkExceptions.push({code: 'CUSTOMER_LABEL_DIFFERENCE', file: 'FMS_invoice_tbl.csv', row: index + 2, sourceInvoice: r.InvoiceNo, sourceSoa: r.SOANo}); } }
    });
    let linkedInvoiceFound = 0, linkedInvoiceMissing = 0, reverseSoaMismatches = 0;
    soas.forEach((r, index) => {
      if (!r.InvoiceNo?.trim() || /^0+(?:\.0+)?$/.test(r.InvoiceNo)) return;
      const invoice = invoiceIndex.get(r.InvoiceNo);
      if (!invoice) { linkedInvoiceMissing++; linkExceptions.push({code: 'SOA_INVOICE_NOT_IN_EXPORT', file: 'FMS_SOA_Tbl.csv', row: index + 2, sourceInvoice: r.InvoiceNo, sourceSoa: r.SOANo}); }
      else { linkedInvoiceFound++; if (invoice.SOANo !== r.SOANo) { reverseSoaMismatches++; linkExceptions.push({code: 'SOA_INVOICE_REVERSE_LINK_DIFFERENCE', file: 'FMS_SOA_Tbl.csv', row: index + 2, sourceInvoice: r.InvoiceNo, sourceSoa: r.SOANo}); } }
    });
    soaReview = {rows: soas.length, sourceKey: profile(soas, 'SOANo'), statusCounts: categories(soas), dateProfiles: [dateProfile('DateCreated', soas), dateProfile('InvoiceDate', soas)],
      invoiceToSoa: {uniqueSoaMatches, missingSoaMatches, ambiguousSoaMatches, customerLabelMismatches},
      soaToInvoice: {linkedInvoiceFound, linkedInvoiceMissing, reverseSoaMismatches},
      soaGroupsWithMultipleInvoiceRows: [...soaGroups.values()].filter(g => g.rows.length > 1).length,
      // Diagnostic cohort only; raw status labels remain unchanged and no lifecycle is imported.
      soaGroupsWithMultipleNonCancelledInvoiceRows: [...soaGroups.values()].filter(g => g.rows.filter(row => !['cancel', 'cancelled'].includes(invoices[row - 2].Status.trim().toLowerCase())).length > 1).length};
  }
  const report = {kind: 'ACCESS_BILLING_SOURCE_REVIEW', version: 1, importEnabled: false, createdAt: new Date().toISOString(),
    decisions: {evatMeansVat: true, testFrom: '2026-09-01', testThrough: '2026-10-31', paidStatusIsLegacyEvidence: true, fabricateReceipts: false},
    inventory, invoiceNumber: profile(invoices, 'InvoiceNo'), statusCounts, dateProfiles: [dateProfile('InvoiceDate'), dateProfile('DateOfTrip_Start')], amountProfile, soaReview,
    identityComparisons: {approvedMapping: false, invoiceNumberMatchesSuppliedTripKeyRows: invoices.filter(r => tripKeys.has(r.InvoiceNo)).length,
      invoiceRowsWithNonzeroSoa: [...soaGroups.values()].reduce((n, g) => n + g.rows.length, 0),
      distinctNonzeroSoas: soaGroups.size, soaValuesAlsoInSuppliedTrips: [...soaGroups.keys()].filter(k => tripSoas.has(k)).length,
      mixedCustomerSoaGroups: [...soaGroups.values()].filter(g => g.customers.size > 1).length},
    exceptions: [...linkExceptions, ...[...soaGroups.entries()].filter(([, g]) => g.customers.size > 1).map(([sourceSoa, g]) => ({code: 'MIXED_CUSTOMER_SOA_EVIDENCE', sourceSoa, rows: g.rows}))],
    limitations: [...(data.soas ? [] : ['SOA headers must be supplied before mapping an unheaded export.']), 'InvoiceNo/Trip-ID overlap is diagnostic only, not an approved identity mapping.',
      'Paid source labels do not create payment dates, cash receipts, allocations or custody events.', 'Source totals are not reconciled opening balances.']};
  for (const record of inventory) {
    const after = crypto.createHash('sha256').update(fs.readFileSync(path.join(input, record.fileName))).digest('hex');
    if (after !== record.sha256) throw new Error('Source changed during billing review');
  }
  const out = path.join(input, 'review'); fs.mkdirSync(out, {recursive: true});
  fs.writeFileSync(path.join(out, 'billing-source-review.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({invoiceRows: invoices.length, soaRows: data.soas?.length ?? null, soaHeaderStatus: inventory.find(v => v.kind === 'soas').status,
    invoiceUniqueKeys: report.invoiceNumber.distinct, duplicateInvoiceKeyGroups: report.invoiceNumber.duplicateGroups,
    paidLabelRows: invoices.filter(r => r.Status.trim().toLowerCase() === 'paid').length,
    dateProfiles: report.dateProfiles, identityComparisons: report.identityComparisons,
    soaRelationships: soaReview ? {sourceKey: soaReview.sourceKey, invoiceToSoa: soaReview.invoiceToSoa, soaToInvoice: soaReview.soaToInvoice, soaGroupsWithMultipleInvoiceRows: soaReview.soaGroupsWithMultipleInvoiceRows, soaGroupsWithMultipleNonCancelledInvoiceRows: soaReview.soaGroupsWithMultipleNonCancelledInvoiceRows} : null,
    exceptionCount: report.exceptions.length, sourceHashesUnchanged: inventory.length, importEnabled: false}));
} catch (error) { console.error(error instanceof Error ? error.message : 'Billing source review failed'); process.exitCode = 1; }
finally { if (previous) require.extensions['.ts'] = previous; else delete require.extensions['.ts']; }
