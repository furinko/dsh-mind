/** 真实宿主形状的隔离反例：只豁免机械首次出生，业务、续接和其他system写仍须审批。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';
import { drainKernelAudit } from './kernel-drain.mjs';
import { MECHANISM_SUBJECT } from '../src/mechanism.js';
import { NeedsApproval, Denied } from '../src/kernel/errors.js';

const P = 'lead-birth-independent-adversarial';
const ROOT = 'session-live-first-root';
const HASH = 'a'.repeat(64);
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const permission = (id = ROOT) => ({ subject: { ...MECHANISM_SUBJECT }, action: 'create', target: { id, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: null, 岗位: 'Lead' }, context: { 身份操作: '实例', 机制动作: '实例出生', 卡版本: HASH } });

async function scene(run) {
  // 无任何实例、但有合规Lead卡；没有先在放权档替被测root登记。首次宿主调用前即审批。
  const f = await makeFixture({ lead: 'unpinned', members: {}, defaults: { 介入度: '审批' } });
  const live = new Map(); const agents = { get: id => live.get(id) };
  const host = fakeHost({ 提供服务: ['tools', 'commands', 'systemPrompt', 'agents'], 服务: { agents } }); let org;
  const config = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P };
  try {
    const cwd = join(f.home, 'workspace'); await mkdir(cwd, { recursive: true }); config.projectBindings = [{ path: cwd, project: P }];
    await kernel.apply(host.ctx, config); org = await shareOrg(config); assert.equal(org.policy.intervention(), '审批'); assert.equal((await org.registry.identity()).members[ROOT], undefined);
    const agent = { id: ROOT, session: { id: ROOT, header: { id: ROOT, cwd } } }; live.set(ROOT, agent);
    const hostFor = current => ({ agent: current, agents, project: P });
    const invoke = async (surface, args, current = agent) => {
      if (surface === 'tool') return JSON.parse(await host.工具.get('mind').execute(args, { agent: current, signal: new AbortController().signal }));
      const { action, ...rest } = args; const reply = await host.命令.get('mind').handler({ agent: current, rawInput: `${action} ${JSON.stringify(rest)}` }); return JSON.parse(reply.text);
    };
    const status = (surface = 'command', current = agent) => invoke(surface, { action: 'status' }, current);
    const createArgs = () => ({ action: 'task_create', 描述: '业务仍须真实批准', 负责人: ROOT, 判据: '完整交付可以复核' });
    const identity = () => org.registry.identity();
    const births = async () => (await org.audit.read({})).filter(row => row.动作 === '主体创建' && row.对象?.id === ROOT && row.详情?.机制动作 === '实例出生');
    await run({ f, org, host, live, agents, agent, hostFor, invoke, status, createArgs, identity, births });
  } finally { host.清理(); if (org) await drainKernelAudit(org); forgetSharedOrg(config); await f.cleanup(); }
}

describe('独立Lead出生：审批正链与窄例外', { timeout: 60_000 }, () => {
  for (const surface of ['command', 'tool']) {
    it(`${surface}首次root在审批档出生，业务仍挂整单、批准一次执行且旧批准不可重放`, async () => scene(async ({ org, invoke, status, createArgs, identity, births }) => {
      assert.equal((await status(surface)).成功, true); const member = (await identity()).members[ROOT]; assert.equal(member.岗位, 'Lead'); assert.equal(member.status, '在岗'); assert.equal((await org.registry.cardOf(ROOT)).就绪, true); assert.equal((await births()).length, 1);
      const args = createArgs(); const pending = await invoke(surface, args); assert.equal(pending.成功, false); assert.equal(pending.结果, '需确认'); assert.equal((await org.tasks.list({ 项目: P })).length, 0); assert.equal(org.policy.intervention(), '审批');
      const requests = await org.intervention.人侧待决({ 项目: P }); assert.equal(requests.length, 1); assert.equal(requests[0].动作, 'task_create'); assert.ok(requests[0].步骤.length > 0); const id = requests[0].请求id;
      await org.intervention.人侧决议({ 请求id: id, 决定: '批准', 通道: '设置页', 认证: '宿主Connection已认证' }); const done = await invoke(surface, { ...args, 审批引用: id }); assert.equal(done.成功, true, JSON.stringify(done)); assert.equal(done.节点.状态, '待派发'); assert.equal((await org.tasks.list({ 项目: P })).length, 1);
      assert.equal((await invoke(surface, { ...args, 审批引用: id })).成功, false); assert.equal((await org.tasks.list({ 项目: P })).length, 1); assert.equal((await births()).length, 1);
    }));
  }

  it('无宿主旧ensure仍须审批，自报context/JSON不能签出生例外', async () => scene(async ({ org, identity }) => {
    await assert.rejects(() => org.registry.ensureLeadInstance({ 实例: ROOT, 代次: org.boot.代次 }), NeedsApproval); assert.equal((await identity()).members[ROOT], undefined);
    for (const extra of [{}, { 已认证: true, 宿主出生: true }, { 宿主: { agent: { id: ROOT, session: { id: ROOT, header: {} } }, agents: {} } }]) { const input = permission(); Object.assign(input.context, extra); assert.equal((await org.policy.decide(input)).verdict, 'confirm'); assert.equal(org.policy.会挂起(input), true); }
  }));

  it('普通成员与两类子会话事实不能借args的实例/机制/宿主假扮root出生', async () => scene(async ({ org, live, agent, invoke, identity }) => {
    for (const header of [{ origin: 'subagent' }, { delegationDepth: 1 }]) {
      const id = `child-${Object.keys(header)[0]}`; const child = { id, session: { id, header: { id, cwd: agent.session.header.cwd, ...header } } }; live.set(id, child);
      const result = await invoke('tool', { action: 'status', 实例: ROOT, 机制动作: '实例出生', 宿主: { agent: { id: ROOT } } }, child); assert.equal(result.成功, false); assert.equal((await identity()).members[id], undefined); assert.equal((await identity()).members[ROOT], undefined);
    }
    assert.equal((await org.registry.identity()).members[ROOT], undefined);
  }));

  it('同id对象副本、跨实例与agents失配不能获得例外', async () => scene(async ({ org, agent, hostFor, live, identity }) => {
    const clone = structuredClone(agent);
    for (const [id, host] of [[ROOT, hostFor(clone)], ['another-root', hostFor(agent)], [ROOT, { ...hostFor(agent), agents: { get: () => undefined } }], [ROOT, { ...hostFor(agent), agent: { ...agent, session: { ...agent.session, id: 'other' } } }]]) {
      await assert.rejects(() => org.registry.ensureLeadInstance({ 实例: id, 代次: org.boot.代次, 宿主: host }), Denied); assert.equal((await identity()).members[id], undefined);
    }
    live.delete(ROOT); await assert.rejects(() => org.registry.ensureLeadInstance({ 实例: ROOT, 代次: org.boot.代次, 宿主: hostFor(agent) }), Denied); assert.equal((await identity()).members[ROOT], undefined);
  }));

  it('缺header或不一致header.id不能仅靠live Map命中出生', async () => scene(async ({ org, live, agent, hostFor, identity }) => {
    for (const session of [{ id: ROOT }, { id: ROOT, header: { id: 'other', cwd: agent.session.header.cwd } }, { id: ROOT, header: { id: ROOT, delegationDepth: -1 } }]) { const current = { id: ROOT, session }; live.set(ROOT, current); await assert.rejects(() => org.registry.ensureLeadInstance({ 实例: ROOT, 代次: org.boot.代次, 宿主: hostFor(current) }), Denied); assert.equal((await identity()).members[ROOT], undefined); }
  }));

  it('ALS内只匹配本实例/卡/tuple；assign、业务写与Lead运行绑定不随之免批', async () => scene(async ({ org, agent, hostFor, identity }) => {
    const input = permission(); await org.policy.withLeadBirth({ 实例: ROOT, 宿主: hostFor(agent), 卡版本: HASH }, async () => {
      assert.equal((await org.policy.decide(input)).verdict, 'allow'); assert.equal(org.policy.会挂起(input), false);
      const variants = [{ ...input, target: { ...input.target, id: 'other' } }, { ...input, context: { ...input.context, 卡版本: 'b'.repeat(64) } }, { ...input, target: { ...input.target, 岗位: '插件工程' } }, { ...input, action: 'write', context: { 身份操作: '实例', 机制动作: 'Lead运行绑定' } }, { ...input, target: { ...input.target, kind: '任务' } }];
      for (const value of variants) { assert.notEqual((await org.policy.decide(value)).verdict, 'allow'); assert.equal(org.policy.会挂起(value), true); }
      await assert.rejects(() => org.registry.assign({ subject: { id: ROOT, kind: 'Lead' }, 实例: 'new-member', 岗位: '插件工程' }));
    }); assert.equal((await identity()).members[ROOT], undefined); assert.equal((await org.policy.decide(input)).verdict, 'confirm');
  }));

  it('ALS返回或抛错后的迟到异步分支不能继续享有出生例外', async () => scene(async ({ org, agent, hostFor, identity }) => {
    for (const throws of [false, true]) {
      const gate = deferred(); let late; const input = permission(); const expected = new Error('isolated-birth-callback-failure');
      const run = () => org.policy.withLeadBirth({ 实例: ROOT, 宿主: hostFor(agent), 卡版本: HASH }, async () => { assert.equal((await org.policy.decide(input)).verdict, 'allow'); late = (async () => { await gate.promise; return org.policy.decide(input); })(); if (throws) throw expected; return 'done'; });
      if (throws) await assert.rejects(run, error => error === expected); else assert.equal(await run(), 'done'); gate.resolve(); assert.equal((await late).verdict, 'confirm'); assert.equal(org.policy.会挂起(input), true); assert.equal((await identity()).members[ROOT], undefined);
    }
  }));
});

describe('独立Lead出生：硬闸与锁内竞态', { timeout: 60_000 }, () => {
  it('策略坏不能出生，诊断不把未就绪改成注册成功', async () => scene(async ({ f, org, status, identity }) => {
    await f.write('集体L2-共享基础设施/defaults/介入度.json', '{broken'); assert.equal(await org.policy.reload(), false); await status(); assert.equal((await identity()).members[ROOT], undefined);
  }));

  for (const id of [ROOT, 'Lead']) it(`撤回${id}仍阻止首次出生`, async () => scene(async ({ org, status, identity }) => { await org.registry.revoke({ subject: SOVEREIGN, 对象id: id, 理由: '明确撤回不能被机械出生恢复' }); await status(); assert.equal((await identity()).members[ROOT], undefined); assert.ok((await identity()).denylist.some(row => row.id === id)); }));

  it('失联冻结仍阻止首次出生，不给system整体豁免', async () => scene(async ({ org, status, identity }) => {
    org.clock._source = () => new Date(Date.now() + 30 * 24 * 3600_000); await org.policy.reload(); assert.equal(org.policy.presence().lost, true); await status(); assert.equal((await identity()).members[ROOT], undefined);
  }));

  it('Lead卡声明错岗不能出生，也不能把任意卡钉成Lead', async () => scene(async ({ f, org, status, identity }) => {
    const file = join(f.factoryRoot, '集体L3-成员角色卡/Lead.md'); const text = await readFile(file, 'utf8'); await writeFile(file, text.replace('id: Lead', 'id: 插件工程'), 'utf8'); await org.policy.reload(); await status(); assert.equal((await identity()).members[ROOT], undefined);
  }));

  it('已有封存、错岗或坏钉卡不由出生路径修复', async () => {
    for (const mode of ['seal', 'wrong-role', 'bad-snapshot']) await scene(async ({ f, org, status, identity }) => {
      if (mode === 'wrong-role') await org.registry.assign({ subject: SOVEREIGN, 实例: ROOT, 岗位: '插件工程' });
      else { await status(); if (mode === 'seal') await org.registry.seal({ subject: SOVEREIGN, 实例: ROOT, 理由: '明确封存' }); else { const hash = (await identity()).members[ROOT].卡版本.摘要; await writeFile(f.layout.cardSnapshot(hash), '{}\n', 'utf8'); } }
      const before = (await identity()).members[ROOT]; const result = await status(); assert.equal(result.实例登记?.就绪, false); assert.deepEqual((await identity()).members[ROOT], before);
    });
  });

  it('首个policy通过后锁内真实撤权不能落出生记录', async () => scene(async ({ org, status, identity, births }) => {
    const check = org.policy.check.bind(org.policy); let changed = false;
    org.policy.check = async input => { const result = await check(input); if (!changed && input.subject?.kind === '系统' && input.action === 'create' && input.target?.id === ROOT) { changed = true; await org.registry.revoke({ subject: SOVEREIGN, 对象id: ROOT, 理由: '提交窗口撤权' }); } return result; };
    const result = await status(); assert.equal(changed, true); assert.equal(result.实例登记?.就绪, false); assert.equal((await identity()).members[ROOT], undefined); assert.equal((await births()).length, 0);
  }));

  it('首判后竞争登记成员岗不能被认作Lead就绪', async () => scene(async ({ org, status, identity, births }) => {
    const check = org.policy.check.bind(org.policy); let changed = false;
    org.policy.check = async input => { const result = await check(input); if (!changed && input.subject?.kind === '系统' && input.action === 'create' && input.target?.id === ROOT) { changed = true; await org.registry.assign({ subject: SOVEREIGN, 实例: ROOT, 岗位: '插件工程' }); } return result; };
    const result = await status(); assert.equal(changed, true); assert.equal(result.实例登记?.就绪, false); assert.equal((await identity()).members[ROOT].岗位, '插件工程'); assert.equal((await births()).length, 0);
    assert.equal((await org.audit.read({})).filter(row => row.动作 === '主体创建' && row.对象?.id === ROOT && row.主体?.id === SOVEREIGN.id).length, 1);
  }));

  it('首判后现行Lead卡变化不能用早摘要出生', async () => scene(async ({ f, org, status, identity, births }) => {
    const check = org.policy.check.bind(org.policy); let changed = false;
    org.policy.check = async input => { const result = await check(input); if (!changed && input.subject?.kind === '系统' && input.action === 'create' && input.target?.id === ROOT) { changed = true; const file = join(f.factoryRoot, '集体L3-成员角色卡/Lead.md'); await writeFile(file, (await readFile(file, 'utf8')) + '\n新的卡规程不得偷换旧摘要。\n', 'utf8'); } return result; };
    const result = await status(); assert.equal(changed, true); assert.equal(result.实例登记?.就绪, false); assert.equal((await identity()).members[ROOT], undefined); assert.equal((await births()).length, 0);
  }));

  it('并发首次出生只留一个身份和一条出生审计，重复status不再写出生', async () => scene(async ({ status, identity, births }) => {
    const results = await Promise.all([status('tool'), status('command')]); assert.ok(results.every(result => result.成功 === true)); assert.equal((await identity()).members[ROOT].岗位, 'Lead'); assert.equal((await births()).length, 1); await status(); assert.equal((await births()).length, 1);
  }));

  it('旧Lead运行绑定在审批仍未自动恢复，首次出生例外不泛化为续接授权', async () => scene(async ({ f, org, status, identity }) => {
    await status(); const file = f.layout.identityFile(); const doc = JSON.parse(await readFile(file, 'utf8')); doc.members[ROOT].代次 = { 代: 'old-host', pid: 999999 }; doc.members[ROOT].运行绑定 = { 状态: '失效', 于: '2026-10-20T00:00:00Z' }; await writeFile(file, JSON.stringify(doc) + '\n', 'utf8'); await org.policy.reload(); const before = (await identity()).members[ROOT];
    const result = await status(); assert.equal(result.实例登记?.就绪, false); assert.deepEqual((await identity()).members[ROOT], before); assert.equal(org.policy.intervention(), '审批');
  }));
});
