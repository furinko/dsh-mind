/** 共享领域计划必须在创建前暴露不匹配，并保留真实策略闸与审批重放。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { prepareMemberSpawn, memberSpawnApprovalPlan, runMemberSpawnStages } from '../lib/member-spawn-plan.js';
import { Denied, InvalidBody, Fault, NeedsApproval } from '../src/kernel/errors.js';

const P = 'member-shared-plan';

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const calls = { spawn: 0, message: 0, release: 0 };
    const created = [];
    const host = {
      agent: { session: { id: 'lead-session' } },
      delegation: { authorize: () => ({ fingerprint: 'shared-plan-authorized' }) },
      subagents: {
        startContinuable: async (spec) => { calls.spawn++; const childId = spec.childId ?? `plan-child-${calls.spawn}`; created.push({ id: childId, spec }); return { childId, messageId: 'initial-inbox' }; },
        sendMessage: async () => ({ messageId: `work-inbox-${++calls.message}` }),
        drainContinuableChildren: async () => { calls.release += 1; },
      },
      agentTeams: {
        spawnTeammate: async (_agent, request) => ({ member: { id: `plan-team-${++calls.spawn}`, name: request.name } }),
        sendMessage: async () => ({ messageId: `team-inbox-${++calls.message}` }),
        interrupt: async () => { calls.release += 1; },
      },
    };
    const create = (负责人 = '插件工程') => org.tasks.create({ subject: LEAD, 项目: P, 描述: `计划-${负责人}`, 负责人, 判据: ['产生可验收产物'] });
    const act = (args) => runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, 面: 'tool', 宿主: host, args });
    const level = async (介入度) => { await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度 })); await org.policy.reload(); };
    await run({ f, org, host, calls, created, create, act, level });
  } finally { await f.cleanup(); }
}

const request = (node, extra = {}) => ({ action: 'member_spawn', 方式: 'subagent', 岗位: '插件工程', 节点: node.id, 任务书: '实现当前判据', ...extra });

describe('member_spawn 共享计划', () => {
  it('准备只读；审批步骤、完整预览和执行阶段来自同一个不可变计划', async () => scene(async ({ org, host, calls, create }) => {
    const node = await create();
    const before = (await org.audit.read({})).length;
    const args = request(node);
    const plan = await prepareMemberSpawn({ org, 项目: P, subject: LEAD, args, 宿主: host });
    const approval = memberSpawnApprovalPlan(plan);
    assert.equal(approval.执行计划, plan);
    assert.equal(approval.步骤, plan.步骤);
    assert.deepEqual(plan.步骤, plan.阶段.flatMap((stage) => stage.步骤 ?? []));
    assert.deepEqual(plan.步骤[0].预览.执行阶段, plan.阶段.map((stage) => stage.类型));
    assert.deepEqual(plan.步骤[0].预览.判据, node.判据);
    assert.equal(plan.步骤.length, 3, '沿用登记、绑定、派发三笔策略写，不新增权限类别');
    assert.deepEqual(calls, { spawn: 0, message: 0, release: 0 });
    assert.equal((await org.audit.read({})).length, before);
    args.任务书 = '调用方事后改写';
    assert.equal(plan.入参.任务书, '实现当前判据', '不可变计划不能借用模型入参对象');
    assert.throws(() => plan.阶段.push({ 类型: 'unknown' }), TypeError);
    const order = [];
    await runMemberSpawnStages(plan, Object.fromEntries(plan.阶段.map((stage) => [stage.类型, async () => order.push(stage.类型)])));
    assert.deepEqual(order, plan.阶段.map((stage) => stage.类型));
  }));

  it('未知、缺失实际阶段或伪造计划都在任何创建之前拒绝', async () => scene(async ({ org, host, create }) => {
    const plan = await prepareMemberSpawn({ org, 项目: P, subject: LEAD, args: request(await create()), 宿主: host });
    let effects = 0;
    const handlers = Object.fromEntries(plan.阶段.map((stage) => [stage.类型, async () => { effects += 1; }]));
    await assert.rejects(() => runMemberSpawnStages(plan, { ...handlers, unknownWrite: async () => { effects += 1; } }), (e) => e instanceof Fault && e.code === 'MEMBER_SPAWN_PLAN_UNCOVERED');
    const incomplete = { ...handlers }; delete incomplete.audit;
    await assert.rejects(() => runMemberSpawnStages(plan, incomplete), (e) => e.code === 'MEMBER_SPAWN_PLAN_UNCOVERED');
    await assert.rejects(() => runMemberSpawnStages(structuredClone(plan), handlers), (e) => e.code === 'MEMBER_SPAWN_PLAN_INVALID');
    assert.equal(effects, 0, '必须先检查整个阶段表，不能等已经spawn才发现后续漏项');
  }));

  it('现有岗位不匹配反例：放权/审批两档均零创建、零登记、零审批请求', async () => scene(async ({ org, calls, create, act, level }) => {
    const before = Object.keys((await org.registry.identity()).members);
    for (const 介入度 of ['放权', '审批']) {
      await level('放权');
      const node = await create('文档整理');
      await level(介入度);
      await assert.rejects(() => act(request(node)), (e) => e instanceof Denied && /不匹配/.test(e.message));
      assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '待派发');
    }
    assert.equal(calls.spawn, 0);
    assert.equal(calls.message, 0);
    assert.deepEqual(Object.keys((await org.registry.identity()).members), before, '非法岗位不留下任何新实例，不依赖固定ID前缀');
    assert.equal((await org.audit.read({})).filter((row) => row.动作 === '介入请求').length, 0, '不可执行的业务不应让用户白批一单');
  }));

  it('Lead本人占位不被静默改派；模型不能注入阶段', async () => scene(async ({ calls, create, act }) => {
    const self = await create(LEAD.id);
    const regular = await create();
    await assert.rejects(() => act(request(self)), (e) => e instanceof Denied && /task_reassign/.test(e.howToChange));
    await assert.rejects(() => act(request(regular, { 执行计划: { 阶段: ['spawn'] } })), (e) => e instanceof InvalidBody && /不接受模型/.test(e.message));
    assert.equal(calls.spawn, 0);
  }));

  it('放权和审批均用策略单源在创建前拒同级/高岗，不留下持久子会话或无效审批', async () => scene(async ({ f, org, calls, create, act, level }) => {
    const leadCard = await readFile(join(f.factoryRoot, '集体L3-成员角色卡/Lead.md'), 'utf8');
    for (const 岗位 of ['主权者', '出厂作者']) await f.write(`集体L3-成员角色卡/${岗位}.md`, leadCard.replaceAll('Lead', 岗位));
    const before = Object.keys((await org.registry.identity()).members);
    for (const 介入度 of ['放权', '审批']) {
      for (const 岗位 of ['Lead', '主权者', '出厂作者']) {
        await level('放权');
        const node = await create(岗位);
        await level(介入度);
        await assert.rejects(() => act(request(node, { 岗位 })), error => error instanceof Denied && /不越授/.test(error.rule));
        assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '待派发');
      }
    }
    assert.deepEqual(calls, { spawn: 0, message: 0, release: 0 });
    assert.deepEqual(Object.keys((await org.registry.identity()).members), before);
    assert.equal((await org.audit.read({})).filter(row => row.动作 === '介入请求').length, 0);
  }));

  it('正常team/subagent仍真实登记、绑定、派发与投递', async () => scene(async ({ org, calls, create, act }) => {
    for (const 方式 of ['team', 'subagent']) {
      const node = await create();
      const result = await act(request(node, { 方式 }));
      assert.equal(result.已登记, true);
      assert.equal(result.已派发, true);
      assert.equal(result.已发开工书, true);
      assert.equal((await org.tasks.get(node.id, { 项目: P })).绑定[0].实例, result.实例);
      assert.equal((await org.registry.identity()).members[result.实例].status, '在岗');
    }
    assert.equal(calls.spawn, 2);
    assert.equal(calls.message, 2);
  }));

  it('复核员是可委派成员岗，仍经真实登记、精确绑定和派发', async () => scene(async ({ org, calls, create, act }) => {
    const source = await create();
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '独立复核', 负责人: ['复核员'], 判据: ['核对原产物'], 复核对象: [source.id] });
    const result = await act(request(node, { 岗位: '复核员' }));
    const current = await org.tasks.get(node.id, { 项目: P });
    assert.equal((await org.registry.identity()).members[result.实例].岗位, '复核员');
    assert.equal(current.绑定[0].实例, result.实例);
    assert.equal(current.状态, '已派发');
    assert.deepEqual(current.复核对象, [source.id]);
    assert.deepEqual(calls, { spawn: 1, message: 1, release: 0 });
  }));

  it('审批沿同一领域计划重放一次，重复审批引用仍为Denied且不重复创建', async () => scene(async ({ org, calls, create, act, level }) => {
    const node = await create();
    await level('审批');
    const args = request(node);
    let id;
    await assert.rejects(() => act(args), (e) => e instanceof NeedsApproval && Boolean(id = e.detail.请求id));
    assert.equal(calls.spawn, 0);
    const frozen = await org.intervention.读冻结({ 请求id: id, subject: LEAD });
    assert.deepEqual(frozen.步骤[0].预览.执行阶段, ['spawn', 'register', 'bind-dispatch', 'message', 'audit']);
    await org.intervention.人侧决议({ 请求id: id, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证' });
    await act({ ...args, 审批引用: id });
    await assert.rejects(() => act({ ...args, 审批引用: id }), (e) => e instanceof Denied);
    assert.equal(calls.spawn, 1);
  }));

  it('计划不会代替真实写前策略复判；登记被拒时仍不伪报就绪', async () => scene(async ({ org, calls, created, create, act }) => {
    const node = await create();
    const check = org.policy.check.bind(org.policy);
    org.policy.check = async (spec) => {
      if (spec.action === 'create' && spec.target?.kind === '身份' && spec.target.id === created[0]?.id) throw new Denied('动态拒绝', '实际登记时权限已撤回');
      return check(spec);
    };
    await assert.rejects(() => act(request(node)), (e) => e instanceof Fault && e.code === 'MEMBER_SPAWN_ASSIGN_FAILED');
    assert.equal(calls.spawn, 1);
    assert.equal(calls.release, 1);
    assert.equal(calls.message, 0);
    assert.equal((await org.registry.identity()).members[created[0].id], undefined);
  }));
});
