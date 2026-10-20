import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { Denied } from '../src/kernel/errors.js';
import { serializeByKey } from '../src/kernel/fsx.js';

const P = 'plugins';
const SELF = { id: 'session-ea05d8ff-0aab-45e2-aca4-e263855042b0', kind: 'Lead', roleId: 'Lead' };
const OTHER = 'other-lead';
const member = { id: 'member-a', kind: '成员', roleId: '插件工程' };
const overGrant = (e) => e instanceof Denied && /不越授/.test(e.rule);

async function withOrg(body) {
  const f = await makeFixture({ members: {
    'member-a': { id: 'member-a', 岗位: '插件工程', status: '在岗', 代: 1 },
    'member-b': { id: 'member-b', 岗位: '插件工程', status: '在岗', 代: 1 },
    boss: { id: 'boss', 岗位: '主权者', status: '在岗', 代: 1 },
    author: { id: 'author', 岗位: '出厂作者', status: '在岗', 代: 1 },
  } });
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    for (const 实例 of [SELF.id, OTHER]) {
      assert.equal((await org.registry.ensureLeadInstance({ 实例, 代次: { 代: 'direct-probe', pid: process.pid } })).就绪, true);
    }
    const run = (args, 主体 = SELF) => runAction({ org, 项目: P, 主体, args });
    const create = async (负责人 = 'Lead') => (await run({ action: 'task_create', 描述: '隔离直接执行验证', 负责人, 判据: ['真实绑定及红线'] })).节点;
    const bind = (id, 实例 = SELF.id, 岗位 = 'Lead', 主体 = SELF) => run({ action: 'task_bind', id, 实例, 岗位 }, 主体);
    const dispatch = (id, extra = {}) => run({ action: 'task_dispatch', id, ...extra });
    const get = (id) => org.tasks.get(id, { 项目: P });
    await body({ f, org, run, create, bind, dispatch, get });
  } finally { await f.cleanup(); }
}

// 持有任务变更的最外层目标队列，确保调用者先读到旧节点，再让合法变更先落线。
// 目标锁已在任务锁之前；不能持有内层任务队列再等两个调用都进入该队列，
// 否则第一个调用占着外层目标队列，第二个无法排到内层，夹具本身永久互等。
async function withQueuedChange(org, f, change, operation) {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const lockKey = f.layout.goalLog(P);
  const holder = serializeByKey(lockKey, async () => { entered.resolve(); await release.promise; });
  await entered.promise;
  const queued = [Promise.withResolvers(), Promise.withResolvers()];
  const queue = serializeByKey._queue;
  const originalSet = queue.set;
  let index = 0;
  queue.set = function (key, value) {
    const result = originalSet.call(this, key, value);
    if (key === lockKey) queued[index++]?.resolve();
    return result;
  };
  let first;
  let second;
  try {
    first = change();
    first.catch(queued[0].reject);
    await queued[0].promise;
    second = operation();
    second.catch(queued[1].reject);
    await queued[1].promise;
  } finally {
    queue.set = originalSet;
    release.resolve();
    await holder;
  }
  return Promise.allSettled([first, second]);
}

