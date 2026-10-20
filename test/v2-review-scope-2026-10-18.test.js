/**
 * 复核读域 / 真实署名 / 旧独立会审封写（v2 口述收敛 2026-10-18 条目4/6/18/19 的补修）。
 *
 * 每个正向都配一条**能变红**的反例（写不出反例＝没验过）：
 *  ① 复核完整闭环：create(复核对象) → bind → dispatch → 开工 → 交报告 → task_review
 *     不靠 `依赖` 表达复核对象（依赖须前置已采纳，会把闭环锁死）；复核对象可在
 *     待派发/已派发用 task_bind 只补（W7 的正确路径，受审计）。
 *  ② 读域单源：workbench / task_criteria / memory_query / audit_tail / bus_read 五个
 *     模型可达出口都只给「复核任务 + 显式复核对象」那一片；不相关任务、未参与会审的
 *     盲评内容、别的项目账本（审计是跨项目共享账）一律不可达。
 *  ③ 真实署名：任何 kind 传 `复核者` 冒签都拒（含 Lead 代签）；成员复核员必须真在册
 *     在岗 + 真绑定一条把本节点列为复核对象的复核任务；交卷人/负责人/自己仍不得复核。
 *  ④ 旧独立会审封写：bus_unlock 已从模型动作面退役；bus.send 服务层对旧节点恒拒；
 *     历史账本一字不动、fold 仍能读出历史 模式 与答案。
 *  ⑤ 投影无空壳：新节点与工作台行不再出现 `模式: null`；历史有值时照原样折出。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readJsonl } from '../src/kernel/fsx.js';
import { makeFixture, writeUnder, seedLegacyIndependentCouncil, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import { ACTIONS, runAction } from '../lib/actions.js';
import { 复核读域 } from '../src/review-scope.js';

const P = 'proj-w6';
const OTHER = 'proj-w6-other';

/** 岗位卡（结构合规的最小卡；能力引用必须是能力库里真实存在的 id）。 */
function 岗位卡(id) {
  return `---
id: ${id}
kind: 身份
authority: 自治
zone: 出厂
domain: 个体
version: 1
---
<!-- authority: 自治 -->
# ${id}

## 个体L0 · 身份核心

我是 ${id}。

### 身份核心

锁定段。

## 个体L1 · 规则

1. 先搜后写。

## 个体L2 · 能力引用

- \`policy-decision\`

## 个体L3 · 经验引用

### 占位
`;
}

async function 起组织() {
  const f = await makeFixture({
    members: {
      'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
      'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
      lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
      reviewer: { id: 'reviewer', 岗位: '复核员', 代: 1, status: '在岗' },
    },
  });
  for (const id of ['插件工程', '复核员', 'Lead']) {
    await writeUnder(f.privateRoot, `集体L3-成员角色卡/${id}.md`, 岗位卡(id));
  }
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

/** 造一个已交卷的业务节点（负责人=插件工程，member-a 执行）。 */
async function 交卷节点(org, 描述 = '业务节点') {
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人: ['插件工程'], 判据: ['判据一'] });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: 'member-a', 岗位: '插件工程' });
  await org.tasks.start(node.id, { subject: MEMBER, 项目: P });
  await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: '交付完成', 结论层: '可验' });
  return org.tasks.get(node.id, { 项目: P });
}

/** 造一条复核任务并绑定复核实例；`复核对象` 可在 create 或事后 task_bind 补。 */
async function 复核任务(org, 目标id, options = {}) {
  const node = await org.tasks.create({
    subject: LEAD,
    项目: P,
    描述: options.描述 ?? `复核-${目标id}`,
    负责人: ['复核员'],
    判据: ['核对目标'],
    ...(options.创建时带对象 === false ? {} : { 复核对象: [目标id] }),
  });
  await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: 'reviewer', 岗位: '复核员' });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  return org.tasks.get(node.id, { 项目: P });
}

function 跑(org, 主体, args) {
  return runAction({ org, 项目: P, subject: 主体, 主体, args });
}

