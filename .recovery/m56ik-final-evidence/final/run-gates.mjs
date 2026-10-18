import { spawnSync } from 'node:child_process';
import { openSync, closeSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve(import.meta.dirname, '..');
const gates = [
  ['preflight', ['test/preflight.mjs']],
  ['root-tests', ['--test', 'test/*.test.js']],
  ['board-tests', ['--test', 'components/board/test/*.test.js']],
  ['client-harness', ['components/board/test/client-harness.mjs']],
  ['install-selftest', ['scripts/verify-profile-install.mjs', '--selftest']],
];
const results = [];
for (const [name, args] of gates) {
  const log = join(import.meta.dirname, `${name}.log`);
  const fd = openSync(log, 'w');
  const run = spawnSync(process.execPath, args, { cwd: root, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const result = { name, status: run.status, signal: run.signal, error: run.error?.message ?? null, log };
  results.push(result);
  console.log(JSON.stringify(result));
}
writeFileSync(join(import.meta.dirname, 'gate-results.json'), `${JSON.stringify({ at: new Date().toISOString(), root, results }, null, 2)}\n`);
process.exitCode = results.every((x) => x.status === 0 && !x.error) ? 0 : 1;
