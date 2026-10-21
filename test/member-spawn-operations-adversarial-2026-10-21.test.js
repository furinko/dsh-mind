/** 独立创建中断反例：真实 Org/动作/日志，宿主只用隔离 fake，不启动实际 Agent。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { readFile, writeFile, rmdir } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { SpawnOperationService } from '../src/spawn-operations.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { digest } from '../src/kernel/text.js';
import { Denied, Fault, describeFailure } from '../src/kernel/errors.js';
import { runAction } from '../lib/actions.js';

const P = 'spawn-operations-independent-adversarial';
const Q = `${P}-other`;
const HASH = digest('server-normalized-spawn-input');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SECRET = 'SPAWN_PRIVATE_TASK_CONTENT_MUST_NOT_ENTER_OPERATIONS';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

async function caught(fn) { try { await fn(); } catch (error) { return error; } assert.fail('应拒绝且保留可核对的创建回执'); }

async function scene(body) {
  const f = await makeFixture();
  try {
    const open = () => Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
    const org = await open();
    const calls = { spawn: [], message: [], release: [] };
    const host = {
      agent: { id: LEAD.id, session: { id: LEAD.id } },
      delegation: { authorize: () => ({ fingerprint: 'independent-operations-authorization' }) },
      subagents: {
        startContinuable: async spec => { calls.spawn.push(spec); return { childId: spec.childId, messageId: `initial-inbox-${calls.spawn.length}` }; },
        sendMessage: async (_parent, id, content) => { calls.message.push({ id, content }); return { messageId: `work-inbox-${calls.message.length}` }; },
        drainContinuableChildren: async (_parent, ids) => { calls.release.push(ids); },
      },
      agentTeams: {
        spawnTeammate: async (_parent, spec) => { calls.spawn.push(spec); return { member: { id: `team-child-${calls.spawn.length}`, name: spec.name } }; },
        sendMessage: async (_parent, spec) => { calls.message.push(spec); return { messageId: `team-work-${calls.message.length}` }; },
        interrupt: async (_parent, name) => { calls.release.push(name); },
      },
    };
    const create = () => org.tasks.create({ subject: LEAD, 项目: P, 描述: '独立持久创建验收', 负责人: '插件工程', 判据: ['真实回执可核对'] });
    const act = (args, currentOrg = org, subject = LEAD) => runAction({ org: currentOrg, 项目: P, subject, 主体: subject, 面: 'tool', 宿主: host, args });
    const query = (extra = {}, currentOrg = org) => currentOrg.spawnOperations.query({ subject: LEAD, 项目: P, ...extra });
    const begin = (node, extra = {}) => org.spawnOperations.begin({ subject: LEAD, 项目: P, 任务: node.id, 方式: 'subagent', 请求摘要: HASH, ...extra });
    const log = () => readTextOrNull(f.layout.spawnOperationLog(P));
    await body({ f, org, open, host, calls, create, act, query, begin, log });
  } finally { await f.cleanup(); }
}

const request = (node, extra = {}) => ({ action: 'member_spawn', 方式: 'subagent', 岗位: '插件工程', 节点: node.id, 任务书: SECRET, ...extra });
const operationIdOf = error => describeFailure(error).已确认阶段?.find(row => row.操作id)?.操作id;
const operationOf = async (query, node) => (await query({ 任务: node.id })).操作页.条目[0];

describe('独立创建操作：严格意图与治理读', { timeout: 60_000 }, () => {
  it('同任务的多服务并发只签发一次新许可，认回旧意图没有第二张可创建回执', async () => scene(async ({ org, f, create, begin, query, log }) => {
    const node = await create();
    const other = new SpawnOperationService({ layout: f.layout, clock: org.clock, policy: org.policy, registry: org.registry });
    const [a, b] = await Promise.all([begin(node), other.begin({ subject: LEAD, 项目: P, 任务: node.id, 方式: 'subagent', 请求摘要: HASH })]);
    assert.equal([a, b].filter(row => row.可创建 === true).length, 1);
    assert.equal(a.操作id, b.操作id); assert.equal(a.拟用实例, b.拟用实例); assert.match(a.拟用实例, UUID);
    const before = await log(); const repeat = await begin(node);
    assert.equal(repeat.可创建, false); assert.equal(repeat.幂等, true); assert.equal(await log(), before);
    const view = await query(); assert.equal(view.操作页.总数, 1); assert.equal(view.汇总.仅有意图, 1);
    assert.equal(view.完整, false); assert.equal(view.操作页.条目[0].状态, 'intent');
  }));

  it('改参数、方式、真实Lead均不能覆写或洗掉原任务意图；另一项目保持独立', async () => scene(async ({ org, create, begin, query }) => {
    const node = await create(); const first = await begin(node);
    for (const extra of [{ 请求摘要: digest('different-server-input') }, { 方式: 'team' }]) {
      await assert.rejects(() => begin(node, extra), error => error instanceof Denied && error.detail.操作id === first.操作id);
    }
    await org.registry.assign({ subject: SOVEREIGN, 实例: 'replacement-lead', 岗位: 'Lead' });
    const replacement = { id: 'replacement-lead', kind: 'Lead' };
    await assert.rejects(() => begin(node, { subject: replacement }), error => error instanceof Denied && error.detail.操作id === first.操作id);
    const independent = await begin(node, { 项目: Q });
    assert.equal(independent.可创建, true); assert.notEqual(independent.操作id, first.操作id);
    assert.notEqual(independent.拟用实例, first.拟用实例); assert.equal((await query()).操作页.总数, 1);
    assert.equal((await query({ 项目: Q })).操作页.总数, 1);
  }));

  it('阶段严格归属且只保存标识，重复认回零新行，完成不代表任务执行完成', async () => scene(async ({ org, create, begin, query, log }) => {
    const node = await create(); const first = await begin(node);
    const record = (阶段, 回执) => org.spawnOperations.record({ 项目: P, 操作id: first.操作id, 阶段, 回执 });
    await assert.rejects(() => record('host_returned', { 实例: 'wrong-child', 初始消息id: 'initial', 团队名: null }), Denied);
    await assert.rejects(() => record('registered', { 实例: first.拟用实例 }), Denied);
    const stages = [
      ['host_returned', { 实例: first.拟用实例, 初始消息id: 'initial', 团队名: null }],
      ['registered', { 实例: first.拟用实例 }],
      ['bound', { 实例: first.拟用实例, 任务: node.id }], ['dispatched', { 任务: node.id }],
      ['message_received', { 实例: first.拟用实例, 任务: node.id, 消息id: 'work' }],
      ['audited', { 实例: first.拟用实例, 任务: node.id }],
    ];
    for (const [stage, receipt] of stages) await record(stage, receipt);
    const before = await log(); const repeated = await record(...stages.at(-1));
    assert.equal(repeated.幂等, true); assert.equal(await log(), before);
    await assert.rejects(() => record('message_received', { 实例: first.拟用实例, 任务: node.id, 消息id: 'different' }), Denied);
    await assert.rejects(() => record('audited', { 实例: first.拟用实例, 任务: node.id, 内容: SECRET }));
    const view = await query(); assert.equal(view.汇总.已审计, 1); assert.equal(view.汇总.未收尾, 0);
    assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '待派发', '记录观察不能推进真实任务');
    assert.ok(!before.includes(SECRET));
  }));

  it('id、任务、分页和自报Lead均不能扩大成员读域，查询没有业务副作用', async () => scene(async ({ org, f, create, begin, query, log }) => {
    const node = await create(); const first = await begin(node);
    const files = [f.layout.taskLog(P), f.layout.identityFile(), f.layout.goalLog(P), f.layout.goalBudgetLog(P), f.layout.spawnOperationLog(P)];
    const snapshot = () => Promise.all(files.map(file => readTextOrNull(file)));
    const before = await snapshot();
    for (const subject of [MEMBER, { id: MEMBER.id, kind: 'Lead' }, { id: 'unregistered', kind: 'Lead' }]) {
      for (const filter of [{}, { id: first.操作id }, { 任务: node.id }, { 条数: 1, 偏移: 50 }]) await assert.rejects(() => query({ subject, ...filter }), Denied);
    }
    const view = await query({ id: first.操作id, 条数: 1 }); assert.equal(view.操作页.总数, 1);
    assert.deepEqual(await snapshot(), before); assert.ok(await log());
    await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '验证当前读资格' });
    await assert.rejects(() => query({ id: first.操作id }), Denied);
    assert.equal(await org.spawnOperations.summaryFor({ subject: LEAD, 项目: P }), null);
  }));

  it('坏账、撕裂和跨项目原文不降为空；所有旧意图仍保持不可重新准入', async () => scene(async ({ f, org, create, begin, query, log }) => {
    const node = await create(); await begin(node); const raw = await log(); const file = f.layout.spawnOperationLog(P);
    const row = JSON.parse(raw.trim());
    const cases = [raw.slice(0, -1), `${raw}{broken\n`, `${raw}\n`, `${JSON.stringify({ ...row, 项目: Q })}\n`, `${JSON.stringify({ ...row, kind: 'constructor' })}\n`];
    for (const broken of cases) {
      await writeFile(file, broken, 'utf8');
      await assert.rejects(() => begin(node), error => error instanceof Fault && error.code === 'SPAWN_OPERATION_LEDGER_INVALID');
      await assert.rejects(() => query(), error => error.code === 'SPAWN_OPERATION_LEDGER_INVALID');
      const summary = org.spawnOperations.summary(P); assert.equal(summary.健康, '不可用'); assert.equal(summary.汇总.操作, null);
    }
    await writeFile(file, raw, 'utf8'); assert.equal((await begin(node)).可创建, false);
  }));

  it('实际文件追加失败给出本次操作锚点和未知提交态，不签发创建许可', async () => scene(async ({ org, f, create }) => {
    const node = await create(); const file = f.layout.spawnOperationLog(P);
    const clock = { iso: () => { mkdirSync(file); return '2026-10-21T12:00:00.000Z'; } };
    const service = new SpawnOperationService({ layout: f.layout, clock, policy: org.policy, registry: org.registry });
    const error = await caught(() => service.begin({ subject: LEAD, 项目: P, 任务: node.id, 方式: 'subagent', 请求摘要: HASH }));
    assert.equal(error.code, 'SPAWN_OPERATION_APPEND_FAILED'); assert.match(error.detail.操作id, UUID);
    assert.equal(error.outcome.可重试, false); assert.equal(error.outcome.提交状态, '未知');
    await rmdir(file);
  }));
});

describe('独立创建操作：真实动作阶段与中断', { timeout: 60_000 }, () => {
  it('host调用前已有意图和同一候选UUID；正常六阶段只留标识，成功重复只读诊断不重放', async () => scene(async ({ org, host, calls, create, act, query, log }) => {
    const node = await create();
    const start = host.subagents.startContinuable;
    host.subagents.startContinuable = async spec => {
      const existing = org.spawnOperations.findByTask(P, node.id);
      assert.ok(existing, '第一笔宿主调用前必须已经落意图');
      assert.equal(existing.状态, 'intent'); assert.equal(existing.拟用实例, spec.childId); assert.match(spec.childId, UUID);
      return start(spec);
    };
    const result = await act(request(node));
    assert.equal(result.实例, calls.spawn[0].childId); assert.equal(result.操作.拟用实例, result.实例);
    assert.equal(result.操作.记账, '已收尾'); assert.equal(result.操作.成员执行, null); assert.equal(result.执行完成, null);
    const view = await operationOf(query, node);
    assert.equal(view.操作id, result.操作.操作id); assert.equal(view.状态, 'audited');
    assert.deepEqual(view.阶段.map(row => row.阶段), ['intent', 'host_returned', 'registered', 'bound', 'dispatched', 'message_received', 'audited']);
    assert.ok(!JSON.stringify(view).includes(SECRET)); assert.ok(!(await log()).includes(SECRET));
    const before = await log(); const error = await caught(() => act(request(node, { 任务书: '不同参数也不能重建' })));
    assert.equal(error.code, 'MEMBER_SPAWN_OPERATION_EXISTS'); assert.equal(operationIdOf(error), result.操作.操作id);
    assert.equal(calls.spawn.length, 1); assert.equal(calls.message.length, 1); assert.equal(calls.release.length, 0); assert.equal(await log(), before);
  }));

  it('两个动作都准备完再同时begin，仍只有一个宿主和一个开工消息', async () => scene(async ({ org, calls, create, act, query }) => {
    const node = await create(); const entered = deferred(); let count = 0;
    const begin = org.spawnOperations.begin.bind(org.spawnOperations);
    org.spawnOperations.begin = async spec => { if (++count === 2) entered.resolve(); await entered.promise; return begin(spec); };
    const results = await Promise.allSettled([act(request(node)), act(request(node))]);
    assert.equal(count, 2, '反例必须让两个合法计划都走到意图竞争');
    assert.equal(results.filter(row => row.status === 'fulfilled').length, 1);
    const rejected = results.find(row => row.status === 'rejected').reason;
    assert.equal(rejected.code, 'MEMBER_SPAWN_OPERATION_EXISTS'); assert.match(operationIdOf(rejected), UUID);
    assert.equal(calls.spawn.length, 1); assert.equal(calls.message.length, 1); assert.equal((await query()).操作页.总数, 1);
  }));

  it('宿主已收到调用后回执丢失，Org重建和换真实Lead均只能查询原intent', async () => scene(async ({ org, open, host, calls, create, act, query }) => {
    const node = await create();
    host.subagents.startContinuable = async spec => { calls.spawn.push(spec); throw new Error(SECRET); };
    const original = await caught(() => act(request(node))); const id = operationIdOf(original);
    assert.equal(original.code, 'MEMBER_SPAWN_RESULT_UNKNOWN'); assert.match(id, UUID);
    assert.equal(original.outcome.可重试, false); assert.equal(calls.spawn.length, 1);
    const reopened = await open(); const second = await caught(() => act(request(node), reopened));
    assert.equal(second.code, 'MEMBER_SPAWN_OPERATION_EXISTS'); assert.equal(operationIdOf(second), id);
    await org.registry.assign({ subject: SOVEREIGN, 实例: 'new-lead-for-recovery', 岗位: 'Lead' });
    const replacement = { id: 'new-lead-for-recovery', kind: 'Lead' }; host.agent = { id: replacement.id, session: { id: replacement.id } };
    const third = await caught(() => act(request(node), reopened, replacement));
    assert.equal(third.code, 'MEMBER_SPAWN_OPERATION_EXISTS'); assert.equal(operationIdOf(third), id);
    const view = (await query({ subject: replacement, id }, reopened)).操作页.条目[0];
    assert.equal(view.状态, 'intent'); assert.equal(view.拟用实例, calls.spawn[0].childId);
    assert.equal(view.阶段.some(row => row.阶段 === 'host_returned'), false, '夹具知道宿主收过调用，不代表服务取得创建回执');
    assert.equal(calls.spawn.length, 1); assert.equal(calls.message.length, 0); assert.equal(calls.release.length, 0);
    assert.ok(!JSON.stringify(view).includes(SECRET));
  }));

  it('阶段日志失败不触发补偿或吞掉合法业务；成功回执明确需核对，原intent继续挡重建', async () => scene(async ({ org, calls, create, act, query }) => {
    const node = await create(); const record = org.spawnOperations.record.bind(org.spawnOperations);
    org.spawnOperations.record = async spec => { if (spec.阶段 === 'registered') throw new Error(SECRET); return record(spec); };
    org.logger = { warn: () => { throw new Error('logger-failed'); } };
    const result = await act(request(node));
    assert.equal(result.已登记, true); assert.equal(result.已派发, true); assert.equal(result.已接收, true); assert.equal(result.操作.记账, '需核对');
    const view = await operationOf(query, node); assert.equal(view.状态, 'host_returned');
    assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '已派发');
    const repeat = await caught(() => act(request(node))); assert.equal(repeat.code, 'MEMBER_SPAWN_OPERATION_EXISTS');
    assert.equal(calls.spawn.length, 1); assert.equal(calls.message.length, 1); assert.equal(calls.release.length, 0);
  }));

  it('dispatch事件已提交但审计失败：原Fault、事件序号和操作问题保留，不能说仍待派发', async () => scene(async ({ f, org, calls, create, act, query }) => {
    const node = await create(); const append = org.audit.append.bind(org.audit);
    org.audit.append = async row => { if (row.对象?.id === node.id && row.结果 === 'dispatched') throw new Error(SECRET); return append(row); };
    const error = await caught(() => act(request(node))); const id = operationIdOf(error);
    assert.equal(error.code, 'MEMBER_SPAWN_DISPATCH_FAILED'); assert.match(id, UUID);
    const rows = (await readFile(f.layout.taskLog(P), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
    const event = rows.find(row => row.id === node.id && row.kind === 'dispatched'); assert.ok(event);
    const report = describeFailure(error);
    assert.ok(report.已确认阶段.some(row => row.事件 === 'dispatched' && row.事件序号 === event.seq && row.任务 === node.id));
    const view = (await query({ id })).操作页.条目[0];
    assert.equal(view.状态, 'bound', '没有正常dispatch返回就不伪补标准阶段');
    assert.ok(view.问题.some(issue => issue.故障码 === error.code && issue.已确认阶段.some(row => row.事件 === 'dispatched' && row.事件序号 === event.seq)));
    assert.ok(!JSON.stringify(view).includes(SECRET)); assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '已派发');
    assert.equal(calls.spawn.length, 1); assert.equal(calls.message.length, 0); assert.equal(calls.release.length, 0);
  }));

  for (const mismatch of [false, true]) {
    it(`宿主${mismatch ? '返回另一id' : '缺少初始inbox凭据'}：保留候选和事实，零登记、零bind、零释放不明对象`, async () => scene(async ({ org, host, calls, create, act, query }) => {
      const node = await create(); const returned = 'unexpected-existing-child';
      host.subagents.startContinuable = async spec => { calls.spawn.push(spec); return { childId: mismatch ? returned : spec.childId, ...(mismatch ? { messageId: 'initial-returned' } : {}) }; };
      const error = await caught(() => act(request(node))); const id = operationIdOf(error); assert.match(id, UUID);
      assert.equal(error.code, mismatch ? 'MEMBER_SPAWN_RESERVED_ID_MISMATCH' : 'MEMBER_SPAWN_RECEIPT_UNKNOWN');
      const view = (await query({ id })).操作页.条目[0]; assert.equal(view.状态, 'intent');
      assert.equal(view.阶段.length, 1); assert.equal(view.拟用实例, calls.spawn[0].childId);
      assert.ok(view.问题.some(issue => issue.故障码 === error.code));
      const publicRows = describeFailure(error).已确认阶段;
      if (mismatch) assert.ok(publicRows.some(row => row.拟用实例 === view.拟用实例 && row.返回实例 === returned));
      else assert.ok(publicRows.some(row => row.实例 === view.拟用实例));
      const identity = await org.registry.identity(); assert.equal(identity.members[view.拟用实例], undefined); assert.equal(identity.members[returned], undefined);
      const current = await org.tasks.get(node.id, { 项目: P }); assert.equal(current.状态, '待派发'); assert.equal(current.绑定?.length ?? 0, 0);
      assert.equal(calls.spawn.length, 1); assert.equal(calls.message.length, 0); assert.equal(calls.release.length, 0);
    }));
  }

  it('begin实际追加失败经动作公开保留操作锚点，0host且不登记或派发', async () => scene(async ({ org, f, calls, create, act }) => {
    const node = await create(); const file = f.layout.spawnOperationLog(P);
    org.spawnOperations = new SpawnOperationService({ layout: f.layout, policy: org.policy, registry: org.registry,
      clock: { iso: () => { mkdirSync(file); return '2026-10-21T12:00:00.000Z'; } } });
    const error = await caught(() => act(request(node))); const report = describeFailure(error);
    assert.equal(error.code, 'SPAWN_OPERATION_APPEND_FAILED'); assert.match(operationIdOf(error), UUID);
    assert.equal(report.提交状态, '未知'); assert.equal(report.可重试, false);
    assert.ok(report.已确认阶段.some(row => row.阶段 !== '成员创建意图已记录' && row.操作id), '追加失败只能公开拟用操作锚点，不能伪称意图已提交');
    assert.equal(calls.spawn.length, 0); assert.equal(calls.message.length, 0); assert.equal(calls.release.length, 0);
    assert.equal((await org.tasks.get(node.id, { 项目: P })).状态, '待派发'); await rmdir(file);
  }));

  it('额度预检确定拒绝时不先落永久intent；受管宿主未知错误的问题仍保留预算之外的创建回执', async () => scene(async ({ org, calls, host, create, act, query, log }) => {
    const node = await create(); const goal = await org.goals.create({ subject: LEAD, 项目: P, 期望结果: '预算下安全创建', 完成依据: ['可核对'], 来源: '明确意图转述未认证', 下一步: '登记创建' });
    await org.goals.linkTask(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 任务: node.id });
    await org.budgets.configure(goal.id, { subject: SOVEREIGN, 项目: P, 预算修订: 0, 上限: 0 });
    await assert.rejects(() => act(request(node)), Denied); assert.equal(await log(), null); assert.equal(calls.spawn.length, 0);
    await org.budgets.configure(goal.id, { subject: SOVEREIGN, 项目: P, 预算修订: 1, 上限: 1 });
    host.subagents.startContinuable = async spec => { calls.spawn.push(spec); throw new Error(SECRET); };
    const error = await caught(() => act(request(node))); const id = operationIdOf(error); assert.match(id, UUID);
    assert.ok(describeFailure(error).已确认阶段.some(row => row.预算目标 === goal.id && row.执行键));
    const view = (await query({ id })).操作页.条目[0]; assert.ok(view.问题.some(issue => issue.故障码 === error.code));
    assert.equal(calls.spawn.length, 1); assert.equal(calls.message.length, 0);
    const budget = await org.budgets.query(goal.id, { subject: LEAD, 项目: P }); assert.equal(budget.累计准入, 1); assert.equal(budget.未决占用, 1);
  }));

  it('正式终止并建后继能另起隔离任务，旧intent及宿主未知状态都不会被清除或借旧id重建', async () => scene(async ({ org, host, calls, create, act, query }) => {
    const node = await create(); const start = host.subagents.startContinuable;
    host.subagents.startContinuable = async spec => { calls.spawn.push(spec); throw new Error('transport-lost'); };
    const first = await caught(() => act(request(node))); const firstId = operationIdOf(first);
    const closed = await org.tasks.close(node.id, { subject: LEAD, 项目: P, 原因: '原创建结果未知，停止原任务组织授权' });
    assert.equal(closed.宿主停止状态, '未确认');
    const next = await org.tasks.createSuccessor(node.id, { subject: LEAD, 项目: P, 负责人: '插件工程', 原因: '显式另建后继，输出范围重新授予' });
    host.subagents.startContinuable = start;
    const result = await act(request(next.节点)); assert.notEqual(result.操作.操作id, firstId); assert.notEqual(result.实例, calls.spawn[0].childId);
    const old = await caught(() => act(request(node))); assert.equal(old.code, 'MEMBER_SPAWN_OPERATION_EXISTS'); assert.equal(operationIdOf(old), firstId);
    const view = await query(); assert.equal(view.操作页.总数, 2); assert.equal(view.汇总.仅有意图, 1);
    assert.equal(calls.spawn.length, 2); assert.equal(calls.message.length, 1); assert.equal(calls.release.length, 0);
  }));
});
