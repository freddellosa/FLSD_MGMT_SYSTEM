// Offline review templates only. Never overwrites a human response or changes source data.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
try {
  if (root !== 'D:\\FLSD-Batch7-Validation' || process.argv.length !== 2) throw new Error('Fixed workspace required');
  const folder = path.join(root, 'migration-input', 'review');
  if (fs.realpathSync(folder) !== folder) throw new Error('Local review directory required');
  const input = path.join(root, 'migration-input', 'Company_Tbl.csv');
  if (fs.realpathSync(input) !== input) throw new Error('Local customer copy required');
  const companyBytes = fs.readFileSync(input);
  const planBytes = fs.readFileSync(path.join(folder, 'six-table-import-plan.generated.json'));
  const plan = JSON.parse(planBytes);
  if (plan.files.find(f => f.id === 'Company_Tbl.csv')?.sha256 !== sha(companyBytes)) throw new Error('Customer source changed');
  // Use the established CSV parser through a local-only TypeScript loader.
  const ts = require('typescript'), prior = require.extensions['.ts'];
  let staged;
  try {
    const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
    require.extensions['.ts'] = (module, filename) => {
      const relative = path.relative(lib, fs.realpathSync(filename));
      if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Local library required');
      module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText, filename);
    };
    staged = require('../src/lib/migration/six-table-contract.ts').stageSixTableCsv('company_tbl', new TextDecoder('utf-8', {fatal: true}).decode(companyBytes));
  } finally {
    if (prior) require.extensions['.ts'] = prior; else delete require.extensions['.ts'];
  }
  if (!staged.rows.length || new Set(staged.rows.map(r => r.sourceKey)).size !== staged.rows.length) throw new Error('Unique customer keys required');
  const cell = value => {
    let text = String(value ?? '');
    if (/^[\s]*[=+@-]/.test(text) || /^[\t\r\n]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"', '""') + '"';
  };
  const csv = rows => rows.map(row => row.map(cell).join(',')).join('\r\n') + '\r\n';
  const customers = csv([
    ['CompanyID', 'SourceNameForReference', 'EffectiveFrom', 'EffectiveTo', 'VatClassification', 'BaseOtAmountBasis', 'EvidenceReference', 'Reviewer', 'ReviewDate', 'ReviewStatus', 'Notes'],
    ...staged.rows.map(row => [row.sourceKey, row.payload.CompanyName, '', '', '', '', '', '', '', 'PENDING', ''])
  ]);
  const receivables = csv([['InvoiceID', 'SOAID', 'CompanyID', 'AsOfDate', 'ApprovedOutstandingAmount', 'EvidenceReference', 'Reviewer', 'ReviewDate', 'ReviewStatus', 'Notes']]);
  const files = [['financial-customer-review.csv', customers], ['financial-receivable-review.csv', receivables]];
  const manifest = {kind: 'FINANCIAL_REVIEW_TEMPLATES', version: 1, status: 'PENDING_NOT_APPROVED_POLICY', importEnabled: false, executionAuthorized: false,
    customerSourceSha256: sha(companyBytes), sourcePlanFileSha256: sha(planBytes), sourcePlanSha256: plan.evidenceSha256,
    coverage: 'ALL_SUPPLIED_CUSTOMER_MASTER_ROWS_NOT_CONFIRMED_OPERATIONAL_CUSTOMERS', customerRows: staged.rows.length, receivableRows: 0,
    files: files.map(([name, content]) => ({name, templateSha256: sha(Buffer.from(content))})),
    notes: 'Separate optional review responses, not an importer or replacements for existing contract decisions. Blank fields remain unresolved. Names are spreadsheet-escaped references. No receivables inferred.'};
  files.push(['financial-review-templates.manifest.json', JSON.stringify(manifest, null, 2) + '\n']);
  if (sha(fs.readFileSync(input)) !== sha(companyBytes) || sha(fs.readFileSync(path.join(folder, 'six-table-import-plan.generated.json'))) !== sha(planBytes)) throw new Error('Evidence changed');
  // Check all paths before creating anything; existing human-editable sheets are never refreshed.
  if (files.some(([name]) => fs.existsSync(path.join(folder, name)))) throw new Error('Review sheets already exist; preserve responses');
  for (const [name, content] of files) fs.writeFileSync(path.join(folder, name), content, {flag: 'wx'});
  console.log(JSON.stringify({customerRows: staged.rows.length, receivableRows: 0, sourceUnchanged: true, importEnabled: false, executionAuthorized: false}));
} catch {
  console.error('Review-sheet preparation stopped. Existing responses are preserved; no source or database changes performed.');
  process.exitCode = 1;
}
