/**
 * ⑮ 强制反对者接线（2026-10-10）——四层全接 + 发声通道。
 *
 * 修之前是**四层全缺**：`pickDissenter` 零生产调用点、`ACTIONS` 无入口、工作台投影无字段、
 * 看板不渲染。本文件钉住前两层与「发声通道」，第三层（投影）在这一层，第四层（渲染）
 * 在 `components/board/test/`（那是浏览器半边，跑不了 node:test 的同一进程渲染器）。
 *
 * 判据（逐条对着规格）：
 *  1. 指定：候选给足 ⇒ `node.讨论.反对者` 非空且**不在参与者里**；候选为空 ⇒ `''` 且讨论照常开启；
 *  2. 不重复：`#usedDissenters` 的既有语义不被破坏（`pickDissenter` 本身一个字没改）；
 *  3. 投影：会审行含 `强制反对者`；无讨论段的节点**不带**这个键；
 *  4. 发声通道：非参与者的反对者能 say，**且预算真管住他**（消息上限 / 字符上限两条都要真读数）；
 *  5. 反例校准：删 `pickDissenter` 调用 ⇒ 判据 1 红；改回 say 的原判据 ⇒ 判据 4 红。
 *  6. **候选池的两道前置筛**（收尾②③·2026-10-10，独立复核抓到的尾巴）：复核者 / 拒绝名单成员
 *     不进池（可写预检，与 `bus.send` 同闸）；不在册的负责人（`system`）不进池，在册的可以
 *     （「在册即可」是有意的）；全池不可写 / 拿不到结论 ⇒ `''` 且讨论照常开启（fail-closed 不阻断）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { MessageBus } from '../src/bus.js';
import { ReviewProtocol } from '../src/review.js';
import { DebateService } from '../src/debate.js';
import { RoleRegistry } from '../src/registry.js';
import { projectWorkbench } from '../src/workbench.js';

const P = 'default';
const 部署偏好 = '集体L2-共享基础设施/defaults/部署.json';
const MEMBER_A = { id: 'member-a', kind: '成员', roleId: '插件工程' };
const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };
/** 夹具身份档案里的**全部**成员（`makeFixture` 默认那四个）：指定反对者的候选就来自这里。 */
const 夹具成员 = {
  'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
  'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
  lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
  reviewer: { id: 'reviewer', 岗位: '复核员', 代: 1, status: '在岗' },
};

/**
 * 与 `org.open` 同款接线 + 可注入的 `random`。
 *
 * 注入 random 的理由：候选池是「身份档案成员（非封存）∪ 本项目其它节点负责人」的并集，
 * 随机结果会影响断言；这里让**每次开启都确定性**地取池中第一个，测试才钉得住读数。
 */
