/**
 * ①④⑤ 回归：讨论预算绕行与换轮权限（2026-10-10 独立复核实证 · 主人已拍，本批修）。
 *
 * 三处攻击（复核脚本实测攻破，本文件把**攻击原样钉成**判据）：
 *  - **①甲**：`bus_send`（动作面）能往会审讨论线程直接落消息，**完全绕开** `debate_say`
 *    的两道预算闸与发言权判据，且线程无归属校验。实测：上限「每轮 2 条 / 每人 10 字」下
 *    直灌 11 条全落线，参与者随后 `debate_say` 被拒（预算被外人占死）。
 *    修法：`lib/actions.js` 的 `bus_send` handler 命中「开过讨论段的节点」⇒ `Denied`。
 *  - **①乙**：`本轮发言()` 只按「类型 ∈ 三种 且 `发件 !== 'system'`」过滤 ⇒ 名单外发件的
 *    消息照样占预算。修法：改为 `本轮发言(messages, 名单)`（名单 = 参与者 ∪ 反对者）。
 *  - **④**：`debate.round()` 无任何主体判定 ⇒ 任何成员可换轮、重置两道预算。
 *  - **⑤**：`发件='system'` 且**在名单里**（他当上了强制反对者）时，旧过滤把他排除 ⇒
 *    他的发言不计入预算（可无限发言）。①乙 的名单口径一次闭合。
 *
 * 判据（每条都带反例面）：
 *  1. 甲：动作面往**讨论中的会审节点**线程发 ⇒ 拒（且没落线）；**正对照**：普通线程
 *     （非节点 id / 没有讨论段的节点）发 ⇒ 照常放行；
 *  2. 乙：服务面直灌 11 条后，参与者的 `debate_say` 不受影响（读数 1 → 2），且闸照旧管住
 *     名单内的人（第 3 条 2/2 被拒）——「外人占不死」不等于「把闸拆了」；
 *  3. ④：非 Lead 换轮 ⇒ 拒（轮次不推进、无轮边界消息落线）；Lead 换轮 ⇒ 放行（正对照）；
 *  4. ⑤：`system` 不在名单 ⇒ 不计入；`system` 在名单（当上反对者）⇒ 计入（端到端两条读数）。
 *
 * 反例校准（本批实测，三段「改坏 ⇒ 红 ⇒ 还原」读数见提交说明与回报）：
 *  ① 删甲的判据 ⇒ A-回归必红；② 把乙 改回旧过滤（`发件 !== 'system'`）⇒ A2-回归必红；
 *  ③ 删④ 的判据 ⇒ ④-回归必红。
 *
 * ⚠️ **诚实边界（2026-10-10 批c 补漏后订正，读前先看这一段）**：甲堵的是**动作面**
 *    （`bus_send` 与 `bus_unlock` **两个**入口 —— 批c 补漏 P2 之前只写在 `bus_send` 里，
 *    于是 `bus_unlock` 成了隔壁的漏口；判据现已收成 `lib/actions.js` 的**一处**实现
 *    `拒讨论线程直灌`）。**服务面 `bus.send` 仍可往讨论线程发消息**（unlock 广播、轮边界、
 *    converge 末位表态都靠它）——那是有意的内部编排通道（⑧ 那条债）。`A2-回归` 里那条
 *    「11 条真落线」的前置断言就是它的如实读数。服务面靠「内部编排是唯一调用者」的纪律
 *    + 乙 的纵深防御，**不是彻底修复**。
 * ⚠️ **命中的键（批c 补漏 P3）**：判定侧走 `线程等价键()`（`src/paths.js`，与落线路径
 *    `busThread` 同一个等价类 = 文件系统那一个：NTFS 大小写不敏感）。修前判定用**精确键**
 *    而落线走文件系统 ⇒ 线程名的大小写变体是一条旁路（实测：判定 miss、放行，而消息
 *    **落进同一个文件**，连类型闸一起废）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { MessageBus } from '../src/bus.js';
import { ReviewProtocol } from '../src/review.js';
import { DebateService, 本轮发言, ROUND_BOUNDARY_MARK } from '../src/debate.js';
import { RoleRegistry } from '../src/registry.js';
import { projectWorkbench } from '../src/workbench.js';
import { runAction } from '../lib/actions.js';

const P = 'default';
const 部署偏好 = '集体L2-共享基础设施/defaults/部署.json';
const MEMBER_A = { id: 'member-a', kind: '成员', roleId: '插件工程' };
const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };
/** 外人（非参与者、非反对者）：服务面直灌攻击用的主体。 */
const MEMBER_C = { id: 'member-c', kind: '成员', roleId: '插件工程' };
/** 机制主体（系统）：⑤ 的当事人。 */
const SYSTEM = { id: 'system', kind: '系统' };
const 系统成员 = { id: 'system', kind: '成员', roleId: '插件工程' };

const 档案 = (ids) =>
  Object.fromEntries(ids.map((id) => [id, { id, 岗位: '插件工程', 代: 1, status: '在岗' }]));

