/** 真模块 apply + 同步 guard + 动作入口；全部使用临时双区，不碰运行态组织账本。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { makeFixture, LEAD } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { shareOrg } from '../src/runtime.js';
import { runAction } from '../lib/actions.js';
import { NeedsApproval, Fault } from '../src/kernel/errors.js';
import * as plugin from '../components/kernel/lib/index.js';

const P = 'council-entry';
const 模型路由 = { 模型供应商: 'openai-codex', 模型: 'gpt-6.1-sol', 推理档: 'high' };

async function setup() {
  const f = await makeFixture();
  const cwd = join(f.home, P);
  const materials = join(cwd, 'materials');
  await mkdir(materials, { recursive: true });
  const brief = join(materials, 'brief.md');
  await writeFile(brief, '资料正文\n', 'utf8');
  const calls = { spawn: [], send: [], stop: [], drain: [] };
  const agent = { session: { id: 'lead', header: { cwd } } };
  const subagents = {
    async startActivation(spec) {
      assert.equal(this, subagents, '宿主方法不能裸调用');
      assert.equal(spec.request.parent, agent);
      assert.ok(spec.signal instanceof AbortSignal);
      assert.equal(spec.request.signal, spec.signal);
      calls.spawn.push(spec);
      return { childId: `consult-${calls.spawn.length}`, messageId: 'started' };
    },
    async sendMessage(parent, id, content, options) {
      assert.equal(this, subagents);
      assert.equal(parent, agent);
      assert.ok(options.signal instanceof AbortSignal);
      calls.send.push({ id, content });
      return { messageId: `sent-${calls.send.length}` };
    },
    interrupt(id, owner) { assert.equal(this, subagents); assert.equal(owner.agent, agent); calls.stop.push(id); },
    async drainChildren(parent, ids) { assert.equal(this, subagents); assert.equal(parent, agent); calls.drain.push(...ids); },
  };
  const host = fakeHost({ 提供服务: ['tools', 'commands', 'systemPrompt', 'subagents'], 服务: { subagents } });
  const config = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P,
    delegation: { mode: 'lead-discretion', projects: [P], authorizationRef: 'isolated-recovery-test' } };
  await plugin.apply(host.ctx, config);
  const org = await shareOrg(config);
  const tool = host.工具.get('mind');
  assert.equal(typeof tool?.execute, 'function', '真实 mind 必须已注册');
  const exec = (id, name, args, dir = cwd) => ({ name, arguments: args, signal: new AbortController().signal,
    agent: id === 'lead' ? agent : { session: { id, header: { origin: 'subagent', parentSession: 'lead', cwd: dir } } } });
  const guard = (e) => {
    for (const fn of host.闸) {
      const out = fn(e);
      assert.ok(out === undefined || typeof out === 'string', '必须同步返回 string/undefined，不能抛缺函数/Promise');
      if (out !== undefined) return out;
    }
    return undefined;
  };
  const invoke = async (id, args) => {
    const e = exec(id, 'mind', args);
    assert.equal(guard(e), undefined, '正例必须真正走到 mind execute');
    return JSON.parse(await tool.execute(args, e));
  };
  const hostServices = { agent, subagents, delegation: { authorize: () => ({ fingerprint: 'test' }) } };
  const action = (args, services = hostServices) => runAction({ org, 项目: P, 主体: LEAD, subject: LEAD, 面: 'tool', 宿主: services, args });
  const openArgs = { action: 'debate_open', 问题: '隔离咨询问题', 参与岗位: '插件工程,插件工程', 方式: 'subagent', 资料: materials, ...模型路由 };
  const open = async () => {
    const result = await invoke('lead', openArgs);
    assert.equal(result.成功, true, JSON.stringify(result));
    return result.会审;
  };
  const close = async () => { host.清理(); await f.cleanup(); };
  return { f, cwd, materials, brief, calls, subagents, org, exec, guard, invoke, action, hostServices, openArgs, open, close };
}

async function unlock(s, council) {
  for (const [i, id] of council.参与者.entries()) {
    const result = await s.invoke(id, { action: 'debate_answer', id: council.id, 结论: `秘密答案-${i}`, 结论层: `方案${i}` });
    assert.equal(result.成功, true, JSON.stringify(result));
    if (i === 1) assert.ok(!JSON.stringify(result).includes('秘密答案-0'), '交卷回执仍遮他人答案');
  }
  const result = await s.invoke('lead', { action: 'debate_unlock', id: council.id });
  assert.equal(result.成功, true, JSON.stringify(result));
}

async function alterIdentity(s, change) {
  const file = s.f.layout.identityFile();
  const doc = JSON.parse(await readFile(file, 'utf8'));
  change(doc);
  await writeFile(file, JSON.stringify(doc), 'utf8');
}

describe('恢复入口：真作用域、工具闸、审批计划', () => {
  it('真实 apply→spawn→登记→作答→解锁→讨论→收敛→退役；路由不回落、任务图零增长', async () => {
    const s = await setup();
    try {
      const before = (await s.org.tasks.list({ 项目: P })).length;
      const council = await s.open();
      assert.equal(s.calls.spawn.length, 2);
      assert.ok(s.calls.spawn.every((x) => x.request.agentOptions.model === 'gpt-6.1-sol'));
      assert.equal(s.calls.send.length, 2);
      assert.ok(s.calls.send.every((x) => x.content[0].text.includes('已钉版')));
      await unlock(s, council);
      assert.equal((await s.invoke('lead', { action: 'debate_round', id: council.id })).成功, true);
      const 发言 = await s.invoke('consult-1', { action: 'debate_say', id: council.id, 类型: '分歧', 内容: '不同边界' });
      assert.equal(发言.成功, true, JSON.stringify(发言));
      const result = await s.invoke('lead', { action: 'debate_converge', id: council.id, 内容: '取长补短' });
      assert.equal(result.成功, true, JSON.stringify(result));
      assert.deepEqual(s.calls.stop.sort(), ['consult-1', 'consult-2']);
      const doc = await s.org.registry.identity();
      assert.equal(doc.members['consult-1'].status, '封存');
      assert.equal(doc.members['consult-2'].status, '封存');
      assert.equal((await s.org.tasks.list({ 项目: P })).length, before);
    } finally { await s.close(); }
  });

  it('咨询工具闭名单：代码写、shell、创建、能力发布、安全类写、未知工具全拒；普通成员/Lead 不误伤', async () => {
    const s = await setup();
    try {
      const council = await s.open();
      for (const name of ['write', 'edit', 'pwsh', 'subagent', 'spawn_teammate', 'workflow', 'mind_guard', 'mystery_exec']) {
        assert.match(s.guard(s.exec('consult-1', name, {})), /闭名单/);
      }
      for (const action of ['capability_publish', 'memory_write', 'task_create', 'member_spawn', 'debate_open', 'debate_unlock', 'bus_send']) {
        assert.match(s.guard(s.exec('consult-1', 'mind', { action, id: council.id })), /不得执行/);
      }
      assert.equal(s.guard(s.exec('member-a', 'write', { file_path: s.brief })), undefined);
      assert.equal(s.guard(s.exec('lead', 'write', { file_path: s.brief })), undefined);
      assert.match(s.guard(s.exec('consult-1', 'mind', { action: 'debate_answer', id: 'other' })), /只绑定/);
      assert.match(s.guard(s.exec('consult-1', 'mind', { action: 'status', project: 'other' })), /只服务项目/);
      assert.equal(s.guard(s.exec('consult-1', 'mind', { action: 'bus_read', 线程: `会审-${council.id}` })), undefined);
      assert.match(s.guard(s.exec('consult-1', 'mind', { action: 'bus_read', 线程: 'other' })), /只能读会审/);
    } finally { await s.close(); }
  });

  it('资料读根：真 arguments、绝对/相对/大小写/../junction；缺资料、私有父目录递归和界外均拒', async () => {
    const s = await setup();
    try {
      await s.open();
      assert.equal(s.guard(s.exec('consult-1', 'read', { file_path: s.brief })), undefined);
      assert.equal(s.guard(s.exec('consult-1', 'read', { file_path: 'materials/../materials/brief.md' })), undefined);
      assert.equal(s.guard(s.exec('consult-1', 'glob', { pattern: '*.md', path: s.materials })), undefined);
      if (process.platform === 'win32') assert.equal(s.guard(s.exec('consult-1', 'read', { file_path: s.brief.toUpperCase() })), undefined);
      for (const name of ['read', 'read_image', 'glob', 'grep']) assert.match(s.guard(s.exec('consult-1', name, {})), /路径|资料根/);
      const badExec = s.exec('consult-1', 'read', undefined); badExec.input = { file_path: s.brief };
      assert.match(s.guard(badExec), /arguments/);
      const link = join(s.materials, 'private-link');
      symlinkSync(s.f.privateRoot, link, 'junction');
      assert.match(s.guard(s.exec('consult-1', 'read', { file_path: join(link, '身份档案', 'identity.json') })), /私有区/);
      assert.match(s.guard(s.exec('consult-1', 'grep', { pattern: '.', path: s.f.home })), /私有区/);
      assert.match(s.guard(s.exec('consult-1', 'read', { file_path: join(s.f.factoryRoot, '集体L0-宪章', '宪章.md') })), /资料根/);
      await alterIdentity(s, (d) => { d.members['consult-1'].会审绑定.资料 = []; });
      assert.match(s.guard(s.exec('consult-1', 'read', { file_path: s.brief })), /没有资料/);
    } finally { await s.close(); }
  });

  it('冻结资料根不得在被换成 junction 后自动授权到新目标', async () => {
    const s = await setup();
    try {
      await s.open();
      const other = join(s.cwd, 'other');
      await mkdir(other); await writeFile(join(other, 'brief.md'), '界外正文');
      await rename(s.materials, `${s.materials}-original`);
      symlinkSync(other, s.materials, 'junction');
      assert.match(s.guard(s.exec('consult-1', 'read', { file_path: s.brief })), /资料根/);
    } finally { await s.close(); }
  });

  it('报告复用 agent_id/target 真变体；卡坏/绑定坏不堵向真实 Lead 的故障上报，但不许叫醒其他成员', async () => {
    const s = await setup();
    try {
      await s.open();
      for (const args of [{ agent_id: 'lead', message: '故障' }, { target: 'lead', message: '故障' }, { agent_id: 'lead', target: 'lead', message: '故障' }]) {
        assert.equal(s.guard(s.exec('consult-1', 'send_message', args)), undefined);
      }
      for (const args of [{ target: 'member-a', message: 'x' }, { target: 'lead', agent_id: 'member-a', message: 'x' }, { target: 'lead', recipient: 'member-a', message: 'x' }, { message: 'x' }]) {
        assert.match(s.guard(s.exec('consult-1', 'send_message', args)), /报告通道/);
      }
      await alterIdentity(s, (d) => { d.members['consult-1'].会审绑定 = 'broken'; d.members['consult-1'].卡版本.摘要 = 'f'.repeat(64); });
      assert.match(s.guard(s.exec('consult-1', 'read', { file_path: s.brief })), /未就绪|绑定不可用/);
      assert.equal(s.guard(s.exec('consult-1', 'send_message', { agent_id: 'lead', message: '坏档案' })), undefined);
    } finally { await s.close(); }
  });

  it('咨询工作台只看本场，盲卷仍遮罩，不夹带其他会审/任务/审计；直接动作面也拒跨项目', async () => {
    const s = await setup();
    try {
      const council = await s.open();
      await s.org.council.open({ subject: LEAD, 项目: P, 问题: '别场保密问题', 参与者: ['member-a', 'member-b'] });
      await s.invoke('consult-1', { action: 'debate_answer', id: council.id, 结论: '秘密独立答案' });
      const result = await s.invoke('consult-2', { action: 'workbench', 全量: true });
      assert.equal(result.成功, true, JSON.stringify(result));
      assert.equal(result.数据.会审.length, 1);
      assert.equal(result.数据.会审[0].id, council.id);
      assert.equal(result.数据.任务.总数, 0);
      assert.ok(!JSON.stringify(result).includes('秘密独立答案'));
      assert.ok(!JSON.stringify(result).includes('别场保密问题'));
      await assert.rejects(() => runAction({ org: s.org, 项目: 'other', 主体: { id: 'consult-1', kind: '成员' }, args: { action: 'status' } }), /只服务项目/);
    } finally { await s.close(); }
  });

  it('审批完整链：open 在 host 前挂完整五步单（含失败补偿）；批准一次后建两实例；converge 一次批准覆盖 write+两seal', async () => {
    const s = await setup();
    try {
      await s.f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' }));
      await s.org.policy.reload();
      let openRequest;
      await assert.rejects(() => s.action(s.openArgs), (e) => e instanceof NeedsApproval && (openRequest = e.detail.请求id, true));
      assert.equal(s.calls.spawn.length, 0);
      assert.equal((await s.org.council.list({ 项目: P })).length, 0);
      let pending = (await s.org.intervention.人侧待决({ 项目: P })).find((x) => x.请求id === openRequest);
      assert.equal(pending.步骤.length, 5);
      assert.deepEqual(pending.步骤.map((x) => [x.动作, x.目标.kind]), [['create', '会审'], ['create', '身份'], ['create', '身份'], ['seal', '身份'], ['seal', '身份']]);
      assert.deepEqual(pending.步骤.slice(3).map(x => x.补偿自), [2, 3]);
      await s.org.intervention.人侧决议({ 请求id: openRequest, 决定: '批准', 通道: '设置页', 认证: '隔离夹具认证' });
      const opened = await s.action({ ...s.openArgs, 审批引用: openRequest });
      const council = opened.会审;
      assert.equal(s.calls.spawn.length, 2);
      // setup 只在夹具切回放权，完成独立作答与解锁；随后恢复审批档验证第二个宏动作。
      await s.f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '放权' })); await s.org.policy.reload();
      await unlock(s, council);
      await s.f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' })); await s.org.policy.reload();
      const args = { action: 'debate_converge', id: council.id, 内容: '批准后结论' };
      let request;
      await assert.rejects(() => s.action(args), (e) => e instanceof NeedsApproval && (request = e.detail.请求id, true));
      assert.equal(s.calls.stop.length, 0);
      assert.equal((await s.org.council.get(P, council.id)).状态, '已解锁');
      pending = (await s.org.intervention.人侧待决({ 项目: P })).find((x) => x.请求id === request);
      assert.deepEqual(pending.步骤.map((x) => x.动作), ['write', 'seal', 'seal']);
      await s.org.intervention.人侧决议({ 请求id: request, 决定: '批准', 通道: '设置页', 认证: '隔离夹具认证' });
      await s.action({ ...args, 审批引用: request });
      assert.equal((await s.org.council.get(P, council.id)).状态, '已收敛');
      assert.equal(s.calls.stop.length, 2);
      await assert.rejects(() => s.action({ ...args, 审批引用: request }));
      assert.equal(s.calls.stop.length, 2);
    } finally { await s.close(); }
  });

  it('必要宿主接口缺失在 open/converge 副作用前拒；不假报停机成功', async () => {
    const s = await setup();
    try {
      for (const key of ['sendMessage', 'drainChildren', 'interrupt']) {
        const fn = s.subagents[key]; delete s.subagents[key];
        await assert.rejects(() => s.action(s.openArgs), (e) => e instanceof Fault && e.code === 'MEMBER_SPAWN_CONTRACT');
        s.subagents[key] = fn;
      }
      assert.equal(s.calls.spawn.length, 0);
      const council = await s.open(); await unlock(s, council);
      const fn = s.subagents.interrupt; delete s.subagents.interrupt;
      await assert.rejects(() => s.action({ action: 'debate_converge', id: council.id }), (e) => e instanceof Fault && e.code === 'COUNCIL_ADAPTER_NOT_READY');
      assert.equal((await s.org.council.get(P, council.id)).状态, '已解锁');
      assert.equal((await s.org.registry.identity()).members['consult-1'].status, '在岗');
      s.subagents.interrupt = fn;
    } finally { await s.close(); }
  });

  it('异常钉卡读取也停机并封存当前新实例；不触碰预给成员', async () => {
    const s = await setup();
    try {
      const readCard = s.org.registry.cardOf.bind(s.org.registry);
      s.org.registry.cardOf = async (id) => { if (id === 'consult-1') throw new Error('卡读取故障'); return readCard(id); };
      await assert.rejects(() => s.action({ ...s.openArgs, 参与者: 'member-a' }), (e) => e instanceof Fault && e.code === 'COUNCIL_CREATE_FAILED');
      assert.deepEqual(s.calls.stop, ['consult-1']);
      assert.equal((await s.org.registry.identity()).members['consult-1'].status, '封存');
      assert.equal((await s.org.registry.identity()).members['member-a'].status, '在岗');
      assert.equal((await s.org.council.list({ 项目: P })).length, 0);
    } finally { await s.close(); }
  });

  it('第二条开场书失败，真实动作路径作废并停封本次两个实例，预给成员不动', async () => {
    const s = await setup();
    try {
      const send = s.subagents.sendMessage;
      s.subagents.sendMessage = async function (...args) { if (args[1] === 'consult-2') throw new Error('投递故障'); return send.apply(this, args); };
      await assert.rejects(() => s.action({ ...s.openArgs, 参与者: 'member-a' }), (e) => e instanceof Fault && e.code === 'COUNCIL_SEND_FAILED');
      assert.deepEqual(s.calls.stop.sort(), ['consult-1', 'consult-2']);
      const doc = await s.org.registry.identity();
      assert.equal(doc.members['consult-1'].status, '封存'); assert.equal(doc.members['consult-2'].status, '封存');
      assert.equal(doc.members['member-a'].status, '在岗');
      assert.equal((await s.org.council.list({ 项目: P }))[0].状态, '作废');
    } finally { await s.close(); }
  });

  it('绑定未知/目录换项目 fail-closed；咨询允许结果不得旁路主权者工具总范围', async () => {
    const s = await setup();
    try {
      await s.open();
      assert.match(s.guard(s.exec('consult-1', 'read', { file_path: s.brief }, join(s.f.home, 'other'))), /不是绑定项目/);
      await alterIdentity(s, (d) => { d.members['consult-1'].会审绑定 = {}; });
      assert.match(s.guard(s.exec('consult-1', 'mind', { action: 'status' })), /绑定不可用/);
      assert.equal(s.guard(s.exec('consult-1', 'send_message', { target: 'lead', message: '故障' })), undefined);
      await alterIdentity(s, (d) => { d.members['consult-1'].会审绑定 = { 会审: 'c', 项目: P, 来源会话: 'lead', 资料: [s.materials] }; });
      await s.f.write('集体L2-共享基础设施/defaults/工具总范围.json', JSON.stringify({ 允许: [], 拒绝: ['read'] }));
      const second = fakeHost();
      try {
        await plugin.apply(second.ctx, { home: s.f.home, factoryRoot: s.f.factoryRoot, privateRoot: s.f.privateRoot, project: P });
        assert.match(s.guard(s.exec('consult-1', 'read', { file_path: s.brief })), /工具总范围之外/);
      } finally { second.清理(); }
    } finally { await s.close(); }
  });
});