function 装配(g, random = () => 0) {
  const tasks = new TaskGraph({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const bus = new MessageBus({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const registry = new RoleRegistry({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const review = new ReviewProtocol({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock, tasks, bus, random });
  const debate = new DebateService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock, tasks, bus, review, registry });
  return { tasks, bus, registry, review, debate };
}

/** 造一个已交齐的双人会审节点（与 debate.test.js 同款：派发后有人 start，才能交卷）。 */
async function 交齐会审(tasks, 主体 = [MEMBER_A, MEMBER_B]) {
  const node = await tasks.create({
    subject: LEAD, 项目: P, 描述: '⑮ 强制反对者', 负责人: 主体.map((s) => s.id), 判据: ['结论一致'], 模式: '独立会审',
  });
  await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await tasks.start(node.id, { subject: 主体[0], 项目: P });
  for (const s of 主体) await tasks.submit(node.id, { subject: s, 项目: P, 结论: `${s.id} 案` });
  return node.id;
}

/** 会审行的投影（喂真线程消息，读数全现算）。 */
async function 投影(parts, 节点) {
  const current = await parts.tasks.get(节点, { 项目: P });
  return projectWorkbench({
    项目: P,
    节点: [current],
    审计尾: [],
    升级挂起: [],
    探针: { 状态: '正常', 结果: [] },
    策略: { healthy: true, 错误: null, 介入度: '零参与', 失联: {} },
    讨论消息: current?.讨论 ? { [节点]: await parts.bus.readRaw({ 项目: P, 线程: 节点 }) } : {},
    生成于: '2026-10-10T00:00:00Z',
  });
}

describe('⑮ 强制反对者接线（2026-10-10）', () => {
  /** @type {Awaited<ReturnType<typeof makeFixture>>} */
  let f;
  before(async () => {
    f = await makeFixture();
  });
  after(async () => {
    await f.cleanup();
  });

  it('判据1a：候选给足 ⇒ 讨论.反对者 非空、不在参与者里、进事件流、open() 当场可见', async () => {
    const parts = 装配(f);
    const 节点 = await 交齐会审(parts.tasks);

    const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
    assert.ok(开.强制反对者, 'open() 返回值必须当场带上强制反对者（Lead 要看得见）');
    assert.equal(开.强制反对者依据, '系统随机指定一名未参与成员，且不重复', '依据来自 pickDissenter，原样带出');
    assert.ok(!开.参与者.includes(开.强制反对者), '反对者不能是参与者（他没交过独立答案）');

    const node = await parts.tasks.get(节点, { 项目: P });
    assert.equal(node.讨论.状态, '讨论中', '讨论照常开启');
    assert.equal(node.讨论.反对者, 开.强制反对者, 'fold 出的 讨论.反对者 与 open() 返回一致');
    assert.notEqual(node.讨论.反对者, '', '指定成功：非空串');
    assert.ok(!node.讨论.参与者.includes(node.讨论.反对者), '投影层同判据：反对者不在参与者里');

    // 事件流是状态权威 ⇒ 指定的那一笔必须能从事件流重算（不是内存里的临时值）。
    const 事件 = (await parts.tasks.events({ 项目: P })).filter((r) => r.kind === 'debate_opened' && r.id === 节点);
    assert.equal(事件.length, 1, '恰好一条 debate_opened');
    assert.equal(事件[0].反对者, 开.强制反对者, '事件里带 反对者（状态可重算）');
    assert.equal(事件[0].反对者依据, 开.强制反对者依据, '事件里带 反对者依据');

    // 审计留痕（pickDissenter 既有行为，未被改动）：详情.强制反对者 = 指定结果。
    const 审计 = (await f.audit.read({})).filter((r) => r.详情?.强制反对者 && r.详情?.节点 === 节点);
    assert.equal(审计.length, 1, '指定留一条审计（#usedDissenters 读的就是它）');
    assert.equal(审计[0].详情.强制反对者, 开.强制反对者);
  });

  it('判据1b：候选为空 ⇒ 反对者 === "" 且讨论照常开启（不抛错），依据原样带上', async () => {
    // 候选池两条来源都掐空：身份档案里只有参与者两人（参与者恒被扣掉），且本项目没有**别的**
    // 节点的负责人。注意节点负责人也来自身份档案（policy 身份链），所以不能靠「封存实例当负责人」
    // 来造这个局面——那会在交卷那一步就被身份链拒掉，测不到候选池这一层。
    const g = await makeFixture({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
      },
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks, [MEMBER_A, MEMBER_B]);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.equal(开.强制反对者, '', '没有可用候选时宁缺毋滥：反对者为空串');
      assert.match(开.强制反对者依据, /没有可用的未参与成员/, '依据原样带出（说清为什么没人）');
      const node = await parts.tasks.get(节点, { 项目: P });
      assert.equal(node.讨论.状态, '讨论中', '指定失败**不阻断开启**');
      assert.equal(node.讨论.反对者, '', '空串（不是 undefined）——投影/渲染两边都按空值不画');
      assert.equal(开.参与者.length, 2, '前提：两个参与者在，讨论真的开起来了');
    } finally {
      await g.cleanup();
    }
  });

  it('判据1c：候选池 = 身份档案成员 ∪ 本项目其它节点负责人 —— 两来源都过同一道「在册」检查', async () => {
    // 来源①：身份档案成员。在岗成员只有 a/b/lead，参与者是 a+b ⇒ 候选只剩 lead（另一来源为空）。
    const g1 = await makeFixture({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
        lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
      },
    });
    try {
      const parts = 装配(g1);
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.equal(开.强制反对者, 'lead', '候选只有身份档案里的 lead（参与者被扣掉）');
    } finally {
      await g1.cleanup();
    }

    // 来源②：本项目其它节点的负责人。**负责人那一路也要在册**（收尾③·2026-10-10）：
    // 身份档案里只有 a/c（都是参与者），别的节点负责人是 b —— b 不在册 ⇒ 被剔 ⇒ 候选池空。
    // ⚠️ 如实记（这条规则的副作用，不是缺陷）：在册检查对两个来源一律适用之后，
    //    **来源② ⊆ 来源①** —— 一个在册的负责人本来就已被来源①收进池里了。
    //    并集的第二条腿因此成了冗余；保留它是有意的（「负责人也是一条显式来源」这件事
    //    仍写在代码里，将来若「在册」口径放宽，它不必重新发明）。
    const g2 = await makeFixture({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-c': { id: 'member-c', 岗位: '插件工程', 代: 1, status: '在岗' },
      },
    });
    try {
      const parts = 装配(g2);
      const 别的 = await parts.tasks.create({
        subject: LEAD, 项目: P, 描述: '别的节点', 负责人: ['member-b'], 判据: ['x'], 模式: '独立会审',
      });
      const 节点 = await 交齐会审(parts.tasks, [MEMBER_A, { id: 'member-c', kind: '成员', roleId: '插件工程' }]);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.equal(开.强制反对者, '', '不在册的负责人被剔（收尾③）：候选池空 ⇒ 宁缺毋滥');
      assert.equal((await parts.tasks.get(别的.id, { 项目: P })).id, 别的.id, '前提：那个「别的节点」真的在图上');
      assert.equal((await parts.tasks.get(节点, { 项目: P })).讨论.状态, '讨论中', '剔完为空不阻断开启');

      // 把 member-b **登记进档案**（在岗）之后他就能被选中 —— 「在册即可」是有意的：
      // 门槛是「档案里在册且在岗 ＋ 真能写消息」，不是「他是不是负责人」。
      const 身份 = await parts.registry.identity();
      await g2.writePrivate('身份档案/identity.json', `${JSON.stringify({
        members: {
          ...身份.members,
          'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
        },
        sovereign: 身份.sovereign,
        denylist: 身份.denylist,
      }, null, 2)}\n`);
      assert.equal(await g2.policy.reload(), true, '前提：改完档案重载成功');
      const 节点2 = await 交齐会审(parts.tasks, [MEMBER_A, { id: 'member-c', kind: '成员', roleId: '插件工程' }]);
      const 开2 = await parts.debate.open({ subject: LEAD, 项目: P, 节点: 节点2 });
      assert.equal(开2.强制反对者, 'member-b', '在册且在岗 ⇒ 他进池（参与者 a/c 被扣掉后只剩他）');
    } finally {
      await g2.cleanup();
    }
  });

  it('判据2：不重复的既有语义不被破坏（用过的那位不再被指定；pickDissenter 一个字没改）', async () => {
    // 四个在岗成员 + 两次开启，让两次指定都落在「候选充足」的区间：
    //  node1 参与者 a+b ⇒ 池 = {a,b,c,d} \ {a,b} = {c,d} → 取 0 得 c
    //  node2 参与者 a+c ⇒ 池 = {a,b,c,d} \ {a,c} = {b,d} → 取 0 得 b
    const g = await makeFixture({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-c': { id: 'member-c', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-d': { id: 'member-d', 岗位: '插件工程', 代: 1, status: '在岗' },
      },
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks, [MEMBER_A, MEMBER_B]);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.equal(开.强制反对者, 'member-c', '池 {c,d} 取第一个');

      // 「不重复」的既有语义：用过名单 = 审计里记的那一位（没有第二个存储）。
      const 已用过 = (await g.audit.read({}))
        .filter((r) => r.详情?.强制反对者 && r.详情?.节点 === 节点)
        .map((r) => r.详情.强制反对者);
      assert.deepEqual(已用过, [开.强制反对者], '用过名单 = 审计里记的那一位（第二事实源不存在）');

      // 同一节点内真的不重复：池里同时给「用过的那位」与一个新面孔，指定的必须是新面孔。
      const 复用 = await parts.review.pickDissenter({ 项目: P, 节点, 参与者: [], 候选: [开.强制反对者, 'member-d'] });
      assert.equal(复用.反对者, 'member-d', '同一节点内不得重复指定（#usedDissenters 语义照旧）');
      assert.deepEqual(复用.已用过, ['member-c', 'member-d'], '已用过名单按节点累积');

      // 换个节点、参与者换人 ⇒ 候选池不同 ⇒ 指定结果不同（证明池子真的按参与者扣过）。
      const 节点2 = await 交齐会审(parts.tasks, [MEMBER_A, { id: 'member-c', kind: '成员', roleId: '插件工程' }]);
      const 开2 = await parts.debate.open({ subject: LEAD, 项目: P, 节点: 节点2 });
      assert.equal(开2.强制反对者, 'member-b', '池 {b,d} 取第一个');
      assert.notEqual(开2.强制反对者, 开.强制反对者, '两个节点的指定结果不同（池子按参与者扣过）');

      // `pickDissenter` 本体零改动：仍按「参与者 + 已用过」扣，且宁缺毋滥。
      const 空 = await parts.review.pickDissenter({ 项目: P, 节点: 'n-x', 参与者: ['member-a'], 候选: ['member-a'] });
      assert.equal(空.反对者, '', 'pickDissenter 本体未动：池空即空串');
    } finally {
      await g.cleanup();
    }
  });

  it('判据3：会审行投影含 强制反对者（讨论小节里没有重复的第二份）；无讨论段不带这个键', async () => {
    const parts = 装配(f);
    const 节点 = await 交齐会审(parts.tasks);
    await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
    const view = await 投影(parts, 节点);
    const 行 = view.会审.find((a) => a.节点 === 节点);
    assert.ok(行, '会审行在');
    assert.equal(行.强制反对者, (await parts.tasks.get(节点, { 项目: P })).讨论.反对者, '行级字段 = 讨论.反对者');
    assert.ok(行.强制反对者, '指定成功时非空');
    assert.equal('强制反对者' in 行.讨论, false, '读数只有一处：讨论小节里不再重复一份');

    // 无讨论段的节点：**不带**这个键（不给空壳）——用并行分担节点（它全程没有讨论段）。
    const 并行 = await parts.tasks.create({
      subject: LEAD, 项目: P, 描述: '并行分担', 负责人: ['member-a', 'member-b'], 判据: ['x'], 模式: '并行分担',
    });
    await parts.tasks.dispatch(并行.id, { subject: LEAD, 项目: P });
    await parts.tasks.start(并行.id, { subject: MEMBER_A, 项目: P });
    await parts.tasks.submit(并行.id, { subject: MEMBER_A, 项目: P, 结论: '甲' });
    await parts.tasks.submit(并行.id, { subject: MEMBER_B, 项目: P, 结论: '乙' });
    const view2 = await 投影(parts, 并行.id);
    const 行2 = view2.会审.find((a) => a.节点 === 并行.id);
    assert.ok(行2, '并行分担节点也在会审块里（有负责人有答案）');
    assert.equal('讨论' in 行2, false, '前提：并行分担没有讨论小节');
    assert.equal('强制反对者' in 行2, false, '无讨论段 ⇒ 连键都不给（与「讨论小节没有就不画」同款）');
  });

  it('判据4a：非参与者的反对者能发言，且预算真的管住他——每轮消息上限拒', async () => {
    const g = await makeFixture({ privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 每轮消息上限: 2 } }) } });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      const 反对者 = 开.强制反对者;
      assert.ok(反对者, '前提：指定成功');
      assert.ok(!开.参与者.includes(反对者), '前提：他确实不是参与者（旧判据下必拒）');
      const 主体 = { id: 反对者, kind: '成员' };

      const s1 = await parts.debate.say({ subject: 主体, 项目: P, 节点, 类型: '分歧', 内容: '我不同意 A 案' });
      assert.equal(s1.本轮消息数, 1, '反对者的第一条真落线（发声通道通了）');
      const 落线 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => m.发件 === 反对者);
      assert.equal(落线.length, 1, '消息总线上真有他这条');
      assert.equal(s1.每轮消息上限, 2, '快照读数如时（部署覆盖也为 2）');

      // 参与者发第二条，把预算刚好用满。
      await parts.debate.say({ subject: MEMBER_A, 项目: P, 节点, 类型: '表态', 内容: '我维持 A 案' });
      // 反对者再发 ⇒ 必须被「每轮消息上限」拒：预算**真的**把他算进去了。
      await assert.rejects(
        () => parts.debate.say({ subject: 主体, 项目: P, 节点, 类型: '答复', 内容: '我还有话说' }),
        (e) => e.name === 'Denied' && /每轮消息上限/.test(e.rule) && /2\/2/.test(e.message),
        '反对者同样吃每轮消息上限：连续发言到上限必须被拒',
      );
      const 落在 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => m.发件 === 反对者);
      assert.equal(落在.length, 1, '被拒的那条没落线（预算不是纸面读数）');
    } finally {
      await g.cleanup();
    }
  });

  it('判据4b：反对者的「每人每轮字符上限」也现算管住他', async () => {
    const g = await makeFixture({
      privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 每人每轮字符上限: 10, 每轮消息上限: 5 } }) },
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      const 主体 = { id: 开.强制反对者, kind: '成员' };
      assert.ok(开.强制反对者 && !开.参与者.includes(开.强制反对者), '前提：非参与者的反对者');

      await parts.debate.say({ subject: 主体, 项目: P, 节点, 类型: '分歧', 内容: '六六六六六六' }); // 6 字
      await assert.rejects(
        () => parts.debate.say({ subject: 主体, 项目: P, 节点, 类型: '答复', 内容: '五五五五五' }), // 6+5 > 10
        (e) => e.name === 'Denied' && /每人每轮字符上限/.test(e.rule) && /6\/10/.test(e.message),
        '反对者本轮累计 + 新内容超限必须拒（额度按 发件 === subject.id 现算，天然覆盖他）',
      );
      // 反面对照：额度没被别人占掉——参与者各自一份额度。
      const s = await parts.debate.say({ subject: MEMBER_A, 项目: P, 节点, 类型: '表态', 内容: '五五五五五' });
      assert.equal(s.本轮消息数, 2, '参与者的额度与反对者互不共用');
    } finally {
      await g.cleanup();
    }
  });

  it('判据4c 反例面：没被指定的非参与者（旁听者）照旧拒——发声通道只给指定的那一位', async () => {
    const parts = 装配(f);
    const 节点 = await 交齐会审(parts.tasks);
    const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
    const 旁听 = 夹具成员.reviewer.id === 开.强制反对者 ? 'lead' : 'reviewer';
    await assert.rejects(
      () => parts.debate.say({ subject: { id: 旁听, kind: '成员' }, 项目: P, 节点, 类型: '表态', 内容: '旁听意见' }),
      (e) => e.name === 'Denied' && /仅参与者可发言/.test(e.rule) && /强制反对者亦可发言/.test(e.howToChange),
      '非参与者且非反对者：照旧拒，且拒绝文案指路「强制反对者亦可发言」',
    );
  });

  it('判据4d：say() 的拒绝文案仍点名「仅参与者可发言」，且指路里说清反对者也能发', async () => {
    const parts = 装配(f);
    const 节点 = await 交齐会审(parts.tasks);
    await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
    await assert.rejects(
      () => parts.debate.say({ subject: { id: 'ghost', kind: '成员' }, 项目: P, 节点, 类型: '表态', 内容: 'x' }),
      (e) => e.name === 'Denied' && /仅参与者/.test(e.rule),
      '旧断言（/仅参与者/）不许被文案改动打红',
    );
  });

  // ── 收尾②③（2026-10-10 独立复核抓到的两处尾巴）：候选池的两道前置筛 ──────────────
  // 判据：候选必须**在册且在岗**（两个来源一律适用）**且真能写消息**（与 bus.send 同闸）。
  // 筛它的目的只有一个：指定出来的那一位**真的能发声** —— 不然面板写着「强制反对者：X」，
  // 而 X 一开口就被策略闸拒（`法律 复核者只读数…` / `撤回 = 写拒绝名单`），
  // 四层里的最后一层「发声通道」对这类候选**静默失效**。

  it('判据5a 收尾②：复核者在池里 ⇒ 被可写预检剔掉，指定的是真能发声的那位', async () => {
    // 档案顺序把 reviewer 放在最前：**不筛的话** random()=0 一定选中他 —— 他就是那个哑候选。
    const g = await makeFixture({
      members: {
        reviewer: { id: 'reviewer', 岗位: '复核员', 代: 1, status: '在岗' },
        lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
      },
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.equal(开.强制反对者, 'lead', '复核者被剔 ⇒ 池里只剩 lead（不筛的话 random()=0 会选 reviewer）');
      assert.notEqual(开.强制反对者, 'reviewer', '复核者不得被指定：他写不了消息，是个哑反对者');

      // 剔的依据来自**策略闸本身**（不是角色名黑名单）：审计里留了一条针对 reviewer 的「策略拒绝」。
      const 拒 = (await g.audit.read({})).filter((r) => r.动作 === '策略拒绝' && r.主体?.id === 'reviewer');
      assert.equal(拒.length, 1, '剔掉复核者这件事有留痕（一条策略拒绝）');
      assert.match(拒[0].依据, /复核者只读数/, '依据是策略闸那条法律（法律 复核者只读数…），不是硬编码黑名单');

      // 正面：被指定的那位**真能发声**（筛的是「能不能写」，不是「名字像不像」）。
      const s = await parts.debate.say({
        subject: { id: 开.强制反对者, kind: 'Lead', roleId: 'Lead' }, 项目: P, 节点, 类型: '分歧', 内容: '我反对这个结论',
      });
      assert.equal(s.本轮消息数, 1, '被指定的那位发言真落线（发声通道不是纸面读数）');
    } finally {
      await g.cleanup();
    }
  });

  it('判据5b 收尾②：拒绝名单成员在池里 ⇒ 被剔掉（撤回 = 写拒绝名单，他一写就被拒）', async () => {
    // member-c 在档案里**在岗**，但被主权者撤回过（拒绝名单）—— 他一落消息就被策略闸拒。
    // 同样把他放在档案最前：不筛的话 random()=0 一定选他。
    const g = await makeFixture({
      members: {
        'member-c': { id: 'member-c', 岗位: '插件工程', 代: 1, status: '在岗' },
        lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
      },
      denylist: [{ id: 'member-c', 理由: '撤回（测试）', 撤于: '2026-10-10T00:00:00.000Z', 由: 'sovereign' }],
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.notEqual(开.强制反对者, 'member-c', '拒绝名单成员不得被指定');
      assert.equal(开.强制反对者, 'lead', '剔掉 member-c 后池里只剩 lead');
      const 拒 = (await g.audit.read({})).filter((r) => r.动作 === '策略拒绝' && r.主体?.id === 'member-c');
      assert.ok(拒.length >= 1, '剔掉拒绝名单成员也有留痕（策略拒绝）');
      assert.match(拒[0].依据, /拒绝名单/, '依据是「撤回 = 写拒绝名单，不删卡」那条法律');
    } finally {
      await g.cleanup();
    }
  });

  it('判据5c 收尾②：全池都不可写 ⇒ 反对者 === "" 且讨论照常开启（宁缺毋滥，不阻断）', async () => {
    const g = await makeFixture({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
        reviewer: { id: 'reviewer', 岗位: '复核员', 代: 1, status: '在岗' },
      },
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.equal(开.强制反对者, '', '池里只剩「非参与者的复核者」，剔完为空 ⇒ 宁缺毋滥');
      assert.match(开.强制反对者依据, /没有可用的未参与成员/, '依据原样带出（说清为什么没人）');
      const node = await parts.tasks.get(节点, { 项目: P });
      assert.equal(node.讨论.状态, '讨论中', '指定失败**不阻断开启**（与判据1b 同款，只是这次空的原因是「不可写」）');
      assert.equal(node.讨论.反对者, '', '空串进事件流与投影');
    } finally {
      await g.cleanup();
    }
  });

  it('判据6a 收尾③：负责人=["system"] 且 system 不在册 ⇒ 池里没有 system，反对者 !== "system"', async () => {
    const g = await makeFixture({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
      },
    });
    try {
      const parts = 装配(g);
      // 根因「task_create 不校验负责人身份」是既有面（本批不动）—— 这里钉的是候选池那一侧的筛。
      const 别的 = await parts.tasks.create({
        subject: LEAD, 项目: P, 描述: 'system 当负责人', 负责人: ['system'], 判据: ['x'], 模式: '独立会审',
      });
      assert.deepEqual((await parts.tasks.get(别的.id, { 项目: P })).负责人, ['system'],
        '前提：system 真当上了负责人（既有面：create 不校验负责人身份）');
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.notEqual(开.强制反对者, 'system', '不在册的负责人被剔：system 不进候选池');
      assert.equal(开.强制反对者, '', '剔完只剩参与者 ⇒ 池空（宁缺毋滥）');
      assert.equal((await parts.tasks.get(节点, { 项目: P })).讨论.状态, '讨论中', '不阻断开启');
    } finally {
      await g.cleanup();
    }
  });

  it('判据6b 收尾③：system 在册且在岗 ⇒ 他可以被选中（「在册即可」是有意的，不看名字）', async () => {
    const g = await makeFixture({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
        system: { id: 'system', 岗位: '插件工程', 代: 1, status: '在岗' },
      },
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.equal(开.强制反对者, 'system', '在册且在岗 ⇒ 与别的成员一样进池（门槛是档案 + 可写，不是名字）');
      // 他真能落线（不然又是个哑反对者）。
      // ⚠️ 已知边界（**既有面，不在本批范围**，如实记读数）：他的消息 `发件='system'`，
      //    而 `本轮发言()` 按 `发件 !== 'system'` 过滤 ⇒ 这条发言**不计入**每轮消息数与字符额度。
      //    「身份档案里真有一个叫 system 的实例」是主权者的选择，本批只钉「在册即可」这条语义。
      await parts.debate.say({
        subject: { id: 'system', kind: '成员', roleId: '插件工程' }, 项目: P, 节点, 类型: '分歧', 内容: '我反对',
      });
      const 落线 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => m.类型 === '分歧' && m.内容 === '我反对');
      assert.equal(落线.length, 1, '在册的 system 发言真落线');
      assert.equal(落线[0].发件, 'system', '发件 = 他的 id（既有面：这个 id 恰好是机制保留字）');
    } finally {
      await g.cleanup();
    }
  });

  it('判据6c 收尾②③：可写预检拿不到结论 ⇒ fail-closed 按不可写处理（不猜、不放行、不阻断开启）', async () => {
    const g = await makeFixture({
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
        lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
      },
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      // 「闸读不出来」的替身：canWrite 抛错。判据本体（`bus.canWrite`）在 5a/5b 已实测，
      // 这里钉的是**调用侧**的 fail-closed：拿不到结论不许当放行，也不许把 open() 一起带走。
      const 坏闸 = Object.create(parts.bus);
      坏闸.canWrite = async () => { throw new Error('闸读不出来（测试替身）'); };
      const d = new DebateService({
        layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock,
        tasks: parts.tasks, bus: 坏闸, review: parts.review, registry: parts.registry,
      });
      const 开 = await d.open({ subject: LEAD, 项目: P, 节点 });
      assert.equal(开.强制反对者, '', '拿不到结论 ⇒ 一律按不合格 ⇒ 池空');
      assert.equal((await parts.tasks.get(节点, { 项目: P })).讨论.状态, '讨论中',
        'fail-closed 不阻断开启：讨论照常开，只是没有反对者（宁缺毋滥）');
    } finally {
      await g.cleanup();
    }
  });
});
