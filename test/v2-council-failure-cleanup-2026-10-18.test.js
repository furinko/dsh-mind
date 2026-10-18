/** 真实 Org/runAction + 契约宿主故障注入；状态只读临时双区。 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { readJsonl } from '../src/kernel/fsx.js';
import { NeedsApproval } from '../src/kernel/errors.js';
import { 以放行上下文, 本次放行匹配, 本次放行可匹配, 记录本次新建, 当前放行 } from '../src/intervention.js';

const P = 'council-failures';
async function setup() {
  const f = await makeFixture();
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  const calls = { spawn: 0, stop: [], drain: [] };
  const agent = { session: { id: 'lead' } };
  const subagents = {
    async startActivation() { assert.equal(this, subagents); return { childId: `owned-${++calls.spawn}` }; },
    async sendMessage() { assert.equal(this, subagents); return { messageId: 'sent' }; },
    async interrupt(id) { assert.equal(this, subagents); calls.stop.push(id); },
    async drainChildren(parent, ids) { assert.equal(this, subagents); assert.equal(parent, agent); calls.drain.push(...ids); },
    async listChildren() { return [{ id: 'owned-1', label: 'real child' }, { id: 'unregistered', label: 'unknown child' }]; },
  };
  const host = { agent, subagents, delegation: { authorize: () => ({ fingerprint: 'isolated-failure-test' }) } };
  const action = (args) => runAction({ org, 项目: P, 主体: LEAD, 面: 'tool', 宿主: host, args });
  const openArgs = { action: 'debate_open', 问题: '失败矩阵', 参与者: 'member-a', 参与岗位: '插件工程,插件工程', 方式: 'subagent' };
  const mode = async (value) => { await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: value })); await org.policy.reload(); };
  const approve = async (args) => {
    let request;
    await assert.rejects(() => action(args), e => e instanceof NeedsApproval && (request = e.detail.请求id, true));
    await org.intervention.人侧决议({ 请求id: request, 决定: '批准', 通道: '设置页', 认证: '隔离夹具' });
    return request;
  };
  const injectAudit = (predicate) => {
    const append = org.audit.append.bind(org.audit);
    org.audit.append = async (row) => { if (predicate(row)) throw new Error(`injected audit: ${row.动作}`); return append(row); };
  };
  return { f, org, calls, subagents, action, openArgs, mode, approve, injectAudit };
}

it('审批第二次spawn失败：冻结补偿意图可预览，只清当前实际owned', async () => {
  const s = await setup();
  try {
    await s.mode('审批');
    const request = await s.approve(s.openArgs);
    const pending = (await s.org.intervention.人侧待决({ 项目: P })).find(x => x.请求id === request);
    const start = s.subagents.startActivation;
    s.subagents.startActivation = async function () { if (s.calls.spawn === 1) throw new Error('second spawn injected'); return start.call(this); };
    let failure;
    await assert.rejects(() => s.action({ ...s.openArgs, 审批引用: request }), e => (failure = e, e.code === 'COUNCIL_CREATE_FAILED'));
    const members = (await s.org.registry.identity()).members;
    console.log('approval spawn failure:', members['owned-1'].status, JSON.stringify(failure.detail));
    assert.equal(members['owned-1'].status, '封存');
    assert.equal(members['member-a'].status, '在岗');
    assert.equal(pending.步骤.filter(x => x.动作 === 'seal' && x.补偿自).length, 2);
    assert.deepEqual(failure.detail.补偿失败, []);
    assert.equal((await s.org.intervention.投影({ 项目: P })).find(x => x.请求id === request).状态, '失败');
  } finally { await s.f.cleanup(); }
});

for (const stage of ['状态变更', '主体创建', '成员创建']) it(`登记后${stage}审计失败：当前尚未回Council的实例也清理`, async () => {
  const s = await setup();
  try {
    await s.mode('审批');
    const request = await s.approve(s.openArgs);
    s.injectAudit(row => row.动作 === stage && row.对象?.id === 'owned-1');
    let failure;
    await assert.rejects(() => s.action({ ...s.openArgs, 审批引用: request }), e => (failure = e, e.code === 'COUNCIL_CREATE_FAILED'));
    assert.equal((await s.org.registry.identity()).members['owned-1'].status, '封存');
    assert.equal((await s.org.registry.identity()).members['member-a'].status, '在岗');
    assert.ok([...s.calls.stop, ...s.calls.drain].includes('owned-1'));
    assert.match(JSON.stringify(failure.detail), /injected audit/);
    assert.equal(failure.detail.错误详情.实例, 'owned-1');
    if (stage === '状态变更') assert.match(failure.detail.错误详情.补偿失败, /封存失败.*injected audit: 状态变更/);
  } finally { await s.f.cleanup(); }
});

it('opened已落而审计失败：作废冻结并清owned，预给不动', async () => {
  const s = await setup();
  try {
    s.injectAudit(row => row.动作 === '会审发起');
    let failure;
    await assert.rejects(() => s.action(s.openArgs), e => (failure = e, e.code === 'COUNCIL_OPEN_FAILED'));
    assert.match(failure.message, /opened 事件已落线，但发起审计失败/);
    assert.doesNotMatch(failure.message, /opened 事件落线失败/);
    assert.equal(failure.detail.opened已落线, true);
    const [view] = await s.org.council.list({ 项目: P });
    assert.equal(view.状态, '作废');
    await assert.rejects(() => s.org.council.answer({ subject: { id: 'member-a', kind: '成员' }, 项目: P, id: view.id, 结论: '禁止早卷' }));
    assert.equal((await s.org.registry.identity()).members['member-a'].status, '在岗');
    assert.equal((await s.org.registry.identity()).members['owned-1'].status, '封存');
  } finally { await s.f.cleanup(); }
});

for (const stage of ['会审收敛', '零分歧异常', '介入失败']) it(`converged后${stage}审计失败：逐个退役，合并失败，不重复结论`, async () => {
  const s = await setup();
  try {
    const { 会审: opened } = await s.action(s.openArgs);
    for (const id of opened.参与者) await s.org.council.answer({ subject: { id, kind: '成员' }, 项目: P, id: opened.id, 结论: '相同', 结论层: '方案A' });
    await s.org.council.unlock({ subject: LEAD, 项目: P, id: opened.id });
    await s.mode('审批');
    const args = { action: 'debate_converge', id: opened.id, 内容: '唯一结论' };
    const request = await s.approve(args);
    s.injectAudit(row => row.动作 === stage || (stage === '介入失败' && row.动作 === '会审收敛') || row.动作 === '会审退役' || row.动作 === '会审退役失败');
    s.subagents.interrupt = async function (id) { s.calls.stop.push(id); if (id === 'owned-1') throw new Error('first stop injected'); };
    let failure;
    await assert.rejects(() => s.action({ ...args, 审批引用: request }), e => (failure = e, /injected audit/.test(e.message)));
    assert.deepEqual(s.calls.stop, ['owned-1', 'owned-2']);
    assert.equal((await s.org.registry.identity()).members['owned-1'].status, '封存');
    assert.equal((await s.org.registry.identity()).members['owned-2'].status, '封存');
    assert.match(JSON.stringify(failure.detail), /first stop injected/);
    assert.match(JSON.stringify(failure.detail), /会审退役失败/);
    if (stage === '介入失败') assert.match(failure.detail.介入失败记账错误, /injected audit: 介入失败/);
    const rows = await readJsonl(s.org.layout.councilLog(P));
    assert.equal(rows.filter(x => x.kind === 'converged').length, 1);
    await assert.rejects(() => s.action(args));
    assert.deepEqual(s.calls.stop, ['owned-1', 'owned-2']);
  } finally { await s.f.cleanup(); }
});

it('member_list同id登记与子代合并，team去重，未知状态不编造', async () => {
  const s = await setup();
  try {
    await s.action(s.openArgs);
    const { 成员 } = await s.action({ action: 'member_list' });
    const row = 成员.find(x => x.实例 === 'owned-1');
    assert.equal(row.岗位, '插件工程'); assert.equal(row.来源, 'subagent'); assert.equal(row.名, 'real child'); assert.equal(row.状态, null);
    assert.equal(成员.find(x => x.实例 === 'unregistered').状态, null);
    assert.equal(成员.filter(x => x.实例 === 'owned-1').length, 1);
    const host = { agent: { session: { id: 'lead' } }, subagents: s.subagents, agentTeams: { listMembers: () => [{ role: 'teammate', id: 'owned-1', name: 'team-name', status: 'idle' }] }, delegation: { authorize: () => ({ fingerprint: 'test' }) } };
    const team = await runAction({ org: s.org, 项目: P, 主体: LEAD, 面: 'tool', 宿主: host, args: { action: 'member_list' } });
    assert.equal(team.成员.find(x => x.实例 === 'owned-1').来源, 'team');
    assert.equal(team.成员.find(x => x.实例 === 'owned-1').名, 'team-name');
    assert.equal(team.成员.find(x => x.实例 === 'owned-1').状态, 'idle');
    assert.equal(team.成员.filter(x => x.实例 === 'owned-1').length, 1);
  } finally { await s.f.cleanup(); }
});

it('审批成功不执行失败补偿，预给/别场/未登记/伪owned都拿不到seal', async () => {
  const s = await setup();
  try {
    await s.org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'other-council', 会审: { id: 'other', 项目: P, 资料: [] } });
    await s.mode('审批');
    const args = { ...s.openArgs, owned: ['member-a', 'other-council'] };
    const request = await s.approve(args);
    const append = s.org.audit.append.bind(s.org.audit);
    let checked = 0;
    s.org.audit.append = async (row) => {
      if (row.动作 === '成员创建') {
        for (const id of ['member-a', 'member-b', 'other-council', 'not-created']) {
          await assert.rejects(() => s.org.registry.seal({ subject: LEAD, 实例: id, 理由: '伪造owned不能放行' }), e => e instanceof NeedsApproval);
          checked++;
        }
      }
      return append(row);
    };
    await s.action({ ...args, 审批引用: request });
    assert.equal(checked, 8, '负例在实际批准请求上下文中执行');
    const members = (await s.org.registry.identity()).members;
    for (const id of ['member-a', 'member-b', 'other-council', 'owned-1', 'owned-2']) assert.equal(members[id].status, '在岗');
    assert.deepEqual(s.calls.stop, []);
    assert.deepEqual(s.calls.drain, []);
  } finally { await s.f.cleanup(); }
});

it('宿主冒返已有身份时，不改绑、不seal、不停预给与别场', async () => {
  for (const id of ['member-a', 'other-council']) {
    const s = await setup();
    try {
      await s.org.registry.assign({ subject: LEAD, 岗位: '插件工程', 实例: 'other-council', 会审: { id: 'other', 项目: P, 资料: [] } });
      const before = (await s.org.registry.identity()).members[id];
      s.subagents.startActivation = async () => ({ childId: id });
      await s.mode('审批');
      const request = await s.approve(s.openArgs);
      await assert.rejects(() => s.action({ ...s.openArgs, 审批引用: request }), e => e.code === 'COUNCIL_CREATE_FAILED');
      assert.deepEqual((await s.org.registry.identity()).members[id], before);
      assert.deepEqual(s.calls.stop, []); assert.deepEqual(s.calls.drain, []);
    } finally { await s.f.cleanup(); }
  }
});

for (const mode of ['subagent', 'team']) it(`创建后${mode}停机API消失：补偿如实失败而非可选调用假绿`, async () => {
  const s = await setup();
  try {
    s.org.registry.assign = async () => { throw new Error('registration before write injected'); };
    let run = s.action;
    let stopCalls = 0;
    if (mode === 'subagent') {
      const start = s.subagents.startActivation;
      s.subagents.startActivation = async function (...args) {
        const result = await start.apply(this, args);
        delete this.drainChildren;
        return result;
      };
    } else {
      const teams = {
        async spawnTeammate() { assert.equal(this, teams); s.calls.spawn++; delete this.interrupt; return { member: { id: 'owned-team', name: 'temporary' } }; },
        async sendMessage() {},
        async interrupt() { stopCalls++; },
        listMembers() { return [{ role: 'teammate', id: 'owned-team', name: 'temporary' }]; },
      };
      const host = { agent: { session: { id: 'lead' } }, agentTeams: teams, delegation: { authorize: () => ({ fingerprint: 'test' }) } };
      run = args => runAction({ org: s.org, 项目: P, 主体: LEAD, 面: 'tool', 宿主: host, args });
    }
    let failure;
    await assert.rejects(() => run({ ...s.openArgs, 方式: mode }), e => (failure = e, e.code === 'COUNCIL_CREATE_FAILED'));
    assert.equal(s.calls.spawn, 1, '通过副作用前校验，真实创建后才注入缺接口');
    assert.notEqual(failure.detail.错误详情.补偿失败, null, '缺接口必须有补偿失败证据');
    assert.match(failure.detail.错误详情.补偿失败, /停机接口.*已不可用.*未停机/);
    assert.match(failure.detail.错误详情.原因, /registration before write injected/);
    assert.deepEqual(s.calls.drain, []); assert.deepEqual(s.calls.stop, []); assert.equal(stopCalls, 0);
    assert.equal((await s.org.registry.identity()).members['member-a'].status, '在岗');
  } finally { await s.f.cleanup(); }
});

it('opened未能提交时如实报未落线，不声称已落或已作废', async () => {
  const s = await setup();
  const councilLog = s.org.layout.councilLog;
  try {
    s.org.layout.councilLog = () => s.f.home;
    let failure;
    await assert.rejects(() => s.action(s.openArgs), e => (failure = e, e.code === 'COUNCIL_OPEN_FAILED'));
    assert.equal(failure.detail.opened已落线, false);
    assert.match(failure.message, /opened 事件未能落线/);
    assert.doesNotMatch(failure.message, /已尝试冻结作废/);
    assert.deepEqual(s.calls.stop.sort(), ['owned-1', 'owned-2']);
  } finally { s.org.layout.councilLog = councilLog; await s.f.cleanup(); }
});

it('开场发送阻塞后另一Root先收敛：失败作废不得覆盖已定格状态', async () => {
  const s = await setup();
  let release;
  let entered;
  const gate = new Promise(resolve => { release = resolve; });
  const ready = new Promise(resolve => { entered = resolve; });
  let opening;
  try {
    s.subagents.sendMessage = async () => { entered(); await gate; throw new Error('delayed send injected'); };
    opening = s.action(s.openArgs).then(value => ({ value }), error => ({ error }));
    await ready;
    const [opened] = await s.org.council.list({ 项目: P });
    for (const id of opened.参与者) await s.org.council.answer({ subject: { id, kind: '成员' }, 项目: P, id: opened.id, 结论: id });
    await s.org.council.unlock({ subject: LEAD, 项目: P, id: opened.id });
    await s.action({ action: 'debate_converge', id: opened.id, 内容: '另一Root已定格的唯一结论' });
    release();
    const { error } = await opening;
    assert.equal(error.code, 'COUNCIL_SEND_FAILED');
    const final = await s.org.council.get(P, opened.id);
    assert.equal(final.状态, '已收敛');
    assert.equal(final.结论, '另一Root已定格的唯一结论');
    assert.match(error.detail.作废错误, /已收敛/);
    assert.deepEqual(s.calls.stop.sort(), ['owned-1', 'owned-1', 'owned-2', 'owned-2'], '作废被拒后仍逐个尝试owned清理');
    assert.equal((await s.org.registry.identity()).members['member-a'].status, '在岗');
    const rows = await readJsonl(s.org.layout.councilLog(P));
    assert.equal(rows.filter(x => x.kind === 'converged').length, 1);
    assert.equal(rows.filter(x => x.kind === 'aborted').length, 0);
  } finally { release(); if (opening) await opening; await s.f.cleanup(); }
});

it('新id落盘绑定错场时，不凭匹配过create给它seal', async () => {
  const s = await setup();
  try {
    await s.mode('审批');
    const request = await s.approve(s.openArgs);
    const assign = s.org.registry.assign.bind(s.org.registry);
    s.org.registry.assign = spec => assign({ ...spec, 会审: { ...spec.会审, id: 'wrong-council' } });
    await assert.rejects(() => s.action({ ...s.openArgs, 审批引用: request }), e => e.code === 'COUNCIL_CREATE_FAILED');
    const member = (await s.org.registry.identity()).members['owned-1'];
    assert.equal(member.status, '在岗');
    assert.equal(member.会审绑定.会审, 'wrong-council');
    assert.deepEqual(s.calls.drain, ['owned-1'], '停止刚spawn的执行体但不得封错场身份');
  } finally { await s.f.cleanup(); }
});

it('只有预给的opened审计失败也作废；aborted审计失败不阻断冻结', async () => {
  const s = await setup();
  try {
    s.injectAudit(row => ['会审发起', '会审作废'].includes(row.动作));
    let failure;
    await assert.rejects(() => s.action({ action: 'debate_open', 问题: '预给', 参与者: 'member-a,member-b' }), e => (failure = e, e.code === 'COUNCIL_OPEN_FAILED'));
    assert.match(failure.detail.作废错误, /会审作废/);
    const [view] = await s.org.council.list({ 项目: P });
    assert.equal(view.状态, '作废');
    for (const id of ['member-a', 'member-b']) assert.equal((await s.org.registry.identity()).members[id].status, '在岗');
  } finally { await s.f.cleanup(); }
});

it('补偿引用创建步：错序/未确认首登/未匹配create/异主体/跨请求均拒；重复判定幂等且不能多封', async () => {
  const target = id => ({ kind: '身份', id, authority: '自治', zone: '私有' });
  const plan = [
    { 动作: 'create', 目标: { kind: '身份', 新: true } },
    { 动作: 'seal', 目标: { kind: '身份' }, 补偿自: 1 },
    { 动作: 'seal', 目标: { kind: '身份' }, 补偿自: 99 },
  ];
  await 以放行上下文({ 原主体: LEAD.id, 请求id: 'one', 步骤: plan }, async () => {
    assert.equal(本次放行匹配(LEAD, 'seal', target('owned')), null);
    assert.equal(记录本次新建(LEAD, target('owned')), false);
    assert.ok(本次放行匹配(LEAD, 'create', target('owned')));
    assert.equal(本次放行匹配(LEAD, 'seal', target('owned')), null, '只预检过create不等于真实首登');
    assert.equal(记录本次新建({ id: 'impostor' }, target('owned')), false);
    assert.equal(记录本次新建(LEAD, target('owned')), true);
    assert.equal(本次放行可匹配(LEAD, 'seal', target('owned')), true);
    const first = 本次放行匹配(LEAD, 'seal', target('owned'));
    assert.equal(first.序, 2);
    assert.equal(本次放行匹配(LEAD, 'seal', target('owned')).重复, true);
    assert.equal(当前放行().已用.get(2), 1);
    assert.equal(本次放行匹配(LEAD, 'seal', target('extra')), null);
    assert.equal(记录本次新建(LEAD, target('extra')), false);
    assert.equal(本次放行匹配({ id: 'impostor' }, 'seal', target('owned')), null);
    await 以放行上下文({ 原主体: LEAD.id, 请求id: 'two', 步骤: plan }, () => {
      assert.equal(本次放行匹配(LEAD, 'seal', target('owned')), null, '新请求不继承owned');
    });
  });
  await 以放行上下文({ 原主体: LEAD.id, 请求id: 'wrong-step', 步骤: [plan[0], plan[2]] }, () => {
    assert.ok(本次放行匹配(LEAD, 'create', target('owned')));
    assert.equal(记录本次新建(LEAD, target('owned')), true);
    assert.equal(本次放行匹配(LEAD, 'seal', target('owned')), null, '错创建步序不能封');
  });
  assert.equal(本次放行匹配(LEAD, 'seal', target('owned')), null, '执行结束无全局豁免');
});
