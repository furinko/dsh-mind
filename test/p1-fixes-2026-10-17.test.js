/**
 * 全面审查 P1 修复回归（2026-10-17）。
 *
 * 覆盖：
 *  P1-01 purge 意图先行（坏审计 ⇒ 不动盘；正常 ⇒ 意图 + 完成两行）
 *  P1-02 打回后无新交卷不得 review(过)
 *  P1-03 坏 identity ⇒ decide 返回 fail-closed 结论、引擎不健康、故障入账
 *  P1-04 闸在位探针：回执缺失/未确认 ⇒ 红；显式无内核装配才是绿
 *  P1-05 allow grant 不得越过复核者只读 / 逐条审批
 *  P1-07 member_spawn 不得收编独立会审/已登记负责人
 *  P1-08 锚月枚举按 Layout.auditAnchor 命名（孤立锚必须见红）
 *  P1-13 registry_assign 缺实例必须拒，且不写 members["undefined"]
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { makeFixture, writeUnder, LEAD, MEMBER, REVIEWER, seedLegacyIndependentCouncil } from './helpers.mjs';
import { Org } from '../src/org.js';
import { ProbeRunner } from '../src/probes.js';
import { runAction } from '../lib/actions.js';
import { 盲标分配 } from '../src/review.js';
import { fakeHost } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';
import { appendLines } from '../src/kernel/fsx.js';
import { basename, join } from 'node:path';

const P = 'p1-fixes';
const 岗位卡 = '集体L3-成员角色卡/插件工程.md';
const 岗位卡正文 = '---\nid: 插件工程\nkind: 身份\nauthority: 自治\nzone: 出厂\ndomain: 个体\nversion: 1\n---\n# 插件工程\n\n## 个体L0 · 身份\n成员岗。\n\n## 个体L1 · 规则\n单源。\n\n## 个体L2 · 能力\n（引用）\n\n## 个体L3 · 经验\n（引用）\n';

async function 起组织(extra = {}) {
  const f = await makeFixture({ rules: { [岗位卡]: 岗位卡正文 }, ...extra });
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

describe('P1-01 purge 意图先行', () => {
  it('坏审计 ⇒ 意图先失败、内容不抹；正常 ⇒ 意图 + 完成两行', async () => {
    const { f, org } = await 起组织();
    try {
      const r = await org.memory.remember({ subject: LEAD, 类: '知识', 内容: 'P1-01 可删内容', 来源: '回归', 项目: P });
      const 账本 = org.layout.memoryLog(P, '知识');
      const 条目行 = () => readFileSync(账本, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).filter((x) => x.id === r.id).length;

      // 坏月份清单：意图审计落不下去 ⇒ 必须不动盘
      await f.writePrivate('集体L2-共享基础设施/审计日志/月份清单.json', '{坏 JSON');
      await assert.rejects(() => org.memory.purge(r.id, { subject: LEAD, 理由: '敏感回归', 敏感: true }), /月份清单损坏/);
      assert.equal(条目行(), 1, '意图审计失败时内容必须还在（先想后做）');

      // 修好清单：正常路径两行都在
      await f.writePrivate('集体L2-共享基础设施/审计日志/月份清单.json', JSON.stringify({ months: ['2026-10'], checkpoints: {} }));
      await org.audit.append({ 动作: '测试占位', 主体: LEAD, 对象: { id: 'x', kind: '账目' }, 依据: '回归', 结果: 'ok' }).catch(() => {});
      await org.memory.purge(r.id, { subject: LEAD, 理由: '敏感回归', 敏感: true });
      const rows = await f.audit.read({});
      assert.ok(rows.some((x) => x.动作 === '不可逆操作意图'), '必须有意图行');
      assert.ok(rows.some((x) => x.动作 === '不可逆操作'), '必须有完成行');
      assert.equal(条目行(), 0, '完成后内容已抹');
    } finally { await f.cleanup(); }
  });
});

describe('P1-02 打回后证据在场', () => {
  it('打回后不交新卷不能 review(过)；返工交卷后可过', async () => {
    const { f, org } = await 起组织();
    try {
      const n = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '返工闸', 负责人: ['member-a'], 判据: ['判据甲'] });
      await org.tasks.dispatch(n.id, { subject: LEAD, 项目: P });
      await org.tasks.start(n.id, { subject: MEMBER, 项目: P });
      await org.tasks.submit(n.id, { subject: MEMBER, 项目: P, 结论: 'v1', 结论层: 'A' });
      await org.tasks.review(n.id, { subject: LEAD, 项目: P, 三态: '不过', 分歧清单: ['重做'] });
      await assert.rejects(() => org.tasks.review(n.id, { subject: LEAD, 项目: P, 三态: '过' }), (e) => e.name === 'Denied' && /已打回且当前代没有独立答案/.test(e.message));
      await org.tasks.start(n.id, { subject: MEMBER, 项目: P });
      await org.tasks.submit(n.id, { subject: MEMBER, 项目: P, 结论: 'v2', 结论层: 'A' });
      const r = await org.tasks.review(n.id, { subject: LEAD, 项目: P, 三态: '过' });
      // 补修K：复核「过」只出票、不自动采纳；采纳是 Lead 的独立一步（引用真票）。
      assert.equal(r.状态, '已交卷', '复核「过」不自动采纳');
      const 采纳 = await org.tasks.accept(n.id, { subject: LEAD, 项目: P, 票: r.待采纳?.票 });
      assert.equal(采纳.状态, '已采纳');
    } finally { await f.cleanup(); }
  });
});

describe('P1-03 坏身份档案 fail-closed', () => {
  it('decide 不抛原始异常；引擎不健康；故障入账；探针会看到不健康', async () => {
    const { f, org } = await 起组织();
    try {
      await f.writePrivate('身份档案/identity.json', '{这不是 JSON');
      const d = await org.policy.decide({ subject: LEAD, action: 'read', target: { id: 'k', kind: '知识', authority: '只增' } });
      assert.equal(d.verdict, 'deny', '失败必须是可执行的拒绝决定');
      assert.equal(d.alarm, true, '故障决定必须带告警');
      assert.equal(org.policy.describe().healthy, false, '引擎必须如实不健康');
      const rows = await f.audit.read({});
      assert.ok(rows.some((x) => /安全闸故障/.test(String(x.动作)) || x.告警 === true), '故障必须入账');
    } finally { await f.cleanup(); }
  });
});

describe('P1-04 闸在位探针未知态', () => {
  it('回执缺失/未确认见红；双闸严格 true 才绿；纯夹具显式 opt-in', async () => {
    const f = await makeFixture({ 无内核装配: true });
    const 探针 = (extra = {}) => new ProbeRunner({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, ...extra });
    try {
      const 无回执 = await 探针().run({ subject: LEAD });
      const g1 = 无回执.结果.find((r) => r.探针 === '闸在位');
      assert.equal(g1.状态, '红', '真实装配下回执缺失 = 未知，不许绿');
      assert.match(g1.详情, /回执缺失|无法证明/);

      const 回执路径 = '集体L2-共享基础设施/defaults/工具闸回执.json';
      await writeUnder(f.privateRoot, 回执路径, JSON.stringify({ 范围闸: { registered: true }, 调度创建闸: { registered: null } }));
      const 未确认 = await 探针().run({ subject: LEAD });
      assert.equal(未确认.结果.find((r) => r.探针 === '闸在位').状态, '红');
      assert.match(未确认.结果.find((r) => r.探针 === '闸在位').详情, /未确认|registered=null/);

      await writeUnder(f.privateRoot, 回执路径, JSON.stringify({ 范围闸: { registered: true }, 调度创建闸: { registered: true } }));
      const 双绿 = await 探针().run({ subject: LEAD });
      assert.equal(双绿.结果.find((r) => r.探针 === '闸在位').状态, '绿');

      const 纯夹具 = await 探针({ 无内核装配: true }).run({ subject: LEAD });
      assert.equal(纯夹具.结果.find((r) => r.探针 === '闸在位').状态, '绿', '显式无内核装配才是绿');
    } finally { await f.cleanup(); }
  });
});

describe('P1-05 授权块不得越过结构性边界', () => {
  const 私有矩阵 = (grant) => `---\nid: 权限矩阵\nkind: 规则\nauthority: 法律\nzone: 私有\ndomain: 集体\nversion: 2\n---\n\n<!-- authority: 法律 -->\n## 作业细则\n\n\`\`\`policy\n${JSON.stringify({ grants: [grant] })}\n\`\`\`\n`;
  it('审批档下 member write allow grant 仍是 confirm', async () => {
    const f = await makeFixture({
      defaults: { 介入度: '审批' },
      rules: { [岗位卡]: 岗位卡正文 },
      privateFiles: { '集体L1-法律/权限矩阵.md': 私有矩阵({ subject: '成员', action: 'write', authority: '自治', verdict: 'allow' }) },
    });
    try {
      const d = await f.policy.decide({
        subject: MEMBER, action: 'write', target: { id: 'k', kind: '知识', authority: '自治', zone: '私有' },
        context: { task: { 负责人: ['member-a'], 状态: '执行中' } },
      });
      assert.equal(d.verdict, 'confirm', '介入度 confirm 必须先于 grant');
      // 成员已有委派父（默认夹具真钉）⇒ v2 条目20 父判把父的 confirm 门槛传播上来，
      // 结论仍是 confirm（不是 allow）；两条规则名都表示「结构性边界先于授权块」。
      assert.match(d.rule, /审批|不越授/);
    } finally { await f.cleanup(); }
  });
  it('复核员 write allow grant 仍 deny（v2：边界按岗位名判，grant 按 kind 命中也翻不动）', async () => {
    const f = await makeFixture({
      rules: { [岗位卡]: 岗位卡正文 },
      privateFiles: { '集体L1-法律/权限矩阵.md': 私有矩阵({ subject: '成员', action: 'write', authority: '自治', verdict: 'allow' }) },
    });
    try {
      const d = await f.policy.decide({ subject: REVIEWER, action: 'write', target: { id: 't', kind: '任务', authority: '自治' } });
      assert.equal(d.verdict, 'deny');
      assert.match(d.rule, /只读数/);
    } finally { await f.cleanup(); }
  });
});

describe('P1-07 member_spawn 多负责人', () => {
  it('多负责人（v2 只剩并行分担）/ 已登记负责人节点在起执行体之前被拒', async () => {
    const { f, org } = await 起组织();
    try {
      const 会审 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '多负责人', 负责人: ['插件工程', '文档整理'], 判据: ['判据甲'] });
      const 宿主 = { agent: { id: 'lead-agent' }, delegation: { authorize: () => ({ fingerprint: 'x' }) } };
      await assert.rejects(
        () => runAction({ org, 项目: P, 主体: LEAD, subject: LEAD, args: { action: 'member_spawn', 方式: 'team', 岗位: '插件工程', 节点: 会审.id, 任务书: 'x' }, 宿主 }),
        (e) => e.name === 'InvalidBody' && /2 位负责人/.test(e.message) && /并行分担/.test(e.message),
        'v2 删了任务「模式」，多负责人闸改为按人数判：spawn 会把负责人收成单实例',
      );
      const 实例节点 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '已登记负责人', 负责人: ['member-a'], 判据: ['判据甲'] });
      await assert.rejects(
        () => runAction({ org, 项目: P, 主体: LEAD, subject: LEAD, args: { action: 'member_spawn', 方式: 'team', 岗位: '插件工程', 节点: 实例节点.id, 任务书: 'x' }, 宿主 }),
        (e) => e.name === 'InvalidBody' && /已登记实例/.test(e.message),
      );
    } finally { await f.cleanup(); }
  });
});

describe('P1-08 锚月枚举', () => {
  it('只有锚、没有日志的月份必须报分片缺失', async () => {
    const f = await makeFixture();
    try {
      await writeUnder(f.layout.auditDir(), '.anchor-2026-01.json', JSON.stringify({ seq: 1, hash: 'deadbeef', at: '2026-01-31T23:59:59Z' }));
      const v = await f.audit.verify();
      assert.ok(v.broken.some((b) => /分片缺失/.test(String(b.类型))), `孤立锚必须见红，实际 ${JSON.stringify(v.broken)}`);
    } finally { await f.cleanup(); }
  });
});

describe('P1-09 盲标单源', () => {
  it('总线读面与 review.盲标分配 同标（未交齐、未揭名）', async () => {
    const 成员 = (id) => ({ id, 岗位: '插件工程', 代: 1, status: '在岗' });
    const { f, org } = await 起组织({
      members: { 'member-a': 成员('member-a'), 'member-b': 成员('member-b'), 'member-c': 成员('member-c') },
    });
    try {
      // v2 删了任务「模式」写入路径：总线盲评遮罩只服务历史账本 ⇒ 按旧形状播种。
      const n = { id: await seedLegacyIndependentCouncil(f, { 项目: P, 负责人: ['member-a', 'member-b', 'member-c'], 描述: '盲标单源' }) };
      const 甲 = { id: 'member-a', kind: '成员' };
      const 乙 = { id: 'member-b', kind: '成员' };
      // v2 起旧独立会审整体只读：答案按历史账本形状直接播种（不再经 start/submit 写入口）。
      const at = new Date().toISOString();
      await appendLines(f.layout.taskLog(P), [
        { seq: 9001, at, by: { id: 'member-a', kind: '成员' }, kind: 'submitted', id: n.id, 状态: '已交卷', 产出物引用: [], 结论: 'member-a 卷', 结论层: 'A', 反例面: [], 知识候选: [] },
        { seq: 9002, at, by: { id: 'member-b', kind: '成员' }, kind: 'submitted', id: n.id, 状态: '已交卷', 产出物引用: [], 结论: 'member-b 卷', 结论层: 'A', 反例面: [], 知识候选: [] },
      ]);
      void 甲; void 乙;
      // 2/3 未齐：遮罩生效。选一个「确定性置换后不是成员 A」的发送者：
      // 旧实现按消息到达顺序发 A，对这位发送者必错；新实现必须与 review.盲标分配 同标。
      const 标 = new Map(盲标分配(n.id, ['member-a', 'member-b']).map((e) => [e.id, e.盲标]));
      const 发送者 = ['member-a', 'member-b'].find((id) => 标.get(id) !== '成员 A');
      const 读者 = ['member-a', 'member-b'].find((id) => id !== 发送者);
      assert.ok(发送者 && 读者, '前提：两个已交卷成员里必有一个非 A 标');
      // v2 旧独立会审已封写：遮罩是**读面**契约，按历史账本形状直接播种一条消息（不经过已封闭的写入口）。
      await appendLines(f.layout.busThread(P, n.id), [{
        id: `msg-blind-${Date.now().toString(36)}`,
        线程: n.id,
        发件: 发送者,
        收件: [],
        类型: '表态',
        内容: '发送者说一句',
        状态: '已投递',
        延后: false,
        引用: null,
        追加于: new Date().toISOString(),
      }]);
      const 读 = await runAction({ org, 项目: P, subject: { id: 读者, kind: '成员' }, 主体: { id: 读者, kind: '成员' }, args: { action: 'bus_read', 线程: n.id } });
      const 消息 = 读.消息 ?? [];
      assert.equal(消息.length, 1, `读者应读到 1 条消息，实际 ${消息.length}`);
      assert.equal(消息[0].发件, 标.get(发送者), `总线遮罩必须用 review.盲标分配：期望 ${标.get(发送者)}，实际 ${消息[0].发件}`);
      assert.equal(消息[0].内容.includes('发送者说一句'), false, '遮罩期内容不可见');
    } finally { await f.cleanup(); }
  });
});

describe('P1-12 命令面宿主服务形状', () => {
  it('/mind member_list 与工具面看到同一名册（Team 行不被丢）', async () => {
    const f = await makeFixture({ rules: { [岗位卡]: 岗位卡正文 } });
    try {
      let currentCwd = process.cwd();
      const agent = { id: 's-cmd', session: { id: 's-cmd', header: { id: 's-cmd', cwd: process.cwd() } } };
      const host = fakeHost({
        提供服务: ['tools', 'commands', 'systemPrompt', 'connection', 'agentTeams', 'subagents', 'agents', 'workingDirectory'],
        服务: {
          workingDirectory: { get: () => currentCwd },
          agents: { get: id => id === agent.id ? agent : undefined },
          connection: { requestRejection: () => undefined },
          agentTeams: {
            listMembers: () => [{ id: 'team-1', name: 'member-x', role: 'teammate', status: 'running' }],
            spawnTeammate: async () => ({ member: { id: 'team-1', name: 'member-x' } }),
            sendMessage: async () => ({}),
          },
          subagents: { startActivation: async () => ({ childId: 'sub-1' }), sendMessage: async () => ({}), listChildren: async () => [] },
        },
      });
      await kernel.apply(host.ctx, {
        home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot,
        delegation: { mode: 'lead-discretion', projects: [basename(process.cwd())], authorizationRef: 'p1-12' },
      });
      const invoke = async args => {
        const result = JSON.parse(await host.工具.get('mind').execute(args, { name: 'mind', agent }));
        assert.equal(result.成功, true, JSON.stringify(result));
        return result;
      };
      await invoke({ action: 'registry_assign', 岗位: '插件工程', 实例: 'team-1' });
      const task = (await invoke({ action: 'task_create', 描述: '真实任务名册', 负责人: '插件工程', 判据: '命令工具同形' })).节点;
      await invoke({ action: 'task_bind', id: task.id, 实例: 'team-1', 岗位: '插件工程' });
      await invoke({ action: 'task_dispatch', id: task.id });
      const 命令 = JSON.parse((await host.命令.get('mind').handler({ agent, rawInput: 'member_list' })).text);
      const 工具 = JSON.parse(await host.工具.get('mind').execute({ action: 'member_list' }, { name: 'mind', agent }));
      assert.equal(命令.成员.length, 工具.成员.length, `命令面 ${命令.成员.length} vs 工具面 ${工具.成员.length}`);
      assert.ok(命令.成员.some((m) => m.来源 === 'team' && m.实例 === 'team-1'), '命令面不得丢 Team 行');
      const cross = JSON.parse(await host.工具.get('mind').execute({ action: 'member_list', project: 'foreign-project' }, { name: 'mind', agent }));
      assert.equal(cross.成功, false, '真实工具面不得用args.project同时覆盖会话项目形成同值假正控');
      assert.match(cross.理由, /跨项目|会话项目/);
      currentCwd = join(process.cwd(), 'changed-workspace');
      const changed = JSON.parse(await host.工具.get('mind').execute({ action: 'member_list' }, { name: 'mind', agent }));
      assert.equal(changed.成功, false, '提交的workingDirectory变化优先于旧header.cwd');
      assert.match(changed.理由, /跨项目|会话项目/);
    } finally { await f.cleanup(); }
  });
});

describe('P1-13 registry_assign 实例校验', () => {
  it('省略实例 ⇒ InvalidBody，且身份档案不出现 undefined 键', async () => {
    const { f, org } = await 起组织();
    try {
      await assert.rejects(() => org.registry.assign({ subject: LEAD, 岗位: '插件工程' }), (e) => e.name === 'InvalidBody' && /实例/.test(e.message));
      const id = await org.registry.identity();
      assert.equal(Object.hasOwn(id.members, 'undefined'), false);
    } finally { await f.cleanup(); }
  });
});
