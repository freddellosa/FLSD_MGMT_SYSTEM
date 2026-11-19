// Fixed-copy structural review only. Does not connect to or import into any database.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), priorLoader = require.extensions['.ts'];
try {
  const exceptionMode = process.argv.length === 3 && process.argv[2] === '--exceptions';
  const normalizedMode = process.argv.length === 3 && process.argv[2] === '--normalized-source';
  const targetMode = process.argv.length === 3 && (process.argv[2] === '--target-candidates' || exceptionMode || normalizedMode);
  if (root !== 'D:\\FLSD-Batch7-Validation' || (process.argv.length !== 2 && !targetMode)) throw new Error('Validation workspace/known local review mode required');
  const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
  require.extensions['.ts'] = (module, filename) => {
    const relative = path.relative(lib, fs.realpathSync(filename));
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Trusted local source required');
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText, filename);
  };
  const {buildSixTableImportPlan} = require('../src/lib/migration/six-table-import-plan.ts');
  const {archiveGeneratedFile} = require('./lib/access-billing-sources.cjs');
  const specs = [['Driver_tbl', 'Driver_Tbl.csv'], ['vehicle_tbl', 'Vehicle_Tbl.csv'], ['company_tbl', 'Company_Tbl.csv'],
    ['Trips_Tbl', 'Trips_Tbl.csv'], ['Trips_Tbl', 'FMS_Trips_Tbl Oct2026.csv'], ['SOA_Tbl', 'FMS_SOA_Tbl.csv'], ['Invoice_Tbl', 'FMS_invoice_tbl.csv']];
  const input = fs.realpathSync(path.join(root, 'migration-input'));
  if (input !== path.join(root, 'migration-input')) throw new Error('Local input directory required');
  const files = specs.map(([table, id]) => {
    const filename = path.join(input, id);
    if (fs.lstatSync(filename).isSymbolicLink() || fs.statSync(filename).size > 30 * 1024 * 1024) throw new Error('Bounded local source required');
    return {table, id, bytes: fs.readFileSync(filename)};
  });
  const plan = buildSixTableImportPlan(files, {namespace: 'FLSD_ACCESS', from: '2026-09-01', through: '2026-10-31', retainMissingSoaReferences: true});
  let report = plan;
  let exceptionMarkdown;
  let normalizedReviewHtml;
  if (targetMode) {
    const {prepareSixTableTargetCandidates} = require('../src/lib/migration/six-table-target-candidates.ts');
    const mappingPath = path.join(root, 'docs', 'LEGACY_SIX_TABLE_FIELD_MAP.csv');
    if (fs.lstatSync(mappingPath).isSymbolicLink() || fs.statSync(mappingPath).size > 1024 * 1024) throw new Error('Bounded local map required');
    const mappingBytes = fs.readFileSync(mappingPath);
    const prepared = prepareSixTableTargetCandidates(files, {namespace: 'FLSD_ACCESS', from: '2026-09-01', through: '2026-10-31', retainMissingSoaReferences: true}, new TextDecoder('utf-8', {fatal: true}).decode(mappingBytes));
    if (!fs.readFileSync(mappingPath).equals(mappingBytes)) throw new Error('Map changed during review');
    const issueCounts = {};
    for (const row of prepared.candidates) for (const issue of row.issues) issueCounts[issue.code] = (issueCounts[issue.code] ?? 0) + 1;
    report = {kind: 'SIX_TABLE_TARGET_CANDIDATE_DIAGNOSTICS', version: 1, importEnabled: false, executionAuthorized: false,
      releaseState: prepared.releaseState, counts: prepared.counts, sourcePlanSha256: prepared.sourcePlanSha256, mappingSha256: prepared.mappingSha256,
      candidateEvidenceSha256: prepared.evidenceSha256, files: plan.files, issueCounts,
      tables: specs.map(([table]) => table).filter((table, i, all) => all.indexOf(table) === i).map(table => ({table,
        rows: prepared.candidates.filter(c => c.source.table === table).length,
        quarantined: prepared.candidates.filter(c => c.source.table === table && c.state === 'QUARANTINED').length})),
      rows: prepared.candidates.map(c => ({source: c.source, state: c.state, issues: c.issues})), limitations: prepared.limitations};
    if (exceptionMode) {
      const {buildSixTableExceptionWorklist, renderSixTableExceptionMarkdown} = require('../src/lib/migration/six-table-exception-worklist.ts');
      report = buildSixTableExceptionWorklist(prepared);
      exceptionMarkdown = renderSixTableExceptionMarkdown(report);
    }
    if (normalizedMode) {
      const {prepareNormalizedSource} = require('../src/lib/migration/normalized-source.ts');
      const {validateNormalizedSourceSnapshot, normalizedCoverageSha256} = require('../src/lib/migration/normalized-snapshot.ts');
      const {stageSixTableCsv} = require('../src/lib/migration/six-table-contract.ts');
      const normalized = prepareNormalizedSource(files, {namespace: 'FLSD_ACCESS', from: '2026-09-01', through: '2026-10-31', retainMissingSoaReferences: true}, new TextDecoder('utf-8', {fatal: true}).decode(mappingBytes));
      let sourceValidation = null;
      if (normalized.sourceSnapshot) {
        const expectedFiles = files.map(file => {
          const known = plan.files.find(f => f.id === file.id);
          return {id: file.id, table: file.table, sha256: known.sha256, rows: known.rows,
            headers: stageSixTableCsv(file.table, new TextDecoder('utf-8', {fatal: true}).decode(file.bytes)).headers};
        });
        const expectedIdentities = plan.records.map(r => ({namespace: 'FLSD_ACCESS', kind: r.table, key: r.sourceKey}));
        sourceValidation = validateNormalizedSourceSnapshot(normalized.sourceSnapshot, normalized.mappingSha256, normalizedCoverageSha256(expectedFiles, expectedIdentities));
      }
      const rows = normalized.sourceSnapshot?.records ?? [];
      report = {kind: 'NORMALIZED_SOURCE_DIAGNOSTICS', version: 'NS-1', status: sourceValidation?.status ?? normalized.status, preparationStatus: normalized.status, importEnabled: false, executionAuthorized: false,
        contractSha256: normalized.contractSha256, sourcePlanSha256: normalized.sourcePlanSha256, mappingSha256: normalized.mappingSha256,
        candidateEvidenceSha256: normalized.candidateEvidenceSha256, worklistSha256: normalized.worklistSha256,
        normalizedSourceEvidenceSha256: normalized.evidenceSha256, coverageSha256: normalized.sourceSnapshot?.coverageSha256 ?? null,
        counts: {normalizedRows: rows.length, sourceCases: normalized.sourceCases, policyHeldRows: normalized.policyHeldRows,
          quarantinedRows: rows.filter(r => r.reviewState === 'QUARANTINED').length, destinationUnboundRows: rows.length},
        states: sourceValidation?.stateCounts ?? {}, sourceValidation, blockedFiles: normalized.blockedFiles, blockedRows: normalized.blockedRows, files: plan.files,
        note: 'Source-only validation with source-plan identity coverage. No destination snapshot/registry or approval was fabricated; personal/financial normalized values remain in memory.'};
      if (sourceValidation) {
        const {renderNormalizedSourceReview} = require('../src/lib/migration/normalized-source-html.ts');
        const {buildSixTableExceptionWorklist} = require('../src/lib/migration/six-table-exception-worklist.ts');
        normalizedReviewHtml = renderNormalizedSourceReview({validation: sourceValidation, worklist: buildSixTableExceptionWorklist(prepared), files: plan.files,
          sourcePlanSha256: plan.evidenceSha256, candidateEvidenceSha256: prepared.evidenceSha256, retainedMissingSoaKeys: plan.retainedMissingSoaKeys});
      }
    }
    if (!fs.readFileSync(mappingPath).equals(mappingBytes)) throw new Error('Map changed during source preparation');
  }
  for (const file of plan.files) if (crypto.createHash('sha256').update(fs.readFileSync(path.join(input, file.id))).digest('hex') !== file.sha256) throw new Error('Source changed during review');
  const output = path.join(input, 'review');
  fs.mkdirSync(output, {recursive: true});
  if (fs.realpathSync(output) !== output) throw new Error('Local review directory required');
  const reportName = normalizedMode ? 'normalized-source.generated.json' : exceptionMode ? 'six-table-exceptions.generated.json' : targetMode ? 'six-table-target-candidates.generated.json' : 'six-table-import-plan.generated.json';
  const outputs = [[path.join(output, reportName), JSON.stringify(report, null, 2) + '\n']];
  if (exceptionMarkdown !== undefined) outputs.push([path.join(output, 'six-table-exceptions.generated.md'), exceptionMarkdown]);
  if (normalizedReviewHtml !== undefined) outputs.push([path.join(output, 'normalized-source.generated.html'), normalizedReviewHtml]);
  for (const [target] of outputs) if (fs.existsSync(target) && fs.lstatSync(target).isSymbolicLink()) throw new Error('Local generated report required');
  for (const [target, content] of outputs) if (!fs.existsSync(target) || fs.readFileSync(target, 'utf8') !== content) {archiveGeneratedFile(target); fs.writeFileSync(target, content);}
  console.log(JSON.stringify(targetMode ? {kind: report.kind, status: report.status, counts: report.counts, tables: report.tables, issueCounts: report.issueCounts,
    sourceValidation: report.sourceValidation ? {rows: report.sourceValidation.counts.rows, gateCounts: report.sourceValidation.gateCounts} : undefined,
    sourceHashesUnchanged: true, importEnabled: false, executionAuthorized: false, report: 'migration-input/review/' + reportName} :
    {kind: plan.kind, structuralStatus: plan.structuralStatus, counts: plan.counts, relationshipCounts: plan.relationshipCounts,
      documentLinkIssues: plan.documentLinkIssues.length, missingTables: plan.missingTables, evidenceSha256: plan.evidenceSha256,
      sourceHashesUnchanged: true, importEnabled: false, executionAuthorized: false, report: 'migration-input/review/' + reportName}, null, 2));
} catch {console.error('Six-table source planning failed. No import or database action was performed.'); process.exitCode = 1;}
finally {if (priorLoader) require.extensions['.ts'] = priorLoader; else delete require.extensions['.ts'];}
