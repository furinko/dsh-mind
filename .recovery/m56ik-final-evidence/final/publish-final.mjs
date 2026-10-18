import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, renameSync, realpathSync } from 'node:fs';
import { join, resolve, dirname, sep } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
const source = 'C:/Users/wjthq/.dsh/plugins/dsh-mind', stage = resolve(import.meta.dirname, '..');
const files = ['src/intervention.js', 'src/council.js', 'lib/actions.js',
  'test/v2-council-managed-2026-10-18.test.js', 'test/v2-council-entry-recovery-2026-10-18.test.js',
  'test/v2-council-failure-cleanup-2026-10-18.test.js', 'test/policy-check-task-context-2026-10-18.test.js',
  'test/fix-batch3-design-2026-10-15.test.js'];
const digest = (p) => existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex') : null;
const manifestPath = join(import.meta.dirname, 'final-publication-plan.json');
function targetOf(rel) {
  if (!files.includes(rel)) throw new Error('Path is outside reviewed publication list');
  const target = resolve(source, rel), parent = realpathSync(dirname(target));
  if (!target.startsWith(`${resolve(source)}${sep}`) || !parent.startsWith(`${realpathSync(source)}${sep}`)) throw new Error(`Unexpected target ${target}`);
  return target;
}
if (process.argv[2] === 'prepare') {
  if (existsSync(manifestPath)) throw new Error('Do not overwrite frozen publication plan');
  const rows = files.map(rel => {
    const target = targetOf(rel), original = digest(target), next = digest(join(stage, rel));
    if (!next) throw new Error(`Missing staged file ${rel}`);
    if (original) {
      const backup = join(import.meta.dirname, 'final-live-before', rel);
      mkdirSync(dirname(backup), { recursive: true }); copyFileSync(target, backup);
      if (digest(backup) !== original) throw new Error('Backup mismatch');
    }
    return { rel, original, next };
  });
  writeFileSync(manifestPath, JSON.stringify({ at: new Date().toISOString(), source, stage, rows }, null, 2));
  console.log('Prepared eight-file baseline and byte backups; live source untouched.');
} else if (process.argv[2] === 'apply') {
  const plan = JSON.parse(readFileSync(manifestPath, 'utf8'));
  if (plan.source !== source || plan.stage !== stage || plan.rows.length !== files.length) throw new Error('Publication roots drift');
  const gates = JSON.parse(readFileSync(join(import.meta.dirname, 'gate-results.json'), 'utf8'));
  if (gates.root !== stage || gates.results.length !== 5 || gates.results.some(x => x.status !== 0 || x.error)) throw new Error('All five final gates must be green');
  const mutations = JSON.parse(readFileSync(join(import.meta.dirname, 'final-mutation-results.json'), 'utf8'));
  if (mutations.root !== stage || !mutations.unchanged || mutations.results.length !== 17 || mutations.results.some(x => !x.caught)) throw new Error('All seventeen final mutations must be caught');
  for (const [rel, sha] of Object.entries(mutations.after)) if (digest(join(stage, rel)) !== sha) throw new Error(`Source changed after mutation calibration ${rel}`);
  for (const row of plan.rows) {
    if (digest(targetOf(row.rel)) !== row.original) throw new Error(`Concurrent live writer ${row.rel}`);
    if (digest(join(stage, row.rel)) !== row.next) throw new Error(`Staged source drift ${row.rel}`);
  }
  const prepared = plan.rows.map(row => {
    const target = targetOf(row.rel), temp = join(dirname(target), `._m56ik-final-${randomUUID()}.tmp`);
    copyFileSync(join(stage, row.rel), temp);
    if (digest(temp) !== row.next) throw new Error('Prepared byte mismatch');
    return { ...row, target, temp };
  });
  for (const row of prepared) {
    if (targetOf(row.rel) !== row.target || dirname(row.temp) !== dirname(row.target) || digest(row.target) !== row.original) throw new Error(`Publication path changed ${row.rel}`);
    renameSync(row.temp, row.target);
    if (digest(row.target) !== row.next) throw new Error(`Published byte mismatch ${row.rel}`);
  }
  writeFileSync(join(import.meta.dirname, 'final-publication-result.json'), JSON.stringify({ at: new Date().toISOString(), source, stage, rows: plan.rows }, null, 2), { flag: 'wx' });
  console.log('Published eight complete reviewed files; runtime acceptance remains pending.');
} else throw new Error('Use prepare or apply');
