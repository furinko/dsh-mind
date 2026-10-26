import { it } from 'node:test';
import assert from 'node:assert/strict';
import { Org } from '../src/org.js';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';
import { injectLeadContext } from '../components/kernel/lib/lead-context.js';
import { injectProjectBrief } from '../components/kernel/lib/project-brief-hooks.js';
import { projectMindRuntimeContext } from '../components/kernel/lib/runtime-context.js';
import { renderContextFrame } from '../components/kernel/lib/context-frame.js';
import { shareOrg, forgetSharedOrg, shareKey } from '../src/runtime.js';
import { apply } from '../components/kernel/lib/index.js';
import { fakeHost } from './host-harness.mjs';

const P = 'runtime-chat';
const base = () => ({ sections: [{ name: 'host', text: 'stable host' }], contexts: [] });
const hooks = { health: () => ({ enabled: true, stopped: false }), schedule() {} };
async function scene(run) {
  const f = await makeFixture();
  const org = await Org.open({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
  try { await run(org); } finally { await org.observability.flush(); await f.cleanup(); }
}
function session(id = LEAD.id) {
  const events = []; let nodes = [];
  return { id, header: { id, cwd: process.cwd() }, events, inheritedEventCount: 0,
    get seq() { return events.length; }, get surface() { return { nodes: [...nodes] }; },
    isOwnSeq: seq => seq >= 0 && seq < events.length, eventAt: seq => events[seq],
    append(type, data, surfaceOp) {
      const event = { seq: events.length, type, data, time: Date.now(), ...(surfaceOp ? { surfaceOp } : {}) };
      events.push(event); if (surfaceOp === 'append') nodes.push(event.seq); return event;
    },
    hide(seq) { nodes = nodes.filter(n => n !== seq); },
  };
}
async function accept(org, s, text, turn) {
  const fromSeq = s.seq, time = Date.now();
  s.append('turn/start', { turn });
  const message = s.append('user/message', { id: `${s.id}-${turn}`, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }, 'append');
  await org.turnBuffer.capture({ subject: { id: s.id, kind: 'Lead' }, project: P, session: s.id, fromSeq, throughSeq: s.seq, records: [
    { seq: fromSeq, type: 'turn/start', turn, time },
    { seq: message.seq, type: 'message', turn, role: 'user', text, id: message.data.id, time, clipped: false, interrupted: false },
  ] });
  await org.projectBrief.touch({ subject: { id: s.id, kind: 'Lead' }, project: P, session: s.id });
  return message;
}
const preference = org => org.memory.remember({ subject: LEAD, 项目: P, 类: '偏好', 内容: '表达简短', 来源: 'synthetic fixture',
  连续性: { 类别: '用户偏好', 主题: '表达', 依据: '明确表达', 范围: '部署' } });
async function assemble(org, s) {
  const options = { org, agent: { session: s }, projectOf: () => P, hooks };
  return projectMindRuntimeContext(await injectProjectBrief(await injectLeadContext(base(), options), options));
}

it('已有偏好和真实接纳消息：跨轮普通聊天不因焦点元数据或已可见待整理原文刷新完整投影', async () => scene(async org => {
  await preference(org); const s = session(); let first;
  for (let turn = 1; turn <= 8; turn++) {
    await accept(org, s, turn % 2 ? '今天聊聊' : '换一句无关闲聊', turn);
    const out = await assemble(org, s);
    assert.ok(out.contexts.some(c => c.name === 'mind:lead-continuity'));
    assert.ok(!out.contexts.some(c => c.name === 'mind:project-brief'));
    if (first) assert.deepEqual(out, first); else first = out;
    const frame = JSON.parse(out.contexts[0].text.split('\n').at(-1));
    assert.ok(!Object.hasOwn(frame, '焦点线索'));
  }
}));

it('内核完整装配链：有偏好、有待整理消息、连续八轮真实用户事件不因流水元数据追加新资料', async () => {
  const f = await makeFixture();
  const cfg = { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P,
    projectBindings: [{ path: process.cwd(), project: P }] };
  const org = await shareOrg(cfg), s = session();
  const query = { async observeSession() { return { source: 'live', header: s.header, inheritedEventCount: 0,
    cursor: s.seq - 1, events: [...s.events], [Symbol.dispose]() {} }; } };
  const host = fakeHost({ 服务: { sessionQuery: query }, 提供服务: ['tools', 'commands', 'systemPrompt', 'sessionQuery'] });
  try {
    await preference(org); await apply(host.ctx, cfg);
    const hook = host.钩子.get('system-prompt/assemble').at(-1);
    let first;
    for (let turn = 1; turn <= 8; turn++) {
      s.append('turn/start', { turn });
      s.append('user/message', { id: `kernel-message-${turn}`, role: 'user', source: { kind: 'user' },
        content: [{ type: 'text', text: `普通闲聊第${turn}句` }] }, 'append');
      const input = base(), out = await hook(input, { agent: { session: s } }, async () => input);
      assert.ok(out.contexts.some(c => c.name === 'mind:lead-continuity'));
      assert.ok(out.contexts.some(c => c.name === 'mind:information-growth'));
      assert.ok(!out.contexts.some(c => c.name === 'mind:project-brief'));
      if (first) assert.deepEqual(out, first); else first = out;
      s.append('turn/end', { turn, reason: { kind: 'completed' } });
    }
  } finally {
    host.清理(); await org.turnBufferHooks?.flush(); await org.projectBriefHooks?.flush();
    await org.observability.flush(); forgetSharedOrg(shareKey(cfg)); await f.cleanup();
  }
});

it('当前可见原文不挤掉压缩后缺失的更正；查询默认仍返回完整待整理索引', async () => scene(async org => {
  const s = session(); const correction = await accept(org, s, '更正：取消旧方案', 1); s.hide(correction.seq);
  for (let turn = 2; turn <= 7; turn++) await accept(org, s, `可见闲聊${turn}`, turn);
  const spec = { subject: LEAD, project: P, session: s.id };
  const queried = await org.projectBrief.read(spec);
  assert.equal(queried.待整理用户表达.length, 4);
  const out = await assemble(org, s);
  const frame = JSON.parse(out.contexts.find(c => c.name === 'mind:project-brief').text.split('\n').at(-1));
  assert.deepEqual(frame.待整理用户表达.map(m => m.文本), ['更正：取消旧方案']);
  assert.ok(!Object.hasOwn(frame, '待整理消息数'));
  assert.ok(!Object.hasOwn(frame, '摘要待更新'));
  await accept(org, s, '又一条可见闲聊', 8);
  assert.deepEqual(await assemble(org, s), out);
}));

it('跨会话相同序号不被本会话可见节点误过滤；缺少表面能力时保留补充原文', async () => scene(async org => {
  const other = { id: 'other-lead', kind: 'Lead' };
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: other.id });
  for (const id of [LEAD.id, other.id]) {
    const state = await org.information.load();
    await org.information.admin({ subject: SOVEREIGN, project: P }, { op: 'relationship', expectedRevision: state.configRevision, session: id, relationship: 'fixture-same-human' });
  }
  const a = session(), b = session(other.id);
  await accept(org, b, '另一会话的新约束', 1); await accept(org, a, '当前已可见', 1);
  const out = await assemble(org, a);
  const frame = JSON.parse(out.contexts.find(c => c.name === 'mind:project-brief').text.split('\n').at(-1));
  assert.deepEqual(frame.待整理用户表达.map(m => m.文本), ['另一会话的新约束']);
  const legacy = { id: a.id, header: a.header, seq: a.seq, isOwnSeq: a.isOwnSeq };
  const fallback = await assemble(org, legacy);
  assert.match(fallback.contexts.find(c => c.name === 'mind:project-brief').text, /当前已可见/);
}));

