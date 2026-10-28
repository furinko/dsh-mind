import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { makeFixture } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { apply } from '../components/kernel/lib/index.js';
import { shareOrg, forgetSharedOrg, shareKey } from '../src/runtime.js';
import { Org } from '../src/org.js';
import { DelegationPolicy } from '../src/delegation-policy.js';

const creationNames = ['spawn_teammate', 'subagent', 'subagent_fork', 'role_spawn', 'workflow'];
async function scene(run) {
  const f = await makeFixture();
  const host = fakeHost();
  const project = 'prompt-switch-review';
  const cwd = join(f.home, 'governed'); const otherCwd = join(f.home, 'ordinary');
  await mkdir(cwd); await mkdir(otherCwd);
  const config = { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project,
    projectBindings: [{ path: cwd, project }, { path: otherCwd, project: 'ordinary' }],
    audit工具调用: false, 观测模型用量: false,
    delegation: { mode: 'lead-discretion', projects: [project], authorizationRef: 'synthetic regression fixture' } };
  let org;
  const agent = (id, path = cwd) => ({ id, session: { id, header: { id, cwd: path }, seq: 0,
    surface: { nodes: [] }, inheritedEventCount: 0, requestHeader() { return { config: {} }; } } });
  const exec = (name, actor) => ({ name, arguments: {}, agent: actor, callId: 'synthetic-call', signal: new AbortController().signal });
  try {
    await apply(host.ctx, config); org = await shareOrg(config);
    const initial = { sections: host.段落.map(x => ({ ...x })), contexts: [],
      tools: [host.工具.get('mind'), ...creationNames.map(name => ({ name })), { name: 'ordinary_read' }] };
    const assemble = actor => host.钩子.get('system-prompt/assemble')[0](initial, { agent: actor }, async () => initial);
    const guard = (name, actor) => host.闸.map(fn => fn(exec(name, actor))).find(reason => reason !== undefined);
    const connect = (actor, enabled) => org.mindConnection.set({ sessionId: actor.id, enabled,
      expectedRevision: org.mindConnection.read(actor.id).revision }, actor.session.seq);
    await run({ f, host, project, config, org, agent, otherCwd, exec, assemble, guard, connect });
  } finally {
    host.清理(); await org?.turnBufferHooks?.flush(); await org?.budgetHooks?.flush(); await org?.observability.flush();
    forgetSharedOrg(shareKey(config)); await f.cleanup();
  }
}

test('实际装配承认持久目标，重开后恢复工作资料且不承诺自动执行接管', () => scene(async ({ config, org, host, agent, project, exec, assemble }) => {
  const actor = agent('persisted-goal-root');
  const created = JSON.parse(await host.工具.get('mind').execute({ action: 'goal_create', 期望结果: 'Synthetic persisted result',
    来源: 'synthetic user request', 完成依据: ['Synthetic acceptance'], 下一步: 'Synthetic next step' }, exec('mind', actor)));
  assert.equal(created.成功, true, JSON.stringify(created));
  const reopened = await Org.open(config);
  try {
    const saved = await reopened.goals.get(created.目标.id, { 项目: project, subject: { id: actor.id, kind: 'Lead' } });
    assert.equal(saved.期望结果, 'Synthetic persisted result');
    const assembly = await assemble(actor);
    const organization = assembly.sections.find(row => row.name === 'mind:organization').text;
    assert.doesNotMatch(organization, /目标持久化与跨会话自动接管尚未提供/);
    assert.match(organization, /持久目标已支持/);
    assert.match(organization, /不代表自动接管或持续执行/);
    assert.match(organization, /需求理解可随goal_create或goal_progress记录/);
    assert.ok(assembly.contexts.some(row => row.name === 'mind:current-work' && row.text.includes(created.目标.id)));
  } finally { await reopened.observability.flush(); }
}));

test('受管项目关闭Mind即暂停新委派，隐藏不可用创建工具并给出可行恢复条件', () => scene(async ({ org, project, host, agent, exec, assemble, guard, connect }) => {
  const actor = agent('fresh-no-tasks-root');
  assert.equal((await org.tasks.snapshot({ 项目: project })).节点.length, 0);
  await connect(actor, false);
  const assembly = await assemble(actor);
  assert.deepEqual(assembly.tools.map(row => row.name), ['ordinary_read']);
  assert.ok(assembly.sections.every(row => !row.name.startsWith('mind:')));
  for (const name of creationNames) {
    const reason = guard(name, actor);
    assert.match(reason, /未接入心智.*暂停新委派/);
    assert.match(reason, /重新打开.*心智/);
    assert.doesNotMatch(reason, /member_spawn/);
  }
  const refused = JSON.parse(await host.工具.get('mind').execute({ action: 'member_spawn' }, exec('mind', actor)));
  assert.equal(refused.成功, false); assert.match(refused.理由, /聊天框打开/);
  await connect(actor, true);
  const enabled = await assemble(actor);
  assert.ok(enabled.tools.some(row => row.name === 'mind'));
  for (const name of creationNames) {
    assert.ok(enabled.tools.some(row => row.name === name));
    assert.match(guard(name, actor), /member_spawn/);
  }
}));

test('关闭的受管聊天不改变其他聊天或非受管根聊天的原生调度边界', () => scene(async ({ agent, otherCwd, assemble, guard, connect }) => {
  const closed = agent('closed-root'); const other = agent('other-connected-root'); const ordinary = agent('ordinary-root', otherCwd);
  await connect(closed, false); await connect(ordinary, false);
  const on = await assemble(other); const off = await assemble(ordinary);
  assert.ok(on.tools.some(row => row.name === 'mind'));
  assert.equal(off.tools.some(row => row.name === 'mind'), false);
  for (const name of creationNames) {
    assert.ok(on.tools.some(row => row.name === name)); assert.match(guard(name, other), /member_spawn/);
    assert.ok(off.tools.some(row => row.name === name)); assert.equal(guard(name, ordinary), undefined);
  }
}));

test('关闭聊天不能放宽成员、未授权项目或卸载中的创建边界', () => {
  const policy = new DelegationPolicy({ mode: 'lead-discretion', projects: ['managed'], authorizationRef: 'fixture' });
  for (const name of creationNames) {
    assert.match(policy.creationGuard({ name }, { subject: { kind: '成员' }, project: 'managed', connected: false }), /成员与复核者不能再起成员/);
    assert.equal(policy.creationGuard({ name }, { subject: { kind: 'Lead' }, project: 'ordinary', connected: false }), undefined);
  }
  policy.close();
  assert.match(policy.creationGuard({ name: 'subagent' }, { subject: { kind: 'Lead' }, project: 'managed', connected: false }), /已卸载/);
});
