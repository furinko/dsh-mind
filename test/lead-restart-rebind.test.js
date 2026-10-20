import { it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture } from './helpers.mjs';
import * as kernel from '../components/kernel/lib/index.js';
import { fakeHost } from './host-harness.mjs';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';
import { Org } from '../src/org.js';

const old = { 代: 'old-host', pid: 999999 };
const now = { 代: 'new-host', pid: process.pid };
const id = 'session-resumable';
const root = { id, header: { id } };
const owner = { id: 'owner', kind: '主权者' };
async function setup() {
  const f = await makeFixture();
  await f.registry.recordBoot(old);
  await f.registry.ensureLeadInstance({ 实例: id, 代次: old });
  const before = (await f.registry.identity()).members[id];
  await f.registry.recordBoot(now);
  return { f, before };
}
const request = (session = root) => ({ 实例: id, 代次: now, 宿主会话: session });
const target = { id: 'probe', kind: '产物', authority: '自治', zone: '私有' };

it('restart invalidates only binding; verified root rebind preserves identity, card and lifecycle', async () => {
  const { f, before } = await setup();
  try {
    await assert.rejects(f.policy.check({ subject: { id, kind: 'Lead' }, action: 'write', target }), /旧运行绑定不能授权写操作/);
    const swept = await f.registry.orphanSweep({ 代次: now, 存活探测: () => false });
    assert.deepEqual(swept.封存, []);
    assert.deepEqual(swept.绑定失效, [id]);
    const stale = (await f.registry.identity()).members[id];
    assert.equal(stale.status, '在岗');
    assert.deepEqual(stale.生命周期, before.生命周期);
    await assert.rejects(f.policy.check({ subject: { id, kind: 'Lead' }, action: 'write', target }), /旧运行绑定不能授权写操作/);
    assert.equal((await f.registry.ensureLeadInstance(request())).就绪, true);
    const bound = (await f.registry.identity()).members[id];
    assert.deepEqual(bound.代次, now);
    assert.deepEqual(bound.卡版本, before.卡版本);
    assert.deepEqual(bound.生命周期, before.生命周期);
    assert.equal(bound.代, before.代);
    await f.policy.check({ subject: { id, kind: 'Lead' }, action: 'write', target });
    assert.equal((await f.registry.ensureLeadInstance(request())).就绪, true);
    assert.deepEqual((await f.registry.identity()).members[id], bound, 'repeat is no-op');
    assert.deepEqual((await f.registry.identity()).boot.代, now.代, 'identity writes preserve boot facts');
    const rows = (await f.audit.read()).filter((r) => r.详情?.机制动作 === 'Lead运行绑定');
    assert.deepEqual(rows.filter((r) => r.详情.阶段 === '写入完成').map((r) => r.结果), ['Lead运行绑定失效', 'Lead运行绑定有效']);
    assert.equal(rows.filter((r) => r.详情.阶段 === '写入意图').length, 2);
    assert.ok(rows.every((r) => r.主体.id === 'system' && r.详情.卡版本 === before.卡版本.摘要));
    assert.equal((await f.audit.verify()).ok, true);
  } finally { await f.cleanup(); }
});

it('missing, mismatched and delegated host facts cannot resume a stale Lead', async () => {
  const { f } = await setup();
  try {
    for (const session of [undefined, { id: 'other', header: {} }, { id, header: { origin: 'subagent' } }, { id, header: { delegationDepth: 1 } }, { id }]) {
      assert.equal((await f.registry.ensureLeadInstance({ ...request(session), 宿主会话: session })).就绪, false);
    }
    assert.deepEqual((await f.registry.identity()).members[id].代次, old);
  } finally { await f.cleanup(); }
});

it('concurrent resume is idempotent and cannot bind an unregistered generation', async () => {
  const { f } = await setup();
  try {
    await f.registry.orphanSweep({ 代次: now, 存活探测: () => false });
    await assert.rejects(f.registry.ensureLeadInstance({ ...request(), 代次: { 代: 'forged', pid: process.pid } }), /本进程代次/);
    const results = await Promise.all([f.registry.ensureLeadInstance(request()), f.registry.ensureLeadInstance(request())]);
    assert.ok(results.every((r) => r.就绪 === true));
    assert.equal((await f.audit.read()).filter((r) => r.结果 === 'Lead运行绑定有效').length, 1);
  } finally { await f.cleanup(); }
});

it('kernel tool resumes only host root facts and does not advance existing tasks', async () => {
  const { f, before } = await setup();
  const spec = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot };
  try {
    const previous = await Org.open({ ...spec, project: 'restart', 代次: old });
    const unfinished = await previous.tasks.create({ subject: { id, kind: 'Lead' }, 项目: 'restart', 描述: 'before restart', 负责人: id, 判据: ['must remain pending'] });
    const host = fakeHost();
    await kernel.apply(host.ctx, spec);
    const org = await shareOrg(spec);
    const tool = host.工具.get('mind');
    assert.equal((await org.registry.identity()).members[id].运行绑定.状态, '失效');
    const spoof = JSON.parse(await tool.execute({ action: 'status', 实例: id, 宿主会话: root }, { agent: { session: { id: 'child', header: { origin: 'subagent', delegationDepth: 1 } } } }));
    assert.equal(spoof.成功, false);
    assert.equal((await org.registry.identity()).members[id].运行绑定.状态, '失效');
    const exec = { agent: { session: root } };
    const created = JSON.parse(await tool.execute({ action: 'task_create', project: 'restart', 描述: 'unfinished', 负责人: id, 判据: 'do not advance' }, exec));
    assert.equal(created.成功, true, JSON.stringify(created));
    assert.equal(created.节点.状态, '待派发');
    const node = created.节点;
    await tool.execute({ action: 'status', project: 'restart' }, exec);
    assert.deepEqual(await org.tasks.get(node.id, { 项目: 'restart' }), node);
    assert.deepEqual(await org.tasks.get(unfinished.id, { 项目: 'restart' }), unfinished, 'restart leaves existing task facts unchanged');
    assert.deepEqual((await org.registry.identity()).members[id].卡版本, before.卡版本);
  } finally { forgetSharedOrg(spec); await f.cleanup(); }
});

for (const mode of ['seal', 'revoke', 'role-revoke', 'wrong-role']) {
  it(`restart does not restore ${mode}`, async () => {
    const { f } = await setup();
    try {
      if (mode === 'seal') await f.registry.seal({ subject: owner, 实例: id, 理由: 'manual' });
      if (mode === 'revoke' || mode === 'role-revoke') await f.registry.revoke({ subject: owner, 对象id: mode === 'revoke' ? id : 'Lead', 理由: 'manual' });
      if (mode === 'wrong-role') {
        await f.registry.seal({ subject: owner, 实例: id, 理由: 'role change' });
        await f.registry.assign({ subject: owner, 岗位: '插件工程', 实例: id });
      }
      const before = await f.registry.identity();
      assert.equal((await f.registry.ensureLeadInstance(request())).就绪, false);
      assert.deepEqual(await f.registry.identity(), before, 'no auto repair of identity or denylist');
    } finally { await f.cleanup(); }
  });
}
