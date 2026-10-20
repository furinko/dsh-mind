/**
 * 补修F · 入口级三段真链（Lead 2026-10-18：不拿域单测替端到端）。
 *
 * 走**真实动作入口** `runAction`：
 *  - task_create：挂起 → 批准 → 带审批引用重放（冻结入参）→ 完成；重复重放被拒；
 *  - member_spawn：挂起时 **host 未创建子**；批准后重放才创建/登记/绑定/派发；
 *  - task_settle 多候选：一次批准覆盖 settle + 多条知识晋升 + 归档，不逐门重新挂起。
 * 三链都用真实 TaskGraph / MemoryService / RoleRegistry，不手工拼 policy.check。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, seedReviewRelation, LEAD, REVIEWER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { readJsonl } from '../src/kernel/fsx.js';
import { runAction } from '../lib/actions.js';
import { Denied, InvalidBody, NeedsApproval } from '../src/kernel/errors.js';

const P = 'proj-f-entry-chains';

async function 起(默认档位 = '放权') {
  const f = await makeFixture({ defaults: { 介入度: 默认档位 } });
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

async function 切档(f, org, 档位) {
  await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: 档位 }, null, 2));
  assert.equal(await org.policy.reload(), true);
}

/** member_spawn 的宿主束：只记调用次数，不碰真实运行时。 */
function 假宿主() {
  const 调用 = { 创建: 0, 发消息: 0, 停用: 0 };
  return {
    调用,
    宿主: {
      agent: { session: { id: 'lead-session' } },
      delegation: { authorize: () => ({ fingerprint: 'test-auth' }), status: () => ({}) },
      subagents: {
        startContinuable: async () => { 调用.创建 += 1; return { childId: 'member-spawned', messageId: 'initial-accepted' }; },
        sendMessage: async () => { 调用.发消息 += 1; return 'work-inbox-accepted'; },
        drainContinuableChildren: async () => { 调用.停用 += 1; },
      },
    },
  };
}

/** 跑一次写动作；返回错误或结果。 */
async function 跑(org, 宿主, args) {
  return await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, 面: 'tool', ...(宿主 ? { 宿主 } : {}), args });
}

function 取请求id(error) {
  const id = error?.detail?.请求id;
  assert.equal(typeof id, 'string', `挂起必须给请求 id，实际：${JSON.stringify(error?.detail ?? null)}`);
  return id;
}

