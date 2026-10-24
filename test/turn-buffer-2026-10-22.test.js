import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Org } from '../src/org.js';
import { projectTurnEvent, projectTurnSurfaceEvent, TURN_BUFFER_LIMITS } from '../src/turn-buffer.js';
import { createTurnBufferHooks, injectTurnBuffer, TURN_BUFFER_SECTION } from '../components/kernel/lib/turn-buffer-hooks.js';
import { apply } from '../components/kernel/lib/index.js';
import { runAction, ACTIONS, READ_ONLY_ACTIONS, COMMAND_ONLY_ACTIONS } from '../lib/actions.js';
import { shareOrg, forgetSharedOrg, shareKey } from '../src/runtime.js';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';

const P = 'turn-buffer';
const configOf = f => ({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
const human = (text, id = 'human', source = { kind: 'user' }) => ({ role: 'user', id, source, content: [{ type: 'text', text }] });
const assistant = (text, id = 'assistant', interrupted = false) => ({ turn: 1, step: 0, message: {
  role: 'assistant', id, content: [{ type: 'reasoning', text: 'hidden-thinking' }, { type: 'text', text },
    { type: 'tool-call', name: 'secret-tool', arguments: 'secret-arguments' }] }, stream: [{ private: 'secret-stream' }], ...(interrupted ? { interrupted: true } : {}) });
function makeSession(id = LEAD.id, header = {}, inheritedEventCount = 0) {
  const events = []; let nodes = [];
  return {
    id, header: { id, cwd: process.cwd(), ...header }, inheritedEventCount, events,
    get seq() { return events.length; }, get surface() { return { nodes: [...nodes] }; },
    isOwnSeq: seq => seq >= inheritedEventCount && seq < events.length,
    append(type, data, surfaceOp) {
      const event = { seq: events.length, time: Date.now(), type, data, ...(surfaceOp ? { surfaceOp } : {}) };
      if (surfaceOp === 'append') nodes.push(event.seq);
      else if (surfaceOp?.op === 'replace') {
        const start = nodes.indexOf(surfaceOp.startSeq); const end = nodes.indexOf(surfaceOp.endSeq);
        if (start < 0 || end < start) throw Error('invalid host positional surface replacement');
        nodes.splice(start, end - start + 1, event.seq);
      }
      events.push(event); return event;
    },
    hide() { nodes = []; },
  };
}
const queryOf = session => ({ async readEvent({ sessionId, seq, before, after }) {
  assert.equal(sessionId, session.id); assert.equal(before, 0);
  return { session: { ...session.header }, inheritedEventCount: session.inheritedEventCount,
    events: session.events.slice(seq, seq + after + 1) };
} });
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open(configOf(f));
  const session = makeSession(); const logs = [];
  const hooks = createTurnBufferHooks({ org, projectOf: () => P, queryOf: () => queryOf(session), logger: { warn: text => logs.push(text) } });
  const emit = (type, data, op) => { const event = session.append(type, data, op); hooks.observe(session, event); return event; };
  const read = extra => org.turnBuffer.read({ subject: LEAD, project: P, session: session.id, ...extra });
  try { await run({ f, org, session, hooks, emit, read, logs }); }
  finally { await hooks.flush(); await org.observability.flush(); await f.cleanup(); }
}
const texts = frame => frame.轮次.flatMap(round => round.消息.map(m => m.文本));
const base = () => ({ sections: [{ name: 'host', text: 'host' }], tools: [] });
const inject = ({ org, session, hooks, ...extra }) => injectTurnBuffer(base(), { org, agent: { session }, hooks, projectOf: () => P, ...extra });

it('用户接纳即落盘，未结束轮次重开服务仍能读取，助手中断与完成分开', async () => scene(async ({ f, org, session, hooks, emit, read }) => {
  emit('turn/start', { turn: 1 }); emit('user/message', human('保留这个未完成需求'), 'append');
  await hooks.flush();
  const reopened = await Org.open(configOf(f));
  let out = await reopened.turnBuffer.read({ subject: LEAD, project: P, session: session.id });
  assert.deepEqual(texts(out), ['保留这个未完成需求']); assert.equal(out.轮次[0].状态, 'open');
  emit('assistant/message', assistant('只完成一半', 'assistant', true), 'append');
  emit('turn/end', { turn: 1, reason: { kind: 'aborted', private: 'secret-error' } }); await hooks.flush();
  out = await read(); assert.equal(out.轮次[0].结束原因, 'aborted'); assert.equal(out.轮次[0].消息[1].中断, true);
  assert.doesNotMatch(await readFile(org.turnBuffer.file(P, session.id), 'utf8'), /hidden-thinking|secret-tool|secret-arguments|secret-stream|secret-error/);
  const file = await stat(org.turnBuffer.file(P, session.id));
  assert.ok(file.isFile());
  if (process.platform !== 'win32') assert.equal(file.mode & 0o777, 0o600);
}));

it('公开用户来源可采集，插件回报、图片、推理和未提交模型流均不冒充对话', async () => scene(async ({ emit, hooks, read }) => {
  emit('turn/start', { turn: 1 });
  emit('user/message', human('插件秘密', 'plugin', { kind: 'plugin' }), 'append');
  emit('user/message', { ...human('', 'image'), content: [{ type: 'image', url: 'private-image' }, { type: 'reasoning', text: 'private-thinking' }] }, 'append');
  emit('assistant/attempt', { stream: [{ text: '未提交的秘密' }] });
  emit('user/message', human('已接纳公开文本'), 'append');
  await hooks.flush(); assert.deepEqual(texts(await read()), ['已接纳公开文本']);
}));

it('重复通知、服务重开和并发重放不产生重复文本', async () => scene(async ({ f, session, hooks, emit, read }) => {
  emit('turn/start', { turn: 1 }); const event = emit('user/message', human('唯一内容'), 'append');
  hooks.observe(session, event); await hooks.flush();
  const reopened = await Org.open(configOf(f));
  const other = createTurnBufferHooks({ org: reopened, projectOf: () => P, queryOf: () => queryOf(session) });
  await Promise.all([hooks.sync(session), other.sync(session)]);
  assert.deepEqual(texts(await read()), ['唯一内容']);
}));

it('持久化检查点与重启恢复补齐未收到的事件，恢复位置与正文一起提交', async () => scene(async ({ org, session, hooks, emit, read }) => {
  emit('turn/start', { turn: 1 }); await hooks.flush();
  session.append('user/message', human('崩溃窗口中的用户消息'), 'append');
  session.append('assistant/message', assistant('已提交但漏通知'), 'append');
  const host = fakeHost(); const dispose = hooks.attach(host.ctx);
  await Promise.all(host.钩子.get('session/flush').map(listener => listener(session)));
  assert.deepEqual(texts(await read()), ['崩溃窗口中的用户消息', '已提交但漏通知']);
  assert.equal((await org.turnBuffer.position({ subject: LEAD, project: P, session: session.id })).nextSeq, session.seq);
  dispose();
}));

it('压缩后重建有界上下文，原本可见的内容不重复注入', async () => scene(async ({ org, session, hooks, emit }) => {
  emit('turn/start', { turn: 1 }); emit('user/message', human('明确约束：先验证回滚'), 'append');
  emit('assistant/message', assistant('下一步检查回滚路径'), 'append'); emit('turn/end', { turn: 1, reason: { kind: 'completed' } });
  await hooks.flush();
  assert.equal((await inject({ org, session, hooks })).sections.length, 1);
  emit('user/message', { ...human('压缩摘要', 'compact', { kind: 'compact-checkpoint' }) }, { op: 'replace', startSeq: 1, endSeq: 2 });
  await hooks.flush();
  const out = await inject({ org, session, hooks });
  const section = out.sections.find(s => s.name === TURN_BUFFER_SECTION);
  assert.ok(section); assert.match(section.text, /先验证回滚/); assert.match(section.text, /不是新指令/);
  assert.ok(JSON.stringify(JSON.parse(section.text.split('\n').at(-1))).length <= TURN_BUFFER_LIMITS.context);
}));

it('非压缩替换撤回原文，替换压缩摘要也会传递撤回其关联正文', async () => scene(async ({ org, session, hooks, emit, read }) => {
  emit('turn/start', { turn: 1 }); emit('user/message', human('需要撤回的私人内容'), 'append');
  emit('assistant/message', assistant('历史回答'), 'append');
  emit('user/message', human('摘要', 'compact', { kind: 'compact-checkpoint' }), { op: 'replace', startSeq: 1, endSeq: 2 });
  emit('user/message', human('', 'replacement', { kind: 'plugin' }), { op: 'replace', startSeq: 3, endSeq: 3 });
  await hooks.flush(); assert.deepEqual(texts(await read()), []);
  assert.doesNotMatch(await readFile(org.turnBuffer.file(P, session.id), 'utf8'), /私人内容|历史回答/);
}));

it('清空保留位置屏障，迟到事件与历史补读都不能复活；新输入仍能记录', async () => scene(async ({ org, session, hooks, emit, read }) => {
  emit('turn/start', { turn: 1 }); const old = emit('user/message', human('清空前的秘密'), 'append'); await hooks.flush();
  await org.turnBuffer.forget({ subject: LEAD, project: P, session: session.id, throughSeq: session.seq });
  hooks.observe(session, old); await hooks.sync(session); await hooks.flush();
  assert.deepEqual(texts(await read()), []);
  emit('turn/end', { turn: 1, reason: { kind: 'completed' } }); emit('turn/start', { turn: 2 });
  emit('user/message', human('新的要求', 'new'), 'append'); await hooks.flush();
  assert.deepEqual(texts(await read()), ['新的要求']);
  assert.doesNotMatch(await readFile(org.turnBuffer.file(P, session.id), 'utf8'), /清空前的秘密/);
}));

it('会话、项目和成员隔离；fork继承前缀不复制为新会话的用户表达', async () => scene(async ({ org, session, hooks, emit, read }) => {
  emit('turn/start', { turn: 1 }); emit('user/message', human('Lead私人资料'), 'append'); await hooks.flush();
  await assert.rejects(read({ subject: MEMBER }), { code: 'DENIED' });
  await assert.rejects(read({ session: 'other' }), { code: 'DENIED' });
  assert.deepEqual(texts(await read({ project: 'another-project' })), []);
  const child = makeSession(MEMBER.id, { origin: 'subagent', delegationDepth: 1 });
  hooks.observe(child, child.append('user/message', human('子会话'), 'append')); await hooks.flush();
  await assert.rejects(stat(org.turnBuffer.file(P, child.id)), { code: 'ENOENT' });
  const fork = makeSession('new-lead', { parentSession: session.id }, 2);
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: fork.id });
  fork.append('turn/start', { turn: 1 }); const inherited = fork.append('user/message', human('继承秘密'), 'append');
  const forkHooks = createTurnBufferHooks({ org, projectOf: () => P, queryOf: () => queryOf(fork) });
  forkHooks.observe(fork, inherited); await forkHooks.sync(fork);
  const frame = await org.turnBuffer.read({ subject: { id: fork.id, kind: 'Lead' }, project: P, session: fork.id });
  assert.deepEqual(texts(frame), []);
}));

