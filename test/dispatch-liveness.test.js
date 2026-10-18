/**
 * 派活闭环批（2026-10-15 主权者裁决）：
 *  1. **派发闸** —— dispatch/reassign 的每个负责人必须「就位」：在册在岗实例 id，
 *     或有在岗实例的岗位名（scopeOf 既有的岗位寻址语义，债㉔ 只登记不改），
 *     或 Lead/主权者自领。派给空气当场拒，howToChange 指向 registry_assign。
 *  2. **判活读数** —— 工作台：已派发/执行中节点报 `负责人无活动`（审计链现算，
 *     与复核员池「已任命 · 未见活动」同口径）；岗位块报 `岗位闲置`
 *     （最近派发于 / 在岗实例数，org 跨项目现算，纯投影零新账）。
 *  3. **提示段** —— 组织说明含派活流程一句（拉起后须 registry_assign 登记）。
 *
 * 判据出处：任务节点 task-派活闭环批-2026-10-15-w74q1（判据已冻结）。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, LEAD } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { Org } from '../src/org.js';
import { projectWorkbench, sliceForViewer } from '../src/workbench.js';
import { Denied } from '../src/kernel/errors.js';
import { runAction } from '../lib/actions.js';

const here = dirname(fileURLToPath(import.meta.url));
const P = 'proj-dispatch-gate';

/** Lead 自领探针用的第二 Lead（刻意不在身份档案里——自领路径不查档案）。 */
const LEAD2 = { id: 'lead-2', kind: 'Lead' };

describe('派发闸：负责人必须就位', () => {
  let f;
  let org;

  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  });
  after(async () => {
    await f.cleanup();
  });

  it('夹具口径：直接构造的 TaskGraph（不接身份源）派发照旧——闸只在装配点生效', async () => {
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock });
    const node = await tasks.create({ subject: LEAD, 项目: P, 描述: '裸图节点', 负责人: 'ghost-x', 判据: ['x'] });
    const dispatched = await tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    assert.equal(dispatched.判据冻结, true);
  });

  it('未登记的负责人 ⇒ 拒，howToChange 指向 registry_assign，节点留在待派发', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '派给空气', 负责人: 'ghost-x', 判据: ['x'] });
    await assert.rejects(
      () => org.tasks.dispatch(node.id, { subject: LEAD, 项目: P }),
      (e) => e instanceof Denied && /未就位|在岗/.test(e.message) && /registry_assign/.test(e.howToChange ?? ''),
    );
    assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '待派发', '被拒的派发不许落任何事件');
  });

  it('在册在岗实例 ⇒ 放行（member-a 是夹具默认在册实例）', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '派给在册实例', 负责人: 'member-a', 判据: ['x'] });
    assert.equal((await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P })).状态, '已派发');
  });

  it('岗位名负责人且有在岗实例 ⇒ 放行（scopeOf 岗位寻址语义保留）', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '按岗名派', 负责人: '插件工程', 判据: ['x'] });
    assert.equal((await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P })).状态, '已派发');
  });

  it('岗位名负责人但该岗零在岗实例 ⇒ 拒（派给空气的另一种写法）', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '空岗名', 负责人: '文档整理', 判据: ['x'] });
    await assert.rejects(
      () => org.tasks.dispatch(node.id, { subject: LEAD, 项目: P }),
      (e) => e instanceof Denied && /未就位/.test(e.message),
    );
  });

  it('Lead 自领（负责人 = 本次主体自己）⇒ 放行，不查档案', async () => {
    // v2 条目10：Lead 实例要先进身份档案（在岗 + 钉版）才能做自治写；这条是正规出生路径。
    const 出生 = await org.registry.ensureLeadInstance({ 实例: 'lead-2', 代次: { 代: 'gen-test', pid: process.pid } });
    assert.equal(出生.就绪, true, `Lead 实例出生必须就绪：${JSON.stringify(出生)}`);
    const node = await org.tasks.create({ subject: LEAD2, 项目: P, 描述: 'Lead 顺手干', 负责人: 'lead-2', 判据: ['x'] });
    assert.equal((await org.tasks.dispatch(node.id, { subject: LEAD2, 项目: P })).状态, '已派发');
  });

  it('封存实例 ⇒ 拒（在册 ≠ 在岗）', async () => {
    await org.registry.seal({ subject: LEAD, 实例: 'member-b', 理由: '判活探针' });
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '派给封存者', 负责人: 'member-b', 判据: ['x'] });
    await assert.rejects(
      () => org.tasks.dispatch(node.id, { subject: LEAD, 项目: P }),
      (e) => e instanceof Denied && /member-b/.test(e.message),
    );
  });

  it('reassign 同一把闸：改派给未就位者拒，改派给在册者过', async () => {
    const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '改派演示', 负责人: 'member-a', 判据: ['x'] });
    await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
    await assert.rejects(
      () => org.tasks.reassign(node.id, { subject: LEAD, 项目: P, 负责人: 'ghost-y' }),
      (e) => e instanceof Denied && /未就位/.test(e.message),
    );
    const after = await org.tasks.reassign(node.id, { subject: LEAD, 项目: P, 负责人: 'reviewer' });
    assert.deepEqual(after.负责人, ['reviewer']);
  });
});

