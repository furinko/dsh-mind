import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readAcceptedExpression, EXPRESSION_EVENT_LIMIT, EXPRESSION_TEXT_LIMIT } from '../components/kernel/lib/accepted-expression.js';
import { injectLeadContext, LEAD_CONTEXT_SECTION } from '../components/kernel/lib/lead-context.js';
import { recallLeadContext } from '../src/lead-context.js';
import { Org } from '../src/org.js';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'accepted-expression';
const OTHER = { id: 'another-lead', kind: 'Lead' };
const config = f => ({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
async function scene(run) {
  const f = await makeFixture();
  try { const org = await Org.open(config(f)); await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: OTHER.id }); await run(org, f); }
  finally { await f.cleanup(); }
}
function session(id = LEAD.id, inherited = 0) {
  const rows = []; let nodes = [];
  return {
    id, header: { cwd: process.cwd() },
    get seq() { return rows.length; },
    get surface() { return { nodes: Object.freeze([...nodes]) }; },
    isOwnSeq: seq => seq >= inherited,
    eventAt: seq => rows[seq],
    append(type, data, surfaceOp) {
      const event = Object.freeze({ seq: rows.length, type, data: structuredClone(data), ...(surfaceOp ? { surfaceOp } : {}) });
      rows.push(event); if (surfaceOp === 'append') nodes.push(event.seq); return event;
    },
    shadow(seq) { nodes = nodes.filter(value => value !== seq); },
  };
}
const human = (text, extra = {}) => ({ id: 'human-message', role: 'user', source: { kind: 'user', rpcId: 'human-rpc' }, content: [{ type: 'text', text }], ...extra });
const start = (s, turn = 1) => s.append('turn/start', { turn });
const accept = (s, text, extra) => s.append('user/message', human(text, extra), 'append');
const goal = org => org.goals.create({ subject: LEAD, 项目: P, 期望结果: 'nebula', 完成依据: ['nebula'], 下一步: 'nebula', 来源: '隔离夹具转述' });
const lesson = (org, text, extra = {}) => org.memory.remember({ subject: LEAD, 项目: P, 类: '偏好', 内容: text, 来源: '隔离夹具', 连续性: { 类别: '协作教训', 主题: '协作方法', 依据: '自省', 范围: '部署' }, ...extra });
const assembly = () => ({ sections: [{ name: 'host:rules', text: 'host' }], tools: [] });
const recall = (org, s) => recallLeadContext({ org, subject: LEAD, project: P, readExpression: () => readAcceptedExpression(s) });
const inject = (org, s, extra = {}) => injectLeadContext(assembly(), { org, agent: { session: s }, projectOf: () => P, ...extra });
const frameOf = out => JSON.parse(out.sections.find(section => section.name === LEAD_CONTEXT_SECTION).text.split('\n').at(-1));

it('只读已接纳文本，首步领取中的消息不提前成为表达线索', () => {
  const s = session(); start(s);
  s.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [human('尚未接纳的秘密')] });
  s.append('agent/inbox/spliced', { target: 'next-turn', start: 0, removedCount: 1, inserted: [] });
  assert.equal(readAcceptedExpression(s), null);
  const event = accept(s, '发布之前核对回退路径');
  const out = readAcceptedExpression(s);
  assert.equal(out.query, '发布之前核对回退路径');
  assert.equal(out.description.事件序号, event.seq);
  assert.match(out.description.依据, /不认证原话、意图或授权/);
  assert.doesNotMatch(JSON.stringify(out.description), /秘密|发布|human-rpc/);
});

it('自动回报、工具、模型和未知来源排除，公开用户来源不额外要求RPC字段', () => {
  for (const source of [{ kind: 'plugin', plugin: 'runtime-context' }, { kind: 'tool' }, { kind: 'model' }, {}]) {
    const s = session(); start(s); accept(s, 'nebula', { source });
    assert.equal(readAcceptedExpression(s), null, JSON.stringify(source));
  }
  const s = session(); start(s); accept(s, 'nebula'); accept(s, 'ocean', { source: { kind: 'plugin', plugin: 'member-report' } });
  assert.equal(readAcceptedExpression(s).query, 'nebula');
  accept(s, '公开用户来源', { source: { kind: 'user' } });
  assert.equal(readAcceptedExpression(s).query, '公开用户来源');
});

