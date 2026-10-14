/**
 * 复核员任命闭环 G1-G4（交接件《复核员任命闭环缺口-2026-10-14》· task-接交接件-复核员任命闭环缺口-2-r6wr8）。
 *
 * 交接件定案的缺口与 本文件钉死的判据 一一对应：
 *  G1「提名没有机制承载」（Lead 只能发总线消息，seq 478 那条连收件人都为空）：
 *   ① 两向·正向：Lead 提名已交卷节点 ⇒ 节点转待决（待决类型=复核提名）+ 复核提名记录 + 进 snapshot 待决队列；
 *   ② 两向·反向：同样交卷但不提名 ⇒ 不出现上述任何一项；
 *   ③ 提名 ≠ 任命：提名后身份档案里没有该候选（本动作不触碰 registry_assign——4yuxq 定案）；
 *   ④ 资格闸：成员/复核者提名 ⇒ 拒（仅 Lead）；候选是本节点交卷人 ⇒ 拒（§3.4 提审分离）；
 *      复核窗口外（执行中）提名 ⇒ 拒（状态机）；
 *   ⑤ 环路恢复：主权者侧 resolve 后节点回到已交卷，未交卷主体可照常 review；
 *  G3「在册 ≠ 活着，且无一手判活手段」：
 *   ⑥ 两向：registry_list 实例读数带 最近活动于/活动条数（从审计链现算）——
 *      账上有行 ⇒ 给出时刻（与账本逐条对得上）；无行 ⇒ null 且 status 仍报在岗（无活动 ≠ 不在岗）；
 *  G4「豁免无处登记」：
 *   ⑦ 两向：Lead 带授权引用 ⇒ 节点复核豁免字段可查询可统计；空授权 ⇒ 拒；成员 ⇒ 拒；
 *  重放：fold 纯函数从事件流重建 复核提名记录/复核豁免（状态权威 = 事件流，§12.4）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, writeUnder, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { runAction } from '../lib/actions.js';
import { Org } from '../src/org.js';
import { fold } from '../src/tasks.js';
import { Denied } from '../src/kernel/errors.js';

const P = 'proj-review-appointment';

/** 走完 受理→派发→执行→交卷，返回节点 id（member-a 交卷）。 */
async function 交卷节点(org, 描述) {
  const { id } = await org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人: 'member-a', 判据: ['判据一'], 模式: '并行分担' });
  await org.tasks.dispatch(id, { subject: LEAD, 项目: P });
  await org.tasks.start(id, { subject: MEMBER, 项目: P });
  await org.tasks.submit(id, { subject: MEMBER, 项目: P, 结论: '交了' });
  return id;
}

