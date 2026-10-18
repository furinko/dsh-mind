/**
 * 补修I 绑定 → 策略边界（Lead 2026-10-18 转 F 的 policy 项）：
 * 真实登记在册、带 `会审绑定` 的成员，只允许**本场**会审的作答/讨论受限写；
 * 其它业务写 / 派活 / 能力发布一律拒。绑定取身份档案（可信 registry），
 * 不由模型 context 自报；复核员不设豁免；既有任务/岗位权限不变。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';

const P = 'proj-council-bound';
const 会审视图 = { id: 'council-1', 参与者: ['member-c'], 状态: '作答中' };
const 成员 = { id: 'member-c', kind: '成员', roleId: '插件工程' };

async function 起(默认档 = '放权') {
  const f = await makeFixture({ defaults: { 介入度: '放权' } });
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  // 绑定在放权档落（准备），再切到被测档——审批档会把准备动作也一起拦下。
  await org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'member-c', 会审: { id: 'council-1', 项目: P }, 代: 1 });
  if (默认档 !== '放权') {
    await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: 默认档 }, null, 2));
    assert.equal(await org.policy.reload(), true);
  }
  return { f, org };
}

function 判(org, action, target, context = {}) {
  return org.policy.decide({
    subject: 成员,
    action,
    target: { authority: '自治', zone: '私有', project: P, ...target },
    context,
  });
}

describe('会审参与实例：只允许本场作答/讨论的受限写', () => {
  it('本场作答 ⇒ 放行；别的会审 / 别的项目 / 名单外 / 无会审视图 ⇒ 拒', async () => {
    const { f, org } = await 起();
    try {
      assert.ok((await org.registry.identity()).members['member-c'].会审绑定, '前提：绑定落在身份档案');
      assert.equal((await 判(org, 'write', { id: 'council-1', kind: '会审' }, { 会审: 会审视图 })).verdict, 'allow');
      for (const [标注, target, context] of [
        ['别的会审 id', { id: 'council-2', kind: '会审' }, { 会审: { ...会审视图, id: 'council-2' } }],
        ['别的项目', { id: 'council-1', kind: '会审', project: 'other' }, { 会审: 会审视图 }],
        ['名单外', { id: 'council-1', kind: '会审' }, { 会审: { ...会审视图, 参与者: ['someone-else'] } }],
        ['没有会审视图', { id: 'council-1', kind: '会审' }, {}],
      ]) {
        const 结论 = await 判(org, 'write', target, context);
        assert.equal(结论.verdict, 'deny', `${标注} 必须拒（实际 ${结论.verdict}）`);
        assert.match(结论.rule, /会审参与实例/, `${标注} 的拒绝要归到会审边界规则`);
      }
    } finally {
      await f.cleanup();
    }
  });

  it('业务写 / 派活 / 能力发布一律拒；读面不受这条规则影响', async () => {
    const { f, org } = await 起();
    try {
      for (const [标注, action, target] of [
        ['建任务', 'create', { id: 'task-x', kind: '任务' }],
        ['改任务', 'write', { id: 'task-x', kind: '任务' }],
        ['派发', 'dispatch', { id: 'task-x', kind: '任务' }],
        ['发布能力', 'create', { id: 'cap-x', kind: '能力' }],
      ]) {
        const 结论 = await 判(org, action, target);
        assert.equal(结论.verdict, 'deny', `${标注} 必须拒（实际 ${结论.verdict}）`);
        // 派发会先撞「成员不得再起成员/自扩权」的结构红线——仍是拒，规则可见即可。
        assert.match(String(结论.rule), /会审参与实例|成员自扩权|宪章/, `${标注} 的拒绝要归到一条可读的边界规则`);
      }
      assert.equal((await 判(org, 'read', { id: 'council-1', kind: '会审' }, { 会审: 会审视图 })).verdict, 'allow', '读不是这条规则管的');
    } finally {
      await f.cleanup();
    }
  });

  it('审批档：本场作答仍要过介入度（confirm）；业务写仍先被会审边界拒', async () => {
    const { f, org } = await 起('审批');
    try {
      const 作答 = await 判(org, 'write', { id: 'council-1', kind: '会审' }, { 会审: 会审视图 });
      assert.equal(作答.verdict, 'confirm', '会审边界不替介入度开豁免');
      const 业务 = await 判(org, 'create', { id: 'task-x', kind: '任务' });
      assert.equal(业务.verdict, 'deny');
      assert.match(业务.rule, /会审参与实例/, '业务写先被会审边界拒，不是等介入度');
    } finally {
      await f.cleanup();
    }
  });
});