describe('① task_create 入口链', () => {
  it('挂起无副作用 → 批准 → 冻结重放成功 → 重复重放拒', async () => {
    const { f, org } = await 起('审批');
    try {
      let 请求id = null;
      await assert.rejects(
        () => 跑(org, null, { action: 'task_create', 描述: '入口链一', 负责人: 'lead', 判据: 'x' }),
        (e) => e instanceof NeedsApproval && (请求id = 取请求id(e), true),
      );
      assert.equal((await org.tasks.list({ 项目: P })).length, 0, '挂起时未建节点');
      await org.intervention.人侧决议({ 请求id, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证' });
      const 回 = await 跑(org, null, { action: 'task_create', 描述: '入口链一', 负责人: 'lead', 判据: 'x', 审批引用: 请求id });
      assert.ok(回.节点?.id, '重放建出节点');
      assert.equal((await org.tasks.list({ 项目: P })).length, 1);
      assert.equal((await org.intervention.投影({ 项目: P })).find((x) => x.请求id === 请求id).状态, '已完成');
      await assert.rejects(
        () => 跑(org, null, { action: 'task_create', 描述: '入口链一', 负责人: 'lead', 判据: 'x', 审批引用: 请求id }),
        (e) => e instanceof Denied,
        '已完成请求不许再次重放',
      );
      assert.equal((await org.tasks.list({ 项目: P })).length, 1, '重复重放不产生第二份副作用');
    } finally {
      await f.cleanup();
    }
  });
});

describe('② member_spawn 入口链', () => {
  it('挂起时 host 未创建子；批准后重放才创建/登记/绑定/派发；重复重放拒', async () => {
    const { f, org } = await 起('放权');
    try {
      const 节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '派活链', 负责人: '插件工程', 判据: ['x'] });
      await 切档(f, org, '审批');
      const { 宿主, 调用 } = 假宿主();
      let 请求id = null;
      await assert.rejects(
        () => 跑(org, 宿主, { action: 'member_spawn', 方式: 'subagent', 任务书: '开工', 节点: 节点.id, 岗位: '插件工程' }),
        (e) => e instanceof NeedsApproval && (请求id = 取请求id(e), true),
      );
      assert.equal(调用.创建, 0, '挂起时不得先创建子（副作用前拦截）');
      assert.equal((await org.registry.identity()).members['member-spawned'], undefined, '挂起时未登记实例');
      assert.equal((await org.tasks.get(节点.id, { 项目: P })).状态, '待派发', '挂起时节点未派发');

      await org.intervention.人侧决议({ 请求id, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证' });
      const 回 = await 跑(org, 宿主, { action: 'member_spawn', 方式: 'subagent', 任务书: '开工', 节点: 节点.id, 岗位: '插件工程', 审批引用: 请求id });
      assert.equal(回.实例, 'member-spawned');
      assert.equal(调用.创建, 1, '批准后只创建一次子');
      assert.equal((await org.registry.identity()).members['member-spawned'].status, '在岗', '实例已登记在岗');
      assert.equal((await org.tasks.get(节点.id, { 项目: P })).状态, '已派发', '节点已绑定并派发');
      assert.equal(调用.发消息, 1, '开工书只发一次');

      await assert.rejects(
        () => 跑(org, 宿主, { action: 'member_spawn', 方式: 'subagent', 任务书: '开工', 节点: 节点.id, 岗位: '插件工程', 审批引用: 请求id }),
        (e) => e instanceof Denied,
      );
      assert.equal(调用.创建, 1, '重复重放不再创建子');
    } finally {
      await f.cleanup();
    }
  });
});

describe('③ task_settle 多候选入口链', () => {
  it('一次批准覆盖 settle + 两条知识晋升 + 归档；不逐门重新挂起', async () => {
    const { f, org } = await 起('放权');
    try {
      const 节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '结账链', 负责人: 'lead', 判据: ['x'] });
      await org.tasks.dispatch(节点.id, { subject: LEAD, 项目: P });
      await org.tasks.start(节点.id, { subject: LEAD, 项目: P });
      await org.tasks.submit(节点.id, { subject: LEAD, 项目: P, 结论: '结论', 结论层: '方案A', 知识候选: ['候选甲', '候选乙'] });
      await seedReviewRelation(f, { 项目: P, 目标: 节点.id });
      const 过 = await org.tasks.review(节点.id, { subject: REVIEWER, 项目: P, 三态: '过' });
      await org.tasks.accept(节点.id, { subject: LEAD, 项目: P, 票: 过.待采纳?.票 });
      await 切档(f, org, '审批');

      const 处置 = { '候选/lead/0': '晋升', '候选/lead/1': '晋升' };
      let 请求id = null;
      await assert.rejects(
        () => 跑(org, null, { action: 'task_settle', id: 节点.id, 记忆处置: 处置 }),
        (e) => e instanceof NeedsApproval && (请求id = 取请求id(e), true),
      );
      assert.equal((await org.tasks.get(节点.id, { 项目: P })).状态, '已采纳', '挂起时未结账');
      assert.equal((await org.memory.query({ subject: LEAD, 类: ['知识'], 项目: P })).条目.length, 0, '挂起时未产知识');
      assert.equal((await org.audit.read({})).filter((r) => r.动作 === '介入请求').length, 1, '整单只登记一个请求（不逐候选挂起）');

      await org.intervention.人侧决议({ 请求id, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证' });
      const 回 = await 跑(org, null, { action: 'task_settle', id: 节点.id, 记忆处置: 处置, 审批引用: 请求id });
      assert.equal((await org.tasks.get(节点.id, { 项目: P })).状态, '已结账', '一次批准完成结账');
      assert.equal(Object.keys(回.节点?.记忆晋升 ?? {}).length, 2, '两条候选都真实产出知识');
      assert.equal((await org.memory.query({ subject: LEAD, 类: ['知识'], 项目: P })).条目.length, 2);
      assert.equal((await org.intervention.投影({ 项目: P })).find((x) => x.请求id === 请求id).状态, '已完成');

      await assert.rejects(
        () => 跑(org, null, { action: 'task_settle', id: 节点.id, 记忆处置: 处置, 审批引用: 请求id }),
        (e) => e instanceof Denied,
      );
      assert.equal((await org.memory.query({ subject: LEAD, 类: ['知识'], 项目: P })).条目.length, 2, '重复重放不重复产知识');
    } finally {
      await f.cleanup();
    }
  });
});

describe('④ 结账单源：只读 settlePlan 与执行业务消费同一结果', () => {
  it('settlePlan 零写；执行后写的东西与计划意图一致；非法处置同一把尺', async () => {
    const { f, org } = await 起('放权');
    try {
      const 节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '单源链', 负责人: 'lead', 判据: ['x'] });
      await org.tasks.dispatch(节点.id, { subject: LEAD, 项目: P });
      await org.tasks.start(节点.id, { subject: LEAD, 项目: P });
      await org.tasks.submit(节点.id, { subject: LEAD, 项目: P, 结论: '结论', 结论层: '方案A', 知识候选: ['甲', '乙'] });
      await seedReviewRelation(f, { 项目: P, 目标: 节点.id });
      const 过 = await org.tasks.review(节点.id, { subject: REVIEWER, 项目: P, 三态: '过' });
      await org.tasks.accept(节点.id, { subject: LEAD, 项目: P, 票: 过.待采纳?.票 });
      const 经历 = await org.memory.remember({ subject: LEAD, 类: '经历', 内容: '经历甲', 项目: P, 来源: { 谁: 'lead', 怎么知道: '单源测试' }, 来源引用: [节点.id] });
      // 归档要有可归档的作答条目（0 条时 archiveAnswers 不追加行，读数无从对账）。
      await org.memory.remember({ subject: LEAD, 类: '作答', 内容: '一条作答', 项目: P, 来源: { 谁: 'lead', 怎么知道: '单源测试' } });
      const 处置 = { '候选/lead/0': '晋升', '候选/lead/1': '留账本', [经历.id]: '丢弃' };

      const 快照 = async () => ({
        审计: (await org.audit.read({})).length,
        任务事件: (await readJsonl(f.layout.taskLog(P))).length,
        知识: (await readJsonl(f.layout.memoryLog(P, '知识'))).length,
        经历: (await readJsonl(f.layout.memoryLog('跨项目', '经历'))).length,
        作答: (await readJsonl(f.layout.memoryLog(P, '作答'))).length,
      });
      const 前 = await 快照();
      const 计划 = await org.tasks.settlePlan(节点.id, { 项目: P, 记忆处置: 处置 });
      assert.deepEqual(await 快照(), 前, 'settlePlan 必须是只读的（零写：审计/任务事件/记忆账本都不动）');
      assert.equal(计划.晋升计划.length, 1, '候选 1 留账本、候选 0 晋升 ⇒ 只计划一条晋升');
      assert.deepEqual(计划.丢弃, [经历.id], '丢弃只含判了丢弃的经历候选');
      assert.equal(计划.晋升计划[0].幂等键, `${P}|${节点.id}|候选/lead/0`, '幂等键与 memory.promoteFromAdopted 同一口径');
      assert.equal(计划.晋升计划[0].内容, '甲', '晋升内容来自候选，计划里可预览真正将写什么');
      await assert.rejects(
        () => org.tasks.settlePlan(节点.id, { 项目: P, 记忆处置: { ...处置, '候选/lead/9': '晋升' } }),
        (e) => e instanceof InvalidBody,
        '非法处置在计划阶段就拒（同一把尺，不等到写）',
      );

      await org.tasks.settle(节点.id, { subject: LEAD, 项目: P, 记忆处置: 处置 });
      const 后 = await 快照();
      assert.equal(后.知识 - 前.知识, 1, '计划里只有 1 条晋升 ⇒ 只产 1 条知识');
      assert.ok(后.经历 > 前.经历, '丢弃 = 追加失效状态行（不是删）');
      assert.ok(后.作答 > 前.作答, '归档作答');
      assert.equal((await org.tasks.get(节点.id, { 项目: P })).状态, '已结账');
    } finally {
      await f.cleanup();
    }
  });
});