describe('① 复核闭环：显式复核对象（不借依赖）+ 可派可交 + 事后补绑', () => {
  it('create 带复核对象 → bind → dispatch → 开工 → 交报告 → 复核采纳；依赖仍为空（无派发死锁）', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '闭环-业务');
      const 复核 = await 复核任务(org, 业务.id);
      assert.deepEqual(复核.复核对象, [业务.id], '复核对象独立成字段');
      assert.deepEqual(复核.依赖, [], '绝不复用依赖表达复核对象');
      // 复核实例在自己的复核节点上可走受限生命周期（开工 → 交报告）。
      await org.tasks.start(复核.id, { subject: REVIEWER, 项目: P });
      await org.tasks.submit(复核.id, { subject: REVIEWER, 项目: P, 结论: '已核' });
      // 复核结论落回业务节点：证据闸（真在岗复核岗 + 真关联）应放行。
      const 了 = await 跑(org, REVIEWER, { action: 'task_review', id: 业务.id, 三态: '过' });
      assert.equal(了.结论.算通过, true);
      // 补修K：复核只出票、不代 Lead 采纳；采纳是 Lead 的独立一步（引用真票）。
      assert.equal((await org.tasks.get(业务.id, { 项目: P })).状态, '已交卷');
      const 采纳 = await 跑(org, LEAD, { action: 'task_accept', id: 业务.id, 票: 了.结论.票 });
      assert.equal(采纳.节点.状态, '已采纳');
    } finally { await f.cleanup(); }
  });

  it('历史任务没有结构化复核对象：待派发/已派发用 task_bind 只补 复核对象（W7 正路，入审计）', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '补绑-业务');
      const 复核 = await 复核任务(org, 业务.id, { 创建时带对象: false, 描述: '补绑-复核' });
      assert.equal(复核.复核对象, undefined, '前提：创建时没有复核对象');
      // 只补复核对象（不给实例/岗位）——同一受审计入口。
      const 补 = await org.tasks.bind(复核.id, { subject: LEAD, 项目: P, 复核对象: [业务.id] });
      assert.deepEqual(补.复核对象, [业务.id]);
      const 事件 = (await readJsonl(f.layout.taskLog(P))).filter((r) => r.kind === 'bound' && r.复核对象);
      assert.ok(事件.length >= 1, '补绑走 bound 事件（可回放）');
      const 了 = await 跑(org, REVIEWER, { action: 'task_review', id: 业务.id, 三态: '过' });
      // 补修K：复核只出票；采纳是 Lead 的独立一步（引用真票）。
      const 采纳 = await 跑(org, LEAD, { action: 'task_accept', id: 业务.id, 票: 了.结论.票 });
      assert.equal(采纳.节点.状态, '已采纳');
    } finally { await f.cleanup(); }
  });

  it('反例：复核对象指向空气 / 指向自己 ⇒ 拒（引用是事实，不是自由文本）', async () => {
    const { f, org } = await 起组织();
    try {
      await assert.rejects(
        () => org.tasks.create({ subject: LEAD, 项目: P, 描述: '空气对象', 负责人: ['复核员'], 判据: ['x'], 复核对象: ['task-不存在'] }),
        (e) => e instanceof InvalidBody && /不存在/.test(e.message),
      );
      const 自 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '自指对象', 负责人: ['复核员'], 判据: ['x'] });
      await assert.rejects(
        () => org.tasks.bind(自.id, { subject: LEAD, 项目: P, 复核对象: [自.id] }),
        (e) => e instanceof InvalidBody && /自己/.test(e.message),
      );
    } finally { await f.cleanup(); }
  });
});

