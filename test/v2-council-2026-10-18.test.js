/**
 * v2 会审（口述收敛 2026-10-18 条目18/19）的回归网。
 *
 * 旧四份测试（council-integrity / debate / debate-guards / dissenter）里的判据在本文件
 * 按 v2 语义重钉：
 *  ① 会审退出任务图 = 与会话绑定的独立功能：问题/参与者/来源会话入自己的事件流
 *     （`councils.jsonl`），不再占任务节点、不写任务图 debate_* 事件。
 *  ② 盲评：未交齐前参与者互不可见；提交后解锁（`debate_unlock`，仅 Lead，全员按人交齐）。
 *  ③ 讨论段默认不开：第一次 `debate_round` 才开启（仅 Lead）；类型闸/发言权闸/两道预算闸
 *     与轮次上限照旧；预算开启时冻结快照，改部署不追溯。
 *  ④ 收敛（仅 Lead）算分歧清单 + 零分歧报警，存档六要素齐全；收敛后状态机冻结。
 *  ⑤ 工作台会审区 = 会审存档形状（id/问题/状态/参与者/答案/分歧清单/结论/零分歧/轮次）。
 *  ⑥ 直灌闸：会审讨论线程 `会审/{id}` 只许 debate_say 落线（bus_send / bus_unlock 拒，
 *     含大小写别名 —— 判定键与落线键同源）。
 *  ⑦ 历史任务图讨论段原地只读：旧 debate_* 事件仍 fold，总线投影照旧遮罩。
 *
 * 反例校准留痕：本文件每条「拒」都同时断言副作用没发生（不落账/不落线/状态不动）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER, REVIEWER, writeUnder } from './helpers.mjs';
import { Org } from '../src/org.js';
import { 本轮发言, ROUND_BOUNDARY_MARK, 线程名, DEBATE_SAY_TYPES } from '../src/council.js';
import { 盲标分配 } from '../src/review.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import { appendLines } from '../src/kernel/fsx.js';
import { runAction } from '../lib/actions.js';

const P = 'proj-v2council';
const 部署偏好 = '集体L2-共享基础设施/defaults/部署.json';
const 乙 = { id: 'member-b', kind: '成员', roleId: '插件工程' };
const 丙 = { id: 'member-c', kind: '成员', roleId: '插件工程' };

async function 起组织(options = {}) {
  const f = await makeFixture(options);
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

/** 发起一场会审（默认参与者 = 甲乙）。 */
async function 开会审(org, spec = {}) {
  return org.council.open({
    subject: spec.subject ?? LEAD, 项目: P, 问题: spec.问题 ?? 'v2 会审演示：方案 A 还是方案 B',
    参与者: spec.参与者 ?? [MEMBER.id, 乙.id],
  });
}

/** 甲乙各交一份卷（默认结论层一致、无例外面 ⇒ 零分歧成立）。 */
async function 双人交齐(org, id, spec = {}) {
  await org.council.answer({
    subject: spec.甲 ?? MEMBER, 项目: P, id, 结论: spec.甲结论 ?? 'A 案',
    结论层: spec.甲层 ?? '方案A', 反例面: spec.甲反例 ?? [],
  });
  await org.council.answer({
    subject: spec.乙 ?? 乙, 项目: P, id, 结论: spec.乙结论 ?? 'B 案',
    结论层: spec.乙层 ?? '方案A', 反例面: spec.乙反例 ?? [],
  });
}

/** 一场「已解锁 + 已开讨论」的会审（用于讨论/收敛用例）。 */
async function 开讨论(org, id) {
  await org.council.unlock({ subject: LEAD, 项目: P, id });
  return org.council.round({ subject: LEAD, 项目: P, id });
}