describe('G1 · 复核提名进任务图（nominateReview）', () => {
  let f;
  let org;
  let 节点A;

  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    节点A = await 交卷节点(org, '节点A-提名后任命复核');
  });
  after(async () => {
    await f.cleanup();
  });

  it('① 两向·正向：Lead 提名 ⇒ 节点转待决（复核提名）+ 提名记录 + 进 snapshot 待决队列', async () => {
    const 节点 = await org.tasks.nominateReview(节点A, { subject: LEAD, 项目: P, 候选: 'reviewer', 原因: '首轮交付需要独立复核' });
    assert.equal(节点.状态, '待决', '提名把节点挂起等主权者任命');
    assert.equal(节点.待决类型, '复核提名');
    assert.equal(节点.复核提名记录.length, 1);
    assert.equal(节点.复核提名记录[0].候选, 'reviewer');
    assert.equal(节点.复核提名记录[0].提名人, 'lead');
    // 进主权者决策队列：snapshot 的待决面看得见（这是「不保证被看见」缺口的正解）。
    const 快照 = await org.tasks.snapshot({ 项目: P });
    assert.ok(快照.待决.some((n) => n.id === 节点A), '提名节点必须出现在待决队列（workbench 供主权者决策的面）');
    // 审计有痕：事件 kind 与动作名都进链。
    const rows = await org.audit.read({});
    assert.ok(rows.some((r) => r.结果 === 'review_nominated' && r.对象?.id === 节点A), '审计链要有 review_nominated 一条');
  });

  it('② 两向·反向：同样交卷但不提名 ⇒ 无待决、无提名记录', async () => {
    const 节点B = await 交卷节点(org, '节点B-不提名对照');
    const 节点 = await org.tasks.get(节点B, { 项目: P });
    assert.equal(节点.状态, '已交卷', '不提名 ⇒ 节点照常停在已交卷，不产生待决');
    assert.equal(节点.复核提名记录, undefined, '不提名 ⇒ 没有复核提名记录');
    assert.ok(!(await org.tasks.snapshot({ 项目: P })).待决.some((n) => n.id === 节点B));
  });

  it('③ 提名 ≠ 任命：提名后身份档案里没有该候选（不触碰 registry_assign）', async () => {
    const 节点B = await 交卷节点(org, '节点C-未登记候选可提名');
    // 候选未登记也应能提名（提名先于任命：登记正是任命那一步做的）。
    const 节点 = await org.tasks.nominateReview(节点B, { subject: LEAD, 项目: P, 候选: 'reviewer-x-未登记' });
    assert.equal(节点.待决类型, '复核提名');
    const identity = await org.registry.identity();
    assert.equal(identity.members['reviewer-x-未登记'], undefined, '提名不产生登记：任命仍由主权者的授权引用驱动（4yuxq 定案）');
  });

  it('④ 资格闸：成员/复核者提名 ⇒ 拒；候选=交卷人 ⇒ 拒（§3.4）；复核窗口外 ⇒ 拒（状态机）', async () => {
    const 节点D = await 交卷节点(org, '节点D-资格闸');
    await assert.rejects(
      () => org.tasks.nominateReview(节点D, { subject: MEMBER, 项目: P, 候选: 'reviewer' }),
      (e) => e instanceof Denied && /复核提名仅 Lead/.test(e.rule),
      '成员不得提名（编制：Lead 可提名）',
    );
    await assert.rejects(
      () => org.tasks.nominateReview(节点D, { subject: REVIEWER, 项目: P, 候选: 'reviewer' }),
      (e) => e instanceof Denied && /复核提名仅 Lead/.test(e.rule),
      '复核者不得提名',
    );
    await assert.rejects(
      () => org.tasks.nominateReview(节点D, { subject: LEAD, 项目: P, 候选: 'member-a' }),
      (e) => e instanceof Denied && /§3\.4/.test(e.rule),
      '候选是本节点交卷人 ⇒ 拒（提审分离的前置面）',
    );
    // 窗口外：执行中不许提名（提名是复核窗口的事）。上面 ④ 已把 节点D 留在已交卷，
    // 另起一个执行中的节点验状态机那道闸。
    const { id: 执行中 } = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '节点E-窗口外', 负责人: 'member-a', 判据: ['判据一'], 模式: '并行分担' });
    await org.tasks.dispatch(执行中, { subject: LEAD, 项目: P });
    await org.tasks.start(执行中, { subject: MEMBER, 项目: P });
    await assert.rejects(
      () => org.tasks.nominateReview(执行中, { subject: LEAD, 项目: P, 候选: 'reviewer' }),
      (e) => e instanceof Denied && /状态机/.test(e.rule),
      '执行中（未交卷）不许提名',
    );
  });

  it('⑤ 环路恢复 + 协议层委托：resolve 后回已交卷，review.nominate（池外候选）落的也是任务图事件', async () => {
    // 先把 ① 提的名决掉：节点回已交卷。
    const 已决1 = await org.tasks.resolvePending(节点A, { subject: LEAD, 项目: P, 决定: '批准任命 reviewer' });
    assert.equal(已决1.状态, '已交卷', 'resolve 把节点放回待决前的状态');
    assert.ok(已决1.待决记录.some((r) => /提名 reviewer/.test(r.原因)), '待决记录留痕（清空队列不删记录）');
    // 协议层再提一次（池外候选 reviewer-y ⇒ 走提名路径）：review.nominate 必须委托任务图
    // （与 record 委托 tasks.review 同款）——判据就是它落的是任务图事件（节点又转待决、
    // 提名记录追加），而不是只落一条审计。池内候选的路由另测（G1.5）。
    const 节点 = await org.review.nominate({ subject: LEAD, 项目: P, 节点: 节点A, 实例: 'reviewer-y', 理由: '协议层委托验证' });
    assert.equal(节点.状态, '待决', 'review.nominate（池外）落的是任务图事件（委托，不是只记审计）');
    assert.equal(节点.复核提名记录.length, 2, '提名记录逐次追加');
    const 已决2 = await org.tasks.resolvePending(节点A, { subject: LEAD, 项目: P, 决定: '批准任命 reviewer-y，授权引用=本节点 id' });
    assert.equal(已决2.状态, '已交卷');
    const 已核 = await org.tasks.review(节点A, { subject: REVIEWER, 项目: P, 三态: '过' });
    assert.equal(已核.状态, '已采纳');
    assert.equal(已核.复核经过.at(-1).复核者, 'reviewer');
    // 终态不许再提名（状态机守着环路的尽头）。
    await assert.rejects(
      () => org.tasks.nominateReview(节点A, { subject: LEAD, 项目: P, 候选: 'reviewer' }),
      (e) => e instanceof Denied && /已采纳/.test(e.message),
      '已采纳（终态）不许再提名',
    );
  });
});