/** 与 `org.open` 同款接线（random 固定 ⇒ 指定谁是确定性的，读数才钉得住）。 */
function 装配(g, random = () => 0) {
  const tasks = new TaskGraph({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const bus = new MessageBus({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const registry = new RoleRegistry({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const review = new ReviewProtocol({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock, tasks, bus, random });
  const debate = new DebateService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock, tasks, bus, review, registry });
  return { tasks, bus, registry, review, debate };
}

/** 造一个已交齐的双人会审节点（派发后有人 start，才能交卷）。 */
async function 交齐会审(tasks, 主体 = [MEMBER_A, MEMBER_B], 描述 = '①④⑤ 回归') {
  const node = await tasks.create({
    subject: LEAD, 项目: P, 描述, 负责人: 主体.map((s) => s.id), 判据: ['结论一致'], 模式: '独立会审',
  });
  await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await tasks.start(node.id, { subject: 主体[0], 项目: P });
  for (const s of 主体) await tasks.submit(node.id, { subject: s, 项目: P, 结论: `${s.id} 案` });
  return node.id;
}

/** 会审行的投影（读数全现算：面板的「本轮消息数」必须与闸是同一份名单算出来的）。 */
async function 投影(parts, 节点) {
  const current = await parts.tasks.get(节点, { 项目: P });
  return projectWorkbench({
    项目: P,
    节点: [current],
    审计尾: [],
    升级挂起: [],
    探针: { 状态: '正常', 结果: [] },
    策略: { healthy: true, 错误: null, 介入度: '零参与', 失联: {} },
    讨论消息: { [节点]: await parts.bus.readRaw({ 项目: P, 线程: 节点 }) },
    生成于: '2026-10-10T00:00:00Z',
  });
}

/** 动作面的最小 org（`bus_send` handler 要 registry 做主体链、tasks 做讨论线程判定、bus 落线）。 */
function 动作面org(parts) {
  return { registry: parts.registry, tasks: parts.tasks, bus: parts.bus, debate: parts.debate };
}

describe('①甲 动作面收窄：讨论线程的发言只走 debate_say（2026-10-10）', () => {
  it('A-回归：往讨论中的会审节点线程直灌 ⇒ 拒、且没落线（修前 11 条全落线）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      await assert.rejects(
        () => runAction({
          org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_A,
          args: { action: 'bus_send', role: '插件工程', 实例: 'member-a', 线程: 节点, 类型: '分歧', 内容: '绕过 debate_say 直灌' },
        }),
        (e) => e.name === 'Denied'
          && /讨论线程的发言只走 debate_say/.test(e.rule)
          && /debate_say/.test(e.howToChange)
          && /预算闸/.test(e.message)
          && /发言权判据/.test(e.message),
        '讨论线程的发言只走 debate_say：文案要说清类型闸 + 两道预算闸 + 发言权判据，howToChange 指向 debate_say',
      );
      const 落线 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => m.内容 === '绕过 debate_say 直灌');
      assert.equal(落线.length, 0, '被拒的那条没有落线（不是纸面拒绝）');
    } finally {
      await g.cleanup();
    }
  });

  it('A-回归·正对照1：普通线程（根本不是节点 id）照常放行', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      const 普通 = await runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_A,
        args: { action: 'bus_send', role: '插件工程', 实例: 'member-a', 线程: 't-甲-正对照', 类型: '分歧', 内容: '普通线程的消息' },
      });
      assert.equal(普通.消息.线程, 't-甲-正对照', '普通线程不受甲的判据影响（同一个部署里同时有讨论线程）');
      const 落线 = (await parts.bus.readRaw({ 项目: P, 线程: 't-甲-正对照' })).filter((m) => m.内容 === '普通线程的消息');
      assert.equal(落线.length, 1, '真落线');
      assert.equal(落线[0].发件, 'member-a', '发件仍是主体链真实 id（W2 既有口径不受影响）');
    } finally {
      await g.cleanup();
    }
  });

  it('A-回归·正对照2：没有讨论段的节点线程照常放行（甲只认「开过讨论段」）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      const 并行 = await parts.tasks.create({
        subject: LEAD, 项目: P, 描述: '甲正对照·无讨论段', 负责人: ['member-a', 'member-b'], 判据: ['x'], 模式: '并行分担',
      });
      const n = await parts.tasks.get(并行.id, { 项目: P });
      assert.equal(n.讨论, undefined, '前提：这个节点没有讨论段（并行分担全程不长 讨论 字段）');
      const r = await runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_A,
        args: { action: 'bus_send', role: '插件工程', 实例: 'member-a', 线程: 并行.id, 类型: '表态', 内容: '无讨论段节点的消息' },
      });
      assert.equal(r.消息.线程, 并行.id, '没有讨论段的节点 ⇒ 甲的判据不命中 ⇒ 放行');
    } finally {
      await g.cleanup();
    }
  });

  it('A-回归·匹配口径：讨论**已收敛**的节点线程照旧拒（判据是「开过讨论段」，不是「讨论中」）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      await parts.debate.converge({ subject: LEAD, 项目: P, 节点 });
      assert.equal((await parts.tasks.get(节点, { 项目: P })).讨论.状态, '已收敛', '前提：讨论已收敛，讨论段仍在（子状态不删）');
      await assert.rejects(
        () => runAction({
          org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_A,
          args: { action: 'bus_send', role: '插件工程', 实例: 'member-a', 线程: 节点, 类型: '表态', 内容: '收敛后再灌' },
        }),
        (e) => e.name === 'Denied' && /讨论线程的发言只走 debate_say/.test(e.rule) && /已收敛/.test(e.message),
        '收敛后的讨论线程照旧走 debate_say（那边会以「已收敛」拒），动作面不开口子',
      );
    } finally {
      await g.cleanup();
    }
  });
});

