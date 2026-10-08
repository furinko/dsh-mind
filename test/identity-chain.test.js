/**
 * 审查批次 3 + 5 的修复断言（2026-10-08 代码审查报告 §五）。
 *
 * 批次 3（身份链）：B1 身份档案接入判定 / B2 身份变更后重载 / B3 工具面岗位不再自报即真。
 * 批次 5（一致性）：E1 fold 同 id 合并 / E2 bus read 按 id 折叠 / E3 审计 append 上锁 / F3 挂起历史。
 * 每条断言都对应报告里的一个编号，塞 bug 校准见提交说明。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { makeFixture, SOVEREIGN, LEAD, MEMBER, writeUnder } from './helpers.mjs';
import { RoleRegistry } from '../src/registry.js';
import { subjectFor } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { MemoryService } from '../src/memory.js';
import { MessageBus } from '../src/bus.js';
import { UpgradeManager } from '../src/upgrade.js';
import { fold } from '../src/memory.js';

/** @type {Awaited<ReturnType<typeof makeFixture>>} */
let f;
/** @type {RoleRegistry} */ let registry;

describe('审查修复 · 批次3+5（身份链 / 一致性）', () => {
  before(async () => {
    f = await makeFixture();
    registry = new RoleRegistry({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    // 岗位卡：实例权限只来自岗位（§7），先有卡才能 assign。
    const 卡 = [
      '---', 'id: 插件工程', 'kind: 身份', 'authority: 自治', 'zone: 私有', 'domain: 个体', 'version: 1', '---',
      '# 插件工程', '', '## 个体L0 · 身份', '插件工程岗。', '',
      '## 个体L1 · 规则', '先搜后写。', '',
      '## 个体L2 · 能力', '- 无', '',
      '## 个体L3 · 经验', '- 无',
    ].join('\n');
    await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 卡);
  });
  after(async () => {
    await f.cleanup();
  });

  // ── B1：身份档案接入判定 ────────────────────────────────────────────────────

  it('B1 封存实例失权：seal 之后判定理由从「任务外」变成「身份状态」', async () => {
    await registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-z', 代: 1 });
    const 主体 = { id: 'member-z', kind: '成员', roleId: '插件工程' };
    const 目标 = { id: '知识-x', kind: '知识', authority: '自治', zone: '私有' };
    const before = await f.policy.decide({ subject: 主体, action: 'write', target: 目标, context: {} });
    // 在岗成员对任务外自治写本来就会被拒（任务外无）——这里盯的是**拒绝理由属于哪一族**。
    assert.equal(before.verdict, 'deny');
    assert.doesNotMatch(before.rule, /§12\.2/, '在岗时不应触发身份停用条款');

    await registry.seal({ subject: LEAD, 实例: 'member-z', 理由: '停岗' });
    const after决策 = await f.policy.decide({ subject: 主体, action: 'write', target: 目标, context: {} });
    assert.equal(after决策.verdict, 'deny');
    assert.match(after决策.rule, /§12\.2/);
    assert.match(after决策.reason, /封存/);
  });

  it('B1 未登记的成员身份按最严拒绝（查不到不等于放行）', async () => {
    const 决定 = await f.policy.decide({
      subject: { id: 'ghost-member', kind: '成员', roleId: '插件工程' },
      action: 'write',
      target: { id: '知识-x', kind: '知识', authority: '自治', zone: '私有' },
      context: {},
    });
    assert.equal(决定.verdict, 'deny');
    assert.match(决定.reason, /没有 ghost-member/);
  });

  it('B1 撤回名单对「主体自身」也生效：revoke 成员 id 后该成员的写被拒', async () => {
    const g2 = await makeFixture({ denylist: [{ id: 'member-a', 理由: '测试撤回主体', 撤于: '2026-10-08T00:00:00Z' }] });
    try {
      const 决定 = await g2.policy.decide({
        subject: { ...MEMBER },
        action: 'write',
        target: { id: '与撤回对象无关的-id', kind: '知识', authority: '自治', zone: '私有' },
        context: {},
      });
      assert.equal(决定.verdict, 'deny');
      assert.match(决定.reason, /拒绝名单/);
    } finally {
      await g2.cleanup();
    }
  });

  // ── B2：身份变更后判定读新快照 ──────────────────────────────────────────────

  it('B2 seal 之后判定立即生效（不依赖下一次 reload）', async () => {
    // 上一条用例已经 seal 过 member-z：这里验证的是「decide 读的就是最新档案」，
    // 所以换一个新实例走完整闭环。拒绝理由属于哪一族就是「判定读的是哪份档案」的证据。
    await registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-live' });
    await registry.seal({ subject: LEAD, 实例: 'member-live', 理由: '马上恢复' });
    const 主体 = { id: 'member-live', kind: '成员', roleId: '插件工程' };
    const 目标 = { id: '知识-x', kind: '知识', authority: '自治', zone: '私有' };
    const sealed = await f.policy.decide({ subject: 主体, action: 'write', target: 目标, context: {} });
    assert.match(sealed.rule, /§12\.2/, '封存必须立即失权（写档案后重载）');
    await registry.restore({ subject: SOVEREIGN, 实例: 'member-live' });
    const restored = await f.policy.decide({ subject: 主体, action: 'write', target: 目标, context: {} });
    assert.doesNotMatch(restored.rule, /§12\.2/, '恢复在岗必须立即复权：身份条款不再触发');
  });

  it('B2 失联冻得住也解得开：markInteraction 之后 presence 立即回在位', async () => {
    const g3 = await makeFixture({ offline: true });
    try {
      const reg3 = new RoleRegistry({ layout: g3.layout, policy: g3.policy, audit: g3.audit, clock: g3.clock });
      assert.equal(g3.policy.presence().lost, true, '夹具应处于失联');
      await reg3.markInteraction({});
      assert.equal(g3.policy.presence().lost, false, '主权者一次交互即解除（判定读新档案）');
    } finally {
      await g3.cleanup();
    }
  });

  // ── B3：岗位不再自报即真 ────────────────────────────────────────────────────

  it('B3 subjectFor：带岗位的会话不被根会话标记回填成 Lead', () => {
    const s = subjectFor({ 岗位: '插件工程', 实例: 'member-a', 根会话: true });
    assert.equal(s.kind, '成员');
    assert.equal(s.roleId, '插件工程');
    assert.equal(subjectFor({ 根会话: true }).kind, 'Lead', '无岗位的根会话仍是 Lead');
  });

  it('B3 runAction：岗位身份必须在身份档案里登记且在岗，否则按最严拒绝', async () => {
    const org = {
      registry: { identity: async () => ({ members: { 'member-a': { id: 'member-a', 岗位: '插件工程', status: '在岗' } }, sovereign: {}, denylist: [] }) },
      status: async () => ({ 项目: 'default' }),
    };
    const ok = await runAction({ org, 项目: 'default', subject: { id: 'lead', kind: 'Lead' }, args: { action: 'status', role: '插件工程', 实例: 'member-a' } });
    assert.equal(ok.主体.kind, '成员');

    await assert.rejects(
      () => runAction({ org, 项目: 'default', subject: { id: 'lead', kind: 'Lead' }, args: { action: 'status', role: '插件工程', 实例: 'ghost' } }),
      (error) => {
        assert.match(error.message, /身份档案/);
        assert.match(error.message, /ghost/);
        return true;
      },
    );
    await assert.rejects(
      () => runAction({ org, 项目: 'default', subject: { id: 'lead', kind: 'Lead' }, args: { action: 'status', role: '别的岗位', 实例: 'member-a' } }),
      (error) => {
        assert.match(error.message, /岗位/, '登记岗位与自报岗位不一致也要拒');
        return true;
      },
    );
  });

  // ── E1：fold 同 id 合并 ─────────────────────────────────────────────────────

  it('E1 晋升副本不再被项目账原件覆盖：默认视图里岗位标签可见', async () => {
    const row = { id: 'k-1', 类: '知识', 内容: '同一份正文', 归属: 'plugins', 岗位: null, 记于: '2026-10-08T01:00:00Z' };
    const promoted = { ...row, 归属: '跨项目', 岗位: '插件工程', 跨项目判定: { 由: 'lead' } };
    // query 的推入序是「跨项目 → 各项目」：晋升副本先、项目原件后。
    assert.equal(fold([promoted, row])[0].岗位, '插件工程', '后读的原件不许抹掉晋升副本的岗位标签');
    assert.equal(fold([row, promoted])[0].岗位, '插件工程', '反过来也一样');
    const merged = fold([promoted, row])[0];
    assert.ok(merged.账本出现于.includes('跨项目') && merged.账本出现于.includes('plugins'), '两份账的出处都留痕');
  });

  it('E1 活体：promoteCrossProject 之后 memory_query 默认视图带岗位标签', async () => {
    const memory = new MemoryService({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const written = await memory.remember({
      subject: LEAD,
      类: '知识',
      内容: 'E1 活体验收：晋升标签默认可见',
      来源: { 谁: 'lead', 怎么知道: '测试' },
      项目: 'default',
      标签: ['e1'],
    });
    await memory.promoteCrossProject(written.id, { subject: LEAD, 岗位: '插件工程', 理由: '可复用' });
    const result = await memory.query({ 文本: '晋升标签默认可见' });
    assert.ok(result.命中.length >= 1, `应命中，口径：${JSON.stringify(result.口径)}`);
    const 视图 = result.条目.find((e) => e.id === written.id);
    assert.ok(视图, '默认视图里要能看到这条知识');
    assert.equal(视图.岗位, '插件工程', '默认视图必须能看到晋升打的岗位标签');
    assert.equal(视图.归属, '跨项目', '归属按晋升副本报，不被项目原件覆盖');
  });

  // ── E2：bus read 按 id 折叠 ─────────────────────────────────────────────────

  it('E2 投递后消息不重复出现，「未投递」查询不再命中旧行', async () => {
    const bus = new MessageBus({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const sent = await bus.send({ subject: LEAD, 项目: 'default', 线程: 'e2', 发件: 'lead', 收件: 'member-a', 类型: '表态', 内容: '压一条', 暂不投递: true });
    assert.equal((await bus.read({ 项目: 'default', 线程: 'e2' })).length, 1);
    assert.equal((await bus.read({ 项目: 'default', 线程: 'e2', 未投递: true })).length, 1, '投递前状态是暂不投递');

    await bus.deliver({ subject: LEAD, 项目: 'default', 线程: 'e2', id: sent.id });
    const rows = await bus.read({ 项目: 'default', 线程: 'e2' });
    assert.equal(rows.length, 1, `同 id 两行必须折成一行，实际 ${rows.length}`);
    assert.equal(rows[0].状态, '已投递');
    assert.equal((await bus.read({ 项目: 'default', 线程: 'e2', 未投递: true })).length, 0, '投递后「未投递」查询必须为空');
  });

  // ── E3：审计 append 上锁 ────────────────────────────────────────────────────

  it('E3 并发追加不 fork：两个写者（各自持链尾缓存）并行 append，链仍完整', async () => {
    const g4 = await makeFixture();
    try {
      // 两个实例 = 两个写者：内存里的链尾缓存互相看不见，锁是唯一防线。
      const { AuditLog } = await import('../src/audit.js');
      const a = new AuditLog({ layout: g4.layout, clock: g4.clock });
      const b = new AuditLog({ layout: g4.layout, clock: g4.clock });
      await Promise.all([
        ...Array.from({ length: 10 }, (_, i) => a.append({ 动作: '状态变更', 主体: { id: `a-${i}`, kind: 'Lead' }, 对象: '并发', 依据: 'E3', 结果: 'ok' })),
        ...Array.from({ length: 10 }, (_, i) => b.append({ 动作: '状态变更', 主体: { id: `b-${i}`, kind: 'Lead' }, 对象: '并发', 依据: 'E3', 结果: 'ok' })),
      ]);
      const verified = await g4.audit.verify();
      assert.equal(verified.ok, true, `链不能 fork：${JSON.stringify(verified.broken.slice(0, 3))}`);
      const rows = await g4.audit.read({});
      const seqs = rows.map((r) => r.seq);
      assert.equal(new Set(seqs).size, seqs.length, '并发下 seq 必须唯一');
      assert.equal(seqs.length, 20, `20 条都要落下，实际 ${seqs.length}`);
    } finally {
      await g4.cleanup();
    }
  });

  // ── F3：挂起历史 ────────────────────────────────────────────────────────────

  it('F3 同 id 再次挂起：已裁决的旧档案进 history，不丢裁决历史', async () => {
    const upgrade = new UpgradeManager({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const 条款 = (标题, 正文) => `## ${标题}\n${正文}\n`;
    const 能力相对 = (名) => `集体L2-共享基础设施/能力库/${名}.md`;
    await writeUnder(f.factoryRoot, 能力相对('F3演示'), `${条款('甲', 'v1')}\n`);
    await writeUnder(f.privateRoot, 能力相对('F3演示'), `${条款('甲', 'v1-用户改过')}\n`);
    await upgrade.stamp({ 版本: '1', 对象: ['F3演示'] });
    await writeUnder(f.factoryRoot, 能力相对('F3演示'), `${条款('甲', 'v2')}\n`);
    await upgrade.compare({ 对象: 'F3演示' });
    const first = (await upgrade.pending()).find((p) => p.对象 === 'F3演示');
    assert.ok(first, '第一次应挂起');

    await upgrade.resolve({ subject: SOVEREIGN, id: first.id, 选择: '用我的版', 理由: '保留' });
    // 同一条款再次冲突（出厂又改了）。
    await upgrade.stamp({ 版本: '2', 对象: ['F3演示'] });
    await writeUnder(f.factoryRoot, 能力相对('F3演示'), `${条款('甲', 'v3')}\n`);
    await upgrade.compare({ 对象: 'F3演示' });
    const second = (await upgrade.pending()).find((p) => p.对象 === 'F3演示' && !p.已裁决);
    assert.ok(second, '裁决后的同条款再次冲突应产生新的挂起');
    const history = await readdir(`${f.layout.pendingDir()}/history`);
    assert.ok(history.some((n) => n.startsWith(first.id) && n.includes('已裁决')), `裁决历史要留档，实际：${history.join(',')}`);
  });

  // ── C1 止血：工作台不再给必失败的死命令 ────────────────────────────────────

  it('C1 止血：升级挂起的引导不再给 /mind-guard resolve 死命令', async () => {
    const { projectWorkbench } = await import('../src/workbench.js');
    const view = projectWorkbench({
      项目: 'default',
      节点: [],
      审计尾: [],
      升级挂起: [{ id: 'p-1', 对象: '权限矩阵', 条款: '三档门槛', 可选项: ['用出厂版', '用我的版'] }],
      探针: { 状态: '正常', 结果: [] },
      策略: { healthy: true, 错误: null, 介入度: '零参与', 失联: {} },
      生成于: '2026-10-08T00:00:00Z',
    });
    const 项 = view.待你决定.find((i) => i.类型 === '升级挂起');
    assert.ok(项);
    assert.equal(项.命令, null, '主权者通道未落地前不给命令');
    assert.match(项.说明, /不可达/);
  });
});
