/**
 * 设计债㉔读面收口（2026-10-17 批 · 节点 task-设计债批次实施-主权者-继续处理-yxu6r）。
 *
 * 债：写面（scopeOf ② · 缺口4 2026-10-12）早已按身份档案把实例解析成岗位再比，读面
 * sliceForViewer 仍按 id/roleId 字面比对 ⇒ 会话派生成员（㉑ A 修后**不带 roleId**）对
 * **按岗位名合法派发**（派发闸② · 2026-10-15）的节点「能写不能看」——同一份档案下
 * 两个面口径不一致（债㉔ 登记时的病，从写面挪到了读面）。
 *
 * 修法判据：org.workbench 用在手身份档案（同一份 identity 读数，零新增 IO）把在册且
 * 在岗成员的岗位喂给**读者副本**；解析只影响切片，主体链对账与调用方传入的 读者 对象
 * 一律不动。复核员岗成员在动作入口已被解析成复核者主体（R02），到不了这一支。
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';

const P = 'proj-debt24-slice';

describe('设计债㉔读面：岗位派发成员的工作台可见性', () => {
  let f;
  let org;
  /** @type {string} 按岗位名派发的节点 id */
  let byRole;
  /** @type {string} 按实例 id 直配的节点 id */
  let byId;
  /** @type {string} 派给别人的节点 id */
  let others;

  before(async () => {
    f = await makeFixture();
    org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    // member-a / member-b 是夹具默认在册在岗实例，岗位 插件工程（helpers.seedIdentity）。
    byRole = (await org.tasks.create({ subject: LEAD, 项目: P, 描述: '按岗名派', 负责人: '插件工程', 判据: ['x'] })).id;
    byId = (await org.tasks.create({ subject: LEAD, 项目: P, 描述: '按实例派', 负责人: 'member-a', 判据: ['x'] })).id;
    others = (await org.tasks.create({ subject: LEAD, 项目: P, 描述: '派给同事', 负责人: 'member-b', 判据: ['x'] })).id;
    for (const id of [byRole, byId, others]) await org.tasks.dispatch(id, { subject: LEAD, 项目: P });
  });
  after(async () => {
    await f.cleanup();
  });

  it('㉔-回归：会话派生成员（无 roleId）看得见按岗位名派发的节点——与 scopeOf ② 同口径', async () => {
    const view = await org.workbench({ 项目: P, 读者: { id: 'member-a', kind: '成员' } });
    assert.equal(view.视图, '只读自己任务那片');
    const ids = view.任务.节点.map((n) => n.id);
    assert.ok(ids.includes(byRole), `按岗位名派发的节点必须可见（修前「能写不能看」正是债㉔）；实际可见：${ids.join(',')}`);
    assert.ok(ids.includes(byId), '实例 id 直配的既有路径不受影响');
    assert.ok(!ids.includes(others), '别人的节点不进自己那片');
  });

  it('㉔-封存即失效：seal 之后岗位解析失效，只剩实例 id 直配那一条（与 scopeOf「在册且在岗」同步）', async () => {
    await org.registry.seal({ subject: LEAD, 实例: 'member-a', 理由: '㉔判据' });
    const view = await org.workbench({ 项目: P, 读者: { id: 'member-a', kind: '成员' } });
    const ids = view.任务.节点.map((n) => n.id);
    assert.ok(!ids.includes(byRole), '封存后岗位解析必须失效（不在岗 ⇒ 不产出岗位）');
    assert.ok(ids.includes(byId), '实例 id 直配与档案状态无关，照旧可见');
  });

  it('㉔-正对照：自带 roleId 的读者照旧（岗位分支是既有路径，本批只补会话派生那一支）', async () => {
    const view = await org.workbench({ 项目: P, 读者: { id: 'member-b', kind: '成员', roleId: '插件工程' } });
    const ids = view.任务.节点.map((n) => n.id);
    assert.ok(ids.includes(byRole), '自报 roleId 命中岗位名节点（既有语义不变）');
    assert.ok(!ids.includes(byId), '别人的实例节点不进自己那片');
  });

  it('㉔-读者副本：解析不许污染调用方传入的 读者 对象（主体链对账的输入是它）', async () => {
    // member-b 在册在岗（岗位 插件工程）——解析会发生；断言发生之后原对象仍无 roleId。
    const 读者 = { id: 'member-b', kind: '成员' };
    await org.workbench({ 项目: P, 读者 });
    assert.equal(读者.roleId, undefined, 'org.workbench 只能喂读者副本；原地改会把「岗位由档案解析」泄漏成调用方可见的形状变化');
  });

  it('㉔-未登记成员：档案里查无此人 ⇒ 不产出岗位，行为与修前一致（只有 id 直配）', async () => {
    const view = await org.workbench({ 项目: P, 读者: { id: 'session-stranger', kind: '成员' } });
    assert.equal(view.视图, '只读自己任务那片');
    assert.equal(view.任务.节点.length, 0, '未登记成员名下无节点（fail-closed，不猜岗位）');
  });
});