describe('② 读域单源：五个模型可达出口都只给任务作用域', () => {
  it('相关目标可读、不相关任务/会审/跨项目账本不可读（workbench/task_criteria/memory/audit/bus）', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '读域-业务');
      const 复核 = await 复核任务(org, 业务.id);
      const 无关 = await 交卷节点(org, '读域-无关');
      // 记忆：一条挂在业务节点上（相关）、一条挂在无关节点上、一条在别的项目里但引用了业务 id。
      await org.memory.remember({ subject: LEAD, 类: '经历', 项目: P, 内容: '业务节点的相关经历', 来源: '测试', 来源引用: [业务.id] });
      await org.memory.remember({ subject: LEAD, 类: '经历', 项目: P, 内容: '无关节点的经历', 来源: '测试', 来源引用: [无关.id] });
      await org.memory.remember({ subject: LEAD, 类: '经历', 项目: OTHER, 内容: '别的项目同引用经历', 来源: '测试', 依据: '跨项目对照臂', 来源引用: [业务.id] });
      // 审计：业务行、无关行、以及**别的项目**里对象 id 相同的一行（跨项目共享账，不许按 id 撞车）。
      await org.audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 业务.id, kind: '任务' }, 依据: '读域正例', 结果: '业务行', 项目: P });
      await org.audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 无关.id, kind: '任务' }, 依据: '读域反例', 结果: '无关行', 项目: P });
      await org.audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 业务.id, kind: '任务' }, 依据: '跨项目同 id 反例', 结果: '别的项目同 id 行', 项目: OTHER });
      // 本人行也必须核项目（Lead 抽查的漏轴）：同项目留痕可读、跨项目本人行不可读。
      await org.audit.append({ 动作: '状态变更', 主体: REVIEWER, 对象: { id: 'self-same-project', kind: '动作' }, 依据: '本人本项目留痕', 结果: '本人本项目行', 项目: P });
      await org.audit.append({ 动作: '状态变更', 主体: REVIEWER, 对象: { id: 'self-other-project', kind: '动作' }, 依据: '本人跨项目反例', 结果: '本人跨项目行', 项目: OTHER });
      // 唯一全局自身记录口子：对象 kind=身份 且对象 id=本人（迁移补登/身份授权），可单列。
      await org.audit.append({ 动作: '状态变更', 主体: REVIEWER, 对象: { id: 'reviewer', kind: '身份' }, 依据: '迁移补登', 结果: '全局身份自身行', 项目: null });
      // 总线：业务线程有消息；别处线程有消息。
      await org.bus.send({ subject: LEAD, 项目: P, 线程: 业务.id, 发件: 'lead', 收件: [], 类型: '表态', 内容: '业务线程正文' });
      await org.bus.send({ subject: LEAD, 项目: P, 线程: 无关.id, 发件: 'lead', 收件: [], 类型: '表态', 内容: '无关线程正文' });
      // 会审：复核员不是参与者，作答中的答案不得由 role 全量读。
      const 会审 = await org.council.open({ subject: LEAD, 项目: P, 问题: '读域会审', 参与者: ['member-a', 'member-b'] });
      await org.council.answer({ subject: MEMBER, 项目: P, id: 会审.id, 结论: '只有参与者该看到的答案' });

      // ── workbench ──
      const 台 = (await 跑(org, REVIEWER, { action: 'workbench' })).数据;
      assert.deepEqual(台.任务.节点.map((n) => n.id).sort(), [复核.id, 业务.id].sort(), '只给复核任务 + 复核对象');
      assert.match(台.视图, /复核读域/);
      assert.equal(台.能力, null, '治理面不给复核实例');
      assert.ok(!JSON.stringify(台).includes('只有参与者该看到的答案'), '未参与会审的答案不得从工作台出');

      // ── task_criteria ──
      const 判 = await 跑(org, REVIEWER, { action: 'task_criteria', id: 业务.id });
      assert.deepEqual(判.节点.判据, ['判据一'], '复核对象判据可读');
      assert.ok(!('模式' in 判.节点), '新节点不投影模式空壳');
      await assert.rejects(
        () => 跑(org, REVIEWER, { action: 'task_criteria', id: 无关.id }),
        (e) => e instanceof Denied && /读域/.test(e.message),
        '非复核对象不可读判据',
      );

      // ── memory_query ──
      const 记 = (await 跑(org, REVIEWER, { action: 'memory_query', 文本: '经历' })).结果;
      assert.ok(JSON.stringify(记).includes('业务节点的相关经历'), '相关经历可读');
      assert.ok(!JSON.stringify(记).includes('无关节点的经历'), '无关节点的经历不可读');
      assert.ok(!JSON.stringify(记).includes('别的项目同引用经历'), '跨项目同引用不可读（按实际任务项目判）');

      // ── audit_tail ──
      const 审 = (await 跑(org, REVIEWER, { action: 'audit_tail', limit: 100 })).审计;
      const 结果 = 审.map((r) => r.结果);
      assert.ok(结果.includes('业务行'), '读域内审计行可读');
      assert.ok(!结果.includes('无关行'), '读域外审计行不可读');
      assert.ok(!结果.includes('别的项目同 id 行'), '同 id 跨项目不许碰撞命中');
      assert.ok(结果.includes('本人本项目行'), '本人本项目留痕可读（正例）');
      assert.ok(!结果.includes('本人跨项目行'), '同本人、不同项目同样不可读（独立反例）');
      assert.ok(结果.includes('全局身份自身行'), '唯一全局口子：对象 kind=身份 且 id=本人');
      assert.ok(
        审.every((r) => r.项目 === P || (String(r.对象?.kind ?? '') === '身份' && String(r.对象?.id ?? '') === 'reviewer')),
        '审计过滤保留项目核对（本人行也不例外）',
      );

      // ── bus_read（原文出口）──
      const 读 = await 跑(org, REVIEWER, { action: 'bus_read', 线程: 业务.id });
      assert.ok(JSON.stringify(读).includes('业务线程正文'), '读域内线程可读原文');
      await assert.rejects(
        () => 跑(org, REVIEWER, { action: 'bus_read', 线程: 无关.id }),
        (e) => e instanceof Denied && /读域/.test(e.message),
        '读域外线程不能凭 role 全量读原文',
      );
    } finally { await f.cleanup(); }
  });

  it('未绑定复核任务 ⇒ 读域为空（未关联任务不得读；不是「复核员就看全量」）', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '空读域-业务');
      const 台 = (await 跑(org, REVIEWER, { action: 'workbench' })).数据;
      assert.deepEqual(台.任务.节点, [], '没有绑定复核任务 ⇒ 零任务可读');
      assert.match(台.复核读域.说明, /为空/);
      assert.equal((await 复核读域({ 节点: await org.tasks.list({ 项目: P }), 主体: REVIEWER, 项目: P })).限定, true);
    } finally { await f.cleanup(); }
  });
});

