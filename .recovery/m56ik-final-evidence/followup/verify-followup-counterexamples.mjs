import { cpSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const cases = [
  { name: 'review-parent-gap', file: 'components/kernel/lib/index.js', old: ' || (递归搜索 && 在目录内(规范私有, 规范目标))', next: '', test: 'test/guard-reviewer-readonly-2026-10-18.test.js', pattern: '合法授予私有区父目录' },
  { name: 'preflight-context-dropped', file: 'lib/actions.js', old: 'context: 任务 ? { task: 任务 } : {},', next: 'context: {},', test: 'test/policy-check-task-context-2026-10-18.test.js', pattern: 'policy_check' },
];
const hash = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');
const before = cases.map((c) => hash(join(root, c.file)));
const results = [];
for (const c of cases) {
  const clone = mkdtempSync(join(tmpdir(), 'dsh-mind-followup-mutant-'));
  cpSync(root, clone, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes('.recovery') });
  const path = join(clone, c.file), text = readFileSync(path, 'utf8');
  if (text.split(c.old).length !== 2) throw new Error(`Anchor not unique: ${c.name}`);
  writeFileSync(path, text.replace(c.old, c.next));
  const log = join(import.meta.dirname, `${c.name}.log`), fd = openSync(log, 'w');
  const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=${c.pattern}`, c.test], { cwd: clone, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const output = readFileSync(log, 'utf8');
  results.push({ name: c.name, clone, log, caught: run.status === 1 && output.includes('ERR_ASSERTION') && /fail [1-9]/.test(output) });
}
const unchanged = cases.every((c, i) => hash(join(root, c.file)) === before[i]);
writeFileSync(join(import.meta.dirname, 'followup-counterexamples.json'), JSON.stringify({ results, unchanged }, null, 2));
console.log(JSON.stringify({ results, unchanged }));
if (!unchanged || results.some((x) => !x.caught)) process.exitCode = 1;
