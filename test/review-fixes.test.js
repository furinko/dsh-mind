/**
 * 代码审查（2026-10-08）批次 1+2 的回归断言。
 *
 * 每条对应报告里一条已核验的 P1，防的都是「同一类失守复发」：
 *  - 任务图写方法绕过策略引擎 + 状态机无守卫（报告 A1）
 *  - upgrade_withdraw 与 resolve 权限颠倒（A2）
 *  - purge 不过闸 + 关键字闸 + 理由缺省炸 TypeError（A3）
 *  - bus.deliver 不过闸（A4）
 *  - archiveAnswers 不过闸（A5）
 *  - 路径片段零校验 ⇒ 路径穿越（E5）
 *  - 故障期拒绝零留痕，与 Fault「已入账」承诺矛盾（E4）
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, SOVEREIGN, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { MessageBus } from '../src/bus.js';
import { MemoryService } from '../src/memory.js';
import { UpgradeManager } from '../src/upgrade.js';
import { assertPathSegment } from '../src/paths.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;
/** @type {TaskGraph} */ let tasks;
/** @type {MessageBus} */ let bus;
/** @type {MemoryService} */ let memory;
/** @type {UpgradeManager} */ let upgrade;

const P = 'proj-a';
const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };

describe('审查修复 · 批次 1+2', () => {
  before(async () => {
    f = await makeFixture();
    tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    bus = new MessageBus({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    upgrade = new UpgradeManager({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
  });
  after(async () => {
    await f.cleanup();
  });

  it('状态机：环路次序有强制力（待派发不能开工/复核，终态不能复活）', async () => {
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '状态机演示', 负责人: 'member-a', 判据: ['x'] });
    // 没派发就开工 / 就复核：都越过「派发」这站，判据还没冻结。
    await assert.rejects(() => tasks.start(node.id, { subject: MEMBER, 项目: P }), (e) => e instanceof Denied && /状态机/.test(e.rule));
    await assert.rejects(
      () => tasks.review(node.id, { subject: REVIEWER, 项目: P, 三态: '过', 复核者: 'reviewer' }),
      (e) => e instanceof Denied && /状态机/.test(e.rule),
    );

    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    await tasks.submit(node.id, { subject: MEMBER, 项目: P });
    const adopted = await tasks.review(node.id, { subject: REVIEWER, 项目: P, 三态: '过', 复核者: 'reviewer' });
    assert.equal(adopted.状态, '已采纳');
    // 终态不许复活，也不许再挂任何事件。
    await assert.rejects(() => tasks.start(node.id, { subject: MEMBER, 项目: P }), (e) => e instanceof Denied);
    await assert.rejects(() => tasks.attach(node.id, { subject: MEMBER, 项目: P, 产出物: 'a-1' }), (e) => e instanceof Denied);
    await assert.rejects(() => tasks.markPending(node.id, { subject: LEAD, 项目: P, 原因: '回头再看看' }), (e) => e instanceof Denied);
    await assert.rejects(() => tasks.reject(node.id, { subject: REVIEWER, 项目: P, 理由: '改主意了' }), (e) => e instanceof Denied && /终态/.test(e.message));
  });

  it('状态机：打回返工是合法环路（已打回 → 开工 → 再交卷）', async () => {
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '返工演示', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    await tasks.submit(node.id, { subject: MEMBER, 项目: P });
    await tasks.review(node.id, { subject: REVIEWER, 项目: P, 三态: '不过', 分歧清单: ['判据未满足'], 复核者: 'reviewer' });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    const resubmitted = await tasks.submit(node.id, { subject: MEMBER, 项目: P });
    assert.equal(resubmitted.状态, '已交卷');
    assert.equal(resubmitted.打回次数, 1, '返工不清打回计数');
  });

  it('任务写动作的闸：复核者不能交卷，任务外成员不能交卷', async () => {
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '闸演示', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await tasks.start(node.id, { subject: MEMBER, 项目: P });
    await assert.rejects(
      () => tasks.submit(node.id, { subject: REVIEWER, 项目: P }),
      (e) => e instanceof Denied && /复核者/.test(e.rule),
    );
    await assert.rejects(
      () => tasks.submit(node.id, { subject: MEMBER_B, 项目: P }),
      (e) => e instanceof Denied && /任务外无/.test(e.rule),
    );
    // 开工本身也要过闸：复核者连 start 都不行。
    const node2 = await tasks.create({ subject: LEAD, 项目: P, 描述: '闸演示二', 负责人: 'member-a', 判据: ['x'] });
    await tasks.dispatch(node2.id, { subject: LEAD, 项目: P });
    await assert.rejects(() => tasks.start(node2.id, { subject: REVIEWER, 项目: P }), (e) => e instanceof Denied);
  });

  it('upgrade_withdraw：法律档挂起项 Lead 可处置（裁决 2026-10-08）；安全类（宪章档）仍拒 Lead', async () => {
    // 直接种两个遗留挂起项（新冲突已按私有优先自动处置，不再产生挂起）。
    await f.writePrivate('升级/挂起/pend-1.json', `${JSON.stringify({ id: 'pend-1', 对象: '权限矩阵', 安全类: false, 状态: '挂起' }, null, 2)}\n`);
    await f.writePrivate('升级/挂起/pend-2.json', `${JSON.stringify({ id: 'pend-2', 对象: '宪章', 安全类: true, 状态: '挂起' }, null, 2)}\n`);
    const withdrawn = await upgrade.withdraw({ subject: LEAD, id: 'pend-1', 理由: '主权者授意撤回' });
    assert.equal(withdrawn.已撤回, true, '法律档：Lead 裁决通道放行');
    await assert.rejects(
      () => upgrade.withdraw({ subject: LEAD, id: 'pend-2', 理由: '试试安全类' }),
      (e) => e instanceof Denied && /主权者|宪章/.test(e.rule + e.reason),
      '宪章档（安全类）：Lead 仍不可达',
    );
  });

  it('purge：理由必填（不再是 TypeError），敏感必须显式声明，且过策略闸', async () => {
    const entry = await memory.remember({ subject: LEAD, 类: '经历', 内容: '待删除的经历', 来源: '测试' });
    // 理由缺省：结构不合规，不是裸 TypeError。
    await assert.rejects(() => memory.purge(entry.id, { subject: LEAD }), (e) => e instanceof InvalidBody && /理由/.test(e.message));
    // 理由里写「这段不敏感」：旧关键字闸会误放行；显式声明闸不误放行。
    await assert.rejects(
      () => memory.purge(entry.id, { subject: LEAD, 理由: '这段不敏感，但我想删' }),
      (e) => e instanceof Denied && /记忆处置表/.test(e.rule),
    );
    // 复核者就算声明了敏感也不行：write 闸先一步拦住（复核者只读数）。
    await assert.rejects(
      () => memory.purge(entry.id, { subject: REVIEWER, 理由: '这是敏感数据', 敏感: true }),
      (e) => e instanceof Denied && /复核者/.test(e.rule),
    );
    const purged = await memory.purge(entry.id, { subject: LEAD, 理由: '这是敏感数据', 敏感: true });
    assert.equal(purged.已删除, true);
  });

  it('bus.deliver 过闸：复核者不能放行被压住的消息', async () => {
    const held = await bus.send({ subject: LEAD, 项目: P, 线程: 't-gate', 发件: 'lead', 收件: 'member-a', 内容: '暂缓', 暂不投递: true });
    await assert.rejects(
      () => bus.deliver({ subject: REVIEWER, 项目: P, 线程: 't-gate', id: held.id }),
      (e) => e instanceof Denied,
    );
    const delivered = await bus.deliver({ subject: LEAD, 项目: P, 线程: 't-gate', id: held.id });
    assert.equal(delivered.状态, '已投递');
  });

  it('archiveAnswers 过闸：复核者不能归档作答', async () => {
    await assert.rejects(
      () => memory.archiveAnswers({ subject: REVIEWER, 项目: P, 任务: 'task-x' }),
      (e) => e instanceof Denied && /复核者/.test(e.rule),
    );
    const archived = await memory.archiveAnswers({ subject: LEAD, 项目: P, 任务: 'task-x' });
    assert.ok(typeof archived.归档条数 === 'number');
  });

  it('路径片段校验：穿越写法一律 InvalidBody，正常片段原样放行', () => {
    for (const bad of ['..', '.', '', 'a/b', 'a\\b', 'C:', '..\\x', 'a:b']) {
      assert.throws(() => assertPathSegment(bad, '项目'), (e) => e instanceof InvalidBody, `应拒绝：${JSON.stringify(bad)}`);
    }
    for (const ok of ['proj-a', 'my.proj', '中文项目', '跨项目', 'task-x-1a2b3']) {
      assert.equal(assertPathSegment(ok, '项目'), ok);
    }
    // 入口可控的 project 直接打到布局上：`project="../../x"` 不许落到私有区外面。
    assert.throws(() => f.layout.taskLog('../../x'), (e) => e instanceof InvalidBody);
    assert.throws(() => f.layout.busThread(P, '../other'), (e) => e instanceof InvalidBody);
    assert.throws(() => f.layout.pendingFile('../../audit'), (e) => e instanceof InvalidBody);
    assert.throws(() => f.layout.historyDir('../x'), (e) => e instanceof InvalidBody);
  });

  it('故障期拒绝也入账：Fault「已入账」的承诺是真的', async () => {
    const broken = await makeFixture({ rules: {} });
    const { rm } = await import('node:fs/promises');
    await rm(broken.layout.rulePath('宪章', '出厂'), { force: true });
    assert.equal(await broken.policy.reload(), false);
    const decision = await broken.policy.decide({ subject: LEAD, action: 'write', target: { id: 'x', kind: '能力', authority: '自治' } });
    assert.equal(decision.verdict, 'deny');
    assert.equal(decision.alarm, true);
    const rows = await broken.audit.read({});
    const 故障入账 = rows.filter((r) => r.动作 === '策略拒绝' && String(r.结果).includes('安全闸故障'));
    assert.ok(故障入账.length >= 1, `故障期拒绝必须入账（Fault 的 howToChange 承诺了「已入账」），实际审计 ${rows.length} 条`);
    assert.equal(故障入账[0].告警, true, '故障入账必须是告警级');
    await broken.cleanup();
  });
});