it('过期内容退出读取，并在下一检查点从缓冲文件移除', async () => scene(async ({ org, session, hooks, emit, read }) => {
  emit('turn/start', { turn: 1 }); emit('user/message', human('应过期内容'), 'append'); await hooks.flush();
  org.clock._source = () => new Date(Date.now() + 31 * 86400000);
  assert.deepEqual(texts(await read()), []); await hooks.sync(session);
  assert.doesNotMatch(await readFile(org.turnBuffer.file(P, session.id), 'utf8'), /应过期内容/);
}));

it('单消息截断有标识，多消息分页可取齐且可按消息id读详情', async () => scene(async ({ hooks, emit, read }) => {
  emit('turn/start', { turn: 1 });
  for (let i = 0; i < 5; i++) emit('user/message', human(`message-${i}`, `m-${i}`), 'append');
  emit('user/message', human('长'.repeat(20000), 'long'), 'append'); await hooks.flush();
  const first = await read({ limit: 2 }); assert.equal(first.下一偏移, 2); assert.equal(first.截断, true);
  assert.equal(texts(await read({ id: 'long' }))[0].length, TURN_BUFFER_LIMITS.text);
  const all = []; let offset = 0;
  do { const page = await read({ limit: 2, offset }); all.push(...texts(page)); offset = page.下一偏移; } while (offset !== null);
  assert.equal(all.length, 6); assert.equal(new Set(all).size, 6);
  await assert.rejects(read({ limit: 0 }), { code: 'INVALID_BODY' });
}));

