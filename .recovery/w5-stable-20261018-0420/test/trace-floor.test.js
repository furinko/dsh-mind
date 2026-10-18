/**
 * 2026-10-12 评审批次 4：留痕铺满（缺口1B / P2-2 / P1-9 / P2-1）。
 *
 *  - 缺口1B 动作层拦截入账：身份门①②、服务层闸（状态机/会审闸……）的 Denied 记
 *    「动作拦截」；策略引擎自己的拒绝（已记「策略拒绝」，带 已入账 标记）不双记。
 *  - P2-2 结论集坏串不许静默落成 []（零分歧检查读空气 = 假绿）。
 *  - P1-9 更正声明跨月生效：声明表全局收集（声明写当前月、目标在旧月）。
 *  - P2-1 审计 hash 输入先过 JSON 往返归一：写侧与验侧恒为同一形状
 *    （修前含 undefined 的字段会自己打断自己的链——2026-10#37 同款）。
 *
 * 断言全部经塞 bug 校准（造坏 ⇒ 必红）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD } from './helpers.mjs';
import { fakeHost, fakeExec } from './host-harness.mjs';
import { AuditLog } from '../src/audit.js';
import { TaskGraph } from '../src/tasks.js';
import { RoleRegistry } from '../src/registry.js';
import { runAction } from '../lib/actions.js';
import * as kernel from '../components/kernel/lib/index.js';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';

const P = 'default';
const MEMBER_A = { id: 'member-a', kind: '成员', roleId: '插件工程' };

describe('批次4 · 缺口1B：动作层拦截入账', () => {
  it('门①（role:Lead 自报）⇒ 拒 + 账上有「动作拦截」（修前这次企图完全无痕）', async () => {
    const g = await makeFixture();
    try {
      await assert.rejects(
        () => runAction({ org: { audit: g.audit }, 项目: P, 主体: MEMBER_A, args: { action: 'status', role: 'Lead' } }),
        (e) => e.name === 'Denied' && /Lead 身份由会话事实决定/.test(e.rule),
      );
      const 拦截 = (await g.audit.read({})).filter((r) => r.动作 === '动作拦截');
      assert.equal(拦截.length, 1, '冒充企图必须入账');
      assert.equal(拦截[0].主体.id, 'member-a', '记的是真实主体');
      assert.match(拦截[0].依据 ?? '', /Lead 身份由会话事实决定/, '拦在哪条规则上要可复核');
    } finally {
      await g.cleanup();
    }
  });

  it('服务层闸（状态机）的 Denied 入账；策略引擎的拒绝不双记（无「动作拦截」行）', async () => {
    const g = await makeFixture();
    try {
      const tasks = new TaskGraph({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      const registry = new RoleRegistry({ layout: g.layout, policy: g.policy, audit: g.audit, clock: g.clock });
      const org = { tasks, registry, audit: g.audit };
      const node = await tasks.create({ subject: LEAD, 项目: P, 描述: 'x', 负责人: ['member-a'], 判据: ['y'] });
      // ① 服务层状态机闸：待派发节点不许交卷（Denied 不经过策略引擎 ⇒ 修前无痕）
      await assert.rejects(
        () => runAction({ org, 项目: P, 主体: LEAD, args: { action: 'task_submit', id: node.id, 结论: '抢跑' } }),
        (e) => e.name === 'Denied' && /状态机/.test(e.rule),
      );
      // ② 策略引擎的拒绝：成员在任务外写任务（create 不过闸 ⇒ 引擎已记「策略拒绝」）
      await assert.rejects(
        () => runAction({ org, 项目: P, 主体: MEMBER_A, args: { action: 'task_create', 描述: '越权', 负责人: ['member-a'], 判据: ['y'] } }),
        (e) => e.name === 'Denied',
      );
      const rows = await g.audit.read({});
      const 拦截 = rows.filter((r) => r.动作 === '动作拦截');
      assert.equal(拦截.length, 1, '只有服务层那条记「动作拦截」（策略拒绝不双记）');
      assert.match(拦截[0].依据 ?? '', /状态机/);
      assert.ok(rows.some((r) => r.动作 === '策略拒绝'), '引擎那条仍在账上（各自一处）');
    } finally {
      await g.cleanup();
    }
  });
});

describe('批次4 · P2-2：结论集坏串响亮拒，不静默落成空集', () => {
  it('工具面：结论集 是坏 JSON ⇒ 拒（修前静默 [] ⇒ 零分歧检查读空气）；合法 JSON 照常往下走', async () => {
    const g = await makeFixture();
    const host = fakeHost();
    try {
      await kernel.apply(host.ctx, { home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot });
      await shareOrg({ home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot });
      const 工具 = host.工具.get('mind');
      const exec = fakeExec({ name: 'mind', sessionId: 'session-root-batch4' });

      const 坏 = JSON.parse(await 工具.execute({ action: 'review_zero', id: 'task-x', 结论集: '{这根本不是JSON' }, exec));
      assert.equal(坏.成功, false, '坏串必须拒（修前放行且按空集判定）');
      assert.match(JSON.stringify(坏), /结论集 不是合法 JSON/, '拒绝要点名是结论集解析失败');

      // 合法串 + 真实节点（2026-10-13 审查 P1-8 之后结论集不再收自报：必须给任务图里真有的
      // 节点 id，服务层从独立答案重算）。'task-x' 不存在 ⇒ 响亮拒，而不是读空气。
      const org = await shareOrg({ home: g.home, factoryRoot: g.factoryRoot, privateRoot: g.privateRoot });
      // 项目键两边钉死同一个值（工具面的项目键从 exec 工作区派生，这里显式传 project 免得漂）。
      const 项目 = 'zero-div-floor';
      const LEAD_SUB = { id: 'lead', kind: 'Lead' };
      const 节点 = await org.tasks.create({ subject: LEAD_SUB, 项目, 描述: '零分歾示证', 负责人: ['member-a', 'member-b'], 模式: '独立会审', 判据: ['x'] });
      await org.tasks.dispatch(节点.id, { subject: LEAD_SUB, 项目 });
      await org.tasks.start(节点.id, { subject: { id: 'member-a', kind: '成员' }, 项目 });
      await org.tasks.submit(节点.id, { subject: { id: 'member-a', kind: '成员' }, 项目, 结论: '同一结论' });
      await org.tasks.submit(节点.id, { subject: { id: 'member-b', kind: '成员' }, 项目, 结论: '同一结论' });
      const 好 = JSON.parse(await 工具.execute({ action: 'review_zero', id: 节点.id, project: 项目, 结论集: '[]' }, exec));
      assert.equal(好.成功, true, `合法串 + 真实节点必须给出检查读数（实际：${JSON.stringify(好)}）`);
      assert.ok(好.检查, '走到 review.checkZeroDivergence 才有「检查」读数');
      assert.equal(好.检查.零分歧, true, '两份同文结论且无反例面 ⇒ 零分歧（从任务图独立答案重算）');

      const 空气节点 = JSON.parse(await 工具.execute({ action: 'review_zero', id: 'task-x', project: 项目, 结论集: '[]' }, exec));
      assert.equal(空气节点.成功, false, '不存在的节点必须响亮拒（不收自报结论集 ⇒ 没有权威源）');
    } finally {
      host.清理();
      forgetSharedOrg();
      await g.cleanup();
    }
  });
});

describe('批次4 · P1-9：更正声明跨月生效', () => {
  const clockAt = (iso) => ({ iso: () => iso, ms: () => Date.parse(iso) });

  it('目标在旧月、声明在当月 ⇒ verify 认（修前按月收集 ⇒ 跨月静默失效）；伪造声明仍红', async () => {
    const g = await makeFixture();
    try {
      const a9 = new AuditLog({ layout: g.layout, clock: clockAt('2026-09-15T00:00:00.000Z') });
      await a9.append({ 动作: '状态变更', 主体: 'lead', 结果: '第一行' });
      await a9.append({ 动作: '状态变更', 主体: 'lead', 结果: '第二行' });
      // 篡改 2026-09#1（改内容、留原 hash/prev ⇒ 单点 hash 瑕疵、骨架完好、尾部无恙）
      const file = g.layout.auditLog('2026-09');
      const lines = (await readFile(file, 'utf8')).trim().split('\n').map((s) => JSON.parse(s));
      lines[0].结果 = '被篡改的第一行';
      await writeFile(file, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);

      const a10 = new AuditLog({ layout: g.layout, clock: clockAt('2026-10-01T00:00:00.000Z') });
      let v = await a10.verify();
      assert.ok(v.broken.some((b) => b.month === '2026-09' && b.seq === 1 && b.类型 === '链断裂'), '前提：篡改见红');

      // 授权引用存在性（P2-18）：先在任务图里落一个真实节点，授权指向它。
      const { appendLines } = await import('../src/kernel/fsx.js');
      const { mkdir } = await import('node:fs/promises');
      const { dirname } = await import('node:path');
      const taskLog = g.layout.taskLog('default');
      await mkdir(dirname(taskLog), { recursive: true }).catch(() => {});
      await appendLines(taskLog, [{ seq: 1, at: '2026-09-01T00:00:00.000Z', by: { id: 'lead', kind: 'Lead' }, kind: 'created', id: '决议-batch4', 描述: '跨月声明授权载体', 判据: ['x'] }]);

      await a10.appendCorrection({ 主体: '主权者', 目标: '2026-09#1', 理由: '核查无误（测试造瑕）', 授权引用: '决议-batch4' });
      v = await a10.verify();
      assert.equal(v.ok, true, '跨月声明必须够得着目标（修前：声明在 10 月片、按月收集 ⇒ 永远对不上，照样红）');
      assert.equal(v.已确认瑕疵.length, 1);
      assert.equal(v.已确认瑕疵[0].month, '2026-09');

      // 伪造声明（指向健康行）⇒ 无人消费 ⇒ 仍红
      await a10.append({ 动作: '更正声明', 主体: 'attacker', 结果: '伪造', 详情: { 目标: '2026-09#2', 实存hash: 'fake', 复算hash: 'fake' } });
      v = await a10.verify();
      assert.ok(!v.ok && v.broken.some((b) => b.类型 === '更正声明无效'), '伪造/错配声明照样见红（声明不是洗白通道）');
    } finally {
      await g.cleanup();
    }
  });
});

describe('批次4 · P2-1：审计 hash 与落盘形状同源', () => {
  it('详情含 undefined 字段 ⇒ 落盘丢键但链不许断（修前写侧算带 null、盘上没有 ⇒ 自检见红）', async () => {
    const g = await makeFixture();
    try {
      const audit = new AuditLog({ layout: g.layout, clock: g.clock });
      await audit.append({ 动作: '状态变更', 主体: 'lead', 结果: 'x', 详情: { 会丢的键: undefined, 留下: 1 } });
      await audit.append({ 动作: '状态变更', 主体: 'lead', 结果: 'y' });
      const v = await audit.verify();
      assert.equal(v.ok, true, `写侧与验侧输入必须同形状（broken=${JSON.stringify(v.broken)}）`);
    } finally {
      await g.cleanup();
    }
  });
});