describe('①乙 预算名单过滤：外人占不死参与者的闸（2026-10-10）', () => {
  it('A2-回归：服务面直灌 11 条后，参与者照常发言到满、第 3 条才拒（修前第 1 条就被拒）', async () => {
    // 档案顺序决定 random()=0 选谁：参与者 a/b 被扣掉后池是 [lead, member-c] ⇒ 反对者 = lead，
    // 灌水者 member-c **不在名单**（参与者 ∪ 反对者 = a/b/lead）。
    const g = await makeFixture({
      privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 每轮消息上限: 2 } }) },
      members: 档案(['member-a', 'member-b', 'lead', 'member-c']),
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.deepEqual([...开.参与者].sort(), ['member-a', 'member-b'], '前提：参与者两人');
      assert.equal(开.强制反对者, 'lead', '前提：反对者 = lead（random()=0 + 可写预检后的池）');
      assert.ok(!开.参与者.includes('member-c') && 开.强制反对者 !== 'member-c', '前提：member-c 是名单外的人');

      // 复现攻击 A 的形态：名单外的人经**服务面** bus.send 直灌 11 条（上限 2，灌满 5 倍）。
      for (let i = 1; i <= 11; i += 1) {
        await parts.bus.send({ subject: MEMBER_C, 项目: P, 线程: 节点, 发件: 'member-c', 收件: 开.参与者, 类型: '分歧', 内容: `灌水 ${i}` });
      }
      const 灌 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => m.发件 === 'member-c');
      assert.equal(灌.length, 11, '诚实边界：服务面照旧落线 11 条（甲只堵动作面，这里钉的是「落线也占不死预算」）');

      // 参与者的闸不受影响：读数从 1 走到 2，第 3 条才被预算拒。
      const s1 = await parts.debate.say({ subject: MEMBER_A, 项目: P, 节点, 类型: '表态', 内容: '我表态' });
      assert.equal(s1.本轮消息数, 1, '外人灌的 11 条不占预算 ⇒ 参与者第一条照常（修前这里会 11/2 被拒）');
      const s2 = await parts.debate.say({ subject: MEMBER_B, 项目: P, 节点, 类型: '表态', 内容: '我也表态' });
      assert.equal(s2.本轮消息数, 2, '参与者第二条照常');
      await assert.rejects(
        () => parts.debate.say({ subject: MEMBER_A, 项目: P, 节点, 类型: '答复', 内容: '第三条' }),
        (e) => e.name === 'Denied' && /每轮消息上限/.test(e.rule) && /2\/2/.test(e.message),
        '闸照旧管住名单内的人：不是「把闸拆了」换来的放行',
      );

      // 面板读数与闸同一份名单：投影里的本轮消息数也是 2/2（不是把 11 条算进去）。
      const 行 = (await 投影(parts, 节点)).会审.find((a) => a.节点 === 节点);
      assert.equal(行.讨论.本轮消息数, '2/2', '工作台讨论小节用的是同一份名单（第三处调用点）');
    } finally {
      await g.cleanup();
    }
  });

  it('乙·正对照：名单内（参与者 / 反对者）的消息照旧计入', async () => {
    const g = await makeFixture({
      privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 每轮消息上限: 3 } }) },
      members: 档案(['member-a', 'member-b', 'lead', 'member-c']),
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      const s1 = await parts.debate.say({ subject: MEMBER_A, 项目: P, 节点, 类型: '分歧', 内容: '一' });
      assert.equal(s1.本轮消息数, 1, '参与者计入');
      const s2 = await parts.debate.say({ subject: { id: 开.强制反对者, kind: '成员' }, 项目: P, 节点, 类型: '答复', 内容: '二' });
      assert.equal(s2.本轮消息数, 2, '反对者（名单里的人）同样计入');
      const s3 = await parts.debate.say({ subject: MEMBER_B, 项目: P, 节点, 类型: '表态', 内容: '三' });
      assert.equal(s3.本轮消息数, 3, '参与者第三条计入 ⇒ 满');
      await assert.rejects(
        () => parts.debate.say({ subject: MEMBER_A, 项目: P, 节点, 类型: '答复', 内容: '四' }),
        (e) => e.name === 'Denied' && /3\/3/.test(e.message),
        '名单内一律计入：第 4 条拒',
      );
    } finally {
      await g.cleanup();
    }
  });
});

