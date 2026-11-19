// Builds a source review bundle only. No install/build/database/deploy/Git commands are executed.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
try {
  const root = fs.realpathSync(path.resolve(__dirname, '..'));
  if (root !== 'D:\\FLSD-Batch7-Validation' || process.argv.length !== 2) throw new Error('Validation workspace/no arguments required');
  const base = path.join(root, 'artifacts', 'production-review');
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '');
  const output = path.join(base, 'source-review-' + stamp);
  if (!output.startsWith(base + path.sep)) throw new Error('Invalid review output');
  fs.mkdirSync(output, {recursive: true});
  const rootFiles = ['AGENTS.md', 'README.md', 'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.pilot.json',
    'next.config.ts', 'next-env.d.ts', 'postcss.config.mjs', 'eslint.config.mjs', 'vitest.config.ts', 'vitest.pilot.config.ts', 'vitest.main-adapter.config.ts', 'playwright.config.ts', 'offline-integration.test.cjs'];
  const allowedExtensions = new Set(['.ts', '.tsx', '.css', '.json', '.md', '.csv', '.cjs', '.ps1', '.prisma', '.sql', '.toml', '.png', '.svg']);
  const files = [];
  const copy = relative => {
    const source = path.join(root, relative), stat = fs.lstatSync(source);
    if (stat.isSymbolicLink() || !stat.isFile() || !fs.realpathSync(source).startsWith(root + path.sep)) throw new Error('Only local regular source files may be packaged');
    if (stat.size > 30 * 1024 * 1024 || files.length >= 10000) throw new Error('Review package resource bound');
    const bytes = fs.readFileSync(source), destination = path.join(output, relative);
    fs.mkdirSync(path.dirname(destination), {recursive: true}); fs.writeFileSync(destination, bytes, {flag: 'wx'});
    files.push({path: relative.replaceAll(path.sep, '/'), bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex')});
  };
  const walk = relative => {
    for (const entry of fs.readdirSync(path.join(root, relative), {withFileTypes: true})) {
      if (entry.isSymbolicLink()) throw new Error('Symlinks are not package inputs');
      if (entry.name.startsWith('.') || ['migration-input', 'artifacts', 'node_modules', 'test-results'].includes(entry.name)) continue;
      const child = path.join(relative, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (allowedExtensions.has(path.extname(entry.name)) && !/\.bak(?:\.|$)|\.backup(?:\.|$)/i.test(entry.name)) copy(child);
    }
  };
  for (const file of rootFiles) copy(file);
  for (const directory of ['src', 'tests', 'docs', 'prisma', 'scripts']) walk(directory);
  const manifest = {kind: 'FLSD_PRODUCTION_SOURCE_REVIEW_PACKAGE', version: 1, createdAt: new Date().toISOString(),
    releaseStatus: 'NOT_PRODUCTION_READY', deploymentAuthorized: false, importEnabled: false, postingEnabled: false,
    excluded: ['migration-input', '.pilot', '.pilot-owner-access', '.env*', '.git', '.aws', '.codex', '.agents', 'node_modules', '.next*', 'test-results', 'artifacts'],
    outstanding: ['Authoritative persistence/import for ordinary zero-total daily entry; manual month-end base and SOA summary currently memory-only', 'PR-1 review SQL/reference import kernel prepared; connected PostgreSQL provider, shared financial/auth integration and authority cutover remain pending',
      'Atomic persisted business-number allocation and real concurrency tests', 'Imported historical data accepted as final by Owner; preserve recorded evidence. Operational tax eligibility and approved cutover receivables remain separate from historical acceptance',
      'Current successful application build pending; previous build failed EPERM on restricted .pilot (no permission bypass authorized)',
      'Zero-daily pilot schema review/rehearsal and approved capability activation; runtime remains strict',
      'Dependency patches blocked by registry access', 'Separately approved disposable database rehearsal/recovery',
      'Synthetic VAT report and entry browser checks passed; physical invoice/stock acceptance and security/release review remain pending', 'Hosting, real import, posting and deployment approvals'],
    files: files.sort((a, b) => a.path.localeCompare(b.path))};
  fs.writeFileSync(path.join(output, 'PACKAGE_MANIFEST.json'), JSON.stringify(manifest, null, 2), {flag: 'wx'});
  fs.writeFileSync(path.join(output, 'START_HERE.md'), '# FLSD source review package\n\nNOT PRODUCTION READY. This package is for code/design review and permitted offline validation only. No deployment, database setup/import or live posting is authorized.\n\nSee docs/PRODUCTION_PACKAGE_READINESS.md and PACKAGE_MANIFEST.json for current evidence and outstanding work. Historical source exports, credentials, local cluster, dependencies and compiled build are excluded. Documentation retains reviewed source field names/record references. Do not execute historical setup/migration commands as a release procedure.\n', {flag: 'wx'});
  for (const file of files) {
    const sourceHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file.path))).digest('hex');
    const copyHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(output, file.path))).digest('hex');
    if (sourceHash !== file.sha256 || copyHash !== file.sha256) throw new Error('Package/source changed during verification');
  }
  const result = {output, fileCount: files.length, releaseStatus: manifest.releaseStatus, credentialsAndSourceDataExcluded: true};
  fs.writeFileSync(path.join(base, 'LATEST_PACKAGE_REPORT.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
} catch {console.error('Source review packaging failed; no deployment or database action was performed. Inspect the bounded artifact output before reuse.'); process.exitCode = 1;}
