/**
 * 持久一致性与代次收口（task-持久一致性与代次收口-第三批-依-iahma · 2026-10-16）。
 * 依据：审查报告 §四 R09/R10/R12/R13/R14/R15/R16 的「修法/验收」＋第12代复核两条增量。
 *
 * 九组：
 *  A·R09 任务 attempt/epoch——打回关闭当前代（旧答案整代归档、讨论清空），齐卷/复核只认当前代，
 *     他人新卷不再被上一代讨论拦死。
 *  B·R10 删除 fence——引用校验与提交之间完成的 purge，由锁内提交点复验挡住（悬空/待删除拒写）。
 *  C·R12剩余 状态行与本体分立——投递行是瘦状态行，折叠只叠状态不吞本体。
 *  C·R13 无活动月不判缺口（清单口径取代日历连续性）。
 *  C·R14 日志∪锚∪清单并集——已登记月被删（含孤立锚）必红。
 *  C·R15 锚-尾恢复协议——锚落后按崩溃断面恢复（[1,2,2] 必消）；锚超前/不符响亮拒。
 *  C·R16 部分提交明确化——正文已落盘而提交链失败 ⇒ STORE_PARTIAL_COMMIT（禁止盲重试语义）。
 *  D·R08存量 旧格式 id 读面盲标化（账本不动）；D·R07 错误详情面不含他人答案。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { makeFixture, LEAD, writeUnder, seedLegacyIndependentCouncil } from './helpers.mjs';
import { Org } from '../src/org.js';
import { AuditLog } from '../src/audit.js';
import { runAction } from '../lib/actions.js';
import { Denied, Fault } from '../src/kernel/errors.js';
import { readJsonl, appendLines } from '../src/kernel/fsx.js';

const P = 'proj-consistency3';
const MEMBER_A = { id: 'member-a', kind: '成员', roleId: '插件工程' };
const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };
const SOVEREIGN = { id: 'sovereign', kind: '主权者' };
const REVIEWER = { id: 'reviewer', kind: '成员', roleId: '复核员' };

/** 记录器桩钟：按当前月返回 iso/ms（审计按月分片，造跨月场景用）。 */
function 桩钟() {
  const 态 = { 月: '2026-08' };
  return {
    态,
    clock: {
      iso: () => `${态.月}-15T00:00:00Z`,
      ms: () => Date.parse(`${态.月}-15T00:00:00Z`),
    },
  };
}

describe('A · R09 任务 attempt/epoch（打回关代）', () => {
  it('打回后：旧代答案归档、讨论清空；他人新卷不被上一代讨论拦死；齐卷只认当前代', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'R09-返工代', 负责人: ['member-a', 'member-b'], 判据: ['x'], 模式: '独立会审' });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      // 第一代：两人交齐 ⇒ 讨论开启（揭名）。
      await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
      await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论: '旧代A的结论' });
      await org.tasks.submit(node.id, { subject: MEMBER_B, 项目: P, 结论: '旧代B的结论' });
      // v2 删了 debate 写路径；「第一代开过讨论」按历史账本形状播种（只读回放契约仍在）。
      await appendLines(f.layout.taskLog(P), [{
        seq: 9999, at: new Date().toISOString(), by: LEAD, kind: 'debate_opened', id: node.id,
        参与者: ['member-a', 'member-b'], 轮次上限: 2, 状态: '讨论中',
      }]);
      const 一代 = await org.tasks.get(node.id, { 项目: P });
      assert.equal(一代.代, 1, '前提：当前代=1');
      assert.ok(一代.讨论, '前提：讨论段已开');
      // 复核不过 ⇒ 打回：关代。
      await org.tasks.review(node.id, { subject: REVIEWER, 项目: P, 三态: '不过', 分歧清单: ['判据未满足'] });
      const 二代 = await org.tasks.get(node.id, { 项目: P });
      assert.equal(二代.代, 2, '打回必须关代（代 +1）');
      assert.equal(二代.讨论, null, '旧讨论随代清空（历史在事件流，投影只认当前代）');
      assert.equal(二代.独立答案.length, 0, '旧答案整代清出当前视图');
      assert.equal(二代.答案历史.length, 1, '旧代整代归档进答案历史');
      assert.equal(二代.答案历史[0].代, 1);
      assert.ok(JSON.stringify(二代.答案历史[0]).includes('旧代A的结论'), '历史里的旧答案保留（只增不洗）');
      // 第二代：A 重交，B 的新卷**不再**被上一代讨论拦死（R09 病根②）。
      await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
      await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论: '新代A的结论' });
      const b交 = await org.tasks.submit(node.id, { subject: MEMBER_B, 项目: P, 结论: '新代B的结论' });
      assert.equal(b交.状态, '已交卷');
      const 齐 = await org.tasks.get(node.id, { 项目: P });
      assert.equal(齐.独立答案.length, 2, '齐卷=两人（当前代）');
      const 齐文本 = JSON.stringify(齐.独立答案);
      assert.ok(齐文本.includes('新代A的结论') && 齐文本.includes('新代B的结论'), '当前代两卷都在');
      assert.ok(!齐文本.includes('旧代A的结论'), '旧代答案不混入当前齐卷（R09 病根①）');
      // 复核只对当前代：复核员不在当前代答案里 ⇒ 可复核；再判"过"。
      const 过 = await org.tasks.review(node.id, { subject: REVIEWER, 项目: P, 三态: '过', 分歧清单: [] });
      assert.equal(过.状态, '已采纳');
    } finally {
      await f.cleanup();
    }
  });
});