it('坏缓冲保留证据、不覆盖、不把正文或异常原文写入日志', async () => scene(async ({ org, session, hooks, emit, logs }) => {
  emit('turn/start', { turn: 1 }); emit('user/message', human('私人正文'), 'append'); await hooks.flush();
  const file = org.turnBuffer.file(P, session.id); const broken = '{私人故障原文'; await writeFile(file, broken);
  emit('assistant/message', assistant('后续内容'), 'append'); await hooks.flush();
  assert.equal(await readFile(file, 'utf8'), broken); assert.ok(hooks.health().failedWrites);
  assert.doesNotMatch(logs.join(''), /私人正文|私人故障原文|后续内容/);
  assert.equal((await inject({ org, session, hooks, logger: { warn() {} } })).sections.length, 1);
}));

it('装配期间清空、切换会话、项目或卸载时不提交旧缓冲段', async () => scene(async ({ org, session, hooks, emit }) => {
  emit('turn/start', { turn: 1 }); emit('user/message', human('不得泄漏的旧段'), 'append'); await hooks.flush(); session.hide();
  const original = org.turnBuffer.read.bind(org.turnBuffer);
  org.turnBuffer.read = async spec => {
    const frame = await original(spec);
    await org.turnBuffer.forget({ ...spec, throughSeq: session.seq });
    return frame;
  };
  assert.equal((await inject({ org, session, hooks })).sections.length, 1);
  org.turnBuffer.read = original;
  assert.equal((await inject({ org, session, hooks, active: () => false })).sections.length, 1);
}));