it('相关教训、偏好撤回与新摘要仍更新投影', async () => scene(async org => {
  const pref = await preference(org); const s = session(); await accept(org, s, 'nebula', 1);
  const before = await assemble(org, s);
  await org.memory.remember({ subject: LEAD, 项目: P, 类: '偏好', 内容: 'nebula先核对条件', 来源: 'synthetic fixture',
    连续性: { 类别: '协作教训', 主题: 'nebula', 依据: '自省', 范围: '部署' } });
  assert.notDeepEqual(await assemble(org, s), before);
  await accept(org, s, '完全无关的另一话题', 2);
  const changed = await assemble(org, s);
  assert.doesNotMatch(changed.contexts.find(c => c.name === 'mind:lead-continuity').text, /nebula先核对条件/);
  await org.memory.invalidate(pref.id, { subject: LEAD, 原因: 'fixture withdraw' });
  assert.ok(!(await assemble(org, s)).contexts.some(c => c.name === 'mind:lead-continuity'));
  // End the synthetic source round so the real summarizer can process it.
  const end = s.append('turn/end', { turn: 2, reason: { kind: 'completed' } });
  await org.turnBuffer.capture({ subject: LEAD, project: P, session: s.id, fromSeq: end.seq, throughSeq: s.seq,
    records: [{ seq: end.seq, type: 'turn/end', turn: 2, reason: 'completed', time: Date.now() }] });
  await org.projectBrief.touch({ subject: LEAD, project: P, session: s.id });
  await org.projectBrief.update({ subject: LEAD, project: P, session: s.id }, { extract: async input => ({ items: [{
    id: 'new', kind: '约束', claim: '用户表达', state: '进行中', text: '真实新摘要', sources: [input.messages.find(m => m.role === 'user').source],
  }] }) });
  const summarized = await assemble(org, s);
  const brief = summarized.contexts.find(c => c.name === 'mind:project-brief');
  assert.match(brief.text, /真实新摘要/);
  for (let turn = 3; turn <= 5; turn++) {
    await accept(org, s, `摘要整理期间的可见闲聊${turn}`, turn);
    assert.deepEqual((await assemble(org, s)).contexts.find(c => c.name === 'mind:project-brief'), brief);
  }
}));

it('首步缺表达和接纳后查询线索切换不单独改写投影；原帧保持完整', () => {
  const frame = { 项目: P, 记录: [{ id: 'pref', 摘要: '相同资料' }], 焦点线索: { 目标: 'goal', 修订: 1 } };
  const raw = structuredClone(frame);
  const first = renderContextFrame('mind:lead-continuity', frame);
  assert.deepEqual(frame, raw);
  frame.焦点线索 = { 类型: '已接纳用户来源文本', 轮次: 2, 事件序号: 10, 消息: 'new-message' };
  assert.equal(renderContextFrame('mind:lead-continuity', frame), first);
  frame.焦点线索 = null;
  assert.equal(renderContextFrame('mind:lead-continuity', frame), first);
});

it('项目接续读取期间表面撤下消息或会话前进时丢弃旧投影', async () => scene(async org => {
  for (const change of ['surface', 'seq']) {
    const s = session(); const message = await accept(org, s, '待核对更正', change === 'surface' ? 1 : 2);
    const read = org.projectBrief.read.bind(org.projectBrief);
    org.projectBrief.read = async (...args) => {
      const frame = await read(...args);
      if (change === 'surface') s.hide(message.seq); else s.append('turn/end', { turn: 2 });
      return frame;
    };
    try { assert.ok(!(await assemble(org, s)).contexts.some(c => c.name === 'mind:project-brief')); }
    finally { org.projectBrief.read = read; }
  }
}));