describe('Lead 真实自执行与不越授唯一判定', { timeout: 60_000 }, () => {
  it('岗位负责人Lead+本人真实绑定，经动作/Org/TaskGraph派发开工交卷，负责人仍是岗位名', async () => withOrg(async ({ create, bind, dispatch, run, get }) => {
    const node = await create();
    await bind(node.id);
    assert.equal((await dispatch(node.id)).节点.状态, '已派发');
    assert.equal((await run({ action: 'task_start', id: node.id })).节点.状态, '执行中');
    assert.equal((await run({ action: 'task_submit', id: node.id, 结论: '本人完成' })).节点.状态, '已交卷');
    const end = await get(node.id);
    assert.deepEqual(end.负责人, ['Lead']);
    assert.deepEqual(end.绑定.map(b => b.实例), [SELF.id]);
    assert.equal(end.独立答案[0].成员, SELF.id);
  }));

  it('原实例id自领保留；岗位Lead没有真实绑定仍拒', async () => withOrg(async ({ create, dispatch, get }) => {
    const direct = await create(SELF.id);
    assert.equal((await dispatch(direct.id)).节点.状态, '已派发');
    const role = await create();
    await assert.rejects(dispatch(role.id), overGrant);
    assert.equal((await get(role.id)).状态, '待派发');
  }));

  it('自报context/task/自领不能替代真实绑定', async () => withOrg(async ({ create, dispatch }) => {
    const n = await create();
    await assert.rejects(dispatch(n.id, { 自领: true, context: { task: { 绑定: [{ 实例: SELF.id, 岗位: 'Lead' }] } }, task: { 绑定: [{ 实例: SELF.id, 岗位: 'Lead' }] } }), overGrant);
  }));

  it('另一Lead、主权者、出厂作者的实例与岗位派发仍拒，混合负责人不被本人掩盖', async () => withOrg(async ({ create, dispatch, get }) => {
    for (const 负责人 of [OTHER, 'boss', 'author', 'Lead', '主权者', '出厂作者', [SELF.id, OTHER], [SELF.id, 'boss'], [SELF.id, 'author']]) {
      const n = await create(负责人);
      await assert.rejects(dispatch(n.id), overGrant);
      assert.equal((await get(n.id)).状态, '待派发');
    }
  }));

  it('主权者预置的他人/混合Lead绑定不能伪装自执行', async () => withOrg(async ({ create, bind, dispatch, get }) => {
    for (const mix of [false, true]) {
      const n = await create();
      if (mix) await bind(n.id);
      await bind(n.id, OTHER, 'Lead', SOVEREIGN);
      await assert.rejects(dispatch(n.id), overGrant);
      assert.equal((await get(n.id)).状态, '待派发');
    }
  }));

  it('派发前后绑定另一Lead或上级均拒，拒绝不落bound事件', async () => withOrg(async ({ create, bind, dispatch, org, get }) => {
    for (const dispatched of [false, true]) {
      for (const [实例, 岗位] of [[OTHER, 'Lead'], ['boss', '主权者'], ['author', '出厂作者']]) {
        const n = await create(['Lead', 岗位]);
        await bind(n.id, SELF.id, 'Lead', SOVEREIGN);
        // 主权者/出厂作者的岗名本身禁止Lead派发，先由主权者建立已派发状态以单独打中绑定面。
        if (dispatched) await org.tasks.dispatch(n.id, { subject: SOVEREIGN, 项目: P });
        await assert.rejects(bind(n.id, 实例, 岗位), overGrant);
        assert.deepEqual((await get(n.id)).绑定.map(b => b.实例), [SELF.id]);
      }
    }
  }));

  it('派发前后改派另一Lead或上级及混合名单均拒，新负责人未落线', async () => withOrg(async ({ create, dispatch, run, get }) => {
    for (const dispatched of [false, true]) {
      for (const 负责人 of [OTHER, 'boss', 'author', [SELF.id, OTHER], [SELF.id, 'boss'], [SELF.id, 'author']]) {
        const n = await create(SELF.id);
        if (dispatched) await dispatch(n.id);
        await assert.rejects(run({ action: 'task_reassign', id: n.id, 负责人 }), overGrant);
        assert.deepEqual((await get(n.id)).负责人, [SELF.id]);
      }
    }
  }));

  it('本人绑定的Lead岗可由改派正门表达；不能用改派清除他人的高权绑定', async () => withOrg(async ({ create, bind, run, dispatch, get }) => {
    const n = await create(SELF.id);
    await bind(n.id);
    assert.deepEqual((await run({ action: 'task_reassign', id: n.id, 负责人: 'Lead' })).节点.负责人, ['Lead']);
    await dispatch(n.id);
    await bind(n.id, OTHER, 'Lead', SOVEREIGN);
    await assert.rejects(run({ action: 'task_reassign', id: n.id, 负责人: SELF.id }), overGrant);
    assert.deepEqual((await get(n.id)).负责人, ['Lead']);
  }));

  it('登记另一Lead/主权者/出厂作者仍拒，未改registry权限', async () => withOrg(async ({ org }) => {
    for (const 岗位 of ['Lead', '主权者', '出厂作者']) {
      await assert.rejects(org.registry.assign({ subject: SELF, 实例: `new-${岗位}`, 岗位 }), overGrant);
    }
  }));

  it('实际档案与声明岗位不符、未知实例、负责人跨岗仍由绑定闸拒', async () => withOrg(async ({ create, bind, get }) => {
    for (const [实例, 岗位, rule] of [['member-a', 'Lead', /档案一致/], ['ghost', 'Lead', /在册在岗/], ['member-a', '插件工程', /负责人对得上/]]) {
      const n = await create();
      await assert.rejects(bind(n.id, 实例, 岗位), e => e instanceof Denied && rule.test(e.rule));
      assert.equal((await get(n.id)).绑定, undefined);
    }
  }));

  it('真实主体不能借Lead卡自报：成员kind=Lead被凭证闸拒', async () => withOrg(async ({ create, run }) => {
    const n = await create();
    await assert.rejects(run({ action: 'task_bind', id: n.id, 实例: SELF.id, 岗位: 'Lead' }, { id: 'member-a', kind: 'Lead', roleId: 'Lead' }), e => e instanceof Denied && /主体种类与档案岗位不符/.test(e.rule));
  }));

  it('普通成员岗位负责人、真实绑定和父域约束保留，跨岗成员不获任务权', async () => withOrg(async ({ create, bind, dispatch, run, org, f, get }) => {
    const n = await create('插件工程');
    await bind(n.id, 'member-a', '插件工程');
    await dispatch(n.id);
    await run({ action: 'task_start', id: n.id }, member);
    assert.deepEqual((await get(n.id)).负责人, ['插件工程']);
    await assert.rejects(run({ action: 'task_dispatch', id: n.id }, member), e => e instanceof Denied);
    const matrix = ['---', 'id: 权限矩阵', 'kind: 规则', 'authority: 法律', 'zone: 私有', 'domain: 集体', 'version: 1', '---', '# 权限矩阵', '## 三档门槛', '```policy', JSON.stringify({ grants: [{ subject: 'Lead', action: 'create', kind: '经历', verdict: 'deny', reason: '父域反例' }, { subject: '成员', action: 'create', kind: '经历', verdict: 'allow', reason: '不得越父' }] }), '```'].join('\n');
    await f.writePrivate('集体L1-法律/权限矩阵.md', matrix);
    await assert.rejects(org.memory.remember({ subject: member, 类: '经历', 内容: '父域不得扩张', 来源: '隔离', 任务: await get(n.id), 项目: P }), overGrant);
    const unrelated = await create(SELF.id);
    await dispatch(unrelated.id);
    await assert.rejects(run({ action: 'task_start', id: unrelated.id }, member), e => e instanceof Denied && /任务外/.test(e.rule));
  }));

  it('并发自领dispatch与另一Lead bind：自领成功，外派绑定拒绝且无残留', async () => withOrg(async ({ create, bind, dispatch, get }) => {
    const n = await create();
    await bind(n.id);
    const [a, b] = await Promise.allSettled([dispatch(n.id), bind(n.id, OTHER, 'Lead')]);
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected');
    assert.ok(overGrant(b.reason));
    assert.deepEqual((await get(n.id)).绑定.map(b => b.实例), [SELF.id]);
  }));

  it('并发两次自领派发仅一次落线', async () => withOrg(async ({ create, bind, dispatch, org }) => {
    const n = await create();
    await bind(n.id);
    const results = await Promise.allSettled([dispatch(n.id), dispatch(n.id)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await org.tasks.events({ 项目: P })).filter(e => e.id === n.id && e.kind === 'dispatched').length, 1);
  }));

  it('排队期间主权者先加绑另一Lead：dispatch必须按锁内新绑定拒绝', async () => withOrg(async ({ create, bind, dispatch, org, f, get }) => {
    const n = await create();
    await bind(n.id);
    const [a, b] = await withQueuedChange(org, f, () => bind(n.id, OTHER, 'Lead', SOVEREIGN), () => dispatch(n.id));
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected');
    assert.ok(overGrant(b.reason));
    assert.equal((await get(n.id)).状态, '待派发');
  }));

  it('排队期间先改派成员岗：旧Lead绑定请求必须按新负责人拒绝', async () => withOrg(async ({ create, bind, run, org, f, get }) => {
    const n = await create();
    await bind(n.id);
    const [a, b] = await withQueuedChange(org, f, () => run({ action: 'task_reassign', id: n.id, 负责人: '插件工程' }), () => bind(n.id));
    assert.equal(a.status, 'fulfilled');
    assert.equal(b.status, 'rejected');
    assert.match(b.reason.rule, /负责人对得上/);
    assert.deepEqual((await get(n.id)).负责人, ['插件工程']);
  }));

  it('排队期间先开工：bind/reassign都必须按锁内执行中拒绝', async () => withOrg(async ({ create, bind, dispatch, run, org, f, get }) => {
    for (const op of ['bind', 'reassign']) {
      const n = await create();
      await bind(n.id);
      await dispatch(n.id);
      const [a, b] = await withQueuedChange(org, f, () => run({ action: 'task_start', id: n.id }), () => op === 'bind' ? bind(n.id) : run({ action: 'task_reassign', id: n.id, 负责人: '插件工程' }));
      assert.equal(a.status, 'fulfilled');
      assert.equal(b.status, 'rejected');
      assert.match(b.reason.rule, /状态机/);
      assert.equal((await get(n.id)).状态, '执行中');
    }
  }));
});
