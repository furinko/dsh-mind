/** 实际内核装配与创建宏：只用临时宿主夹具，不创建真实会话。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { apply } from '../components/kernel/lib/index.js';
import { Org } from '../src/org.js';
import { shareOrg, forgetSharedOrg, shareKey } from '../src/runtime.js';
import { runAction } from '../lib/actions.js';

const P = 'spawn-operation-integration';
async function scene(body) {
  const f = await makeFixture(); const host = fakeHost(); let org;
  try {
    const cwd = join(f.home, 'work'); await mkdir(cwd); const input = join(cwd, 'input.txt'); await writeFile(input, 'fixture input');
    const config = { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P,
      projectBindings: [{ path: cwd, project: P }], memberFileAccess: { read: [cwd], write: [cwd] } };
    await apply(host.ctx, config); org = await shareOrg(config);
    const goal = await org.goals.create({ subject: LEAD, 项目: P, 期望结果: '创建可恢复的成员', 完成依据: ['当前工作可核对'], 来源: '明确用户意图的转述', 下一步: '创建成员调查文件' });
    const counts = { creates: 0, sends: 0, releases: 0, requested: [] };
    const agent = { session: { id: LEAD.id, header: { cwd } } };
    const runtime = { agent, signal: new AbortController().signal, project: P, delegation: { authorize: () => ({ fingerprint: 'operations-fixture' }) },
      subagents: { startContinuable: async spec => { counts.creates++; counts.requested.push(spec.childId); return { childId: spec.childId, messageId: `initial-${counts.creates}` }; },
        sendMessage: async () => `work-${++counts.sends}`, drainContinuableChildren: async () => { counts.releases++; } } };
    const create = async (linked = true) => {
      const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '调查当前文件', 负责人: '插件工程', 判据: ['来源可验证'] });
      if (linked) { const current = await org.goals.get(goal.id, { subject: LEAD, 项目: P }); await org.goals.linkTask(goal.id, { subject: LEAD, 项目: P, 修订: current.修订, 任务: task.id }); }
      return task;
    };
    const request = task => ({ action: 'member_spawn', 方式: 'subagent', 岗位: '插件工程', 节点: task.id, 任务书: '调查当前文件', 工具文件范围: { 读: [cwd], 写: [cwd] } });
    const act = args => runAction({ org, 项目: P, 主体: LEAD, 宿主: runtime, args });
    const query = extra => org.spawnOperations.query({ subject: LEAD, 项目: P, ...extra });
    const reopen = () => Org.open({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
    await body({ f, org, host, runtime, agent, goal, counts, cwd, input, create, request, act, query, reopen });
  } finally { await org?.budgetHooks?.flush(); await org?.modelUsageHooks?.flush(); await org?.observability?.flush(); host.清理(); forgetSharedOrg(shareKey({ home: f.home, privateRoot: f.privateRoot, project: P })); await f.cleanup(); }
}

describe('成员创建意图的内核纵向接线', { timeout: 45_000 }, () => {
  it('预留id传给宿主、六阶段和工具/工作台共源，重建后不重复创建', async () => scene(async ({ org, host, agent, runtime, goal, counts, create, request, act, query, reopen }) => {
    const task = await create(); const result = await act(request(task));
    assert.equal(result.实例, counts.requested[0]); assert.equal(result.操作.拟用实例, result.实例); assert.equal(result.操作.记账, '已收尾');
    const row = (await query({ id: result.操作.操作id })).操作页.条目[0];
    assert.equal(row.状态, 'audited'); assert.equal(row.阶段.length, 7);
    const tool = host.工具.get('mind');
    const text = await tool.execute({ action: 'operation_query', id: row.操作id }, { agent, name: 'mind', arguments: { action: 'operation_query' } });
    assert.equal(JSON.parse(text).操作.操作页.条目[0].操作id, row.操作id);
    const fresh = await reopen();
    assert.equal((await fresh.spawnOperations.query({ subject: LEAD, 项目: P, 任务: task.id })).汇总.已审计, 1);
    await assert.rejects(runAction({ org: fresh, 项目: P, 主体: LEAD, 宿主: runtime, args: request(task) }), error => error.code === 'MEMBER_SPAWN_OPERATION_EXISTS');
    await assert.rejects(act(request(task)), error => error.code === 'MEMBER_SPAWN_OPERATION_EXISTS' && error.outcome.可重试 === false);
    assert.equal(counts.creates, 1); assert.equal(counts.sends, 1);
    const board = await org.workbench({ 项目: P, 读者: LEAD }); assert.equal(board.创建操作.汇总.已审计, 1);
    assert.equal(board.目标.目标[0].id, goal.id);
    const member = await org.workbench({ 项目: P, 读者: { id: result.实例, kind: '成员', roleId: '插件工程' } }); assert.equal(member.创建操作, null);
  }));

  it('创建异常的原意图及候选id可重建，同任务重试不再扣额度或调用宿主', async () => scene(async ({ org, runtime, goal, counts, create, request, act, query, reopen }) => {
    const task = await create(); await org.budgets.configure(goal.id, { subject: SOVEREIGN, 项目: P, 预算修订: 0, 上限: 2 });
    runtime.subagents.startContinuable = async spec => { counts.creates++; counts.requested.push(spec.childId); throw new Error('transport-private-body'); };
    let original;
    await assert.rejects(act(request(task)), error => { original = error; return error.code === 'MEMBER_SPAWN_RESULT_UNKNOWN'; });
    const receipt = original.outcome.已确认阶段.find(row => row.操作id);
    assert.equal(receipt.拟用实例, counts.requested[0]);
    const fresh = await reopen(); const row = (await fresh.spawnOperations.query({ subject: LEAD, 项目: P, id: receipt.操作id })).操作页.条目[0];
    assert.equal(row.状态, 'intent'); assert.equal(row.拟用实例, counts.requested[0]);
    assert.equal((await query({ 任务: task.id })).汇总.已见宿主回执, 0);
    await assert.rejects(act({ ...request(task), 任务书: '换句话再试' }), error => error.code === 'MEMBER_SPAWN_OPERATION_EXISTS');
    assert.equal(counts.creates, 1);
    assert.equal((await org.budgets.query(goal.id, { subject: LEAD, 项目: P })).累计准入, 1);
    assert.equal((await org.registry.identity()).members[counts.requested[0]], undefined);
  }));

  it('阶段观察写失败不制造孤儿补偿，成功业务返回操作id和需核对', async () => scene(async ({ org, counts, create, request, act, query }) => {
    const task = await create(); const record = org.spawnOperations.record.bind(org.spawnOperations);
    org.spawnOperations.record = async spec => { if (spec.阶段 === 'host_returned') throw new Error('journal unavailable'); return record(spec); };
    const result = await act(request(task));
    assert.equal(result.操作.记账, '需核对'); assert.equal(result.已派发, true); assert.equal(result.已接收, true);
    assert.equal(counts.creates, 1); assert.equal(counts.sends, 1); assert.equal(counts.releases, 0);
    assert.equal((await org.registry.identity()).members[result.实例].status, '在岗');
    assert.equal((await query({ 任务: task.id })).操作页.条目[0].状态, 'intent');
    await assert.rejects(act(request(task)), error => error.code === 'MEMBER_SPAWN_OPERATION_EXISTS');
    assert.equal(counts.creates, 1);
  }));

  it('额度拒绝和额度后已知任务变化均在意图前停止，不锁死独立任务', async () => scene(async ({ org, goal, counts, create, request, act }) => {
    const task = await create(); await org.budgets.configure(goal.id, { subject: SOVEREIGN, 项目: P, 预算修订: 0, 上限: 0 });
    await assert.rejects(act(request(task)), error => error.code === 'DENIED');
    await assert.rejects(stat(org.layout.spawnOperationLog(P)), { code: 'ENOENT' });
    await org.budgets.configure(goal.id, { subject: SOVEREIGN, 项目: P, 预算修订: 1, 上限: 1 });
    const reserve = org.budgets.reserve.bind(org.budgets);
    org.budgets.reserve = async spec => { const receipt = await reserve(spec); await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P }); return receipt; };
    await assert.rejects(act(request(task)), error => error.code === 'INVALID_BODY');
    await assert.rejects(stat(org.layout.spawnOperationLog(P)), { code: 'ENOENT' }); assert.equal(counts.creates, 0);
    org.budgets.reserve = reserve;
    const independent = await create(false); await act(request(independent)); assert.equal(counts.creates, 1);
  }));

  it('坏创建账只阻止新创建，已有文件工具和其他诊断仍可推进', async () => scene(async ({ org, host, runtime, counts, input, create, request, act }) => {
    const task = await create(); const result = await act(request(task));
    await writeFile(org.layout.spawnOperationLog(P), '{broken');
    const exec = { name: 'read', arguments: { file_path: input }, callId: 'existing-member-read', token: Symbol('execution'),
      agent: { session: { id: result.实例, header: { ...runtime.agent.session.header, origin: 'subagent', parentSession: LEAD.id, delegationDepth: 1 } } } };
    const listeners = [...host.钩子.get('tools/pre-execute') ?? []]; let index = 0;
    const next = () => Promise.resolve((listeners[index++] ?? (() => ({ kind: 'allow' })))(exec, next));
    assert.equal((await next()).kind, 'allow'); const reason = host.闸.map(guard => guard(exec)).find(value => value !== undefined);
    let body = 0; if (reason === undefined) body++; assert.equal(body, 1);
    host.触发('tools/result', exec, { isError: false, content: [] }); await org.budgetHooks.flush(); await org.observability.flush();
    assert.equal((await org.workbench({ 项目: P, 读者: LEAD })).创建操作.健康, '不可用');
    assert.equal((await org.modelUsage.query({ subject: LEAD, 项目: P })).健康, '可用');
    const nextTask = await create(false); await assert.rejects(act(request(nextTask)), error => error.code === 'SPAWN_OPERATION_LEDGER_INVALID');
    assert.equal(counts.creates, 1);
  }));
});