describe('① 发起：会话绑定的独立会审（问题 · 参与者 · 来源会话）', () => {
  it('问题必填、至少两位参与者；被拒的发起不落账', async () => {
    const { f, org } = await 起组织();
    try {
      await assert.rejects(
        () => org.council.open({ subject: LEAD, 项目: P, 问题: '   ', 参与者: ['member-a', 'member-b'] }),
        (e) => e.name === 'InvalidBody' && /问题/.test(e.message),
        '没有问题的会审没有收敛对象',
      );
      await assert.rejects(
        () => org.council.open({ subject: LEAD, 项目: P, 问题: '只有一个参与者', 参与者: ['member-a'] }),
        (e) => e.name === 'InvalidBody' && /两位参与者/.test(e.message),
        '独立作答的意义在多份答案互相校验',
      );
      assert.deepEqual(await org.council.list({ 项目: P }), [], '被拒的发起不落事件流');
    } finally { await f.cleanup(); }
  });

  it('参与者必须在册在岗：不在档案里 ⇒ 拒（不落账）', async () => {
    const { f, org } = await 起组织();
    try {
      await assert.rejects(
        () => 开会审(org, { 参与者: ['member-a', 'ghost-member'] }),
        (e) => e.name === 'InvalidBody' && /ghost-member/.test(e.message) && /身份档案/.test(e.message),
        '会审答案要落到真实实例头上',
      );
      assert.deepEqual(await org.council.list({ 项目: P }), []);
    } finally { await f.cleanup(); }
  });

  it('成员不能发起会审（自治档 · 会审名单外无）', async () => {
    const { f, org } = await 起组织();
    try {
      await assert.rejects(
        () => 开会审(org, { subject: MEMBER }),
        (e) => e instanceof Denied && /会审/.test(e.rule),
        '参与者名单由 Lead 点名；成员自己发起等于自带名单',
      );
      assert.deepEqual(await org.council.list({ 项目: P }), []);
    } finally { await f.cleanup(); }
  });

  it('发起成功：状态作答中、来源会话=发起人、问题/参与者/创建时间入档，审计留痕', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org, { 问题: '来源会话要入档' });
      assert.match(开.id, /^council-/, '会审 id 形状');
      assert.equal(开.会审.状态, '作答中');
      assert.equal(开.会审.问题, '来源会话要入档');
      assert.deepEqual(开.会审.参与者, ['member-a', 'member-b']);
      assert.equal(开.会审.来源会话, 'lead', '来源会话 = 发起人主体 id（会话绑定）');
      assert.ok(开.会审.创建于, '创建时间入档');
      assert.equal(开.会审.轮次上限, 2, '默认轮次上限 2');
      const 审计 = (await org.audit.read({})).filter((r) => r.动作 === '会审发起' && r.对象?.id === 开.id);
      assert.equal(审计.length, 1, '发起留一条审计');
      assert.equal(审计[0].结果, 'opened');
    } finally { await f.cleanup(); }
  });

  it('人数上限：部署覆盖生效，超限拒并指路拆成多场', async () => {
    const { f, org } = await 起组织({
      privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 人数上限: 2 } }) },
      members: {
        'member-a': { id: 'member-a', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-b': { id: 'member-b', 岗位: '插件工程', 代: 1, status: '在岗' },
        'member-c': { id: 'member-c', 岗位: '插件工程', 代: 1, status: '在岗' },
        lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' },
      },
    });
    try {
      await assert.rejects(
        () => 开会审(org, { 参与者: ['member-a', 'member-b', 'member-c'] }),
        (e) => e instanceof Denied && /人数上限/.test(e.rule) && /3/.test(e.message) && /拆/.test(e.howToChange),
        '会审按小会设计：规模上去请拆成多场',
      );
      assert.deepEqual(await org.council.list({ 项目: P }), []);
    } finally { await f.cleanup(); }
  });
});