describe('判活读数：工作台投影', () => {
  it('已派发节点报 负责人无活动（审计链零行的负责人）；有活动的不报', () => {
    const view = projectWorkbench({
      项目: P,
      节点: [
        { id: 'task-a', 状态: '已派发', 负责人: ['member-a', 'member-b'], 判据: ['x'], 独立答案: [] },
        { id: 'task-b', 状态: '执行中', 负责人: ['lead'], 判据: ['x'], 独立答案: [] },
      ],
      实例活动: {
        'member-a': { 最近活动于: null, 活动条数: 0 },
        'member-b': { 最近活动于: '2026-10-15T00:00:00Z', 活动条数: 2 },
        lead: { 最近活动于: '2026-10-14T00:00:00Z', 活动条数: 9 },
      },
    });
    const a = view.任务.节点.find((n) => n.id === 'task-a');
    assert.deepEqual(a.负责人无活动, ['member-a']);
    // 窗口内但全员有活动 ⇒ 空清单（查过且没有），不是 undefined（没查）——两件事要分得开。
    assert.deepEqual(view.任务.节点.find((n) => n.id === 'task-b').负责人无活动, []);
  });

  it('复核窗口之外（已交卷及以后）不报；宿主没给 实例活动 ⇒ 整个字段不出现（不装懂）', () => {
    const view = projectWorkbench({
      项目: P,
      节点: [{ id: 'task-c', 状态: '已交卷', 负责人: ['member-a'], 判据: ['x'], 独立答案: [{ 成员: 'member-a', 结论: 'x' }] }],
      实例活动: { 'member-a': { 最近活动于: null, 活动条数: 0 } },
    });
    assert.equal(view.任务.节点[0].负责人无活动, undefined);
    const 无输入 = projectWorkbench({ 项目: P, 节点: [{ id: 'task-d', 状态: '已派发', 负责人: ['member-a'], 判据: ['x'], 独立答案: [] }] });
    assert.equal(无输入.任务.节点[0].负责人无活动, undefined);
  });

  it('岗位闲置：{阈值, 岗位} 原样投影，宿主没给 ⇒ null；成员切片不给（治理面）', () => {
    const 闲置 = { 阈值: 14, 岗位: { 插件工程: { 在岗实例: 2, 封存实例: 1, 最近派发于: '2026-10-15T01:00:00Z', 闲置: false } } };
    const view = projectWorkbench({ 项目: P, 节点: [], 岗位闲置: 闲置 });
    assert.deepEqual(view.岗位闲置, 闲置);
    assert.equal(projectWorkbench({ 项目: P, 节点: [] }).岗位闲置, null);
    assert.equal(sliceForViewer(view, { id: 'member-a', kind: '成员' }).岗位闲置, null);
  });

  it('部署键 岗位闲置天数：合法值生效、坏值 fail-closed（引擎不健康）、修好即恢复', async () => {
    const f = await makeFixture({ privateFiles: { '集体L2-共享基础设施/defaults/部署.json': '{"岗位闲置天数": 5}' } });
    try {
      assert.equal(f.policy.state.defaults.岗位闲置天数, 5, '私有部署键覆盖内置默认（14）');
      await f.writePrivate('集体L2-共享基础设施/defaults/部署.json', '{"岗位闲置天数": "一周"}');
      // reload 的契约是把错误落 state.error 而不是抛（§2.17-3：健康面见红，写动作全拒）。
      await f.policy.reload();
      assert.equal(f.policy.healthy, false, '坏值 ⇒ 引擎不健康 ⇒ 写动作全拒（§3.6）');
      assert.match(String(f.policy.state.error), /岗位闲置天数/, '错误要能指认到这个键');
      await f.writePrivate('集体L2-共享基础设施/defaults/部署.json', '{"岗位闲置天数": 0}');
      await f.policy.reload();
      assert.equal(f.policy.state.defaults.岗位闲置天数, 0, '0 = 不判闲置（只报原始读数）');
      assert.equal(f.policy.healthy, true);
    } finally {
      await f.cleanup();
    }
  });

  it('端到端：org.workbench 现算两块读数（成员开工前亮灯，开工后熄灯）', async () => {
    const f = await makeFixture();
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    try {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '判活演示', 负责人: 'member-a', 判据: ['x'] });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });

      let view = await org.workbench({ 项目: P });
      const row = view.任务.节点.find((n) => n.id === node.id);
      assert.deepEqual(row.负责人无活动, ['member-a'], 'member-a 还没以主体身份敲过任何门');
      assert.ok(view.岗位闲置?.岗位?.插件工程, '岗位闲置要有插件工程这一行');
      assert.equal(view.岗位闲置.阈值, 14, '未写部署键 ⇒ 内置默认 14 天');
      assert.equal(view.岗位闲置.岗位.插件工程.在岗实例, 2);
      assert.equal(view.岗位闲置.岗位.插件工程.闲置, false, '刚派发过 ⇒ 未超期');
      assert.equal(view.岗位闲置.岗位.复核员.闲置, true, '复核员在册但从未被派 ⇒ 闲置（机械读数：超期含未见）');
      assert.equal(view.岗位闲置.岗位.插件工程.最近派发于, (await org.tasks.get(node.id, { 项目: P })).派发于, '最近派发于取自该岗实例名下已派发节点');

      // member-a 以主体身份动一次（start 本身就落审计）⇒ 灯熄。
      await runAction({ org, 项目: P, 主体: { id: 'member-a', kind: '成员' }, args: { action: 'task_start', id: node.id } });
      view = await org.workbench({ 项目: P });
      const started = view.任务.节点.find((n) => n.id === node.id);
      assert.deepEqual(started.负责人无活动, []);
    } finally {
      await f.cleanup();
    }
  });
});

