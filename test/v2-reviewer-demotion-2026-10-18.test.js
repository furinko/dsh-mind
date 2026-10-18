/**
 * v2 复核者降级（口述收敛 2026-10-18 条目1/2/5）的回归网。
 *
 * 钉四件事：
 *  ① 「复核者」退出主体清单：SUBJECT_KINDS 无复核者；subjectFor/subjectForRole 对
 *     复核员岗产出 {kind:'成员', roleId:'复核员'}；未知主体仍 fail-closed。
 *  ② 复核免审 = 部署设置全局开关：默认关 ⇒ exemptReview 一律拒（连 Lead/主权者）；
 *     开 ⇒ Lead/主权者可登记、成员仍拒、节点带 复核豁免 字段且 fold 可重建；
 *     非法值（非布尔）⇒ 加载期响亮抛错（fail-closed，与介入度同一把尺）。
 *  ③ 冲突排除硬规则：交卷人 / 负责人不得复核本节点（锁外快拒）；
 *     无冲突复核员复核 ⇒ 过 ⇒ 只出票；Lead 显式采纳后才到已采纳（补修K：采纳权在 Lead）。
 *  ④ 免审是「合法采纳依据」但仍须 Lead 显式采纳：豁免只是标记，不会自动采纳、也不跳过交卷。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { subjectFor } from '../src/org.js';
import { subjectForRole } from '../src/registry.js';
import { SUBJECT_KINDS } from '../src/policy.js';
import { Denied } from '../src/kernel/errors.js';

const P = 'proj-v2demote';

async function 起组织(options) {
  const f = await makeFixture(options);
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

/** 建一个 member-a 已交卷的节点。 */
async function 已交卷节点(org, 描述 = 'v2-演示') {
  const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人: 'member-a', 判据: ['判据一'] });
  await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
  await org.tasks.start(node.id, { subject: MEMBER, 项目: P });
  await org.tasks.submit(node.id, { subject: MEMBER, 项目: P, 结论: '交卷' });
  return node;
}

/** v2 条目6：成员复核需要真实关联（复核任务 + 显式复核对象）。 */
async function 建复核关联(org, 目标id) {
  const 复核任务 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `复核-${目标id}`, 负责人: ['复核员'], 判据: ['核对'], 复核对象: [目标id] });
  await org.tasks.bind(复核任务.id, { subject: LEAD, 项目: P, 实例: 'reviewer', 岗位: '复核员' });
  await org.tasks.dispatch(复核任务.id, { subject: LEAD, 项目: P });
  return 复核任务.id;
}

describe('① 主体清单：复核者退出，复核员=成员 kind + roleId', () => {
  it('SUBJECT_KINDS 恰为五类且不含复核者', () => {
    assert.deepEqual([...SUBJECT_KINDS].sort(), ['Lead', '主权者', '出厂作者', '成员', '系统'].sort());
    assert.ok(!SUBJECT_KINDS.includes('复核者'));
  });
  it('subjectFor / subjectForRole 对复核员岗产出成员主体', () => {
    assert.deepEqual(subjectFor({ 岗位: '复核员', 实例: 'r1' }), { id: 'r1', kind: '成员', roleId: '复核员' });
    assert.deepEqual(subjectForRole('复核员', 'r1'), { id: 'r1', kind: '成员', roleId: '复核员' });
    assert.equal(subjectForRole('Lead', 'l1').kind, 'Lead', 'Lead 直通不变');
  });
});

describe('② 复核免审 = 部署设置全局开关', () => {
  it('默认关 ⇒ exemptReview 一律拒（Lead 也拒），拒因指路设置', async () => {
    const { f, org } = await 起组织();
    try {
      const node = await 已交卷节点(org);
      await assert.rejects(
        () => org.tasks.exemptReview(node.id, { subject: LEAD, 项目: P, 原因: '试试' }),
        (e) => e instanceof Denied && /复核免审/.test(e.rule + e.message),
        '开关默认关 ⇒ 豁免一律拒',
      );
      assert.equal((await org.tasks.get(node.id, { 项目: P })).复核豁免, undefined, '被拒的豁免不落标记');
    } finally { await f.cleanup(); }
  });

  it('开 ⇒ Lead 可登记、成员仍拒、fold 可重建豁免标记', async () => {
    const { f, org } = await 起组织({ defaults: { 复核免审: true } });
    try {
      const node = await 已交卷节点(org);
      await assert.rejects(
        () => org.tasks.exemptReview(node.id, { subject: MEMBER, 项目: P, 原因: '成员没这只手' }),
        (e) => e instanceof Denied && /仅 Lead/.test(e.rule),
        '开关开了成员也碰不到豁免',
      );
      const 豁免 = await org.tasks.exemptReview(node.id, { subject: LEAD, 项目: P, 原因: '主权者明示本件不复核' });
      assert.equal(豁免.复核豁免.豁免原因, '主权者明示本件不复核');
      assert.equal(豁免.状态, '已交卷', '豁免只标记不转移');
      // fold 重建：新会话（重开 Org）从事件流折出同一份豁免标记。
      const org2 = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const 重建 = await org2.tasks.get(node.id, { 项目: P });
      assert.equal(重建.复核豁免.豁免原因, '主权者明示本件不复核', 'fold 重建豁免标记（无授权引用字段）');
      assert.equal(重建.复核豁免.授权引用, undefined);
    } finally { await f.cleanup(); }
  });

  it('非法值（非布尔）⇒ 加载失败：reload 失败、引擎不健康、写动作 fail-closed', async () => {
    // reload 的既有语义：加载错误不响亮抛出，而是把引擎标记为不健康（返回 false），
    // 之后所有写判定统一走 Fault（POLICY_NOT_LOADED）——fail-closed 的落点。
    const f = await makeFixture({ defaults: { 复核免审: 'yes' } });
    try {
      const ok = await f.policy.reload();
      assert.equal(ok, false, '坏值 ⇒ reload 失败');
      assert.equal(f.policy.healthy, false, '引擎标记不健康');
      assert.match(String(f.policy.state?.error), /复核免审/, '失败原因点名复核免审');
      const d = await f.policy.decide({ subject: LEAD, action: 'write', target: { id: 'x', kind: '任务', authority: '自治' } });
      assert.notEqual(d.verdict, 'allow', '引擎不健康 ⇒ 写动作 fail-closed');
    } finally { await f.cleanup(); }
  });
});

