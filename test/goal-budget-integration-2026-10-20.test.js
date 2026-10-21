/** 真实内核装配路径：pre→guard→body、跨入口共用额度、观测与只读摘要。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { apply } from '../components/kernel/lib/index.js';
import { shareOrg, forgetSharedOrg, shareKey } from '../src/runtime.js';
import { runAction } from '../lib/actions.js';

const P = 'budget-integration';
async function scene(run, audit = true) {
  const f = await makeFixture();
  const host = fakeHost();
  let org;
  try {
    const cwd = join(f.home, 'work'); await mkdir(cwd);
    const input = join(cwd, 'input.txt'); await writeFile(input, 'fixture data');
    const config = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P,
      projectBindings: [{ path: cwd, project: P }], memberFileAccess: { read: [cwd], write: [cwd] }, audit工具调用: audit };
    await apply(host.ctx, config); org = await shareOrg(config);
    const goal = await org.goals.create({ subject: LEAD, 项目: P, 期望结果: '共享受管准入额度', 完成依据: ['当前交付通过'], 来源: '明确用户意图的转述', 下一步: '创建成员并完成文件调查' });
    const parent = { session: { id: LEAD.id, header: { cwd } } };
    let creates = 0; let body = 0; let serial = 0;
    const runtime = { agent: parent, signal: new AbortController().signal, project: P,
      delegation: { authorize: () => ({ fingerprint: 'budget-test-delegation' }) },
      subagents: { startContinuable: async (spec) => { creates++; return { childId: spec.childId ?? `budget-child-${creates}`, messageId: `initial-${creates}` }; }, sendMessage: async () => `opened-${creates}`, drainContinuableChildren: async () => {} } };
    const task = async (bind = false) => {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `受管工作${++serial}`, 负责人: '插件工程', 判据: ['内容可验证'] });
      const current = await org.goals.get(goal.id, { subject: LEAD, 项目: P });
      await org.goals.linkTask(goal.id, { subject: LEAD, 项目: P, 修订: current.修订, 任务: node.id });
      if (bind) {
        await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: 'member-a', 岗位: '插件工程' });
        await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P, 工具文件范围: { 读: [cwd], 写: [cwd] } });
      }
      return node;
    };
    const exec = (id = 'member-a') => ({ name: 'read', arguments: { file_path: input }, callId: 'reused-call-id', token: Symbol('host-execution'),
      agent: { session: { id, header: { cwd, origin: 'subagent', parentSession: LEAD.id, delegationDepth: 1 } } } });
    const invoke = async execution => {
      const listeners = [...host.钩子.get('tools/pre-execute') ?? []]; let index = 0;
      const next = () => Promise.resolve((listeners[index++] ?? (() => ({ kind: 'allow' })))(execution, next));
      const decision = await next();
      const reason = decision.kind === 'deny' ? decision.reason : host.闸.map(guard => guard(execution)).find(value => value !== undefined);
      if (reason === undefined) body++;
      const result = { isError: reason !== undefined, content: [], ...(reason !== undefined ? { error: { message: reason } } : {}) };
      host.触发('tools/result', execution, result);
      await org.budgetHooks.flush(); await org.observability.flush();
      return result;
    };
    const configure = (limit, revision = 0) => org.budgets.configure(goal.id, { subject: SOVEREIGN, 项目: P, 预算修订: revision, 上限: limit });
    const query = () => org.budgets.query(goal.id, { subject: LEAD, 项目: P });
    await run({ f, org, cwd, goal, runtime, task, exec, invoke, configure, query, calls: () => ({ creates, body }) });
  } finally {
    await org?.budgetHooks?.flush(); await org?.observability?.flush(); host.清理();
    forgetSharedOrg(shareKey({ home: f.home, privateRoot: f.privateRoot, project: P })); await f.cleanup();
  }
}

describe('共享额度的内核纵向接线', { timeout: 30_000 }, () => {
  it('member_spawn与新成员文件调用共用目标额度，耗尽后body不再进入且阻塞可查', async () => scene(async ({ org, goal, cwd, runtime, task, exec, invoke, configure, query, calls }) => {
    await configure(2);
    const node = await task();
    const spawn = await runAction({ org, 项目: P, 主体: LEAD, 宿主: runtime, args: { action: 'member_spawn', 方式: 'subagent', 节点: node.id, 岗位: '插件工程', 任务书: '只调查文件', 工具文件范围: { 读: [cwd], 写: [cwd] } } });
    assert.equal(spawn.预算.结果记账, '已收尾');
    assert.equal((await invoke(exec(spawn.实例))).isError, false);
    assert.equal((await invoke(exec(spawn.实例))).isError, true);
    assert.deepEqual(calls(), { creates: 1, body: 1 });
    const budget = await query();
    assert.equal(budget.累计准入, 2); assert.equal(budget.已结算, 2); assert.equal(budget.未决占用, 0); assert.equal(budget.可准入, 0);
    assert.equal(org.budgetHooks.health().failedWrites, 0, '正常额度耗尽不是采集写故障');
    const monitor = await org.observability.query({ subject: LEAD, project: P });
    assert.ok(monitor.阻塞.some(item => item.block.ruleId === 'kernel.goal-budget'));
    assert.equal((await org.goals.get(goal.id, { subject: LEAD, 项目: P })).状态, '进行中');
  }));

  it('关闭普通native监控仍保留预算准入，但不会擅自开启普通native监控事实', async () => scene(async ({ org, task, exec, invoke, configure, query, calls }) => {
    await task(true); await configure(1);
    assert.equal((await invoke(exec())).isError, false);
    assert.equal((await invoke(exec())).isError, true);
    assert.equal(calls().body, 1); assert.equal((await query()).累计准入, 1);
    const monitor = await org.observability.query({ subject: LEAD, project: P });
    assert.equal(monitor.尝试总数, 0);
  }, false));

  it('未配用量是未知且不制造预算账，配置后工作台显示真实占用和未知token费用', async () => scene(async ({ f, org, goal, task, exec, invoke, configure, query }) => {
    await task(true); assert.equal((await invoke(exec())).isError, false);
    const unknown = await query(); assert.equal(unknown.累计准入, null); assert.equal(unknown.token, null); assert.equal(unknown.费用, null);
    await assert.rejects(() => stat(f.layout.goalBudgetLog(P)), error => error.code === 'ENOENT');
    await configure(1); assert.equal((await invoke(exec())).isError, false);
    const view = await org.workbench({ 项目: P, 读者: LEAD });
    const budget = view.目标.目标.find(item => item.id === goal.id).预算;
    assert.equal(budget.健康, '可用'); assert.equal(budget.累计准入, 1); assert.equal(budget.可准入, 0); assert.equal(budget.token, null); assert.equal(budget.费用, null);
    assert.equal((await org.workbench({ 项目: P, 读者: { id: 'member-a', kind: '成员', roleId: '插件工程' } })).目标, null);
  }));

  it('预算账本损坏不冒充零用量，目标本身与任务摘要仍可诊断', async () => scene(async ({ f, org, goal, task, exec, invoke, configure, calls }) => {
    await task(true); await configure(1); await writeFile(f.layout.goalBudgetLog(P), '{torn-budget');
    const view = await org.workbench({ 项目: P, 读者: LEAD });
    assert.equal(view.目标.健康, '可用');
    const budget = view.目标.目标.find(item => item.id === goal.id).预算;
    assert.equal(budget.健康, '不可用'); assert.equal(budget.累计准入, null);
    assert.equal((await invoke(exec())).isError, true); assert.equal(calls().body, 0);
  }));
});