describe('② 作答 · 盲评 · 解锁', () => {
  it('仅参与者作答、结论必填；同人再交替换自己那份（按人计数不虚增）', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await assert.rejects(
        () => org.council.answer({ subject: 丙, 项目: P, id: 开.id, 结论: '名单外' }),
        (e) => e instanceof Denied && /仅参与者可作答/.test(e.rule),
      );
      await assert.rejects(
        () => org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: '   ' }),
        (e) => e.name === 'InvalidBody' && /结论/.test(e.message),
      );

      const 一 = await org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: 'A 初稿', 结论层: '方案A' });
      assert.deepEqual([一.已交, 一.待交, 一.齐], [1, 1, false]);
      const 二 = await org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: 'A 改稿', 结论层: '方案A' });
      assert.deepEqual([二.已交, 二.待交, 二.齐], [1, 1, false], '同人再交是替换，不是多一份');
      const 三 = await org.council.answer({ subject: 乙, 项目: P, id: 开.id, 结论: 'B 案', 结论层: '方案A' });
      assert.deepEqual([三.已交, 三.待交, 三.齐], [2, 0, true]);
      const 视图 = await org.council.get(P, 开.id);
      assert.equal(视图.答案.find((a) => a.成员 === 'member-a').结论, 'A 改稿', '自己的最新那份生效');
    } finally { await f.cleanup(); }
  });

  it('盲评遮罩：作答中参与者只看到他人盲标（结论不出）；Lead 全量；解锁后参与者全量', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: 'A 的秘密结论' });
      const 标 = new Map(盲标分配(线程名(开.id), ['member-a', 'member-b']).map((e) => [e.id, e.盲标]));

      const 乙读 = (await org.council.list({ 项目: P, 读者: 乙 }))[0];
      assert.equal(乙读.盲评遮罩, true, '作答中的成员读者看到遮罩标记');
      const 甲条 = 乙读.答案.find((a) => a.成员 === 标.get('member-a'));
      assert.ok(甲条, '他人条目只留盲标（单源 盲标分配）');
      assert.equal(甲条.结论, null, '结论不出');
      assert.equal(甲条.结论层, null);
      assert.deepEqual(甲条.反例面, []);
      assert.ok(!JSON.stringify(乙读).includes('A 的秘密结论'), '遮罩行整体不许泄露结论原文');

      const lead读 = (await org.council.list({ 项目: P, 读者: LEAD }))[0];
      assert.equal(lead读.盲评遮罩, undefined, '发起人/Lead 不受盲评遮罩（组织记账）');
      assert.ok(lead读.答案.some((a) => a.结论 === 'A 的秘密结论'));

      const 回执 = await org.council.answer({ subject: 乙, 项目: P, id: 开.id, 结论: 'B 案' });
      assert.equal(回执.会审.状态, '作答中', '交齐不等于已解锁');
      assert.ok(!JSON.stringify(回执).includes('A 的秘密结论'), '后交卷者的作答响应也必须遮罩他人答案');
      assert.ok(回执.会审.答案.some((a) => a.成员 === 乙.id && a.结论 === 'B 案'), '自己的答案不遮罩');
      const 旁听读 = (await org.council.list({ 项目: P, 读者: 丙 }))[0];
      assert.ok(!JSON.stringify(旁听读).includes('A 的秘密结论'), '名单外成员不能比参与者看到更多盲评内容');
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      const 解锁后 = (await org.council.list({ 项目: P, 读者: 乙 }))[0];
      assert.equal(解锁后.状态, '已解锁');
      assert.equal(解锁后.盲评遮罩, undefined, '解锁 = 盲评到此为止');
      assert.ok(解锁后.答案.some((a) => a.结论 === 'A 的秘密结论'), '解锁后参与者看全量');
    } finally { await f.cleanup(); }
  });

  it('解锁：仅 Lead；未全员按人交齐 ⇒ 拒且状态不动；解锁后不再接受作答', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: 'A 案' });
      await assert.rejects(
        () => org.council.unlock({ subject: LEAD, 项目: P, id: 开.id }),
        (e) => e instanceof Denied && /全员已交/.test(e.rule) && /member-b/.test(e.message),
        '提前揭名会污染还没作答的独立判断',
      );
      assert.equal((await org.council.get(P, 开.id)).状态, '作答中', '被拒的解锁不改状态');

      await org.council.answer({ subject: 乙, 项目: P, id: 开.id, 结论: 'B 案' });
      await assert.rejects(
        () => org.council.unlock({ subject: MEMBER, 项目: P, id: 开.id }),
        (e) => e instanceof Denied && /仅 Lead/.test(e.rule),
        '解锁是流程决定，不是发言权',
      );
      const 解 = await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      assert.equal(解.会审.状态, '已解锁');
      assert.ok(解.会审.解锁于, '解锁时间入档');

      await assert.rejects(
        () => org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: '解锁后改卷' }),
        (e) => e instanceof Denied && /不再接受作答/.test(e.message),
        '揭名后改卷 = 在已公开的答案集上洗卷',
      );
      const after = await org.council.get(P, 开.id);
      assert.equal(after.答案.find((a) => a.成员 === 'member-a').结论, 'A 案', '被拒的改卷没洗掉原答案');
    } finally { await f.cleanup(); }
  });
});

