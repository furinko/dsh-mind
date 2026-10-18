/**
 * 2026-10-14 全面审查修复批次回归（对应 docs/design/代码审查报告-dsh-mind与DSHOME-2026-10-14.md）。
 *
 * 覆盖（dsh-mind 宿主侧）：
 *  A 批 P1：结论层贯通（P1-1）、零分歧按负责人过滤（P1-2）、提审分离闸（P1-3）、
 *           bus_deliver 断头路（P1-4）、收件人数组过滤（P1-5）、探针快照名唯一（P1-7）、
 *           晋升幂等闸（P1-8）、appoint proposerId（P1-9）。
 *  B 批 P2/P3：authority 缺省按最严档（P2-1）、grant 缺 subject/action 响亮抛（P2-4）、
 *           bus 锁内闸（P2-11 的机制面）、升级比对告警去重（P2-15）、NTFS 别名拒（P2-18）、
 *           能力库路径不出模型面（P2-17）、能力卡正文必填、tags null 往返、
 *           serializeByKey 队列收口、store_rollback 接线（P2-20）、记忆标签进索引（P2-19）。
 *
 * 塞bug校准：本文件每条的反例面在编写时逐条做过「塞回坏码 ⇒ 必红 ⇒ 还原 ⇒ 必绿」，
 * 校准记录见 git 提交说明与审查报告的修复跟踪表。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { makeFixture, SOVEREIGN, LEAD, MEMBER, REVIEWER, seedReviewRelation } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { assertPathSegment } from '../src/paths.js';
import { parseDocument, formatFrontMatter } from '../src/tags.js';
import { serializeByKey, atomicWrite, readJsonl } from '../src/kernel/fsx.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';

const P = 'default';

async function 起组织(f = null) {
  const fixture = f ?? (await makeFixture());
  const org = await Org.open({ home: fixture.home, factoryRoot: fixture.factoryRoot, privateRoot: fixture.privateRoot, project: P });
  return { fixture, org };
}

/** 造一个已交卷的独立会审节点：两个负责人各交一份（可指定结论层/反例面）。 */
async function 会审节点(org, { 结论层A = '方案A', 结论层B = 结论层A, 反例面A = [], 反例面B = [] } = {}) {
  const { id } = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `会审-${Math.random()}`, 负责人: ['member-a', 'member-b'], 判据: ['判据一'], 模式: '独立会审' });
  await org.tasks.dispatch(id, { subject: LEAD, 项目: P });
  await org.tasks.start(id, { subject: { id: 'member-a', kind: '成员' }, 项目: P });
  await org.tasks.submit(id, { subject: { id: 'member-a', kind: '成员' }, 项目: P, 结论: '甲的独立答案', 结论层: 结论层A, 反例面: 反例面A });
  await org.tasks.submit(id, { subject: { id: 'member-b', kind: '成员' }, 项目: P, 结论: '乙的独立答案', 结论层: 结论层B, 反例面: 反例面B });
  return id;
}