describe('④ 换轮仅 Lead（2026-10-10）', () => {
  it('④-回归：非 Lead 换轮 ⇒ 拒（轮次不推进、无边界消息落线）；Lead 换轮 ⇒ 放行（正对照）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      await parts.debate.say({ subject: MEMBER_A, 项目: P, 节点, 类型: '分歧', 内容: '修前：换轮会把这条预算洗掉' });

      await assert.rejects(
        () => parts.debate.round({ subject: MEMBER_A, 项目: P, 节点 }),
        (e) => e.name === 'Denied'
          && /换轮仅 Lead/.test(e.rule)
          && e.requireAuthority === 'Lead'
          && /debate_round/.test(e.howToChange) && /debate_converge/.test(e.howToChange),
        '成员换轮必须被拒（修前无任何主体判定：任何成员都能换轮、重置两道预算）',
      );
      const n = await parts.tasks.get(节点, { 项目: P });
      assert.equal(n.讨论.轮次, 1, '被拒的换轮没有推进轮次');
      const 边界 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => String(m.内容 ?? '').startsWith(ROUND_BOUNDARY_MARK));
      assert.equal(边界.length, 0, '被拒的换轮没有落轮边界消息 ⇒ 预算没被重置');
      const s = await parts.debate.say({ subject: MEMBER_A, 项目: P, 节点, 类型: '表态', 内容: '还在同一轮' });
      assert.equal(s.轮次, 1, '发言仍在第 1 轮');
      assert.equal(s.本轮消息数, 2, '预算连续（若被洗过这里会回到 1）');

      // 正对照：Lead 换轮放行。
      const 换 = await parts.debate.round({ subject: LEAD, 项目: P, 节点 });
      assert.equal(换.轮次, 2, 'Lead 换轮放行（正对照）');
      const 边界2 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => String(m.内容 ?? '').startsWith(ROUND_BOUNDARY_MARK));
      assert.equal(边界2.length, 1, 'Lead 换轮真落了一条边界消息');
      const s2 = await parts.debate.say({ subject: MEMBER_A, 项目: P, 节点, 类型: '表态', 内容: '新轮第一条' });
      assert.equal(s2.本轮消息数, 1, '真边界照常切轮（换轮功能本体没被改坏）');
    } finally {
      await g.cleanup();
    }
  });

  it('④-回归·文案对齐：拒绝文案与既有「换轮（debate_round，Lead）」同口径', async () => {
    const g = await makeFixture({ privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 每轮消息上限: 1 } }) } });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      await parts.debate.say({ subject: MEMBER_A, 项目: P, 节点, 类型: '表态', 内容: '一' });
      // say() 的两道预算闸文案里一直写着「换轮（debate_round，Lead）」——修前判据与它自相矛盾。
      const 预算拒 = await parts.debate.say({ subject: MEMBER_B, 项目: P, 节点, 类型: '表态', 内容: '二' }).then(() => null, (e) => e);
      assert.match(预算拒.howToChange, /换轮（debate_round，Lead）/, '前提：预算闸的文案确实写着「换轮（debate_round，Lead）」');
      const 换轮拒 = await parts.debate.round({ subject: MEMBER_B, 项目: P, 节点 }).then(() => null, (e) => e);
      assert.equal(换轮拒.requireAuthority, 'Lead', '换轮的实际判据与那句文案同口径：要 Lead');
      assert.match(换轮拒.howToChange, /debate_round/, '指路 debate_round');
    } finally {
      await g.cleanup();
    }
  });
});