describe('③ 讨论默认不开 · 发言闸 · 预算', () => {
  it('解锁后 say 仍拒（讨论默认不开）；round 仅 Lead，首次调用=开启第1轮并落边界消息', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id);
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      await assert.rejects(
        () => org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '表态', 内容: '没开讨论就想说' }),
        (e) => e instanceof Denied && /没有开启讨论/.test(e.rule),
        '讨论段默认不开（条目19）',
      );
      await assert.rejects(
        () => org.council.round({ subject: MEMBER, 项目: P, id: 开.id }),
        (e) => e instanceof Denied && /仅 Lead/.test(e.rule),
        '换轮/开启讨论仅 Lead',
      );
      const 轮 = await org.council.round({ subject: LEAD, 项目: P, id: 开.id });
      assert.equal(轮.轮次, 1);
      assert.equal(轮.会审.状态, '讨论中');
      const 消息 = await org.bus.readRaw({ 项目: P, 线程: 线程名(开.id) });
      const 边界 = 消息.filter((m) => String(m.内容 ?? '').startsWith(ROUND_BOUNDARY_MARK));
      assert.equal(边界.length, 1, '开启讨论落一条轮边界消息');
      assert.equal(边界[0].发件, 'system');
      assert.equal(边界[0].类型, '系统');
    } finally { await f.cleanup(); }
  });

  it('发言闸：类型只认三种、仅参与者、内容非空', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id);
      await 开讨论(org, 开.id);
      await assert.rejects(
        () => org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '交卷', 内容: 'x' }),
        (e) => e.name === 'InvalidBody' && /分歧 \/ 表态 \/ 答复/.test(e.message),
        `讨论类型只有 ${DEBATE_SAY_TYPES.join('/')}`,
      );
      await assert.rejects(
        () => org.council.say({ subject: REVIEWER, 项目: P, id: 开.id, 类型: '表态', 内容: '旁听意见' }),
        (e) => e instanceof Denied && /仅参与者可发言/.test(e.rule),
        '旁听者看会审页 / bus_read，不进讨论',
      );
      await assert.rejects(
        () => org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '表态', 内容: '   ' }),
        (e) => e.name === 'InvalidBody' && /内容为空/.test(e.message),
      );
      const 说 = await org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '分歧', 内容: '回滚成本没评估' });
      assert.equal(说.本轮消息数, 1);
      const 落 = (await org.bus.readRaw({ 项目: P, 线程: 线程名(开.id) })).filter((m) => m.内容 === '回滚成本没评估');
      assert.equal(落.length, 1, '真落线');
      assert.equal(落[0].发件, 'member-a', '发件 = 主体真实 id');
    } finally { await f.cleanup(); }
  });

  it('两道预算：每轮消息上限与每人每轮字符上限，读数如时且换成员不共用额度', async () => {
    const { f, org } = await 起组织({
      privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 每轮消息上限: 2, 每人每轮字符上限: 10 } }) },
    });
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id);
      await 开讨论(org, 开.id);
      const s1 = await org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '表态', 内容: '六六六六六六' }); // 6 字
      assert.equal(s1.本轮消息数, 1);
      assert.equal(s1.每轮消息上限, 2, '部署覆盖生效（快照冻结）');
      await assert.rejects(
        () => org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '表态', 内容: '五五五五五' }), // 6+5 > 10
        (e) => e instanceof Denied && /每人每轮字符上限/.test(e.rule) && /6\/10/.test(e.message),
        '同一成员本轮累计 + 新内容超限要拒',
      );
      const s2 = await org.council.say({ subject: 乙, 项目: P, id: 开.id, 类型: '表态', 内容: '五五五五五' });
      assert.equal(s2.本轮消息数, 2, '别的成员额度独立');
      await assert.rejects(
        () => org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '答复', 内容: '三' }),
        (e) => e instanceof Denied && /每轮消息上限/.test(e.rule) && /2\/2/.test(e.message),
        '第 3 条撞每轮消息上限',
      );
      const 落 = (await org.bus.readRaw({ 项目: P, 线程: 线程名(开.id) })).filter((m) => m.内容 === '三');
      assert.equal(落.length, 0, '被拒的那条没落线（预算不是纸面读数）');
    } finally { await f.cleanup(); }
  });

  it('预算快照冻结：开启后改部署.json 不影响进行中的讨论', async () => {
    const { f, org } = await 起组织({
      privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 每轮消息上限: 3 } }) },
    });
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id);
      await 开讨论(org, 开.id);
      await writeUnder(f.privateRoot, 部署偏好, JSON.stringify({ 会审讨论: { 每轮消息上限: 1 } }));
      assert.equal(await f.policy.reload(), true, '前提：新值合法，重载成功');
      await org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '表态', 内容: '一' });
      await org.council.say({ subject: 乙, 项目: P, id: 开.id, 类型: '表态', 内容: '二' });
      await org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '答复', 内容: '三' }); // 按快照 3 仍可
      await assert.rejects(
        () => org.council.say({ subject: 乙, 项目: P, id: 开.id, 类型: '表态', 内容: '四' }),
        (e) => e instanceof Denied && /3\/3/.test(e.message),
        '快照是 3：第 4 条才拒（新部署值 1 不追溯）',
      );
    } finally { await f.cleanup(); }
  });

  it('轮次上限：换轮回数到上限后拒并指路收敛', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id);
      await 开讨论(org, 开.id);
      await org.council.round({ subject: LEAD, 项目: P, id: 开.id }); // 1 → 2
      await assert.rejects(
        () => org.council.round({ subject: LEAD, 项目: P, id: 开.id }), // 2 → 3 越过上限 2
        (e) => e instanceof Denied && /轮次上限/.test(e.rule) && /debate_converge/.test(e.howToChange),
        '轮次用尽须收敛',
      );
      assert.equal((await org.council.get(P, 开.id)).轮次, 2, '被拒的换轮不推进');
    } finally { await f.cleanup(); }
  });

  it('本轮发言：名单外不计入、名单内(含 system)计入、边界切轮、漏传名单 fail-closed', () => {
    const 消息 = [
      { 发件: 'member-a', 类型: '表态', 内容: 'a' },
      { 发件: 'member-c', 类型: '分歧', 内容: '外人灌水' },
      { 发件: 'system', 类型: '分歧', 内容: 's' },
    ];
    assert.deepEqual(本轮发言(消息, ['member-a', 'member-b']).map((m) => m.内容), ['a'], '名单外占不死预算');
    assert.deepEqual(本轮发言(消息, ['member-a', 'member-b', 'system']).map((m) => m.内容), ['a', 's'], 'system 在名单内照常计入');
    const 带边界 = [
      { 发件: 'member-a', 类型: '分歧', 内容: '边界之前的不算' },
      { 发件: 'system', 类型: '系统', 内容: `${ROUND_BOUNDARY_MARK} 2` },
      { 发件: 'member-a', 类型: '分歧', 内容: '新轮的' },
    ];
    assert.deepEqual(本轮发言(带边界, ['member-a']).map((m) => m.内容), ['新轮的'], '真边界切轮；边界消息本身不计数');
    assert.throws(
      () => 本轮发言([{ 发件: 'member-a', 类型: '表态', 内容: 'x' }]),
      (e) => e.name === 'InvalidBody' && /名单/.test(e.message),
      '漏传名单会让预算闸静默失效（fail-open）：必须响亮失败',
    );
  });
});