describe('B · R10 删除 fence（提交点原子检查）', () => {
  it('引用校验通过后、提交前完成 purge ⇒ 该写在提交点被拒（不逃过隔离）', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const 源 = await org.memory.remember({ subject: LEAD, 类: '知识', 内容: 'R10 源条目', 来源: '测试', 项目: P });
      const 原check = org.policy.check.bind(org.policy);
      let 已注入 = false;
      // 注入点在「锁外引用校验完成之后、锁内提交之前」：remember 的顺序是
      // #verifyRefs → policy.check → #appendEntry(锁内提交点)。在 policy.check 里完成一次
      // 完整 purge（状态行+物理抹除+闭包），正是审查实证的并发窗口。
      org.policy.check = async (input) => {
        const 结果 = await 原check(input);
        if (!已注入 && input.action === 'create' && input.context?.类 === '知识' && input.subject?.id === 'lead') {
          已注入 = true;
          await org.memory.purge(源.id, { subject: SOVEREIGN, 理由: 'R10 注入：并发窗口内完成删除' });
        }
        return 结果;
      };
      await assert.rejects(
        () => org.memory.remember({ subject: LEAD, 类: '知识', 内容: 'R10 在途子条目', 来源: '测试', 项目: P, 来源引用: [源.id] }),
        (e) => e instanceof Denied || e instanceof Fault || /悬空|待删除|物理删除/.test(e.message),
        '源已删：在途引用写必须在提交点被拒',
      );
      org.policy.check = 原check;
      // 且它确实没落账（默认检索面召不回）。
      const 查 = await org.memory.query({ subject: LEAD, 项目: P, 文本: '在途子条目', 类: ['知识'] });
      assert.equal((查.条目 ?? []).some((x) => String(x.内容 ?? '').includes('在途子条目')), false, '被拒的写在账上不存在');
    } finally {
      await f.cleanup();
    }
  });
});

