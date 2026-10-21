/** 操作入口只读；HOST阶段由隔离夹具调用内部record注入，不给模型补签接口。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, REVIEWER, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { Org } from '../src/org.js';
import { shareOrg } from '../src/runtime.js';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { runAction, ACTIONS, COMMAND_ACTIONS, READ_ONLY_ACTIONS } from '../lib/actions.js';
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'spawn-operations-entry';
const Q = 'spawn-operations-other';
const invalid = error => error instanceof Denied || error instanceof InvalidBody;
const digest = value => createHash('sha256').update(value).digest('hex');
const taskSpec = (description, 项目 = P) => ({ subject: LEAD, 项目, 描述: description, 负责人: '插件工程', 判据: ['返回可验收产物'] });
const configFor = f => ({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });

async function scene(run) {
  const f = await makeFixture();
  try {
    const org = await Org.open(configFor(f));
    const act = (args, subject = LEAD, 面 = 'tool') => runAction({ org, 项目: P, 主体: subject, subject, 面, args });
    const query = async (args = {}, subject = LEAD) => (await act({ action: 'operation_query', ...args }, subject)).操作;
    const log = (project = P) => readTextOrNull(f.layout.spawnOperationLog(project));
    await run({ f, org, act, query, log });
  } finally { await f.cleanup(); }
}

async function begin(org, name, { project = P, mode = 'subagent' } = {}) {
  const task = await org.tasks.create(taskSpec(name, project));
  const spec = { 项目: project, subject: LEAD, 任务: task.id, 方式: mode, 请求摘要: digest(name) };
  return { task, spec, operation: await org.spawnOperations.begin(spec) };
}

async function recordAll(org, operation) {
  const 实例 = operation.拟用实例 ?? 'host-confirmed-team-member';
  const 任务 = operation.任务;
  const receipts = [
    ['host_returned', { 实例, 初始消息id: 'initial-inbox', 团队名: operation.方式 === 'team' ? 'host-team' : null }],
    ['registered', { 实例 }],
    ['bound', { 实例, 任务 }],
    ['dispatched', { 任务 }],
    ['message_received', { 实例, 任务, 消息id: 'work-inbox' }],
    ['audited', { 实例, 任务 }],
  ];
  for (const [阶段, 回执] of receipts) await org.spawnOperations.record({ 项目: operation.项目, 操作id: operation.操作id, 阶段, 回执 });
}

describe('operation_query入口合同', () => {
  it('仅意图保留预留UUID和未知阶段；audited只表示宏审计收尾，分页不裁汇总', async () => scene(async ({ org, query }) => {
    const a = await begin(org, 'intent-only');
    const b = await begin(org, 'completed-journal', { mode: 'team' });
    assert.equal(b.operation.拟用实例, null);
    await recordAll(org, b.operation);
    const result = await query({ 条数: 1 });
    assert.equal(result.健康, '可用');
    assert.equal(result.完整, false);
    assert.deepEqual(result.汇总, { 操作: 2, 未收尾: 1, 已审计: 1, 已见宿主回执: 1, 仅有意图: 1, 有问题操作: 0, 问题记录: 0 });
    assert.equal(result.操作页.条目.length, 1);
    assert.equal(result.操作页.总数, 2);
    assert.equal(result.操作页.hasMore, true);
    assert.equal(result.操作页.条目[0].状态, 'audited');
    assert.equal(result.操作页.条目[0].拟用实例, null, 'team意图不虚构宿主实例');
    assert.deepEqual(result.操作页.条目[0].阶段.map(row => row.阶段), ['intent', 'host_returned', 'registered', 'bound', 'dispatched', 'message_received', 'audited']);
    const intent = (await query({ id: a.operation.操作id })).操作页.条目[0];
    assert.equal(intent.状态, 'intent');
    assert.match(intent.拟用实例, /^[0-9a-f-]{36}$/);
    assert.deepEqual(intent.阶段.map(row => row.阶段), ['intent']);
    assert.equal(intent.阶段[0].回执.拟用实例, a.operation.拟用实例);
    for (const field of ['已创建', '已停止', '已完成', '可创建']) assert.equal(Object.hasOwn(intent, field), false);
    assert.match(result.覆盖口径.预留, /不证明宿主已创建/);
    assert.match(result.覆盖口径.阶段, /不表示成员执行、任务或目标完成/);
    const receipt = result.操作页.条目[0].阶段.find(row => row.阶段 === 'message_received');
    assert.equal(receipt.回执.消息id, 'work-inbox');
    assert.ok(Number.isSafeInteger(receipt.事件序号));
  }));

  it('问题是内部报告，有限查询不推进阶段、不补签宿主事实，也不签发重放许可', async () => scene(async ({ org, query, log }) => {
    const { operation } = await begin(org, 'internal-issues');
    const 已确认阶段 = [{ 阶段: '已落盘意图', 操作id: operation.操作id, 任务: operation.任务, 拟用实例: operation.拟用实例 }];
    for (const 故障码 of ['MEMBER_SPAWN_RESULT_UNKNOWN', 'MEMBER_SPAWN_RECEIPT_UNKNOWN', 'MEMBER_SPAWN_ASSIGN_FAILED', 'MEMBER_SPAWN_DISPATCH_FAILED', 'MEMBER_SPAWN_MESSAGE_FAILED', 'MEMBER_SPAWN_INCOMPLETE']) {
      await org.spawnOperations.recordIssue({ 项目: P, 操作id: operation.操作id, 故障码, 已确认阶段 });
    }
    const before = await log();
    const view = await query({ id: operation.操作id });
    assert.equal(view.汇总.有问题操作, 1);
    assert.equal(view.汇总.问题记录, 6);
    assert.equal(view.汇总.已见宿主回执, 0);
    const row = view.操作页.条目[0];
    assert.equal(row.状态, 'intent');
    assert.deepEqual(row.阶段.map(stage => stage.阶段), ['intent']);
    assert.equal(row.问题.length, 5);
    assert.equal(row.问题总数, 6);
    assert.equal(row.问题截断, true);
    assert.match(row.问题[0].来源, /内部模块报告.*不代替底层事实真源核验/);
    assert.match(view.覆盖口径.问题, /不认证底层事实/);
    assert.equal(Object.hasOwn(row, '可创建'), false);
    assert.equal(await log(), before, '查询不补签问题或阶段');
  }));

  it('操作UUID与任务为精确交集，项目范围隔离且不会夹带其他记录', async () => scene(async ({ org, query, act }) => {
    const a = await begin(org, 'scope-a');
    const b = await begin(org, 'scope-b');
    const other = await begin(org, 'scope-other', { project: Q });
    const single = await query({ 任务: a.task.id });
    assert.deepEqual(single.操作页.条目.map(row => row.操作id), [a.operation.操作id]);
    assert.equal((await query({ id: a.operation.操作id, 任务: b.task.id })).汇总.操作, 0);
    assert.equal((await query({ 任务: a.task.id.slice(0, -1) })).汇总.操作, 0, '不是前缀匹配');
    assert.equal((await query({ id: other.operation.操作id })).汇总.操作, 0);
    assert.equal((await act({ action: 'operation_query', project: Q, id: other.operation.操作id })).操作.汇总.操作, 1);
    assert.equal((await query({ id: randomUUID() })).操作页.总数, 0);
  }));

  it('仅读当前真实就绪Lead及主权者，拒绝成员/复核员与伪造Lead，实际policy.read仍复判', async () => scene(async ({ org, query }) => {
    await begin(org, 'reader');
    for (const subject of [MEMBER, REVIEWER, { id: MEMBER.id, kind: 'Lead' }]) await assert.rejects(() => query({}, subject), error => error instanceof Denied);
    assert.equal((await query({}, SOVEREIGN)).汇总.操作, 1);
    const check = org.policy.check.bind(org.policy);
    org.policy.check = async spec => {
      if (spec.action === 'read' && spec.target?.kind === '成员创建操作') throw new Denied('测试当前读策略', '读资格可撤回');
      return check(spec);
    };
    await assert.rejects(() => query(), error => error instanceof Denied);
    org.policy.check = check;
    await org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '读资格复判' });
    await assert.rejects(() => query(), error => error instanceof Denied);
  }));

  it('模型与命令均无写操作或阶段补签，伪造主体/认证/回执以及无界分页明确拒绝', async () => scene(async ({ act, query, log }) => {
    for (const key of ['subject', '主体', '认证', '面', '人侧', '执行计划', '回执', '阶段', '故障码', '已确认阶段', '拟用实例', '可创建', '请求摘要', '清零', '恢复', '审批引用']) {
      await assert.rejects(() => query({ [key]: key === '回执' ? { 实例: randomUUID() } : 'forged' }), invalid, key);
    }
    for (const action of ['operation_begin', 'operation_record', 'operation_issue', 'operation_reset', 'operation_recover', 'begin', 'record', 'recordIssue']) {
      assert.equal(ACTIONS.includes(action), false);
      assert.equal(COMMAND_ACTIONS.includes(action), false);
      await assert.rejects(() => act({ action }), error => error instanceof InvalidBody);
    }
    for (const args of [{ id: 'not-uuid' }, { 任务: '' }, { 条数: 0 }, { 条数: 51 }, { 条数: Infinity }, { 偏移: -1 }, { 偏移: 0.5 }]) await assert.rejects(() => query(args), invalid);
    assert.equal(await log(), null);
  }));

  it('纯查询不造操作与审计事实；意图持久化后重装配只读认回，从不再发创建许可', async () => scene(async ({ f, org, query, log }) => {
    const emptyAudit = await org.audit.read({});
    assert.equal(await log(), null);
    assert.equal((await query()).汇总.操作, 0);
    assert.equal(await log(), null);
    assert.deepEqual(await org.audit.read({}), emptyAudit);
    const a = await begin(org, 'durable-intent');
    const before = await log();
    const reopened = await Org.open(configFor(f));
    const audit = await org.audit.read({}); // 重装配本身有进程登记审计；下列查询及幂等认回不得新增。
    const actual = await reopened.spawnOperations.query({ subject: LEAD, 项目: P, id: a.operation.操作id });
    assert.equal(actual.操作页.条目[0].拟用实例, a.operation.拟用实例);
    const repeated = await reopened.spawnOperations.begin(a.spec);
    assert.equal(repeated.操作id, a.operation.操作id);
    assert.equal(repeated.可创建, false);
    assert.equal(repeated.幂等, true);
    await assert.rejects(() => reopened.spawnOperations.begin({ ...a.spec, 请求摘要: digest('different') }), error => error instanceof Denied);
    await query({ 条数: 1, 偏移: 1 });
    assert.equal(await log(), before);
    assert.deepEqual(await org.audit.read({}), audit);
  }));
});

it('真实tool/command共用operation_query只读入口，数字分页有限且不开放恢复写动作', async () => {
  const f = await makeFixture();
  const host = fakeHost();
  try {
    const cwd = join(f.home, P);
    await mkdir(cwd, { recursive: true });
    const config = { ...configFor(f), projectBindings: [{ path: cwd, project: P }] };
    await kernel.apply(host.ctx, config);
    const org = await shareOrg(config);
    const agent = { session: { id: 'lead', header: { cwd } } };
    const tool = host.工具.get('mind');
    const command = host.命令.get('mind');
    assert.ok(ACTIONS.includes('operation_query'));
    assert.ok(COMMAND_ACTIONS.includes('operation_query'));
    assert.ok(READ_ONLY_ACTIONS.includes('operation_query'));
    assert.ok(tool.parameters.properties.action.enum.includes('operation_query'));
    assert.equal(tool.isConcurrencySafe({ action: 'operation_query' }), true);
    for (const action of ['operation_begin', 'operation_record', 'operation_issue', 'operation_reset', 'operation_recover', 'begin', 'record', 'recordIssue']) assert.equal(tool.parameters.properties.action.enum.includes(action), false);
    const a = await begin(org, 'host-a');
    await begin(org, 'host-b');
    await begin(org, 'host-c');
    const before = await readTextOrNull(f.layout.spawnOperationLog(P));
    const exec = { name: 'mind', agent, signal: new AbortController().signal };
    const page = JSON.parse(await tool.execute({ action: 'operation_query', 条数: 1, 偏移: 0 }, exec));
    const next = JSON.parse((await command.handler({ agent, rawInput: 'operation_query 条数=1 偏移=1' })).text);
    assert.equal(page.成功, true, JSON.stringify(page));
    assert.equal(next.成功, true, JSON.stringify(next));
    assert.deepEqual(page.操作.汇总, next.操作.汇总);
    assert.equal(page.操作.汇总.操作, 3);
    assert.equal(page.操作.操作页.条目.length, 1);
    assert.equal(next.操作.操作页.条目.length, 1);
    assert.notEqual(page.操作.操作页.条目[0].操作id, next.操作.操作页.条目[0].操作id);
    const exact = JSON.parse((await command.handler({ agent, rawInput: `operation_query 任务=${a.task.id}` })).text);
    assert.equal(exact.成功, true, JSON.stringify(exact));
    assert.deepEqual(exact.操作.操作页.条目.map(row => row.操作id), [a.operation.操作id]);
    const spoof = JSON.parse((await command.handler({ agent, rawInput: 'operation_query 阶段=audited' })).text);
    assert.equal(spoof.成功, false);
    const member = JSON.parse(await tool.execute({ action: 'operation_query' }, { ...exec, agent: { session: { id: MEMBER.id, header: { cwd } } } }));
    assert.equal(member.成功, false);
    assert.equal(await readTextOrNull(f.layout.spawnOperationLog(P)), before);
  } finally { host.清理(); await f.cleanup(); }
});
