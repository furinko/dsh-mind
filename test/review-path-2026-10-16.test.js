/**
 * 合法复核与调度路径可靠可用（task-合法复核与调度路径可靠可用-第一-dv2jf · 2026-10-16；
 * v2 复核者降级改写 2026-10-18）。
 * 依据：audits/mind-2026-10-16/复核汇总与后续顺序.md 第四节第1条（先让合法复核与调度路径
 * 可靠可用）＋ 审查报告 R19 / R02 的修复方向；v2（口述收敛 2026-10-18 条目1/5）把复核员
 * 降为普通岗位卡后，本文件按新语义重写：
 *
 * 三块判据：
 *  ① member_spawn 起复核员与起普通成员**同一套规则**（授权引用不再必填、不再校验存在性；
 *     给了就原样进链）。R19 的「复核员预检授权引用」随降级移除。
 *  ② 统一可信岗位回填（R02 的 v2 形态）：复核员岗成员主体在 runAction 从身份档案回填
 *     roleId——即使持**自己负责的已派发任务**＋任务上下文齐全，也拿不到普通业务写权
 *     （越权面由 #preGrantBoundary 按岗位名闭合）；review/read 本职不受损；
 *     普通成员任务内写不受影响。
 *  ③ task_criteria：受管冻结判据只读入口——负责人/Lead/主权者/复核员岗可读（v2 读面放宽：
 *     复核员按岗位名放行，不再有指派闸）；未参与普通成员拒；白名单投影不含他人结论/未揭名答案。
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

/** v2 条目6：给复核员造真实关联（复核任务 + 显式复核对象）——测试准备，走真实服务。 */
async function 建复核关联(org, 目标id) {
  const 复核任务 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `复核-${目标id}`, 负责人: '复核员', 判据: ['核对'], 复核对象: [目标id] });
  await org.tasks.bind(复核任务.id, { subject: LEAD, 项目: P, 实例: 'reviewer', 岗位: '复核员' });
  await org.tasks.dispatch(复核任务.id, { subject: LEAD, 项目: P });
  return 复核任务.id;
}

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
    // 契约桩（2026-10-18 换代后）：只认 startContinuable/drainContinuableChildren；校验顶层 spec.signal 在场。
    startContinuable: async (spec) => {
      if (!(spec?.signal instanceof AbortSignal)) throw new Error('contract: spec.signal required');
      assert.equal(Object.hasOwn(spec.request, 'signal'), false, 'continuable signal belongs to outer spec');
      calls.spawn.push(spec); return { childId: `sub-${calls.spawn.length}`, messageId: 'm0' };
    },
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