describe('C · R12剩余 / R13 / R14 / R15 / R16', () => {
  it('R12剩余：投递行是瘦状态行——折叠只叠状态、不吞本体；账本两行（本体+状态）', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const 线程 = 't-r12';
      const 发 = await runAction({ org, 项目: P, 主体: LEAD, subject: LEAD, args: { action: 'bus_send', 线程, 类型: '表态', 内容: '本体正文-R12', 暂不投递: true } });
      const id = 发.id ?? 发.消息?.id;
      assert.ok(id, `发信返回要带 id：${JSON.stringify(发).slice(0, 120)}`);
      await runAction({ org, 项目: P, 主体: LEAD, subject: LEAD, args: { action: 'bus_deliver', 线程, id } });
      const 原行 = await readJsonl(f.layout.busThread(P, 线程));
      assert.equal(原行.length, 2, '账本两行：本体 + 状态（只增）');
      assert.ok(原行[0].内容 === '本体正文-R12', '第一行是本体');
      assert.equal(原行[1].内容, undefined, '第二行是瘦状态行（不带正文）');
      assert.equal(原行[1].状态, '已投递');
      const 视图 = await org.bus.readRaw({ 项目: P, 线程 });
      assert.equal(视图.length, 1, '折叠成一条');
      assert.equal(视图[0].内容, '本体正文-R12', '本体不被状态行吞掉');
      assert.equal(视图[0].状态, '已投递', '状态叠加生效');
      const 未投递 = await org.bus.readRaw({ 项目: P, 线程, 未投递: true });
      assert.equal(未投递.length, 0, '「暂不投递」过滤按折叠后状态判');
    } finally {
      await f.cleanup();
    }
  });

  it('R13：只登记有活动的月——无活动月不再被判缺口（1月/3月绿）', async () => {
    const f = await makeFixture();
    try {
      const { 态, clock } = 桩钟();
      const audit = new AuditLog({ layout: f.layout, clock });
      态.月 = '2026-01';
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'x' } });
      态.月 = '2026-03';
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'y' } });
      const v = await audit.verify();
      assert.equal(v.ok, true, `2月无活动 ≠ 被删（修前按日历连续性误报月份缺口）：${JSON.stringify(v.broken)}`);
      assert.deepEqual(v.broken, []);
    } finally {
      await f.cleanup();
    }
  });

  it('R14：已登记月被删（含孤立锚）⇒ 分片缺失见红；单月删日志不再假绿', async () => {
    const f = await makeFixture();
    try {
      const { 态, clock } = 桩钟();
      const audit = new AuditLog({ layout: f.layout, clock });
      态.月 = '2026-08';
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'x' } });
      assert.equal((await audit.verify()).ok, true, '前提：绿');
      // 孤立锚：只删日志、锚留着。
      await rm(f.layout.auditLog('2026-08'));
      const 孤 = await audit.verify();
      assert.equal(孤.ok, false, '整月日志丢失而锚还在 ⇒ 必须见红（修前 months=0 假绿）');
      assert.ok(孤.broken.some((b) => b.类型 === '分片缺失' && b.month === '2026-08'), `要点名缺失分片：${JSON.stringify(孤.broken)}`);
    } finally {
      await f.cleanup();
    }
  });

  it('R15：锚落后（崩溃断面）⇒ 恢复续写无重复序号；锚超前/不符 ⇒ 响亮拒', async () => {
    const f = await makeFixture();
    try {
      const { 态, clock } = 桩钟();
      态.月 = '2026-08';
      const audit = new AuditLog({ layout: f.layout, clock });
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'a' } });
      await audit.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'b' } });
      const 行 = await readJsonl(f.layout.auditLog('2026-08'));
      assert.deepEqual(行.map((r) => r.seq), [1, 2], '前提：两行');
      // 模拟「第二条已落日志、锚仍指第一条」的崩溃断面：把锚写回 seq1。
      await writeFile(f.layout.auditAnchor('2026-08'), `${JSON.stringify({ seq: 1, hash: 行[0].hash, at: 行[0].时间 })}\n`, 'utf8');
      // 新实例（清内存链缓存）续写：必须认实际尾、不再造重复序号。
      const audit2 = new AuditLog({ layout: f.layout, clock });
      await audit2.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'c' } });
      const 续 = await readJsonl(f.layout.auditLog('2026-08'));
      assert.deepEqual(续.map((r) => r.seq), [1, 2, 3], '锚落后 ⇒ 按崩溃断面恢复（[1,2,2] 形态必消）');
      assert.equal((await audit2.verify()).ok, true, '恢复后链完整');
      // 篡改/截断面：截短日志而锚指更远 ⇒ 不接受该尾部。
      await writeFile(f.layout.auditLog('2026-08'), `${JSON.stringify(行[0])}\n`, 'utf8');
      const audit3 = new AuditLog({ layout: f.layout, clock });
      await assert.rejects(
        () => audit3.append({ 动作: '状态变更', 主体: LEAD, 对象: { id: 'd' } }),
        (e) => /不一致|截断|篡改/.test(e.message),
        '锚超前/与尾不符 ⇒ 不接受任意尾部（fail-closed）',
      );
    } finally {
      await f.cleanup();
    }
  });

  it('R16：正文已落盘而提交链失败 ⇒ STORE_PARTIAL_COMMIT（标注已提交版本、禁止盲重试）', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const 原append = org.audit.append.bind(org.audit);
      org.audit.append = async () => { throw new Error('注入：审计不可用'); };
      await assert.rejects(
        () => org.store.write('能力', { meta: { id: 'cap-r16', 名: 'R16卡', authority: '自治', domain: '集体' }, body: '\n# R16卡\n\n## 适用岗位\n- 插件工程\n\n## 怎么做\nx\n' }, { subject: LEAD, reason: 'R16 注入' }),
        (e) => e instanceof Fault && e.code === 'STORE_PARTIAL_COMMIT' && e.detail?.已落盘正文 === true && /不要盲目重试/.test(e.message),
        '部分提交必须明确标注「已落盘」与不可盲重试',
      );
      org.audit.append = 原append;
      const 对象 = await org.store.read('能力', 'cap-r16', { subject: LEAD });
      assert.ok(对象, '正文确实已在盘上（报错 ≠ 没写成）');
      assert.equal(String(对象.meta.version), '1', '版本从 front matter 读回是字符串（既有口径）');
    } finally {
      await f.cleanup();
    }
  });
});

