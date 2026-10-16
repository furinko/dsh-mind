/**
 * 任务上下文透传修复（task-修复-lib-actions-j-649a4 · 判据①② · 2026-10-13）。
 *
 * 撞墙证据（修前复现，TEMP 脚本实测，原始拒因）：
 *  ① capability_publish：成员带 任务=<名下节点id> 发卡 ⇒ Denied「法律 权限矩阵 · 自治档
 *     （任务外无）：成员在任务外无权限：本次调用未声明任务上下文（task 为空）」——
 *     断点两处：lib/actions.js handler 不透传 args.任务；src/capability.js publish 不把
 *     任务转交 store.write 的 spec.task（store.write 本就支持）。
 *  ② task_review：复核员岗成员（teammate 主体 kind=成员，岗位在档案）落复核结论 ⇒ 同一规则拒
 *     ——tasks.review 的策略判定需要复核者主体形状，成员主体过不了。
 *
 * 修复：① handler 经「取任务上下文」取真节点 → capability.publish 透传 → store.write spec.task；
 *  ② task_review handler 按**身份档案真源**把复核员岗成员解析成复核者主体（registry.subjectForRole
 *  唯一映射落点，与缺口4 同族：只信档案、不信自报），仍走策略引擎（§2 复核者 review 放行）。
 *  【2026-10-16 演进】②的解析已从 task_review 单点上移至 runAction 门②（审查报告 R02 收口，
 *  见 test/review-path-2026-10-16.test.js）；本文件 ② 用例照跑（到达 handler 的主体已是复核者
 *  形状），原「解析只在 review 放行」断言已按新语义改写（见下）。
 *
 * 判据2 · 同族全量排查（逐 handler 结论，本文件头部钉存；「不改」均给出理由）：
 *  - status / workbench / policy_check / audit_tail / audit_verify / audit_correct /
 *    registry_list / registry_can / upgrade_pending / review_zero：只读或 Lead/主权者专属入口，
 *    无成员任务内写语义 ⇒ 无需任务上下文（不改）。
 *  - task_create / task_reassign / task_dispatch / task_settle：排兵/收尾动作，宪章 §3.5 与
 *    settle 闸限 Lead ⇒ 成员不可达，无需任务上下文（不改）。
 *  - task_start / task_submit / task_pending / task_resolve：服务层（src/tasks.js #checkWrite）
 *    自建 context {task: node}（节点本体由 id 取出）⇒ 无断点（不改）。
 *  - task_review：本批修（复核者主体档案解析）。
 *  - memory_write / memory_lifecycle(invalidate/demote/overturn)：已透传（7lot2，不改）；
 *    purge/promote 不透传是设计（物理删除/晋升不属任务内全权）。
 *  - memory_query / memory_lineage：只读，read 不受「任务外无」限（不改）。
 *  - capability_list / capability_resolve / capability_read：只读（resolve 过判定记汇总）⇒ 不改。
 *  - capability_publish：本批修（handler 透传 + capability.publish 转交 store.write）。
 *  - bus_send / bus_read：消息是只增对象（authority=只增，create 放行），线程归属由
 *    「拒他人任务线程」闸自守（actions.js ㉖）⇒ 无任务上下文断点（不改）。
 *  - debate_open / debate_say / debate_round / debate_converge：say 走 bus.send 只增路；
 *    round/converge 仅 Lead（runAction 门①）；open 的候选预检走 bus.canWrite 同款判定 ⇒ 不改。
 *  - registry_assign / registry_seal / registry_revoke：身份档动作，Lead/主权者路径
 *    （复核员任命另需授权引用，10th0 已加）⇒ 无任务内语义（不改）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, writeUnder } from './helpers.mjs';
import { runAction } from '../lib/actions.js';
import { Org } from '../src/org.js';
import { Denied } from '../src/kernel/errors.js';

const P = 'proj-taskctx-649a4';

/** 岗位卡（私有区）。 */
const 岗位卡 = (id) => [
  '---', `id: ${id}`, 'kind: 身份', 'authority: 自治', 'zone: 私有', 'domain: 个体', 'version: 1', '---',
  `# ${id}`, '', '## 个体L0 · 身份', `${id} 岗。`, '',
  '## 个体L1 · 规则', '先搜后写。', '',
  '## 个体L2 · 能力', '- 无', '',
  '## 个体L3 · 经验', '- 无',
].join('\n');

/** 夹具默认 members 里已有 reviewer（复核员·在岗）——用 kind=成员 主体模拟 teammate 复核员。 */
const 成员A = { id: 'member-a', kind: '成员', roleId: '插件工程' };
const 成员B = { id: 'member-b', kind: '成员', roleId: '插件工程' };
const 复核员成员 = { id: 'reviewer', kind: '成员' };

