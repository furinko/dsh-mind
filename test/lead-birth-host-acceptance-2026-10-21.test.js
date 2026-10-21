/** 真宿主发布反例的领域复现；真实宿主HTTP/GUI另由隔离验收执行。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { apply } from '../components/kernel/lib/index.js';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';
import { MECHANISM_SUBJECT } from '../src/mechanism.js';
import { Denied, NeedsApproval } from '../src/kernel/errors.js';

const P = 'lead-birth-host-acceptance';
async function scene(run, options = {}) {
  const f = await makeFixture({ defaults: { 介入度: '审批' }, ...options });
  const id = `session-${randomUUID()}`;
  const agent = { id, session: { id, header: { id, cwd: f.home } } };
  const agents = { get: key => key === agent.id ? agent : undefined };
  const host = fakeHost({ 提供服务: ['tools', 'commands', 'systemPrompt', 'agents'], 服务: { agents } });
  const spec = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P, projectBindings: [{ path: f.home, project: P }] };
  let org;
  try {
    await apply(host.ctx, spec); org = await shareOrg(spec);
    const invoke = async (face, args) => face === 'tool'
      ? JSON.parse(await host.工具.get('mind').execute(args, { name: 'mind', callId: randomUUID(), agent, signal: new AbortController().signal }))
      : JSON.parse((await host.命令.get('mind').handler({ agent, rawInput: `${args.action} ${JSON.stringify(Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'action')))}` })).text);
    const live = { agent, agents, project: P };
    await run({ f, org, host, agent, id, live, invoke });
  } finally {
    host.清理();
    if (org) { await org.observability.flush(); await org.modelUsageHooks?.flush?.(); await org.budgetHooks?.flush?.(); }
    forgetSharedOrg(spec); await f.cleanup();
  }
}

describe('审批档真实根会话有限出生', () => {
  for (const face of ['command', 'tool']) it(`${face}:首次status机械钉卡，业务仍挂审批，一次批准才创建`, async () => scene(async ({ org, id, invoke }) => {
    assert.equal((await org.registry.identity()).members[id], undefined);
    const status = await invoke(face, { action: 'status' }); assert.equal(status.成功, true); assert.equal(status.实例登记, undefined);
    const member = (await org.registry.identity()).members[id]; assert.equal(member.岗位, 'Lead'); assert.equal(member.status, '在岗'); assert.equal((await org.registry.cardOf(id)).就绪, true);
    assert.equal((await org.intervention.人侧待决({ 会话: id })).length, 0, '机械出生不生成业务批准票');
    const args = { action: 'task_create', 描述: '新根会话审批验收', 负责人: [id], 判据: ['必须批准后才创建'] };
    const pending = await invoke(face, args); assert.equal(pending.成功, false); assert.equal((await org.tasks.list({ 项目: P })).length, 0);
    const rows = await org.intervention.人侧待决({ 项目: P, 会话: id }); assert.equal(rows.length, 1); assert.equal(rows[0].步骤.length, 1); assert.equal(rows[0].步骤[0].目标.kind, '任务');
    await org.intervention.人侧决议({ 请求id: rows[0].请求id, 决定: '批准', 通道: '所属会话', 认证: '隔离测试人侧适配', 项目: P, 会话: id, 审阅指纹: rows[0].审阅指纹 });
    const completed = await invoke(face, { ...args, 审批引用: rows[0].请求id }); assert.equal(completed.成功, true); assert.equal(completed.节点.状态, '待派发');
    assert.equal((await invoke(face, { ...args, 审批引用: rows[0].请求id })).成功, false); assert.equal((await org.tasks.list({ 项目: P })).length, 1);
    assert.equal((await org.audit.read()).filter(row => row.动作 === '主体创建' && row.对象.id === id).length, 1);
  }));

  it('旧内部ensure在审批无live证据仍拒，放权旧调用兼容', async () => scene(async ({ f, org, id }) => {
    await assert.rejects(() => org.registry.ensureLeadInstance({ 实例: id, 宿主会话: { id, header: { id } } }), error => error instanceof NeedsApproval);
    assert.equal((await org.registry.identity()).members[id], undefined);
    await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '放权' })); await org.policy.reload();
    assert.equal((await org.registry.ensureLeadInstance({ 实例: id })).就绪, true);
  }));

  it('同id假Agent、子会话、不同实例与缺header均不能签发有限出生', async () => scene(async ({ org, id, agent, live }) => {
    const duplicate = structuredClone(agent);
    for (const bad of [
      { ...live, agent: duplicate },
      { ...live, agent: { ...agent, session: { id, header: { id, origin: 'subagent' } } } },
      { ...live, agent: { ...agent, session: { id, header: { id, delegationDepth: -1 } } } },
      { ...live, agent: { ...agent, session: { id } } },
    ]) await assert.rejects(() => org.registry.ensureLeadInstance({ 实例: id, 宿主: bad }), error => error instanceof Denied);
    await assert.rejects(() => org.registry.ensureLeadInstance({ 实例: 'other-root', 宿主: live }), error => error instanceof Denied);
    assert.equal((await org.registry.identity()).members[id], undefined);
  }));

  it('context字符串与任意卡摘要不能从模型策略预检取得例外', async () => scene(async ({ org, id }) => {
    const decision = await org.policy.decide({ subject: MECHANISM_SUBJECT, action: 'create', target: { id, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: null, 岗位: 'Lead' }, context: { 身份操作: '实例', 机制动作: '实例出生', 卡版本: 'a'.repeat(64), 宿主: true } });
    assert.equal(decision.verdict, 'confirm');
  }));

  it('有限上下文只解除出生confirm，其它tuple照审批且迟到子链失效', async () => scene(async ({ org, id, live }) => {
    const hash = (await org.registry.cardOf('lead')).卡版本.摘要;
    const permission = { subject: MECHANISM_SUBJECT, action: 'create', target: { id, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: null, 岗位: 'Lead' }, context: { 身份操作: '实例', 机制动作: '实例出生', 卡版本: hash } };
    let late; let release; const wait = new Promise(done => { release = done; });
    await org.policy.withLeadBirth({ 实例: id, 宿主: live, 卡版本: hash }, async () => {
      assert.equal(org.policy.会挂起(permission), false); assert.equal((await org.policy.decide(permission)).verdict, 'allow');
      for (const changed of [{ action: 'write', context: { 机制动作: 'Lead运行绑定' } }, { target: { ...permission.target, id: 'other' } }, { target: { ...permission.target, 岗位: '插件工程' } }, { context: { ...permission.context, 卡版本: 'b'.repeat(64) } }]) assert.notEqual((await org.policy.decide({ ...permission, ...changed })).verdict, 'allow');
      late = (async () => { await wait; return org.policy.decide(permission); })();
    });
    release(); assert.equal((await late).verdict, 'confirm'); assert.equal(org.policy.会挂起(permission), true);
  }));

  it('预检后真实撤回在identity锁内复判拒，不追加新身份', async () => scene(async ({ org, id, live }) => {
    const check = org.policy.check.bind(org.policy); let changed = false;
    org.policy.check = async input => { const value = await check(input); if (!changed && input.subject?.kind === '系统' && input.target?.id === id) { changed = true; await org.registry.revoke({ subject: SOVEREIGN, 对象id: id, 理由: '出生提交前撤回' }); } return value; };
    await assert.rejects(() => org.registry.ensureLeadInstance({ 实例: id, 宿主: live }), error => error instanceof Denied);
    assert.equal(changed, true); assert.equal((await org.registry.identity()).members[id], undefined);
  }));

  it('预检后Lead卡变更不能钉旧版，下一次新准备可登记新卡', async () => scene(async ({ f, org, id, live }) => {
    const check = org.policy.check.bind(org.policy); let changed = false;
    org.policy.check = async input => { const value = await check(input); if (!changed && input.subject?.kind === '系统' && input.target?.id === id) { changed = true; const path = f.layout.factory('集体L3-成员角色卡', 'Lead.md'); const card = await readFile(path, 'utf8'); await writeFile(path, `${card}\n<!-- 出生准备后更新 -->\n`); } return value; };
    await assert.rejects(() => org.registry.ensureLeadInstance({ 实例: id, 宿主: live }), error => error instanceof Denied && /卡版本变化/.test(error.rule));
    assert.equal((await org.registry.identity()).members[id], undefined); assert.equal((await org.registry.ensureLeadInstance({ 实例: id, 宿主: live })).就绪, true);
  }));

  it('并发新根出生只落一条真实创建审计，不重复重钉', async () => scene(async ({ org, id, live }) => {
    const results = await Promise.all([org.registry.ensureLeadInstance({ 实例: id, 宿主: live }), org.registry.ensureLeadInstance({ 实例: id, 宿主: live })]);
    assert.ok(results.every(result => result.就绪 === true)); assert.equal(results.filter(result => result.新建 === true).length, 1);
    assert.equal((await org.audit.read()).filter(row => row.动作 === '主体创建' && row.对象.id === id).length, 1);
  }));

  it('命令面未就绪业务写在审批前拒，status诚实且人侧恢复仍可达', async () => scene(async ({ org, host, agent, id }) => {
    delete host.ctx.agents; host.ctx.get = name => name === 'agents' ? undefined : host.ctx[name];
    const command = host.命令.get('mind');
    const status = JSON.parse((await command.handler({ agent, rawInput: 'status' })).text); assert.equal(status.成功, true); assert.equal(status.实例登记.就绪, false);
    const write = JSON.parse((await command.handler({ agent, rawInput: `task_create ${JSON.stringify({ 描述: '不能冻结幽灵Lead', 负责人: [id], 判据: ['先真实登记'] })}` })).text); assert.equal(write.成功, false); assert.match(write.规则, /未就绪/);
    assert.equal((await org.intervention.人侧待决({ 会话: id })).length, 0); assert.equal((await org.tasks.list({ 项目: P })).length, 0);
    const presence = JSON.parse((await command.handler({ agent, rawInput: 'presence' })).text); assert.equal(presence.成功, true);
  }));
});