it('历史读面缺失仍采集新接纳事件，公开缺口；停用后不采集或装配', async () => scene(async ({ org, session, read }) => {
  session.append('turn/start', { turn: 1 });
  const hooks = createTurnBufferHooks({ org, projectOf: () => P });
  hooks.observe(session, session.append('user/message', human('新消息'), 'append')); await hooks.flush();
  assert.deepEqual(texts(await read()), ['新消息']); assert.ok(hooks.health().recoveryUnavailable);
  session.append('tool/call', { arguments: 'private' });
  hooks.observe(session, session.append('user/message', human('后续消息', 'next'), 'append')); await hooks.flush();
  assert.equal((await read()).未核事件数, 1);
  const disabled = createTurnBufferHooks({ org, projectOf: () => P, enabled: false });
  const host = fakeHost(); disabled.attach(host.ctx);
  assert.equal(host.钩子.size, 0); assert.equal((await inject({ org, session, hooks: disabled })).sections.length, 1);
}));

it('实际内核接线、工具查询与人侧清空使用真实会话，不提供模型清空入口', async () => {
  const f = await makeFixture(); const host = fakeHost(); const session = makeSession(); let org;
  try {
    const cwd = join(f.home, 'work'); await mkdir(cwd); session.header.cwd = cwd;
    host.ctx.sessionQuery = queryOf(session);
    const config = { ...configOf(f), projectBindings: [{ path: cwd, project: P }] };
    await apply(host.ctx, config); org = await shareOrg(config);
    const emit = (type, data, op) => { const e = session.append(type, data, op); host.触发('session/event', session, e); };
    emit('turn/start', { turn: 1 }); emit('user/message', human('真实接线内容'), 'append'); await org.turnBufferHooks.flush();
    const exec = { agent: { session }, name: 'mind', arguments: { action: 'turn_buffer_query' }, callId: 'buffer-query' };
    const tool = host.工具.get('mind'); const response = JSON.parse(await tool.execute({ action: 'turn_buffer_query' }, exec));
    assert.equal(response.成功, true); assert.deepEqual(texts(response.缓冲), ['真实接线内容']);
    assert.ok(ACTIONS.includes('turn_buffer_query')); assert.ok(READ_ONLY_ACTIONS.includes('turn_buffer_query'));
    assert.ok(!ACTIONS.includes('turn_buffer_forget')); assert.ok(COMMAND_ONLY_ACTIONS.includes('turn_buffer_forget'));
    await assert.rejects(runAction({ org, 项目: P, 主体: LEAD, args: { action: 'turn_buffer_forget' } }), { code: 'DENIED' });
    await assert.rejects(runAction({ org, 项目: P, 主体: LEAD, args: { action: 'turn_buffer_query', project: 'other' },
      宿主: { agent: exec.agent, project: P } }), { code: 'DENIED' });
    const forgotten = await host.命令.get('mind').handler({ agent: exec.agent, rawInput: 'turn_buffer_forget' });
    assert.equal(forgotten.kind, 'success', forgotten.text);
    assert.deepEqual(texts(await org.turnBuffer.read({ subject: LEAD, project: P, session: session.id })), []);
  } finally {
    await org?.turnBufferHooks?.flush(); await org?.budgetHooks?.flush(); await org?.observability.flush(); host.清理();
    forgetSharedOrg(shareKey(configOf(f))); await f.cleanup();
  }
});

