/**
 * 主体创建入账 + 复核员任命特判 + 未登记敲门者报告面 + task_reassign
 * （task-机制缺口-重要度高于本批其它工作-10th0 · 主权者已批 · 2026-10-13）。
 *
 * 缺口：「起成员」（spawn_teammate）在本组织无留痕入口——spawn 在宿主侧（Agent Teams），
 * 审计在组织侧。891jd 决策备忘录 §二已评估并**否掉**宿主侧挂钩（选项 C，归属错）；
 * 本批走裁决给的退路：**首次登记即创建入账**（registry.assign 首登 ⇒ 审计追加「主体创建」），
 * 并如实标注残余盲区：被创建但从未登记、也从未敲过门（从未调过 mind）的主体，账上报不出。
 *
 * 本文件钉死的判据：
 *  ① 两向·正向：首次登记 ⇒ 审计新增「主体创建」（实例 id + 动作名，登记人为主体）；
 *  ② 两向·反向：不登记就不新增——同实例幂等再登记不产生第二条；只敲门不登记 ⇒ 无「主体创建」；
 *  ③ 防泄密：「主体创建」详情不抄入参（8dt59 同口径）；复核员任命的授权引用除外（它本来就要进链受复核）；
 *  ④ 复核员任命特判：目标岗=复核员 ⇒ 空授权默认拒（requireAuthority 主权者）；带授权 ⇒ 过，且授权进链；
 *  ⑤ 报告面：敲过门但未登记的主体在 registry_list 的「未登记敲门者」里报得出；登记后消失；
 *  ⑥ task_reassign：仅 Lead、仅 待派发/已派发、入审计、fold 可重建（改派记录逐次留痕）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER, writeUnder } from './helpers.mjs';
import { runAction } from '../lib/actions.js';
import { Org } from '../src/org.js';
import { ACTIONS } from '../lib/actions.js';
import { Denied } from '../src/kernel/errors.js';

const P = 'proj-subject-creation';

/** 岗位卡（私有区，与 lead-identity.test.js 同款）。 */
const 岗位卡 = (id) => [
  '---', `id: ${id}`, 'kind: 身份', 'authority: 自治', 'zone: 私有', 'domain: 个体', 'version: 1', '---',
  `# ${id}`, '', '## 个体L0 · 身份', `${id} 岗。`, '',
  '## 个体L1 · 规则', '先搜后写。', '',
  '## 个体L2 · 能力', '- 无', '',
  '## 个体L3 · 经验', '- 无',
].join('\n');

/** 造一个带 插件工程 / 复核员 两张岗位卡的夹具 + 打开的 Org。 */
async function 起夹具() {
  const f = await makeFixture();
  await writeUnder(f.privateRoot, '集体L3-成员角色卡/插件工程.md', 岗位卡('插件工程'));
  await writeUnder(f.privateRoot, '集体L3-成员角色卡/复核员.md', 岗位卡('复核员'));
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  return { f, org };
}

/** 审计里「主体创建」条数（可按实例过滤）。 */
const 创建条数 = async (org, 实例 = null) =>
  (await org.audit.read({})).filter((r) => r.动作 === '主体创建' && (实例 === null || r.对象?.id === 实例)).length;

