/** 实际SDK快照观察：不逐样本相加，不将结束/归因/路由当业务成功或完整成本。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { TaskGraph } from '../src/tasks.js';
import { ModelUsageService } from '../src/model-usage.js';
import { MODEL_USAGE_FIELDS, modelUsageLogPath, readModelUsageLedger, readModelUsageLedgerSync, parseModelUsageLedger } from '../src/model-usage-ledger.js';
import { Denied, Fault, InvalidBody } from '../src/kernel/errors.js';

const P = 'model-usage-domain';
const invalid = (error) => error instanceof Denied || error instanceof Fault || error instanceof InvalidBody;
async function scene(run) {
  const f = await makeFixture();
  try {
    const tasks = new TaskGraph({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, registry: f.registry });
    const make = (extra = {}) => new ModelUsageService({ layout: f.layout, policy: f.policy, clock: f.clock, registry: f.registry, goals: tasks.goals, ...extra });
    const usage = make();
    let serial = 0;
    const startSpec = (extra = {}) => ({ 项目: P, 执行键: randomUUID(), 会话: LEAD.id, 生命周期: randomUUID(), attemptId: `lead:${++serial}`, revision: 1, turn: 0, step: 0,
      主体: { ...LEAD }, 归因: { 目标: null, 原因: '起始帧无唯一活动绑定，保持未归因' }, 配置路由: { provider: null, model: null }, ...extra });
    const start = async (extra = {}) => { const spec = startSpec(extra); await usage.recordStart(spec); return spec; };
    const sample = (spec, extra = {}) => usage.recordSample({ 项目: spec.项目, 执行键: spec.执行键, index: 0, revision: 3, time: 0, usage: { inputTokens: 2, outputTokens: 1 }, ...extra });
    const end = (spec, extra = {}) => usage.recordEnd({ 项目: spec.项目, 执行键: spec.执行键, index: 1, revision: 8, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 }, finish: 'stop', ...extra });
    const query = (extra = {}) => usage.query({ subject: LEAD, 项目: P, ...extra });
    const file = modelUsageLogPath(f.layout, P);
    const rows = () => readModelUsageLedger(file, P);
    const goal = (project = P) => tasks.goals.create({ subject: LEAD, 项目: project, 请求键: randomUUID(), 期望结果: '明确用户期望', 完成依据: ['已验证结果'], 来源: '调用者转述', 下一步: '开展工作' });
    await run({ f, usage, make, startSpec, start, sample, end, query, rows, file, goal });
  } finally { await f.cleanup(); }
}

describe('模型用量只读观察领域', () => {
  it('快照替换而非样本相加，保留所有观察但工具页只返回最后usage', async () => scene(async ({ usage, start, sample, end, query }) => {
    const spec = await start();
    await sample(spec, { usage: { inputTokens: 20, outputTokens: 5, cacheReadTokens: 3, totalTokens: 28 } });
    await sample(spec, { index: 4, revision: 17, time: 200, usage: { inputTokens: 7, outputTokens: 2, totalTokens: 9 } });
    await end(spec, { index: 5, revision: 35 });
    const result = await query();
    assert.equal(result.汇总.已报告token.inputTokens, 7);
    assert.equal(result.汇总.已报告token.outputTokens, 2);
    assert.equal(result.汇总.已报告token.totalTokens, 9);
    assert.equal(result.汇总.已报告token.cacheReadTokens, null, '新快照缺字段不能沿用旧值');
    const attempt = result.尝试页.条目[0];
    assert.equal(attempt.样本数, 2);
    assert.equal(attempt.最后用量index, 4);
    assert.equal(Object.hasOwn(attempt, '样本'), false);
    assert.equal(usage.rawSnapshot(P).尝试[0].样本.length, 2);
    assert.equal(attempt.usage.cacheReadTokens, null);
    assert.equal(result.完整, false);
    assert.equal(result.token, null);
    assert.equal(result.费用, null);
  }));

  it('DISJOINT缓存进入已给total下界，reasoning属于output不再重复相加', async () => scene(async ({ start, sample, query, rows }) => {
    const spec = await start();
    const sdk = { inputTokens: 10, outputTokens: 4, cacheReadTokens: 3, cacheWriteTokens: 2, reasoningTokens: 4, totalTokens: 19 };
    await assert.rejects(() => sample(spec, { usage: { ...sdk, totalTokens: 18 } }), (error) => error instanceof InvalidBody);
    assert.equal((await rows()).length, 1);
    await sample(spec, { usage: sdk });
    const result = await query();
    assert.deepEqual(result.汇总.已报告token, sdk);
    assert.equal(result.汇总.已报告token.outputTokens, 4, 'reasoning不另加到output');
  }));

  it('真实0与未知分开，缺失total不计算；每个SDK字段报告已知/缺失覆盖', async () => scene(async ({ start, sample, end, query }) => {
    await start();
    const zero = await start();
    await sample(zero, { usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 } });
    await end(zero);
    const result = await query();
    assert.equal(result.汇总.尝试, 2);
    assert.equal(result.汇总.有用量, 1);
    assert.equal(result.汇总.无用量, 1);
    assert.equal(result.汇总.已报告token.inputTokens, 0);
    assert.equal(result.汇总.已报告token.totalTokens, null);
    assert.equal(result.汇总.已报告token.cacheReadTokens, 0);
    assert.equal(result.汇总.已报告token.reasoningTokens, null);
    assert.deepEqual(result.汇总.字段覆盖.inputTokens, { 已知: 1, 缺失: 1 });
    assert.deepEqual(result.汇总.字段覆盖.totalTokens, { 已知: 0, 缺失: 2 });
    assert.equal(result.尝试页.条目.find((attempt) => attempt.执行键 === zero.执行键).usage.totalTokens, null);
  }));

  it('assistant/attempt、abandoned和open保留观察用量，不从结束推断业务成功', async () => scene(async ({ start, sample, end, query }) => {
    const failed = await start();
    await sample(failed, { usage: { inputTokens: 3, outputTokens: 2 } });
    await end(failed, { outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 11 }, finish: 'error' });
    const abandoned = await start();
    await sample(abandoned, { usage: { inputTokens: 4, outputTokens: 1 } });
    await end(abandoned, { outcome: { kind: 'abandoned' }, finish: 'aborted' });
    const open = await start();
    await sample(open, { usage: { inputTokens: 5, outputTokens: 0 } });
    const empty = await start();
    await end(empty, { index: 0, revision: 2, outcome: { kind: 'abandoned' }, finish: null });
    const result = await query();
    assert.equal(result.汇总.已报告token.inputTokens, 12);
    assert.equal(result.汇总.已报告token.outputTokens, 3);
    assert.equal(result.汇总.已结束, 3);
    assert.equal(result.汇总.未结束, 1);
    assert.equal(result.尝试页.条目.find((item) => item.执行键 === open.执行键).状态, 'open');
    assert.equal(Object.hasOwn(result.尝试页.条目[0], '业务成功'), false);
  }));

  it('同规范start/sample/end只认回，终态后旧样本可认回但新样本拒绝', async () => scene(async ({ usage, startSpec, sample, end, rows }) => {
    const spec = startSpec();
    const first = await usage.recordStart(spec);
    await sample(spec);
    const done = await end(spec);
    const before = await rows();
    const restarted = await usage.recordStart(spec);
    assert.equal(restarted.幂等, true);
    assert.equal(restarted.事件序号, first.事件序号);
    assert.equal(restarted.状态, 'ended');
    assert.equal((await sample(spec)).幂等, true);
    assert.equal((await end(spec)).事件序号, done.事件序号);
    await assert.rejects(() => sample(spec, { index: 2, revision: 20 }), (error) => error instanceof Denied);
    await assert.rejects(() => end(spec, { finish: 'error' }), (error) => error instanceof Denied);
    assert.deepEqual(await rows(), before);
  }));

  it('起始归因、会话、路由和身份不能用同执行键迁移，同index不同usage也不能覆盖', async () => scene(async ({ usage, start, sample, rows }) => {
    const spec = await start();
    const before = await rows();
    for (const change of [{ 归因: { 目标: 'goal-other', 原因: '新的归因' } }, { 配置路由: { provider: 'new', model: 'new' } }, { 生命周期: randomUUID() }, { attemptId: 'new-attempt' }, { 会话: MEMBER.id, 主体: { ...MEMBER } }]) await assert.rejects(() => usage.recordStart({ ...spec, ...change }), (error) => error instanceof Denied);
    assert.deepEqual(await rows(), before);
    await sample(spec);
    await assert.rejects(() => sample(spec, { usage: { inputTokens: 9, outputTokens: 1 } }), (error) => error instanceof Denied);
  }));

  it('revision是本attempt逐事件递增的宿主frame版本，允许全局跳号且不同attempt独立', async () => scene(async ({ usage, start, sample, end, rows }) => {
    const a = await start({ revision: 15 });
    const b = await start({ revision: 2 });
    await sample(a, { revision: 90, index: 7 });
    await sample(b, { revision: 5, index: 0 });
    await assert.rejects(() => sample(a, { index: 8, revision: 90 }), (error) => error instanceof Denied);
    await assert.rejects(() => sample(a, { index: 3, revision: 91 }), (error) => error instanceof Denied);
    await assert.rejects(() => end(a, { index: 7, revision: 92 }), (error) => error instanceof Denied);
    await end(a, { index: 8, revision: 150 });
    assert.equal(usage.rawSnapshot(P).尝试.find((item) => item.执行键 === a.执行键).revision, 150);
    assert.deepEqual((await rows()).map((row) => row.seq), [1, 2, 3, 4, 5]);
  }));

  it('同Agent生命周期attempt不得换执行键再记，新生命周期同编号是独立尝试', async () => scene(async ({ usage, start, query }) => {
    const spec = await start();
    await assert.rejects(() => usage.recordStart({ ...spec, 执行键: randomUUID() }), (error) => error instanceof Denied);
    await usage.recordStart({ ...spec, 执行键: randomUUID(), 生命周期: randomUUID() });
    assert.equal((await query()).汇总.尝试, 2);
  }));

  it('并发同规范认回只落1笔，冲突样本或结束竞争不会破坏事件顺序', async () => scene(async ({ usage, make, startSpec, sample, end, rows }) => {
    const spec = startSpec();
    const results = await Promise.all([usage.recordStart(spec), make().recordStart(spec)]);
    assert.equal(results.filter((result) => !result.幂等).length, 1);
    const sampleResults = await Promise.allSettled([sample(spec), sample(spec, { usage: { inputTokens: 6, outputTokens: 0 } })]);
    assert.equal(sampleResults.filter((result) => result.status === 'fulfilled').length, 1);
    const race = await Promise.allSettled([sample(spec, { index: 1, revision: 7 }), end(spec, { index: 1, revision: 8 })]);
    assert.equal(race.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal((await rows()).length, 3);
  }));

  it('重装配保留open与最后快照，迟到结束仍可记录，不因当前身份/目标失效丢真实帧', async () => scene(async ({ f, usage, make, start, sample, end }) => {
    const spec = await start();
    await sample(spec);
    await f.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '真实帧起始后身份退场' });
    const reopened = make();
    assert.equal(reopened.rawSnapshot(P).尝试[0].状态, 'open');
    await reopened.recordEnd({ 项目: P, 执行键: spec.执行键, index: 2, revision: 12, outcome: { kind: 'abandoned' }, finish: null });
    assert.equal(usage.rawSnapshot(P).尝试[0].状态, 'ended');
    const noIdentity = make({ policy: { check: () => { throw new Error('must not be called'); } }, registry: { identity: () => { throw new Error('must not be called'); } }, goals: { rawSnapshot: () => { throw new Error('must not be called'); } } });
    await noIdentity.recordStart({ ...spec, 执行键: randomUUID(), 生命周期: randomUUID(), 会话: 'not-yet-registered', 主体: { id: 'not-yet-registered', kind: 'Lead' } });
    assert.equal(noIdentity.rawSnapshot(P).尝试.length, 2);
    void end;
  }));

  it('首await前冻结来源，排队后调用者改对象不能把用量转给另一个目标', async () => scene(async ({ usage, startSpec }) => {
    const spec = startSpec();
    const original = structuredClone(spec);
    const promise = usage.recordStart(spec);
    spec.归因.目标 = 'goal-changed-after-queue';
    spec.配置路由.model = 'not-original-route';
    spec.主体.id = 'not-original-session';
    await promise;
    assert.deepEqual(usage.rawSnapshot(P).尝试[0].归因, original.归因);
    assert.deepEqual(usage.rawSnapshot(P).尝试[0].配置路由, original.配置路由);
    assert.equal(usage.rawSnapshot(P).尝试[0].主体.id, original.主体.id);
  }));

  it('缺会话、伪kind、Lead冒岗位、不匹配会话和写入正文/认证字段均拒，成员可保留未核岗位', async () => scene(async ({ usage, startSpec, rows }) => {
    const spec = startSpec();
    for (const change of [{ 会话: '' }, { 主体: { id: LEAD.id, kind: '主权者' } }, { 主体: { ...LEAD, roleId: 'Lead' } }, { 主体: { id: 'other', kind: 'Lead' } }, { 生命周期: 'not-uuid' }, { 执行键: 'not-uuid' }, { 主体: { id: LEAD.id, kind: 'Lead', 已认证: true } }, { prompt: '不得记录的正文' }, { messages: [] }, { 认证: '本人声明' }]) await assert.rejects(() => usage.recordStart({ ...spec, ...change }), (error) => error instanceof InvalidBody);
    assert.deepEqual(await rows(), []);
    await usage.recordStart({ ...spec, 会话: 'unknown-role-member', 主体: { id: 'unknown-role-member', kind: '成员' } });
    assert.equal(Object.hasOwn(usage.rawSnapshot(P).尝试[0].主体, 'roleId'), false);
  }));

  it('样本SDK字段严格安全整数，optional缺失不接受null，finish闭名单且不收额外内容', async () => scene(async ({ usage, start, sample, end, rows }) => {
    const spec = await start();
    for (const usage of [{ inputTokens: -1, outputTokens: 0 }, { inputTokens: 1.5, outputTokens: 0 }, { inputTokens: Number.MAX_SAFE_INTEGER + 1, outputTokens: 0 }, { inputTokens: 1, outputTokens: 0, totalTokens: null }, { inputTokens: 1, outputTokens: 0, providerCost: 1 }, { outputTokens: 0 }]) await assert.rejects(() => sample(spec, { usage }), (error) => error instanceof InvalidBody);
    await assert.rejects(() => usage.recordSample({ 项目: P, 执行键: spec.执行键, index: 0, revision: 3, time: 0, usage: { inputTokens: 0, outputTokens: 0 }, 主体: LEAD }), (error) => error instanceof InvalidBody);
    await assert.rejects(() => end(spec, { finish: 'a free text bill or error body' }), (error) => error instanceof InvalidBody);
    await assert.rejects(() => end(spec, { outcome: { kind: 'committed', eventType: 'tool/result', seq: 1 } }), (error) => error instanceof InvalidBody);
    assert.equal((await rows()).length, 1);
  }));

  it('分页不缩小全量汇总，目标筛选只读真实同项目goal，未知归因保留为项目级', async () => scene(async ({ usage, start, sample, query, goal }) => {
    const a = await goal();
    const b = await goal();
    const foreign = await goal('another-project');
    for (const target of [a.id, a.id, b.id, null]) { const spec = await start({ 归因: { 目标: target, 原因: target ? '起始唯一活动绑定' : '起始未能唯一归因' } }); await sample(spec, { usage: { inputTokens: 2, outputTokens: 1 } }); }
    const page = await query({ 条数: 1, 偏移: 1 });
    assert.equal(page.尝试页.条目.length, 1);
    assert.equal(page.尝试页.总数, 4);
    assert.equal(page.尝试页.hasMore, true);
    assert.equal(page.汇总.已报告token.inputTokens, 8);
    assert.equal(page.汇总.未归因, 1);
    const selected = await query({ id: a.id, 条数: 1 });
    assert.equal(selected.汇总.尝试, 2);
    assert.equal(selected.汇总.已报告token.inputTokens, 4);
    assert.equal(selected.汇总.未归因, 0);
    assert.equal(usage.summary(P, b.id).汇总.尝试, 1);
    await assert.rejects(() => query({ id: foreign.id }), (error) => error instanceof InvalidBody);
    await assert.rejects(() => query({ id: 'unknown-goal' }), (error) => error instanceof InvalidBody);
  }));

  it('查询只向当前在册就绪Lead/主权者开放，普通成员和停岗/未就绪Lead拒绝', async () => scene(async ({ f, usage, start, query }) => {
    await start();
    for (const subject of [MEMBER, { id: MEMBER.id, kind: 'Lead' }, { id: 'ghost', kind: 'Lead' }]) await assert.rejects(() => query({ subject }), (error) => error instanceof Denied);
    assert.equal((await query({ subject: SOVEREIGN })).汇总.尝试, 1);
    await assert.rejects(() => query({ usage: { inputTokens: 1, outputTokens: 1 } }), (error) => error instanceof InvalidBody);
    const check = f.policy.check.bind(f.policy);
    f.policy.check = async (spec) => { if (spec.target.kind === '模型用量') throw new Denied('当前测试读规则', '读权收紧'); return check(spec); };
    await assert.rejects(() => query(), /读权收紧/);
    f.policy.check = check;
    await f.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: '读资格失效' });
    await assert.rejects(() => usage.query({ subject: LEAD, 项目: P }), (error) => error instanceof Denied);
  }));

  it('带读者工作台只读投影复用真实卡与当前read拒绝，合法摘要不写任何账', async () => scene(async ({ f, usage, start, sample, rows, file }) => {
    const spec = await start();
    await sample(spec);
    const events = await rows();
    const auditBefore = await f.audit.readVerified();
    const visible = await usage.summaryFor({ subject: LEAD, 项目: P });
    assert.equal(visible.健康, '可用');
    assert.equal(visible.汇总.已报告token.inputTokens, 2);
    assert.equal(await usage.summaryFor({ subject: MEMBER, 项目: P }), null);
    assert.deepEqual(await rows(), events);
    assert.deepEqual(await f.audit.readVerified(), auditBefore);
    const identityFile = f.layout.identityFile();
    const identityRaw = await readFile(identityFile, 'utf8');
    const broken = JSON.parse(identityRaw);
    broken.members.lead.卡版本 = null;
    await writeFile(identityFile, JSON.stringify(broken));
    assert.equal(await usage.summaryFor({ subject: LEAD, 项目: P }), null, '真实Lead钉版不可用时不泄露统计');
    await assert.rejects(() => usage.query({ subject: LEAD, 项目: P }), (error) => error instanceof Denied);
    await writeFile(identityFile, identityRaw);
    const matrix = '集体L1-法律/权限矩阵.md';
    const ruleRaw = await readFile(f.layout.factory(matrix), 'utf8');
    await f.write(matrix, ruleRaw + '\n```policy\n' + JSON.stringify({ grants: [{ subject: 'Lead', action: 'read', kind: '模型用量', verdict: 'deny', reason: '只拒绝模型用量治理读面' }] }) + '\n```\n');
    assert.equal(await usage.summaryFor({ subject: LEAD, 项目: P }), null, '当前真实read deny不能被工作台旧资格绕过');
    await assert.rejects(() => usage.query({ subject: LEAD, 项目: P }), (error) => error instanceof Denied);
    await f.write(matrix, ruleRaw);
    const valid = await readFile(file, 'utf8');
    await writeFile(file, valid + '{bad}\n');
    const damaged = await usage.summaryFor({ subject: LEAD, 项目: P });
    assert.equal(damaged.健康, '不可用', '有权读者应看到真源不可用，而非假零或被当作无权');
    assert.equal(damaged.汇总.尝试, null);
  }));

  it('每个SDK字段独立累加并检测安全整溢出，其它0和缺失仍保留真实口径', async () => scene(async ({ usage, start, sample, query }) => {
    for (let i = 0; i < 2; i += 1) { const spec = await start(); await sample(spec, { usage: { inputTokens: Number.MAX_SAFE_INTEGER, outputTokens: 0, totalTokens: Number.MAX_SAFE_INTEGER } }); }
    const result = await query();
    assert.equal(result.健康, '不可用');
    assert.deepEqual(result.汇总.不可用字段, ['inputTokens', 'totalTokens']);
    assert.equal(result.汇总.已报告token.inputTokens, null);
    assert.equal(result.汇总.已报告token.totalTokens, null);
    assert.equal(result.汇总.已报告token.outputTokens, 0);
    assert.equal(result.汇总.已报告token.reasoningTokens, null);
    assert.equal(usage.summary(P).健康, '不可用');
    assert.equal(usage.rawSnapshot(P).尝试.length, 2);
  }));

  for (const corruption of ['json', 'torn', 'unknown', 'seq', 'revision', 'index', 'identity', 'migration', 'same-origin', 'duplicate-end', 'sample-after-end', 'finish']) it(`严格账本${corruption}异常不生成假零统计且拒绝继续追加`, async () => scene(async ({ usage, start, sample, end, query, rows, file }) => {
    const spec = await start();
    await sample(spec);
    await end(spec);
    const existing = await rows();
    let text;
    if (corruption === 'json') text = existing.map((row) => JSON.stringify(row)).join('\n') + '\n{bad}\n';
    else if (corruption === 'torn') text = existing.map((row) => JSON.stringify(row)).join('\n');
    else {
      if (corruption === 'unknown') existing[1].kind = 'constructor';
      if (corruption === 'seq') existing[1].seq = 90;
      if (corruption === 'revision') existing[1].revision = existing[0].revision;
      if (corruption === 'index') existing[2].index = existing[1].index;
      if (corruption === 'identity') existing[1].主体 = LEAD;
      if (corruption === 'migration') existing[1].项目 = 'another-project';
      if (corruption === 'same-origin') existing.push({ ...existing[0], seq: 4, 执行键: randomUUID() });
      if (corruption === 'duplicate-end') existing.push({ ...existing[2], seq: 4, revision: 9, index: 2 });
      if (corruption === 'sample-after-end') existing.push({ ...existing[1], seq: 4, revision: 9, index: 2 });
      if (corruption === 'finish') existing[2].finish = 'unknown-finish';
      text = existing.map((row) => JSON.stringify(row)).join('\n') + '\n';
    }
    await writeFile(file, text);
    assert.throws(() => usage.rawSnapshot(P), (error) => error.code === 'MODEL_USAGE_LEDGER_INVALID');
    const unavailable = usage.summary(P);
    assert.equal(unavailable.健康, '不可用');
    assert.equal(unavailable.汇总.尝试, null);
    assert.equal(unavailable.汇总.已报告token.inputTokens, null);
    await assert.rejects(() => query(), (error) => error.code === 'MODEL_USAGE_LEDGER_INVALID');
    await assert.rejects(() => sample(spec), (error) => error.code === 'MODEL_USAGE_LEDGER_INVALID');
    assert.equal(await readFile(file, 'utf8'), text);
  }));

  it('BOM/CRLF兼容且同步异步相同；返回值修改不能污染真源，无观察字段都是null', async () => scene(async ({ usage, start, sample, query, rows, file }) => {
    const empty = await query();
    assert.equal(empty.健康, '可用');
    assert.equal(empty.汇总.尝试, 0);
    for (const field of MODEL_USAGE_FIELDS) assert.equal(empty.汇总.已报告token[field], null);
    const spec = await start();
    await sample(spec);
    const original = await readFile(file, 'utf8');
    await writeFile(file, '\ufeff' + original.replaceAll('\n', '\r\n'));
    assert.deepEqual(readModelUsageLedgerSync(file, P), await rows());
    assert.deepEqual(parseModelUsageLedger(await readFile(file, 'utf8'), P), await rows());
    const page = await query();
    page.尝试页.条目[0].usage.inputTokens = 999;
    const raw = usage.rawSnapshot(P);
    raw.尝试[0].样本.length = 0;
    assert.equal((await query()).汇总.已报告token.inputTokens, 2);
    assert.equal(usage.rawSnapshot(P).尝试[0].样本.length, 1);
  }));
});