it('轮次结束、下一轮和继承历史均不复用上一轮的人类线索', () => {
  const s = session(); start(s); accept(s, 'nebula'); s.append('turn/end', { turn: 1 });
  assert.equal(readAcceptedExpression(s), null); start(s, 2); assert.equal(readAcceptedExpression(s), null);
  accept(s, 'ocean'); assert.equal(readAcceptedExpression(s).description.轮次, 2);
  const fork = session('fork', 2); start(fork); accept(fork, 'parent-private-text'); assert.equal(readAcceptedExpression(fork), null);
});

it('改写接纳消息只用实际入账文本，新领取消息不会续用旧表达', () => {
  const s = session(); start(s); accept(s, 'nebula');
  s.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [] });
  assert.equal(readAcceptedExpression(s), null);
  accept(s, 'ocean', { id: 'rewritten-message' }); assert.equal(readAcceptedExpression(s).query, 'ocean');
  s.append('agent/inbox/spliced', { target: 'next-step', start: 0, removedCount: 1, inserted: [], outcome: 'canceled' });
  assert.equal(readAcceptedExpression(s).query, 'ocean');
});

it('最新输入无可用文本时不捞回旧文字，图片、推理和工具块不进入查询', () => {
  const s = session(); start(s); accept(s, 'nebula');
  accept(s, '', { id: 'mixed', content: [{ type: 'image', url: 'private-image' }, { type: 'reasoning', text: 'private-thinking' }, { type: 'text', text: 'ocean' }, { type: 'tool-result', content: 'private-result' }] });
  assert.equal(readAcceptedExpression(s).query, 'ocean');
  accept(s, '', { id: 'image-only', content: [{ type: 'image', url: 'private-image' }] });
  assert.equal(readAcceptedExpression(s), null);
});

it('只检查有界事件和文本块，不全量读取历史；过旧或坏能力保留未知', () => {
  const s = session(); start(s);
  accept(s, '', { content: [{ type: 'text', text: '中'.repeat(20000) }, ...Array.from({ length: 70 }, () => ({ type: 'text', text: '后续' }))] });
  const out = readAcceptedExpression(s); assert.equal(out.query.length, EXPRESSION_TEXT_LIMIT); assert.equal(out.description.截断, true);
  let reads = 0; const old = s.eventAt; s.eventAt = seq => { reads++; return old(seq); };
  for (let i = 0; i < EXPRESSION_EVENT_LIMIT; i++) s.append('assistant/chunk', {});
  assert.equal(readAcceptedExpression(s), null); assert.equal(reads, EXPRESSION_EVENT_LIMIT);
  for (const bad of [{}, { id: LEAD.id, seq: 1, eventAt() { throw new Error('private details'); }, isOwnSeq: () => true }]) assert.equal(readAcceptedExpression(bad), null);
});

it('压缩或替换后已不在模型表面的旧原文不重新召回', () => {
  const s = session(); start(s); const event = accept(s, 'nebula');
  assert.ok(readAcceptedExpression(s)); s.shadow(event.seq); assert.equal(readAcceptedExpression(s), null);
});

it('同轮后续装配按已接纳中文表达检索教训，旧目标不挤入，人格与偏好保留', async () => scene(async org => {
  await goal(org); await lesson(org, 'nebula workflow');
  const useful = await lesson(org, '发布之前核对回退路径');
  const persona = await lesson(org, '保持好奇心', { 连续性: { 类别: '人格', 主题: '人格', 依据: '自省', 范围: '部署' } });
  const s = session(); start(s); accept(s, '发布之前核对回退路径');
  const out = frameOf(await inject(org, s));
  assert.equal(out.焦点线索.类型, '已接纳用户来源文本');
  assert.deepEqual(new Set(out.记录.map(item => item.id)), new Set([useful.id, persona.id]));
  assert.doesNotMatch(JSON.stringify(out), /nebula/);
}));

it('首步、缺SDK读能力时保持目标召回；有文本但零命中不回填旧目标或近期教训', async () => scene(async org => {
  await goal(org); const old = await lesson(org, 'nebula workflow');
  const s = session(); start(s);
  assert.deepEqual((await recall(org, s)).记录.map(item => item.id), [old.id]);
  assert.deepEqual(frameOf(await inject(org, { id: LEAD.id, header: s.header })).记录.map(item => item.id), [old.id]);
  accept(s, 'totallyunmatched'); assert.equal((await recall(org, s)).记录.length, 0);
  assert.deepEqual((await inject(org, s)).sections, assembly().sections);
}));

