/** 持久目标经真实动作/审批/命令入口执行；测试只写临时组织。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, seedReviewRelation, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { Org } from '../src/org.js';
import { shareOrg } from '../src/runtime.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { runAction, ACTIONS, COMMAND_ONLY_ACTIONS, READ_ONLY_ACTIONS } from '../lib/actions.js';
import { Denied, InvalidBody, NeedsApproval, Fault, describeFailure } from '../src/kernel/errors.js';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'goals-entry';
const CREATE = { action: 'goal_create', 期望结果: '交付可以复验的修复', 约束: ['保留可追溯证据'], 禁止工具: [], 完成依据: ['交付已通过独立复核'], 来源: '用户当前消息的意图转述', 下一步: '建立正式执行任务' };
const invalid = (e) => e instanceof Denied || e instanceof InvalidBody;

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const act = (args, subject = LEAD, 面 = 'tool') => runAction({ org, 项目: P, 主体: subject, subject, 面, args });
    let serial = 0;
    const create = async (extra = {}) => (await act({ ...CREATE, 请求键: `entry-${++serial}`, ...extra })).目标;
    const log = () => readTextOrNull(f.layout.goalLog(P));
    const approval = async () => {
      await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' }));
      await org.policy.reload();
    };
    const approve = async (args) => {
      let id;
      await assert.rejects(() => act(args), e => e instanceof NeedsApproval && Boolean(id = e.detail.请求id));
      await org.intervention.人侧决议({ 请求id: id, 决定: '批准', 通道: '设置页', 认证: '宿主Connection已认证' });
      return id;
    };
    await run({ f, org, act, create, log, approval, approve });
  } finally { await f.cleanup(); }
}

async function hostScene(run) {
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
    const invoke = async (args) => JSON.parse(await tool.execute(args, { name: 'mind', agent, signal: new AbortController().signal }));
    const human = async (line) => JSON.parse((await command.handler({ agent, rawInput: line })).text);
    await run({ f, org, host, agent, tool, command, invoke, human });
  } finally { host.清理(); await f.cleanup(); }
}

describe('持久目标入口、权限和一次性计划', () => {
  it('模型创建只留意图转述；幂等请求认回同一目标，不授予权限或伪造人侧核验', async () => scene(async ({ act, log, org }) => {
    const args = { ...CREATE, 请求键: 'one-user-intent' };
    const first = (await act(args)).目标;
    assert.equal(first.修订, 1);
    assert.equal(first.状态, '进行中');
    assert.deepEqual(first.约束, CREATE.约束);
    assert.match(JSON.stringify(first.来源声明), /未核验/);
    const before = await log();
    const audit = await org.audit.read({});
    assert.equal((await act(args)).目标.id, first.id);
    assert.equal(await log(), before);
    assert.deepEqual(await org.audit.read({}), audit);
    assert.equal((await act({ action: 'goal_query', id: first.id })).目标.id, first.id);
    assert.equal((await org.tasks.list({ 项目: P })).length, 0, '记录目标不偷偷建任务或启动执行');
    await assert.rejects(() => act({ ...args, 期望结果: '同键偷偷换本意' }), invalid);
  }));

  it('创建审批预览与实际执行同一领域签发计划，副作用前挂起且批准只消费一次', async () => scene(async ({ org, act, log, approval, approve }) => {
    await approval();
    const args = { ...CREATE, 请求键: 'approved-create' };
    const requestId = await approve(args);
    assert.equal(await log(), null, '挂起不得先创建goal事件');
    const preview = (await org.intervention.人侧待决({ 项目: P })).find(row => row.请求id === requestId);
    assert.equal(preview.步骤.length, 1);
    assert.equal(preview.步骤[0].动作, 'create');
    assert.match(JSON.stringify(preview.步骤[0].预览), /交付可以复验的修复/);
    let internal;
    const create = org.goals.create.bind(org.goals);
    org.goals.create = async (spec) => { internal = spec.执行计划; return create(spec); };
    const checks = [];
    const check = org.policy.check.bind(org.policy);
    org.policy.check = async (spec) => { checks.push(spec); return check(spec); };
    const result = await act({ ...args, 审批引用: requestId });
    assert.equal(Object.isFrozen(internal), true);
    assert.equal(internal.动作, 'goal_create');
    assert.ok(result.目标.id);
    assert.ok(checks.some(row => row.action === 'create' && row.target.id === result.目标.id), '批准不代替真实policy复判');
    const before = await log();
    await assert.rejects(() => act({ ...args, 审批引用: requestId }), e => e instanceof Denied);
    assert.equal(await log(), before);
    assert.equal((await act(args)).目标.id, result.目标.id, '不带已消费批准引用可只读认回');
  }));

  it('Lead仅能增加限制；改本意、删限制、陈旧修订与假计划都在新审批请求前拒绝', async () => scene(async ({ org, act, create, log, approval }) => {
    const goal = await create({ 禁止工具: ['write'] });
    const revised = (await act({ action: 'goal_revise', id: goal.id, 修订: goal.修订, 约束: [...goal.约束, '保持接口兼容'], 禁止工具: ['write', 'edit'], 来源: '执行边界收紧' })).目标;
    assert.equal(revised.修订, 2);
    assert.deepEqual(revised.禁止工具.slice().sort(), ['edit', 'write']);
    await approval();
    const before = await log();
    const calls = [
      { action: 'goal_revise', id: goal.id, 修订: 2, 期望结果: '改变用户结果' },
      { action: 'goal_revise', id: goal.id, 修订: 2, 完成依据: ['我说完成就完成'] },
      { action: 'goal_revise', id: goal.id, 修订: 2, 约束: [] },
      { action: 'goal_revise', id: goal.id, 修订: 2, 禁止工具: [] },
      { action: 'goal_progress', id: goal.id, 修订: 1, 状态: '进行中', 下一步: '陈旧覆盖' },
      { action: 'goal_progress', id: goal.id, 修订: 2, 状态: '等待', 等待原因: '' },
      { action: 'goal_progress', id: goal.id, 修订: 2, 状态: '进行中', 执行计划: { 动作: 'goal_progress' } },
    ];
    for (const args of calls) await assert.rejects(() => act({ ...(args.action === 'goal_revise' ? { 来源: '修改请求' } : {}), ...args }), invalid, JSON.stringify(args));
    assert.equal(await log(), before);
    assert.deepEqual(await org.intervention.投影({ 项目: P }), []);
  }));

  it('读写仅真实在岗Lead/主权者；成员、复核员与身份自报均不能获得目标读域', async () => scene(async ({ org, act, create, log }) => {
    const goal = await create();
    const before = await log();
    for (const subject of [MEMBER, REVIEWER]) {
      for (const args of [{ action: 'goal_query', id: goal.id }, { ...CREATE, 请求键: 'forged-role' }, { action: 'goal_query', id: goal.id, role: 'Lead' }]) {
        await assert.rejects(() => act(args, subject), e => e instanceof Denied);
      }
    }
    await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '验证停岗后读域立即收回' });
    await assert.rejects(() => act({ action: 'goal_query', id: goal.id }), e => e instanceof Denied);
    assert.equal(await log(), before);
  }));

  it('命令专属目标决定不可从工具或自报面进入，来源文案不等于人侧认证', async () => scene(async ({ act, create, log }) => {
    const goal = await create();
    const before = await log();
    for (const args of [
      { action: 'goal_decide', id: goal.id, 修订: 1, 状态: '取消' },
      { action: 'goal_decide', id: goal.id, 修订: 1, 状态: '取消', 面: 'command', subject: SOVEREIGN },
    ]) await assert.rejects(() => act(args), e => e instanceof Denied && /命令面/.test(e.message));
    for (const field of ['面', 'subject', '主体', '认证', '来源已核验']) {
      await assert.rejects(() => act({ ...CREATE, 请求键: `spoof-${field}`, [field]: 'human' }), e => e instanceof InvalidBody);
    }
    assert.equal(await log(), before);
  }));

  it('goal_query列表显式分页摘要，详情保留完整约束；新Org可重建目标和进展', async () => scene(async ({ f, org, act, create }) => {
    const goals = [];
    for (let index = 0; index < 4; index += 1) goals.push(await create({ 期望结果: `分页目标${index}` }));
    const page = (await act({ action: 'goal_query', 条数: 2, 偏移: 0 })).目标清单;
    assert.equal(page.目标.length, 2);
    assert.equal(page.总数, 4);
    assert.equal(page.摘要, true);
    assert.equal(page.hasMore, true);
    const next = (await act({ action: 'goal_query', 条数: 2, 偏移: 2 })).目标清单;
    assert.equal(new Set([...page.目标, ...next.目标].map(row => row.id)).size, 4);
    const progressed = (await act({ action: 'goal_progress', id: goals[0].id, 修订: 1, 状态: '等待', 等待原因: '等待独立材料', 下一步: '材料到齐后复核' })).目标;
    const fresh = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const restored = await fresh.goals.get(goals[0].id, { subject: LEAD, 项目: P });
    assert.equal(restored.状态, '等待');
    assert.equal(restored.修订, progressed.修订);
    assert.equal(restored.等待原因, '等待独立材料');
    assert.deepEqual(restored.约束, CREATE.约束);
    assert.equal((await org.tasks.list({ 项目: P })).length, 0);
  }));

  it('目标完成必须逐项绑定真实已采纳交付；缺项及内容漂移在审批前拒绝', async () => scene(async ({ f, org, act, create, log, approval }) => {
    const goal = await create();
    const path = join(f.home, 'accepted-result.txt');
    await writeFile(path, '经过独立复核的交付正文');
    const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '目标证据任务', 负责人: LEAD.id, 判据: ['内容可独立复核'] });
    const linked = (await act({ action: 'goal_link_task', id: goal.id, 修订: 1, 任务: task.id })).目标;
    await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
    await org.tasks.start(task.id, { subject: LEAD, 项目: P });
    await org.tasks.submit(task.id, { subject: LEAD, 项目: P, 产出物引用: [path], 结论: '交付已完成' });
    await seedReviewRelation(f, { 项目: P, 目标: task.id });
    const reviewed = await org.tasks.review(task.id, { subject: REVIEWER, 项目: P, 三态: '过' });
    await org.tasks.accept(task.id, { subject: LEAD, 项目: P, 票: reviewed.待采纳.票 });
    const args = { action: 'goal_complete', id: goal.id, 修订: linked.修订, 证据: [task.id], 完成核对: [{ 依据: goal.完成依据[0], 任务: [task.id] }], 说明: '按逐条依据核对交付' };
    await approval();
    const before = await log();
    for (const bad of [{ ...args, 完成核对: [] }, { ...args, 证据: [] }, { ...args, 完成核对: [{ 依据: '替换标准', 任务: [task.id] }] }]) await assert.rejects(() => act(bad), invalid);
    await writeFile(path, '采纳后被替换的正文');
    await assert.rejects(() => act(args), invalid);
    assert.equal(await log(), before);
    assert.deepEqual(await org.intervention.投影({ 项目: P }), []);
    await writeFile(path, '经过独立复核的交付正文');
    let requestId;
    await assert.rejects(() => act(args), e => e instanceof NeedsApproval && Boolean(requestId = e.detail.请求id));
    await org.intervention.人侧决议({ 请求id: requestId, 决定: '批准', 通道: '设置页', 认证: '宿主Connection已认证' });
    const completed = (await act({ ...args, 审批引用: requestId })).目标;
    assert.equal(completed.状态, '已完成');
    await assert.rejects(() => act({ action: 'goal_progress', id: goal.id, 修订: completed.修订, 状态: '进行中' }), invalid);
    await assert.rejects(() => act({ action: 'goal_decide', id: goal.id, 修订: completed.修订, 状态: '进行中' }, LEAD, 'command'), invalid);
  }));

  it('批准目标创建成功但完成记账失败：保留真实目标id，不把成功记为业务失败', async () => scene(async ({ org, act, log, approval, approve }) => {
    await approval();
    const args = { ...CREATE, 请求键: 'completion-receipt' };
    const requestId = await approve(args);
    let failed = 0;
    org.intervention.记完成 = async () => { throw new Error('approval-report-lost'); };
    org.intervention.记失败 = async () => { failed += 1; };
    let error;
    try { await act({ ...args, 审批引用: requestId }); } catch (e) { error = e; }
    assert.ok(error instanceof Fault);
    assert.equal(failed, 0);
    const output = describeFailure(error);
    assert.equal(output.提交状态, '已提交');
    assert.equal(output.可重试, false);
    const goal = (await act(args)).目标;
    assert.ok(output.已确认阶段.some(stage => stage.对象id === goal.id));
    const before = await log();
    await assert.rejects(() => act({ ...args, 审批引用: requestId }), e => e instanceof Denied);
    assert.equal(await log(), before);
  }));
});

it('真实tool/command共用目标流程：修订数字可用，人侧决议与模型限制严格分离', async () => hostScene(async ({ invoke, human, tool }) => {
  const modelActions = ['goal_create', 'goal_query', 'goal_revise', 'goal_progress', 'goal_complete', 'goal_link_task'];
  assert.ok(COMMAND_ONLY_ACTIONS.includes('goal_decide'));
  assert.ok(!ACTIONS.includes('goal_decide'));
  assert.ok(!tool.parameters.properties.action.enum.includes('goal_decide'));
  for (const action of modelActions) assert.ok(tool.parameters.properties.action.enum.includes(action));
  assert.equal(READ_ONLY_ACTIONS.includes('goal_query'), true);
  assert.equal(tool.isConcurrencySafe({ action: 'goal_query' }), true);
  assert.equal(tool.isConcurrencySafe({ action: 'goal_progress' }), false);
  const first = await invoke({ ...CREATE, 请求键: 'host-entry' });
  assert.equal(first.成功, true, JSON.stringify(first));
  const id = first.目标.id;
  const page = await human('goal_query 条数=1 偏移=0');
  assert.equal(page.成功, true, JSON.stringify(page));
  assert.equal(page.目标清单.目标.length, 1);
  const blocked = await invoke({ action: 'goal_decide', id, 修订: 1, 状态: '暂停', 面: 'command' });
  assert.equal(blocked.成功, false);
  assert.match(blocked.理由, /命令面/);
  const paused = await human(`goal_decide id=${id} 修订=1 状态=暂停`);
  assert.equal(paused.成功, true, JSON.stringify(paused));
  assert.equal(paused.主体.kind, '主权者');
  assert.equal(paused.目标.状态, '暂停');
  const illegal = await invoke({ action: 'goal_progress', id, 修订: paused.目标.修订, 状态: '进行中' });
  assert.equal(illegal.成功, false, '模型不能恢复用户暂停的目标');
  const resumed = await human(`goal_decide id=${id} 修订=${paused.目标.修订} 状态=进行中`);
  assert.equal(resumed.成功, true, JSON.stringify(resumed));
  const mixed = await human(`goal_decide ${JSON.stringify({ id, 修订: resumed.目标.修订, 状态: '暂停', 期望结果: '混入目标改动', 来源: '用户请求' })}`);
  assert.equal(mixed.成功, false, '状态决定与目标修订不能混成一份含糊计划');
  const changed = await human(`goal_decide ${JSON.stringify({ id, 修订: resumed.目标.修订, 期望结果: '用户更新后的期望结果', 完成依据: ['用户的新验收依据'], 来源: '人侧更新期望' })}`);
  assert.equal(changed.成功, true, JSON.stringify(changed));
  assert.equal(changed.目标.期望结果, '用户更新后的期望结果');
  const leadChange = await human(`goal_revise ${JSON.stringify({ id, 修订: changed.目标.修订, 期望结果: 'Lead借命令替用户改目标', 来源: '命令面Lead请求' })}`);
  assert.equal(leadChange.成功, false, '普通命令goal_revise仍不自动升为主权者');
  const cancelled = await human(`goal_decide id=${id} 修订=${changed.目标.修订} 状态=取消`);
  assert.equal(cancelled.成功, true, JSON.stringify(cancelled));
  const revive = await human(`goal_decide id=${id} 修订=${cancelled.目标.修订} 状态=进行中`);
  assert.equal(revive.成功, false, '取消不能复活');
}));
