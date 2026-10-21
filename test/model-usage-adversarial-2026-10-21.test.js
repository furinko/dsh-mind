/** 独立模型观察反例：隔离 Org + 真服务 + 宿主帧合同；不创建 Agent 或调用模型。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { createModelUsageHooks } from '../components/kernel/lib/model-usage-hooks.js';
import { readTextOrNull } from '../src/kernel/fsx.js';

const P = 'model-usage-independent-adversarial';
const Q = `${P}-other`;
const SECRET = 'MODEL_PRIVATE_TEXT_MUST_NOT_ENTER_OBSERVATION_LEDGER';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function scene(body) {
  const f = await makeFixture();
  let hooks;
  try {
    const cwd = join(f.home, 'work'), other = join(f.home, 'other-project'); await mkdir(cwd); await mkdir(other);
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const goal = await org.goals.create({ subject: LEAD, 项目: P, 期望结果: '如实观察已报告用量',
      完成依据: ['观察可核对'], 来源: '明确意图的未核验转述', 下一步: '执行当前调查' });
    const task = async ({ instance = MEMBER.id, role = MEMBER.roleId, linked = true, targetGoal = goal } = {}) => {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '模型观察隔离任务', 负责人: role, 判据: ['调查可追溯'] });
      if (linked) {
        const current = await org.goals.get(targetGoal.id, { subject: LEAD, 项目: P });
        await org.goals.linkTask(targetGoal.id, { subject: LEAD, 项目: P, 修订: current.修订, 任务: node.id });
      }
      await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: instance, 岗位: role });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      return node;
    };
    const source = await task();
    const agent = (id = MEMBER.id, directory = cwd) => ({ id, session: { id,
      header: { cwd: directory, origin: 'subagent', parentSession: LEAD.id, delegationDepth: 1 } },
      options: { provider: 'configured-provider-hint', model: 'configured-model-hint' } });
    const warnings = [];
    hooks = createModelUsageHooks({ org, projectOf: ({ agent }) => agent.session.header.cwd === cwd ? P : Q,
      logger: { warn: message => warnings.push(message) } });
    const revisions = new WeakMap();
    const send = (owner, frame) => { assert.equal(hooks.observe({ agent: owner, frame }), undefined, 'emit观察回调同步返回，不以Promise阻塞业务'); return frame; };
    const driver = (owner, attemptId = `${owner.session.id}:1`, { turn = 1, step = 0, extra = {} } = {}) => {
      const revision = () => { const next = (revisions.get(owner) ?? 0) + 1; revisions.set(owner, next); return next; };
      let index = 0;
      const start = send(owner, { type: 'start', attemptId, revision: revision(), turn, step, ...extra });
      const chunk = (value, time = 100) => send(owner, { type: 'chunk', attemptId, revision: revision(), index: index++, time, chunk: value });
      return { owner, start, chunk, sample: (usage, time) => chunk({ type: 'usage', usage }, time),
        finish: (kind = 'stop', details = {}) => chunk({ type: 'finish', reason: { kind, ...details } }),
        end: (outcome = { kind: 'committed', eventType: 'assistant/message', seq: 21 }) => send(owner, { type: 'end', attemptId, revision: revision(), index, outcome }) };
    };
    const query = (extra = {}) => org.modelUsage.query({ subject: LEAD, 项目: P, ...extra });
    const ledger = () => readTextOrNull(f.layout.modelUsageLog(P));
    await body({ f, org, hooks, goal, source, task, cwd, other, agent, driver, send, query, ledger, warnings });
  } finally { await hooks?.flush(); await f.cleanup(); }
}

describe('独立模型观察：生命周期、快照与结束', { timeout: 60_000 }, () => {
  it('同真实Agent重复帧只记一次，新Agent同session+attemptId和revision从1开始仍是另一尝试', async () => scene(async ({ hooks, agent, driver, send, query }) => {
    const firstAgent = agent(); const first = driver(firstAgent);
    send(firstAgent, first.start);
    const sample = first.sample({ inputTokens: 8, outputTokens: 2 }); send(firstAgent, sample);
    first.finish(); const end = first.end(); send(firstAgent, end);
    const replacement = agent(); const second = driver(replacement);
    assert.equal(second.start.attemptId, first.start.attemptId); assert.equal(second.start.revision, 1);
    second.sample({ inputTokens: 3, outputTokens: 1 }); second.finish(); second.end();
    await hooks.flush();
    const view = await query(); assert.equal(view.汇总.尝试, 2); assert.equal(view.汇总.已结束, 2);
    const [a, b] = view.尝试页.条目;
    assert.notEqual(a.生命周期, b.生命周期); assert.notEqual(a.执行键, b.执行键);
    assert.equal(view.汇总.已报告token.inputTokens, 11); assert.equal(view.汇总.已报告token.outputTokens, 3);
  }));

  it('累计usage取最后合法快照，缓存和推理分列，缺失字段不推导为0或总费用', async () => scene(async ({ hooks, agent, driver, query }) => {
    const d = driver(agent());
    d.sample({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 6, cacheWriteTokens: 2, reasoningTokens: 3, totalTokens: 22 }, 100);
    const latest = { inputTokens: 12, outputTokens: 5, cacheReadTokens: 7, cacheWriteTokens: 3, reasoningTokens: 4, totalTokens: 27 };
    d.sample(latest, 99); // 墙钟回拨不改变index/revision顺序。
    d.finish('max-tokens'); d.end(); await hooks.flush();
    const view = await query(); assert.deepEqual(view.汇总.已报告token, latest);
    assert.equal(view.尝试页.条目[0].样本数, 2); assert.equal(view.尝试页.条目[0].最后用量time, 99);
    assert.equal(view.尝试页.条目[0].finish, 'max-tokens');
    assert.equal(view.token, null); assert.equal(view.费用, null); assert.equal(view.完整, false);
    const noTotal = driver(agent(), 'member-a:without-total'); noTotal.sample({ inputTokens: 2, outputTokens: 0 }); noTotal.end({ kind: 'abandoned' });
    await hooks.flush();
    const next = await query(); const item = next.尝试页.条目.find(row => row.attemptId === 'member-a:without-total');
    assert.equal(item.usage.outputTokens, 0, '明确报告0仍为已知值');
    for (const field of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) assert.equal(item.usage[field], null);
    assert.deepEqual(next.汇总.字段覆盖.totalTokens, { 已知: 1, 缺失: 1 });
    assert.equal(next.汇总.已报告token.totalTokens, 27, '仅已报告小计，不能把缺失total自算后混入');
  }));

  it('失败和abandoned仍保留usage，无end/无usage均保持未知，message提交不映射业务成功', async () => scene(async ({ hooks, agent, driver, query }) => {
    const owner = agent();
    const failed = driver(owner, 'member-a:failed'); failed.sample({ inputTokens: 7, outputTokens: 3 });
    failed.finish('error', { failure: { code: 'TEST_ERROR', message: SECRET } }); failed.end({ kind: 'committed', eventType: 'assistant/attempt', seq: 31 });
    const abandoned = driver(owner, 'member-a:abandoned'); abandoned.sample({ inputTokens: 2, outputTokens: 1 }); abandoned.end({ kind: 'abandoned' });
    const noUsage = driver(owner, 'member-a:no-usage'); noUsage.end({ kind: 'committed', eventType: 'assistant/message', seq: 32 });
    const open = driver(owner, 'member-a:open'); open.sample({ inputTokens: 4, outputTokens: 2 });
    await hooks.flush();
    const view = await query(); assert.equal(view.汇总.尝试, 4); assert.equal(view.汇总.已结束, 3); assert.equal(view.汇总.未结束, 1);
    assert.equal(view.汇总.有用量, 3); assert.equal(view.汇总.无用量, 1);
    assert.equal(view.汇总.已报告token.inputTokens, 13); assert.equal(view.汇总.已报告token.totalTokens, null);
    const failedRow = view.尝试页.条目.find(row => row.attemptId === 'member-a:failed'); assert.equal(failedRow.finish, 'error');
    const message = view.尝试页.条目.find(row => row.attemptId === 'member-a:no-usage');
    assert.equal(message.usage, null); assert.equal(message.finish, null); assert.equal(Object.hasOwn(message, '成功'), false);
    assert.ok(!JSON.stringify(view).includes(SECRET));
  }));

  it('正文、推理、工具参数和finish错误原文不进账，真实对象形式finish只留kind', async () => scene(async ({ hooks, agent, driver, query, ledger }) => {
    const d = driver(agent(), 'member-a:private-content', { extra: { body: SECRET } });
    d.chunk({ type: 'text-delta', index: 0, text: SECRET });
    d.chunk({ type: 'reasoning-delta', index: 1, text: `${SECRET}-reasoning` });
    d.chunk({ type: 'tool-call-delta', index: 2, id: 'call-private', name: 'read', argumentsDelta: JSON.stringify({ file_path: SECRET }) });
    d.sample({ inputTokens: 5, outputTokens: 2 });
    d.finish('aborted', { failure: { code: 'TEST_ABORT', message: `${SECRET}-error` } }); d.end({ kind: 'abandoned' });
    await hooks.flush(); const view = await query();
    assert.equal(view.尝试页.条目[0].finish, 'aborted'); assert.equal(view.尝试页.条目[0].样本数, 1);
    assert.ok(!(await ledger()).includes(SECRET)); assert.ok(!JSON.stringify(view).includes(SECRET));
  }));

  it('finish后多余chunk、全局revision倒退、孤立帧和冲突重放不污染原样本', async () => scene(async ({ hooks, agent, driver, send, query }) => {
    const owner = agent(); const d = driver(owner); d.sample({ inputTokens: 3, outputTokens: 1 }); const finish = d.finish();
    send(owner, { type: 'chunk', attemptId: d.start.attemptId, revision: finish.revision + 1, index: 2, time: 100, chunk: { type: 'usage', usage: { inputTokens: 999, outputTokens: 999 } } });
    d.end();
    send(owner, { type: 'chunk', attemptId: 'nonexistent', revision: 500, index: 0, time: 1, chunk: { type: 'usage', usage: { inputTokens: 900, outputTokens: 1 } } });
    send(owner, { ...d.start, turn: 999 });
    send(owner, { type: 'start', attemptId: 'old-global-revision', revision: 1, turn: 99, step: 0 });
    await hooks.flush(); const view = await query();
    assert.equal(view.汇总.尝试, 1); assert.equal(view.汇总.已报告token.inputTokens, 3);
    assert.ok(hooks.health().invalidFrames >= 3); assert.ok(hooks.health().orphanFrames >= 1);
  }));
});

describe('独立模型观察：真实归因与污染隔离', { timeout: 60_000 }, () => {
  it('开始归因冻结：后来添加未关联任务或改变进展，不重签旧尝试；新尝试诚实未知', async () => scene(async ({ hooks, org, goal, task, agent, driver, query }) => {
    const owner = agent(); const old = driver(owner, 'member-a:before-change');
    let current = await org.goals.get(goal.id, { subject: LEAD, 项目: P });
    await org.goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: current.修订, 状态: '进行中', 下一步: '改变进展不改旧观察归因' });
    await task({ linked: false });
    old.sample({ inputTokens: 4, outputTokens: 1 }); old.end();
    const fresh = driver(owner, 'member-a:after-change'); fresh.sample({ inputTokens: 2, outputTokens: 1 }); fresh.end();
    await hooks.flush(); const view = await query();
    assert.equal(view.尝试页.条目.find(row => row.attemptId === old.start.attemptId).归因.目标, goal.id);
    assert.equal(view.尝试页.条目.find(row => row.attemptId === fresh.start.attemptId).归因.目标, null);
    assert.equal((await query({ id: goal.id })).汇总.尝试, 1);
  }));

  it('先无任务开始后补绑定，不补造旧归因；失效身份开始仍观察为未知，已开始迟到帧不丢', async () => scene(async ({ hooks, org, goal, source, agent, driver, query }) => {
    const unbound = agent('member-b'); const first = driver(unbound, 'member-b:unbound');
    await org.tasks.bind(source.id, { subject: LEAD, 项目: P, 实例: 'member-b', 岗位: MEMBER.roleId });
    first.sample({ inputTokens: 3, outputTokens: 1 }); first.end();
    const owner = agent(); const beforeSeal = driver(owner, 'member-a:before-seal');
    await org.registry.seal({ subject: LEAD, 实例: MEMBER.id, 理由: '观察不删除旧用量' });
    beforeSeal.sample({ inputTokens: 2, outputTokens: 1 }); beforeSeal.end();
    const afterSeal = driver(owner, 'member-a:after-seal'); afterSeal.sample({ inputTokens: 1, outputTokens: 1 }); afterSeal.end();
    await hooks.flush(); const rows = (await query()).尝试页.条目;
    assert.equal(rows.find(row => row.attemptId === first.start.attemptId).归因.目标, null);
    assert.equal(rows.find(row => row.attemptId === beforeSeal.start.attemptId).归因.目标, goal.id);
    assert.equal(rows.find(row => row.attemptId === afterSeal.start.attemptId).归因.目标, null);
    assert.equal(rows.length, 3); assert.equal((await query()).汇总.已报告token.inputTokens, 6);
  }));

  it('复核员按自己的活动关联任务可归因，会审和Lead保持未知', async () => scene(async ({ hooks, org, goal, task, agent, driver, query, cwd }) => {
    await task({ instance: 'reviewer', role: '复核员' });
    const reviewer = driver(agent('reviewer'), 'reviewer:1'); reviewer.sample({ inputTokens: 2, outputTokens: 1 }); reviewer.end();
    await org.registry.assign({ subject: LEAD, 实例: 'council-member', 岗位: MEMBER.roleId, 会审: { id: 'model-council', 项目: P, 资料: [] } });
    const council = driver(agent('council-member'), 'council-member:1'); council.end({ kind: 'abandoned' });
    const lead = { id: LEAD.id, session: { id: LEAD.id, header: { cwd } }, options: { provider: 'lead-hint', model: 'lead-model' } };
    driver(lead, 'lead:1').end();
    await hooks.flush(); const rows = (await query()).尝试页.条目;
    assert.equal(rows.find(row => row.会话 === 'reviewer').归因.目标, goal.id);
    assert.equal(rows.find(row => row.会话 === 'council-member').归因.目标, null);
    assert.equal(rows.find(row => row.会话 === LEAD.id).归因.目标, null);
  }));

  for (const drift of ['会话', '项目']) {
    it(`${drift}漂移不能污染已开始的尝试，恢复真实上下文后仍只接受原index`, async () => scene(async ({ hooks, agent, driver, send, other, query, f }) => {
      const owner = agent(); const d = driver(owner);
      const priorSession = owner.session.id, priorCwd = owner.session.header.cwd;
      if (drift === '会话') owner.session.id = 'other-session'; else owner.session.header.cwd = other;
      const frame = { type: 'chunk', attemptId: d.start.attemptId, revision: 2, index: 0, time: 100,
        chunk: { type: 'usage', usage: { inputTokens: 900, outputTokens: 100 } } };
      send(owner, frame);
      owner.session.id = priorSession; owner.session.header.cwd = priorCwd;
      send(owner, { ...frame, revision: 3, chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 1 } } });
      send(owner, { type: 'end', attemptId: d.start.attemptId, revision: 4, index: 1, outcome: { kind: 'abandoned' } });
      await hooks.flush(); const view = await query();
      assert.equal(view.汇总.尝试, 1); assert.equal(view.汇总.已报告token.inputTokens, 4); assert.equal(view.汇总.已结束, 1);
      assert.ok(hooks.health().invalidFrames >= 1); assert.equal(await readTextOrNull(f.layout.modelUsageLog(Q)), null);
    }));
  }

  it('非法计量不能覆盖合法快照，未知usage不补零；坏账失败不抛给业务', async () => scene(async ({ hooks, org, agent, driver, query, ledger, f }) => {
    const d = driver(agent()); d.sample({ inputTokens: 3, outputTokens: 1 }); await hooks.flush();
    d.sample({ inputTokens: -1, outputTokens: 999, totalTokens: 0 }); await hooks.flush();
    let view = await query(); assert.equal(view.汇总.已报告token.inputTokens, 3); assert.equal(view.尝试页.条目[0].样本数, 1);
    assert.ok(hooks.health().failedWrites >= 1);
    const empty = driver(agent('member-b'), 'member-b:no-usage'); empty.end(); await hooks.flush();
    view = await query(); assert.equal(view.汇总.无用量, 1); assert.equal(view.尝试页.条目.find(row => row.会话 === 'member-b').usage, null);
    const before = await ledger(); await writeFile(f.layout.modelUsageLog(P), `${before}{broken`);
    let business = 0; assert.doesNotThrow(() => { const next = driver(agent(), 'member-a:broken-ledger'); next.sample({ inputTokens: 100, outputTokens: 10 }); business++; });
    await hooks.flush(); assert.equal(business, 1); assert.equal(await ledger(), `${before}{broken`);
    assert.equal(org.modelUsage.summary(P).健康, '不可用'); assert.equal(org.modelUsage.summary(P).汇总.尝试, null);
    await assert.rejects(query(), error => error?.code === 'MODEL_USAGE_LEDGER_INVALID');
    await writeFile(f.layout.modelUsageLog(P), before);
  }));

  it('原始持久写失败和告警异常均不抛模型回调，后续不伪补该尝试', async () => scene(async ({ org, agent, query }) => {
    const start = org.modelUsage.recordStart;
    org.modelUsage.recordStart = async () => { throw Error(SECRET); };
    const capture = createModelUsageHooks({ org, projectOf: () => P, logger: { warn() { throw Error('logger failure'); } } });
    const owner = agent(); let continued = 0;
    try {
      assert.doesNotThrow(() => {
        capture.observe({ agent: owner, frame: { type: 'start', attemptId: 'failed-start', revision: 1, turn: 1, step: 0 } });
        capture.observe({ agent: owner, frame: { type: 'chunk', attemptId: 'failed-start', revision: 2, index: 0, time: 1, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 1 } } } });
        capture.observe({ agent: owner, frame: { type: 'end', attemptId: 'failed-start', revision: 3, index: 1, outcome: { kind: 'abandoned' } } });
        continued++;
      });
      await capture.flush(); assert.equal(continued, 1); assert.equal(capture.health().failedWrites, 1);
      assert.equal((await query()).汇总.尝试, 0); assert.equal((await query()).汇总.已报告token.inputTokens, null);
    } finally { org.modelUsage.recordStart = start; await capture.flush(); }
  }));

  it('并发Agent落线不丢样本，分页不缩小分母且不向成员放开读域', async () => scene(async ({ hooks, agent, driver, query, org }) => {
    const attempts = Array.from({ length: 7 }, (_, index) => driver(agent(), `same-session-concurrent:${index}`));
    for (const d of attempts) { d.sample({ inputTokens: 2, outputTokens: 1 }); d.end(); }
    await hooks.flush();
    const first = await query({ 条数: 2, 偏移: 0 }); const second = await query({ 条数: 2, 偏移: 2 });
    assert.equal(first.汇总.尝试, 7); assert.equal(first.汇总.已报告token.inputTokens, 14);
    assert.deepEqual(second.汇总, first.汇总); assert.equal(first.尝试页.总数, 7); assert.equal(first.尝试页.hasMore, true);
    assert.equal(new Set([...first.尝试页.条目, ...second.尝试页.条目].map(row => row.执行键)).size, 4);
    await assert.rejects(org.modelUsage.query({ subject: MEMBER, 项目: P }), error => error?.code === 'DENIED');
    await assert.rejects(query({ 条数: 51 }), error => error?.code === 'INVALID_BODY');
  }));
});

describe('独立模型观察：有界hook状态', { timeout: 60_000 }, () => {
  it('closed索引淘汰后旧start不能重算，真实新Agent仍可从1开始', async () => scene(async ({ org, hooks, agent, driver, send }) => {
    const recordStart = org.modelUsage.recordStart, recordEnd = org.modelUsage.recordEnd;
    const starts = [];
    org.modelUsage.recordStart = async spec => { starts.push(spec); };
    org.modelUsage.recordEnd = async () => {};
    try {
      const owner = agent(); let oldStart;
      for (let index = 0; index < 129; index++) { const d = driver(owner, `member-a:${index + 1}`); if (!index) oldStart = d.start; d.end(); }
      await hooks.flush(); assert.equal(starts.length, 129);
      send(owner, oldStart); await hooks.flush(); assert.equal(starts.length, 129);
      const replacement = driver(agent(), oldStart.attemptId); replacement.end(); await hooks.flush(); assert.equal(starts.length, 130);
      assert.notEqual(starts[0].生命周期, starts.at(-1).生命周期);
    } finally { await hooks.flush(); org.modelUsage.recordStart = recordStart; org.modelUsage.recordEnd = recordEnd; }
  }));

  it('持久化卡住时1024队列上限拒继续积压，丢帧明确计缺口且业务继续', async () => scene(async ({ org, hooks, agent, driver }) => {
    const recordStart = org.modelUsage.recordStart, recordSample = org.modelUsage.recordSample, recordEnd = org.modelUsage.recordEnd;
    const blocker = deferred(); let samples = 0;
    org.modelUsage.recordStart = () => blocker.promise;
    org.modelUsage.recordSample = async () => { samples++; };
    org.modelUsage.recordEnd = async () => {};
    try {
      const d = driver(agent()); await Promise.resolve(); let business = 0;
      assert.doesNotThrow(() => { for (let index = 0; index < 1030; index++) d.sample({ inputTokens: index, outputTokens: 1 }); d.end(); business++; });
      assert.equal(business, 1); assert.ok(hooks.health().droppedWrites > 0);
      blocker.resolve(); await hooks.flush(); assert.equal(samples, 0, '超界尝试后续不补造成功持久化');
    } finally { blocker.resolve(); await hooks.flush(); org.modelUsage.recordStart = recordStart; org.modelUsage.recordSample = recordSample; org.modelUsage.recordEnd = recordEnd; }
  }));
});