it('无需先建目标，已接纳表达也能检索相关协作教训', async () => scene(async org => {
  const useful = await lesson(org, 'ocean workflow'); await lesson(org, 'nebula unrelated');
  const s = session(); start(s); accept(s, 'ocean');
  assert.deepEqual((await recall(org, s)).记录.map(item => item.id), [useful.id]);
}));

it('读取过程中新增表达、结束轮次或撤下原文时清除旧帧', async () => {
  for (const change of [s => accept(s, 'ocean', { id: 'new-human' }), s => s.append('turn/end', { turn: 1 }), s => s.shadow(1)]) {
    await scene(async org => {
      await lesson(org, 'nebula workflow'); const s = session(); start(s); accept(s, 'nebula');
      const query = org.memory.query.bind(org.memory); let first = true;
      org.memory.query = async args => { const out = await query(args); if (first) { first = false; change(s); } return out; };
      assert.deepEqual((await inject(org, s)).sections, assembly().sections);
    });
  }
});

it('相同会话id换了实际Session对象也不提交旧帧，成员不读取私人输入', async () => scene(async org => {
  await lesson(org, 'nebula workflow'); const s = session(); start(s); accept(s, 'nebula'); const agent = { session: s };
  const query = org.memory.query.bind(org.memory); let first = true;
  org.memory.query = async args => { const out = await query(args); if (first) { first = false; agent.session = session(); } return out; };
  assert.deepEqual((await inject(org, s, { agent })).sections, assembly().sections);
  const child = session(MEMBER.id); child.header.origin = 'subagent'; start(child); accept(child, 'private-child-input'); let reads = 0; child.eventAt = () => { reads++; throw new Error('must not read'); };
  assert.deepEqual((await inject(org, child)).sections, assembly().sections); assert.equal(reads, 0);
}));

it('领域召回已完成但适配器尚未提交时，迟到的新消息仍会撤下旧帧', async () => scene(async org => {
  await lesson(org, 'nebula workflow'); const s = session(); start(s); accept(s, 'nebula');
  const eventAt = s.eventAt; let boundaries = 0;
  s.eventAt = seq => {
    const event = eventAt(seq);
    if (event.type === 'turn/start' && ++boundaries === 2) queueMicrotask(() => accept(s, 'ocean', { id: 'late-message' }));
    return event;
  };
  assert.deepEqual((await inject(org, s)).sections, assembly().sections);
}));

it('真实内核装配按各自Session取表达，不跨Lead或项目串用，也不加消息钩子', async () => scene(async (org, f) => {
  const a = await lesson(org, 'nebula workflow'); const b = await lesson(org, 'ocean workflow');
  const host = fakeHost();
  try {
    await kernel.apply(host.ctx, { ...config(f), projectBindings: [{ path: process.cwd(), project: P }] });
    assert.equal(host.钩子.has('agent/pre-step'), false); assert.equal(host.钩子.has('agent/inbox/claimed'), false);
    const hook = host.钩子.get('system-prompt/assemble').at(-1);
    for (const [who, word, expected] of [[LEAD, 'nebula', a.id], [OTHER, 'ocean', b.id]]) {
      const s = session(who.id); start(s); accept(s, word); const base = assembly();
      const out = await hook(base, { agent: { session: s } }, async () => base);
      assert.deepEqual(frameOf(out).记录.map(item => item.id), [expected]);
      assert.equal(frameOf(out).焦点线索.会话, who.id);
    }
    const local = await lesson(org, 'quartz-project-private', { 连续性: { 类别: '协作教训', 主题: '项目教训', 依据: '自省', 范围: '项目' } });
    const s = session(); start(s); accept(s, 'quartz-project-private');
    assert.deepEqual(frameOf(await inject(org, s)).记录.map(item => item.id), [local.id]);
    assert.deepEqual((await inject(org, s, { projectOf: () => 'another-project' })).sections, assembly().sections);
  } finally { host.清理(); }
}));

it('表达只作临时查询，不向目标/记忆账本复制聊天或追加自动偏好', async () => scene(async (org, f) => {
  await goal(org); await lesson(org, 'nebula workflow'); const s = session(); start(s); accept(s, 'nebula');
  const paths = [f.layout.goalLog(P), f.layout.memoryLog('跨项目', '偏好')];
  const before = await Promise.all(paths.map(path => readFile(path, 'utf8'))); const seq = s.seq;
  await inject(org, s);
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path, 'utf8'))), before); assert.equal(s.seq, seq);
}));
