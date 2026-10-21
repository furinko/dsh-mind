/** 预算只有读入口与人侧配置；真实派活准入消费在宿主之前发生，失败也不退还尝试。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { Org } from '../src/org.js';
import { shareOrg } from '../src/runtime.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { runAction, ACTIONS, COMMAND_ONLY_ACTIONS, READ_ONLY_ACTIONS } from '../lib/actions.js';
import { 介入计划Of } from '../lib/approval-plan.js';
import { Denied, InvalidBody, Fault, describeFailure } from '../src/kernel/errors.js';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'goal-budget-entry';
const invalid = (e) => e instanceof InvalidBody || e instanceof Denied;
const existingOperationFor = (taskId, operationId) => error => {
  assert.ok(error instanceof Fault);
  assert.equal(error.code, 'MEMBER_SPAWN_OPERATION_EXISTS');
  assert.match(operationId, /^[0-9a-f-]{36}$/);
  const receipt = describeFailure(error);
  assert.equal(receipt.可重试, false);
  assert.ok(receipt.已确认阶段.some(stage => stage.任务 === taskId && stage.操作id === operationId), '重复派活须提供同一原任务、同一持久操作凭据');
  assert.match(receipt.怎么改, /operation_query/);
  return true;
};
const goalArgs = (key) => ({ action: 'goal_create', 请求键: key, 期望结果: '在受管准入预算内完成可复验交付', 约束: [], 禁止工具: [], 完成依据: ['交付通过核对'], 来源: '本轮用户意图转述', 下一步: '安排正式执行' });
const budgetArgs = (id, rev, limit) => ({ action: 'budget_decide', id, 预算修订: rev, 上限: limit });

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const calls = { spawn: 0, send: 0, release: 0 };
    const host = { agent: { session: { id: 'lead' } }, delegation: { authorize: () => ({ fingerprint: 'budget-entry-authorized' }) }, subagents: {
      startContinuable: async (spec) => { calls.spawn++; return { childId: spec.childId ?? `budget-child-${calls.spawn}`, messageId: 'started' }; },
      sendMessage: async () => ({ messageId: `work-${++calls.send}` }),
      drainContinuableChildren: async () => { calls.release += 1; },
    } };
    const act = (args, subject = LEAD, 面 = 'tool') => runAction({ org, 项目: P, 主体: subject, subject, 面, 宿主: host, args });
    const goal = (await act(goalArgs('budget-entry'))).目标;
    const configure = (rev, limit, extra = {}) => act({ ...budgetArgs(goal.id, rev, limit), ...extra }, LEAD, 'command');
    const query = async (extra = {}, subject = LEAD) => (await act({ action: 'budget_query', id: goal.id, ...extra }, subject)).预算;
    let serial = 0;
    const task = async () => {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `真实预算派活${++serial}`, 负责人: '插件工程', 判据: ['可核对交付'] });
      const current = await org.goals.get(goal.id, { subject: LEAD, 项目: P });
      await act({ action: 'goal_link_task', id: goal.id, 修订: current.修订, 任务: node.id });
      return node;
    };
    const spawn = (node) => act({ action: 'member_spawn', 方式: 'subagent', 节点: node.id, 岗位: '插件工程', 任务书: '按当前判据交付' });
    const log = () => readTextOrNull(f.layout.goalBudgetLog(P));
    await run({ f, org, calls, host, act, goal, configure, query, task, spawn, log });
  } finally { await f.cleanup(); }
}

describe('目标预算动作入口', () => {
  it('未配置口径为未知而非零；query不收伪计量字段，模型不能声明面或调用reserve/settle', async () => scene(async ({ act, goal, query, log }) => {
    const result = await query();
    assert.equal(result.目标, goal.id);
    for (const key of ['预算修订', '上限', '累计准入', '已结算', '未决占用', '可准入', 'token', '费用']) assert.equal(result[key], null, key);
    assert.ok(result.覆盖口径);
    assert.equal(result.配置, null);
    assert.deepEqual(result.尝试页.条目, []);
    assert.equal(result.尝试页.总数, null);
    assert.equal(result.尝试页.hasMore, null);
    const before = await log();
    await assert.rejects(() => act({ action: 'budget_query' }), invalid, '预算查询不能猜默认目标');
    await assert.rejects(() => query({ 条数: -1 }), invalid);
    for (const field of ['用量', '累计准入', '结算', '释放', '清零', '执行键', '结果', '类别', '上限']) await assert.rejects(() => query({ [field]: 0 }), invalid, field);
    for (const action of ['budget_reserve', 'budget_settle', 'budget_release', 'budget_configure']) await assert.rejects(() => act({ action, id: goal.id }), e => e instanceof InvalidBody);
    await assert.rejects(() => act({ ...budgetArgs(goal.id, 0, 100), 面: 'command', subject: SOVEREIGN }), e => e instanceof Denied && /命令面/.test(e.message));
    assert.equal(await log(), before);
  }));

  it('人侧初配0与当前修订严格分离；不接受负数/无限大/伪计量，也不改目标状态', async () => scene(async ({ org, goal, configure, query, log }) => {
    await assert.rejects(() => configure(1, 0), invalid, '首次只能以预算修订0配置');
    assert.equal(await log(), null);
    let internal;
    const configureService = org.budgets.configure.bind(org.budgets);
    org.budgets.configure = async (id, spec) => { internal = spec.执行计划; return configureService(id, spec); };
    const first = await configure(0, 0);
    assert.equal(Object.isFrozen(internal), true);
    assert.equal(internal.动作, 'budget_configure');
    assert.equal(internal.主体.kind, '主权者');
    assert.equal(first.主体.kind, '主权者');
    assert.equal(first.预算.预算修订, 1);
    assert.equal(first.预算.上限, 0);
    assert.equal(first.预算.累计准入, 0);
    assert.equal(first.预算.可准入, 0);
    const before = await log();
    for (const args of [[0, 8], [1, -1], [1, Infinity], [1.1, 8], [1, Number.MAX_SAFE_INTEGER + 1]]) await assert.rejects(() => configure(...args), invalid);
    for (const key of ['用量', '已结算', '释放', '状态', '执行计划', '认证']) await assert.rejects(() => configure(1, 8, { [key]: key === '状态' ? '已完成' : true }), invalid);
    assert.equal(await log(), before);
    assert.equal((await org.goals.get(goal.id, { subject: LEAD, 项目: P })).状态, '进行中');
    const next = await configure(1, 2);
    assert.equal(next.预算.预算修订, 2);
    assert.equal((await query()).上限, 2);
  }));

  it('真实member_spawn消费一次准入；耗尽在host前拒绝，调低/抬高上限都不reset累计', async () => scene(async ({ calls, configure, query, task, spawn }) => {
    await configure(0, 1);
    const first = await task();
    await spawn(first);
    const spent = await query({ 条数: 1, 偏移: 0 });
    assert.equal(calls.spawn, 1);
    assert.equal(spent.累计准入, 1);
    assert.equal(spent.已结算, 1);
    assert.equal(spent.未决占用, 0);
    assert.equal(spent.可准入, 0);
    assert.equal(spent.尝试页.条目.length, 1);
    assert.equal(typeof spent.尝试页.条目[0].执行键, 'string');
    assert.equal(spent.token, null);
    assert.equal(spent.费用, null);
    const second = await task();
    await assert.rejects(() => spawn(second), e => e instanceof Denied && /预算|额度|准入/.test(e.message));
    assert.equal(calls.spawn, 1, '不得先创建host再发现额度耗尽');
    const low = (await configure(1, 0)).预算;
    assert.equal(low.累计准入, 1);
    assert.equal(low.上限, 0);
    assert.equal(low.可准入, 0);
    const raised = (await configure(2, 2)).预算;
    assert.equal(raised.累计准入, 1);
    assert.equal(raised.可准入, 1);
    await spawn(second);
    assert.equal(calls.spawn, 2);
    const final = await query();
    assert.equal(final.累计准入, 2);
    assert.equal(final.可准入, 0);
    const firstPage = (await query({ 条数: 1, 偏移: 0 })).尝试页;
    const secondPage = (await query({ 条数: 1, 偏移: 1 })).尝试页;
    assert.equal(firstPage.条目.length, 1);
    assert.equal(secondPage.条目.length, 1);
    assert.notEqual(firstPage.条目[0].执行键, secondPage.条目[0].执行键);
    assert.equal(firstPage.hasMore, true);
    assert.equal(secondPage.hasMore, false);
  }));

  it('host抛出未取得可靠创建回执：保持未决占用，不能伪补结算或免费重试', async () => scene(async ({ goal, host, calls, configure, task, spawn, query }) => {
    await configure(0, 1);
    const node = await task();
    host.subagents.startContinuable = async () => { calls.spawn += 1; throw new Error('host-creation-failed'); };
    let error;
    try { await spawn(node); } catch (e) { error = e; }
    assert.ok(error);
    const result = await query();
    assert.equal(calls.spawn, 1);
    assert.equal(result.累计准入, 1);
    assert.equal(result.可准入, 0);
    assert.equal(result.已结算, 0);
    assert.equal(result.未决占用, 1, 'host抛错不证明创建结果，可以保留准入占用但不能编造结算');
    const key = result.尝试页.条目[0].执行键;
    assert.ok(describeFailure(error).已确认阶段?.some(stage => stage.预算目标 === goal.id && stage.执行键 === key), 'host结果未知仍保留已确认的占用事实');
    const operationId = describeFailure(error).已确认阶段.find(stage => stage.任务 === node.id && stage.操作id)?.操作id;
    await assert.rejects(() => spawn(node), existingOperationFor(node.id, operationId));
    assert.equal(calls.spawn, 1, '失败后没有无条件免费重试');
    assert.deepEqual(await query(), result, '已有意图阻止重复派活，不增加准入或补造结算');
  }));

  it('reserve已落线但审计失败：host零调用、占用保持未决，公开回执保留服务执行键', async () => scene(async ({ org, goal, calls, configure, task, spawn, query }) => {
    await configure(0, 1);
    const node = await task();
    const append = org.audit.append.bind(org.audit);
    org.audit.append = async (row) => {
      if (row.结果 === 'budget_reserved') throw new Error('reserve-audit-down');
      return append(row);
    };
    let error;
    try { await spawn(node); } catch (e) { error = e; }
    assert.ok(error instanceof Fault, '必须真正拦在准入事件落线后的审计失败处');
    assert.equal(calls.spawn, 0);
    const result = await query();
    assert.equal(result.累计准入, 1);
    assert.equal(result.未决占用, 1);
    assert.equal(result.已结算, 0);
    assert.equal(result.可准入, 0);
    const key = result.尝试页.条目[0].执行键;
    assert.equal(typeof key, 'string');
    const receipt = describeFailure(error);
    assert.equal(receipt.可重试, false);
    assert.ok(receipt.已确认阶段.some(stage => stage.对象id === goal.id && stage.执行键 === key), '保留已确认的预算目标和执行键，不能展开原始detail代替安全回执');
    assert.ok(!Object.hasOwn(receipt, 'detail'));
  }));

  it('host已可靠创建但settle审计失败：继续登记绑定派发，只把预算结果记账标为需核对', async () => scene(async ({ org, goal, calls, configure, task, spawn, query, log }) => {
    await configure(0, 1);
    const node = await task();
    const append = org.audit.append.bind(org.audit);
    let failed = 0;
    org.audit.append = async (row) => {
      if (row.结果 === 'budget_settled') { failed += 1; throw new Error('settled-audit-down'); }
      return append(row);
    };
    const result = await spawn(node);
    assert.equal(failed, 1, '故障必须命中真实settle事件落线后的审计');
    assert.deepEqual(calls, { spawn: 1, send: 1, release: 0 });
    assert.equal(result.已登记, true);
    assert.equal(result.已派发, true);
    assert.equal(result.已发开工书, true);
    assert.equal(result.预算.目标, goal.id);
    assert.equal(result.预算.已准入, true);
    assert.equal(result.预算.结果记账, '需核对');
    assert.equal(typeof result.预算.执行键, 'string');
    assert.equal((await org.registry.identity()).members[result.实例].status, '在岗');
    const current = await org.tasks.get(node.id, { 项目: P });
    assert.equal(current.状态, '已派发');
    assert.ok(current.绑定.some(binding => binding.实例 === result.实例));
    const budget = await query();
    assert.equal(budget.累计准入, 1);
    assert.equal(budget.已结算, 1, '已落线的settled事实与审计完整性分开');
    assert.equal(budget.未决占用, 0);
    assert.equal(budget.尝试页.条目[0].执行键, result.预算.执行键);
    assert.equal((await log()).trim().split('\n').map(JSON.parse).filter(row => row.kind === 'budget_settled').length, 1);
    await assert.rejects(() => spawn(node), existingOperationFor(node.id, result.操作.操作id));
    assert.equal(calls.spawn, 1, '预算记账故障不得重建已创建成员');
    assert.deepEqual(await query(), budget, '重复调用不新增预算事实');
  }));

  it('query只开放真实当前Lead/主权者，成员、复核员、停岗Lead与自报身份均拒', async () => scene(async ({ org, goal, configure, query, act, log }) => {
    await configure(0, 3);
    assert.equal((await query({}, SOVEREIGN)).上限, 3);
    const before = await log();
    for (const subject of [MEMBER, REVIEWER]) await assert.rejects(() => query({}, subject), e => e instanceof Denied);
    await assert.rejects(() => act({ action: 'budget_query', id: goal.id, role: 'Lead' }, MEMBER), e => e instanceof Denied);
    await assert.rejects(() => act({ action: 'budget_query', id: goal.id, 认证: '主权者' }), e => e instanceof InvalidBody);
    await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '预算读域当前资格复判' });
    await assert.rejects(() => query(), e => e instanceof Denied);
    assert.equal(await log(), before);
  }));

  it('配置事件已落线但审计失败保留目标id；不把业务提交故障说成未配置', async () => scene(async ({ org, goal, configure, query }) => {
    const append = org.audit.append.bind(org.audit);
    org.audit.append = async (row) => {
      if (/budget.*configur|预算.*配置/i.test(String(row.结果))) throw new Error('budget-audit-down');
      return append(row);
    };
    let error;
    try { await configure(0, 2); } catch (e) { error = e; }
    assert.ok(error instanceof Fault, '必须实际打中预算落线后的审计追加故障');
    const receipt = describeFailure(error);
    assert.equal(receipt.提交状态, '已提交');
    assert.equal(receipt.可重试, false);
    assert.ok(receipt.已确认阶段.some(stage => stage.对象id === goal.id));
    assert.equal((await query()).预算修订, 1);
    assert.equal((await query()).上限, 2);
  }));

  it('已批准配置回放成功但审批完成记账失败，保留预算目标id且不记业务失败', async () => scene(async ({ org, act, goal, query, log }) => {
    const args = budgetArgs(goal.id, 0, 2);
    // 正常人侧不需要自己批准自己；此夹具覆盖已有完整批准记录的真实重放分支。
    const plan = await 介入计划Of({ org, 项目: P, action: 'budget_decide', args, subject: SOVEREIGN });
    const request = await org.intervention.记请求({ subject: SOVEREIGN, action: 'budget_decide', args, 目标: null, 项目: P, 档位: org.policy.intervention(), 规则: '测试已存在完整预算批准记录', 步骤: plan.步骤 });
    await org.intervention.人侧决议({ 请求id: request.请求id, 决定: '批准', 通道: '设置页', 认证: '宿主Connection已认证' });
    let failed = 0;
    org.intervention.记完成 = async () => { throw new Error('budget-approval-report-down'); };
    org.intervention.记失败 = async () => { failed += 1; };
    let error;
    try { await act({ ...args, 审批引用: request.请求id }, LEAD, 'command'); } catch (e) { error = e; }
    assert.ok(error instanceof Fault);
    assert.equal(error.code, 'APPROVAL_COMPLETION_AUDIT_FAILED');
    assert.equal(failed, 0);
    const receipt = describeFailure(error);
    assert.equal(receipt.提交状态, '已提交');
    assert.equal(receipt.可重试, false);
    assert.ok(receipt.已确认阶段.some(stage => stage.对象id === goal.id));
    assert.equal((await query()).预算修订, 1);
    const before = await log();
    await assert.rejects(() => act({ ...args, 审批引用: request.请求id }, LEAD, 'command'), invalid);
    assert.equal(await log(), before);
  }));
});

it('真实tool/command共用预算入口：仅query在工具白名单，预算修订0与上限数字按命令解析', async () => {
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
    const invoke = (args) => tool.execute(args, { name: 'mind', agent, signal: new AbortController().signal }).then(JSON.parse);
    assert.ok(ACTIONS.includes('budget_query'));
    assert.ok(READ_ONLY_ACTIONS.includes('budget_query'));
    assert.equal(tool.isConcurrencySafe({ action: 'budget_query' }), true);
    assert.ok(COMMAND_ONLY_ACTIONS.includes('budget_decide'));
    for (const action of ['budget_decide', 'budget_reserve', 'budget_settle', 'budget_release', 'budget_configure']) assert.equal(tool.parameters.properties.action.enum.includes(action), false);
    const goal = (await invoke(goalArgs('real-host-budget'))).目标;
    const initial = await invoke({ action: 'budget_query', id: goal.id });
    assert.equal(initial.成功, true, JSON.stringify(initial));
    assert.equal(initial.预算.配置, null);
    const blocked = await invoke({ ...budgetArgs(goal.id, 0, 10), 面: 'command' });
    assert.equal(blocked.成功, false);
    assert.match(blocked.理由, /命令面/);
    const configured = JSON.parse((await command.handler({ agent, rawInput: `budget_decide id=${goal.id} 预算修订=0 上限=2` })).text);
    assert.equal(configured.成功, true, JSON.stringify(configured));
    assert.equal(configured.主体.kind, '主权者');
    assert.equal(configured.预算.上限, 2);
    assert.equal(configured.预算.预算修订, 1);
    const page = JSON.parse((await command.handler({ agent, rawInput: `budget_query id=${goal.id} 条数=1 偏移=0` })).text);
    assert.equal(page.成功, true, JSON.stringify(page));
    assert.equal(page.预算.尝试页.条数, 1);
    const extra = JSON.parse((await command.handler({ agent, rawInput: `budget_decide id=${goal.id} 预算修订=1 上限=5 用量=0` })).text);
    assert.equal(extra.成功, false);
    assert.equal((await org.budgets.query(goal.id, { subject: LEAD, 项目: P })).预算修订, 1);
  } finally { host.清理(); await f.cleanup(); }
});