describe('④ 收敛 · 存档 · 零分歧报警', () => {
  it('作答中不得收敛；仅 Lead；被拒的收敛不改状态', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id);
      await assert.rejects(
        () => org.council.converge({ subject: LEAD, 项目: P, id: 开.id }),
        (e) => e instanceof Denied && /未解锁不得收敛/.test(e.rule),
        '先全员交齐并解锁，再收敛',
      );
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      await assert.rejects(
        () => org.council.converge({ subject: MEMBER, 项目: P, id: 开.id }),
        (e) => e instanceof Denied && /仅 Lead/.test(e.rule),
        '收敛是「流程到此为止」的决定',
      );
      assert.equal((await org.council.get(P, 开.id)).状态, '已解锁', '被拒的收敛不改状态');
    } finally { await f.cleanup(); }
  });

  it('分歧清单 = 答案反例面 ∪ 各轮讨论分歧；零分歧报警入账（结论层一致且无例外面）', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id, { 甲反例: ['回滚成本未评估'] });
      await 开讨论(org, 开.id);
      await org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '分歧', 内容: '第一轮分歧' });
      await org.council.round({ subject: LEAD, 项目: P, id: 开.id });
      await org.council.say({ subject: 乙, 项目: P, id: 开.id, 类型: '分歧', 内容: '第二轮分歧' });
      const 收 = await org.council.converge({ subject: LEAD, 项目: P, id: 开.id, 内容: '按 A 案收敛' });
      assert.deepEqual(
        [...收.分歧清单].sort(),
        ['member-a: 第一轮分歧', 'member-a: 回滚成本未评估', 'member-b: 第二轮分歧'].sort(),
        '答案反例面与所有轮次的分歧都要算（收敛清的是全场的账）',
      );
      assert.equal(收.零分歧, false, '有人给反例面 ⇒ 不构成全票一致');
      assert.match(收.零分歧依据, /反例面 存在/);
      const 存档 = await org.council.get(P, 开.id);
      assert.deepEqual(存档.分歧清单, 收.分歧清单);
      assert.equal(存档.结论, '按 A 案收敛');
      assert.equal(存档.状态, '已收敛');
      assert.ok(存档.收敛于, '收敛时间入档');
      const 报警 = (await org.audit.read({})).filter((r) => r.动作 === '零分歧异常' && r.对象?.id === 开.id);
      assert.equal(报警.length, 0, '有分歧时不许报零分歧异常');
    } finally { await f.cleanup(); }
  });

  it('零分歧 = 异常信号：结论层一致且无人给反例面 ⇒ 审计「零分歧异常」+ 存档标记', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id); // 层同为 方案A、无例外面
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      const 收 = await org.council.converge({ subject: LEAD, 项目: P, id: 开.id });
      assert.equal(收.零分歧, true);
      assert.match(收.零分歧依据, /全票一致/);
      const 报警 = (await org.audit.read({})).filter((r) => r.动作 === '零分歧异常' && r.对象?.id === 开.id);
      assert.equal(报警.length, 1, '零分歧报警入账（留 · 条目19）');
      assert.equal(报警[0].档位, '全记');
      assert.equal((await org.council.get(P, 开.id)).零分歧异常, true);
    } finally { await f.cleanup(); }
  });

  it('收敛后状态机冻结：作答 / 发言 / 换轮 / 再收敛全拒；存档六要素齐全', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org, { 问题: '存档六要素' });
      await 双人交齐(org, 开.id, { 甲反例: ['边界未测'] });
      await 开讨论(org, 开.id);
      const 收 = await org.council.converge({ subject: LEAD, 项目: P, id: 开.id });
      const 存档 = 收.会审;

      // 六要素：问题 / 各答案 / 分歧 / 结论 / 来源会话 / 时间。
      assert.equal(存档.问题, '存档六要素');
      assert.equal(存档.答案.length, 2);
      assert.deepEqual(存档.分歧清单, ['member-a: 边界未测']);
      assert.equal(存档.结论, '收敛：会审结束（2 份答案）', '未给收敛内容时的默认结论');
      assert.equal(存档.来源会话, 'lead');
      assert.ok(存档.创建于 && 存档.解锁于 && 存档.收敛于, '创建/解锁/收敛时间齐全');

      await assert.rejects(
        () => org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: '收敛后想改' }),
        (e) => e instanceof Denied && /不再接受作答/.test(e.message),
      );
      await assert.rejects(
        () => org.council.say({ subject: MEMBER, 项目: P, id: 开.id, 类型: '表态', 内容: '还想说' }),
        (e) => e instanceof Denied && /没有开启讨论/.test(e.rule),
        '已收敛后不再接受讨论发言',
      );
      await assert.rejects(
        () => org.council.round({ subject: LEAD, 项目: P, id: 开.id }),
        (e) => e instanceof Denied && /状态机/.test(e.rule),
      );
      await assert.rejects(
        () => org.council.converge({ subject: LEAD, 项目: P, id: 开.id }),
        (e) => e instanceof Denied && /已收敛/.test(e.message),
      );
    } finally { await f.cleanup(); }
  });

  it('工作台会审区 = 新存档形状（id/问题/状态/参与者/答案/分歧清单/结论/零分歧/轮次），无旧字段', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id);
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      await org.council.converge({ subject: LEAD, 项目: P, id: 开.id });

      const wb = await org.workbench({ 项目: P });
      const 行 = wb.会审.find((r) => r.id === 开.id);
      assert.ok(行, '会审存档行要在工作台投影里');
      for (const key of ['id', '问题', '状态', '参与者', '答案', '分歧清单', '结论', '零分歧', '轮次']) {
        assert.ok(key in 行, `存档形状缺字段：${key}`);
      }
      for (const 旧 of ['节点', '揭名', '独立答案', '讨论', '强制反对者', '反例面', '复核三态']) {
        assert.equal(旧 in 行, false, `旧任务图会审字段不许复活：${旧}`);
      }
      assert.equal(行.状态, '已收敛');
      assert.equal(行.轮次, '0/2');
      assert.equal(行.零分歧, true, '零分歧异常照实投影（布尔）');
      assert.deepEqual(行.参与者, ['member-a', 'member-b']);
      assert.equal(行.答案.length, 2);
      assert.equal(行.来源会话, 'lead');
    } finally { await f.cleanup(); }
  });

  it('审计留痕：发起 / 作答 / 解锁 / 讨论开启 / 换轮 / 收敛 各一条（对象=会审 id）', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id);
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      await org.council.round({ subject: LEAD, 项目: P, id: 开.id });   // 讨论开启
      await org.council.round({ subject: LEAD, 项目: P, id: 开.id });   // 会审换轮
      await org.council.converge({ subject: LEAD, 项目: P, id: 开.id });
      const 行 = (await org.audit.read({})).filter((r) => r.对象?.id === 开.id);
      for (const 动作 of ['会审发起', '会审作答', '会审解锁', '讨论开启', '会审换轮', '会审收敛']) {
        assert.ok(行.some((r) => r.动作 === 动作), `审计缺「${动作}」：${JSON.stringify(行.map((r) => r.动作))}`);
      }
      assert.ok(行.filter((r) => r.动作 === '会审作答').length >= 2, '每份作答各留一条');
      const 换轮 = 行.find((r) => r.动作 === '会审换轮');
      assert.equal(换轮.主体?.id, 'lead', '审计主体 = 真实主体 id（不是硬编码）');
    } finally { await f.cleanup(); }
  });

  it('部署.json 会审讨论坏值：加载期 fail-closed（引擎不健康、错误点名键）', async () => {
    const g = await makeFixture({ privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: { 轮次上限: '两' } }) } });
    try {
      assert.equal(g.policy.healthy, false, '坏值不许静默');
      assert.match(String(g.policy.state.error), /会审讨论/, '错误要点名是哪个键');
      assert.match(String(g.policy.state.error), /≥1 的整数/);
    } finally { await g.cleanup(); }
    const g2 = await makeFixture({ privateFiles: { [部署偏好]: JSON.stringify({ 会审讨论: [1, 2] }) } });
    try {
      assert.equal(g2.policy.healthy, false, '非对象形状同样拒');
      assert.match(String(g2.policy.state.error), /会审讨论.*对象/);
    } finally { await g2.cleanup(); }
  });
});