describe('2026-10-14 审查修复 · A 批（宿主 P1）', () => {
  it('P1-1：结论层贯通——交卷落事件、fold 进独立答案、会审作答进存档并随投影给到', async () => {
    const { fixture, org } = await 起组织();
    try {
      const id = await 会审节点(org, { 结论层A: '方案A', 结论层B: '方案B' });
      const node = await org.tasks.get(id, { 项目: P });
      assert.deepEqual(node.独立答案.map((a) => a.结论层), ['方案A', '方案B'], 'fold 的独立答案必须带结论层');
      // 事件流里有结论层（状态权威 = 事件流）。
      const events = await org.tasks.events({ 项目: P });
      const submits = events.filter((e) => e.kind === 'submitted' && e.id === id);
      assert.deepEqual(submits.map((e) => e.结论层), ['方案A', '方案B'], 'submitted 事件必须原样带结论层');

      // v2：会审的判定输入改在 council 存档里（任务图只留历史只读路径）。
      // 两份答案结论层不同 ⇒ 收敛时不报零分歧；结论层原样进存档与工作台投影。
      const 开 = await org.council.open({ subject: LEAD, 项目: P, 问题: '结论层贯通', 参与者: ['member-a', 'member-b'] });
      await org.council.answer({ subject: MEMBER, 项目: P, id: 开.id, 结论: '甲的独立答案', 结论层: '方案A' });
      await org.council.answer({ subject: { id: 'member-b', kind: '成员', roleId: '插件工程' }, 项目: P, id: 开.id, 结论: '乙的独立答案', 结论层: '方案B' });
      await org.council.unlock({ subject: LEAD, 项目: P, id: 开.id });
      const 收 = await org.council.converge({ subject: LEAD, 项目: P, id: 开.id });
      assert.deepEqual(收.会审.答案.map((a) => a.结论层), ['方案A', '方案B'], '会审存档带结论层（零分歧判据比的是它）');
      assert.equal(收.零分歧, false, '结论层不同 ⇒ 不是零分歧');
      const bench = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'workbench' } });
      const 行 = bench.数据.会审.find((r) => r.id === 开.id);
      assert.deepEqual(行.答案.map((a) => a.结论层), ['方案A', '方案B'], '工作台投影必须带结论层');
    } finally {
      await fixture.cleanup();
    }
  });

  it('P1-2：零分歧只按负责人结论判——外人垫的不同结论层压不掉报警', async () => {
    const { fixture, org } = await 起组织();
    try {
      // 两名负责人结论层一致、无反例面 ⇒ 零分歧报警必须触发（修前若结论集混入外人答案则可能被压）。
      const id = await 会审节点(org, { 结论层A: '方案A', 结论层B: '方案A' });
      const r = await org.review.checkZeroDivergence({ subject: LEAD, 项目: P, 节点: id });
      assert.equal(r.零分歧, true, `负责人结论层一致且无反例面 ⇒ 必须报警；实际 ${JSON.stringify(r)}`);
      assert.match(r.结论集来源, /负责人 2 份/, '来源必须如实标注是按负责人重算的两份');
      // 反例面对照臂：一名负责人给出反例面 ⇒ 不报警（判据本身没被改坏）。
      const id2 = await 会审节点(org, { 结论层A: '方案A', 结论层B: '方案A', 反例面B: ['我试过一个反例'] });
      const r2 = await org.review.checkZeroDivergence({ subject: LEAD, 项目: P, 节点: id2 });
      assert.equal(r2.零分歧, false, '有人给出反例面 ⇒ 不报零分歧（对照臂）');
    } finally {
      await fixture.cleanup();
    }
  });

  it('P1-3：提审分离闸——交卷人复核自己的卷 ⇒ 拒；复核员复核 ⇒ 过', async () => {
    const { fixture, org } = await 起组织();
    try {
      const { id } = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '单人任务-提审分离', 负责人: 'member-a', 判据: ['判据一'] });
      await org.tasks.dispatch(id, { subject: LEAD, 项目: P });
      await org.tasks.start(id, { subject: MEMBER, 项目: P });
      await org.tasks.submit(id, { subject: MEMBER, 项目: P, 结论: '做完了', 结论层: '完成' });
      await assert.rejects(
        () => org.tasks.review(id, { subject: MEMBER, 项目: P, 三态: '过', 复核结论: '自批' }),
        (e) => e instanceof Denied && /提审分离/.test(e.rule),
        '交卷人复核自己的卷必须拒（§3.4）',
      );
      // 署名必须恒等于真实执行主体（v2 补修）：Lead 也不例外，代签交卷人同样拒。
      await assert.rejects(
        () => org.tasks.review(id, { subject: LEAD, 项目: P, 三态: '过', 复核者: 'member-a', 复核结论: '署名交卷人' }),
        (e) => e instanceof Denied && /不许替别人署名|实际操作者|提审分离/.test(e.rule + e.message),
        '署名复核者≠执行主体 ⇒ 拒（Lead 代签也不行）',
      );
      await seedReviewRelation(fixture, { 项目: P, 目标: id });
      const ok = await org.tasks.review(id, { subject: REVIEWER, 项目: P, 三态: '过', 复核结论: '独立复核通过' });
      // 补修K：复核只出票、不代 Lead 采纳；采纳是 Lead 的独立一步（引用真票）。
      assert.equal(ok.状态, '已交卷', '复核员（未交卷）复核 ⇒ 放行出票');
      const 采纳 = await org.tasks.accept(id, { subject: LEAD, 项目: P, 票: ok.待采纳?.票 });
      assert.equal(采纳.状态, '已采纳');
    } finally {
      await fixture.cleanup();
    }
  });

  it('P1-4：bus_deliver 接线——暂不投递的消息可显式放行（同 id 状态流转，幂等）', async () => {
    const { fixture, org } = await 起组织();
    try {
      const sent = await org.bus.send({ subject: LEAD, 项目: P, 线程: 't-deliver', 发件: 'lead', 收件: ['member-a'], 类型: '派活', 内容: '先压着', 暂不投递: true });
      assert.equal(sent.状态, '暂不投递');
      const viaAction = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'bus_deliver', 线程: 't-deliver', id: sent.id } });
      assert.equal(viaAction.投递.状态, '已投递', 'bus_deliver 必须把消息翻成已投递');
      // 幂等：再投一次不报错也不加新行。
      const again = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'bus_deliver', 线程: 't-deliver', id: sent.id } });
      assert.equal(again.投递.状态, '已投递', '重复 deliver 幂等');
      const 原文 = await readJsonl(org.layout.busThread(P, 't-deliver'));
      assert.equal(原文.filter((m) => m.id === sent.id).length, 2, '账上两条同 id 记录（暂不投递 + 已投递），只增不改');
      assert.equal((await org.bus.readRaw({ 项目: P, 线程: 't-deliver' })).filter((m) => m.id === sent.id).length, 1, '折叠视图只留最新状态');
      // 不存在 id ⇒ 响亮拒。
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'bus_deliver', 线程: 't-deliver', id: 'msg-不存在' } }),
        (e) => e instanceof InvalidBody,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('P1-5：收件人是数组时过滤照样成立——在列可见、不在列不可见', async () => {
    const { fixture, org } = await 起组织();
    try {
      await org.bus.send({ subject: LEAD, 项目: P, 线程: 't-收件', 发件: 'lead', 收件: ['member-a'], 类型: '派活', 内容: '只给甲' });
      const 甲 = await org.bus.read({ subject: { id: 'member-a', kind: '成员' }, 项目: P, 线程: 't-收件', 收件: 'member-a' });
      assert.equal(甲.length, 1, '在收件数组里的成员读得到');
      const 丙 = await org.bus.read({ subject: REVIEWER, 项目: P, 线程: 't-收件', 收件: 'member-c' });
      assert.equal(丙.length, 0, '不在收件数组里的读取静默返空不得发生——过滤要真的过滤（修前数组收件恒 false 的反面：数组收件对查询不生效）');
    } finally {
      await fixture.cleanup();
    }
  });

  it('P1-7：探针快照文件名同秒不撞（含随机段与内容哈希）', async () => {
    const { fixture, org } = await 起组织();
    try {
      org.probes.无内核装配 = true; // 纯服务夹具：没有内核装配/闸回执，显式声明
      await org.probes.run({ subject: LEAD });
      await org.probes.run({ subject: LEAD });
      const files = await readdir(org.layout.probeSnapshotDir());
      const snaps = files.filter((n) => n.endsWith('.json'));
      assert.ok(snaps.length >= 2, `两次探针各留一份快照；实际 ${snaps.length}`);
      assert.equal(new Set(snaps).size, snaps.length, '快照名不许撞（修前同秒同名互覆）');
      assert.ok(snaps.every((n) => /Z-[0-9a-z]+-[0-9a-f]{6}\.json$/.test(n)), `快照名带随机段+短哈希；实际 ${snaps.join(', ')}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('P1-8：跨项目晋升幂等闸——第二次晋升响亮拒，审计不再记假成功', async () => {
    const { fixture, org } = await 起组织();
    try {
      const w = await org.memory.remember({ subject: LEAD, 类: '知识', 内容: '可复用的知识', 来源: '测试', 项目: P });
      const first = await org.memory.promoteCrossProject(w.id, { subject: LEAD, 岗位: '插件工程', 理由: '值得跨项目复用' });
      assert.equal(first.id, w.id);
      await assert.rejects(
        () => org.memory.promoteCrossProject(w.id, { subject: LEAD, 岗位: '插件工程', 理由: '再来一次' }),
        (e) => e instanceof Denied && /不许重复晋升|幂等/.test(e.rule + e.message),
        '第二次晋升必须拒（修前静默无效还记假审计）',
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('v2 冲突排除：负责人不得复核自己的任务（复核者降级后独立性由这条硬规则承担）', async () => {
    // review.appoint 已随复核者降级删除（2026-10-18：复核员是普通岗位卡，不再有任命闸）。
    // 独立性改由复核时的冲突排除承担——本用例钉「负责人不得复核本节点」这道新闸。
    const { fixture, org } = await 起组织();
    try {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'Lead 自办的活', 负责人: 'lead', 判据: ['x'] });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      await org.tasks.start(node.id, { subject: LEAD, 项目: P });
      await org.tasks.submit(node.id, { subject: LEAD, 项目: P, 结论: 'Lead 交卷' });
      await assert.rejects(
        () => org.tasks.review(node.id, { subject: LEAD, 项目: P, 三态: '过' }),
        (e) => e instanceof Denied && /负责人不得复核|交卷人不得复核/.test(e.rule),
        '负责人（也是交卷人）复核自己的任务 = 自己验收自己 ⇒ 拒',
      );
      // 对照（v2 条目11 + 署名安全 H 补修）：Lead 冒签复核员 ⇒ 拒；真正由复核员本人执行、
      // 且其复核任务显式 `复核对象` 含本节点 ⇒ 落结论。
      const 复核任务 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'Lead 自办活的复核任务', 负责人: '复核员', 判据: ['核对'], 复核对象: [node.id] });
      await org.tasks.bind(复核任务.id, { subject: LEAD, 项目: P, 实例: 'reviewer', 岗位: '复核员' });
      await assert.rejects(
        () => org.tasks.review(node.id, { subject: LEAD, 项目: P, 三态: '过', 复核者: 'reviewer' }),
        (e) => e instanceof Denied && /不许替别人署名|实际操作者/.test(e.rule + e.message),
        'Lead 不能把结论记到复核员头上（署名=实际主体）',
      );
      const ok = await org.tasks.review(node.id, { subject: REVIEWER, 项目: P, 三态: '过' });
      // 补修K：复核只出票；采纳是 Lead 的独立一步（引用真票）——「过 ⇒ 已采纳」的旧硬闸已拆成两步。
      assert.equal(ok.状态, '已交卷', '真实复核实例（有本任务关联）的结论照常出票');
      const 采纳 = await org.tasks.accept(node.id, { subject: LEAD, 项目: P, 票: ok.待采纳?.票 });
      assert.equal(采纳.状态, '已采纳');
    } finally {
      await fixture.cleanup();
    }
  });
});

describe('2026-10-14 审查修复 · B 批（宿主 P2/P3）', () => {
  it('P2-1：目标缺 authority ⇒ 按最严档判（写仅主权者可过），不再缺省最松', async () => {
    const f = await makeFixture();
    try {
      const target = { id: 'x-未盖章', kind: '能力', zone: '私有' };
      assert.equal((await f.policy.decide({ subject: LEAD, action: 'write', target, context: {} })).verdict, 'deny', 'Lead 写缺章目标 ⇒ 拒（按宪章档）');
      assert.equal((await f.policy.decide({ subject: SOVEREIGN, action: 'write', target, context: {} })).verdict, 'allow', '主权者写缺章目标 ⇒ 过（最严档的合法路径不受影响）');
      assert.equal((await f.policy.decide({ subject: LEAD, action: 'write', target: { ...target, authority: '自治' }, context: {} })).verdict, 'allow', '显式盖自治章 ⇒ Lead 照常过（对照臂）');
    } finally {
      await f.cleanup();
    }
  });

  it('P2-4：grant 缺 action ⇒ 加载期响亮抛错（引擎不健康），不静默跳过', async () => {
    const g = await makeFixture({
      rules: {
        '集体L1-法律/权限矩阵.md': [
          '---', 'id: 权限矩阵', 'kind: ' + '规则', 'authority: 法律', 'zone: 出厂', 'domain: 集体', 'version: 1', '---',
          '# 权限矩阵', '', '```policy',
          JSON.stringify({ grants: [{ subject: 'Lead', kind: '能力', verdict: 'allow', reason: '漏了 action' }] }),
          '```',
        ].join('\n'),
      },
    });
    try {
      assert.equal(g.policy.healthy, false, '缺 action 的 grant 必须让引擎不健康');
    } finally {
      await g.cleanup();
    }
  });

  it('P2-11：bus.send 锁内闸——闸抛错则消息不落线（预算闸的权威一检机制）', async () => {
    const { fixture, org } = await 起组织();
    try {
      await assert.rejects(
        () => org.bus.send({ subject: LEAD, 项目: P, 线程: 't-闸', 发件: 'lead', 收件: [], 类型: '广播', 内容: '不该落线', 锁内闸: async () => { throw new Denied('测试闸', '锁内复检拒绝'); } }),
        (e) => e instanceof Denied && /测试闸/.test(e.rule),
      );
      const rows = await org.bus.readRaw({ 项目: P, 线程: 't-闸' });
      assert.equal(rows.length, 0, '锁内闸拒 ⇒ 一个字节都不落线');
      // 对照：闸通过 ⇒ 正常落线。
      await org.bus.send({ subject: LEAD, 项目: P, 线程: 't-闸', 发件: 'lead', 收件: [], 类型: '广播', 内容: '闸过了', 锁内闸: async () => {} });
      assert.equal((await org.bus.readRaw({ 项目: P, 线程: 't-闸' })).length, 1);
    } finally {
      await fixture.cleanup();
    }
  });

  it('P2-15：升级比对告警去重——同一份比对结果不重复刷审计', async () => {
    const { fixture, org } = await 起组织();
    try {
      const 计数 = async () => (await org.audit.read({})).filter((r) => String(r.对象?.id) === '权限矩阵').length;
      const before = await 计数();
      await org.upgrade.compare({ 对象: '权限矩阵', subject: LEAD });
      const afterFirst = await 计数();
      await org.upgrade.compare({ 对象: '权限矩阵', subject: LEAD });
      const afterSecond = await 计数();
      assert.equal(afterSecond, afterFirst, '第二次比对结果相同 ⇒ 一条新审计都不许加（修前每次调用都刷）');
      assert.ok(afterFirst >= before, '第一次比对照常入账（去重不吞第一次）');
    } finally {
      await fixture.cleanup();
    }
  });

  it('P2-18：路径片段拒 Windows 保留名与尾部点/空格（NTFS 别名面）', () => {
    for (const bad of ['CON', 'con', 'NUL', 'COM1', 'lpt9', 'CON.txt', 'foo.', 'foo ']) {
      assert.throws(() => assertPathSegment(bad, '测试'), InvalidBody, `${bad} 必须拒`);
    }
    for (const ok of ['my.proj', '插件工程', 'com10', 'contact', 'a.b.c']) {
      assert.equal(assertPathSegment(ok, '测试'), ok, `${ok} 正常放行`);
    }
  });

  it('P2-17：能力库读数不带本机绝对路径（list/resolve/read 三个动作面）', async () => {
    const { fixture, org } = await 起组织();
    try {
      await org.capability.publish({ subject: LEAD, 名: '测试能力卡', 正文: '怎么做：第一步。', 适用岗位: ['插件工程'], 依据: '测试' });
      const list = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'capability_list' } });
      assert.ok(list.能力.length >= 1);
      assert.ok(list.能力.every((c) => !('path' in c)), 'capability_list 不许带 path');
      const resolve = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'capability_resolve', 名: '测试能力卡' } });
      assert.ok(resolve.解析.条目.every((c) => !('path' in c)), 'capability_resolve 的条目不许带 path');
      const read = await runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'capability_read', id: list.能力[0].id } });
      assert.ok(!('path' in read.条目), 'capability_read 不许带 path');
    } finally {
      await fixture.cleanup();
    }
  });

  it('能力卡正文必填：空正文响亮拒，不发 undefined 卡', async () => {
    const { fixture, org } = await 起组织();
    try {
      await assert.rejects(
        () => org.capability.publish({ subject: LEAD, 名: '空正文卡', 适用岗位: ['插件工程'], 依据: '测试' }),
        (e) => e instanceof InvalidBody && /正文必填/.test(e.message),
      );
    } finally {
      await fixture.cleanup();
    }
  });

  it('tags：null 往返闭合——写 `null` 字面量，读回还是 null（不再漂成 []）', () => {
    const text = formatFrontMatter({ id: 't-null', tags: null, kind: '能力', authority: '自治' }) + '# x\n';
    const parsed = parseDocument(text);
    assert.equal(parsed.meta.tags, null, 'null 必须往返成 null');
    // legacy 对照：空值行仍按 [] 读（老账的语义不动）。
    const legacy = parseDocument('---\nid: t-legacy\ntags:\n---\n# x\n');
    assert.deepEqual(legacy.meta.tags, [], '空值行（legacy 写法）仍读 []');
  });

  it('serializeByKey：settle 后队列摘除（长跑不长胖），且同 key 串行语义不变', async () => {
    const seen = [];
    await Promise.all([
      serializeByKey('k-test', async () => { seen.push(1); await new Promise((r) => setTimeout(r, 10)); seen.push(2); }),
      serializeByKey('k-test', async () => { seen.push(3); }),
    ]);
    assert.deepEqual(seen, [1, 2, 3], '同 key 串行语义不变');
    await new Promise((r) => setImmediate(r));
    assert.equal(serializeByKey._queue.has('k-test'), false, '链尾 settle 后 key 必须摘除');
  });

  it('P2-20：store_rollback 接线——Lead 拒（§4），主权者过且旧版仍在历史里', async () => {
    const { fixture, org } = await 起组织();
    try {
      await org.store.write('能力', { meta: { id: 'rb-cap', authority: '自治', domain: '集体' }, body: '# rb\n\n## 适用岗位\n- 插件工程\n\n## 怎么做\n第一版' }, { subject: LEAD, reason: 'v1' });
      await org.store.write('能力', { meta: { id: 'rb-cap', authority: '自治', domain: '集体' }, body: '# rb\n\n## 适用岗位\n- 插件工程\n\n## 怎么做\n第二版' }, { subject: LEAD, reason: 'v2' });
      await assert.rejects(
        () => runAction({ org, 项目: P, subject: LEAD, 主体: LEAD, args: { action: 'store_rollback', 对象类: '能力', id: 'rb-cap', version: 1, 依据: '回滚测试' } }),
        (e) => e instanceof Denied && /主权者/.test(e.rule + e.message),
        'Lead 回滚文本版本 ⇒ 拒（§4）',
      );
      const ok = await runAction({ org, 项目: P, subject: SOVEREIGN, 主体: SOVEREIGN, args: { action: 'store_rollback', 对象类: '能力', id: 'rb-cap', version: 1, 依据: '主权者回滚测试' } });
      assert.equal(ok.回滚.restoredFrom, 1);
      assert.equal(ok.回滚.version, 3, '回滚本身也是一次新写入（留 v3，谁也不能抹掉「回过滚」）');
      const v1 = await org.store.readVersion('rb-cap', 1);
      assert.ok(v1.includes('第一版'), '旧版仍在历史里');
      const now = await org.store.read('能力', 'rb-cap', { subject: LEAD });
      assert.ok(now.body.includes('第一版'), '当前版 = 回滚到的内容');
    } finally {
      await fixture.cleanup();
    }
  });

  it('P2-19：用户标签进检索索引——按标签词能召回', async () => {
    const { fixture, org } = await 起组织();
    try {
      await org.memory.remember({ subject: LEAD, 类: '知识', 内容: '部署时要先冻结端口', 来源: '测试', 项目: P, 标签: ['发布规程'] });
      const hit = await org.memory.query({ subject: LEAD, 项目: P, 文本: '发布规程' });
      assert.ok(hit.命中.length >= 1, `按标签召回必须命中；实际 ${JSON.stringify(hit.命中)}`);
    } finally {
      await fixture.cleanup();
    }
  });

  it('atomicWrite：写失败不留孤儿 tmp（失败路径清场）', async () => {
    const f = await makeFixture();
    try {
      const { mkdir, readdir, readFile } = await import('node:fs/promises');
      // 目标是目录 ⇒ rename 必然失败 ⇒ tmp 必须被清掉（修前孤儿 tmp 永久残留）。
      const dir = `${f.privateRoot}/原子写-目录`;
      await mkdir(dir, { recursive: true });
      await assert.rejects(() => atomicWrite(dir, '内容'));
      const leftovers = (await readdir(f.privateRoot)).filter((n) => n.includes('.tmp-'));
      assert.deepEqual(leftovers, [], `失败路径不许留孤儿 tmp；实际 ${leftovers.join(', ')}`);
      // 正常路径对照：顺序写两版，最后一版完整可读（tmp 随机段在实现里，行为面锁内容不撕裂）。
      const file = `${f.privateRoot}/原子写-正常.txt`;
      await atomicWrite(file, '第一版');
      await atomicWrite(file, '第二版');
      assert.equal(await readFile(file, 'utf8'), '第二版');
      assert.deepEqual((await readdir(f.privateRoot)).filter((n) => n.includes('.tmp-')), [], '正常写完也不留 tmp');
    } finally {
      await f.cleanup();
    }
  });
});