it('观察租约优先于窗口读面，读取成功和项目变化都释放租约', async () => scene(async ({ org, session, read }) => {
  session.append('turn/start', { turn: 1 }); session.append('user/message', human('观察租约内容'), 'append');
  let released = 0; let windows = 0; let project = P;
  const query = {
    async observeSession() { return { source: 'live', header: session.header, inheritedEventCount: 0,
      cursor: session.seq - 1, events: session.events, [Symbol.dispose]() { released++; } }; },
    async readEvent() { windows++; throw new Error('不应使用'); },
  };
  const hooks = createTurnBufferHooks({ org, projectOf: () => project, queryOf: () => query });
  await hooks.sync(session); assert.deepEqual(texts(await read()), ['观察租约内容']); assert.equal(released, 1); assert.equal(windows, 0);
  session.append('user/message', human('切换期间内容', 'later'), 'append');
  const original = query.observeSession;
  query.observeSession = async () => { const lease = await original(); project = 'another'; return lease; };
  await hooks.sync(session); assert.equal(released, 2); assert.deepEqual(texts(await read()), ['观察租约内容']);
}));

it('窗口受限的SDK退回单事件补读，仍不漏掉事件', async () => scene(async ({ org, session, read }) => {
  session.append('turn/start', { turn: 1 }); session.append('user/message', human('小窗口内容'), 'append');
  const delegate = queryOf(session); let fallbacks = 0;
  const hooks = createTurnBufferHooks({ org, projectOf: () => P, queryOf: () => ({ async readEvent(request) {
    if (request.after > 0) { fallbacks++; throw Object.assign(new Error('window'), { code: 'SESSION_QUERY_INVALID_WINDOW' }); }
    return delegate.readEvent(request);
  } }) });
  await hooks.sync(session); assert.ok(fallbacks); assert.deepEqual(texts(await read()), ['小窗口内容']);
}));

it('轮数、消息数和实际UTF8字节均有硬上限，并公开已清理数量', async () => scene(async ({ org, session, read }) => {
  for (let turn = 1; turn <= 130; turn++) {
    session.append('turn/start', { turn }); session.append('user/message', human(`轮-${turn}`, `u-${turn}`), 'append');
  }
  await org.turnBuffer.capture({ subject: LEAD, project: P, session: session.id, fromSeq: 0, throughSeq: session.seq,
    records: session.events.map(projectTurnEvent) });
  let state = JSON.parse(await readFile(org.turnBuffer.file(P, session.id), 'utf8'));
  assert.equal(state.rounds.length, TURN_BUFFER_LIMITS.rounds); assert.equal(state.removed, 2);
  const from = session.seq;
  session.append('turn/start', { turn: 131 });
  for (let i = 0; i < 520; i++) session.append('user/message', human(`短消息${i}`, `short-${i}`), 'append');
  await org.turnBuffer.capture({ subject: LEAD, project: P, session: session.id, fromSeq: from, throughSeq: session.seq,
    records: session.events.slice(from).map(projectTurnEvent) });
  state = JSON.parse(await readFile(org.turnBuffer.file(P, session.id), 'utf8'));
  assert.equal(state.rounds.flatMap(r => r.messages).length, TURN_BUFFER_LIMITS.messages);
  const largeFrom = session.seq;
  for (let i = 0; i < 48; i++) session.append('user/message', human('汉'.repeat(16384), `large-${i}`), 'append');
  await org.turnBuffer.capture({ subject: LEAD, project: P, session: session.id, fromSeq: largeFrom, throughSeq: session.seq,
    records: session.events.slice(largeFrom).map(projectTurnEvent) });
  assert.ok((await stat(org.turnBuffer.file(P, session.id))).size <= TURN_BUFFER_LIMITS.bytes);
  assert.ok((await read()).已清理消息数 > 10);
}));