describe('主体创建入账（裁决①·首登即锚）', () => {
  let f;
  let org;

  before(async () => {
    ({ f, org } = await 起夹具());
  });
  after(async () => {
    await f.cleanup();
  });

  it('① 首次登记 ⇒ 审计新增「主体创建」（起之前 0 条 / 起之后 1 条，含实例 id 与登记人）', async () => {
    const 实例 = 'spawned-newcomer-001';
    const 之前 = await 创建条数(org, 实例);
    assert.equal(之前, 0, '起之前：账上没有这个实例的创建记录');
    const r = await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例, 代: 1 });
    assert.equal(r.状态, '在岗');
    const rows = (await org.audit.read({})).filter((x) => x.动作 === '主体创建' && x.对象?.id === 实例);
    assert.equal(rows.length, 1, `起之后：恰好一条「主体创建」；实际 ${rows.length}`);
    assert.equal(rows[0].主体.id, LEAD.id, '登记人（发起者）进审计主体');
    assert.equal(rows[0].档位, '全记', '创建主体按全记入档');
    assert.equal(rows[0].结果, '已入账');
  });

  it('② 反向·未登记不新增：同实例幂等再登记 ⇒ 不产生第二条；只敲门不登记 ⇒ 无「主体创建」', async () => {
    // 幂等：同岗位重复 assign 不写盘、不记审计（含「主体创建」）。
    await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'spawned-newcomer-001', 代: 9 });
    assert.equal(await 创建条数(org, 'spawned-newcomer-001'), 1, '幂等再登记不产生第二条「主体创建」');
    // 敲门不登记：陌生主体调 mind 被 §12.2 拒（8dt59 记「身份未登记拦截」），但没有「主体创建」。
    const ghost = { id: 'ghost-只敲门', kind: '成员' };
    await assert.rejects(
      () => runAction({ org, 项目: P, 主体: ghost, args: { action: 'status' } }),
      (e) => e instanceof Denied && /§12.2/.test(e.rule),
    );
    assert.equal(await 创建条数(org, 'ghost-只敲门'), 0, '未登记 ⇒ 账上无「主体创建」（残余盲区如实存在，不造假记录）');
  });

  it('③ 防泄密：「主体创建」详情为空对象（非复核员岗不抄任何入参）', async () => {
    await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'spawned-plain-002', 代: 1 });
    const row = (await org.audit.read({})).find((r) => r.动作 === '主体创建' && r.对象?.id === 'spawned-plain-002');
    assert.ok(row, '前置：创建记录在');
    assert.deepEqual(row.详情 ?? {}, {}, '详情必须为空（只记实例 id 与动作名，8dt59 同口径）');
  });
});

describe('复核员任命特判（裁决②·同族机制兜底）', () => {
  let f;
  let org;

  before(async () => {
    ({ f, org } = await 起夹具());
  });
  after(async () => {
    await f.cleanup();
  });

  it('④ 目标岗=复核员：空授权 ⇒ 默认拒（要主权者）；带授权 ⇒ 过，且授权引用原样进链', async () => {
    await assert.rejects(
      () => org.registry.assign({ subject: LEAD, 岗位: '复核员', 实例: 'reviewer-cand-1', 代: 1 }),
      (e) => e instanceof Denied && /复核员任命须主权者授权/.test(e.rule) && e.requireAuthority === '主权者',
      '空授权必须默认拒（任命权与岗位锁是两件事）',
    );
    assert.equal(await 创建条数(org, 'reviewer-cand-1'), 0, '被拒的任命不许留下「主体创建」');
    // 授权引用存在性校验（2026-10-14 审查 P2-2）：任意字符串不能当授权——先落真决议节点。
    await assert.rejects(
      () => org.registry.assign({ subject: LEAD, 岗位: '复核员', 实例: 'reviewer-cand-1', 代: 1, 授权引用: '决议-不存在-悬空授权' }),
      (e) => e instanceof Denied && /授权引用必须真实存在/.test(e.rule),
      '悬空授权引用必须拒（与 audit_correct 同口径）',
    );
    const { id: 决议节点 } = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '决议-2026-10-13-复核员任命', 负责人: 'lead', 判据: ['决议在案'] });
    const ok = await org.registry.assign({ subject: LEAD, 岗位: '复核员', 实例: 'reviewer-cand-1', 代: 1, 授权引用: 决议节点 });
    assert.equal(ok.状态, '在岗');
    const row = (await org.audit.read({})).find((r) => r.动作 === '主体创建' && r.对象?.id === 'reviewer-cand-1');
    assert.ok(row, '带授权的首登有「主体创建」');
    assert.equal(row.详情.授权引用, 决议节点, '授权依据原样进链接受复核');
  });
});