describe('⑤ 直灌闸：会审讨论线程只走 debate_say', () => {
  it('bus_send 往讨论线程直灌 ⇒ 拒且不落线（精确键）；bus_unlock 已退役', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id);
      await 开讨论(org, 开.id);
      const 线程 = 线程名(开.id);
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: LEAD, 主体: MEMBER, args: { action: 'bus_send', 线程, 类型: '交卷', 内容: '绕过 debate_say 直灌' } }),
        (e) => e instanceof Denied
          && /讨论线程的发言只走 debate_say/.test(e.rule)
          && /debate_say/.test(e.howToChange)
          && /预算闸/.test(e.message)
          && e.detail?.入口 === 'bus_send',
        'bus_send 必须与 debate_say 过同一道判据',
      );
      // v2 条目18 补修：旧会审解锁动作整体退役（模型面不存在这只手）。
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: LEAD, 主体: MEMBER, args: { action: 'bus_unlock', id: 开.id, 线程, 内容: '绕过 debate_say 直灌' } }),
        (e) => e instanceof InvalidBody && /未知 action/.test(e.message),
        'bus_unlock 已退役（不是换一条拒绝理由）',
      );
      const 线程消息 = await org.bus.readRaw({ 项目: P, 线程 });
      assert.equal(线程消息.filter((m) => m.内容 === '绕过 debate_say 直灌').length, 0, '被拒的那条没落线');
    } finally { await f.cleanup(); }
  });

  it('大小写别名同一把尺：线程键大小写变体不许绕过（判定键与落线键同源）', async () => {
    const { f, org } = await 起组织();
    try {
      const 开 = await 开会审(org);
      await 双人交齐(org, 开.id);
      await 开讨论(org, 开.id);
      const 别名 = 线程名(开.id).toUpperCase();
      assert.notEqual(别名, 线程名(开.id), '前提：会审 id 里真有大写可变的位置');
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: LEAD, 主体: MEMBER, args: { action: 'bus_send', 线程: 别名, 类型: '交卷', 内容: '别名直灌' } }),
        (e) => e instanceof Denied
          && /讨论线程的发言只走 debate_say/.test(e.rule)
          && /预算闸/.test(e.message),
        'bus_send 的大小写别名必须被同一道判据拦下',
      );
      assert.equal((await org.bus.readRaw({ 项目: P, 线程: 线程名(开.id) })).filter((m) => m.内容 === '别名直灌').length, 0, '别名没落线');
    } finally { await f.cleanup(); }
  });
});