describe('③ 真实署名：不许冒签，冲突排除仍硬拒', () => {
  it('正例：Lead 独立验收别人的任务（签自己）仍可；反例：Lead 冒签复核员 ⇒ 拒', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '署名-业务');
      const ok = await 跑(org, LEAD, { action: 'task_review', id: 业务.id, 三态: '未验', 反例面: ['读数拿不到'] });
      assert.equal(ok.结论.三态, '未验', 'Lead 独立验收别人任务保留');
      const 行 = (await org.audit.read({})).filter((r) => r.对象?.id === 业务.id && r.结果 === 'reviewed').at(-1);
      assert.equal(行.主体.id, LEAD.id, '审计主体恒为真实操作者');

      const 业务2 = await 交卷节点(org, '署名-业务2');
      await assert.rejects(
        () => 跑(org, LEAD, { action: 'task_review', id: 业务2.id, 三态: '过', 复核者: 'reviewer' }),
        (e) => e instanceof Denied && /复核归属不许代签|实际操作者/.test(e.rule + e.message),
        'Lead 也不许把结论记到复核员头上',
      );
    } finally { await f.cleanup(); }
  });

  it('反例：普通成员复核 / 复核员无本任务关联 / 交卷人或负责人自己复核 / 不在岗 ⇒ 全拒', async () => {
    const { f, org } = await 起组织();
    try {
      const 业务 = await 交卷节点(org, '署名-反例');
      // 普通成员不是复核员岗（这里先撞上「交卷人不得复核自己的卷」也是拒——两条都是硬拒）。
      await assert.rejects(
        () => 跑(org, MEMBER, { action: 'task_review', id: 业务.id, 三态: '过' }),
        (e) => e instanceof Denied,
      );
      // 复核员在册在岗，但没有把本节点列为复核对象的复核任务。
      await assert.rejects(
        () => 跑(org, REVIEWER, { action: 'task_review', id: 业务.id, 三态: '过' }),
        (e) => e instanceof Denied && /缺本任务关联/.test(e.rule),
      );
      // 交卷人自己：他是负责人/交卷人，冲突排除先拒（不是「换成自己 id 就过」）。
      await assert.rejects(
        () => 跑(org, MEMBER, { action: 'task_review', id: 业务.id, 三态: '过', 复核者: 'member-a' }),
        (e) => e instanceof Denied,
      );
      // 负责人自己验收：Lead 自领任务后不得复核自己（负责人排除）。
      // 造「负责人=Lead」的初态要主权者派（Lead 派活不得造 Lead/主权者：不越授）。
      const SOV = { id: 'sovereign', kind: '主权者' };
      const 自领 = await org.tasks.create({ subject: SOV, 项目: P, 描述: 'Lead 自领', 负责人: ['Lead'], 判据: ['x'] });
      await org.tasks.dispatch(自领.id, { subject: SOV, 项目: P });
      await org.tasks.start(自领.id, { subject: LEAD, 项目: P });
      await org.tasks.submit(自领.id, { subject: LEAD, 项目: P, 结论: 'done' });
      await assert.rejects(
        () => 跑(org, LEAD, { action: 'task_review', id: 自领.id, 三态: '过' }),
        (e) => e instanceof Denied && /负责人|交卷人/.test(e.rule + e.message),
        '执行者/交卷人不得给自己发合格证',
      );
      // 不在岗 ⇒ 证据闸拒（先绑好真关联，再封存实例）。
      const 业务2 = await 交卷节点(org, '署名-不在岗');
      await 复核任务(org, 业务2.id);
      await org.registry.seal({ subject: LEAD, 实例: 'reviewer', 理由: '测试不在岗' });
      await assert.rejects(
        () => 跑(org, REVIEWER, { action: 'task_review', id: 业务2.id, 三态: '过' }),
        (e) => e instanceof Denied,
        '不在岗实例不得复核',
      );
    } finally { await f.cleanup(); }
  });

  it('反例：已绑执行者但尚未亲自交卷 ⇒ 仍不得复核（不靠「独立答案里出现」间接拒）', async () => {
    const { f, org } = await 起组织();
    try {
      // 负责人=岗位名（v2），真执行者是绑定里的 member-a/member-b；member-b 交了自己的卷，
      // member-a 从未出现在 独立答案 里——修前 `负责人.includes(实例)` 会漏掉这一格。
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '绑定执行者未交卷', 负责人: ['插件工程'], 判据: ['x'] });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: 'member-a', 岗位: '插件工程' });
      await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: 'member-b', 岗位: '插件工程' });
      await org.tasks.start(node.id, { subject: MEMBER, 项目: P });
      await org.tasks.submit(node.id, { subject: { id: 'member-b', kind: '成员', roleId: '插件工程' }, 项目: P, 结论: 'member-b本人交的卷' });
      const 折 = await org.tasks.get(node.id, { 项目: P });
      assert.deepEqual(折.绑定.map(row => row.实例).sort(), ['member-a', 'member-b'], '两名真实执行者均精确绑定，不能借同岗回退代交');
      assert.ok(!(折.独立答案 ?? []).some((a) => a.成员 === 'member-a'), '前提：member-a 不在独立答案里');
      // 统一「负责人实例名单（绑定优先）」判：已绑执行者 member-a 即使没交卷也不得复核。
      await assert.rejects(
        () => org.tasks.review(node.id, { subject: { id: 'member-a', kind: '成员', roleId: '插件工程' }, 项目: P, 三态: '过' }),
        (e) => e instanceof Denied && /负责人不得复核/.test(e.rule),
        '已绑执行者未交卷仍不得复核',
      );
      // 锁内/锁外走同一份名单：直接调服务面（动作层会先撞「代签」闸，测不到冲突那一条）。
      await assert.rejects(
        () => org.tasks.review(node.id, { subject: { id: 'lead', kind: 'Lead', roleId: 'Lead' }, 项目: P, 三态: '过', 复核者: 'member-a' }),
        (e) => e instanceof Denied && /负责人不得复核/.test(e.rule),
        '服务面同样按绑定实例名单判负责人排除（锁外与锁内同源）',
      );
    } finally { await f.cleanup(); }
  });
});

