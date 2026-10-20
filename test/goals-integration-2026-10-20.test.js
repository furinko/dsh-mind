/** 跨会话真源、工作台读域与目标/任务的互斥提交点。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { TaskGraph } from '../src/tasks.js';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';

const P = 'goals-integration';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function scene(run) {
  const f = await makeFixture();
  try {
    const open = () => Org.open({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
    const org = await open();
    const goal = await org.goals.create({ subject: LEAD, 项目: P, 期望结果: '跨会话交付可验证成果', 约束: ['保留原成果署名'], 完成依据: ['独立复核通过'], 来源: '用户明确意图的 Lead 转述', 下一步: '派发既定任务' });
    const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '实现目标的一次执行', 负责人: [MEMBER.id], 判据: ['本次交付可复验'] });
    const linked = await org.goals.linkTask(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 任务: task.id });
    await run({ f, org, goal: linked, task, open });
  } finally { await f.cleanup(); }
}

describe('持久目标与现有任务、工作台的纵向合同', { timeout: 30_000 }, () => {
  it('新装配重建当前限制与任务引用，工作台有界且不向成员泄露目标全文', async () => scene(async ({ f, org, goal, task, open }) => {
    await org.goals.revise(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 来源: '用户要求先不写文件的转述', 禁止工具: ['write', 'edit'] });
    const reopened = await open();
    assert.equal(reopened.goals, reopened.tasks.goals);
    const current = await reopened.goals.get(goal.id, { subject: LEAD, 项目: P });
    assert.deepEqual(current.禁止工具, ['write', 'edit']);
    assert.deepEqual((await reopened.tasks.get(task.id, { 项目: P })).判据, ['本次交付可复验']);
    const before = await readdir(f.privateRoot, { recursive: true });
    const full = await reopened.workbench({ 读者: LEAD, 项目: P });
    assert.equal(full.目标.健康, '可用');
    assert.equal(full.目标.总数, 1);
    assert.equal(full.目标.目标[0].修订, current.修订);
    assert.deepEqual(full.目标.目标[0].任务进展, { 关联: 1, 合法采纳: 0 });
    assert.match(full.目标.目标[0].详情指引, /不含完整约束/);
    assert.equal((await reopened.workbench({ 读者: MEMBER, 项目: P })).目标, null);
    assert.deepEqual(await readdir(f.privateRoot, { recursive: true }), before);
  }));

  it('直接构造 TaskGraph 仍接当前目标，暂停后不能开工或建立后继，原终止可记账', async () => scene(async ({ f, org, goal, task }) => {
    await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
    await org.goals.setState(goal.id, { subject: SOVEREIGN, 项目: P, 修订: goal.修订, 状态: '暂停' });
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, registry: f.registry });
    await assert.rejects(() => tasks.start(task.id, { subject: MEMBER, 项目: P }), /暂停/);
    const closed = await tasks.close(task.id, { subject: LEAD, 项目: P, 原因: '保留已发生事实，等待用户恢复' });
    assert.equal(closed.节点.状态, '已终止');
    await assert.rejects(() => tasks.createSuccessor(task.id, { subject: LEAD, 项目: P, 负责人: [MEMBER.id], 原因: '不能借后继绕过暂停' }), /暂停/);
    assert.equal((await org.goals.get(goal.id, { subject: LEAD, 项目: P })).状态, '暂停');
  }));

  it('派发先获得共同目标锁时先记派发，暂停随后提交并阻止新开工', async () => scene(async ({ org, goal, task }) => {
    const held = deferred(); const release = deferred(); const requested = deferred();
    const check = org.policy.check.bind(org.policy);
    const lock = org.goals.withProjectLock.bind(org.goals);
    let dispatchChecks = 0; let trackPause = false; let paused = false;
    org.policy.check = async spec => {
      if (spec.action === 'dispatch' && ++dispatchChecks === 1) { held.resolve(); await release.promise; }
      return check(spec);
    };
    org.goals.withProjectLock = (project, run) => { if (trackPause) requested.resolve(); return lock(project, run); };
    const dispatch = org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
    await held.promise;
    trackPause = true;
    const pause = org.goals.setState(goal.id, { subject: SOVEREIGN, 项目: P, 修订: goal.修订, 状态: '暂停' }).then(value => { paused = true; return value; });
    await requested.promise;
    assert.equal(paused, false);
    release.resolve();
    await dispatch; await pause;
    assert.equal((await org.tasks.get(task.id, { 项目: P })).状态, '已派发');
    await assert.rejects(() => org.tasks.start(task.id, { subject: MEMBER, 项目: P }), /暂停/);
  }));

  it('暂停先获得共同目标锁时，已通过锁外派发预检也不能在其后落事件', async () => scene(async ({ org, goal, task }) => {
    const held = deferred(); const release = deferred(); const requested = deferred();
    const check = org.policy.check.bind(org.policy);
    const lock = org.goals.withProjectLock.bind(org.goals);
    let trackDispatch = false;
    org.policy.check = async spec => {
      if (spec.action === 'write' && spec.target?.kind === '目标') { held.resolve(); await release.promise; }
      return check(spec);
    };
    org.goals.withProjectLock = (project, run) => { if (trackDispatch) requested.resolve(); return lock(project, run); };
    const pause = org.goals.setState(goal.id, { subject: SOVEREIGN, 项目: P, 修订: goal.修订, 状态: '暂停' });
    await held.promise;
    trackDispatch = true;
    const dispatch = org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
    const denied = assert.rejects(dispatch, /暂停/);
    await requested.promise;
    release.resolve();
    await pause; await denied;
    assert.equal((await org.tasks.get(task.id, { 项目: P })).状态, '待派发');
  }));
});
