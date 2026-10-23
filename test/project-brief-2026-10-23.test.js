import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { PROJECT_BRIEF_LIMITS } from '../src/project-brief.js';
import { projectTurnEvent } from '../src/turn-buffer.js';
import { createTurnBufferHooks } from '../components/kernel/lib/turn-buffer-hooks.js';
import { createProjectBriefHooks, injectProjectBrief, extractProjectBrief, PROJECT_BRIEF_SECTION } from '../components/kernel/lib/project-brief-hooks.js';
import { apply } from '../components/kernel/lib/index.js';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { runAction, ACTIONS, READ_ONLY_ACTIONS, COMMAND_ONLY_ACTIONS } from '../lib/actions.js';
import { shareOrg, forgetSharedOrg, shareKey } from '../src/runtime.js';

const P = 'project-brief';
const config = f => ({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
const spec = (subject = LEAD, project = P) => ({ subject, project, session: subject.id });
const item = (source, extra = {}) => ({ id: 'work', kind: '需求', claim: '用户表达', state: '进行中', text: '新会话接续本项目最近工作', sources: [source], ...extra });
const base = () => ({ sections: [{ name: 'host', text: 'host' }] });
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open(config(f));
  try { await run({ org, f }); } finally { await org.observability.flush(); await f.cleanup(); }
}
async function capture(org, texts, target = spec(), { time = Date.now(), close = true } = {}) {
  const pos = await org.turnBuffer.position(target);
  let seq = pos?.nextSeq ?? 0;
  const records = [{ seq: seq++, type: 'turn/start', turn: seq + 1, time }];
  const turn = records[0].turn;
  for (const value of texts) {
    const { text, role = 'user' } = typeof value === 'string' ? { text: value } : value;
    records.push({ seq: seq++, type: 'message', turn, role, text, id: `m-${seq}`, clipped: false, interrupted: false, time });
  }
  if (close) records.push({ seq: seq++, type: 'turn/end', turn, reason: 'completed', time });
  await org.turnBuffer.capture({ ...target, fromSeq: pos?.nextSeq ?? 0, throughSeq: seq, records });
  await org.projectBrief.touch(target);
  return records;
}
const update = (org, extract, target = spec()) => org.projectBrief.update(target, { extract });
const simple = input => ({ items: [item(input.messages.find(m => m.role === 'user').source)] });
async function newLead(org, id = 'new-lead') {
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: id });
  for (const session of [LEAD.id, id]) {
    const state = await org.information.load();
    await org.information.admin({ subject: SOVEREIGN, project: P }, { op: 'relationship', expectedRevision: state.configRevision, session, relationship: 'same-human-fixture' });
  }
  return spec({ id, kind: 'Lead' });
}
function session(id = LEAD.id) {
  const events = []; let nodes = [];
  return { id, header: { id, cwd: process.cwd() }, inheritedEventCount: 0, events,
    get seq() { return events.length; }, get surface() { return { nodes }; },
    requestHeader: () => ({ config: { provider: 'test', model: 'brief-model' } }),
    isOwnSeq: seq => seq >= 0 && seq < events.length,
    append(type, data, surfaceOp) {
      const event = { seq: events.length, type, data, time: Date.now(), ...(surfaceOp ? { surfaceOp } : {}) };
      events.push(event); if (surfaceOp === 'append') nodes = [...nodes, event.seq]; return event;
    },
  };
}
function llm(extract) {
  return { async prepareCall(config, signal) {
    return { config, async *stream(options) {
      assert.equal(options.tools, undefined); assert.equal(options.purpose, undefined); assert.equal(options.sessionId, undefined);
      const input = JSON.parse(options.messages[0].content[0].text);
      const out = await extract(input, signal);
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(out) } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } };
}

it('两个真实根会话按项目接续：用户约束与助手推断分开，服务重开仍能读取来源', async () => scene(async ({ org, f }) => {
  await capture(org, ['新会话要接续项目，不要全塞历史', { role: 'assistant', text: '建议维护一份有来源的项目摘要' }]);
  await update(org, input => ({ items: [item(input.messages[0].source, { kind: '约束', text: '只带有界项目摘要' }),
    item(input.messages[1].source, { id: 'suggestion', kind: '待验证', claim: '助手推断', state: '未知', text: '用来源索引维护摘要' })] }));
  const fresh = await newLead(org);
  const reopened = await Org.open(config(f));
  const frame = await reopened.projectBrief.read(fresh);
  assert.deepEqual(frame.条目.map(i => i.性质), ['用户表达', '助手推断']);
  assert.equal(frame.条目[0].来源[0].会话, LEAD.id);
  const detail = await reopened.projectBrief.read(fresh, { id: 'work' });
  assert.match(detail.条目[0].来源[0].原文, /不要全塞历史/);
  const file = await stat(org.projectBrief.file(P));
  assert.ok(file.isFile());
  if (process.platform !== 'win32') assert.equal(file.mode & 0o777, 0o600);
  assert.deepEqual((await reopened.projectBrief.read({ ...fresh, project: 'other' })).条目, []);
  await assert.rejects(reopened.projectBrief.read(spec(MEMBER)), { code: 'DENIED' });
}));

it('成功后才推进处理位置，失败及重启重试同一批；不重复调用已整理消息', async () => scene(async ({ org, f }) => {
  await capture(org, ['需要保留这个决定']);
  const before = await org.projectBrief.load(P);
  await assert.rejects(update(org, async () => { throw new Error('temporary'); }), /temporary/);
  assert.equal((await org.projectBrief.load(P)).sessions[0].processed, before.sessions[0].processed);
  const reopened = await Org.open(config(f)); let calls = 0;
  await update(reopened, input => { calls++; return simple(input); });
  await update(reopened, () => { calls++; throw Error('不应重做'); });
  assert.equal(calls, 1); assert.equal((await reopened.projectBrief.read(spec())).修订, 1);
}));

it('后续更正整体替换原理解，摘要不残留旧决定；新会话不需重述', async () => scene(async ({ org }) => {
  await capture(org, ['先做同会话回放']); await update(org, simple);
  await capture(org, ['纠正：重点是新会话接续同一项目工作']);
  await update(org, input => {
    assert.equal(input.previous[0].id, 'work');
    assert.equal(input.messages.length, 1);
    return { items: [item(input.messages[0].source, { text: '重点改为新会话接续同项目' })] };
  });
  const frame = await org.projectBrief.read(await newLead(org));
  assert.match(frame.条目[0].内容, /重点改为新会话/);
  assert.doesNotMatch(JSON.stringify(frame), /先做同会话/);
}));

it('引用伪造、助手冒充用户、未知字段和超预算候选被拒，水位不前进', async () => scene(async ({ org }) => {
  await capture(org, ['用户文本', { role: 'assistant', text: '助手建议' }]);
  const invalid = [input => ({ items: [item('fake')] }),
    input => ({ items: [item(input.messages[1].source)] }),
    input => ({ items: [item(input.messages[0].source, { text: 'x'.repeat(321) })] }),
    input => ({ items: [item(input.messages[0].source, { 认证: true })] }),
    input => ({ items: [item(input.messages[0].source)], promoted: true })];
  for (const extract of invalid) await assert.rejects(update(org, extract));
  assert.equal((await org.projectBrief.load(P)).sessions[0].processed, 0);
  assert.deepEqual((await org.projectBrief.read(spec())).条目, []);
}));

it('提炼期间来源被清空时拒绝旧结果，处理位置及旧摘要不会复活', async () => scene(async ({ org }) => {
  await capture(org, ['应撤回的秘密']);
  await assert.rejects(update(org, async input => {
    const pos = await org.turnBuffer.position(spec());
    await org.turnBuffer.forget({ ...spec(), throughSeq: pos.nextSeq });
    return simple(input);
  }), { code: 'PROJECT_BRIEF_SOURCE_CHANGED' });
  assert.deepEqual((await org.projectBrief.read(spec())).条目, []);
  assert.equal((await org.projectBrief.load(P)).sessions[0].processed, 0);
}));

it('已成摘要的来源替换/清空会退出读面并物理移除派生文本', async () => scene(async ({ org }) => {
  await capture(org, ['私人约束']); await update(org, input => ({ items: [item(input.messages[0].source, { text: '私人约束摘要' })] }));
  const pos = await org.turnBuffer.position(spec());
  await org.turnBuffer.forget({ ...spec(), throughSeq: pos.nextSeq });
  assert.deepEqual((await org.projectBrief.read(spec())).条目, []);
  await org.projectBrief.touch(spec());
  assert.doesNotMatch(await readFile(org.projectBrief.file(P), 'utf8'), /私人约束摘要/);
}));

it('项目清空使在途模型结果失效，已知及后发现的旧历史均不重提炼', async () => scene(async ({ org }) => {
  const oldTime = Date.now() - 10000;
  await capture(org, ['旧需求'], spec(), { time: oldTime });
  await assert.rejects(update(org, async input => { await org.projectBrief.forget(spec()); return simple(input); }), { code: 'PROJECT_BRIEF_CHANGED' });
  assert.equal((await update(org, () => { throw Error('旧源不应重做'); })).updated, false);
  const fresh = await newLead(org);
  await capture(org, ['后来补读的旧历史'], fresh, { time: oldTime });
  assert.equal((await update(org, () => { throw Error('旧历史不应复活'); }, fresh)).updated, false);
  await capture(org, ['清空后新的要求'], fresh, { time: Date.now() + 100 });
  assert.equal((await update(org, simple, fresh)).updated, true);
}));

it('来源到期退出新会话摘要，坏摘要文件拒绝使用且保留原文件', async () => scene(async ({ org }) => {
  await capture(org, ['短期资料']); await update(org, simple);
  org.clock._source = () => new Date(Date.now() + 31 * 86400000);
  assert.deepEqual((await org.projectBrief.read(spec())).条目, []);
  await writeFile(org.projectBrief.file(P), '{broken');
  await assert.rejects(org.projectBrief.read(spec()), { code: 'PROJECT_BRIEF_INVALID' });
  assert.equal(await readFile(org.projectBrief.file(P), 'utf8'), '{broken');
}));

it('中文长积压按实际UTF8预算缩批，仍能推进并报告剩余；只保留有界摘要', async () => scene(async ({ org }) => {
  await capture(org, Array.from({ length: 24 }, (_, i) => `${i}${'长'.repeat(2000)}`));
  let count;
  const result = await update(org, input => {
    count = input.messages.length;
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= PROJECT_BRIEF_LIMITS.input);
    return simple(input);
  });
  assert.ok(count > 0 && count < 24); assert.equal(result.pending, 24 - count);
  assert.ok(JSON.stringify(await org.projectBrief.read(spec())).length <= PROJECT_BRIEF_LIMITS.context + 200);
}));