/**
 * G1.5 · 池化排班（2026-10-14 晚 · 主权者批准）：
 *  - 路由：候选在册在岗 ⇒ assignReview（派单不进待决、节点留复核窗口）；池外 ⇒ nominateReview（待决）；
 *  - 派单闸：仅 Lead；候选=交卷人 ⇒ 拒（§3.4 池内身份不豁免）；窗口外 ⇒ 拒；
 *  - 轮派：候选省略 ⇒ 池内账上活动最旧优先（无活动视为最旧），排除交卷人；池空 ⇒ 响亮拒；
 *  - fold 重放：复核指派记录可从事件流重建。
 */
describe('G1.5 · 池内派单与轮派（assignReview / review.nominate 路由）', () => {
  let f;
  let org;

  /** 岗位卡（与 subject-creation.test.js 同款）——就座第二名复核员要走 registry.assign。 */
  const 岗位卡 = (id) => [
    '---', `id: ${id}`, 'kind: 身份', 'authority: 自治', 'zone: 私有', 'domain: 个体', 'version: 1', '---',
    `# ${id}`, '', '## 个体L0 · 身份', `${id} 岗。`, '',
    '## 个体L1 · 规则', '先搜后写。', '',
    '## 个体L2 · 能力', '- 无', '',
    '## 个体L3 · 经验', '- 无',
  ].join('\n');

  before(async () => {
    f = await makeFixture();
    // 复核员岗位卡：registry.assign(复核员) 要求岗位存在（实例权限只来自岗位）。
    await writeUnder(f.privateRoot, '集体L3-成员角色卡/复核员.md', 岗位卡('复核员'));
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  });
  after(async () => {
    await f.cleanup();
  });

  it('⑨ 路由：池内候选 ⇒ 派单（不进待决、节点留已交卷、复核指派记录）；池外候选 ⇒ 待决', async () => {
    const 池内节点 = await 交卷节点(org, '节点H-池内路由');
    const a = await org.review.nominate({ subject: LEAD, 项目: P, 节点: 池内节点, 实例: 'reviewer' });
    assert.equal(a.状态, '已交卷', '池内派单不是任命：节点留在复核窗口，不进待决');
    assert.equal(a.待决类型, undefined, '没有待决类型（没走 pending）');
    assert.equal(a.复核指派.候选, 'reviewer');
    assert.equal(a.复核指派.排班, '池内');
    assert.ok(!(await org.tasks.snapshot({ 项目: P })).待决.some((n) => n.id === 池内节点), '池内派单不占主权者决策队列');
    assert.ok((await org.audit.read({})).some((r) => r.结果 === 'review_assigned' && r.对象?.id === 池内节点), '审计链要有 review_assigned 一条');
    // 池内派单走完全程：指派后复核员可直接 review（这正是「不进待决」的意义）。
    // 这一步同时让 reviewer 在账上产生活动——⑪ 的轮派预期（选活动最旧者）依赖它。
    const 已核 = await org.tasks.review(池内节点, { subject: REVIEWER, 项目: P, 三态: '过' });
    assert.equal(已核.状态, '已采纳', '池内派单 ⇒ 复核窗口直达复核');

    const 池外节点 = await 交卷节点(org, '节点I-池外路由');
    const b = await org.review.nominate({ subject: LEAD, 项目: P, 节点: 池外节点, 实例: 'outsider-001' });
    assert.equal(b.状态, '待决', '池外候选 = 新任命 ⇒ 挂待决等主权者');
    assert.equal(b.待决类型, '复核提名');
    assert.equal(b.复核指派, undefined, '没走派单');
  });

  it('⑩ 派单闸：成员 ⇒ 拒；候选=交卷人 ⇒ 拒（§3.4 池内不豁免）；窗口外 ⇒ 拒；fold 重放指派记录', async () => {
    const 节点 = await 交卷节点(org, '节点J-派单闸');
    await assert.rejects(
      () => org.tasks.assignReview(节点, { subject: MEMBER, 项目: P, 候选: 'reviewer' }),
      (e) => e instanceof Denied && /复核派单仅 Lead/.test(e.rule),
      '成员没有排班的手',
    );
    await assert.rejects(
      () => org.tasks.assignReview(节点, { subject: LEAD, 项目: P, 候选: 'member-a' }),
      (e) => e instanceof Denied && /§3\.4/.test(e.rule),
      '池内身份不豁免提审分离',
    );
    const { id: 执行中 } = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '节点K-派单窗口外', 负责人: 'member-a', 判据: ['判据一'], 模式: '并行分担' });
    await org.tasks.dispatch(执行中, { subject: LEAD, 项目: P });
    await org.tasks.start(执行中, { subject: MEMBER, 项目: P });
    await assert.rejects(
      () => org.tasks.assignReview(执行中, { subject: LEAD, 项目: P, 候选: 'reviewer' }),
      (e) => e instanceof Denied && /状态机/.test(e.rule),
      '执行中（未交卷）不许派单',
    );
    // fold 重放：指派事实可从事件流重建（状态权威 = 事件流）。
    const 已派 = await org.tasks.assignReview(节点, { subject: LEAD, 项目: P, 候选: 'reviewer' });
    assert.equal(已派.复核指派记录.length, 1);
    const 重放 = fold(await org.tasks.events({ 项目: P })).get(节点);
    assert.equal(重放.复核指派.候选, 'reviewer', '重放可重建复核指派');
    assert.equal(重放.状态, '已交卷', '派单不转移状态（重放口径一致）');
  });

  it('⑪ 轮派：候选省略 ⇒ 池内账上活动最旧优先；池空 ⇒ 响亮拒', async () => {
    // 就座第二名复核员（复核员任命特判：带授权引用）。
    // 授权引用必须真实存在（2026-10-14 审查 P2-2）：先落一个决议节点，拿它的 id 当依据。
    const { id: 授权节点 } = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '主权者决议：常任复核员授权（测试）', 负责人: 'lead', 判据: ['决议在案'] });
    await org.registry.assign({ subject: LEAD, 岗位: '复核员', 实例: 'reviewer-2', 代: 1, 授权引用: 授权节点 });
    // reviewer 已在账上有活动（⑨⑩ 的指派/审计），reviewer-2 刚就座零活动 ⇒ 轮派应选 reviewer-2。
    const 节点 = await 交卷节点(org, '节点L-轮派');
    const 派 = await org.review.nominate({ subject: LEAD, 项目: P, 节点 });
    assert.equal(派.复核指派.候选, 'reviewer-2', '轮派选账上活动最旧的在岗复核员（零活动视为最旧）');
    // 池空对照：造一个没有在岗复核员的独立夹具。
    const 空池 = await makeFixture({ members: { lead: { id: 'lead', 岗位: 'Lead', 代: 1, status: '在岗' } } });
    const 空org = await Org.open({ home: 空池.home, factoryRoot: 空池.factoryRoot, privateRoot: 空池.privateRoot, project: P });
    const 空节点 = '不存在的节点';
    await assert.rejects(
      () => 空org.review.nominate({ subject: LEAD, 项目: P, 节点: 空节点 }),
      (e) => e instanceof Error && /没有在册在岗的复核员/.test(e.message),
      '池空 ⇒ 响亮拒（宁缺毋滥：派单不许变成自审的通道）',
    );
    await 空池.cleanup();
  });
});

