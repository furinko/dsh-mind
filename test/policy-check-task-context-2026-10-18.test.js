import { it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';

it('policy_check 消费真实任务：本人执行中允许、无任务/他人/跨项目/未知任务不授权', async () => {
  const f = await makeFixture();
  const P = 'preflight-task';
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const build = async (owner) => {
      const t = await org.tasks.create({ subject: LEAD, 项目: P, 描述: `预检-${owner}`, 负责人: owner, 判据: ['可核验'] });
      await org.tasks.dispatch(t.id, { subject: LEAD, 项目: P });
      await org.tasks.start(t.id, { subject: { id: owner, kind: '成员', roleId: '插件工程' }, 项目: P });
      return t.id;
    };
    const mine = await build('member-a'), other = await build('member-b');
    const check = (task, extra = {}) => runAction({ org, 项目: P, 主体: MEMBER,
      args: { action: 'policy_check', 动作: 'write', target: { id: 'isolated-artifact', kind: '产物', authority: '自治', zone: '私有' },
        ...(task ? { 任务: task } : {}), ...extra } });
    assert.equal((await check(mine)).判定.verdict, 'allow');
    assert.equal((await check()).判定.verdict, 'deny');
    assert.equal((await check(other)).判定.verdict, 'deny');
    await assert.rejects(() => check('task-does-not-exist'), /任务不存在/);
    await assert.rejects(() => check(mine, { project: 'other-project' }), /跨项目/);
    const current = await org.tasks.get(mine, { 项目: P });
    assert.equal(current.状态, '执行中', '只读预检不得推进任务');
  } finally { await f.cleanup(); }
});

it('task_criteria 复用真实负责人实例名单：本人绑定可读，同岗他人/未绑不扩大，历史实例名单兼容', async () => {
  const f = await makeFixture();
  const P = 'criteria-owner';
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const make = async (owner, bound) => {
      const node = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '判据读域', 负责人: owner, 判据: ['只给真实执行者'] });
      if (bound) await org.tasks.bind(node.id, { subject: LEAD, 项目: P, 实例: bound, 岗位: '插件工程' });
      return node.id;
    };
    const mine = await make('插件工程', MEMBER.id), peer = await make('插件工程', 'member-b');
    const unbound = await make('插件工程'), legacy = await make(MEMBER.id);
    const read = (id) => runAction({ org, 项目: P, 主体: MEMBER, args: { action: 'task_criteria', id } });
    assert.deepEqual((await read(mine)).节点.判据, ['只给真实执行者']);
    await assert.rejects(() => read(peer), /不是节点.*的负责人/);
    await assert.rejects(() => read(unbound), /不是节点.*的负责人/);
    assert.deepEqual((await read(legacy)).节点.判据, ['只给真实执行者']);
  } finally { await f.cleanup(); }
});
