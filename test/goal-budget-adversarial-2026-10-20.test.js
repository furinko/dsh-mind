/** 独立预算攻击：真实 pre waterfall -> 审批 -> 同步闸 -> 结果，不执行真实宿主工具。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { createGoalBudgetHooks } from '../components/kernel/lib/goal-budget-hooks.js';

const P = 'goal-budget-independent-adversarial';
const OTHER = `${P}-other`;
const ALLOW = () => Promise.resolve({ kind: 'allow' });
const denied = value => typeof value === 'string' && value.length > 0;

async function scene(body, { limit = 5, configured = true } = {}) {
  const f = await makeFixture();
  const warnings = [];
  let hooks;
  try {
    const cwd = join(f.home, 'work'), elsewhere = join(f.home, 'other-project');
    await mkdir(join(cwd, 'nested'), { recursive: true }); await mkdir(elsewhere);
    const input = join(cwd, 'input.txt'); await writeFile(input, 'unchanged by host-budget test');
    const options = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P };
    const org = await Org.open(options);
    org.tasks.configureToolFiles({ read: [cwd], write: [cwd] });
    const goal = await org.goals.create({ subject: LEAD, 项目: P, 期望结果: '以共享准入额度完成真实交付',
      完成依据: ['有可复验结果'], 约束: ['维持权限边界'], 来源: '用户意图的未核验 Lead 转述', 下一步: '完成本轮任务' });
    const create = async (targetGoal = goal) => {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '预算独立反例任务', 负责人: '插件工程', 判据: ['保持真实权限'] });
      const current = await org.goals.get(targetGoal.id, { subject: LEAD, 项目: P });
      await org.goals.linkTask(targetGoal.id, { subject: LEAD, 项目: P, 修订: current.修订, 任务: node.id });
      return node;
    };
    const dispatch = async (node, instance = MEMBER.id) => {
      await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: instance, 岗位: MEMBER.roleId });
      return org.tasks.dispatch(node.id, { subject: LEAD, 项目: P, 工具文件范围: { 读: [cwd], 写: [cwd] } });
    };
    const source = await create(); await dispatch(source);
    if (configured) await org.budgets.configure(goal.id, { subject: SOVEREIGN, 项目: P, 预算修订: 0, 上限: limit });
    const projectOf = exec => exec.agent?.session?.header?.cwd?.startsWith(cwd) ? P : OTHER;
    const cwdOf = exec => exec.agent?.session?.header?.cwd;
    const makeHooks = () => createGoalBudgetHooks({ org, projectOf, cwdOf, logger: { warn: message => warnings.push(message) } });
    hooks = makeHooks();
    const makeAgent = (id = MEMBER.id, directory = cwd) => ({ id, session: { id, header: { cwd: directory,
      origin: 'subagent', parentSession: LEAD.id, delegationDepth: 1 } } });
    const exec = (extra = {}) => ({ name: 'read', arguments: { file_path: input }, callId: 'caller-reusable-id',
      rootCallId: 'root-request', token: Symbol('registry-owned-attempt'), signal: new AbortController().signal,
      agent: makeAgent(), ...extra });
    const query = () => org.budgets.query(goal.id, { subject: LEAD, 项目: P });
    const pre = (e, terminal = ALLOW, outer = []) => {
      const callbacks = [...outer, hooks.preExecute];
      const next = () => (callbacks.shift() ?? terminal)(e, next);
      return next();
    };
    // A fixture approval result is applied after pre, just as serviceAsk runs before guards in dsh-tools.
    const pipeline = async (e, { terminal = ALLOW, outer = [], approval = 'allowed-once', afterPre, result = { isError: false } } = {}) => {
      const decision = await pre(e, terminal, outer);
      if (afterPre) await afterPre(decision);
      if (decision.kind === 'deny' || (decision.kind === 'ask' && approval !== 'allowed-once')) {
        hooks.finish(e, { isError: true }); await hooks.flush();
        return { body: false, reason: decision.reason ?? 'approval rejected' };
      }
      assert.ok(['allow', 'ask'].includes(decision.kind));
      const reason = hooks.guard(e);
      assert.ok(!(reason && typeof reason.then === 'function'), '承重 guard 必须同步');
      hooks.finish(e, denied(reason) ? { isError: true } : result);
      await hooks.flush();
      return { body: reason === undefined, reason };
    };
    await body({ f, org, goal, source, cwd, input, elsewhere, options, hooks, makeHooks, makeAgent, exec, create, dispatch, query, pre, pipeline, warnings });
  } finally {
    if (hooks) await hooks.flush();
    await f.cleanup();
  }
}

describe('独立目标额度：真实中间件与凭据', () => {
  it('下游 deny 与原异常原样透传；外层把拒绝翻 allow 仍缺凭据，不得到 body', async () => scene(async ({ hooks, exec, pre, pipeline, query }) => {
    const refusal = { kind: 'deny', reason: 'original downstream refusal' };
    assert.equal(await pre(exec(), async () => refusal), refusal);
    const original = Error('original downstream failure');
    await assert.rejects(pre(exec(), async () => { throw original; }), error => error === original);
    const e = exec();
    const result = await pipeline(e, { terminal: async () => refusal,
      outer: [async (_exec, next) => { assert.equal(await next(), refusal); return { kind: 'allow' }; }] });
    assert.equal(result.body, false); assert.ok(denied(result.reason));
    assert.equal((await query()).累计准入, 0);
    assert.ok(denied(hooks.guard(exec())), '完全跳过 pre 同样不能得到准入');
  }));

  it('ask 在批准前预占，批准可进 body；拒绝同样计尝试且不退款', async () => scene(async ({ pipeline, exec, query }) => {
    const ask = async () => ({ kind: 'ask', reason: 'fixture user approval' });
    assert.equal((await pipeline(exec(), { terminal: ask })).body, true);
    const rejected = await pipeline(exec(), { terminal: ask, approval: 'rejected' });
    assert.equal(rejected.body, false);
    const q = await query();
    assert.equal(q.累计准入, 2); assert.equal(q.已结算, 2); assert.equal(q.未决占用, 0);
    assert.deepEqual(q.尝试页.条目.map(item => item.结果).sort(), ['error', 'success']);
  }));

  it('同 exec 并发重复 pre 只占一次，结果后旧凭据不能再次使用；同 callId 新 exec 独立计量', async () => scene(async ({ hooks, exec, pre, query, pipeline }) => {
    const e = exec();
    assert.deepEqual((await Promise.all([pre(e), pre(e)])).map(item => item.kind), ['allow', 'allow']);
    assert.equal((await query()).累计准入, 1); assert.equal(hooks.guard(e), undefined);
    hooks.finish(e, { isError: false }); hooks.finish(e, { isError: false }); await hooks.flush();
    assert.equal((await query()).已结算, 1);
    assert.equal((await pre(e)).kind, 'deny'); assert.ok(denied(hooks.guard(e)));
    const fresh = exec(); assert.equal(fresh.callId, e.callId); assert.notEqual(fresh.token, e.token);
    assert.equal((await pipeline(fresh)).body, true); assert.equal((await query()).累计准入, 2);
  }));

  for (const drift of ['arguments', 'tool', 'agent', 'project', 'cwd', 'token']) {
    it(`pre 后 ${drift} 漂移不允许迁移预占凭据`, async () => scene(async ({ hooks, exec, pre, makeAgent, cwd, elsewhere, query }) => {
      const e = exec(); assert.equal((await pre(e)).kind, 'allow');
      if (drift === 'arguments') e.arguments = { ...e.arguments, offset: 1 };
      if (drift === 'tool') e.name = 'write';
      if (drift === 'agent') e.agent = makeAgent(); // 同 id 的另一个对象也不是原 Agent。
      if (drift === 'project') e.agent.session.header.cwd = elsewhere;
      if (drift === 'cwd') e.agent.session.header.cwd = join(cwd, 'nested');
      if (drift === 'token') e.token = Symbol('replacement');
      assert.ok(denied(hooks.guard(e)));
      hooks.finish(e, { isError: true }); await hooks.flush();
      const q = await query(); assert.equal(q.累计准入, 1); assert.equal(q.可准入, 4);
    }));
  }

  it('纯进展修订不误杀已预占调用；实质约束收紧与用户暂停均令旧凭据失效', async () => scene(async ({ org, goal, hooks, exec, pre }) => {
    const e = exec(); await pre(e);
    let current = await org.goals.get(goal.id, { subject: LEAD, 项目: P });
    await org.goals.progress(goal.id, { subject: LEAD, 项目: P, 修订: current.修订, 状态: '进行中', 下一步: '已更新进展，交付边界未变化' });
    assert.equal(hooks.guard(e), undefined);
    current = await org.goals.get(goal.id, { subject: LEAD, 项目: P });
    await org.goals.revise(goal.id, { subject: LEAD, 项目: P, 修订: current.修订, 来源: '新增执行限制', 约束: [...current.约束, '保留新增限制'] });
    assert.ok(denied(hooks.guard(e)));
    const paused = exec(); await pre(paused);
    current = await org.goals.get(goal.id, { subject: LEAD, 项目: P });
    await org.goals.setState(goal.id, { subject: SOVEREIGN, 项目: P, 修订: current.修订, 状态: '暂停' });
    assert.ok(denied(hooks.guard(paused)));
  }));
});

describe('独立目标额度：共享累计、原子占用与未知', () => {
  it('三个并发真实 exec 争两次额度，恰好两次预占可放行，没有负余额', async () => scene(async ({ pre, exec, hooks, query }) => {
    const executions = [exec(), exec(), exec()];
    const decisions = await Promise.all(executions.map(e => pre(e)));
    assert.equal(decisions.filter(item => item.kind === 'allow').length, 2);
    assert.equal(decisions.filter(item => item.kind === 'deny').length, 1);
    assert.equal(executions.filter(e => hooks.guard(e) === undefined).length, 2);
    const q = await query(); assert.equal(q.累计准入, 2); assert.equal(q.可准入, 0); assert.equal(q.未决占用, 2);
  }, { limit: 2 }));

  it('同目标多个匹配任务只计一次；两个目标重叠且任一配置额度时保守拒绝分账', async () => scene(async ({ org, create, dispatch, exec, pipeline, query }) => {
    await dispatch(await create());
    assert.equal((await pipeline(exec())).body, true); assert.equal((await query()).累计准入, 1);
    const otherGoal = await org.goals.create({ subject: LEAD, 项目: P, 期望结果: '另一个目标', 完成依据: ['独立结果'],
      来源: '另一个用户意图转述', 下一步: '独立推进' });
    await dispatch(await create(otherGoal));
    const ambiguous = await pipeline(exec()); assert.equal(ambiguous.body, false);
    assert.match(ambiguous.reason, /多目标|归属/);
    assert.equal((await query()).累计准入, 1, '不能任取一目标扣账后放行');
    assert.equal((await org.budgets.query(otherGoal.id, { subject: LEAD, 项目: P })).配置, null);
  }));

  it('未配置不是零额度；Lead 原生调用无可靠目标不伪计量', async () => scene(async ({ org, goal, pipeline, exec, query, cwd, hooks }) => {
    const unconfigured = await pipeline(exec()); assert.equal(unconfigured.body, true);
    const before = await query(); assert.equal(before.累计准入, null); assert.equal(before.费用, null); assert.equal(before.token, null);
    await org.budgets.configure(goal.id, { subject: SOVEREIGN, 项目: P, 预算修订: 0, 上限: 0 });
    const lead = { id: LEAD.id, session: { id: LEAD.id, header: { cwd } } };
    assert.equal((await pipeline(exec({ agent: lead }))).body, true, '此夹具只判预算；真实原生权限仍由现有范围闸判定');
    assert.equal((await query()).累计准入, 0);
    assert.equal((await pipeline(exec())).body, false, '真实受管成员仍受零额度约束');
    assert.equal(hooks.health().failedWrites, 0, '正常额度拒绝不是记账故障，result不得伪造失败收尾');
  }, { configured: false }));

  it('未收到结果不自动返还，模块重建仍保留占用；迟到 error 结算也不恢复额度', async () => scene(async ({ org, goal, exec, pre, query, hooks, makeHooks, options }) => {
    const e = exec(); assert.equal((await pre(e)).kind, 'allow');
    let q = await query(); assert.equal(q.未决占用, 1); assert.equal(q.已结算, 0); assert.equal(q.可准入, 0);
    const replacement = makeHooks(); assert.ok(denied(replacement.guard(e)), '新模块没有旧 exec 的私有准入凭据');
    assert.equal((await replacement.preExecute(exec(), ALLOW)).kind, 'deny');
    const reopened = await Org.open(options);
    q = await reopened.budgets.query(goal.id, { subject: SOVEREIGN, 项目: P });
    assert.equal(q.累计准入, 1); assert.equal(q.未决占用, 1); assert.equal(q.可准入, 0);
    hooks.finish(e, { isError: true }); await hooks.flush(); await replacement.flush();
    q = await query(); assert.equal(q.已结算, 1); assert.equal(q.未决占用, 0); assert.equal(q.可准入, 0);
  }, { limit: 1 }));

  it('正式后继换成员也沿用目标累计，不能靠新节点或新实例刷新余额', async () => scene(async ({ org, goal, source, exec, pre, dispatch, query }) => {
    assert.equal((await pre(exec())).kind, 'allow');
    await org.tasks.close(source.id, { subject: LEAD, 项目: P, 原因: '旧结果未知；由明确后继接续' });
    const child = (await org.tasks.createSuccessor(source.id, { subject: LEAD, 项目: P, 原因: '新实例接续同一目标', 负责人: '插件工程' })).节点;
    await dispatch(child, 'member-b');
    const next = exec(); next.agent.id = 'member-b'; next.agent.session.id = 'member-b';
    const decision = await pre(next); assert.equal(decision.kind, 'deny'); assert.match(decision.reason, /耗尽|额度/);
    assert.equal(org.goals.constraintsForTask(child, await org.tasks.list({ 项目: P }), P).目标, goal.id);
    assert.equal((await query()).累计准入, 1); assert.equal((await query()).可准入, 0);
  }, { limit: 1 }));

  it('预占已落线但审计失败不给凭据；缺失回执保留未决且不准新调用', async () => scene(async ({ org, hooks, exec, pre, query, f }) => {
    const append = org.audit.append.bind(org.audit);
    org.audit.append = async row => {
      if (row.依据 === '目标额度事件流' && row.结果 === 'budget_reserved') throw Error('isolated reserve audit failed after commit');
      return append(row);
    };
    try {
      const e = exec(); const denial = await pre(e);
      assert.equal(denial.kind, 'deny'); assert.ok(denied(hooks.guard(e)));
      hooks.finish(e, { isError: true }); await hooks.flush();
      const q = await query(); assert.equal(q.累计准入, 1); assert.equal(q.未决占用, 1); assert.equal(q.已结算, 0);
      assert.ok(denial.reason.includes(q.尝试页.条目[0].执行键), '公开拒绝回执须带已提交占用的真实执行键供核对');
      const rows = (await readFile(f.layout.goalBudgetLog(P), 'utf8')).trim().split('\n').map(JSON.parse);
      assert.equal(rows.filter(row => row.kind === 'budget_reserved').length, 1);
      assert.equal(rows.filter(row => row.kind === 'budget_settled').length, 0);
      assert.equal((await pre(exec())).kind, 'deny'); assert.equal((await query()).累计准入, 1);
    } finally { org.audit.append = append; }
  }, { limit: 1 }));
});
