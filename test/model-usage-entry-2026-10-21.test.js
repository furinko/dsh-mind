/** 模型只读观察入口；HOST样本仅由隔离夹具调用内部record方法注入，不给模型造数接口。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { Org } from '../src/org.js';
import { shareOrg } from '../src/runtime.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { runAction, ACTIONS, COMMAND_ACTIONS, READ_ONLY_ACTIONS } from '../lib/actions.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'model-usage-entry';
const Q = 'model-usage-other';
const goalSpec = (key, 项目 = P) => ({ subject: LEAD, 项目, 请求键: key, 期望结果: `观察${key}对应目标`, 约束: [], 禁止工具: [], 完成依据: ['证据经过核对'], 来源: '隔离测试目标', 下一步: '安排执行' });
const invalid = e => e instanceof Denied || e instanceof InvalidBody;

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const act = (args, subject = LEAD, 面 = 'tool') => runAction({ org, 项目: P, 主体: subject, subject, 面, args });
    const query = async (args = {}, subject = LEAD) => (await act({ action: 'usage_query', ...args }, subject)).用量;
    const log = (project = P) => readTextOrNull(f.layout.modelUsageLog(project));
    await run({ f, org, act, query, log });
  } finally { await f.cleanup(); }
}

let sequence = 0;
async function start(org, { project = P, goal = null, actor = MEMBER } = {}) {
  const 执行键 = randomUUID();
  const start = { 项目: project, 执行键, 会话: actor.id, 生命周期: randomUUID(), attemptId: `host-attempt-${++sequence}`, revision: 1, turn: 0, step: sequence,
    主体: actor, 归因: { 目标: goal?.id ?? null, 原因: goal ? 'HOST开始快照归属同一目标' : 'HOST开始快照没有可靠目标归属' }, 配置路由: { provider: 'configured-provider', model: 'configured-model' } };
  await org.modelUsage.recordStart(start);
  return { project, key: 执行键, revision: 1, index: 0 };
}
async function sample(org, attempt, usage) {
  await org.modelUsage.recordSample({ 项目: attempt.project, 执行键: attempt.key, index: attempt.index++, revision: ++attempt.revision, time: attempt.index, usage });
}
async function end(org, attempt, { abandoned = false, error = false } = {}) {
  await org.modelUsage.recordEnd({ 项目: attempt.project, 执行键: attempt.key, index: attempt.index, revision: ++attempt.revision,
    outcome: abandoned ? { kind: 'abandoned' } : { kind: 'committed', eventType: error ? 'assistant/attempt' : 'assistant/message', seq: ++sequence }, finish: abandoned ? null : error ? 'error' : 'stop' });
}

describe('usage_query入口合同', () => {
  it('最新usage替换旧快照；error及abandoned也计入已报告字段，未观测尝试不补零', async () => scene(async ({ org, query }) => {
    const goal = await org.goals.create(goalSpec('latest'));
    const a = await start(org, { goal });
    await sample(org, a, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    await sample(org, a, { inputTokens: 20, outputTokens: 7, totalTokens: 27 });
    await end(org, a);
    const b = await start(org, { goal });
    await sample(org, b, { inputTokens: 3, outputTokens: 2, totalTokens: 5 });
    await end(org, b, { error: true });
    const c = await start(org, { goal });
    await sample(org, c, { inputTokens: 1, outputTokens: 1, totalTokens: 2 });
    await end(org, c, { abandoned: true });
    await start(org, { actor: LEAD });
    const result = await query({ 条数: 1, 偏移: 0 });
    assert.equal(result.健康, '可用');
    assert.equal(result.完整, false);
    assert.equal(result.token, null);
    assert.equal(result.费用, null);
    assert.equal(result.汇总.尝试, 4);
    assert.equal(result.汇总.已结束, 3);
    assert.equal(result.汇总.未结束, 1);
    assert.equal(result.汇总.有用量, 3);
    assert.equal(result.汇总.无用量, 1);
    assert.equal(result.汇总.未归因, 1);
    assert.deepEqual(result.汇总.已报告token, { inputTokens: 24, outputTokens: 10, totalTokens: 34, cacheReadTokens: null, cacheWriteTokens: null, reasoningTokens: null });
    assert.deepEqual(result.汇总.字段覆盖.inputTokens, { 已知: 3, 缺失: 1 });
    assert.deepEqual(result.汇总.字段覆盖.cacheReadTokens, { 已知: 0, 缺失: 4 });
    assert.equal(result.尝试页.条目.length, 1, '分页只裁尝试，不裁全量汇总');
    const all = await query({ 条数: 50 });
    const latest = all.尝试页.条目.find(row => row.执行键 === a.key);
    assert.equal(latest.usage.inputTokens, 20);
    assert.equal(latest.配置路由.model, 'configured-model');
    assert.ok(all.尝试页.条目.some(row => row.finish === 'error'));
    assert.ok(all.尝试页.条目.some(row => row.outcome?.kind === 'abandoned'));
  }));

  it('缺失total与缓存/推理字段保持null，不用input+output猜总量', async () => scene(async ({ org, query }) => {
    const attempt = await start(org);
    await sample(org, attempt, { inputTokens: 2, outputTokens: 3 });
    await end(org, attempt);
    const result = await query();
    assert.equal(result.汇总.已报告token.inputTokens, 2);
    assert.equal(result.汇总.已报告token.outputTokens, 3);
    for (const field of ['totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens']) {
      assert.equal(result.汇总.已报告token[field], null);
      assert.deepEqual(result.汇总.字段覆盖[field], { 已知: 0, 缺失: 1 });
    }
    assert.equal(result.尝试页.条目[0].usage.totalTokens, null, '缺席字段标未知，不补造数值');
    assert.equal(result.token, null);
    assert.equal(result.费用, null);
  }));

  it('目标过滤不夹带其他目标或未归因尝试；同项目目标核验和项目范围相互独立', async () => scene(async ({ org, act, query }) => {
    const a = await org.goals.create(goalSpec('scope-a'));
    const b = await org.goals.create(goalSpec('scope-b'));
    const other = await org.goals.create(goalSpec('scope-other', Q));
    for (const [goal, project, amount] of [[a, P, 2], [b, P, 20], [other, Q, 200], [null, P, 1]]) {
      const attempt = await start(org, { goal, project, actor: goal ? MEMBER : LEAD });
      await sample(org, attempt, { inputTokens: amount, outputTokens: 0, totalTokens: amount });
      await end(org, attempt);
    }
    const result = await query({ id: a.id });
    assert.equal(result.汇总.尝试, 1);
    assert.equal(result.汇总.已报告token.inputTokens, 2);
    assert.equal(result.汇总.未归因, 0);
    assert.ok(result.尝试页.条目.every(row => row.归因.目标 === a.id));
    assert.equal((await query()).汇总.已报告token.inputTokens, 23);
    assert.equal((await act({ action: 'usage_query', project: Q, id: other.id })).用量.汇总.已报告token.inputTokens, 200);
    await assert.rejects(() => query({ id: other.id }), invalid);
    await assert.rejects(() => query({ id: 'goal-does-not-exist' }), invalid);
  }));

  it('仅读当前真实就绪Lead/主权者，成员及复核员即使知道目标id也无观察读域', async () => scene(async ({ org, query, act }) => {
    const goal = await org.goals.create(goalSpec('identity'));
    for (const subject of [MEMBER, REVIEWER]) await assert.rejects(() => query({ id: goal.id }, subject), e => e instanceof Denied);
    await assert.rejects(() => act({ action: 'usage_query', role: 'Lead' }, MEMBER), e => e instanceof Denied);
    assert.equal((await query({}, SOVEREIGN)).完整, false);
    await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '观察读域资格复判' });
    await assert.rejects(() => query(), e => e instanceof Denied);
  }));

  it('模型/命令不能上报usage或伪造主体/计量，record动作不在任何模型或命令清单', async () => scene(async ({ act, query, log }) => {
    const before = await log();
    for (const key of ['subject', '主体', '执行计划', '认证', '面', 'usage', '计量', 'inputTokens', 'token', '费用', '归因', '执行键', '审批引用']) {
      await assert.rejects(() => query({ [key]: key === 'usage' ? { inputTokens: 999999, outputTokens: 0 } : 'forged' }), invalid, key);
    }
    for (const action of ['usage_record', 'usage_start', 'usage_sample', 'usage_end', 'recordStart', 'recordSample', 'recordEnd']) {
      assert.equal(ACTIONS.includes(action), false);
      assert.equal(COMMAND_ACTIONS.includes(action), false);
      await assert.rejects(() => act({ action, usage: { inputTokens: 999999, outputTokens: 0 } }), e => e instanceof InvalidBody);
    }
    for (const args of [{ 条数: 0 }, { 条数: 51 }, { 条数: Infinity }, { 偏移: -1 }, { 偏移: 0.5 }]) await assert.rejects(() => query(args), invalid);
    assert.equal(await log(), before, '伪报不能在观察账本制造用量事实');
  }));

  it('纯查询不创建或追加观察事实，也不把未观测窗口说成完整总量', async () => scene(async ({ org, query, log }) => {
    const audit = await org.audit.read({});
    assert.equal(await log(), null);
    const empty = await query();
    assert.equal(empty.汇总.尝试, 0);
    assert.equal(empty.完整, false);
    assert.equal(empty.token, null);
    assert.equal(empty.费用, null);
    assert.equal(empty.汇总.已报告token.totalTokens, null);
    assert.equal(await log(), null);
    const attempt = await start(org);
    await sample(org, attempt, { inputTokens: 4, outputTokens: 1, totalTokens: 5 });
    const before = await log();
    await query({ 条数: 1, 偏移: 0 });
    await query({ 条数: 1, 偏移: 1 });
    assert.equal(await log(), before);
    assert.deepEqual(await org.audit.read({}), audit, '普通只读观察不刷审计或反写计量');
  }));
});

it('真实tool与command共用usage_query，数字分页规范且预算token仍保持未知', async () => {
  const f = await makeFixture();
  const host = fakeHost();
  try {
    const cwd = join(f.home, P);
    await mkdir(cwd, { recursive: true });
    const config = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P, projectBindings: [{ path: cwd, project: P }] };
    await kernel.apply(host.ctx, config);
    const org = await shareOrg(config);
    const agent = { session: { id: 'lead', header: { cwd } } };
    const tool = host.工具.get('mind');
    const command = host.命令.get('mind');
    assert.ok(ACTIONS.includes('usage_query'));
    assert.ok(READ_ONLY_ACTIONS.includes('usage_query'));
    assert.ok(tool.parameters.properties.action.enum.includes('usage_query'));
    assert.equal(tool.isConcurrencySafe({ action: 'usage_query' }), true);
    for (const action of ['usage_record', 'usage_start', 'usage_sample', 'usage_end', 'recordStart', 'recordSample', 'recordEnd']) assert.equal(tool.parameters.properties.action.enum.includes(action), false);
    const goal = await org.goals.create(goalSpec('host'));
    for (const amount of [5, 6, 7]) {
      const attempt = await start(org, { goal });
      await sample(org, attempt, { inputTokens: amount, outputTokens: 0, totalTokens: amount });
      await end(org, attempt);
    }
    const before = await readTextOrNull(f.layout.modelUsageLog(P));
    const exec = { name: 'mind', agent, signal: new AbortController().signal };
    const page = JSON.parse(await tool.execute({ action: 'usage_query', id: goal.id, 条数: 1, 偏移: 0 }, exec));
    assert.equal(page.成功, true, JSON.stringify(page));
    const next = JSON.parse((await command.handler({ agent, rawInput: `usage_query id=${goal.id} 条数=1 偏移=1` })).text);
    assert.equal(next.成功, true, JSON.stringify(next));
    assert.deepEqual(next.用量.汇总, page.用量.汇总);
    assert.equal(page.用量.汇总.已报告token.totalTokens, 18);
    assert.equal(page.用量.尝试页.条目.length, 1);
    assert.equal(next.用量.尝试页.条目.length, 1);
    assert.notEqual(page.用量.尝试页.条目[0].执行键, next.用量.尝试页.条目[0].执行键);
    const spoof = JSON.parse((await command.handler({ agent, rawInput: 'usage_query usage=9999' })).text);
    assert.equal(spoof.成功, false);
    const budget = JSON.parse(await tool.execute({ action: 'budget_query', id: goal.id }, exec));
    assert.equal(budget.成功, true, JSON.stringify(budget));
    assert.equal(budget.预算.token, null);
    assert.equal(budget.预算.费用, null);
    assert.equal(await readTextOrNull(f.layout.modelUsageLog(P)), before);
  } finally { host.清理(); await f.cleanup(); }
});
