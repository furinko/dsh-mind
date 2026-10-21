/** 实际内核装配的隔离模型帧；不调用真实模型或运行宿主。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { apply } from '../components/kernel/lib/index.js';
import { shareOrg, forgetSharedOrg, shareKey } from '../src/runtime.js';
import { runAction } from '../lib/actions.js';

const P = 'model-usage-integration';
async function scene(run, enabled = true) {
  const f = await makeFixture(); const host = fakeHost(); let org;
  try {
    const cwd = join(f.home, 'work'); await mkdir(cwd);
    const input = join(cwd, 'input.txt'); await writeFile(input, 'fixture input');
    const config = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P,
      projectBindings: [{ path: cwd, project: P }], memberFileAccess: { read: [cwd], write: [cwd] }, 观测模型用量: enabled };
    await apply(host.ctx, config); org = await shareOrg(config);
    const goal = await org.goals.create({ subject: LEAD, 项目: P, 期望结果: '观察真实模型用量', 完成依据: ['取得可核对观察'], 来源: '用户意图转述', 下一步: '调查当前文件' });
    const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '调查输入', 负责人: '插件工程', 判据: ['调查有来源'] });
    await org.goals.linkTask(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 任务: task.id });
    await org.tasks.bind(task.id, { subject: LEAD, 项目: P, 实例: 'member-a', 岗位: '插件工程' });
    await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P, 工具文件范围: { 读: [cwd], 写: [cwd] } });
    const agent = { session: { id: 'member-a', header: { cwd, origin: 'subagent', parentSession: LEAD.id, delegationDepth: 1 } }, options: { provider: 'fixture-provider', model: 'fixture-model' } };
    const emit = frame => host.触发('agent/assistant-stream', { agent, frame });
    const query = id => org.modelUsage.query({ subject: LEAD, 项目: P, ...(id ? { id } : {}) });
    const flush = () => org.modelUsageHooks.flush();
    await run({ f, org, host, agent, goal, task, input, emit, flush, query });
  } finally {
    await org?.modelUsageHooks?.flush(); await org?.budgetHooks?.flush(); await org?.observability?.flush(); host.清理();
    forgetSharedOrg(shareKey({ home: f.home, privateRoot: f.privateRoot, project: P })); await f.cleanup();
  }
}
const start = { type: 'start', attemptId: 'member-a:1', revision: 1, turn: 1, step: 0 };

describe('模型用量的内核纵向接线', { timeout: 30_000 }, () => {
  it('真实帧接线、最新快照和目标查询同源，观测不改变受管额度', async () => scene(async ({ org, emit, flush, query, goal, agent }) => {
    await org.budgets.configure(goal.id, { subject: SOVEREIGN, 项目: P, 预算修订: 0, 上限: 1 });
    emit(start);
    emit({ type: 'chunk', attemptId: start.attemptId, revision: 2, index: 0, time: 100, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2, cacheReadTokens: 4, totalTokens: 16 } } });
    emit({ type: 'chunk', attemptId: start.attemptId, revision: 3, index: 1, time: 99, chunk: { type: 'usage', usage: { inputTokens: 12, outputTokens: 3, cacheReadTokens: 5, totalTokens: 20 } } });
    emit({ type: 'chunk', attemptId: start.attemptId, revision: 4, index: 2, time: 101, chunk: { type: 'finish', reason: { kind: 'stop' } } });
    emit({ type: 'end', attemptId: start.attemptId, revision: 5, index: 3, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 21 } });
    await flush();
    const view = await query(goal.id);
    assert.equal(view.汇总.尝试, 1); assert.equal(view.汇总.已结束, 1);
    assert.equal(view.汇总.已报告token.totalTokens, 20); assert.equal(view.汇总.已报告token.cacheWriteTokens, null);
    assert.equal(view.token, null); assert.equal(view.费用, null); assert.equal(view.完整, false);
    const quota = await org.budgets.query(goal.id, { subject: LEAD, 项目: P });
    assert.equal(quota.累计准入, 0); assert.equal(quota.可准入, 1); assert.equal(quota.token, null);
    const board = await org.workbench({ 项目: P, 读者: LEAD });
    assert.equal(board.模型用量.汇总.已报告token.totalTokens, 20);
    assert.equal(board.模型用量.采集.attached, true);
    const member = await org.workbench({ 项目: P, 读者: { id: agent.session.id, kind: '成员', roleId: '插件工程' } });
    assert.equal(member.模型用量, null);
  }));

  it('Lead用量未归因仍保留，不能混进成员目标或补造总用量', async () => scene(async ({ org, host, agent, goal, query, flush }) => {
    const lead = { ...agent, session: { id: LEAD.id, header: { cwd: agent.session.header.cwd } } };
    host.触发('agent/assistant-stream', { agent: lead, frame: { ...start, attemptId: 'lead:1' } });
    host.触发('agent/assistant-stream', { agent: lead, frame: { type: 'end', attemptId: 'lead:1', revision: 2, index: 0, outcome: { kind: 'abandoned' } } });
    await flush();
    const all = await query();
    assert.equal(all.汇总.尝试, 1); assert.equal(all.汇总.未归因, 1); assert.equal(all.汇总.无用量, 1);
    assert.equal(all.汇总.已报告token.inputTokens, null);
    assert.equal((await query(goal.id)).汇总.尝试, 0);
  }));

  it('独立关闭观察不接线、不造零用量或账本，已有目标与查询仍可读', async () => scene(async ({ org, emit, flush, query, goal }) => {
    emit(start); await flush();
    assert.equal(org.modelUsageHooks.health().enabled, false);
    assert.equal(org.modelUsageHooks.health().attached, false);
    assert.equal((await query()).汇总.已报告token.totalTokens, null);
    await assert.rejects(stat(org.layout.modelUsageLog(P)), { code: 'ENOENT' });
    const board = await org.workbench({ 项目: P, 读者: LEAD });
    assert.equal(board.模型用量.采集.enabled, false); assert.equal(board.目标.目标[0].id, goal.id);
  }, false));

  it('坏用量账不拦原工具体，读面明确不可用且不存正文/错误原文', async () => scene(async ({ org, host, agent, input, emit, flush, goal }) => {
    emit(start); await flush();
    const before = await readFile(org.layout.modelUsageLog(P), 'utf8');
    assert.ok(!before.includes('fixture input'));
    await writeFile(org.layout.modelUsageLog(P), before + '{broken');
    assert.doesNotThrow(() => emit({ type: 'chunk', attemptId: start.attemptId, revision: 2, index: 0, time: 100, chunk: { type: 'usage', usage: { inputTokens: 4, outputTokens: 1 } } }));
    await flush();
    assert.equal(org.modelUsageHooks.health().failedWrites, 1);
    await assert.rejects(runAction({ org, 项目: P, 主体: LEAD, args: { action: 'usage_query' } }), error => error.code === 'MODEL_USAGE_LEDGER_INVALID');
    const exec = { name: 'read', arguments: { file_path: input }, callId: 'normal', token: Symbol('real-host-token'), agent };
    const listeners = [...host.钩子.get('tools/pre-execute') ?? []]; let i = 0;
    const next = () => Promise.resolve((listeners[i++] ?? (() => ({ kind: 'allow' })))(exec, next));
    assert.equal((await next()).kind, 'allow');
    const reason = host.闸.map(guard => guard(exec)).find(value => value !== undefined);
    let body = 0; if (reason === undefined) body++;
    assert.equal(body, 1);
    host.触发('tools/result', exec, { isError: false, content: [] });
    await org.budgetHooks.flush(); await org.observability.flush();
    const board = await org.workbench({ 项目: P, 读者: LEAD });
    assert.equal(board.模型用量.健康, '不可用'); assert.equal(board.目标.目标[0].id, goal.id);
  }));
});
