// Caller installs the trusted local TS loader. Reads only the fixed, user-supplied export names.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const {parseCsv} = require('../../src/lib/migration/csv.ts');
const {combineTripPartitions} = require('../../src/lib/migration/trip-partitions.ts');
const specs = [
  {kind: 'trips', fileName: 'Trips_Tbl.csv', declaredMonth: '2026-09', required: ['tmpInvoiceNo', 'CompanyID', 'SOANo', 'DateOfTrip_Start', 'InvoiceTotAmt']},
  {kind: 'trips', fileName: 'FMS_Trips_Tbl Oct2026.csv', declaredMonth: '2026-10', optional: true, required: ['tmpInvoiceNo', 'CompanyID', 'SOANo', 'DateOfTrip_Start', 'InvoiceTotAmt']},
  {kind: 'customers', fileName: 'Company_Tbl.csv', required: ['CompanyID', 'CompanyName']},
  {kind: 'soas', fileName: 'FMS_SOA_Tbl.csv', required: ['SOANo', 'InvoiceNo', 'ChargeTo', 'Status']},
  {kind: 'invoices', fileName: 'FMS_invoice_tbl.csv', required: ['InvoiceNo', 'SOANo', 'ChargeTo', 'Status', 'DateOfTrip_Start', 'InvoiceTotAmt']},
];
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
function readAccessBillingSources(root) {
  if (root !== 'D:\\FLSD-Batch7-Validation') throw new Error('Validation workspace required');
  const input = path.join(root, 'migration-input'), source = {}, inventory = [], tripParts = [];
  for (const spec of specs) {
    const filename = path.join(input, spec.fileName); if (spec.optional && !fs.existsSync(filename)) continue;
    const bytes = fs.readFileSync(filename); if (bytes.length > 30 * 1024 * 1024) throw new Error('Export exceeds offline review bound');
    const rows = parseCsv(new TextDecoder('utf-8', {fatal: true}).decode(bytes), {strictQuotes: true});
    const headers = Object.keys(rows[0] ?? {});
    if (spec.required.some(c => !headers.includes(c)) || headers.some(c => /password|secret|token|credential/i.test(c))) throw new Error('Required safe source headers missing');
    const record = {kind: spec.kind, fileName: spec.fileName, sha256: sha(bytes), rows: rows.length, ...(spec.declaredMonth ? {declaredMonth: spec.declaredMonth} : {})};
    inventory.push(record);
    if (spec.kind === 'trips') tripParts.push({...record, rows}); else source[spec.kind] = rows;
  }
  const tripReview = combineTripPartitions(tripParts);
  source.trips = tripReview.rows; source.tripLocations = tripReview.locations;
  source.retainMissingSoaReferences = true; // Owner confirmed partial exports may retain unresolved references.
  const monthlyPath = path.join(input, 'review', 'owner-monthly-billing-confirmation.json'), ownerReviewFacts = [];
  if (fs.existsSync(monthlyPath)) {
    const bytes = fs.readFileSync(monthlyPath), facts = JSON.parse(bytes.toString('utf8'));
    if (facts.kind !== 'OWNER_MONTHLY_BILLING_REVIEW' || facts.version !== 1 || facts.importEnabled !== false || facts.executionAuthorized !== false ||
        inventory.find(f => f.fileName === facts.sourceTripFile)?.sha256 !== facts.sourceSha256 || !Array.isArray(facts.definitions)) throw new Error('Monthly source evidence is stale or invalid');
    source.monthlyBilling = facts.definitions;
    ownerReviewFacts.push({fileName: 'owner-monthly-billing-confirmation.json', sha256: sha(bytes)});
  }
  return {source, inventory, tripReview, ownerReviewFacts};
}
function assertSourcesUnchanged(root, inventory) {
  for (const record of inventory) {
    if (!specs.some(s => s.fileName === record.fileName) || sha(fs.readFileSync(path.join(root, 'migration-input', record.fileName))) !== record.sha256) throw new Error('Source export changed during review');
  }
}
function archiveGeneratedFile(filename) {
  if (!fs.existsSync(filename)) return;
  const bytes = fs.readFileSync(filename), extension = path.extname(filename);
  const archived = filename.slice(0, -extension.length) + '.' + sha(bytes) + extension;
  if (fs.existsSync(archived)) { if (!fs.readFileSync(archived).equals(bytes)) throw new Error('Generated archive collision'); }
  else fs.writeFileSync(archived, bytes, {flag: 'wx'});
}
module.exports = {readAccessBillingSources, assertSourcesUnchanged, archiveGeneratedFile};
