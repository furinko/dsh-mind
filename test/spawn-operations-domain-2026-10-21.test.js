/** 创建意图是禁止重复宿主副作用的真源；阶段只描述回执，不提供恢复或完成证明。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { SpawnOperationService } from '../src/spawn-operations.js';
import { SPAWN_OPERATION_ISSUE_CODES, spawnOperationLogPath, spawnOperationLockPath, readSpawnOperationLedger, readSpawnOperationLedgerSync, parseSpawnOperationLedger } from '../src/spawn-operation-ledger.js';
import { Denied, Fault, InvalidBody, describeFailure } from '../src/kernel/errors.js';

const P = 'spawn-operations-domain';
async function scene(run) {
  const f = await makeFixture();
  try {
    const tasks = new TaskGraph(f);
    const make = (extra = {}) => new SpawnOperationService({ ...f, ...extra });
    const service = make();
    const createTask = (extra = {}) => tasks.create({ subject: LEAD, 项目: P, 描述: '需要持久执行体的任务', 负责人: ['member-a'], 判据: ['有独立可核对结果'], ...extra });
    const task = await createTask();
    const spec = { 项目: P, subject: LEAD, 任务: task.id, 方式: 'subagent', 请求摘要: 'a'.repeat(64) };
    const begin = (extra = {}) => service.begin({ ...spec, ...extra });
    const record = (operation, stage, receipt) => service.record({ 项目: P, 操作id: operation.操作id, 阶段: stage, 回执: receipt });
    const host = (operation, extra = {}) => record(operation, 'host_returned', { 实例: operation.拟用实例 ?? 'team-member', 初始消息id: null, 团队名: operation.方式 === 'team' ? 'test-team' : null, ...extra });
    const finish = async (operation) => {
      await host(operation);
      const instance = operation.拟用实例 ?? 'team-member';
      for (const [stage, receipt] of [['registered', { 实例: instance }], ['bound', { 实例: instance, 任务: operation.任务 }], ['dispatched', { 任务: operation.任务 }], ['message_received', { 实例: instance, 任务: operation.任务, 消息id: 'task-message-id' }], ['audited', { 实例: instance, 任务: operation.任务 }]]) await record(operation, stage, receipt);
    };
    const query = (extra = {}) => service.query({ subject: LEAD, 项目: P, ...extra });
    const file = spawnOperationLogPath(f.layout, P);
    const rows = () => readSpawnOperationLedger(file, P);
    await run({ f, tasks, service, make, createTask, task, spec, begin, record, host, finish, query, file, rows });
  } finally { await f.cleanup(); }
}

describe('持久成员创建操作领域', () => {
  it('首次intent预留UUID，重建/重复只认回且永不重新签发可创建', async () => scene(async ({ service, make, spec, begin, rows }) => {
    const first = await begin();
    assert.match(first.操作id, /^[a-f0-9-]{36}$/);
    assert.match(first.拟用实例, /^[a-f0-9-]{36}$/);
    assert.notEqual(first.操作id, first.拟用实例);
    assert.equal(first.状态, 'intent'); assert.equal(first.可创建, true); assert.equal(first.幂等, false);
    const retry = await make().begin(spec);
    assert.deepEqual(retry, { ...first, 可创建: false, 幂等: true });
    assert.equal((await rows()).length, 1);
    assert.equal(service.findByTask(P, spec.任务).拟用实例, first.拟用实例);
  }));

  it('并发跨service同规范只一份intent/许可，冲突请求也不能第二次创建', async () => scene(async ({ make, spec, rows }) => {
    const results = await Promise.all(Array.from({ length: 6 }, () => make().begin(spec)));
    assert.equal(results.filter((item) => item.可创建).length, 1);
    assert.equal(new Set(results.map((item) => item.操作id)).size, 1);
    assert.equal(new Set(results.map((item) => item.拟用实例)).size, 1);
    const conflicts = await Promise.allSettled(['b', 'c'].map((char) => make().begin({ ...spec, 请求摘要: char.repeat(64) })));
    assert.equal(conflicts.filter((item) => item.status === 'rejected' && item.reason instanceof Denied).length, 2);
    assert.equal((await rows()).length, 1);
  }));

  it('其它方式/指纹显式冲突并给可查询操作id，不披露请求正文', async () => scene(async ({ begin, rows }) => {
    const first = await begin();
    for (const extra of [{ 方式: 'team' }, { 请求摘要: 'd'.repeat(64) }]) await assert.rejects(() => begin(extra), (error) => error instanceof Denied && error.detail.操作id === first.操作id && error.detail.可创建 === false);
    assert.equal((await rows()).length, 1);
  }));

  it('team无预留实例，实际回执可为非UUID标识，后续同实例同任务严格前进', async () => scene(async ({ begin, finish, query }) => {
    const operation = await begin({ 方式: 'team' });
    assert.equal(operation.拟用实例, null);
    await finish(operation);
    const item = (await query()).操作页.条目[0];
    assert.equal(item.状态, 'audited');
    assert.equal(item.阶段[1].回执.实例, 'team-member');
    assert.equal(item.阶段.length, 7);
    assert.equal(Object.hasOwn(item, '任务状态'), false);
    assert.equal(Object.hasOwn(item, '宿主停止'), false);
  }));

  it('subagent返回ID必须等于预留候选，不符时不记录任何host_returned', async () => scene(async ({ begin, host, service, rows }) => {
    const operation = await begin();
    await assert.rejects(() => host(operation, { 实例: randomUUID() }), (error) => error instanceof Denied);
    assert.equal((await rows()).length, 1);
    assert.equal(service.findByTask(P, operation.任务).状态, 'intent');
    await host(operation, { 初始消息id: 'standby-inbox-id' });
    assert.equal(service.findByTask(P, operation.任务).状态, 'host_returned');
  }));

  it('六阶段完成后begin仍只读认回，旧stage认回不回退最新投影', async () => scene(async ({ begin, finish, record, rows, query }) => {
    const operation = await begin();
    await finish(operation);
    const before = await rows();
    const retry = await begin();
    assert.equal(retry.状态, 'audited'); assert.equal(retry.可创建, false);
    const old = await record(operation, 'registered', { 实例: operation.拟用实例 });
    assert.equal(old.状态, 'audited'); assert.equal(old.幂等, true); assert.equal(old.事件序号, 3);
    assert.deepEqual(await rows(), before);
    assert.deepEqual((await query()).汇总, { 操作: 1, 未收尾: 0, 已审计: 1, 已见宿主回执: 1, 仅有意图: 0, 有问题操作: 0, 问题记录: 0 });
  }));

  it('跳阶段、补签冲突、换实例或换任务均拒绝且不追加', async () => scene(async ({ begin, host, record, rows }) => {
    const operation = await begin();
    await assert.rejects(() => record(operation, 'bound', { 实例: operation.拟用实例, 任务: operation.任务 }), (error) => error instanceof Denied);
    await host(operation);
    const before = await rows();
    await assert.rejects(() => host(operation, { 初始消息id: 'new-id' }), (error) => error instanceof Denied);
    await assert.rejects(() => record(operation, 'registered', { 实例: 'another' }), (error) => error instanceof Denied);
    assert.deepEqual(await rows(), before);
    await record(operation, 'registered', { 实例: operation.拟用实例 });
    await assert.rejects(() => record(operation, 'bound', { 实例: operation.拟用实例, 任务: 'another-task' }), (error) => error instanceof Denied);
    assert.equal((await rows()).length, 3);
  }));

  it('未知阶段/正文/缺字段/自报主体拒绝，缺少intent不能补造事实', async () => scene(async ({ service, begin, record, rows }) => {
    const operation = await begin();
    for (const [stage, receipt] of [['stopped', {}], ['host_returned', { 实例: operation.拟用实例, 初始消息id: null }], ['host_returned', { 实例: operation.拟用实例, 初始消息id: null, 团队名: null, 正文: 'private' }], ['host_returned', { 实例: operation.拟用实例, 初始消息id: '', 团队名: null }]]) await assert.rejects(() => record(operation, stage, receipt), (error) => error instanceof InvalidBody);
    await assert.rejects(() => service.record({ 项目: P, 操作id: operation.操作id, 阶段: 'host_returned', 回执: { 实例: operation.拟用实例, 初始消息id: null, 团队名: null }, subject: LEAD }), (error) => error instanceof InvalidBody);
    await assert.rejects(() => record({ ...operation, 操作id: randomUUID() }, 'dispatched', { 任务: operation.任务 }), (error) => error instanceof Denied);
    assert.equal((await rows()).length, 1);
  }));

  it('阶段并发只追加一次，同阶段不同回执竞争只有一个胜出', async () => scene(async ({ make, begin, record, rows }) => {
    const operation = await begin();
    const input = { 项目: P, 操作id: operation.操作id, 阶段: 'host_returned', 回执: { 实例: operation.拟用实例, 初始消息id: null, 团队名: null } };
    const result = await Promise.all([make().record(input), make().record(input)]);
    assert.equal(result.filter((item) => !item.幂等).length, 1);
    await record(operation, 'registered', { 实例: operation.拟用实例 });
    const both = await Promise.allSettled(['message-a', 'message-b'].map((消息id) => make().record({ ...input, 回执: { ...input.回执, 初始消息id: 消息id } })));
    assert.equal(both.filter((item) => item.status === 'rejected' && item.reason instanceof Denied).length, 2);
    assert.equal((await rows()).length, 3);
  }));

  it('封存/撤权后迟到阶段仍可记录；新begin和治理读取仍复核当前资格', async () => scene(async ({ f, make, begin, host, record, query, service, spec }) => {
    const operation = await begin();
    await f.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '创建途中实例退场' });
    await host(operation);
    await make({ registry: null, policy: null }).record({ 项目: P, 操作id: operation.操作id, 阶段: 'registered', 回执: { 实例: operation.拟用实例 } });
    await record(operation, 'bound', { 实例: operation.拟用实例, 任务: operation.任务 });
    assert.equal(service.findByTask(P, operation.任务).状态, 'bound');
    await assert.rejects(() => begin(), (error) => error instanceof Denied);
    await assert.rejects(() => query(), (error) => error instanceof Denied);
    assert.equal((await query({ subject: SOVEREIGN })).汇总.未收尾, 1);
    assert.equal(service.findByTask(P, spec.任务).阶段[2].阶段, 'registered');
  }));

  it('无当前Lead/岗位伪报/无就绪卡不产生intent，主权者也不代Lead发起', async () => scene(async ({ f, begin, rows }) => {
    for (const subject of [MEMBER, SOVEREIGN, { id: MEMBER.id, kind: 'Lead' }, { id: 'ghost', kind: 'Lead' }, { ...LEAD, roleId: '插件工程' }]) await assert.rejects(() => begin({ subject }), (error) => error instanceof Denied);
    const file = f.layout.identityFile();
    const saved = await readFile(file, 'utf8'); const identity = JSON.parse(saved);
    identity.members.lead.卡版本 = null;
    await writeFile(file, JSON.stringify(identity));
    await assert.rejects(() => begin(), (error) => error instanceof Denied);
    assert.equal((await rows()).length, 0);
    await writeFile(file, saved);
  }));

  it('任务撤回和失联写冻结拒新意图，读诊断不因未知写许可被当放行', async () => scene(async ({ f, begin, task, rows }) => {
    await f.registry.revoke({ subject: SOVEREIGN, 对象id: task.id, 理由: '任务撤回' });
    await assert.rejects(() => begin(), (error) => error instanceof Denied);
    assert.equal((await rows()).length, 0);
    const identityFile = f.layout.identityFile(); const identity = JSON.parse(await readFile(identityFile, 'utf8'));
    identity.denylist = []; identity.sovereign.lastInteraction = '2000-01-01T00:00:00Z';
    await writeFile(identityFile, JSON.stringify(identity));
    await assert.rejects(() => begin(), (error) => error instanceof Denied && /写冻结/.test(error.rule));
    assert.equal((await rows()).length, 0);
  }));

  it('begin使用真实任务read判定，当前read deny不允许记录意图', async () => scene(async ({ f, begin, rows, task }) => {
    const file = '集体L1-法律/权限矩阵.md'; const original = await readFile(f.layout.factory(file), 'utf8');
    await f.write(file, original + '\n```policy\n' + JSON.stringify({ grants: [{ subject: 'Lead', action: 'read', id: task.id, kind: '任务', verdict: 'deny', reason: '当前任务读已收紧' }] }) + '\n```\n');
    await assert.rejects(() => begin(), (error) => error instanceof Denied);
    assert.equal((await rows()).length, 0);
  }));

  it('首await前冻结请求与主体，调用者随后改字段不能转移intent', async () => scene(async ({ service, spec, rows }) => {
    const args = structuredClone(spec); const original = structuredClone(args);
    const pending = service.begin(args);
    args.任务 = 'moved-task'; args.subject.id = 'ghost'; args.方式 = 'team'; args.请求摘要 = 'f'.repeat(64);
    const result = await pending;
    assert.equal(result.任务, original.任务); assert.equal(result.方式, original.方式);
    assert.deepEqual((await rows())[0].by, LEAD);
    assert.equal((await rows())[0].请求摘要, original.请求摘要);
  }));

  it('query仅治理当前真Lead/主权者，成员/复核员/字段造数拒绝', async () => scene(async ({ begin, query }) => {
    const operation = await begin();
    for (const subject of [MEMBER, { id: MEMBER.id, kind: 'Lead' }, { id: 'reviewer', kind: '成员', roleId: '复核员' }]) await assert.rejects(() => query({ subject }), (error) => error instanceof Denied);
    assert.equal((await query({ subject: SOVEREIGN, id: operation.操作id })).操作页.总数, 1);
    for (const extra of [{ 阶段: 'audited' }, { subject: { ...LEAD, roleId: 'wrong' } }, { 正文: 'private' }, { 可创建: true }, { 条数: 51 }, { 偏移: -1 }, { id: 'bad-id' }]) await assert.rejects(() => query(extra), (error) => error instanceof InvalidBody || error instanceof Denied);
  }));

  it('工作台summaryFor复用真实卡和当前read，合法纯投影不写审计或事实', async () => scene(async ({ f, service, begin, query, rows, file }) => {
    await begin(); const before = await rows(); const audit = await f.audit.readVerified();
    assert.equal((await service.summaryFor({ subject: LEAD, 项目: P })).汇总.操作, 1);
    assert.equal(await service.summaryFor({ subject: MEMBER, 项目: P }), null);
    assert.deepEqual(await rows(), before); assert.deepEqual(await f.audit.readVerified(), audit);
    const matrix = '集体L1-法律/权限矩阵.md'; const source = await readFile(f.layout.factory(matrix), 'utf8');
    await f.write(matrix, source + '\n```policy\n' + JSON.stringify({ grants: [{ subject: 'Lead', action: 'read', kind: '成员创建操作', verdict: 'deny', reason: '读面收紧' }] }) + '\n```\n');
    assert.equal(await service.summaryFor({ subject: LEAD, 项目: P }), null);
    await assert.rejects(() => query(), (error) => error instanceof Denied);
    await f.write(matrix, source);
    await writeFile(file, (await readFile(file, 'utf8')) + '{bad}\n');
    const visible = await service.summaryFor({ subject: LEAD, 项目: P });
    assert.equal(visible.健康, '不可用'); assert.equal(visible.汇总.操作, null);
  }));

  it('分页只截条目，完整过滤汇总保持；项目相同任务标识相互隔离', async () => scene(async ({ service, createTask, begin, host, finish, query, spec }) => {
    const first = await begin(); await finish(first);
    const secondTask = await createTask(); const second = await begin({ 任务: secondTask.id }); await host(second);
    const thirdTask = await createTask(); await begin({ 任务: thirdTask.id });
    const foreign = await service.begin({ ...spec, 项目: 'another-project' });
    assert.notEqual(foreign.操作id, first.操作id);
    const page = await query({ 条数: 1, 偏移: 1 });
    assert.equal(page.操作页.条目.length, 1); assert.equal(page.操作页.总数, 3); assert.equal(page.操作页.hasMore, true);
    assert.deepEqual(page.汇总, { 操作: 3, 未收尾: 2, 已审计: 1, 已见宿主回执: 2, 仅有意图: 1, 有问题操作: 0, 问题记录: 0 });
    assert.equal((await query({ id: first.操作id, 任务: thirdTask.id })).操作页.总数, 0);
    assert.equal((await query({ 任务: secondTask.id })).操作页.条目[0].操作id, second.操作id);
  }));

  it('空观察不是无宿主副作用证明，阶段字段不含正文且返回修改不污染真源', async () => scene(async ({ service, begin, host, query, rows }) => {
    const empty = await query(); assert.equal(empty.汇总.操作, 0); assert.equal(empty.完整, false);
    assert.match(empty.覆盖口径.范围, /没有记录不证明/);
    const operation = await begin(); await host(operation);
    const page = await query(); page.操作页.条目[0].阶段[1].回执.实例 = 'tampered';
    const raw = service.rawSnapshot(P); raw.操作[0].阶段.length = 0;
    assert.equal(service.findByTask(P, operation.任务).阶段[1].回执.实例, operation.拟用实例);
    assert.equal(Object.hasOwn((await rows())[1], 'subject'), false);
    assert.deepEqual((await rows())[1].by, { id: 'spawn-operation-journal', kind: '系统' });
  }));

  it('append失败不能签发可创建，回执明确未知而非宣称未提交', async () => scene(async ({ f, make, spec, file }) => {
    const service = make({ clock: { iso: () => { mkdirSync(file); return f.clock.iso(); } } });
    await assert.rejects(() => service.begin(spec), (error) => {
      assert.equal(error.code, 'SPAWN_OPERATION_APPEND_FAILED'); assert.ok(error.cause); assert.equal(error.outcome.提交状态, '未知'); assert.equal(error.outcome.可重试, false);
      const failure = describeFailure(error); const anchor = failure.已确认阶段[0];
      assert.equal(anchor.操作id, error.detail.操作id); assert.equal(anchor.任务, spec.任务); assert.match(anchor.拟用实例, /^[a-f0-9-]{36}$/);
      assert.match(anchor.阶段, /追加未确认且未取得放行/);
      return true;
    });
    await rm(file, { recursive: true });
  }));

  it('诊断issue持久保留部分提交锚点，不推进stage也不签创建许可', async () => scene(async ({ service, make, begin, host, query, rows }) => {
    const operation = await begin(); await host(operation);
    const spec = { 项目: P, 操作id: operation.操作id, 故障码: 'MEMBER_SPAWN_DISPATCH_FAILED', 已确认阶段: [{ 阶段: '任务事件已落线但审计未收尾', 项目: P, 任务: operation.任务, 操作id: operation.操作id, 实例: operation.拟用实例, 事件: 'dispatched', 事件序号: 42 }, { 阶段: '已尝试释放当前驻留', 实例: operation.拟用实例, 已请求: true, 当前驻留已释放: true }] };
    const result = await service.recordIssue(spec);
    assert.equal(result.状态, 'host_returned'); assert.equal(result.已记录阶段, 'issue'); assert.equal(result.幂等, false);
    const before = await rows(); assert.equal((await make().recordIssue(spec)).幂等, true); assert.deepEqual(await rows(), before);
    const view = (await query()).操作页.条目[0];
    assert.equal(view.问题[0].已确认阶段[0].事件序号, 42); assert.match(view.问题[0].来源, /不代替底层事实/);
    assert.equal(view.阶段.length, 2); assert.equal(view.状态, 'host_returned');
    assert.equal((await begin()).可创建, false);
    assert.equal((await query()).汇总.有问题操作, 1); assert.equal((await query()).汇总.问题记录, 1);
  }));

  it('issue可在audited后迟到且撤权不丢报告；同码冲突不覆盖/正文与伪字段拒绝', async () => scene(async ({ f, service, make, begin, finish, rows }) => {
    const operation = await begin(); await finish(operation);
    await f.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '治理身份退出，仍保留迟到诊断' });
    const spec = { 项目: P, 操作id: operation.操作id, 故障码: 'AUDIT_APPEND_FAILED_AFTER_EVENT', 已确认阶段: [{ 阶段: '内部报告；底层事实须核对', 任务: operation.任务, 预算目标: 'goal-1', 执行键: 'budget-execution', 对象id: operation.任务, 已封存: false }] };
    await make({ registry: null, policy: null }).recordIssue(spec);
    const before = await rows();
    await assert.rejects(() => service.recordIssue({ ...spec, 已确认阶段: [{ 阶段: '另一套报告' }] }), (error) => error instanceof Denied);
    for (const change of [{ 故障码: 'PRIVATE_ERROR_WITH_BODY' }, { 已确认阶段: [{ 阶段: 'private', stack: 'secret' }] }, { 已确认阶段: [{ 阶段: 'phase', 已请求: null }] }, { 已确认阶段: [{ 阶段: 'phase', 实例: 'x'.repeat(257) }] }, { 已确认阶段: [{ 阶段: 'phase', 事件序号: Number.MAX_SAFE_INTEGER + 1 }] }, { 已确认阶段: Array.from({ length: 33 }, () => ({ 阶段: 'phase' })) }]) await assert.rejects(() => service.recordIssue({ ...spec, ...change }), (error) => error instanceof InvalidBody);
    await assert.rejects(() => service.recordIssue({ ...spec, 故障码: 'MEMBER_SPAWN_FAILED', 已确认阶段: [{ 阶段: 'wrong scope', 任务: 'another-task' }] }), (error) => error instanceof Denied);
    assert.deepEqual(await rows(), before); assert.equal(service.findByTask(P, operation.任务).状态, 'audited');
  }));

  it('问题页有界但汇总与总数保留，伪造issue事件损坏不能略过', async () => scene(async ({ service, begin, query, rows, file }) => {
    const operation = await begin();
    for (const code of SPAWN_OPERATION_ISSUE_CODES.slice(0, 7)) await service.recordIssue({ 项目: P, 操作id: operation.操作id, 故障码: code, 已确认阶段: [{ 阶段: '内部安全诊断', 操作id: operation.操作id }] });
    const page = await query(); const view = page.操作页.条目[0];
    assert.equal(view.问题.length, 5); assert.equal(view.问题总数, 7); assert.equal(view.问题截断, true); assert.equal(page.汇总.问题记录, 7);
    const existing = await rows(); existing.at(-1).已确认阶段[0].message = 'private';
    await writeFile(file, existing.map((row) => JSON.stringify(row)).join('\n') + '\n');
    assert.throws(() => service.rawSnapshot(P), (error) => error.code === 'SPAWN_OPERATION_LEDGER_INVALID');
  }));

  for (const corruption of ['json', 'torn', 'blank', 'unknown', 'unknown-field', 'seq', 'actor', 'stage-actor', 'migration', 'uuid', 'hash', 'candidate', 'same-task', 'stage-order', 'instance', 'task', 'duplicate-stage']) it(`严格账本${corruption}损坏不当作无intent并拒绝继续追加`, async () => scene(async ({ service, begin, host, query, record, rows, file }) => {
    const operation = await begin(); await host(operation); const existing = await rows();
    let text;
    if (corruption === 'json') text = existing.map((row) => JSON.stringify(row)).join('\n') + '\n{bad}\n';
    else if (corruption === 'torn') text = existing.map((row) => JSON.stringify(row)).join('\n');
    else if (corruption === 'blank') text = existing.map((row) => JSON.stringify(row)).join('\n\n') + '\n';
    else {
      if (corruption === 'unknown') existing[1].kind = 'stopped';
      if (corruption === 'unknown-field') existing[0].任务书 = 'private';
      if (corruption === 'seq') existing[1].seq = 50;
      if (corruption === 'actor') existing[0].by.kind = '成员';
      if (corruption === 'stage-actor') existing[1].by = LEAD;
      if (corruption === 'migration') existing[1].项目 = 'another-project';
      if (corruption === 'uuid') existing[0].操作id = 'unknown-operation';
      if (corruption === 'hash') existing[0].请求摘要 = 'missing';
      if (corruption === 'candidate') existing[0].拟用实例 = null;
      if (corruption === 'same-task') existing.push({ ...existing[0], seq: 3, 操作id: randomUUID(), 拟用实例: randomUUID() });
      if (corruption === 'stage-order') { existing[1].阶段 = 'registered'; existing[1].回执 = { 实例: operation.拟用实例 }; }
      if (corruption === 'instance') existing[1].回执.实例 = randomUUID();
      if (corruption === 'task') existing.push({ seq: 3, at: existing[0].at, by: { id: 'spawn-operation-journal', kind: '系统' }, kind: 'stage', 项目: P, 操作id: operation.操作id, 阶段: 'bound', 回执: { 实例: operation.拟用实例, 任务: 'other' } });
      if (corruption === 'duplicate-stage') existing.push({ ...existing[1], seq: 3 });
      text = existing.map((row) => JSON.stringify(row)).join('\n') + '\n';
    }
    await writeFile(file, text);
    assert.throws(() => service.findByTask(P, operation.任务), (error) => error.code === 'SPAWN_OPERATION_LEDGER_INVALID');
    assert.equal(service.summary(P).健康, '不可用'); assert.equal(service.summary(P).汇总.操作, null);
    await assert.rejects(() => query(), (error) => error.code === 'SPAWN_OPERATION_LEDGER_INVALID');
    await assert.rejects(() => begin(), (error) => error.code === 'SPAWN_OPERATION_LEDGER_INVALID');
    await assert.rejects(() => record(operation, 'registered', { 实例: operation.拟用实例 }), (error) => error.code === 'SPAWN_OPERATION_LEDGER_INVALID');
    assert.equal(await readFile(file, 'utf8'), text);
  }));

  it('同步异步读兼容BOM/CRLF，路径fallback和独立锁无目标任务反锁', async () => scene(async ({ f, begin, rows, file }) => {
    await begin(); const saved = await readFile(file, 'utf8');
    await writeFile(file, '\ufeff' + saved.replaceAll('\n', '\r\n'));
    assert.deepEqual(readSpawnOperationLedgerSync(file, P), await rows());
    assert.deepEqual(parseSpawnOperationLedger(await readFile(file, 'utf8'), P), await rows());
    const fallback = { taskLog: (project) => f.layout.taskLog(project) };
    assert.equal(spawnOperationLogPath(fallback, P), file);
    assert.match(spawnOperationLockPath(fallback, P), /spawn-operations\.lock$/);
  }));
});
