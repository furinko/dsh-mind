import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { mkdtemp, readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { ChatConnection, chatScope, sameChat } from '../components/kernel/lib/chat-connection.js';
import { chatConnection路由 } from '../components/kernel/lib/routes.js';
import { createTurnBufferHooks } from '../components/kernel/lib/turn-buffer-hooks.js';
import { createProjectBriefHooks } from '../components/kernel/lib/project-brief-hooks.js';
import { createMemoryUseHooks } from '../components/kernel/lib/memory-use-hooks.js';
import { createInformationHooks } from '../components/kernel/lib/information-hooks.js';
import { createLeadSpaceHooks } from '../components/kernel/lib/lead-space-hooks.js';
import { retireMindRuntimeSnapshots } from '../components/kernel/lib/runtime-context.js';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { apply } from '../components/kernel/lib/index.js';
import { fakeHost } from './host-harness.mjs';
import { shareOrg, forgetSharedOrg, shareKey } from '../src/runtime.js';

async function store(run) {
  const root = await mkdtemp(join(tmpdir(), 'mind-connect-'));
  const connection = await new ChatConnection(join(root, 'prefs', 'connection.json')).load();
  try { await run(connection, root); } finally { await rm(root, { recursive: true, force: true }); }
}
const set = (c, enabled, seq, sessionId = 'a') => c.set({ sessionId, enabled, expectedRevision: c.read(sessionId).revision }, seq);

test('默认接入、按聊天持久化，关闭区间重开后不会补记，旧异步租约永不复活', () => store(async c => {
  const org = { mindConnection: c }; const session = { id: 'a' }; const old = chatScope(org, session, {});
  assert.deepEqual(c.read('a'), { sessionId: 'a', enabled: true, revision: 0 });
  await set(c, false, 3); assert.equal(c.enabled('b'), true); assert.equal(chatScope(org, session, {}), null);
  await set(c, true, 8); assert.equal(sameChat(org, session, old), false);
  const reopened = await new ChatConnection(c.file).load();
  for (let n = 0; n < 12; n++) assert.equal(reopened.allowsCapture('a', n), n < 3 || n >= 8);
  await set(reopened, false, 10); await set(reopened, true, 12);
  assert.equal(reopened.allowsCapture('a', 11), false); assert.equal(reopened.allowsCapture('a', 12), true);
  assert.doesNotMatch(await readFile(c.file, 'utf8'), /content|credentials|subject/);
}));

test('并发CAS只接受一个状态，其他聊天互不覆盖，原型名也是普通ID', () => store(async c => {
  const result = await Promise.allSettled([set(c, false, 2), set(c, false, 2)]);
  assert.equal(result.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal(result.find(r => r.status === 'rejected').reason.code, 'MIND_CONNECTION_CHANGED');
  await Promise.all([set(c, false, 1, 'b'), set(c, false, 4, '__proto__')]);
  assert.equal(c.enabled('a'), false); assert.equal(c.enabled('b'), false); assert.equal(c.enabled('__proto__'), false);
  const reopened = await new ChatConnection(c.file).load(); assert.equal(reopened.enabled('__proto__'), false);
  await assert.rejects(set(c, true, 1), { code: 'MIND_CONNECTION_SCOPE_CHANGED' });
}));

test('坏记录不覆盖、不假称接入；保存失败保持最后确认状态', () => store(async (c, root) => {
  await set(c, false, 0); const raw = '{broken'; await writeFile(c.file, raw);
  const reopened = await new ChatConnection(c.file).load(); assert.equal(reopened.enabled('any'), false);
  await assert.rejects(c.set({ sessionId: 'a', enabled: true, expectedRevision: 1 }, 5), { code: 'MIND_CONNECTION_UNAVAILABLE' });
  assert.equal(await readFile(c.file, 'utf8'), raw); assert.equal(c.enabled('a'), false);
  const target = join(root, 'directory'); await mkdir(target);
  const failed = new ChatConnection(target); await assert.rejects(set(failed, false, 0)); assert.equal(failed.enabled('a'), true);
}));

function endpoint(c, { rejection, observedId = 'a', cursor = 4 } = {}) {
  let disposed = 0;
  const ctx = { get(name) { return name === 'connection' ? { requestRejection: () => rejection } : name === 'sessionQuery' ? {
    async observeSession(id, options) { assert.equal(id, 'a'); assert.equal(options.projectionMode, 'none'); return { header: { id: observedId }, cursor, [Symbol.dispose]() { disposed++; } }; }
  } : null; } };
  const handler = chatConnection路由({ ctx, org: { mindConnection: c } });
  return { get disposed() { return disposed; }, async request(method, body, headers = {}, query = method === 'GET' ? '?sessionId=a' : '') {
    let status; let value;
    const raw = typeof body === 'string' ? body : JSON.stringify(body);
    await handler({ method, url: '/plugins/dsh-mind/chat-connection' + query,
      headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers },
      async *[Symbol.asyncIterator]() { if (raw) yield Buffer.from(raw); }
    }, { writeHead(n) { status = n; }, end(s) { value = JSON.parse(s); } });
    return { status, value };
  } };
}
test('开关入口认证、同源、窄参数和真实会话位置校验；不接受客户端自报序号', () => store(async c => {
  const body = { sessionId: 'a', enabled: false, expectedRevision: 0 };
  for (const rejection of [401, 403]) assert.equal((await endpoint(c, { rejection }).request('POST', body)).status, rejection);
  const e = endpoint(c);
  assert.equal((await e.request('POST', body, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await e.request('POST', { ...body, nextSeq: 0 })).status, 400);
  assert.equal((await e.request('POST', '{bad')).status, 400);
  assert.equal((await endpoint(c, { observedId: 'foreign' }).request('POST', body)).status, 400);
  assert.equal((await e.request('GET')).value.enabled, true);
  assert.equal((await e.request('POST', body)).value.enabled, false); assert.equal(e.disposed, 1);
  assert.equal((await e.request('POST', body)).status, 409);
  await set(c, true, 8); assert.equal(c.allowsCapture('a', 4), true); assert.equal(c.allowsCapture('a', 5), false);
  assert.equal((await e.request('GET', undefined, {}, '?sessionId=a&sessionId=b')).status, 400);
}));

function sessionOf(id = LEAD.id) {
  const events = []; return { id, header: { id, cwd: process.cwd() }, events,
    get seq() { return events.length; }, surface: { nodes: [] }, inheritedEventCount: 0,
    isOwnSeq(seq) { return seq >= 0 && seq < events.length; },
    append(type, data) { const e = { seq: events.length, time: Date.now(), type, data, ...(type === 'user/message' ? { surfaceOp: 'append' } : {}) }; events.push(e); return e; }
  };
}
const human = text => ({ role: 'user', id: text, source: { kind: 'user' }, content: [{ type: 'text', text }] });
test('真实轮缓冲在重新接入后只补读允许区间，含服务重开及旧SDK窗口读面', async () => {
  for (const observation of [true, false]) {
    const f = await makeFixture(); const config = { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: 'connect' };
    const org = await Org.open(config); org.mindConnection = await new ChatConnection(org.layout.chatConnectionFile()).load();
    const session = sessionOf();
    const query = observation ? { async observeSession() { return { source: 'live', header: session.header, inheritedEventCount: 0, cursor: session.seq - 1, events: session.events, [Symbol.dispose]() {} }; } }
      : { async readEvent({ seq, after }) { return { session: session.header, inheritedEventCount: 0, events: session.events.slice(seq, seq + after + 1) }; } };
    const hooks = createTurnBufferHooks({ org, projectOf: () => 'connect', queryOf: () => query });
    try {
      session.append('turn/start', { turn: 1 }); session.append('user/message', human('before'));
      await hooks.sync(session);
      await set(org.mindConnection, false, session.seq, session.id);
      const secret = session.append('user/message', human('OFF-PERIOD-SECRET')); hooks.observe(session, secret); await hooks.sync(session);
      assert.equal((await org.turnBuffer.position({ subject: LEAD, project: 'connect', session: session.id })).nextSeq, 2);
      await set(org.mindConnection, true, session.seq, session.id);
      org.mindConnection = await new ChatConnection(org.layout.chatConnectionFile()).load();
      session.append('user/message', human('after')); await hooks.sync(session); await hooks.flush();
      const frame = await org.turnBuffer.read({ subject: LEAD, project: 'connect', session: session.id });
      assert.deepEqual(frame.轮次.flatMap(r => r.消息.map(m => m.文本)), ['before', 'after']);
      assert.doesNotMatch(await readFile(org.turnBuffer.file('connect', session.id), 'utf8'), /OFF-PERIOD-SECRET/);
    } finally { await hooks.flush(); await org.observability.flush(); await f.cleanup(); }
  }
});

test('后台整理的旧租约在关闭再打开后仍失效，关闭聊天不启动辅助模型', () => store(async c => {
  const session = sessionOf('a'); session.requestHeader = () => ({ config: { provider: 'p', model: 'm' } });
  const org = { mindConnection: c }; let release; let entered; const began = new Promise(resolve => { entered = resolve; }); let committed = 0; let updates = 0;
  const service = { async update(spec, { active }) { updates++; entered(); await new Promise(resolve => { release = resolve; }); if (active()) committed++; return { updated: false }; } };
  const hooks = createProjectBriefHooks({ org, service, projectOf: () => 'p', llmOf: () => ({ prepareCall() {} }) });
  hooks.schedule(session); await began; await set(c, false, 0); await set(c, true, 0); release(); await hooks.flush();
  assert.equal(committed, 0); await set(c, false, 0); hooks.schedule(session); await hooks.flush(); assert.equal(updates, 1);
}));

test('实际内核关闭后移除Mind资料和工具，保留宿主段与安全闸，旧工具调用拒绝', async () => {
  const f = await makeFixture(); const host = fakeHost(); const config = { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: 'connect' }; let org;
  try {
    await apply(host.ctx, config); org = await shareOrg(config);
    const session = sessionOf('a'); await set(org.mindConnection, false, 0);
    const assembly = { sections: [{ name: 'host', text: 'preserved' }, { name: 'mind:persona-core', text: 'private' }], contexts: [{ name: 'mind:turn-buffer', text: 'private' }], tools: [{ name: 'mind' }, { name: 'shell' }] };
    const listener = host.钩子.get('system-prompt/assemble')[0];
    const out = await listener(assembly, { agent: { session } }, async () => assembly);
    assert.deepEqual(out.sections, [{ name: 'host', text: 'preserved' }]); assert.deepEqual(out.contexts, []); assert.deepEqual(out.tools, [{ name: 'shell' }]); assert.ok(host.闸.length >= 2);
    const response = JSON.parse(await host.工具.get('mind').execute({ action: 'status' }, { name: 'mind', agent: { session }, callId: 'stale' }));
    assert.equal(response.成功, false); assert.match(JSON.stringify(response), /未接入心智/);
  } finally { host.清理(); await org?.turnBufferHooks?.flush(); await org?.budgetHooks?.flush(); await org?.observability.flush(); forgetSharedOrg(shareKey(config)); await f.cleanup(); }
});

test('关闭撤回所有Mind自动快照段，保留其他插件快照与原用户消息', () => {
  const mind = { name: 'mind:older-section', text: 'OLD-MIND-PRIVATE' }; const host = { name: 'host', text: 'HOST-CONTEXT' };
  const original = { seq: 1, type: 'user/message', data: human('ORIGINAL-USER') };
  const snapshot = { seq: 2, type: 'user/message', data: { role: 'user', source: { kind: 'runtime-context', sections: [mind, host] }, content: [{ type: 'text', text: 'OLD-MIND-PRIVATE\nHOST-CONTEXT' }] } };
  const appended = [];
  retireMindRuntimeSnapshots({ contexts: [] }, { session: { surface: { nodes: [1, 2] }, eventAt: seq => seq === 1 ? original : snapshot,
    append(...args) { appended.push(args); } } }, { disconnected: true });
  assert.equal(appended.length, 1); assert.deepEqual(appended[0][1].source.sections, [host]);
  assert.doesNotMatch(JSON.stringify(appended[0][1]), /OLD-MIND-PRIVATE/); assert.match(JSON.stringify(appended[0][1]), /HOST-CONTEXT/);
  assert.deepEqual(appended[0][2].surfaceOp, { op: 'replace', startSeq: 2, endSeq: 2 });
  assert.match(JSON.stringify(original), /ORIGINAL-USER/);
});

test('关闭后自动阅读与自由活动不启动，旧记忆观察在关开后不再被当作当前请求', () => store(async c => {
  const session = sessionOf('a'); session.requestHeader = () => ({ config: { provider: 'p', model: 'm' } }); const agent = { session };
  let calls = 0; const org = { mindConnection: c, information: { toolReceipts: new Map() }, leadSpace: {}, memoryUse: { async observe(spec) { if (spec.valid()) calls++; } } };
  const memory = createMemoryUseHooks({ org, projectOf: () => 'p' });
  memory.recordAssembly(agent, {}, 'OLD-FRAME'); await memory.flush(); assert.equal(calls, 2);
  const space = createLeadSpaceHooks({ org, projectOf: () => 'p', llmOf: () => { throw Error('关闭后不得取模型'); } }); space.bind(session);
  await set(c, false, 0);
  const info = createInformationHooks({ org, projectOf: () => 'p', llmOf: () => { throw Error('关闭后不得取模型'); } });
  info.schedule(session); await info.flush(); await space.tick(); assert.equal(space.health().bound, false);
  memory.recordAssembly(agent, {}, 'OFF-FRAME'); await memory.flush(); assert.equal(calls, 2);
  await set(c, true, 0);
  memory.observeRequest({ sessionId: 'a', system: 'OLD-FRAME' }); await memory.flush(); assert.equal(calls, 2);
  await space.tick(); assert.equal(space.health().bound, false); space.stop(); info.stop();
}));

test('等待宿主位置的旧缓冲任务在关开后被丢弃，不借新接入状态继续写', () => store(async c => {
  const session = sessionOf('a'); session.append('user/message', human('QUEUED-OLD'));
  let release; let enter; const entered = new Promise(resolve => { enter = resolve; }); let captures = 0;
  const org = { mindConnection: c, turnBuffer: { async load() { return null; }, async position() { enter(); await new Promise(resolve => { release = resolve; }); return null; }, async capture() { captures++; } } };
  const hooks = createTurnBufferHooks({ org, projectOf: () => 'p' });
  const work = hooks.sync(session); await entered;
  await set(c, false, 1); await set(c, true, 1); release(); await work; await hooks.flush(); assert.equal(captures, 0);
}));