describe('① v2：member_spawn 起复核员与普通成员同一套规则（授权引用不再必填）', () => {
  let f;
  let org;
  let 束;
  before(async () => {
    ({ f, org } = await 起现场());
    束 = 假宿主();
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

  it('格5-6：复核员 × team/subagent × 无授权 ⇒ 全链路成功（v2：复核员是普通岗位卡，无需任命授权）', async () => {
    for (const 方式 of ['team', 'subagent']) {
      const 节点 = await 建待发节点('复核员');
      const r = await 执行({ action: 'member_spawn', 方式, 岗位: '复核员', 节点: 节点.id, 任务书: '复核某节点' });
      assert.equal(r.已登记, true, `${方式} 应成功（Lead 按任务手动起复核员实例即就位）`);
      assert.equal(r.已派发, true);
      const m = (await org.registry.identity()).members[r.实例];
      assert.equal(m.岗位, '复核员', '登记在复核员岗');
      assert.equal(m.status, '在岗');
    }
    assert.equal(束.calls.spawn.length, 6, '前两格 4 次 + 本格 2 次');
  });

  it('格7：复核员 × 授权引用可选透传 ⇒ 不再校验存在性，给了就原样进首登「主体创建」行', async () => {
    const 节点 = await 建待发节点('复核员');
    const r = await 执行({ action: 'member_spawn', 方式: 'team', 岗位: '复核员', 节点: 节点.id, 任务书: '复核某节点', 授权引用: '决议-可选-不校验存在性' });
    assert.equal(r.已登记, true);
    const row = (await org.audit.read({})).find((x) => x.动作 === '主体创建' && x.对象?.id === r.实例);
    assert.ok(row, '首登有「主体创建」');
    assert.equal(row.详情.授权引用, '决议-可选-不校验存在性', '授权引用给了就原样进链接受复核');
  });
});

describe('② 统一可信岗位回填（v2：复核员岗成员保持成员 kind，roleId 由档案回填）', () => {
  let f;
  let org;
  before(async () => {
    ({ f, org } = await 起现场());
  });
  after(async () => {
    await f.cleanup();
  });
  const 执行 = (主体, args) => runAction({ org, 项目: P, 主体, subject: 主体, args });

  it('a. R02 反例闭合（v2 形态）：复核员成员持【自己负责的已派发任务】＋任务上下文写知识 ⇒ 复核员只读守卫拒', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '复核员名下任务', 负责人: 'reviewer', 判据: ['判据一'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    // 修前（R02 实证越权面）：主体形状 kind=成员 ⇒ 只读守卫不触发，scopeOf 命中
    // 负责人名单 ['reviewer'] ⇒ 普通业务写放行。v2：入口回填 roleId=复核员 ⇒
    // #preGrantBoundary 按岗位名先于一切拒写。任务上下文与负责人匹配**齐全**仍是拒——
    // 证明拒的是「岗位」不是「缺参数」。
    await assert.rejects(
      () => 执行(复核员成员, { action: 'memory_write', 类: '知识', 内容: 'x', 来源: '测试', 任务: node.id, project: P }),
      (e) => e instanceof Denied && /只读数/.test(e.rule),
      '持任务也拿不到普通业务写权（复核员岗 · 只读数，不改）',
    );
  });

  it('b. 复核本职不受损：同一复核员成员 task_review 照常出结论（roleId 回填后 review 放行）', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '复核本职', 负责人: 'member-a', 判据: ['判据一'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论: '交卷' });
    await 建复核关联(org, node.id);
    const r = await 执行(复核员成员, { action: 'task_review', id: node.id, 三态: '过', 分歧清单: [] });
    assert.equal(r.结论.三态, '过');
    // 补修K：复核只出可引用票、不代 Lead 采纳——回执必须带真票，采纳是 Lead 的独立一步。
    assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '已交卷', '复核「过」不自动采纳');
    assert.match(String(r.结论.票), /^rv-\d+$/, 'task_review 回执必须给出真票（指路不能只有内部字段）');
    const 采纳 = await 执行(LEAD, { action: 'task_accept', id: node.id, 票: r.结论.票 });
    assert.equal(采纳.节点.状态, '已采纳');
    assert.equal(采纳.节点.采纳?.票, r.结论.票, '采纳事件引用真票');
  });

  it('c. 读面按任务限定：workbench 只给复核任务+复核对象；task_criteria 对该节点放行', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '读面验证', 负责人: 'member-a', 判据: ['判据一'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论: '交卷' });
    await 建复核关联(org, node.id);
    await 执行(复核员成员, { action: 'status' });
    const wb = await 执行(复核员成员, { action: 'workbench' });
    assert.match(wb.数据.视图, /复核读域/, '复核员读域按「已绑定复核任务→显式复核对象」限定（v2 条目4/6）');
    assert.ok(wb.数据.任务.节点.some((n) => n.id === node.id), '复核对象在视图里');
    const pc = await 执行(复核员成员, { action: 'policy_check', 动作: 'read', target: { id: node.id, kind: '任务', authority: '只增', zone: '私有' } });
    assert.equal(pc.判定.verdict, 'allow');
    // 读域外的线程不许读原文（bus_read 与工作台同一把尺）。
    await assert.rejects(
      () => 执行(复核员成员, { action: 'bus_read', 线程: 't-读面' }),
      (e) => e instanceof Denied && /读域/.test(e.rule),
      '未关联线程不是复核员的读域',
    );
    const tc = await 执行(复核员成员, { action: 'task_criteria', id: node.id });
    assert.deepEqual(tc.节点.判据, ['判据一'], 'v2：读域内的复核目标可读冻结判据');
  });

  it('sandbox接线：真实复核员只有布尔true的实验预检可过且不放宽业务写', async () => {
    const target = { id: '隔离复核实验', kind: '产物', authority: '自治', zone: '私有' };
    const good = await 执行(复核员成员, { action: 'policy_check', 动作: 'experiment', target: { ...target, sandbox: true } });
    assert.equal(good.判定.verdict, 'allow', JSON.stringify(good.判定));
    for (const marker of [undefined, false, 'true', 1]) {
      const bad = await 执行(复核员成员, { action: 'policy_check', 动作: 'experiment', target: { ...target, sandbox: marker } });
      assert.equal(bad.判定.verdict, 'deny', `非布尔true不得冒充沙箱：${String(marker)}`);
      assert.match(bad.判定.rule, /沙箱/);
    }
    const write = await 执行(复核员成员, { action: 'policy_check', 动作: 'write', target: { ...target, sandbox: true } });
    assert.equal(write.判定.verdict, 'deny', '沙箱标记不授予复核员普通业务写权');
    assert.match(write.判定.rule, /只读数/);
    const unknown = await 执行(复核员成员, { action: 'policy_check', 动作: 'unknown-experiment-action', target: { ...target, sandbox: true } });
    assert.equal(unknown.判定.verdict, 'deny', '沙箱标记不放行未知动作');
  });

  it('d. 总线写也按复核员判：bus_send ⇒ 复核员只读守卫拒', async () => {
    await assert.rejects(
      () => 执行(复核员成员, { action: 'bus_send', 线程: 't-x', 类型: '提问', 内容: 'x' }),
      (e) => e instanceof Denied && /只读数/.test(e.rule),
    );
  });

  it('e. 回归：普通成员（插件工程）任务内 memory_write 照常放行（解析只收复核员岗）', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '普通成员任务内写', 负责人: 'member-a', 判据: ['判据一'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    const r = await 执行(MEMBER_A, { action: 'memory_write', 类: '经历', 内容: '任务内产出', 来源: '实测', 任务: node.id, project: P });
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

  /** 建一个 member-a 已交卷的节点，并给复核员建真实关联（读域由此而来）。 */
  async function 建已交卷节点(描述, 结论 = 'member-a的私密结论XYZ') {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人: 'member-a', 判据: ['判据甲', '判据乙'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论 });
    await 建复核关联(org, node.id);
    return node;
  }

  it('a. 复核员（成员形状·roleId 档案回填）读到判据原文；响应不含他人结论（性质断言）', async () => {
    const node = await 建已交卷节点('③-a');
    const r = await 执行(复核员成员, { action: 'task_criteria', id: node.id });
    assert.deepEqual(r.节点.判据, ['判据甲', '判据乙'], '判据原文逐字');
    assert.equal(r.节点.判据冻结, true);
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

  it('b. 未参与普通成员读他人任务判据 ⇒ 拒（在办主体闸）', async () => {
    const node = await 建已交卷节点('③-b');
    await assert.rejects(
      () => 执行(MEMBER_B, { action: 'task_criteria', id: node.id }),
      (e) => e instanceof Denied && /在办主体/.test(e.rule),
      '未参与成员没有读他人判据的业务需要',
    );
  });

  it('c. 节点负责人可读；Lead 可读', async () => {
    const node = await 建已交卷节点('③-c');
    const own = await 执行(MEMBER_A, { action: 'task_criteria', id: node.id });
    assert.deepEqual(own.节点.判据, ['判据甲', '判据乙']);
    const lead = await 执行(LEAD, { action: 'task_criteria', id: node.id });
    assert.deepEqual(lead.节点.判据, ['判据甲', '判据乙']);
  });

  it('d. 读域按任务限定：未关联节点 ⇒ 拒；纳入显式复核对象后 ⇒ 放行（不是 role 全量）', async () => {
    const 未关联节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '③-d-他人节点', 负责人: 'member-a', 判据: ['判据一'] });
    await org.tasks.dispatch(未关联节点.id, { subject: LEAD, 项目: P });
    await org.tasks.start(未关联节点.id, { subject: MEMBER_A, 项目: P });
    await org.tasks.submit(未关联节点.id, { subject: MEMBER_A, 项目: P, 结论: '交卷' });
    await assert.rejects(
      () => 执行(复核员成员, { action: 'task_criteria', id: 未关联节点.id }),
      (e) => e instanceof Denied && /读域/.test(e.message),
      '未关联任务不可读（v2 条目4/6：不是「复核员就看全量」）',
    );
    await 建复核关联(org, 未关联节点.id);
    const r = await 执行(复核员成员, { action: 'task_criteria', id: 未关联节点.id });
    assert.deepEqual(r.节点.判据, ['判据一'], '纳入复核对象后读域生效');
  });
});
