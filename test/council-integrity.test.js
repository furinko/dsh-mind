/**
 * 2026-10-12 评审批次 2：会审完整性三连（P1-4 / P2-5 / P2-6）。
 *
 *  - P1-4 揭名后拒改卷：讨论段存在 + 状态已交卷 ⇒ submit 拒（锁内判）；
 *    返工环路（打回→start→submit）不许被误伤。
 *  - P2-5 「交齐」判据单源：全员已交（按人核对）是三处（debate_open / bus_unlock /
 *    workbench 遮罩）唯一的一把尺；计数口径会被「非负责人垫一份」骗开。
 *  - P2-6 bus_read 盲评遮罩：未交齐的独立会审线程，成员读不到他人的发件与内容——
 *    与 workbench 投影层同一条 §10 规矩。
 *
 * 断言全部经塞 bug 校准（造坏 ⇒ 必红），读数见提交说明。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { TaskGraph, 全员已交 } from '../src/tasks.js';
import { MessageBus } from '../src/bus.js';
import { RoleRegistry } from '../src/registry.js';
import { ReviewProtocol } from '../src/review.js';
import { DebateService } from '../src/debate.js';
import { projectWorkbench } from '../src/workbench.js';
import { runAction } from '../lib/actions.js';

const P = 'default';
const MEMBER_A = { id: 'member-a', kind: '成员', roleId: '插件工程' };
const MEMBER_B = { id: 'member-b', kind: '成员', roleId: '插件工程' };

function 装配(g, random = () => 0) {
  const tasks = new TaskGraph({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const bus = new MessageBus({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const registry = new RoleRegistry({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
  const review = new ReviewProtocol({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock, tasks, bus, random });
  const debate = new DebateService({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock, tasks, bus, review, registry });
  return { tasks, bus, registry, review, debate };
}

async function 双人独立会审(tasks, { 交齐 = true } = {}) {
  const node = await tasks.create({
    subject: LEAD, 项目: P, 描述: '批次2 会审节点', 负责人: ['member-a', 'member-b'], 判据: ['结论一致'], 模式: '独立会审',
  });
  await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await tasks.start(node.id, { subject: MEMBER_A, 项目: P });
  if (交齐) {
    await tasks.submit(node.id, { subject: MEMBER_A, 项目: P, 结论: 'A 案' });
    await tasks.submit(node.id, { subject: MEMBER_B, 项目: P, 结论: 'B 案' });
  }
  return node.id;
}

describe('批次2 · P1-4：讨论段存在 ⇒ 不许从「已交卷」改卷', () => {
  it('揭名（debate_open）后再交卷 ⇒ 锁内拒（修前 fold 静默替换本人答案）；收敛后同样拒', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const id = await 双人独立会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点: id });
      await assert.rejects(
        () => parts.tasks.submit(id, { subject: MEMBER_A, 项目: P, 结论: 'A 洗过的案' }),
        (e) => e.name === 'Denied' && /不许改卷/.test(e.rule) && /返工环路/.test(e.howToChange),
        '揭名后改卷必须拒',
      );
      const node = await parts.tasks.get(id, { 项目: P });
      assert.deepEqual(
        (node.独立答案 ?? []).find((a) => a.成员 === 'member-a')?.结论,
        'A 案',
        '被拒的那次没有洗掉原答案（不是纸面拒绝）',
      );
      // 收敛后（讨论子状态仍在）照样拒。
      await parts.debate.converge({ subject: LEAD, 项目: P, 节点: id, 结论: '按 A 案' });
      await assert.rejects(
        () => parts.tasks.submit(id, { subject: MEMBER_A, 项目: P, 结论: 'A 收敛后洗卷' }),
        (e) => e.name === 'Denied' && /不许改卷/.test(e.rule),
        '已收敛不许成为洗卷通道',
      );
    } finally {
      await g.cleanup();
    }
  });

  it('返工环路不受误伤：打回 ⇒ start ⇒ submit 照常（讨论段存在但不是从已交卷出发）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const id = await 双人独立会审(parts.tasks);
      await parts.debate.open({ subject: LEAD, 项目: P, 节点: id });
      await parts.debate.converge({ subject: LEAD, 项目: P, 节点: id, 结论: '都不行，返工' });
      await parts.tasks.review(id, { subject: REVIEWER_S, 项目: P, 三态: '不过', 分歧清单: ['两处都错'] });
      assert.equal((await parts.tasks.get(id, { 项目: P })).状态, '已打回', '前提：打回落态');
      await parts.tasks.start(id, { subject: MEMBER_A, 项目: P });
      await parts.tasks.submit(id, { subject: MEMBER_A, 项目: P, 结论: 'A 返工案' });
      const node = await parts.tasks.get(id, { 项目: P });
      assert.equal(node.状态, '已交卷', '返工后回到已交卷');
      assert.equal((node.独立答案 ?? []).find((a) => a.成员 === 'member-a')?.结论, 'A 返工案', '返工的新答案落上');
    } finally {
      await g.cleanup();
    }
  });
});

const REVIEWER_S = { id: 'reviewer', kind: '复核者', roleId: '复核员' };

describe('批次2 · P2-5：「交齐」按人核对，三处同一把尺', () => {
  it('非负责人（Lead）垫一份 ⇒ 计数齐、按人不齐：遮罩不揭、debate_open 拒、bus_unlock 拒', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const id = await 双人独立会审(parts.tasks, { 交齐: false });
      await parts.tasks.submit(id, { subject: LEAD, 项目: P, 结论: 'Lead 垫的一份' });
      const node = await parts.tasks.get(id, { 项目: P });
      assert.equal((node.独立答案 ?? []).length, 1, '前提：计数已到 1/2 里的 1，再垫一份就 2/2 —— 先造出计数骗局');
      await parts.tasks.submit(id, { subject: MEMBER_A, 项目: P, 结论: 'A 案' });
      const 骗开前的 = await parts.tasks.get(id, { 项目: P });
      assert.equal((骗开前的.独立答案 ?? []).length, 2, '前提：计数 2/2（Lead 垫的 + A 的）——旧计数口径会判齐');
      assert.equal(全员已交(骗开前的), false, '按人核对：member-b 没交 ⇒ 不齐');

      const view = projectWorkbench({
        项目: P, 节点: [骗开前的], 审计尾: [], 升级挂起: [],
        探针: { 状态: '正常', 结果: [] }, 策略: { healthy: true, 错误: null, 介入度: '零参与', 失联: {} },
        讨论消息: {}, 生成于: '2026-10-12T00:00:00Z',
      });
      const 会审 = (view.会审 ?? []).find((r) => r.节点 === id);
      assert.ok(会审, '前提：会审行在投影里');
      assert.equal(会审.揭名, false, '遮罩不许被垫数骗开（修前计数口径 ⇒ 揭名=true）');
      assert.ok(会审.独立答案.every((a) => a.成员 === undefined), '答案行只留盲标');

      await assert.rejects(
        () => parts.debate.open({ subject: LEAD, 项目: P, 节点: id }),
        (e) => e.name === 'Denied' && /全员已交/.test(e.rule),
        'debate_open 与遮罩同一把尺（按人不齐 ⇒ 拒）',
      );
      await assert.rejects(
        () => runAction({ org: parts, 项目: P, 主体: LEAD, args: { action: 'bus_unlock', id, 线程: id } }),
        (e) => e.name === 'Denied' && /全员已交/.test(e.rule),
        'bus_unlock 同一把尺',
      );
    } finally {
      await g.cleanup();
    }
  });

  it('正对照：两人真交齐 ⇒ 遮罩揭名、三处同判齐', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const id = await 双人独立会审(parts.tasks);
      const node = await parts.tasks.get(id, { 项目: P });
      assert.equal(全员已交(node), true, '两人都交 ⇒ 齐');
      const view = projectWorkbench({
        项目: P, 节点: [node], 审计尾: [], 升级挂起: [],
        探针: { 状态: '正常', 结果: [] }, 策略: { healthy: true, 错误: null, 介入度: '零参与', 失联: {} },
        讨论消息: {}, 生成于: '2026-10-12T00:00:00Z',
      });
      assert.equal((view.会审 ?? []).find((r) => r.节点 === id).揭名, true, '真交齐 ⇒ 揭名（正常路径不许被误伤）');
    } finally {
      await g.cleanup();
    }
  });
});

describe('批次2 · P2-6：bus_read 盲评遮罩（总线读面与投影层同一条 §10 规矩）', () => {
  async function 未齐会审带消息(parts) {
    const id = await 双人独立会审(parts.tasks, { 交齐: false });
    await runAction({
      org: parts, 项目: P, 主体: MEMBER_A,
      args: { action: 'bus_send', 线程: id, 类型: '表态', 内容: '我的结论是 A 案（盲评期不该被 B 看到）' },
    });
    return id;
  }

  it('未交齐：成员 bus_read ⇒ 他人消息只留盲标（发件/内容不出）；自己的照给', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const id = await 未齐会审带消息(parts);
      const r = await runAction({ org: parts, 项目: P, 主体: MEMBER_B, args: { action: 'bus_read', 线程: id } });
      const 他人的 = r.消息.filter((m) => m.盲评遮罩 === true);
      assert.equal(他人的.length, 1, 'A 的那条被遮（修前原样读出结论原文）');
      assert.equal(他人的[0].发件, '成员 A', '发件只剩盲标');
      assert.ok(!String(他人的[0].内容).includes('A 案'), '内容不出');
      // A 自己读：不遮自己那条。
      const 自己 = await runAction({ org: parts, 项目: P, 主体: MEMBER_A, args: { action: 'bus_read', 线程: id } });
      assert.ok(自己.消息.some((m) => String(m.内容).includes('A 案')), '自己的消息照给（盲评不遮自己）');
    } finally {
      await g.cleanup();
    }
  });

  it('Lead 读 ⇒ 不遮（盲评防参与者互看，不防组织记账）；交齐后 ⇒ 全员可见', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const id = await 未齐会审带消息(parts);
      const leadView = await runAction({ org: parts, 项目: P, 主体: LEAD, args: { action: 'bus_read', 线程: id } });
      assert.ok(leadView.消息.some((m) => String(m.内容).includes('A 案')), 'Lead 读原样');
      // 交齐 ⇒ 揭名 ⇒ 成员也读得到。
      await parts.tasks.submit(id, { subject: MEMBER_A, 项目: P, 结论: 'A 案' });
      await parts.tasks.submit(id, { subject: MEMBER_B, 项目: P, 结论: 'B 案' });
      const 齐后 = await runAction({ org: parts, 项目: P, 主体: MEMBER_B, args: { action: 'bus_read', 线程: id } });
      assert.ok(齐后.消息.some((m) => String(m.内容).includes('A 案')), '交齐揭名后成员可读（正常路径不许被误伤）');
    } finally {
      await g.cleanup();
    }
  });

  it('并行分担节点的线程不遮（盲评只属于独立会审）', async () => {
    const g = await makeFixture();
    try {
      const parts = 装配(g);
      const node = await parts.tasks.create({
        subject: LEAD, 项目: P, 描述: '并行分担节点', 负责人: ['member-a', 'member-b'], 判据: ['x'], 模式: '并行分担',
      });
      await parts.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      await runAction({
        org: parts, 项目: P, 主体: MEMBER_A,
        args: { action: 'bus_send', 线程: node.id, 类型: '表态', 内容: '并行分担的中间结果' },
      });
      const r = await runAction({ org: parts, 项目: P, 主体: MEMBER_B, args: { action: 'bus_read', 线程: node.id } });
      assert.ok(r.消息.some((m) => String(m.内容).includes('中间结果')), '并行分担共享中间结果（§10 表）——不许被遮');
    } finally {
      await g.cleanup();
    }
  });
});
