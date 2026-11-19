// Read-only verification of fixed supplied copies; never loads data into an application/database.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), priorLoader = require.extensions['.ts'];
try {
  if (root !== 'D:\\FLSD-Batch7-Validation' || process.argv.length !== 2) throw new Error('Expected validation workspace/no arguments');
  const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
  require.extensions['.ts'] = (module, filename) => {
    const relative = path.relative(lib, fs.realpathSync(filename));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Trusted local source required');
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022}}).outputText, filename);
  };
  const {stageSixTableCsv, sixTableSchemas} = require('../src/lib/migration/six-table-contract.ts');
  const {parseCsv} = require('../src/lib/migration/csv.ts');
  const map = parseCsv(fs.readFileSync(path.join(root, 'docs', 'LEGACY_SIX_TABLE_FIELD_MAP.csv'), 'utf8'), {strictQuotes: true});
  for (const [table, schema] of Object.entries(sixTableSchemas)) {
    const entries = map.filter(r => r.source_table === table);
    if (entries.length !== schema.headers.length || new Set(entries.map(r => r.source_field)).size !== schema.headers.length || entries.some(r => !schema.headers.includes(r.source_field)) ||
        JSON.stringify(entries.filter(r => r.disposition === 'EXCLUDED').map(r => r.source_field).sort()) !== JSON.stringify([...schema.excluded].sort())) throw new Error('Field map and header contract drift');
  }
  const specs = [['Driver_tbl', 'Driver_Tbl.csv'], ['vehicle_tbl', 'Vehicle_Tbl.csv'], ['company_tbl', 'Company_Tbl.csv'],
    ['Trips_Tbl', 'Trips_Tbl.csv'], ['Trips_Tbl', 'FMS_Trips_Tbl Oct2026.csv'], ['SOA_Tbl', 'FMS_SOA_Tbl.csv'], ['Invoice_Tbl', 'FMS_invoice_tbl.csv']];
  const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
  const files = specs.map(([sourceTable, filename]) => {
    const source = path.join(root, 'migration-input', filename), bytes = fs.readFileSync(source);
    if (bytes.length > 30 * 1024 * 1024) throw new Error('Source byte bound exceeded');
    const result = stageSixTableCsv(sourceTable, new TextDecoder('utf-8', {fatal: true}).decode(bytes));
    if (hash(fs.readFileSync(source)) !== hash(bytes)) throw new Error('Source changed during read');
    return {sourceTable, filename, sha256: hash(bytes), status: result.structuralStatus, ...result.counts,
      unknownHeaders: result.unknownHeaders.length, missingOptional: result.missingOptional.length};
  });
  for (const f of files) if (hash(fs.readFileSync(path.join(root, 'migration-input', f.filename))) !== f.sha256) throw new Error('Source changed during verification');
  console.log(JSON.stringify({kind: 'SIX_TABLE_CONTRACT_CHECK', importEnabled: false, executionAuthorized: false, mapColumnsVerified: map.length, files,
    note: 'Header/key/privacy checks only. Not relationship, financial, database or release readiness.'}, null, 2));
} catch {console.error('Six-table contract verification failed; check source headers and field-map consistency. No files or databases were changed.'); process.exitCode = 1;}
finally {if (priorLoader) require.extensions['.ts'] = priorLoader; else delete require.extensions['.ts'];}