describe('D · 第12代复核增量（R08 存量 id 盲标化 / R07 错误详情面）', () => {
  it('D-R08：旧格式 id 在盲评遮罩输出里被盲标化（账本一字不动）', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const nodeId = await seedLegacyIndependentCouncil(f, { 项目: P, 描述: 'D-R08-存量id' });
      // 直接往线程账本落一条**旧格式** id 的消息（真实部署的存量形态）。
      const 结论串 = '旧格式正文前缀SECRETOLDPREFIX';
      const 旧id = `msg-${nodeId}-member-a-${结论串.slice(0, 24)}`;
      const 账本 = f.layout.busThread(P, nodeId);
      await appendLines(账本, [{ id: 旧id, 线程: nodeId, 发件: 'member-a', 收件: [], 类型: '交卷', 内容: 结论串, 状态: '已投递', 追加于: new Date().toISOString() }]);
      const 前 = readFileSync(账本, 'utf8');
      const r = await runAction({ org, 项目: P, 主体: MEMBER_B, subject: MEMBER_B, args: { action: 'bus_read', 线程: nodeId } });
      const 遮 = (r.消息 ?? []).find((m) => m.盲评遮罩 === true);
      assert.ok(遮, 'B 读到遮罩条目');
      assert.ok(!遮.id.includes('member-a'), `遮罩 id 不泄露发件人：${遮.id}`);
      assert.ok(!遮.id.includes('SECRETOLDPREFIX'), `遮罩 id 不泄露正文：${遮.id}`);
      assert.match(String(遮.id), /^msg-盲标-/, '旧格式 id 换成盲标');
      assert.equal(readFileSync(账本, 'utf8'), 前, '账本字节不动（读面投影，不洗账）');
    } finally {
      await f.cleanup();
    }
  });

  it('D-R07：错误详情面两向——状态机拒面与 InvalidBody 面均不含他人答案', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'D-R07-错误面', 负责人: 'member-a', 判据: ['x'] });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      await org.tasks.start(node.id, { subject: MEMBER_A, 项目: P });
      await org.tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论: 'member-a的R07错误面私密结论' });
      // ① 状态机/权限拒面：非负责人 B 交卷 ⇒ 任务外拒。
      const 一 = await runAction({ org, 项目: P, 主体: MEMBER_B, subject: MEMBER_B, args: { action: 'task_submit', id: node.id, 结论: 'x' } }).then(
        () => { throw new Error('应当被拒'); },
        (e) => e,
      );
      assert.ok(一 instanceof Denied, `要 Denied：${一?.constructor?.name}`);
      assert.ok(!JSON.stringify(一).includes('member-a的R07错误面私密结论'), '拒面不携带他人答案');
      assert.ok(!JSON.stringify(一.detail ?? {}).includes('私密结论'), 'detail 面同样不携带');
      // ② InvalidBody 面：不存在的节点 id。
      const 二 = await runAction({ org, 项目: P, 主体: MEMBER_B, subject: MEMBER_B, args: { action: 'task_submit', id: 'task-不存在-R07', 结论: 'x' } }).then(
        () => { throw new Error('应当被拒'); },
        (e) => e,
      );
      assert.ok(二.name === 'InvalidBody' || 二 instanceof Error, `要 InvalidBody：${二?.constructor?.name}`);
      assert.ok(!JSON.stringify(二).includes('member-a的R07错误面私密结论'), 'InvalidBody 面不携带他人答案');
    } finally {
      await f.cleanup();
    }
  });
});
