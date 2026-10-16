/**
 * 合法复核与调度路径可靠可用（task-合法复核与调度路径可靠可用-第一-dv2jf · 2026-10-16）。
 * 依据：audits/mind-2026-10-16/复核汇总与后续顺序.md 第四节第1条（先让合法复核与调度路径
 * 可靠可用）＋ 审查报告 R19（member_spawn 授权引用未透传）/ R02（复核员在非复核动作上
 * 被当作普通成员）的修复方向。
 *
 * 三块判据：
 *  ① R19：member_spawn 起复核员**之前**预检授权引用（空/悬空 ⇒ 拒且零创建，不「先造再杀」），
 *     透传给 registry.assign 正式闸（不拆闸）；矩阵＝普通成员/复核员 × team/subagent ×
 *     无授权/有授权，逐格断言；普通成员路径无回归。
 *  ② 统一可信角色解析（R02 收口）：复核员岗成员主体在 runAction 门② 解析成复核者——
 *     即使持**自己负责的已派发任务**＋任务上下文齐全，也拿不到普通业务写权（修前这正是
 *     R02 实证的越权面：scopeOf 命中负责人名单即放行）；review/read 本职不受损；
 *     普通成员任务内写不受影响。
 *  ③ task_criteria：受管冻结判据只读入口——被指派复核者读到判据原文与指派事实；
 *     未指派成员拒；白名单投影不含他人结论/未揭名答案（性质断言）。
 *
 * 断言全部钉在 runAction 级（缺口的真实发生面），不在服务层重测既有覆盖。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { DelegationPolicy } from '../src/delegation-policy.js';
import { runAction } from '../lib/actions.js';
import { Denied } from '../src/kernel/errors.js';

const P = 'proj-reviewpath';

/** 岗位卡（私有区，registry.assign 的锁内存在性复检要读到卡）。 */
const 岗位卡 = (id) => [
  '---', `id: ${id}`, 'kind: 身份', 'authority: 自治', 'zone: 私有', 'domain: 个体', 'version: 1', '---',
  `# ${id}`, '', '## 个体L0 · 身份', `${id} 岗。`, '',
  '## 个体L1 · 规则', '先搜后写。', '',
  '## 个体L2 · 能力', '- 无', '',
  '## 个体L3 · 经验', '- 无',
].join('\n');

/** 主体形状：member-a/b 插件工程；reviewer 是 复核员·在岗（makeFixture 默认档案），
 *  用 kind=成员 模拟 teammate 复核员的宿主主体（subject.js 第 1 档：会话事实不带岗位）。 */
const MEMBER_A = { id: 'member-a', kind: '成员', roleId: '插件工程' };
const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };
const 复核员成员 = { id: 'reviewer', kind: '成员' };

/** 假宿主（与 delegation.test.js 同款形状）：记录调用、可控名册，不碰真实执行体。 */
function 假宿主() {
  const calls = { spawn: [], teamSend: [], subSend: [], interrupts: [] };
  const agent = { id: 'lead-agent', session: { id: 'sess-lead' } };
  const agentTeams = {
    spawnTeammate: async (_caller, req) => { calls.spawn.push(req); return { member: { id: `team-${calls.spawn.length}`, name: req.name } }; },
    sendMessage: async (_caller, req) => { calls.teamSend.push(req); return { messageId: `tm-${calls.teamSend.length}` }; },
    listMembers: () => [],
    interrupt: (_caller, name) => { calls.interrupts.push(name); return { previousStatus: 'running' }; },
  };
  const subagents = {
    startContinuable: async (spec) => { calls.spawn.push(spec); return { childId: `sub-${calls.spawn.length}`, messageId: 'm0' }; },
    sendMessage: async (_sender, id, content) => { calls.subSend.push({ id, content }); return `sm-${calls.subSend.length}`; },
    interrupt: (id) => { calls.interrupts.push(id); },
    drainContinuableChildren: async (_parent, ids) => { calls.interrupts.push(...ids); },
    listChildren: async () => [],
  };
  return {
    宿主: { agent, agentTeams, subagents, delegation: new DelegationPolicy({ mode: 'lead-discretion', projects: [P], authorizationRef: 'test-grant' }) },
    calls,
  };
}