describe('⑤ system 当反对者时计入预算（2026-10-10）', () => {
  it('⑤-回归·判据本体：system 不在名单 ⇒ 不计入；在名单 ⇒ 计入', () => {
    const 消息 = [
      { 发件: 'member-a', 类型: '表态', 内容: 'a' },
      { 发件: 'system', 类型: '分歧', 内容: 's' },
      { 发件: 'system', 类型: '答复', 内容: 's2' },
    ];
    assert.equal(本轮发言(消息, ['member-a', 'member-b']).length, 1, 'system 不在名单 ⇒ 他的 分歧/答复 都不计入');
    assert.deepEqual(
      本轮发言(消息, ['member-a', 'member-b', 'system']).map((m) => m.内容),
      ['a', 's', 's2'],
      'system 在名单（当上反对者）⇒ 他的两条发言计入',
    );
    // 边界消息自身永远不计入（类型闸）：它只负责切轮 —— 名单里即便有 system 也不影响这一条。
    const 带边界 = [
      { 发件: 'member-a', 类型: '分歧', 内容: '边界之前的不算' },
      { 发件: 'system', 类型: '系统', 内容: `${ROUND_BOUNDARY_MARK} 2` },
      { 发件: 'system', 类型: '分歧', 内容: '新轮的 s' },
    ];
    assert.deepEqual(
      本轮发言(带边界, ['member-a', 'system']).map((m) => m.内容),
      ['新轮的 s'],
      '真边界切轮 + 类型=系统 的消息本身不计入（类型闸不变）',
    );
  });

  it('⑤-回归·端到端：system 真当上强制反对者 ⇒ 他的发言吃满预算、第 3 条被拒（修前可无限发言）', async () => {
    // 「身份档案里真有一个叫 system 的实例」是主权者的选择（判据6b：在册即可，不看名字）。
    const g = await makeFixture({
      privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 每轮消息上限: 2 } }) },
      members: 档案(['member-a', 'member-b', 'system']),
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.equal(开.强制反对者, 'system', '前提：system 当上了反对者（在册 + 可写）');
      const s1 = await parts.debate.say({ subject: 系统成员, 项目: P, 节点, 类型: '分歧', 内容: '我反对' });
      assert.equal(s1.本轮消息数, 1, 'system 在名单 ⇒ 他的发言计入预算');
      const s2 = await parts.debate.say({ subject: 系统成员, 项目: P, 节点, 类型: '答复', 内容: '仍然反对' });
      assert.equal(s2.本轮消息数, 2, '第二条也计入');
      await assert.rejects(
        () => parts.debate.say({ subject: 系统成员, 项目: P, 节点, 类型: '答复', 内容: '第三条' }),
        (e) => e.name === 'Denied' && /每轮消息上限/.test(e.rule) && /2\/2/.test(e.message),
        '修前他不在名单 ⇒ 本轮恒为空 ⇒ 可无限发言；现在按名单计入 ⇒ 2/2 就被拒',
      );
    } finally {
      await g.cleanup();
    }
  });

  it('⑤-回归·对照片：system 不在名单时，同形的系统发件消息照旧不占预算', async () => {
    const g = await makeFixture({
      privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 每轮消息上限: 2 } }) },
      members: 档案(['member-a', 'member-b', 'lead']),
    });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks);
      const 开 = await parts.debate.open({ subject: LEAD, 项目: P, 节点 });
      assert.equal(开.强制反对者, 'lead', '前提：反对者是 lead，不是 system');
      // 机制主体（kind=系统）经服务面落 3 条「分歧」——不是名单里的人。
      for (let i = 1; i <= 3; i += 1) {
        await parts.bus.send({ subject: SYSTEM, 项目: P, 线程: 节点, 发件: 'system', 收件: 开.参与者, 类型: '分歧', 内容: `系统发言 ${i}` });
      }
      const 系统消息 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => m.发件 === 'system' && m.类型 === '分歧');
      assert.equal(系统消息.length, 3, '前提：3 条 system 发件真落线');
      const s = await parts.debate.say({ subject: MEMBER_A, 项目: P, 节点, 类型: '表态', 内容: '我表态' });
      assert.equal(s.本轮消息数, 1, '不在名单的 system 发件不占预算（与 ①乙 同一口径）');
    } finally {
      await g.cleanup();
    }
  });

  it('⑤-回归·fail-closed：名单漏传（undefined）⇒ 响亮失败，不静默放宽', () => {
    assert.throws(
      () => 本轮发言([{ 发件: 'member-a', 类型: '表态', 内容: 'x' }]),
      (e) => e.name === 'InvalidBody' && /名单/.test(e.message),
      '漏传名单若被当成空名单 ⇒ 预算两道闸静默失效（fail-open）：必须响亮失败',
    );
  });
});

/**
 * 批c 补漏 · P2（2026-10-10 独立复核攻破并实测）：甲第一版只写在 `bus_send` 里 ⇒
 * **动作面还有另一只往线程落消息的手**：`bus_unlock`（内部是 `unlock` 广播
 * `发件='system' / 类型='广播' / 内容=调用方给的原文`）。修前实测：
 * `bus_unlock{id:讨论节点, 线程:讨论节点}` ⇒ **放行**，线程里落线 3 条（重复调用重复落线，
 * 无去重）；`id` 换成别的已交卷节点、`线程` 指成讨论节点 ⇒ 依然放行。
 *
 * 危害的**边界**（如实写，别夸大）：类型='广播' 不在 `DEBATE_SAY_TYPES` ⇒ **不占预算**；
 * 也**伪造不了轮边界**（类型='系统' 只许 `kind==='系统'` 主体，`src/bus.js` 那条闸仍拦成员）。
 * 危害是**往讨论线程注入伪造的系统广播**（内容可控、可重复）。
 *
 * 修法：判据收成**一处**实现（`lib/actions.js` 的 `拒讨论线程直灌`），两个 handler 都调它。
 * 正对照必须实测：`bus_unlock` 的正常用途（全员交卷后往**节点线程**解锁广播，那时还没有讨论段）
 * 一个字不许被拒掉。
 */
