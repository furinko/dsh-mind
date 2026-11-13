/** Preserve one-process-per-file isolation without Node test workers' captured pipes.
 * Child permissions do not change. TAP is written by the public Node reporter,
 * not captured via child stdio. Keep every report, including environment failures.
 * node test/run-inherited-stdio.mjs <new-output-directory> [test-globs ...]
 */
import { globSync, mkdirSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { spawn } from 'node:child_process';

const directory = resolve(process.argv[2] ?? `.w37-tests-${Date.now()}`);
const patterns = process.argv.slice(3);
if (!patterns.length) patterns.push('test/*.test.js', 'components/board/test/*.test.js');
const files = [...new Set(globSync(patterns))].sort();
if (!files.length) throw new Error('No test files selected');
mkdirSync(directory); // refuse to overwrite any previous run
const startedAt = new Date().toISOString();
const results = [];
let cursor = 0;
async function run(file) {
  const report = join(directory, file.replaceAll(/[\\/]/g, '__') + '.tap');
  const started = Date.now();
  const outcome = await new Promise(resolveResult => {
    const child = spawn(process.execPath, ['--experimental-test-isolation=none', '--test', '--test-timeout=120000',
      '--test-reporter=tap', `--test-reporter-destination=${report}`, file], { stdio: 'inherit', windowsHide: true });
    child.once('error', error => resolveResult({ exitCode: null, error: error.code ?? error.message }));
    child.once('exit', (exitCode, signal) => resolveResult({ exitCode, ...(signal ? { signal } : {}) }));
  });
  let text = '';
  try { text = await readFile(report, 'utf8'); } catch (error) { outcome.reportError = error.code ?? error.message; }
  const counts = {};
  for (const key of ['tests', 'pass', 'fail', 'cancelled', 'skipped']) {
    const values = [...text.matchAll(new RegExp(`^# ${key} (\\d+)\\r?$`, 'gm'))];
    counts[key] = values.length ? Number(values.at(-1)[1]) : null;
  }
  const row = { file, ...outcome, ...counts, report, durationMs: Date.now() - started };
  results.push(row);
  console.log(JSON.stringify(row));
}
await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
  while (cursor < files.length) await run(files[cursor++]);
}));
const totals = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(key => [key,
  results.reduce((sum, row) => sum + (row[key] ?? 0), 0)]));
const failedFiles = results.filter(row => row.exitCode !== 0 || row.tests === null || row.fail !== 0 || row.cancelled !== 0);
const summary = { node: process.version, startedAt, finishedAt: new Date().toISOString(), patterns,
  concurrency: Math.min(4, files.length), fileCount: files.length, totals, failedFiles, results };
await writeFile(join(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify({ fileCount: files.length, totals, failedFiles: failedFiles.map(row => row.file), directory }));
if (failedFiles.length) process.exitCode = 1;