describe('③ 冲突排除硬规则（v2 条目2）', () => {
  it('交卷人不得复核；负责人（未交卷的）同样不得复核；无冲突复核员 ⇒ 过 ⇒ 已采纳', async () => {
    const { f, org } = await 起组织();
    try {
      // 交卷人：member-a 交卷 ⇒ member-a 复核 ⇒ 拒（§3.4 既有面，锁外）。
      const a = await 已交卷节点(org, '冲突-交卷人');
      await assert.rejects(
        () => org.tasks.review(a.id, { subject: MEMBER, 项目: P, 三态: '过' }),
        (e) => e instanceof Denied && /交卷人/.test(e.rule),
      );
      // 负责人但未交卷（v2 新增面）：一岗多人（并行分担）——member-a 交卷，
      // member-b 是负责人但没交卷；Lead 代录 member-b 的结论 ⇒ 负责人排除先拦。
      const b = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '冲突-负责人', 负责人: ['member-a', 'member-b'], 模式: '并行分担', 判据: ['x'] });
      await org.tasks.dispatch(b.id, { subject: LEAD, 项目: P });
      await org.tasks.start(b.id, { subject: MEMBER, 项目: P });
      await org.tasks.submit(b.id, { subject: MEMBER, 项目: P, 结论: '成员交的卷' });
      await assert.rejects(
        () => org.tasks.review(b.id, { subject: LEAD, 项目: P, 三态: '过', 复核者: 'member-b' }),
        (e) => e instanceof Denied && /负责人不得复核/.test(e.rule),
        '负责人（哪怕没亲自交卷）复核自己的任务 ⇒ 拒',
      );
      // 无冲突复核员：复核 ⇒ 过 ⇒ 出票（不自动采纳）；Lead 显式采纳后才到已采纳。
      const c = await 已交卷节点(org, '冲突-对照');
      await 建复核关联(org, c.id);
      const ok = await org.tasks.review(c.id, { subject: REVIEWER, 项目: P, 三态: '过', 分歧清单: [] });
      assert.equal(ok.状态, '已交卷', '补修K：复核「过」不自动采纳');
      const 采纳 = await org.tasks.accept(c.id, { subject: LEAD, 项目: P, 票: ok.待采纳?.票 });
      assert.equal(采纳.状态, '已采纳');
    } finally { await f.cleanup(); }
  });

  it('④ 免审是「合法采纳依据」，但仍须 Lead 显式采纳（不自动、不跳过交卷）', async () => {
    const { f, org } = await 起组织({ defaults: { 复核免审: true } });
    try {
      const node = await 已交卷节点(org);
      await org.tasks.exemptReview(node.id, { subject: LEAD, 项目: P, 原因: '豁免演示' });
      // 免审 ≠ 自动采纳：节点仍在已交卷，settle 照拒（状态机：settle 只从已采纳出发）。
      await assert.rejects(
        () => org.tasks.settle(node.id, { subject: LEAD, 项目: P, 记忆处置: {} }),
        (e) => e instanceof Denied && /已采纳/.test(e.message),
        '免审不给「自动采纳」开口子（补修K：采纳另走 task_accept）',
      );
      // Lead 显式采纳：依据=复核免审，引用豁免事件（ex-N），不伪造复核票。
      const 采纳 = await org.tasks.accept(node.id, { subject: LEAD, 项目: P });
      assert.equal(采纳.状态, '已采纳');
      assert.equal(采纳.采纳?.依据, '复核免审');
      assert.equal(采纳.采纳?.票, null, '免审不引复核票');
      assert.match(String(采纳.采纳?.豁免), /^ex-\d+$/, '免审引豁免事件（可追）');
    } finally { await f.cleanup(); }
  });
});
