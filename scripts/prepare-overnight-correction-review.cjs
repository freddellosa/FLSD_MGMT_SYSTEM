// Confirmed-date proposal only. Never edits source exports, Owner records, database or application state.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto'), ts = require('typescript');
const root = path.resolve(__dirname, '..'), previousLoader = require.extensions['.ts'];
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
try {
  if (root !== 'D:\\FLSD-Batch7-Validation' || process.argv.length !== 2) throw new Error('Fixed workspace/no arguments required');
  const output = path.join(root, 'migration-input', 'review'), reads = [];
  if (fs.realpathSync(output) !== output) throw new Error('Local review directory required');
  const read = name => {
    const filename = path.join(output, name);
    if (path.basename(name) !== name || fs.realpathSync(filename) !== filename || fs.statSync(filename).size > 30 * 1024 * 1024) throw new Error('Bounded local artifact required');
    const bytes = fs.readFileSync(filename); reads.push({filename, sha256: hash(bytes)}); return JSON.parse(bytes.toString('utf8'));
  };
  const owner = read('owner-overnight-confirmation.json'), worklist = read('six-table-exceptions.generated.json');
  const expected = '77919,77921,77922,77923,77924,77925,77926,77932,77933,77934,77935,77936,77938,78008,78009,78010,78178,78236,78261,78263,78267,78269,78270,78271,78272,78273,78274,78275,78276,78277,78393,78395,78398,78401';
  const cases = worklist.cases.filter(c => c.code === 'SERVICE_END_BEFORE_START');
  if (owner.kind !== 'OWNER_CONFIRMED_NEXT_DAY_REVIEW' || owner.scope !== 'EXACT_LISTED_SOURCE_CASES_ONLY' || owner.preserveRecordedEndTime !== true || owner.sourceCorrectionApplied !== false || owner.applyEnabled !== false ||
    owner.importEnabled !== false || owner.executionAuthorized !== false || owner.cases.length !== 34 || cases.length !== 34 || owner.cases.map(c => c.tripId).sort().join(',') !== expected) throw new Error('Exact recorded Owner confirmation required');
  const lib = fs.realpathSync(path.join(root, 'src', 'lib'));
  require.extensions['.ts'] = (module, filename) => {
    const relative = path.relative(lib, fs.realpathSync(filename)); if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Trusted local library required');
    module._compile(ts.transpileModule(fs.readFileSync(filename, 'utf8'), {compilerOptions: {module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true}}).outputText, filename);
  };
  const {proposeConfirmedNextDayEnd} = require('../src/lib/migration/confirmed-next-day.ts');
  const {canonicalReviewJson} = require('../src/lib/migration/canonical-review-json.ts');
  const {archiveGeneratedFile} = require('./lib/access-billing-sources.cjs');
  const ownerSha256 = reads[0].sha256;
  const sourceHashes = new Map();
  const proposals = owner.cases.map(confirmed => {
    const item = cases.find(c => c.caseId === confirmed.caseSha256 && c.source.sourceKey === confirmed.tripId);
    if (!item || item.source.fileSha256 !== confirmed.sourceFileSha256 || item.source.evidenceSha256 !== confirmed.sourceEvidenceSha256 ||
      item.source.fileId !== confirmed.sourceFile || item.source.row !== confirmed.logicalRow || item.evidence.find(e => e.field === 'DateOfTrip_Start')?.value !== confirmed.recordedStart || item.evidence.find(e => e.field === 'DateOfTrip_End')?.value !== confirmed.recordedEnd ||
      !['Trips_Tbl.csv', 'FMS_Trips_Tbl Oct2026.csv'].includes(confirmed.sourceFile)) throw new Error('Confirmed case source evidence changed');
    const filename = path.join(root, 'migration-input', confirmed.sourceFile);
    if (fs.realpathSync(filename) !== filename || hash(fs.readFileSync(filename)) !== confirmed.sourceFileSha256) throw new Error('Confirmed trip export changed');
    sourceHashes.set(filename, confirmed.sourceFileSha256);
    return {...confirmed, ...proposeConfirmedNextDayEnd(confirmed.recordedStart, confirmed.recordedEnd), ownerConfirmationSha256: ownerSha256, status: 'OWNER_CONFIRMED_PENDING_SOURCE_CORRECTION'};
  });
  const body = {kind: 'CONFIRMED_OVERNIGHT_CORRECTION_REVIEW', version: 1, applyEnabled: false, importEnabled: false, executionAuthorized: false,
    ownerConfirmationSha256: ownerSha256, worklistSha256AtReview: owner.worklistSha256AtReview, count: proposals.length, proposals,
    note: 'Only the exact 34 confirmed source cases. Preserve end times; date-only proposals, no source or database update. Other review gates remain.'};
  const report = {...body, evidenceSha256: hash(canonicalReviewJson(body))};
  const quote = value => '"' + String(value).replaceAll('"', '""') + '"';
  const csv = [['TripID','SourceFile','LogicalRow','OriginalStart','OriginalEnd','ProposedEndLocal','SourceFileSHA256','SourceRowSHA256','OwnerConfirmationSHA256'].map(quote).join(','),
    ...proposals.map(p => [p.tripId,p.sourceFile,p.logicalRow,p.recordedStart,p.recordedEnd,p.proposedEndLocal,p.sourceFileSha256,p.sourceEvidenceSha256,p.ownerConfirmationSha256].map(quote).join(','))].join('\r\n') + '\r\n';
  for (const read of reads) if (hash(fs.readFileSync(read.filename)) !== read.sha256) throw new Error('Review evidence changed during preparation');
  for (const [filename, sha256] of sourceHashes) if (hash(fs.readFileSync(filename)) !== sha256) throw new Error('Trip source changed during preparation');
  for (const [name, content] of [['overnight-corrections.generated.json',JSON.stringify(report,null,2)+'\n'],['overnight-corrections.generated.csv',csv]]) {
    const filename = path.join(output,name); if (fs.existsSync(filename) && fs.lstatSync(filename).isSymbolicLink()) throw new Error('Local generated artifact required');
    if (!fs.existsSync(filename) || fs.readFileSync(filename,'utf8') !== content) {archiveGeneratedFile(filename);fs.writeFileSync(filename,content);}
  }
  console.log(JSON.stringify({confirmedTrips: proposals.length, sourceCorrectionApplied: false, endTimesPreserved: true, sourceHashesUnchanged: true, ownerRecordUnchanged: true, applyEnabled: false}));
} catch {console.error('Overnight correction review failed; no source/date/database updates occurred.');process.exitCode=1;}
finally {if(previousLoader)require.extensions['.ts']=previousLoader;else delete require.extensions['.ts'];}