it('正式目标暂停/终态覆盖旧模型待办，新装配不能把已暂停工作重新推进', async () => scene(async ({ org }) => {
  const goal = await org.goals.create({ subject: LEAD, 项目: P, 期望结果: '完成项目续聊', 来源: '用户要求', 完成依据: ['双会话接续'], 下一步: '实现' });
  await capture(org, ['实现项目续聊']);
  await update(org, input => ({ items: [item(input.messages[0].source, { goal: goal.id, kind: '待办' })] }));
  await org.goals.setState(goal.id, { subject: SOVEREIGN, 项目: P, 修订: goal.修订, 状态: '暂停' });
  assert.equal((await org.projectBrief.read(spec())).条目[0].状态, '暂停');
}));

it('已暂停事项没有新用户来源时禁止仅凭助手记录恢复为进行中', async () => scene(async ({ org }) => {
  await capture(org, ['先暂停']);
  await update(org, input => ({ items: [item(input.messages[0].source, { state: '暂停' })] }));
  await capture(org, [{ role: 'assistant', text: '我想继续做' }]);
  await assert.rejects(update(org, input => ({ items: [{ ...input.previous[0], state: '进行中' }] })), /新的用户来源/);
}));

it('公开LLM流无工具调用，完整文本停止才解析；模型错误不带私人原文', async () => {
  const input = { previous: [], messages: [], goals: [] };
  assert.deepEqual(await extractProjectBrief(llm(() => ({ items: [] })), { provider: 'p', model: 'm' }, input), { items: [] });
  for (const chunks of [
    [{ type: 'tool-call-delta', id: 'bad', name: 'rm' }],
    [{ type: 'block-end', index: 0, block: { type: 'text', text: '{"items":[]}' } }, { type: 'finish', reason: { kind: 'max-tokens' } }],
    [{ type: 'block-end', index: 0, block: { type: 'text', text: 'private-invalid-json' } }, { type: 'finish', reason: { kind: 'stop' } }],
  ]) {
    const model = { async prepareCall(config) { return { config, async *stream() { yield* chunks; } }; } };
    await assert.rejects(extractProjectBrief(model, { provider: 'p', model: 'm' }, input), error => error.code === 'PROJECT_BRIEF_MODEL_OUTPUT' && !error.message.includes('private-invalid-json'));
  }
});