describe('G3 · registry_list 实例活动读数（从审计链现算）', () => {
  let f;
  let org;

  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    // reviewer 在账上动过（交卷→提名→resolve→review 全链）；member-b 登记在册但从没动过。
    const id = await 交卷节点(org, '节点F-活动读数');
    await org.tasks.nominateReview(id, { subject: LEAD, 项目: P, 候选: 'reviewer' });
    await org.tasks.resolvePending(id, { subject: LEAD, 项目: P, 决定: '批准' });
    await org.tasks.review(id, { subject: REVIEWER, 项目: P, 三态: '过' });
  });
  after(async () => {
    await f.cleanup();
  });

  it('⑥ 两向：有活动 ⇒ 时刻与账本对得上；无活动 ⇒ null 且 status 仍报在岗（无活动 ≠ 不在岗）', async () => {
    const 包 = await runAction({ org, 项目: P, 主体: LEAD, args: { action: 'registry_list' } });
    // 正向：reviewer 的最近活动于 = 账本里该主体的最晚一行。
    const 账上最晚 = (await org.audit.read({})).filter((r) => r.主体?.id === 'reviewer').map((r) => String(r.时间)).sort().at(-1);
    assert.ok(账上最晚, '前置：reviewer 在账上真的有行（否则这条测的是空气）');
    assert.equal(包.实例.reviewer.最近活动于, 账上最晚, '最近活动于 与审计链逐条对得上');
    assert.ok(包.实例.reviewer.活动条数 >= 1);
    // 反向：member-b 在册在岗但从未动过 ⇒ null + 条数 0，且在册态照报（不许糊成「不在岗」）。
    assert.equal(包.实例['member-b'].最近活动于, null);
    assert.equal(包.实例['member-b'].活动条数, 0);
    assert.equal(包.实例['member-b'].status, '在岗', '无活动 ≠ 不在岗：在册态照报，活动面另列（no-life-inference-from-permission）');
    assert.match(String(包.活动读数说明), /无活动 ≠ 不在岗/, '读数口径要写明「无活动 ≠ 不在岗」');
  });
});