async function 起现场() {
  const f = await makeFixture({
    rules: {
      '集体L3-成员角色卡/插件工程.md': 岗位卡('插件工程'),
      '集体L3-成员角色卡/复核员.md': 岗位卡('复核员'),
    },
  });
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

describe('① R19：member_spawn 授权引用预检＋透传（矩阵）', () => {
  let f;
  let org;
  let 束;
  let 决议节点;
  before(async () => {
    ({ f, org } = await 起现场());
    束 = 假宿主();
    // 授权引用存在性校验的载体：任务图里真实出现的决议节点（与 subject-creation.test.js 同口径）。
    决议节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '决议-复核员任命依据', 负责人: 'lead', 判据: ['决议在案'] });
  });
  after(async () => {
    await f.cleanup();
  });
  const 执行 = (args) => runAction({ org, 项目: P, 主体: LEAD, subject: LEAD, args, 宿主: 束.宿主 });
  const 建待发节点 = (岗位) => org.tasks.create({ subject: LEAD, 项目: P, 描述: `spawn-${岗位}`, 负责人: [岗位], 判据: ['判据一'] });

  it('格1-4：普通成员（插件工程）× team/subagent × 无授权/有授权 ⇒ 四格全过（不要求授权，无回归）', async () => {
    for (const 方式 of ['team', 'subagent']) {
      for (const 授权 of [undefined, '决议-普通岗用不上']) {
        const 节点 = await 建待发节点('插件工程');
        const r = await 执行({ action: 'member_spawn', 方式, 岗位: '插件工程', 节点: 节点.id, 任务书: 'x', ...(授权 ? { 授权引用: 授权 } : {}) });
        assert.equal(r.已登记, true, `${方式}/${授权 ?? '无授权'} 应成功`);
        assert.equal(r.已派发, true);
      }
    }
    assert.equal(束.calls.spawn.length, 4, '四格各创建一次执行体');
  });

  it('格5-6：复核员 × team/subagent × 无授权 ⇒ 预检拒（不先造再杀），节点留待派发', async () => {
    for (const 方式 of ['team', 'subagent']) {
      const 节点 = await 建待发节点('复核员');
      await assert.rejects(
        () => 执行({ action: 'member_spawn', 方式, 岗位: '复核员', 节点: 节点.id, 任务书: 'x' }),
        (e) => e.name === 'InvalidBody' && /授权引用/.test(e.message) && e.detail?.阶段 === 'precheck',
        `${方式}：空授权在创建执行体之前拒`,
      );
      assert.equal((await org.tasks.get(节点.id, { 项目: P })).状态, '待派发', '节点不被半成品污染');
    }
    assert.equal(束.calls.spawn.length, 4, '预检拒 ⇒ 执行体一次都没创建（零「先造再杀」）');
  });

  it('格7：复核员 × 悬空授权 ⇒ 预检拒且零创建（与 registry_assign 同一把尺）', async () => {
    const 节点 = await 建待发节点('复核员');
    await assert.rejects(
      () => 执行({ action: 'member_spawn', 方式: 'team', 岗位: '复核员', 节点: 节点.id, 任务书: 'x', 授权引用: '决议-不存在-悬空' }),
      (e) => e.name === 'InvalidBody' && /在任务图事件流里找不到/.test(e.message) && e.detail?.阶段 === 'precheck',
    );
    assert.equal(束.calls.spawn.length, 4, '悬空授权同样零创建');
  });

  it('格8-9：复核员 × team/subagent × 有效授权 ⇒ 全链路成功，授权引用原样进链', async () => {
    for (const 方式 of ['team', 'subagent']) {
      const 节点 = await 建待发节点('复核员');
      const r = await 执行({ action: 'member_spawn', 方式, 岗位: '复核员', 节点: 节点.id, 任务书: '复核某节点', 授权引用: 决议节点.id });
      assert.equal(r.已登记, true, `${方式} 应成功`);
      assert.equal(r.已派发, true);
      const m = (await org.registry.identity()).members[r.实例];
      assert.equal(m.岗位, '复核员', '登记在复核员岗');
      assert.equal(m.status, '在岗');
      const row = (await org.audit.read({})).find((x) => x.动作 === '主体创建' && x.对象?.id === r.实例);
      assert.ok(row, '首登有「主体创建」');
      assert.equal(row.详情.授权引用, 决议节点.id, '授权依据原样进链接受复核');
    }
  });
});