it('内容版本支持稳定分页，正文变化时拒绝旧页；人可清空损坏缓冲', async () => scene(async ({ org, session, hooks, emit, read }) => {
  emit('turn/start', { turn: 1 }); emit('user/message', human('第一条'), 'append'); await hooks.flush();
  const first = await read(); await hooks.sync(session);
  assert.equal((await read({ dataVersion: first.数据版本 })).数据版本, first.数据版本);
  emit('user/message', human('第二条', 'second'), 'append'); await hooks.flush();
  await assert.rejects(read({ dataVersion: first.数据版本 }), { code: 'TURN_BUFFER_VERSION_CHANGED' });
  await writeFile(org.turnBuffer.file(P, session.id), '{broken');
  await org.turnBuffer.forget({ subject: LEAD, project: P, session: session.id, throughSeq: session.seq });
  await hooks.sync(session); assert.deepEqual(texts(await read()), []);
}));

it('用户替换原文时移除旧内容并记录实际替换文本', async () => scene(async ({ emit, hooks, read }) => {
  emit('turn/start', { turn: 1 }); emit('user/message', human('旧约束', 'old'), 'append');
  emit('user/message', human('新约束', 'new'), { op: 'replace', startSeq: 1, endSeq: 1 });
  await hooks.flush(); assert.deepEqual(texts(await read()), ['新约束']);
}));

for (const mode of ['window', 'observation']) it('合法逆序序号按表面位置替换，不阻断检查点：' + mode, async () => scene(async ({ org, session, read }) => {
  const host = fakeHost(); let released = 0;
  const query = mode === 'window' ? queryOf(session) : { async observeSession() { return { source: 'live', header: session.header, inheritedEventCount: 0,
    cursor: session.seq - 1, events: session.events, [Symbol.dispose]() { released++; } }; } };
  const hooks = createTurnBufferHooks({ org, projectOf: () => P, queryOf: () => query }); const dispose = hooks.attach(host.ctx);
  const emit = (type, data, op) => { const e = session.append(type, data, op); hooks.observe(session, e); return e; };
  try {
    emit('turn/start', { turn: 1 });
    const a = emit('user/message', human('旧甲', 'a'), 'append');
    const b = emit('user/message', human('旧乙', 'b'), 'append');
    emit('user/message', human('应保留的丙', 'c'), 'append'); await hooks.flush();
    const newer = emit('user/message', human('替换甲', 'new-a'), { op: 'replace', startSeq: a.seq, endSeq: a.seq }); await hooks.flush();
    assert.deepEqual(session.surface.nodes, [newer.seq, b.seq, 3]);
    assert.ok(newer.seq > b.seq);
    const merged = emit('user/message', human('甲乙合并后的新内容', 'new-ab'), { op: 'replace', startSeq: newer.seq, endSeq: b.seq });
    await Promise.all(host.钩子.get('session/flush').map(fn => fn(session))); await hooks.flush();
    assert.deepEqual(texts(await read()), ['应保留的丙', '甲乙合并后的新内容']);
    assert.equal(hooks.health().failedWrites, 0);
    if (mode === 'observation') assert.ok(released > 0);
    // A cold metadata fold must recover exactly the same anchors and text.
    const recovered = createTurnBufferHooks({ org, projectOf: () => P, queryOf: () => query });
    session.append('user/message', human('', 'withdraw-after-restart', { kind: 'plugin' }), { op: 'replace', startSeq: merged.seq, endSeq: merged.seq });
    await recovered.sync(session); assert.deepEqual(texts(await read()), ['应保留的丙']);
  } finally { dispose(); }
}));

it('递增序号范围也必须按节点位置解析，不误撤回范围外的正文；连续压缩锚点可被精确撤回', async () => scene(async ({ org, session, hooks, emit, read }) => {
  emit('turn/start', { turn: 1 });
  const a = emit('user/message', human('撤回的甲', 'a'), 'append');
  const b = emit('user/message', human('压缩前的乙', 'b'), 'append');
  emit('user/message', human('范围外的丙', 'c'), 'append');
  emit('user/message', human('范围外的丁', 'd'), 'append');
  const compact = emit('user/message', human('乙摘要', 'summary', { kind: 'compact-checkpoint' }), { op: 'replace', startSeq: b.seq, endSeq: b.seq });
  await hooks.flush();
  emit('user/message', human('', 'withdraw', { kind: 'plugin' }), { op: 'replace', startSeq: a.seq, endSeq: compact.seq });
  await hooks.flush(); assert.deepEqual(texts(await read()), ['范围外的丙', '范围外的丁']);
  assert.doesNotMatch(await readFile(org.turnBuffer.file(P, session.id), 'utf8'), /撤回的甲|压缩前的乙/);
}));