describe('批c 补漏 · P2：bus_unlock 也是「往线程落消息」的一只手（2026-10-10）', () => {
  it('P2-回归：bus_unlock{线程:讨论节点} ⇒ 拒、且没落线（三种形态；修前落 3 条 广播/无去重）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 讨论 = await 交齐会审(parts.tasks, undefined, 'P2 讨论节点');
      const 别的 = await 交齐会审(parts.tasks, undefined, 'P2 别的已交卷节点');
      await parts.debate.open({ subject: LEAD, 项目: P, 节点: 讨论 });
      const n = await parts.tasks.get(讨论, { 项目: P });
      assert.equal(n.讨论.状态, '讨论中', '前提：讨论开着');
      assert.notEqual(别的, 讨论, '前提：两个节点是不同的已交卷节点（修前「id 换一个」那条形态靠它）');
      assert.equal((await parts.tasks.get(别的, { 项目: P })).状态, '已交卷', '前提：另一个节点也是已交卷（齐卷判据在它身上会成立）');
      // 讨论线程文件这时**还不存在**（debate_open 只写任务图与审计，不往线程落消息）——
      // 修前那三条正是**由攻击自己建出文件**落进去的。
      assert.deepEqual(await parts.bus.threads({ 项目: P }), [], '前提：讨论线程文件此刻还不存在');

      const 攻击 = (id, 内容) => () => runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: LEAD,
        args: { action: 'bus_unlock', id, 线程: 讨论, 内容 },
      });
      // 形态1：id 就是讨论节点自己（修前：全员已交 ⇒ 放行）
      await assert.rejects(
        攻击(讨论, 'P2 攻击原文'),
        (e) => e.name === 'Denied'
          && /讨论线程的发言只走 debate_say/.test(e.rule)
          && /bus_unlock/.test(e.message)
          && /预算闸/.test(e.message) && /发言权判据/.test(e.message)
          && e.detail?.入口 === 'bus_unlock' && e.detail?.节点 === 讨论,
        'bus_unlock 必须与 bus_send 过同一道判据（文案要点名是这只手直灌）',
      );
      // 形态2：同一条重复调用（修前无去重 ⇒ 重复落线）
      await assert.rejects(攻击(讨论, 'P2 攻击原文'), (e) => e.name === 'Denied' && e.detail?.入口 === 'bus_unlock', '重复调用同样拒');
      // 形态3：id 换成别的已交卷节点、线程指成讨论节点（修前：齐卷在别的节点上成立 ⇒ 放行）
      await assert.rejects(攻击(别的, 'P2 攻击原文'), (e) => e.name === 'Denied' && e.detail?.节点 === 讨论, 'id 与线程脱钩也拒');

      const 落 = await parts.bus.readRaw({ 项目: P, 线程: 讨论 });
      assert.equal(落.length, 0, `讨论线程必须 0 条（修前 3 条 发件=system/类型=广播 落在这里）：实际 ${落.length}`);
      assert.deepEqual(await parts.bus.threads({ 项目: P }), [], '连讨论线程文件都不该被攻击建出来');
    } finally {
      await g.cleanup();
    }
  });

  it('P2-回归·正对照1：普通线程（不是节点 id）照常解锁并广播', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 讨论 = await 交齐会审(parts.tasks, undefined, 'P2 正对照·讨论节点');
      await parts.debate.open({ subject: LEAD, 项目: P, 节点: 讨论 });
      const r = await runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: LEAD,
        args: { action: 'bus_unlock', id: 讨论, 线程: 't-P2-普通线程', 内容: 'P2 正对照广播' },
      });
      assert.equal(r.结果.解锁, true, '普通线程不受讨论线程判据影响（同一个部署里同时有讨论线程）');
      const 落 = (await parts.bus.readRaw({ 项目: P, 线程: 't-P2-普通线程' })).filter((m) => m.内容 === 'P2 正对照广播');
      assert.equal(落.length, 1, '真落线');
      assert.equal(落[0].类型, '广播', '广播形态没被改坏（发件=system 是 unlock 的既有口径）');
      assert.deepEqual(落[0].收件, ['member-a', 'member-b'], '收件仍取负责人（默认 收件 = 负责人）');
    } finally {
      await g.cleanup();
    }
  });

  it('P2-回归·正对照2：线程 = 未开讨论的节点 id ⇒ 照常解锁（这正是它的正常用途）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks, undefined, 'P2 正对照·无讨论段节点');
      assert.equal((await parts.tasks.get(节点, { 项目: P })).讨论, undefined, '前提：这个节点没有讨论段');
      const r = await runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: LEAD,
        args: { action: 'bus_unlock', id: 节点, 线程: 节点, 内容: 'P2 正对照广播（节点线程）' },
      });
      assert.equal(r.结果.解锁, true, '未开讨论的节点线程 ⇒ 判据不命中 ⇒ 放行（正常路径不许被误伤）');
      const 落 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => m.类型 === '广播');
      assert.equal(落.length, 1, '解锁广播真落在节点线程上');
    } finally {
      await g.cleanup();
    }
  });
});

/**
 * 批c 补漏 · P3（2026-10-10 独立复核攻破并实测）：判定用**精确键**（`tasks.get`，fold Map 的
 * key 匹配）而落线走**文件系统**（`layout.busThread` → NTFS 大小写不敏感）⇒ 线程名的大小写
 * 变体是一条旁路。修前实测：`线程 = 讨论节点id.toUpperCase()` ⇒ 判定 miss、**放行**，
 * 消息**落进同一个文件**（`readRaw(真 id)` 读得到），且**类型闸一起废**（连 `交卷` 都收）。
 *
 * 修法：判定与落线**共用同一个等价类** —— `线程等价键()`（`src/paths.js`，就写在
 * `assertPathSegment` 旁边、`busThread` 的注释指向它）。只折大小写：不多（NTFS 不折 NFKC，
 * 折了会比落线侧更宽 ⇒ 误伤）也不少（分隔符在 `assertPathSegment` 那一层已被拒 ⇒ 没有别名可绕）。
 */
