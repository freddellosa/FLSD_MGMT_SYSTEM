// Offline structural checks only. No response/source writes and no approval/import consumer.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), prior = require.extensions['.ts'];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
try {
  if (root !== 'D:\\FLSD-Batch7-Validation' || process.argv.length !== 2) throw new Error('Fixed workspace required');
  const folder = path.join(root, 'migration-input', 'review'), reads = [];
  const read = filename => {
    if (fs.realpathSync(filename) !== filename || fs.statSync(filename).size > 30 * 1024 * 1024) throw new Error('Bounded local file required');
    const bytes = fs.readFileSync(filename); reads.push({filename, hash: sha(bytes)});
    return new TextDecoder('utf-8', {fatal: true}).decode(bytes);
  };
  const plan = JSON.parse(read(path.join(folder, 'six-table-import-plan.generated.json')));
  const manifest = JSON.parse(read(path.join(folder, 'financial-review-templates.manifest.json')));
  if (manifest.importEnabled !== false || manifest.executionAuthorized !== false || manifest.sourcePlanSha256 !== plan.evidenceSha256 || manifest.sourcePlanFileSha256 !== reads[0].hash) throw new Error('Stale template provenance');
  if (plan.files.find(f => f.id === 'Company_Tbl.csv')?.sha256 !== manifest.customerSourceSha256) throw new Error('Customer evidence mismatch');
  for (const file of plan.files) {
    if (path.basename(file.id) !== file.id) throw new Error('Local source required');
    read(path.join(root, 'migration-input', file.id));
    if (reads.at(-1).hash !== file.sha256) throw new Error('Source changed');
  }
  const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
  require.extensions['.ts'] = (module, filename) => {
    const relative = path.relative(lib, fs.realpathSync(filename));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Local library required');
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText, filename);
  };
  const {validateFinancialReviewResponses} = require('../src/lib/migration/financial-review-responses.ts');
  const ids = table => plan.records.filter(r => r.table === table).map(r => r.sourceKey);
  const context = {customerIds: ids('company_tbl'), invoiceIds: ids('Invoice_Tbl'), soaIds: ids('SOA_Tbl')};
  if (Object.values(context).some(values => !values.length)) throw new Error('Source identity inventory missing');
  const customer = validateFinancialReviewResponses('CUSTOMER', read(path.join(folder, 'financial-customer-review.csv')), context);
  const receivable = validateFinancialReviewResponses('RECEIVABLE', read(path.join(folder, 'financial-receivable-review.csv')), context);
  if (reads.some(r => sha(fs.readFileSync(r.filename)) !== r.hash)) throw new Error('Evidence changed during validation');
  console.log(JSON.stringify({kind: 'FINANCIAL_REVIEW_RESPONSE_CHECK', customer, receivable, responsesUnchanged: true, sourceHashesUnchanged: true,
    limitations: 'Structural checks do not authenticate reviewers or verify contracts, customer-document relationships, gross ceilings, opening balances or full-period coverage.'}));
  if (customer.status === 'INVALID' || receivable.status === 'INVALID') process.exitCode = 1;
} catch { console.error('Financial review check failed; no responses, sources or database records were changed.'); process.exitCode = 1; }
finally { if (prior) require.extensions['.ts'] = prior; else delete require.extensions['.ts']; }