describe('② 统一可信角色解析（R02 收口：复核员岗成员在入口解析成复核者）', () => {
  let f;
  let org;
  before(async () => {
    ({ f, org } = await 起现场());
  });
  after(async () => {
    await f.cleanup();
  });
  const 执行 = (主体, args) => runAction({ org, 项目: P, 主体, subject: 主体, args });

  it('a. R02 反例闭合：复核员成员持【自己负责的已派发任务】＋任务上下文写知识 ⇒ 复核者只读守卫拒', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '复核员名下任务', 负责人: 'reviewer', 判据: ['判据一'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    // 修前（R02 实证越权面）：主体形状 kind=成员 ⇒ 复核者只读守卫不触发，scopeOf 命中
    // 负责人名单 ['reviewer'] ⇒ 普通业务写放行。修后：入口解析成复核者 ⇒ #tierRule 先于
    // scopeOf 拒写。任务上下文与负责人匹配**齐全**仍是拒——证明拒的是「角色」不是「缺参数」。
    await assert.rejects(
      () => 执行(复核员成员, { action: 'memory_write', 类: '知识', 内容: 'x', 来源: '测试', 任务: node.id, project: P }),
      (e) => e instanceof Denied && /复核者只读/.test(e.rule),
      '持任务也拿不到普通业务写权（§2 复核者只读数、不改）',
    );
  });

  it('b. 复核本职不受损：同一复核员成员 task_review 照常出结论（解析后 review 放行）', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '复核本职', 负责人: 'member-a', 判据: ['判据一'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论: '交卷' });
    const r = await 执行(复核员成员, { action: 'task_review', id: node.id, 三态: '过', 分歧清单: [] });
    assert.equal(r.结论.三态, '过');
    assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '已采纳');
  });

  it('c. 读面不受损：status / workbench（复核者只读全量视图）/ policy_check / bus_read / task_criteria 全通', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '读面验证', 负责人: 'member-a', 判据: ['判据一'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论: '交卷' });
    await 执行(LEAD, { action: 'review_nominate', id: node.id, 候选: 'reviewer', 原因: '判据③测试' });
    await 执行(复核员成员, { action: 'status' });
    const wb = await 执行(复核员成员, { action: 'workbench' });
    assert.equal(wb.数据.视图, '只读全量（复核者需要看到分歧清单）', '复核者读者拿全量视图（修前成员形状切片为空——第8/10代实踩的摩擦面）');
    assert.ok(wb.数据.任务.节点.some((n) => n.id === node.id), '被复核节点在视图里');
    const pc = await 执行(复核员成员, { action: 'policy_check', 动作: 'read', target: { id: node.id, kind: '任务', authority: '只增', zone: '私有' } });
    assert.equal(pc.判定.verdict, 'allow');
    await 执行(复核员成员, { action: 'bus_read', 线程: 't-读面' });
    const tc = await 执行(复核员成员, { action: 'task_criteria', id: node.id });
    assert.equal(tc.节点.复核指派.候选, 'reviewer');
  });

  it('d. 总线写也按复核者判：bus_send ⇒ 复核者只读守卫拒', async () => {
    await assert.rejects(
      () => 执行(复核员成员, { action: 'bus_send', 线程: 't-x', 类型: '提问', 内容: 'x' }),
      (e) => e instanceof Denied && /复核者只读/.test(e.rule),
    );
  });

  it('e. 回归：普通成员（插件工程）任务内 memory_write 照常放行（解析只收复核员岗）', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '普通成员任务内写', 负责人: 'member-a', 判据: ['判据一'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    const r = await 执行(MEMBER_A, { action: 'memory_write', 类: '知识', 内容: '任务内产出', 来源: '实测', 任务: node.id, project: P });
    assert.ok(r.条目?.id ?? r.条目, '任务内写放行');
  });
});