describe('批c 补漏 · P3：线程键的大小写别名绕过甲（2026-10-10）', () => {
  it('P3-回归：bus_send{线程:<讨论节点id 的大小写变体>} ⇒ 拒、且没落线（类型闸一起守住）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 讨论 = await 交齐会审(parts.tasks, undefined, 'P3 讨论节点');
      await parts.debate.open({ subject: LEAD, 项目: P, 节点: 讨论 });
      const 别名 = 讨论.toUpperCase();
      assert.notEqual(别名, 讨论, '前提：节点 id 里真有大写可变的位置（否则这条判据是空转）');
      assert.equal(await parts.tasks.get(别名, { 项目: P }), null, '前提：精确键命不中别名 —— 这就是修前的判定口径');

      await assert.rejects(
        () => runAction({
          org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_A,
          // 类型='交卷' 是讨论类型**之外**的（修前它与消息一起绕过去了：类型闸也废）
          args: { action: 'bus_send', role: '插件工程', 实例: 'member-a', 线程: 别名, 类型: '交卷', 内容: 'P3 别名直灌' },
        }),
        (e) => e.name === 'Denied'
          && /讨论线程的发言只走 debate_say/.test(e.rule)
          && /debate_say/.test(e.howToChange)
          && e.detail?.线程 === 别名 && e.detail?.节点 === 讨论
          && /线程等价类/.test(String(e.detail?.命中)),
        '大小写别名必须被同一道判据拦下（detail 要如实写明是走等价类命中的）',
      );
      assert.equal((await parts.bus.readRaw({ 项目: P, 线程: 讨论 })).length, 0, 'readRaw(真 id) 必须 0 条（修前那一条就落在这里）');
      assert.equal((await parts.bus.readRaw({ 项目: P, 线程: 别名 })).length, 0, '别名这一侧也 0 条');
      assert.deepEqual(await parts.bus.threads({ 项目: P }), [], '别名没有把线程文件建出来（没落线）');
    } finally {
      await g.cleanup();
    }
  });

  it('P3-回归·交叉：bus_unlock 的线程键同样折大小写（P2 与 P3 是同一处判据的两面）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 讨论 = await 交齐会审(parts.tasks, undefined, 'P3 交叉·讨论节点');
      await parts.debate.open({ subject: LEAD, 项目: P, 节点: 讨论 });
      const 别名 = 讨论.toUpperCase();
      await assert.rejects(
        () => runAction({
          org: 动作面org(parts), 项目: P, subject: LEAD, 主体: LEAD,
          args: { action: 'bus_unlock', id: 讨论, 线程: 别名, 内容: 'P3 交叉·别名解锁广播' },
        }),
        (e) => e.name === 'Denied' && /讨论线程的发言只走 debate_say/.test(e.rule)
          && e.detail?.入口 === 'bus_unlock' && /线程等价类/.test(String(e.detail?.命中)),
        '两只手共用同一处判据 ⇒ 别名在两只手上都必须被拦（修前：两只手都放行）',
      );
      assert.equal((await parts.bus.readRaw({ 项目: P, 线程: 讨论 })).length, 0, '没落线');
    } finally {
      await g.cleanup();
    }
  });

  it('P3-回归·正对照：普通线程的大小写变体照常放行（且两个写法落同一个文件＝落线侧的等价类）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 讨论 = await 交齐会审(parts.tasks, undefined, 'P3 正对照·讨论节点');
      await parts.debate.open({ subject: LEAD, 项目: P, 节点: 讨论 });
      const 发 = (线程, 内容) => runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_A,
        args: { action: 'bus_send', role: '插件工程', 实例: 'member-a', 线程, 类型: '表态', 内容 },
      });
      const 上 = await 发('T-P3-Normal', 'P3 正对照·大写写法');
      const 下 = await 发('t-p3-normal', 'P3 正对照·小写写法');
      assert.equal(上.消息.线程, 'T-P3-Normal', '普通线程不受影响（同一个部署里同时有讨论线程）');
      assert.equal(下.消息.线程, 't-p3-normal', '同一个线程的另一个写法也不受影响');
      const 落 = await parts.bus.readRaw({ 项目: P, 线程: 'T-P3-Normal' });
      assert.equal(落.filter((m) => m.内容.startsWith('P3 正对照')).length, 2, '两条都真落线（不是纸面放行）');
      // 落线侧的等价类（实测）：两个写法在**本仓载体**（NTFS 大小写不敏感）上是**同一个文件**——
      // 这正是判定侧必须折大小写的理由。⚠️ 这条断言随载体走：大小写敏感载体上两个写法是两个文件，
      //    那时判定侧也不该折（判据照落线侧来，不是拍脑袋定的），故只在 win32 上断言。
      if (process.platform === 'win32') {
        assert.equal(
          (await parts.bus.threads({ 项目: P })).filter((t) => t.toUpperCase() === 'T-P3-NORMAL').length,
          1,
          '两个大小写写法只对应**一个**线程文件（NTFS 大小写不敏感 ⇒ 判定侧的等价类就是照它定的）',
        );
      }
    } finally {
      await g.cleanup();
    }
  });
});