it('真实内核轮末自动整理，不阻塞轮缓冲；新会话装配与工具查询接线齐全', async () => {
  const f = await makeFixture(); const cfg = { ...config(f), projectBindings: [{ path: process.cwd(), project: P }] }; const org = await shareOrg(cfg); const s = session();
  let release; const gate = new Promise(resolve => { release = resolve; }); let called;
  const started = new Promise(resolve => { called = resolve; });
  const model = llm(async input => { called(); await gate; return simple(input); });
  const query = { async observeSession() { return { source: 'live', header: s.header, inheritedEventCount: 0,
    cursor: s.seq - 1, events: s.events, [Symbol.dispose]() {} }; } };
  const host = fakeHost({ 服务: { llm: model, sessionQuery: query }, 提供服务: ['tools', 'commands', 'systemPrompt', 'llm', 'sessionQuery'] });
  try {
    await apply(host.ctx, cfg);
    for (const event of [s.append('turn/start', { turn: 1 }), s.append('user/message', { role: 'user', id: 'request', source: { kind: 'user' }, content: [{ type: 'text', text: '新会话继续项目' }] }, 'append'),
      s.append('turn/end', { turn: 1, reason: { kind: 'completed' } })]) host.触发('session/event', s, event);
    await org.turnBufferHooks.flush(); await started;
    assert.equal(org.projectBriefHooks.health().pending, 1);
    release(); await org.projectBriefHooks.flush();
    const fresh = await newLead(org); const next = session(fresh.session);
    const out = await injectProjectBrief(base(), { agent: { session: next }, org, hooks: org.projectBriefHooks, projectOf: () => P });
    assert.match(out.sections.find(s => s.name === PROJECT_BRIEF_SECTION).text, /新会话接续/);
    const action = await runAction({ org, 主体: fresh.subject, 项目: P, args: { action: 'project_brief_query', id: 'work' }, 宿主: { agent: { session: next }, project: P } });
    assert.equal(action.摘要.条目[0].来源[0].原文, '新会话继续项目');
    assert.ok(ACTIONS.includes('project_brief_query') && READ_ONLY_ACTIONS.includes('project_brief_query'));
    assert.ok(COMMAND_ONLY_ACTIONS.includes('project_brief_forget'));
    await assert.rejects(runAction({ org, 主体: fresh.subject, 项目: P, args: { action: 'project_brief_forget' }, 宿主: { agent: { session: next }, project: P } }), { code: 'DENIED' });
  } finally { release(); host.清理(); await org.projectBriefHooks.flush(); await org.turnBufferHooks.flush(); forgetSharedOrg(shareKey(cfg)); await f.cleanup(); }
});

it('成员、跨项目、卸载及身份变化时不装配旧接续段', async () => scene(async ({ org }) => {
  await capture(org, ['私人资料']); await update(org, simple);
  const hooks = createProjectBriefHooks({ org, projectOf: () => P });
  const stale = { sections: [{ name: PROJECT_BRIEF_SECTION, text: '旧私人资料' }] };
  const s = session(); s.header.origin = 'subagent';
  assert.deepEqual((await injectProjectBrief(stale, { agent: { session: s }, org, hooks, projectOf: () => P })).sections, []);
  assert.deepEqual((await injectProjectBrief(stale, { agent: { session: session() }, org, hooks, projectOf: () => 'other' })).sections, []);
  hooks.stop();
  assert.deepEqual((await injectProjectBrief(stale, { agent: { session: session() }, org, hooks, projectOf: () => P })).sections, []);
}));
