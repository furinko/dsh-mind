import { it } from 'node:test';
import assert from 'node:assert/strict';
import { renderContextFrame, contextPayload } from '../components/kernel/lib/context-frame.js';
import { projectMindRuntimeContext, retireMindRuntimeSnapshots, MIND_RUNTIME_RULES } from '../components/kernel/lib/runtime-context.js';
import { injectProfessionalContext, PROFESSIONAL_SECTION } from '../components/kernel/lib/professional-context.js';
import { injectLeadContext } from '../components/kernel/lib/lead-context.js';
import { injectInformationContext } from '../components/kernel/lib/information-hooks.js';
import { createMemoryUseHooks } from '../components/kernel/lib/memory-use-hooks.js';
import { createProfessionalReceipts } from '../components/kernel/lib/professional-receipts.js';
import { Org } from '../src/org.js';
import { makeFixture, LEAD } from './helpers.mjs';

const P = 'runtime-cache';
const base = () => ({ sections: [{ name: 'host', text: 'stable host rules' }], contexts: [{ name: 'host:cwd', text: 'workspace' }], tools: [], variables: {} });
const agentOf = (id = LEAD.id) => ({ session: { id, header: { cwd: process.cwd() }, surface: { nodes: [], replaceGeneration: 0 } } });
const section = (name, frame) => ({ name, text: `【资料】\nfixed instructions\n${renderContextFrame(name, frame)}` });
const runtime = sections => ({ role: 'user', source: { kind: 'runtime-context', sections }, content: [{ type: 'text', text: sections.map(s => s.text).join('\n\n') }] });
async function fixture(run) {
  const f = await makeFixture();
  const org = await Org.open({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
  try { await run(org); } finally { await org.memoryUseHooks?.flush(); await f.cleanup(); }
}
function sessionWith(messages) {
  const events = messages.map((message, seq) => ({ type: 'user/message', seq, data: message }));
  const nodes = events.map(e => e.seq); let replacements = 0;
  const session = { id: LEAD.id, header: { cwd: process.cwd() },
    get surface() { return { nodes: [...nodes], replaceGeneration: replacements }; },
    eventAt: seq => events[seq],
    append(type, data, intent) {
      const { startSeq, endSeq } = intent.surfaceOp;
      assert.equal(startSeq, endSeq);
      const index = nodes.indexOf(startSeq); assert.ok(index >= 0);
      const event = { type, seq: events.length, data };
      events.push(event); nodes.splice(index, 1, event.seq); replacements++;
      return event;
    },
  };
  return { session, events };
}

it('模型投影不改变原帧，内部水位变化不改文本，业务修订及工具参数仍保留', () => {
  const frame = { dataRevision: 1, paused: false, growth: [{ id: 'item', revision: 4, read: { dataRevision: 9 } }] };
  const before = structuredClone(frame);
  const first = renderContextFrame('mind:information-growth', frame);
  frame.dataRevision++;
  assert.equal(renderContextFrame('mind:information-growth', frame), first);
  assert.deepEqual(JSON.parse(first).growth, before.growth);
  assert.equal(frame.dataRevision, 2);
  frame.growth[0].revision++;
  assert.notEqual(renderContextFrame('mind:information-growth', frame), first);
  const buffer = { 轮次: [{ 消息: [{ 消息: 'm-1', 文本: 'restore me' }] }], 下次事件序号: 8, 数据版本: 'a' };
  assert.equal(renderContextFrame('mind:turn-buffer', buffer), renderContextFrame('mind:turn-buffer', { ...buffer, 下次事件序号: 200, 数据版本: 'b' }));
});

it('原生快照只带资料，固定指导留在system；相同资料不受对象键顺序影响', () => {
  const a = base(); a.sections.push(section(PROFESSIONAL_SECTION, { 项目: P, 知识: [{ id: 'k', revision: 2 }], 观察ID: 'nonce' }));
  const out = projectMindRuntimeContext(a);
  assert.deepEqual(out.sections, base().sections);
  assert.equal(out.contexts[1].interpolate, false);
  assert.doesNotMatch(out.contexts[1].text, /nonce|fixed instructions/);
  assert.match(MIND_RUNTIME_RULES, /最新完整快照替代/);
  assert.match(MIND_RUNTIME_RULES, /先核对方法/);
  assert.equal(renderContextFrame(PROFESSIONAL_SECTION, { 项目: P, 知识: [] }), renderContextFrame(PROFESSIONAL_SECTION, { 知识: [], 项目: P }));
  assert.equal(a.sections.length, 2);
});

it('兼容旧装配面；当前装配撤掉的段不会从传入旧contexts复活', () => {
  const legacy = { sections: [section(PROFESSIONAL_SECTION, { 知识: [] })] };
  assert.equal(projectMindRuntimeContext(legacy), legacy);
  const current = base(); current.contexts.push({ name: PROFESSIONAL_SECTION, text: 'stale secret' });
  assert.deepEqual(projectMindRuntimeContext(current), base());
});

it('真实专业与连续性召回重复装配保持模型文本一致；更正和失效及时生效', async () => fixture(async org => {
  const knowledge = await org.memory.remember({ subject: LEAD, 项目: P, 类: '知识', 岗位: 'Lead', 内容: 'stable recall', 来源: 'fixture' });
  const options = { agent: agentOf(), org, projectOf: () => P };
  const first = await injectProfessionalContext(base(), options);
  const second = await injectProfessionalContext(base(), options);
  assert.equal(first.sections.at(-1).text, second.sections.at(-1).text);
  assert.doesNotMatch(second.sections.at(-1).text, /观察ID|数据版本/);
  await org.memory.remember({ subject: LEAD, 项目: P, 类: '知识', 岗位: 'Lead', 内容: 'new knowledge', 来源: 'fixture' });
  const added = projectMindRuntimeContext(await injectProfessionalContext(base(), options));
  assert.deepEqual(added.sections, base().sections);
  assert.match(added.contexts.at(-1).text, /new knowledge/);
  await org.memory.invalidate(knowledge.id, { subject: LEAD, 原因: 'withdraw' });
  assert.doesNotMatch((await injectProfessionalContext(base(), options)).sections.at(-1).text, /stable recall/);
  await org.memory.remember({ subject: LEAD, 项目: P, 类: '偏好', 内容: 'concise conversation', 来源: 'fixture', 连续性: { 类别: '用户偏好', 主题: 'style', 依据: '明确表达', 范围: '部署' } });
  const one = await injectLeadContext(base(), options); const two = await injectLeadContext(base(), options);
  assert.equal(one.sections.at(-1).text, two.sections.at(-1).text);
}));

it('信息revision仍参与并发校验，但后台单独推进revision不触发模型资料更新', async () => {
  let revision = 1; let race = false;
  const frame = () => ({ dataRevision: revision, paused: false, growth: [{ id: 'interest', revision: 3 }] });
  const org = { information: { context: async () => frame(), authorize: async () => {}, load: async () => ({ revision: revision + (race ? 1 : 0) }) } };
  const opts = { org, agent: agentOf(), projectOf: () => P };
  const first = projectMindRuntimeContext(await injectInformationContext(base(), opts)); revision++;
  const second = projectMindRuntimeContext(await injectInformationContext(base(), opts));
  assert.deepEqual(second, first);
  race = true;
  assert.deepEqual(await injectInformationContext(base(), opts), base());
});

it('装配回执指纹对相同的实际资料稳定；当前读权核对保持生效', async () => fixture(async org => {
  const options = { agent: agentOf(), org, projectOf: () => P };
  const receipts = createProfessionalReceipts(options);
  let recorded;
  const capture = { begin: (...args) => receipts.begin(...args), record(...args) { receipts.record(...args); recorded = args.at(-1); } };
  const one = projectMindRuntimeContext(await injectProfessionalContext(base(), { ...options, receipts: capture }));
  assert.equal(recorded, one.contexts.at(-1).text);
  const first = recorded;
  await injectProfessionalContext(base(), { ...options, receipts: capture }); assert.equal(recorded, first);
}));

it('无nonce的观察按宿主会话隔离；无身份、辅助调用和用户引用均保持未知', async () => {
  const rows = []; const org = { memoryUse: { observe: async row => rows.push(row) } };
  const hooks = createMemoryUseHooks({ org, projectOf: () => P });
  const a = agentOf('a'); const b = agentOf('b');
  const frame = { 知识: [{ id: 'k' }], 岗位: 'Lead' };
  const s = section(PROFESSIONAL_SECTION, frame);
  hooks.recordAssembly(a, frame, s.text); hooks.recordAssembly(b, frame, s.text); await hooks.flush();
  const r = runtime([{ name: PROFESSIONAL_SECTION, text: contextPayload(s.text) }]);
  hooks.observeRequest({ messages: [r] });
  hooks.observeRequest({ sessionId: 'a', purpose: 'compaction', messages: [r] });
  hooks.observeRequest({ sessionId: 'a', messages: [{ ...r, source: { kind: 'user' } }] });
  await hooks.flush(); assert.equal(rows.filter(row => row.stage === 'request-observed').length, 0);
  const request = { sessionId: 'a', messages: [r] };
  hooks.observeRequest(request); hooks.observeRequest(request); await hooks.flush();
  assert.deepEqual(rows.filter(row => row.stage === 'request-observed').map(row => row.session), ['a']);
  assert.equal(new Set(rows.map(row => row.observation)).size, 2);
  assert.doesNotMatch(JSON.stringify(frame), /观察ID/);
});

it('旧快照仍在历史时，仅最新完整快照能证明当前资料进入请求', async () => {
  const rows = []; const hooks = createMemoryUseHooks({ org: { memoryUse: { observe: async row => rows.push(row) } }, projectOf: () => P });
  const agent = agentOf(); const frame = { 知识: [{ id: 'old' }], 岗位: 'Lead' }; const s = section(PROFESSIONAL_SECTION, frame);
  hooks.recordAssembly(agent, frame, s.text); await hooks.flush();
  const old = runtime([{ name: PROFESSIONAL_SECTION, text: contextPayload(s.text) }]);
  hooks.observeRequest({ sessionId: agent.session.id, messages: [old, runtime([{ name: 'host', text: 'cleared' }])] });
  await hooks.flush(); assert.equal(rows.filter(row => row.stage === 'request-observed').length, 0);
  hooks.observeRequest({ sessionId: agent.session.id, messages: [old] }); await hooks.flush();
  assert.equal(rows.filter(row => row.stage === 'request-observed').length, 1);
});

it('普通追加保留已有快照；知识撤销或更正清理旧自动资料并保留宿主上下文及原用户输入', () => {
  const old = { 项目: P, 岗位: 'Lead', 知识: [{ id: 'k', 版本摘要: 'old', 摘要: 'withdrawn secret' }] };
  const saved = { name: PROFESSIONAL_SECTION, text: contextPayload(section(PROFESSIONAL_SECTION, old).text) };
  const original = { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'original user words' }] };
  const { session, events } = sessionWith([original, runtime([{ name: 'host:cwd', text: 'workspace' }, saved])]);
  const next = base(); next.contexts.push({ ...saved, text: contextPayload(section(PROFESSIONAL_SECTION, { ...old, 知识: [...old.知识, { id: 'new' }] }).text) });
  retireMindRuntimeSnapshots(next, { session }); assert.equal(events.length, 2);
  next.contexts[1] = { ...saved, text: contextPayload(section(PROFESSIONAL_SECTION, { ...old, 知识: [{ id: 'k', 版本摘要: 'corrected', 摘要: 'new facts' }] }).text) };
  retireMindRuntimeSnapshots(next, { session });
  assert.equal(events.length, 3); assert.equal(events[0].data, original);
  assert.match(events.at(-1).data.content[0].text, /workspace/);
  assert.doesNotMatch(JSON.stringify(events.at(-1).data), /withdrawn secret/);
  assert.equal(session.surface.replaceGeneration, 1);
});

it('任务结束、身份失效或读取失败时，缺席段撤掉此前自动快照；损坏段也不能沿用', () => {
  for (const text of ['【资料】\n{"知识":[{"id":"old"}]}', 'malformed', '【资料】\n{"知识":123}']) {
    const { session, events } = sessionWith([runtime([{ name: PROFESSIONAL_SECTION, text }])]);
    retireMindRuntimeSnapshots(base(), { session });
    assert.equal(events.length, 2);
    assert.doesNotMatch(JSON.stringify(events.at(-1).data), /"id":"old"|malformed/);
  }
});