describe('㉖ 动作面收窄：任务线程只有负责人与 Lead 可直灌（2026-10-10 收口）', () => {
  /** 造一个无讨论段、负责人 = member-a（单人）的任务节点 —— 攻击者用**在档**的 member-b（非负责人）。 */
  async function 任务节点(tasks) {
    const node = await tasks.create({
      subject: LEAD, 项目: P, 描述: '㉖ 判据·任务线程', 负责人: ['member-a'], 判据: ['x'], 模式: '并行分担',
    });
    return node.id;
  }

  it('㉖-回归：非负责人成员 bus_send 往别人的任务线程 ⇒ 拒、且没落线（修前 probe 实测放行真落线）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 任务节点(parts.tasks);
      await assert.rejects(
        () => runAction({
          org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_B,
          args: { action: 'bus_send', role: '插件工程', 实例: 'member-b', 线程: 节点, 类型: '表态', 内容: '㉖ 往别人任务线程塞' },
        }),
        (e) => e.name === 'Denied'
          && /任务线程只有负责人与 Lead 可发/.test(e.rule)
          && /权限矩阵/.test(e.rule)
          && e.detail?.发件 === 'member-b'
          && e.detail?.命中 === '精确键',
        '权限矩阵写的是「任何在岗主体写**自己**线程的消息」—— 他人任务线程不在授权面（文案要说清判据出处）',
      );
      const 落线 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => m.内容 === '㉖ 往别人任务线程塞');
      assert.equal(落线.length, 0, '被拒的那条没有落线（不是纸面拒绝）');
    } finally {
      await g.cleanup();
    }
  });

  it('㉖-等价键：线程 = 节点 id 的大小写变体 ⇒ 同一道判据拦下（与 P3 同款攻击面）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 任务节点(parts.tasks);
      await assert.rejects(
        () => runAction({
          org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_B,
          args: { action: 'bus_send', role: '插件工程', 实例: 'member-b', 线程: 节点.toUpperCase(), 类型: '交卷', 内容: '㉖ 大小写旁路' },
        }),
        (e) => e.name === 'Denied' && /任务线程只有负责人与 Lead 可发/.test(e.rule) && /线程等价类/.test(e.detail?.命中),
        '判定键与落线键同源（线程等价键）—— 大小写别名不许绕过「他人任务线程」这道闸',
      );
    } finally {
      await g.cleanup();
    }
  });

  it('㉖-正对照1：负责人自己的任务线程 ⇒ 放行真落线（「写自己线程的消息」的授权面不动）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 任务节点(parts.tasks);
      const r = await runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_A,
        args: { action: 'bus_send', role: '插件工程', 实例: 'member-a', 线程: 节点, 类型: '表态', 内容: '负责人自己的发言' },
      });
      assert.equal(r.消息.线程, 节点, '负责人直灌自己的任务线程 ⇒ 放行');
      const 落线 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => m.内容 === '负责人自己的发言');
      assert.equal(落线.length, 1, '真落线');
      assert.equal(落线[0].发件, 'member-a', '发件仍是主体链真实 id');
    } finally {
      await g.cleanup();
    }
  });

  it('㉖-正对照2：Lead 跨任务线程发言 ⇒ 放行（受理/表态/派活的既有授权面不动）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const 节点 = await 任务节点(parts.tasks);
      const r = await runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: LEAD,
        args: { action: 'bus_send', 线程: 节点, 类型: '表态', 内容: 'Lead 派活口径' },
      });
      assert.equal(r.消息.线程, 节点, 'Lead 往任务线程写消息 ⇒ 放行');
      const 落线 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => m.内容 === 'Lead 派活口径');
      assert.equal(落线.length, 1, '真落线');
      assert.equal(落线[0].发件, 'lead', '发件 = 主体链真实 id（Lead）');
    } finally {
      await g.cleanup();
    }
  });

  it('㉖-正对照3：非负责人成员往**普通线程**（非节点 id）⇒ 照常放行（普通线程的开放是既有语义，本批不收）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      await 任务节点(parts.tasks); // 同一部署里同时有任务节点，证明判据只认「命中节点」这一档
      const r = await runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_B,
        args: { action: 'bus_send', role: '插件工程', 实例: 'member-b', 线程: 't-㉖-普通', 类型: '表态', 内容: '普通线程开放' },
      });
      assert.equal(r.消息.线程, 't-㉖-普通', '普通线程不受㉖ 影响（收窄它属另一条裁决）');
      const 落线 = (await parts.bus.readRaw({ 项目: P, 线程: 't-㉖-普通' })).filter((m) => m.内容 === '普通线程开放');
      assert.equal(落线.length, 1, '真落线');
    } finally {
      await g.cleanup();
    }
  });

  it('㉖-边界：bus_unlock 对别人的已交齐节点 ⇒ 不受㉖ 影响（它有自己的齐卷闸，本判据不挂那只手）', async () => {
    const g = await makeFixture({ members: 档案(['member-a', 'member-b', 'lead', 'member-c']) });
    try {
      const parts = 装配(g);
      const 节点 = await 交齐会审(parts.tasks, undefined, '㉖ 边界·齐卷无讨论');
      // 不开讨论段 ⇒ ⑰ 不命中；全员已交 ⇒ 齐卷闸放行 —— ㉖ 不挂 bus_unlock（有意边界，见函数注释）
      const r = await runAction({
        org: 动作面org(parts), 项目: P, subject: LEAD, 主体: MEMBER_C,
        args: { action: 'bus_unlock', id: 节点, 线程: 节点, 内容: '㉖ 边界广播' },
      });
      assert.ok(r.结果, '非负责人成员触发齐卷解锁广播 ⇒ 照旧放行（解锁的授权面是齐卷，不是线程归属）');
      const 落线 = (await parts.bus.readRaw({ 项目: P, 线程: 节点 })).filter((m) => m.内容 === '㉖ 边界广播');
      assert.equal(落线.length, 1, '广播真落线（发件=system，编排通道）');
    } finally {
      await g.cleanup();
    }
  });
});