it('拒绝缺少实际表面节点的替换和顺序错误、未来或不存在的端点，不猜测数值范围', () => {
  const event = { seq: 10, type: 'user/message', data: human('替换'), surfaceOp: { op: 'replace', startSeq: 8, endSeq: 2 } };
  assert.throws(() => projectTurnEvent(event), /宿主实际覆盖的有序节点/);
  const nodes = [8, 2, 6]; const row = projectTurnSurfaceEvent(event, nodes);
  assert.deepEqual(row.shadowedSeqs, [8, 2]); assert.deepEqual(nodes, [10, 6]);
  assert.throws(() => projectTurnSurfaceEvent({ ...event, surfaceOp: { op: 'replace', startSeq: 2, endSeq: 8 } }, [8, 2, 6]), /有序节点范围/);
  assert.throws(() => projectTurnSurfaceEvent({ ...event, surfaceOp: { op: 'replace', startSeq: 8, endSeq: 9 } }, [8, 2, 6]), /有序节点范围/);
  assert.throws(() => projectTurnSurfaceEvent({ ...event, surfaceOp: { op: 'replace', startSeq: 10, endSeq: 10 } }, [10]), /无效表面替换范围/);
});

it('同会话切项目按历史目录归属补读，排队旧消息不能落到新项目', async () => scene(async ({ org, session }) => {
  session.header.cwd = '/project/a'; let currentProject = P;
  const atCwd = cwd => cwd === '/project/a' ? P : cwd === '/project/b' ? 'other-project' : null;
  const query = { async observeSession() { return { source: 'live', header: session.header,
    inheritedEventCount: 0, cursor: session.seq - 1, events: session.events, [Symbol.dispose]() {} }; } };
  const hooks = createTurnBufferHooks({ org, projectOf: () => currentProject, projectAtCwd: atCwd, queryOf: () => query });
  session.append('turn/start', { turn: 1 });
  const a = session.append('user/message', human('A项目私人需求', 'a'), 'append'); hooks.observe(session, a);
  currentProject = 'other-project'; session.append('working-directory/change', { cwd: '/project/b' });
  const b = session.append('user/message', human('B项目需求', 'b'), 'append'); hooks.observe(session, b);
  await hooks.flush(); await hooks.sync(session);
  const read = project => org.turnBuffer.read({ subject: LEAD, project, session: session.id });
  assert.deepEqual(texts(await read('other-project')), ['B项目需求']);
  currentProject = P; session.append('working-directory/change', { cwd: '/project/a' }); await hooks.sync(session);
  assert.deepEqual(texts(await read(P)), ['A项目私人需求']);
  // 在B替换掉A表面消息后，A也必须撤回原文，且不能把B替换正文带入A。
  currentProject = 'other-project'; session.append('working-directory/change', { cwd: '/project/b' });
  session.append('user/message', human('B替换文本', 'b-new'), { op: 'replace', startSeq: a.seq, endSeq: a.seq });
  currentProject = P; session.append('working-directory/change', { cwd: '/project/a' }); await hooks.sync(session);
  assert.deepEqual(texts(await read(P)), []);
}));

it('跨项目的逆序替换撤回原项目压缩锚点，外项目正文不进入原项目缓冲', async () => scene(async ({ org, session, read }) => {
  session.header.cwd = '/project/a'; let project = P;
  const query = { async observeSession() { return { source: 'live', header: session.header, inheritedEventCount: 0,
    cursor: session.seq - 1, events: session.events, [Symbol.dispose]() {} }; } };
  const hooks = createTurnBufferHooks({ org, projectOf: () => project, projectAtCwd: cwd => cwd === '/project/a' ? P : 'foreign', queryOf: () => query });
  session.append('turn/start', { turn: 1 }); const a = session.append('user/message', human('A待撤回原文', 'a'), 'append');
  await hooks.sync(session);
  session.append('working-directory/change', { cwd: '/project/b' }); project = 'foreign';
  const b = session.append('user/message', human('B私人正文', 'b'), 'append');
  const compact = session.append('user/message', human('外项目压缩摘要', 'summary', { kind: 'compact-checkpoint' }), { op: 'replace', startSeq: a.seq, endSeq: a.seq });
  session.append('user/message', human('B新的私人正文', 'new-b'), { op: 'replace', startSeq: compact.seq, endSeq: b.seq });
  session.append('working-directory/change', { cwd: '/project/a' }); project = P;
  await hooks.sync(session); assert.deepEqual(texts(await read()), []);
  assert.doesNotMatch(await readFile(org.turnBuffer.file(P, session.id), 'utf8'), /A待撤回原文|B私人正文|B新的私人正文|外项目压缩摘要/);
}));