describe('任务上下文透传（649a4）', () => {
  let f;
  let org;

  before(async () => {
    f = await makeFixture();
    await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('插件工程'));
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  });
  after(async () => {
    await f.cleanup();
  });

  /** 建一个 member-a 名下、已派发的节点。 */
  const 建节点 = async (描述) => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人: 'member-a', 判据: ['判据一'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    return node;
  };

  it('① capability_publish：成员带「任务」上下文发卡成功（过策略引擎）；不带 ⇒ 仍拒', async () => {
    const node = await 建节点('pub-任务内发卡');
    // 反向对照：不带任务 ⇒ 修后照旧拒（不放宽）。
    await assert.rejects(
      () => runAction({ org, 项目: P, 主体: 成员A, args: { action: 'capability_publish', 名: 'noctx卡', 正文: 'x', 适用岗位: ['插件工程'], 依据: '任务内产出' } }),
      (e) => e instanceof Denied && /任务外无/.test(e.rule),
      '不带任务上下文 ⇒ 照旧「任务外无」拒（闸的方向不变）',
    );
    // 正向：带任务 ⇒ 全链路透传到 store.write 的策略判定，放行。
    const r = await runAction({ org, 项目: P, 主体: 成员A, args: { action: 'capability_publish', 名: 'taskctx卡', 正文: '怎么做：先搜后写。', 适用岗位: ['插件工程'], 依据: '任务内产出', 任务: node.id } });
    assert.equal(r.能力.来源, '自治');
    assert.ok(r.能力.version >= 1);
    // 传别人的节点 ⇒ scopeOf 拒（自报 id 不承重）。
    const node2 = await org.tasks.create({ subject: LEAD, 项目: P, 描述: 'pub-他人节点', 负责人: 'member-b', 判据: ['判据一'] });
    await org.tasks.dispatch(node2.id, { subject: LEAD, 项目: P });
    await assert.rejects(
      () => runAction({ org, 项目: P, 主体: 成员A, args: { action: 'capability_publish', 名: 'stolen卡', 正文: 'x', 适用岗位: ['插件工程'], 依据: '任务内产出', 任务: node2.id } }),
      (e) => e instanceof Denied && /负责人是/.test(e.message),
      '传别人的节点 ⇒ 负责人名单比对拒',
    );
  });

  it('② task_review：复核员岗成员（kind=成员）自己落结论成功；普通成员仍拒；解析只在 review 放行', async () => {
    const node = await 建节点('rev-复核员自落');
    await org.tasks.start(node.id, { subject: 成员A, 项目: P });
    await org.tasks.submit(node.id, { subject: 成员A, 项目: P, 结论: '交卷' });
    // 普通成员 review ⇒ 照旧拒（任务外无——成员主体不在复核者形状，也不在负责人名单的复核语义里）。
    await assert.rejects(
      () => runAction({ org, 项目: P, 主体: 成员B, args: { action: 'task_review', id: node.id, 三态: '过' } }),
      (e) => e instanceof Denied,
      '普通成员复核照旧拒（不放宽）',
    );
    // 复核员岗成员（teammate 形状）⇒ 档案解析成复核者主体，策略引擎放行 review。
    const r = await runAction({ org, 项目: P, 主体: 复核员成员, args: { action: 'task_review', id: node.id, 三态: '过', 分歧清单: [] } });
    assert.equal(r.结论.三态, '过');
    assert.equal(r.结论.算通过, true);
    const after = await org.tasks.get(node.id, { 项目: P });
    assert.equal(after.状态, '已采纳', '复核「过」把节点推到已采纳');
    assert.equal(after.复核经过?.[0]?.复核者, 'reviewer', '署名是复核者本人');
    // 解析已收口到 runAction 门②（审查报告 R02 · 2026-10-16，dv2jf 批）：同一复核员成员的
    // 其余写动作按【复核者】判 ⇒ 复核者只读守卫拒。修前这里是「任务外无」——那正是 R02
    // 实证的越权面：复核员岗成员持负责人匹配任务即得普通业务写权。断言随语义演进改写，
    // 不是偷偷删红：拒得更早、更对（§2 复核者只读数、不改、不参与提案）。
    await assert.rejects(
      () => runAction({ org, 项目: P, 主体: 复核员成员, args: { action: 'memory_write', 类: '知识', 内容: 'x', 来源: '测试', project: P } }),
      (e) => e instanceof Denied && /复核者只读/.test(e.rule),
      '复核者只读守卫在动作入口生效（其余写动作按复核者判）',
    );
  });

  it('③ 复核员解析只信档案真源：不在册/不在岗/别的岗位 ⇒ 原样成员主体照拒', async () => {
    const node = await 建节点('rev-解析边界');
    await org.tasks.start(node.id, { subject: 成员A, 项目: P });
    await org.tasks.submit(node.id, { subject: 成员A, 项目: P, 结论: '交卷' });
    // member-b 自报 role=复核员（args.role 也不参与）⇒ 档案里是插件工程 ⇒ 照拒。
    await assert.rejects(
      () => runAction({ org, 项目: P, 主体: { id: 'member-b', kind: '成员', roleId: '复核员' }, args: { action: 'task_review', id: node.id, 三态: '过', role: '复核员' } }),
      (e) => e instanceof Denied,
      '自报复核员不算数——解析只读身份档案',
    );
  });
});