describe('④ 旧独立会审封写：动作退役 + 服务层恒拒 + 历史账本不变', () => {
  it('bus_unlock 已从模型动作面消失；bus.send 直写旧线程拒且零落线；历史 fold 仍可读', async () => {
    const { f, org } = await 起组织();
    try {
      assert.ok(!ACTIONS.includes('bus_unlock'), '退役：模型 enum 不再有 bus_unlock');
      const id = await seedLegacyIndependentCouncil(f, { 项目: P, id: 'task-legacy-w6', 负责人: ['member-a'] });
      const 前 = await readJsonl(f.layout.busThread(P, id));
      assert.equal(前.length, 0, '播种后旧线程无消息');

      // 动作面：模型已够不着这只手（未知动作即响亮失败）。
      await assert.rejects(
        () => 跑(org, LEAD, { action: 'bus_unlock', id, 线程: id }),
        (e) => e instanceof InvalidBody && /未知 action/.test(e.message),
      );
      // 服务层：直写旧线程也被墓碑守卫拒（不依赖动作层）。
      await assert.rejects(
        () => org.bus.send({ subject: LEAD, 项目: P, 线程: id, 发件: 'lead', 收件: [], 类型: '广播', 内容: '旧账直写' }),
        (e) => e instanceof Denied && /写入口已封闭/.test(e.rule),
      );
      await assert.rejects(
        () => org.bus.unlock({ subject: LEAD, 项目: P, 节点: id, 线程: id, 全员已交: true, 参与者: ['member-a'] }),
        (e) => e instanceof Denied && /已退役|写入口已封闭/.test(e.rule),
      );
      assert.equal((await readJsonl(f.layout.busThread(P, id))).length, 0, '旧账本一字不动（零落线）');
      const 折 = await org.tasks.get(id, { 项目: P });
      assert.equal(折.模式, '独立会审', '历史有值的模式只读保留');
    } finally { await f.cleanup(); }
  });
});