describe('③ task_criteria：受管冻结判据只读入口', () => {
  let f;
  let org;
  before(async () => {
    ({ f, org } = await 起现场());
  });
  after(async () => {
    await f.cleanup();
  });
  const 执行 = (主体, args) => runAction({ org, 项目: P, 主体, subject: 主体, args });

  /** 建一个 member-a 已交卷、reviewer 已被池内派单的节点（复核窗口内的真实形状）。 */
  async function 建已交卷节点(描述, 结论 = 'member-a的私密结论XYZ') {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人: 'member-a', 判据: ['判据甲', '判据乙'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论 });
    await 执行(LEAD, { action: 'review_nominate', id: node.id, 候选: 'reviewer', 原因: '③测试派单' });
    return node;
  }

  it('a. 被指派复核员（成员形状·入口解析）读到判据原文＋指派事实；响应不含他人结论（性质断言）', async () => {
    const node = await 建已交卷节点('③-a');
    const r = await 执行(复核员成员, { action: 'task_criteria', id: node.id });
    assert.deepEqual(r.节点.判据, ['判据甲', '判据乙'], '判据原文逐字');
    assert.equal(r.节点.判据冻结, true);
    assert.equal(r.节点.复核指派.候选, 'reviewer', '指派事实可见');
    const 文本 = JSON.stringify(r);
    assert.ok(!文本.includes('member-a的私密结论XYZ'), '不含交卷人结论');
    assert.ok(!文本.includes('独立答案'), '不含未揭名答案容器');
    // 结构断言（不用子串「复核经过」——说明文案里本来就提到这个词，子串会误伤自己）：
    // 白名单投影里这些键必须**不存在**，而不是「存在但为空」。
    assert.equal(r.节点.独立答案, undefined, '投影无 独立答案 键');
    assert.equal(r.节点.复核经过, undefined, '投影无 复核经过 键');
    assert.equal(r.节点.讨论, undefined, '投影无 讨论 键');
    assert.equal(r.节点.产物, undefined, '投影无 产物 键');
  });

  it('b. 未指派成员读他人任务判据 ⇒ 拒（在办主体闸）', async () => {
    const node = await 建已交卷节点('③-b');
    await assert.rejects(
      () => 执行(MEMBER_B, { action: 'task_criteria', id: node.id }),
      (e) => e instanceof Denied && /在办主体/.test(e.rule),
      '未指派成员没有读他人判据的业务需要',
    );
  });

  it('c. 节点负责人可读；Lead 可读', async () => {
    const node = await 建已交卷节点('③-c');
    const own = await 执行(MEMBER_A, { action: 'task_criteria', id: node.id });
    assert.deepEqual(own.节点.判据, ['判据甲', '判据乙']);
    const lead = await 执行(LEAD, { action: 'task_criteria', id: node.id });
    assert.equal(lead.节点.复核指派.候选, 'reviewer');
  });

  it('d. 复核员读【未指派给自己】的节点 ⇒ 拒（指派是正门，不是通行证）', async () => {
    const node = await 建已交卷节点('③-d');
    const 未指派节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '③-d-未指派', 负责人: 'member-a', 判据: ['判据一'] });
    await org.tasks.dispatch(未指派节点.id, { subject: LEAD, 项目: P });
    await org.tasks.start(未指派节点.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(未指派节点.id, { subject: MEMBER_A, 项目: P, 结论: '交卷' });
    assert.notEqual(node.id, 未指派节点.id, '前置：两个不同节点');
    await assert.rejects(
      () => 执行(复核员成员, { action: 'task_criteria', id: 未指派节点.id }),
      (e) => e instanceof Denied && /在办主体/.test(e.rule),
      '复核员身份不自动开全部任务的判据读面',
    );
  });
});