describe('报告面：未登记敲门者（裁决③）', () => {
  it('⑤ 敲过门但未登记 ⇒ registry_list 报得出；登记后 ⇒ 从清单消失', async () => {
    const { f, org } = await 起夹具();
    try {
      const ghost = { id: 'ghost-report-face', kind: '成员' };
      await assert.rejects(
        () => runAction({ org, 项目: P, 主体: ghost, args: { action: 'status' } }),
        (e) => e instanceof Denied,
      );
      const 列 = await runAction({ org, 项目: P, 主体: LEAD, args: { action: 'registry_list' } });
      const 报 = 列.未登记敲门者.find((x) => x.id === 'ghost-report-face');
      assert.ok(报, '敲过门、账上无身份的主体要报得出');
      assert.equal(报.敲门次数, 1);
      // 已登记的实例不在清单里（member-a 是夹具预登记成员）。
      assert.ok(!列.未登记敲门者.some((x) => x.id === 'member-a'), '已登记实例不进「未登记敲门者」');
      // 登记后消失。
      await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'ghost-report-face', 代: 1 });
      const 列2 = await runAction({ org, 项目: P, 主体: LEAD, args: { action: 'registry_list' } });
      assert.ok(!列2.未登记敲门者.some((x) => x.id === 'ghost-report-face'), '登记后从清单消失');
    } finally {
      await f.cleanup();
    }
  });
});

describe('task_reassign：改派负责人（裁决③·任务图侧）', () => {
  let f;
  let org;

  before(async () => {
    ({ f, org } = await 起夹具());
  });
  after(async () => {
    await f.cleanup();
  });

  /** Lead 建一个节点（负责人 member-a），返回节点 id。 */
  const 建节点 = (描述) =>
    org.tasks.create({ subject: LEAD, 项目: P, 描述, 负责人: 'member-a', 判据: ['判据一'] });

  it('⑥a 待派发态：Lead 改派成功——fold 负责人换人、改派记录留痕、审计入账', async () => {
    const node = await 建节点('reassign-待派发态');
    const r = await runAction({ org, 项目: P, 主体: LEAD, args: { action: 'task_reassign', id: node.id, 负责人: 'member-b' } });
    assert.ok(r.节点.改派, '返回值带 从/到');
    assert.deepEqual(r.节点.负责人, ['member-b'], 'fold 后负责人=member-b');
    assert.deepEqual(r.节点.改派记录?.[0]?.负责人, ['member-b'], '改派记录逐次留痕');
    assert.equal(r.节点.改派记录?.[0]?.由, 'lead', '谁改派的进记录');
    const 审计 = (await org.audit.read({ project: P })).filter((x) => x.对象?.id === node.id && x.详情?.事件 === 'reassigned');
    assert.equal(审计.length, 1, '审计有一条 reassign 事件');
    // 重开投影可重建（事件流折叠，不是内存态）。
    const org2 = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const again = await org2.tasks.get(node.id, { 项目: P });
    assert.deepEqual(again.负责人, ['member-b'], '重启后 fold 仍是新负责人（投影=事件流）');
  });

  it('⑥b 已派发态仍可改派；执行中 ⇒ 状态机拒', async () => {
    const node = await 建节点('reassign-已派发态');
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    const r = await org.tasks.reassign(node.id, { subject: LEAD, 项目: P, 负责人: 'member-b' });
    assert.deepEqual(r.负责人, ['member-b'], '已派发态可改派（实例消亡换人正路）');
    await org.tasks.start(node.id, { subject: { id: 'member-b', kind: '成员', roleId: '插件工程' }, 项目: P });
    await assert.rejects(
      () => org.tasks.reassign(node.id, { subject: LEAD, 项目: P, 负责人: 'member-a' }),
      (e) => e instanceof Denied && /状态机/.test(e.rule) && /待派发 \/ 已派发/.test(e.message),
      '执行中改派会让作业归属脱钩 ⇒ 拒',
    );
  });

  it('⑥c 仅 Lead：成员改派（哪怕是负责人本人）⇒ 拒', async () => {
    const node = await 建节点('reassign-仅Lead');
    await assert.rejects(
      () => org.tasks.reassign(node.id, { subject: MEMBER, 项目: P, 负责人: 'member-a' }),
      (e) => e instanceof Denied && /仅 Lead/.test(e.rule) && e.requireAuthority === 'Lead',
      '改派是排兵动作，成员没有这只手',
    );
  });

  it('⑥d 工具面在册：task_reassign 已进 ACTIONS（冻结清单在 presence.test.js 另守）', () => {
    assert.ok(ACTIONS.includes('task_reassign'), '工具 schema 的 enum 源要含 task_reassign');
  });
});