describe('⑤ 投影无模式空壳：新节点不出现，历史有值照折', () => {
  it('create 不再带模式；fold/工作台/task_criteria 都不造 `模式: null`；历史播种节点仍折出旧值', async () => {
    const { f, org } = await 起组织();
    try {
      const 新 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '新节点', 负责人: ['插件工程'], 判据: ['x'] });
      assert.ok(!('模式' in 新), '新节点没有 模式 键（不是 null 空壳）');
      const 台 = (await 跑(org, LEAD, { action: 'workbench' })).数据;
      const 行 = 台.任务.节点.find((n) => n.id === 新.id);
      assert.ok(!('模式' in 行), '工作台行不投影空壳');
      const 判 = (await 跑(org, LEAD, { action: 'task_criteria', id: 新.id })).节点;
      assert.ok(!('模式' in 判), 'task_criteria 不投影空壳');

      const 旧 = await seedLegacyIndependentCouncil(f, { 项目: P, id: 'task-legacy-mode-w6' });
      assert.equal((await org.tasks.get(旧, { 项目: P })).模式, '独立会审', '历史值只读保留');
      const 旧行 = (await 跑(org, LEAD, { action: 'workbench' })).数据.任务.节点.find((n) => n.id === 旧);
      assert.equal(旧行.模式, '独立会审', '历史值在投影里也保留');
    } finally { await f.cleanup(); }
  });
});
