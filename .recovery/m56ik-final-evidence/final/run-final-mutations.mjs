import { cpSync, mkdtempSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
const root = resolve(import.meta.dirname, '..');
const entry = 'test/v2-council-entry-recovery-2026-10-18.test.js';
const failure = 'test/v2-council-failure-cleanup-2026-10-18.test.js';
const direct = 'test/direct-lead-execution.test.js';
const thin = 'test/policy-check-task-context-2026-10-18.test.js';
const cases = [
  { name: 'consult-guard-disabled', file: 'components/kernel/lib/index.js', old: 'function 咨询参与工具闸(exec, 项目, deps) {', next: 'function 咨询参与工具闸(exec, 项目, deps) { return { 命中: false };', test: entry, pattern: '咨询工具闭名单', witness: 'ERR_ASSERTION' },
  { name: 'approval-plan-unwired', file: 'lib/approval-plan.js', old: "    case 'debate_open':\n    case 'debate_converge':\n      return org.council.councilPlan({ 项目, 动作: action, args });\n", next: '', test: entry, pattern: '审批完整链', witness: 'ERR_ASSERTION' },
  { name: 'consult-helper-missing', file: 'components/kernel/lib/index.js', old: 'function 咨询参与工具闸(exec, 项目, deps) {', next: 'function 缺失咨询工具闸(exec, 项目, deps) {', test: entry, pattern: '真实 apply', witness: 'ReferenceError' },
  { name: 'discussion-unwired', file: 'src/council.js', old: '会审: 锁内,', next: '', test: entry, pattern: '真实 apply', witness: 'ERR_ASSERTION' },
  { name: 'review-parent-gap', file: 'components/kernel/lib/index.js', old: ' || (递归搜索 && 在目录内(规范私有, 规范目标))', next: '', test: 'test/guard-reviewer-readonly-2026-10-18.test.js', pattern: '合法授予私有区父目录', witness: 'ERR_ASSERTION' },
  { name: 'preflight-context-dropped', file: 'lib/actions.js', old: 'context: 任务 ? { task: 任务 } : {},', next: 'context: {},', test: thin, pattern: 'policy_check', witness: 'ERR_ASSERTION' },
  { name: 'criteria-binding-dropped', file: 'lib/actions.js', old: '负责人实例名单(节点).includes(subject.id)', next: '(节点.负责人 ?? []).includes(subject.id)', test: thin, pattern: 'task_criteria', witness: '不是节点' },
  { name: 'direct-self-dropped', file: 'src/policy.js', old: " || (id === 'Lead' && 本人自领岗)", next: '', test: direct, pattern: '岗位负责人Lead', witness: '不越授' },
  { name: 'direct-bind-reassign-unwired', file: 'src/policy.js', old: "if (!['create', 'dispatch'].includes(action) && !排兵写) return null;", next: "if (!['create', 'dispatch'].includes(action)) return null;", test: direct, pattern: '派发前后绑定|派发前后改派', witness: 'Missing expected rejection' },
  { name: 'direct-dispatch-stale', file: 'src/tasks.js', old: 'context: { task: nodeInLock },', next: 'context: { task: node },', test: direct, pattern: '排队期间主权者先加绑另一Lead', witness: 'fulfilled' },
  { name: 'abort-finality', file: 'src/council.js', old: "          if (当前?.状态 === '已收敛') {", next: '          if (false) {', test: failure, pattern: '开场发送阻塞后另一Root先收敛', witness: "'作废' !== '已收敛'" },
  { name: 'stop-api-disappearance', file: 'lib/actions.js', old: '  if (响亮) {', next: '  if (false) {', test: failure, pattern: '创建后subagent停机API消失', witness: '缺接口必须有补偿失败证据' },
  { name: 'opened-commit-report', file: 'src/council.js', old: 'opened 事件已落线，但发起审计失败', next: 'opened 事件落线失败', test: failure, pattern: 'opened已落而审计失败', witness: 'ERR_ASSERTION' },
  { name: 'owned-boundary', file: 'src/intervention.js', old: "    if (步.补偿自 != null && (步.动作 !== 'seal' || 步.目标.kind !== '身份'\n      || 放行.新建?.get(`${target?.kind}|${target?.id}`) !== 步.补偿自)) continue;", next: '', test: failure, pattern: '审批成功不执行失败补偿', witness: 'Missing expected rejection' },
  { name: 'assign-audit-cleanup', file: 'lib/actions.js', old: '    const 补偿失败 = await 补偿();', next: '    const 补偿失败 = null;', test: failure, pattern: '登记后主体创建审计失败', witness: "'在岗' !== '封存'" },
  { name: 'committed-retirement', file: 'src/council.js', old: '        onCommitted: (落线后) => { view = 落线后; },', next: '', test: failure, pattern: 'converged后会审收敛审计失败', witness: 'deepStrictEqual' },
  { name: 'member-source-merge', file: 'lib/actions.js', old: '        if (!子.实例) continue;', next: '        if (!子.实例 || rows.has(子.实例)) continue;', test: failure, pattern: 'member_list同id登记与子代合并', witness: "'subagent'" },
];
const hash = (p) => createHash('sha256').update(readFileSync(join(root, p))).digest('hex');
const paths = [...new Set(cases.map(c => c.file))], before = Object.fromEntries(paths.map(p => [p, hash(p)]));
const results = [];
for (const c of cases) {
  const clone = mkdtempSync(join(tmpdir(), 'dsh-mind-final-mutant-'));
  cpSync(root, clone, { recursive: true, filter: p => !p.split(/[\\/]/).some(x => ['.git', '.recovery', 'node_modules'].includes(x)) });
  const target = join(clone, c.file), source = readFileSync(target, 'utf8');
  const old = c.old.replaceAll('\n', source.includes('\r\n') ? '\r\n' : '\n');
  if (source.split(old).length !== 2) throw new Error(`Mutation anchor not unique: ${c.name}`);
  writeFileSync(target, source.replace(old, c.next));
  const log = join(import.meta.dirname, `mutation-${c.name}.log`), fd = openSync(log, 'w');
  const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', '--test-name-pattern', c.pattern, c.test], { cwd: clone, stdio: ['ignore', fd, fd] });
  closeSync(fd);
  const output = readFileSync(log, 'utf8');
  const caught = run.status === 1 && output.includes(c.witness) && output.includes('not ok') && /fail [1-9]/.test(output);
  const result = { name: c.name, status: run.status, caught, witness: c.witness, clone, log };
  results.push(result); console.log(JSON.stringify(result));
}
const after = Object.fromEntries(paths.map(p => [p, hash(p)]));
const unchanged = JSON.stringify(before) === JSON.stringify(after);
writeFileSync(join(import.meta.dirname, 'final-mutation-results.json'), JSON.stringify({ at: new Date().toISOString(), root, node: process.version, results, before, after, unchanged }, null, 2));
if (!unchanged || results.some(x => !x.caught)) process.exitCode = 1;