describe('G4 · 复核豁免登记（exemptReview）', () => {
  let f;
  let org;
  let 节点G;

  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    节点G = await 交卷节点(org, '节点G-豁免');
    await org.tasks.nominateReview(节点G, { subject: LEAD, 项目: P, 候选: 'reviewer' });
  });
  after(async () => {
    await f.cleanup();
  });

  it('⑦ 两向：空授权 ⇒ 默认拒；成员带授权 ⇒ 拒；Lead 带授权 ⇒ 复核豁免字段可查询可统计', async () => {
    await assert.rejects(
      () => org.tasks.exemptReview(节点G, { subject: LEAD, 项目: P, 原因: '主权者说不复核' }),
      (e) => e instanceof Denied && /复核豁免须主权者授权/.test(e.rule) && e.requireAuthority === '主权者',
      '空授权 = 默认拒绝（豁免免除的是独立复核本身）',
    );
    await assert.rejects(
      () => org.tasks.exemptReview(节点G, { subject: MEMBER, 项目: P, 授权引用: '决议-2026-10-14-豁免', 原因: 'x' }),
      (e) => e instanceof Denied && /复核豁免仅 Lead \/ 主权者/.test(e.rule),
      '成员没有豁免入口',
    );
    const 节点 = await org.tasks.exemptReview(节点G, { subject: LEAD, 项目: P, 授权引用: '决议-2026-10-14-主权者豁免节点G', 原因: '主权者明示本件不复核' });
    assert.equal(节点.复核豁免.授权引用, '决议-2026-10-14-主权者豁免节点G', '授权依据原样进节点（接受复核）');
    assert.equal(节点.复核豁免.由, 'lead');
    assert.equal(节点.复核豁免记录.length, 1, '逐次留痕');
    // 统计面：已交卷/待决 且无豁免 的节点数可从 snapshot 算出——豁免让这件产出从「没被复核」清单里分出来。
    const 快照 = await org.tasks.snapshot({ 项目: P });
    const 未复核未豁免 = 快照.节点.filter((n) => ['已交卷', '待决'].includes(n.状态) && !n.复核豁免);
    assert.equal(未复核未豁免.some((n) => n.id === 节点G), false, '豁免后的节点不再落在「未复核未豁免」里');
    const rows = await org.audit.read({});
    assert.ok(rows.some((r) => r.结果 === 'review_exempted' && r.对象?.id === 节点G), '审计链要有 review_exempted 一条');
  });

  it('⑧ fold 重放：事件流重建 复核提名记录 与 复核豁免（状态权威 = 事件流）', async () => {
    const rows = await org.tasks.events({ 项目: P });
    const nodes = fold(rows);
    const g = nodes.get(节点G);
    assert.ok(g, '前置：节点在事件流里');
    assert.equal(g.复核提名记录.length, 1);
    assert.equal(g.复核提名记录[0].候选, 'reviewer');
    assert.equal(g.复核豁免.授权引用, '决议-2026-10-14-主权者豁免节点G');
    assert.equal(g.状态, '待决', '豁免只标记不转移：节点仍在待决，清账走 task_resolve');
  });
});