it('较长恢复分批推进，检查点不将尚未补齐的后缀报告为已持久化', async () => scene(async ({ org, session, read }) => {
  const start = session.append('turn/start', { turn: 1 });
  await org.turnBuffer.capture({ subject: LEAD, project: P, session: session.id, fromSeq: 0, throughSeq: 1, records: [projectTurnEvent(start)] });
  for (let i = 0; i < 2100; i++) session.append('tool/call', { arguments: '不得复制的参数' });
  session.append('user/message', human('积压尾部消息'), 'append');
  const hooks = createTurnBufferHooks({ org, projectOf: () => P, queryOf: () => ({ async observeSession() {
    return { source: 'live', header: session.header, inheritedEventCount: 0, cursor: session.seq - 1,
      events: session.events, [Symbol.dispose]() {} };
  } }) });
  const host = fakeHost(); const dispose = hooks.attach(host.ctx);
  const checkpoint = host.钩子.get('session/flush')[0];
  await assert.rejects(checkpoint(session), { code: 'TURN_BUFFER_RECOVERY_PENDING' });
  assert.equal((await read()).下次事件序号, 2049);
  await checkpoint(session); assert.deepEqual(texts(await read()), ['积压尾部消息']); dispose();
}));

it('检查点写盘期间后台任务追加事件，只核验开始时的前缀，下一检查点补齐新事件', async () => scene(async ({ org, session, hooks, emit, read }) => {
  emit('turn/start', { turn: 1 }); emit('user/message', human('后台任务完成前的需求'), 'append');
  await hooks.flush();
  session.append('step/start', { turn: 1, step: 0 });
  const throughSeq = session.seq;
  const capture = org.turnBuffer.capture.bind(org.turnBuffer);
  let appendDuringCapture = true;
  org.turnBuffer.capture = async args => {
    if (appendDuringCapture) {
      appendDuringCapture = false;
      // 对应真实宿主在flush等待期间产生的通知，均不含需复制的正文。
      session.append('job/settled', { id: 'background-job' });
      session.append('agent/inbox/spliced', {});
    }
    return capture(args);
  };
  const recoveryHooks = createTurnBufferHooks({ org, projectOf: () => P, queryOf: () => ({ async observeSession() {
    return { source: 'live', header: session.header, inheritedEventCount: 0, cursor: session.seq - 1,
      events: [...session.events], [Symbol.dispose]() {} };
  } }) });
  const host = fakeHost(); const dispose = recoveryHooks.attach(host.ctx);
  try {
    const checkpoint = host.钩子.get('session/flush')[0];
    await checkpoint(session);
    assert.equal((await read()).下次事件序号, throughSeq);
    assert.ok(session.seq > throughSeq);
    await checkpoint(session);
    assert.equal((await read()).下次事件序号, session.seq);
    assert.deepEqual(texts(await read()), ['后台任务完成前的需求']);
  } finally { org.turnBuffer.capture = capture; dispose(); }
}));

it('空会话检查点不要求不存在的缓冲文件，首条新消息仍须真实落盘', async () => scene(async ({ org, session, hooks, emit, read }) => {
  const host = fakeHost(); const dispose = hooks.attach(host.ctx);
  try {
    const checkpoint = host.钩子.get('session/flush')[0];
    await checkpoint(session);
    await assert.rejects(stat(org.turnBuffer.file(P, session.id)), { code: 'ENOENT' });
    emit('turn/start', { turn: 1 }); emit('user/message', human('空会话后的第一条消息'), 'append');
    await checkpoint(session);
    assert.equal((await read()).下次事件序号, session.seq);
    assert.deepEqual(texts(await read()), ['空会话后的第一条消息']);
  } finally { dispose(); }
}));
