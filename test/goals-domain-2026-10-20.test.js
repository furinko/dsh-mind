/** 目标独立真源、用户控制、冻结修订、任务证据与同步约束。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { GoalService } from '../src/goals.js';
import { parseGoalLedger, readGoalLedger, readGoalLedgerSync, foldGoalLedger, constraintsForTaskInSnapshot } from '../src/goal-ledger.js';
import { Denied, Fault, InvalidBody } from '../src/kernel/errors.js';

const P = 'goals-domain';
const BASE = { subject: LEAD, 项目: P, 期望结果: '交付可复验的修复', 约束: ['保留证据'], 禁止工具: [], 完成依据: ['独立复核通过'], 来源: '调用者对用户当前要求的转述', 下一步: '建立执行任务' };
const invalid = (error) => error instanceof Denied || error instanceof InvalidBody || error instanceof Fault;

async function scene(run) {
  const f = await makeFixture();
  try {
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, registry: f.registry });
    const goals = tasks.goals;
    let serial = 0;
    const create = (extra = {}) => goals.create({ ...BASE, 请求键: `domain-${++serial}`, ...extra });
    const task = (extra = {}) => tasks.create({ subject: LEAD, 项目: P, 描述: '执行目标相关任务', 负责人: MEMBER.id, 判据: ['交付可验'], ...extra });
    const accepted = async (extra = {}) => {
      const node = await task({ 负责人: LEAD.id });
      await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      await tasks.start(node.id, { subject: LEAD, 项目: P });
      await tasks.submit(node.id, { subject: LEAD, 项目: P, 结论: '已有真实交卷', ...extra });
      const reviewed = await tasks.review(node.id, { subject: SOVEREIGN, 项目: P, 三态: '过' });
      return tasks.accept(node.id, { subject: LEAD, 项目: P, 票: reviewed.待采纳.票 });
    };
    const rows = () => readGoalLedger(f.layout.goalLog(P));
    const link = (goal, node) => goals.linkTask(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 任务: node.id });
    const finish = (goal, node, extra = {}) => goals.complete(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 说明: '逐条核对了当前完成依据', 证据: [node.id], 完成核对: goal.完成依据.map((依据) => ({ 依据, 任务: [node.id] })), ...extra });
    await run({ f, tasks, goals, create, task, accepted, rows, link, finish });
  } finally { await f.cleanup(); }
}

describe('持久目标领域合同', () => {
  it('创建保存未核验来源声明，同规范重启认回真实进展，不重新写目标', async () => scene(async ({ f, tasks, goals, rows }) => {
    const goal = await goals.create(BASE);
    assert.equal(goal.修订, 1);
    assert.deepEqual(goal.来源声明, { 内容: BASE.来源, 用户意图: '未核验' });
    const progressed = await goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: 1, 状态: '等待', 等待原因: '等外部材料' });
    const before = await rows();
    const restored = new GoalService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, registry: f.registry, tasks });
    const retry = await restored.create(BASE);
    assert.equal(retry.幂等, true);
    assert.equal(retry.id, goal.id);
    assert.equal(retry.修订, progressed.修订);
    assert.equal(retry.状态, '等待');
    assert.deepEqual(await rows(), before);
    await assert.rejects(() => goals.create({ ...BASE, 请求键: 'fixed', 期望结果: '' }), invalid);
    await goals.create({ ...BASE, 请求键: 'fixed' });
    await assert.rejects(() => goals.create({ ...BASE, 请求键: 'fixed', 期望结果: '另一个结果' }), (error) => error instanceof Denied);
  }));

  it('成员、自报Lead和来源认证参数不能读取或改变目标，真实主权者正门保留', async () => scene(async ({ goals, create, rows }) => {
    const goal = await create();
    const before = await rows();
    for (const subject of [MEMBER, { id: MEMBER.id, kind: 'Lead' }, { id: 'ghost', kind: 'Lead' }]) {
      await assert.rejects(() => goals.get(goal.id, { subject, 项目: P }), invalid);
      await assert.rejects(() => goals.list({ subject, 项目: P }), invalid);
      await assert.rejects(() => goals.progress(goal.id, { subject, 项目: P, 修订: 1, 状态: '进行中' }), invalid);
    }
    await assert.rejects(() => goals.create({ ...BASE, 认证: '用户亲自确认', role: '主权者' }), (error) => error instanceof InvalidBody);
    assert.equal((await goals.get(goal.id, { subject: SOVEREIGN, 项目: P })).期望结果, BASE.期望结果);
    assert.deepEqual(await rows(), before);
  }));

  it('Lead修订只能增加限制，主权者可修改目标本意与完成依据，原来源历史保留', async () => scene(async ({ goals, create }) => {
    let goal = await create({ 禁止工具: ['edit'] });
    goal = await goals.revise(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 约束: ['保留证据', '不连接外部服务'], 禁止工具: ['edit', 'write'], 来源: '补充执行边界' });
    assert.deepEqual(goal.约束, ['保留证据', '不连接外部服务']);
    for (const change of [{ 期望结果: '改成另一个目标' }, { 完成依据: ['无需复核'] }, { 约束: [] }, { 禁止工具: ['edit'] }]) await assert.rejects(() => goals.revise(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 来源: '普通声明无授权', ...change }), (error) => error instanceof Denied);
    const changed = await goals.revise(goal.id, { subject: SOVEREIGN, 项目: P, 修订: goal.修订, 期望结果: '主权者决定的结果', 完成依据: ['新的完成依据'], 约束: [], 禁止工具: [], 来源: '人侧真实主体作出决定，文本本身仍是声明' });
    assert.equal(changed.期望结果, '主权者决定的结果');
    assert.deepEqual(changed.完成依据, ['新的完成依据']);
    assert.equal(changed.来源历史[0].内容, BASE.来源);
    assert.equal(changed.来源声明.用户意图, '未核验');
  }));

  it('乐观修订与锁内复核：同修订并发只有一个写入，旧计划不能换主体或跟随新修订', async () => scene(async ({ goals, create, rows }) => {
    const goal = await create();
    const spec = { subject: LEAD, 项目: P, id: goal.id, 修订: goal.修订, 状态: '进行中', 下一步: '真实下一步' };
    const plan = await goals.plan('goal_progress', spec);
    assert.equal(Object.isFrozen(plan.事件), true);
    await assert.rejects(() => goals.progress(goal.id, { ...spec, subject: SOVEREIGN, 执行计划: plan }), (error) => error instanceof InvalidBody);
    const results = await Promise.allSettled([goals.progress(goal.id, { ...spec, 执行计划: plan }), goals.progress(goal.id, { ...spec, 下一步: '竞争写者' })]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((await rows()).length, 2);
    await assert.rejects(() => goals.progress(goal.id, { ...spec, 执行计划: plan }), (error) => error instanceof Denied);
  }));

  it('已释放锁的迟到异步后代仍需重新排队，不能继承免锁上下文', async () => scene(async ({ goals }) => {
    let trigger;
    const fired = new Promise((resolve) => { trigger = resolve; });
    let requested;
    const lateRequested = new Promise((resolve) => { requested = resolve; });
    let late;
    let entered = false;
    await goals.withProjectLock(P, async () => {
      late = (async () => { await fired; requested(); await goals.withProjectLock(P, async () => { entered = true; }); })();
    });
    let held;
    const holding = new Promise((resolve) => { held = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const holder = goals.withProjectLock(P, async () => { held(); await gate; });
    await holding;
    trigger();
    await lateRequested;
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(entered, false, '另一个写者持锁期间迟到后代不能进入');
    release();
    await holder;
    await late;
    assert.equal(entered, true);
  }));

  it('计划不能绕过当前封存或policy，读回执计划不能在原创建消失后变成写入', async () => scene(async ({ f, goals, create, rows }) => {
    const goal = await create();
    const spec = { subject: LEAD, 项目: P, id: goal.id, 修订: goal.修订, 状态: '进行中' };
    const plan = await goals.plan('goal_progress', spec);
    await f.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '撤回本轮执行资格' });
    await assert.rejects(() => goals.progress(goal.id, { ...spec, 执行计划: plan }), (error) => error instanceof Denied);
    await f.registry.restore({ subject: SOVEREIGN, 实例: LEAD.id });
    const check = f.policy.check.bind(f.policy);
    f.policy.check = async (input) => { if (input.target.kind === '目标' && input.action === 'write') throw new Denied('当前测试闸', '当前写权已撤回'); return check(input); };
    await assert.rejects(() => goals.progress(goal.id, { ...spec, 执行计划: plan }), /当前写权已撤回/);
    f.policy.check = check;
    const created = await goals.create(BASE);
    const readPlan = await goals.plan('goal_create', BASE);
    assert.equal(readPlan.步骤[0].动作, 'read');
    const kept = (await rows()).filter((row) => row.id !== created.id);
    await writeFile(f.layout.goalLog(P), kept.map((row) => JSON.stringify(row)).join('\n') + '\n');
    await assert.rejects(() => goals.create({ ...BASE, 执行计划: readPlan }), (error) => error instanceof Denied);
    assert.equal((await rows()).some((row) => row.id === created.id), false);
  }));

  it('用户暂停须主权者恢复，Lead可等待/恢复工作等待但不能恢复暂停、取消或完成', async () => scene(async ({ goals, create, accepted, link, finish }) => {
    let goal = await create();
    await assert.rejects(() => goals.setState(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 状态: '暂停' }), (error) => error instanceof Denied);
    goal = await goals.setState(goal.id, { subject: SOVEREIGN, 项目: P, 修订: goal.修订, 状态: '暂停' });
    await assert.rejects(() => goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 状态: '进行中' }), (error) => error instanceof Denied);
    goal = await goals.revise(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 约束: ['保留证据', '暂停时仍可收紧限制'], 来源: '保持暂停' });
    assert.equal(goal.状态, '暂停');
    goal = await goals.setState(goal.id, { subject: SOVEREIGN, 项目: P, 修订: goal.修订, 状态: '进行中' });
    goal = await goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 状态: '等待', 等待原因: '等待材料' });
    goal = await goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 状态: '进行中', 下一步: '材料齐备，继续核验' });
    assert.equal(goal.等待原因, null);
    const done = await accepted();
    goal = await link(goal, done);
    goal = await finish(goal, done);
    assert.equal(goal.状态, '已完成');
    assert.equal(goal.完成判断.机器证明目标语义, false);
    for (const subject of [LEAD, SOVEREIGN]) await assert.rejects(() => goals.setState(goal.id, { subject, 项目: P, 修订: goal.修订, 状态: '进行中' }), (error) => error instanceof Denied);
    let cancelled = await create();
    cancelled = await goals.setState(cancelled.id, { subject: SOVEREIGN, 项目: P, 修订: cancelled.修订, 状态: '取消' });
    await assert.rejects(() => goals.setState(cancelled.id, { subject: SOVEREIGN, 项目: P, 修订: cancelled.修订, 状态: '进行中' }), (error) => error instanceof Denied);
  }));

  it('link只记录精确引用且单任务唯一目标，同目标更新关联修订不复制任务状态', async () => scene(async ({ goals, create, task, rows }) => {
    let a = await create();
    const b = await create();
    const node = await task();
    await assert.rejects(() => goals.linkTask(a.id, { subject: LEAD, 项目: P, 修订: a.修订, 任务: '不存在任务' }), invalid);
    a = await goals.linkTask(a.id, { subject: LEAD, 项目: P, 修订: a.修订, 任务: node.id });
    const before = await rows();
    await assert.rejects(() => goals.linkTask(b.id, { subject: LEAD, 项目: P, 修订: b.修订, 任务: node.id }), invalid);
    assert.deepEqual(await rows(), before);
    a = await goals.linkTask(a.id, { subject: LEAD, 项目: P, 修订: a.修订, 任务: node.id });
    assert.equal(a.任务关联.length, 1);
    assert.equal(a.任务关联[0].关联修订, a.修订);
    assert.equal(Object.hasOwn(a.任务关联[0], '状态'), false);
    assert.equal(goals.rawSnapshot(P).任务关联[node.id].关联修订, a.修订);
  }));

  it('正式后继无需新关联即受当前约束，双向重关联不能逃限制', async () => scene(async ({ tasks, goals, create, task, link }) => {
    let a = await create({ 禁止工具: ['edit'] });
    const b = await create();
    const node = await task();
    a = await link(a, node);
    await tasks.close(node.id, { subject: LEAD, 项目: P, 原因: '重新执行' });
    const next = await tasks.createSuccessor(node.id, { subject: LEAD, 项目: P, 原因: '相同冻结标准接续', 负责人: MEMBER.id });
    const nodes = await tasks.list({ 项目: P });
    const constraint = goals.constraintsForTask(next.节点, nodes, P);
    assert.equal(constraint.目标, a.id);
    assert.equal(constraint.来源任务, node.id);
    assert.equal(constraint.直接关联, false);
    assert.deepEqual(constraint.禁止工具, ['edit']);
    await assert.rejects(() => goals.linkTask(b.id, { subject: LEAD, 项目: P, 修订: b.修订, 任务: next.节点.id }), invalid);
    a = await goals.revise(a.id, { subject: LEAD, 项目: P, 修订: a.修订, 禁止工具: ['edit', 'write'], 来源: '动态收紧' });
    assert.deepEqual(goals.constraintsForTask(next.节点, nodes, P).禁止工具, ['edit', 'write']);
  }));

  it('前序缺失/环或跨目标重叠时纯约束读取保守拒绝，不生成空范围', async () => scene(async ({ goals, create, task, link }) => {
    let a = await create();
    let b = await create();
    const x = await task({ 描述: 'a' });
    const y = await task({ 描述: 'b' });
    a = await link(a, x);
    b = await link(b, y);
    const snapshot = goals.rawSnapshot(P);
    assert.throws(() => constraintsForTaskInSnapshot({ ...x, 前序任务: 'missing' }, [x, y], snapshot), (error) => error instanceof Fault);
    assert.throws(() => constraintsForTaskInSnapshot({ ...x, 前序任务: y.id }, [{ ...y, 前序任务: x.id }], snapshot), (error) => error instanceof Fault);
    assert.throws(() => constraintsForTaskInSnapshot({ ...y, 前序任务: x.id }, [x, y], snapshot), (error) => error instanceof Fault && error.code === 'GOAL_TASK_LINEAGE_CONFLICT');
  }));

  it('完成必须逐条覆盖依据且所有证据已关联、合法采纳；关联任务数不自动完成', async () => scene(async ({ goals, create, task, accepted, link, finish }) => {
    let goal = await create({ 完成依据: ['标准甲', '标准乙'] });
    const pending = await task();
    goal = await link(goal, pending);
    assert.equal(goal.状态, '进行中');
    await assert.rejects(() => finish(goal, pending), invalid);
    const done = await accepted();
    await assert.rejects(() => finish(goal, done), invalid);
    goal = await link(goal, done);
    await assert.rejects(() => finish(goal, done, { 完成核对: [{ 依据: '标准甲', 任务: [done.id] }] }), (error) => error instanceof InvalidBody);
    const result = await finish(goal, done);
    assert.equal(result.状态, '已完成');
    assert.equal(result.完成判断.完成核对.length, 2);
    assert.equal(result.完成判断.证据事实[0].任务, done.id);
    await assert.rejects(() => goals.linkTask(result.id, { subject: LEAD, 项目: P, 修订: result.修订, 任务: pending.id }), (error) => error instanceof Denied);
  }));

  it('合法采纳后的产物原地变动不能成为完成证据，空产物的真实manifest仍有效', async () => scene(async ({ f, goals, create, accepted, link, finish }) => {
    const file = join(f.home, 'goal-delivery.txt');
    await writeFile(file, '审过的内容');
    const done = await accepted({ 产出物引用: [file] });
    let goal = await create();
    goal = await link(goal, done);
    await writeFile(file, '采纳后改变内容');
    await assert.rejects(() => finish(goal, done), invalid);
    const empty = await accepted();
    let other = await create();
    other = await link(other, empty);
    assert.equal((await finish(other, empty)).状态, '已完成');
  }));

  for (const corrupted of ['json', 'torn', 'unknown', 'revision', 'false-auth', 'bad-state']) it(`严格账本${corrupted}异常使同步/异步读与写均拒且保留原文`, async () => scene(async ({ f, goals, create }) => {
    const goal = await create();
    const file = f.layout.goalLog(P);
    const original = await readFile(file, 'utf8');
    const row = JSON.parse(original.trim());
    let text;
    if (corrupted === 'json') text = original + '{bad}\n';
    if (corrupted === 'torn') text = original.trimEnd();
    if (corrupted === 'unknown') text = original + JSON.stringify({ ...row, seq: 2, kind: 'unknown', 修订: 2 }) + '\n';
    if (corrupted === 'revision') text = original + JSON.stringify({ kind: 'goal_state_changed', id: goal.id, seq: 2, at: row.at, by: SOVEREIGN, 修订: 9, 状态: '暂停' }) + '\n';
    if (corrupted === 'false-auth') { row.来源声明.用户意图 = '已认证'; text = JSON.stringify(row) + '\n'; }
    if (corrupted === 'bad-state') { row.状态 = '已完成'; text = JSON.stringify(row) + '\n'; }
    await writeFile(file, text);
    assert.throws(() => goals.rawSnapshot(P), (error) => error instanceof Fault && error.code === 'GOAL_LEDGER_INVALID');
    await assert.rejects(() => goals.get(goal.id, { subject: LEAD, 项目: P }), (error) => error instanceof Fault);
    await assert.rejects(() => goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 状态: '进行中' }), (error) => error instanceof Fault);
    assert.equal(await readFile(file, 'utf8'), text);
  }));

  it('BOM/CRLF兼容且同步异步一致；返回值不能污染下次约束真源', async () => scene(async ({ f, goals, create }) => {
    await create();
    const file = f.layout.goalLog(P);
    const original = await readFile(file, 'utf8');
    await writeFile(file, '\ufeff' + original.replaceAll('\n', '\r\n'));
    assert.deepEqual(readGoalLedgerSync(file), await readGoalLedger(file));
    const snapshot = goals.rawSnapshot(P);
    snapshot.目标[0].约束.length = 0;
    assert.deepEqual(goals.rawSnapshot(P).目标[0].约束, ['保留证据']);
    assert.equal(foldGoalLedger(parseGoalLedger(await readFile(file, 'utf8'))).size, 1);
  }));

  it('事件后审计失败保留目标id和已提交回执，同规范create只读认回不伪补审计', async () => scene(async ({ f, goals, rows }) => {
    const append = f.audit.append.bind(f.audit);
    let fail = true;
    f.audit.append = async (entry) => { if (fail && entry.依据 === '目标事件流') { fail = false; throw new Error('模拟审计不可写'); } return append(entry); };
    let id;
    await assert.rejects(() => goals.create(BASE), (error) => { assert.equal(error.code, 'GOAL_AUDIT_APPEND_FAILED_AFTER_EVENT'); assert.equal(error.outcome.提交状态, '已提交'); id = error.outcome.已确认阶段[0].对象id; return Boolean(id); });
    assert.equal((await rows()).length, 1);
    let audits = 0;
    f.audit.append = async (entry) => { if (entry.依据 === '目标事件流') audits += 1; return append(entry); };
    assert.equal((await goals.create(BASE)).id, id);
    assert.equal(audits, 0);
    assert.equal((await rows()).length, 1);
  }));

  it('输入与读面有界，硬约束完整保留；list摘要明确总数与hasMore', async () => scene(async ({ goals, create }) => {
    for (const change of [{ 期望结果: 'x'.repeat(4001) }, { 来源: 'x'.repeat(2001) }, { 下一步: 'x'.repeat(2001) }, { 约束: Array.from({ length: 33 }, (_, i) => `约束${i}`) }, { 完成依据: ['x'.repeat(1001)] }, { 禁止工具: ['pwsh'] }, { 约束: '不是数组' }]) await assert.rejects(() => goals.create({ ...BASE, ...change }), (error) => error instanceof InvalidBody);
    const large = await create({ 约束: Array.from({ length: 32 }, (_, i) => `第${i}条` + 'x'.repeat(990)) });
    for (let i = 0; i < 3; i += 1) await create();
    const page = await goals.list({ subject: LEAD, 项目: P, 条数: 2, 偏移: 1 });
    assert.equal(page.目标.length, 2);
    assert.equal(page.总数, 4);
    assert.equal(page.hasMore, true);
    assert.equal(page.摘要, true);
    const detail = await goals.get(large.id, { subject: LEAD, 项目: P });
    assert.equal(detail.约束.length, 32);
    assert.deepEqual(detail.约束, large.约束);
    assert.equal(detail.硬约束完整, true);
  }));
});
