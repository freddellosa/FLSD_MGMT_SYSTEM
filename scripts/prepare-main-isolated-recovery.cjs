/* eslint-disable @typescript-eslint/no-require-imports -- Node-only recovery tooling. */
const fs = require('node:fs');
const {TextDecoder} = require('node:util');
const recovery = require('./lib/main-isolated-recovery.cjs');

try {
  if (process.cwd() !== 'D:\\FLSD-Batch7-Validation') throw new Error();
  const [action, first, second, third] = process.argv.slice(2);
  if (action === 'manifest') {
    process.stdout.write(recovery.manifestSql());
  } else if (action === 'restore-body') {
    const safeArtifact = path => {
      const expected = /^artifacts[\\/]main-adapter-recovery-75435c87-0a31-42b7-9761-738db6c5c866\.(toc|data\.sql)$/;
      if (!expected.test(path) || !fs.lstatSync(path).isFile() || fs.lstatSync(path).size > 32 * 1024 ** 2) throw new Error();
      return new TextDecoder('utf-8',{fatal:true}).decode(fs.readFileSync(path));
    };
    recovery.validateArchiveList(safeArtifact(first),third);
    const ddl=recovery.recoveryDdl(fs.readFileSync('prisma/disposable-main-adapter.sql'),'b813e743-9f4c-4121-b8ab-b01ca51b9335');
    const body = ddl + '\n' + recovery.selectedCopyBlocks(safeArtifact(second)) + '\n';
    const fd = fs.openSync(`artifacts/main-adapter-recovery-${recovery.runId}.body.sql`,'wx',0o600);
    try { fs.writeFileSync(fd,body,'utf8'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } else {
    throw new Error();
  }
} catch {
  console.error('Recovery input or archive refused; preserve the artifacts.');
  process.exitCode = 1;
}