describe('⑥ 动作面接线（模型可达面）', () => {
  it('六个动作进动作表；主体来自 runAction 主体链；参与者可逗号分隔', async () => {
    const f = await makeFixture();
    try {
    const 收到 = [];
    const org = {
      // Lead 自治写要先过钉版闸：用真实 Registry（夹具已建合法 Lead 初态）。
      registry: f.registry,
      council: {
        councilPlan: async () => null,
        open: async (s) => { 收到.push(['open', s]); return {}; },
        answer: async (s) => { 收到.push(['answer', s]); return {}; },
        unlock: async (s) => { 收到.push(['unlock', s]); return {}; },
        say: async (s) => { 收到.push(['say', s]); return {}; },
        round: async (s) => { 收到.push(['round', s]); return {}; },
        converge: async (s) => { 收到.push(['converge', s]); return {}; },
      },
    };
    const 用例 = [
      ['debate_open', { action: 'debate_open', 问题: 'q', 参与者: 'member-a, member-b' }, 'open'],
      ['debate_answer', { action: 'debate_answer', id: 'c-1', 结论: '我的答案', 结论层: '方案A', 反例面: ['x'] }, 'answer'],
      ['debate_unlock', { action: 'debate_unlock', id: 'c-1' }, 'unlock'],
      ['debate_say', { action: 'debate_say', id: 'c-1', 类型: '表态', 内容: 'x' }, 'say'],
      ['debate_round', { action: 'debate_round', id: 'c-1' }, 'round'],
      ['debate_converge', { action: 'debate_converge', id: 'c-1', 内容: '收敛' }, 'converge'],
    ];
    for (const [动作, args, 方法] of 用例) {
      await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args });
      assert.deepEqual(收到.at(-1)[0], 方法, `${动作} 进了对应服务方法`);
      assert.equal(收到.at(-1)[1].subject.kind, 'Lead', `${动作} 主体来自 runAction 主体链`);
    }
    assert.deepEqual(收到[0][1].参与者, ['member-a', 'member-b'], '参与者逗号分隔并去空白');
    await assert.rejects(
      () => runAction({ org, 项目: P, subject: LEAD, 主体: { id: 'ghost', kind: '成员', roleId: '插件工程' }, args: { action: 'debate_open', id: 'c-1', 问题: 'q', 参与者: 'ghost' } }),
      (e) => /身份档案/.test(e.message),
      '未登记实例在进服务前就被主体链拒',
    );
    } finally { await f.cleanup(); }
  });
});

