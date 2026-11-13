import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { apply } from '../components/kernel/lib/index.js';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';
import { drainKernelAudit } from './kernel-drain.mjs';
const id = 'readiness-root';
const old = { 代: 'old-readiness-host', pid: 999999 };
const now = { 代: 'current-readiness-host', pid: process.pid };
const root = { id, header: { id } };
async function legacy(run) {
  const f = await makeFixture();
  try {
    await f.registry.recordBoot(old); await f.registry.ensureLeadInstance({ 实例: id, 代次: old });
    const doc = await f.registry.identity(); delete doc.members[id].卡版本;
    await writeFile(f.layout.identityFile(), JSON.stringify(doc)); await f.registry.recordBoot(now);
    await run(f);
  } finally { await f.cleanup(); }
}
it('缺专业卡不能越过旧运行绑定：缺Host事实、存活旧进程、未知绑定均拒绝执行就绪', () => legacy(async f => {
  const implicit = await f.registry.ensureLeadInstance({ 实例: id });
  assert.equal(implicit.执行就绪, false, '省略代次也核当前boot，不认可旧运行');
  const absent = await f.registry.ensureLeadInstance({ 实例: id, 代次: now });
  assert.equal(absent.执行就绪, false); assert.match(absent.原因, /根会话/);
  const doc = await f.registry.identity(); doc.members[id].代次 = { 代: old.代, pid: process.pid };
  await writeFile(f.layout.identityFile(), JSON.stringify(doc));
  const alive = await f.registry.ensureLeadInstance({ 实例: id, 代次: { ...now, pid: 88888 }, 宿主会话: root });
  assert.equal(alive.执行就绪, false); assert.match(alive.原因, /仍存活/);
  doc.members[id].运行绑定 = { 状态: 'unknown' }; await writeFile(f.layout.identityFile(), JSON.stringify(doc));
  const unknown = await f.registry.ensureLeadInstance({ 实例: id, 代次: now, 宿主会话: root });
  assert.equal(unknown.执行就绪, false); assert.match(unknown.原因, /不可判/);
}));
it('真实根会话可续接缺卡身份，专业状态仍不就绪，不改生命周期或捏造卡版本', () => legacy(async f => {
  const before = (await f.registry.identity()).members[id];
  const result = await f.registry.ensureLeadInstance({ 实例: id, 代次: now, 宿主会话: root });
  assert.equal(result.执行就绪, true); assert.equal(result.专业就绪, false);
  const after = (await f.registry.identity()).members[id];
  assert.deepEqual(after.生命周期, before.生命周期); assert.equal(after.卡版本, undefined);
  assert.deepEqual(after.代次, now); assert.equal(after.运行绑定.状态, '有效');
}));
it('真实kernel首次无卡根会话可登记身份，明确业务审批继续生效，服务拒绝不能被snapshot覆盖', async () => {
  const f = await makeFixture({ defaults: { 介入度: '审批' } });
  await rm(join(f.factoryRoot, '集体L3-成员角色卡/Lead.md'));
  const agent = { id, session: { id, header: { id, cwd: f.home } } };
  const agents = { get: key => key === id ? agent : undefined };
  const host = fakeHost({ 提供服务: ['tools', 'commands', 'systemPrompt', 'agents'], 服务: { agents } });
  const config = { ...f, project: 'readiness-test', projectBindings: [{ path: f.home, project: 'readiness-test' }] };
  let org;
  try {
    await apply(host.ctx, config); org = await shareOrg(config);
    const execute = async args => JSON.parse(await host.工具.get('mind').execute(args, { name: 'mind', agent, signal: new AbortController().signal }));
    assert.equal((await execute({ action: 'status' })).成功, true);
    const member = (await org.registry.identity()).members[id]; assert.equal(member.岗位, 'Lead'); assert.equal(member.卡版本, undefined);
    const ready = await org.registry.ensureLeadInstance({ 实例: id, 代次: org.boot.代次 });
    assert.equal(ready.执行就绪, true); assert.equal(ready.专业就绪, false);
    const args = { action: 'task_create', 描述: 'not yet approved', 负责人: id, 判据: ['exact delivery'] };
    const pending = await execute(args); assert.equal(pending.结果, '需确认', JSON.stringify(pending));
    assert.equal((await org.tasks.list({ 项目: config.project })).length, 0);
    org.registry.ensureLeadInstance = async () => ({ 已登记: true, 就绪: false, 执行就绪: false, 专业就绪: true, 原因: '旧运行不可续接' });
    const refused = await execute(args); assert.equal(refused.成功, false); assert.match(refused.理由, /旧运行不可续接/);
    assert.equal((await org.tasks.list({ 项目: config.project })).length, 0);
  } finally { host.清理(); if (org) await drainKernelAudit(org); forgetSharedOrg(config); await f.cleanup(); }
});