describe('拉取审查回归：负责人寻址与封存历史', () => {
  it('R1 按岗派发：在岗成员真实开工后，岗位负责人不再报无活动', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '按岗判活', 负责人: '插件工程', 判据: ['x'] });
      await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      let view = await org.workbench({ 项目: P });
      assert.deepEqual(view.任务.节点.find((n) => n.id === node.id).负责人无活动, ['插件工程']);
      await runAction({ org, 项目: P, 主体: { id: 'member-a', kind: '成员' }, args: { action: 'task_start', id: node.id } });
      view = await org.workbench({ 项目: P });
      assert.deepEqual(view.任务.节点.find((n) => n.id === node.id).负责人无活动, [], '岗名负责人要消费该岗在岗实例的真实活动');
    } finally {
      await f.cleanup();
    }
  });

  it('R1 按岗派发：跨项目最近派发时刻不丢，刚派发的岗位不判闲置', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const 另一项目 = `${P}-other`;
      const node = await org.tasks.create({ subject: LEAD, 项目: 另一项目, 描述: '跨项目按岗派发', 负责人: '插件工程', 判据: ['x'] });
      const dispatched = await org.tasks.dispatch(node.id, { subject: LEAD, 项目: 另一项目 });
      const view = await org.workbench({ 项目: P });
      assert.equal(view.岗位闲置.岗位.插件工程.最近派发于, dispatched.派发于, '岗位名与实例名派发必须使用同一统计口径');
      assert.equal(view.岗位闲置.岗位.插件工程.闲置, false);
    } finally {
      await f.cleanup();
    }
  });

  it('R1 反例：同岗乙的活动不能替实例直配的甲消灯，封存乙后也不能替岗位消灯', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const b = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '乙的活动', 负责人: 'member-b', 判据: ['x'] });
      await org.tasks.dispatch(b.id, { subject: LEAD, 项目: P });
      await runAction({ org, 项目: P, 主体: { id: 'member-b', kind: '成员' }, args: { action: 'task_start', id: b.id } });
      const a = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '甲未活动', 负责人: 'member-a', 判据: ['x'] });
      await org.tasks.dispatch(a.id, { subject: LEAD, 项目: P });
      const role = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '岗位活动', 负责人: '插件工程', 判据: ['x'] });
      await org.tasks.dispatch(role.id, { subject: LEAD, 项目: P });
      let view = await org.workbench({ 项目: P });
      assert.deepEqual(view.任务.节点.find((n) => n.id === a.id).负责人无活动, ['member-a'], '实例直配不能借同岗其他人的活动');
      assert.deepEqual(view.任务.节点.find((n) => n.id === role.id).负责人无活动, [], '乙在岗时可以证明岗位有活动');
      await org.registry.seal({ subject: LEAD, 实例: 'member-b', 理由: '回归夹具退场' });
      view = await org.workbench({ 项目: P });
      assert.deepEqual(view.任务.节点.find((n) => n.id === role.id).负责人无活动, ['插件工程'], '封存实例的旧活动不能证明当前在岗成员活着');
    } finally {
      await f.cleanup();
    }
  });

  it('R2 实例全封存：保留派发历史，只有真正超过阈值才判闲置', async () => {
    const f = await makeFixture();
    try {
      const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '封存不抹历史', 负责人: 'member-a', 判据: ['x'] });
      const dispatched = await org.tasks.dispatch(node.id, { subject: LEAD, 项目: P });
      await org.registry.seal({ subject: LEAD, 实例: 'member-a', 理由: '回归夹具退场' });
      await org.registry.seal({ subject: LEAD, 实例: 'member-b', 理由: '回归夹具退场' });
      let view = await org.workbench({ 项目: P });
      assert.equal(view.岗位闲置.岗位.插件工程.在岗实例, 0);
      assert.equal(view.岗位闲置.岗位.插件工程.封存实例, 2);
      assert.equal(view.岗位闲置.岗位.插件工程.最近派发于, dispatched.派发于, '封存不许删除历史派发的统计归属');
      assert.equal(view.岗位闲置.岗位.插件工程.闲置, false, '正常退场不等于已超14天');
      org.clock._source = () => new Date(Date.parse(dispatched.派发于) + 15 * 86400000);
      view = await org.workbench({ 项目: P });
      assert.equal(view.岗位闲置.岗位.插件工程.最近派发于, dispatched.派发于);
      assert.equal(view.岗位闲置.岗位.插件工程.闲置, true, '历史保留不能让闲置灯恒绿');
    } finally {
      await f.cleanup();
    }
  });
});

describe('提示段：组织说明含派活流程', () => {
  it('内核系统提示段把「拉起后须登记」写明（治「忘记可以拉人」的常驻提醒缺位）', async () => {
    const text = await readFile(join(here, '..', 'components', 'kernel', 'lib', 'index.js'), 'utf8');
    assert.match(text, /派活流程/, '组织说明要有一条派活流程');
    assert.match(text, /registry_assign/, '流程里要写明拉起后须 registry_assign 登记');
  });
});