describe('⑧ 旧 W2/㉖ 安全面（四份旧会审测试退役时并入的仍有效判据）', () => {
  it('发件不许自报：bus_send 的 发件=system 被忽略，落线的是主体链真实 id；类型=系统 被写入面拒', async () => {
    const { f, org } = await 起组织();
    try {
      const 线程 = 't-普通-自报';
      await runAction({
        org, 项目: P, subject: LEAD, 主体: MEMBER,
        args: { action: 'bus_send', 线程, 发件: 'system', 类型: '表态', 内容: '冒充系统发件' },
      });
      const 落 = (await org.bus.readRaw({ 项目: P, 线程 })).find((m) => m.内容 === '冒充系统发件');
      assert.ok(落, '消息本身合法 ⇒ 落线');
      assert.equal(落.发件, 'member-a', '自报 发件=system 无效：发件恒为主体链真实 id');
      assert.notEqual(落.发件, 'system', '伪装系统发件不成立（伪造轮边界的第一步被堵）');

      await assert.rejects(
        () => org.bus.send({ subject: MEMBER, 项目: P, 线程, 发件: 'system', 收件: [], 类型: '系统', 内容: '[debate-round] 2' }),
        (e) => e instanceof Denied && /系统类型仅系统主体/.test(e.rule),
        '成员在服务面伪造系统类型 ⇒ 写入面拒（预算洗不掉）',
      );
      assert.equal((await org.bus.readRaw({ 项目: P, 线程 })).filter((m) => m.内容 === '[debate-round] 2').length, 0, '被拒的伪边界没落线');
    } finally { await f.cleanup(); }
  });

  it('㉖ 他人任务线程：非负责人 bus_send 拒、别名同尺；负责人/Lead/普通线程照常放行', async () => {
    const { f, org } = await 起组织();
    try {
      const 节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '㉖ 任务线程', 负责人: ['member-a'], 判据: ['x'] });
      // 非负责人（member-b）往别人的任务线程塞 ⇒ 拒，且不落线。
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: LEAD, 主体: 乙, args: { action: 'bus_send', 线程: 节点.id, 类型: '表态', 内容: '塞别人的任务线程' } }),
        (e) => e instanceof Denied && /任务线程只有负责人与 Lead 可发/.test(e.rule) && /权限矩阵/.test(e.rule),
        '权限矩阵写的是「任何在岗主体写自己线程的消息」：他人任务线程不在授权面',
      );
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: LEAD, 主体: 乙, args: { action: 'bus_send', 线程: 节点.id.toUpperCase(), 类型: '表态', 内容: '大小写旁路' } }),
        (e) => e instanceof Denied && /任务线程只有负责人与 Lead 可发/.test(e.rule),
        '判定键与落线键同源：大小写别名不许绕过',
      );
      assert.equal((await org.bus.readRaw({ 项目: P, 线程: 节点.id })).length, 0, '被拒的两条都没落线');
      // 正对照：负责人自己的线程 / Lead / 普通线程。
      assert.equal((await runAction({ org, 项目: P, subject: LEAD, 主体: MEMBER, args: { action: 'bus_send', 线程: 节点.id, 类型: '表态', 内容: '负责人的发言' } })).消息.线程, 节点.id);
      assert.equal((await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'bus_send', 线程: 节点.id, 类型: '表态', 内容: 'Lead 的派活口径' } })).消息.线程, 节点.id);
      assert.equal((await runAction({ org, 项目: P, subject: LEAD, 主体: 乙, args: { action: 'bus_send', 线程: 't-㉖-普通', 类型: '表态', 内容: '普通线程开放' } })).消息.线程, 't-㉖-普通');
      assert.equal((await org.bus.readRaw({ 项目: P, 线程: 节点.id })).length, 2, '负责人与 Lead 的两条真落线');
    } finally { await f.cleanup(); }
  });
});

describe('⑦ 会审退出任务图 · 旧数据只读', () => {
  it('任务图不再接受「模式」、debate_* 写路径已删除', async () => {
    const { f, org } = await 起组织();
    try {
      const 节点 = await org.tasks.create({
        subject: LEAD, 项目: P, 描述: '模式字段应被忽略', 负责人: ['member-a', 'member-b'],
        判据: ['x'], 模式: '独立会审',
      });
      assert.ok(!('模式' in 节点), 'v2：多人只剩并行分担，模式字段不再存在（不是 null 空壳）');
      assert.equal(typeof org.tasks.debateOpened, 'undefined', '会审写路径已退出任务图');
      assert.equal(typeof org.tasks.debateRounded, 'undefined');
      assert.equal(typeof org.tasks.debateConverged, 'undefined');
    } finally { await f.cleanup(); }
  });

  it('历史 debate_opened 仍 fold 成讨论段；总线投影照旧按「会审讨论段」遮罩', async () => {
    const { f, org } = await 起组织();
    try {
      const 节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '历史讨论段', 负责人: ['member-a', 'member-b'], 判据: ['x'] });
      await appendLines(f.layout.taskLog(P), [{
        seq: 999, at: new Date().toISOString(), by: LEAD, kind: 'debate_opened', id: 节点.id,
        参与者: ['member-a', 'member-b'], 轮次上限: 2, 状态: '讨论中',
      }]);
      const 折 = await org.tasks.get(节点.id, { 项目: P });
      assert.equal(折.讨论?.状态, '讨论中', '旧事件原地只读不迁移，fold 照旧折出');
      // 该线程文件还不存在：直接按纯投影口径造一份（与 workbench 的并集判据同源）。
      const { projectWorkbench } = await import('../src/workbench.js');
      const 纯投影 = projectWorkbench({
        项目: P, 节点: [折], 审计尾: [], 升级挂起: [], 探针: { 结果: [] },
        策略: { healthy: true, 错误: null, 介入度: '放权', 失联: {} },
        线程: [{ 线程: 节点.id, 条数: 1, 未投递: 0, 最新: [{ id: 'm', 发件: 'member-a', 类型: '分歧', 内容: '密文', 状态: '已投递', 追加于: 't' }] }],
        生成于: 't',
      });
      assert.equal(纯投影.消息总线[0].会审讨论段, true, '旧讨论段的线程仍按盲评口径收正文');
      assert.equal(纯投影.消息总线[0].最新, undefined);
      assert.ok(!JSON.stringify(纯投影).includes('密文'));
    } finally { await f.cleanup(); }
  });
});
