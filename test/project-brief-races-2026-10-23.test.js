/** 项目接续的并发回归：真实来源更新不能让旧摘要重新成为当前事实。 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { PROJECT_BRIEF_LIMITS } from '../src/project-brief.js';
import { createProjectBriefHooks, injectProjectBrief, PROJECT_BRIEF_SECTION } from '../components/kernel/lib/project-brief-hooks.js';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';

const P = 'project-brief-races';
const spec = (subject = LEAD) => ({ subject, project: P, session: subject.id });
const item = (source, text, extra = {}) => ({ id: 'work', kind: '约束', claim: '用户表达',
  state: '进行中', text, sources: [source], ...extra });
const stale = error => ['PROJECT_BRIEF_CHANGED', 'PROJECT_BRIEF_SOURCE_CHANGED'].includes(error?.code);
const settle = work => work.then(value => ({ value }), error => ({ error }));

async function scene(run) {
  const f = await makeFixture();
  const org = await Org.open({ home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: P });
  try { await run({ org, f }); }
  finally { await org.observability.flush(); await f.cleanup(); }
}

async function capture(org, messages, target = spec(), { touch = true, at = Date.now() } = {}) {
  const pos = await org.turnBuffer.position(target);
  const fromSeq = pos?.nextSeq ?? 0;
  let seq = fromSeq;
  const turn = fromSeq + 1;
  const records = [{ seq: seq++, type: 'turn/start', turn, time: at }];
  for (const value of messages) {
    const { text, role = 'user' } = typeof value === 'string' ? { text: value } : value;
    records.push({ seq: seq++, type: 'message', turn, role, text, id: `m-${seq}`,
      clipped: false, interrupted: false, time: at });
  }
  records.push({ seq: seq++, type: 'turn/end', turn, reason: 'completed', time: at });
  await org.turnBuffer.capture({ ...target, fromSeq, throughSeq: seq, records });
  if (touch) await org.projectBrief.touch(target);
  return records;
}

async function root(org, id) {
  const subject = { id, kind: 'Lead' };
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: id });
  for (const session of [LEAD.id, id]) {
    const state = await org.information.load();
    await org.information.admin({ subject: SOVEREIGN, project: P }, { op: 'relationship', expectedRevision: state.configRevision, session, relationship: 'same-human-fixture' });
  }
  return spec(subject);
}
const extractLatest = input => ({ items: [item(input.messages.filter(m => m.role === 'user').at(-1).source,
  input.messages.filter(m => m.role === 'user').at(-1).text)] });
const update = (org, extract = extractLatest, target = spec()) => org.projectBrief.update(target, { extract });

function session(id = LEAD.id) {
  return { id, header: { id, cwd: process.cwd() }, seq: 0, isOwnSeq: () => true,
    requestHeader: () => ({ config: { provider: 'isolated', model: 'fixture' } }) };
}
function model(extract) {
  return { async prepareCall(config, signal) {
    return { config, async *stream(options) {
      assert.equal(options.tools, undefined);
      const input = JSON.parse(options.messages[0].content[0].text);
      const output = JSON.stringify(await extract(input, signal));
      yield { type: 'block-end', index: 0, block: { type: 'text', text: output } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } };
}
function gate() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

it('辅助提炼期间新增用户更正使旧候选失效，旧处理位置不冒充已追到最新消息', async () => scene(async ({ org }) => {
  await capture(org, ['旧要求：同会话回放']);
  await assert.rejects(update(org, async input => {
    await capture(org, ['更正：重点改为新会话接续项目']);
    return { items: [item(input.messages[0].source, '必须同会话回放')] };
  }), stale);
  const state = await org.projectBrief.load(P);
  assert.ok(state.sessions.every(s => s.processed <= s.seen));
  assert.ok((await org.projectBrief.read(spec())).待整理消息数 >= 1);
  await update(org);
  assert.match((await org.projectBrief.read(spec())).条目[0].内容, /重点改为新会话/);
}));

it('读取期间新增更正不能返回声称无积压的旧帧，可拒绝或重读到最新用户表达', async () => scene(async ({ org }) => {
  await capture(org, ['旧要求']); await update(org);
  const original = org.projectBrief.sources.bind(org.projectBrief);
  let inserted = false;
  org.projectBrief.sources = async (...args) => {
    const frame = await original(...args);
    if (!inserted) { inserted = true; await capture(org, ['更正：旧要求已撤销']); }
    return frame;
  };
  let result;
  try { result = await settle(org.projectBrief.read(spec())); }
  finally { org.projectBrief.sources = original; }
  if (result.error) assert.ok(stale(result.error), String(result.error));
  else {
    assert.ok(result.value.待整理消息数 >= 1);
    assert.match(JSON.stringify(result.value.待整理用户表达), /旧要求已撤销/);
  }
  const fresh = await org.projectBrief.read(spec());
  assert.ok(fresh.待整理消息数 >= 1);
  assert.match(JSON.stringify(fresh.待整理用户表达), /旧要求已撤销/);
}));

it('轮缓冲已提交但touch尚未登记的间隙，提炼不得持久化processed大于seen的坏状态', async () => scene(async ({ org }) => {
  await capture(org, ['已经登记的消息']);
  await capture(org, ['已落轮缓冲、尚未登记的新消息'], spec(), { touch: false });
  const result = await settle(update(org));
  if (result.error) assert.ok(stale(result.error), String(result.error));
  const state = await org.projectBrief.load(P);
  assert.ok(state.sessions.every(s => s.processed <= s.seen));
  await org.projectBrief.touch(spec());
  await update(org);
  const frame = await org.projectBrief.read(spec());
  assert.equal(frame.待整理消息数, 0);
  assert.match(JSON.stringify(frame.条目), /尚未登记的新消息/);
}));

it('晚登记的旧用户表达不能恢复来源时间更晚的暂停，即使它是本批未整理的新来源', async () => scene(async ({ org }) => {
  const now = Date.now();
  await capture(org, ['暂停这个事项'], spec(), { at: now });
  await update(org, input => ({ items: [item(input.messages[0].source, '这个事项已暂停', { state: '暂停' })] }));
  const restored = await root(org, 'older-restored-root');
  await capture(org, ['继续这个事项'], restored, { at: now - 10000 });
  const result = await settle(update(org, input => {
    assert.equal(input.messages[0].session, restored.session);
    assert.equal(input.messages[0].at, now - 10000);
    assert.ok(Number.isSafeInteger(input.messages[0].seq));
    return { items: [item(input.messages[0].source, '这个事项恢复进行中')] };
  }, restored));
  if (result.error) assert.ok(result.error.code === 'INVALID_BODY' || stale(result.error), String(result.error));
  const frame = await org.projectBrief.read(restored);
  assert.equal(frame.条目.find(row => row.id === 'work').状态, '暂停');
}));

it('来源时间未知的旧版轮缓冲不能作为恢复已暂停事项的更新用户决定', async () => scene(async ({ org }) => {
  await capture(org, ['暂停事项']);
  await update(org, input => ({ items: [item(input.messages[0].source, '事项暂停', { state: '暂停' })] }));
  const restored = await root(org, 'legacy-time-unknown');
  await capture(org, ['继续事项'], restored, { touch: false });
  const file = org.turnBuffer.file(P, restored.session);
  const stored = JSON.parse(await readFile(file, 'utf8'));
  for (const round of stored.rounds) for (const message of round.messages) delete message.at;
  await writeFile(file, JSON.stringify(stored) + '\n');
  await org.projectBrief.touch(restored);
  const result = await settle(update(org, input => ({ items: [item(input.messages[0].source, '事项恢复进行中')] }), restored));
  if (result.error) assert.ok(result.error.code === 'INVALID_BODY' || stale(result.error), String(result.error));
  assert.equal((await org.projectBrief.read(restored)).条目.find(row => row.id === 'work').状态, '暂停');
}));

it('多根会话交错历史按实际消息时间提供，提炼输入保留会话与seq而非最后登记顺序', async () => scene(async ({ org }) => {
  const now = Date.now();
  await capture(org, ['第一条旧要求'], spec(), { at: now - 20000 });
  const second = await root(org, 'interleaved-second');
  await capture(org, ['第二条更正'], second, { at: now - 10000 });
  await capture(org, ['第三条补充'], spec(), { at: now });
  await update(org, input => {
    assert.deepEqual(input.messages.map(m => m.text), ['第一条旧要求', '第二条更正', '第三条补充']);
    assert.deepEqual(input.messages.map(m => m.at), [now - 20000, now - 10000, now]);
    assert.deepEqual(input.messages.map(m => m.session), [LEAD.id, second.session, LEAD.id]);
    assert.ok(input.messages.every(m => Number.isSafeInteger(m.seq)));
    return extractLatest(input);
  });
}));

it('整理任务运行期间的新触发被合并重跑，flush后新更正不遗留到下一轮用户输入', async () => scene(async ({ org }) => {
  const started = gate(); const release = gate(); let calls = 0;
  const llm = model(async input => {
    calls++;
    if (calls === 1) { started.resolve(); await release.promise; }
    return extractLatest(input);
  });
  const hooks = createProjectBriefHooks({ org, projectOf: () => P, llmOf: () => llm, logger: { warn() {} } });
  const s = session();
  try {
    await capture(org, ['旧的初步需求']);
    await hooks.persisted(s, { summarize: true });
    await started.promise;
    await capture(org, ['更正：按最新项目需求执行']);
    await hooks.persisted(s, { summarize: true });
    release.resolve();
    await hooks.flush();
    assert.ok(calls >= 2, '运行中触发必须合并成后续整理');
    const frame = await org.projectBrief.read(spec());
    assert.equal(frame.待整理消息数, 0);
    assert.match(JSON.stringify(frame.条目), /按最新项目需求执行/);
  } finally { release.resolve(); hooks.stop(); await hooks.flush(); }
}));

it('新会话首步在helper未完成时也能看到有界最新用户原文，助手文本不混入待整理用户表达', async () => scene(async ({ org }) => {
  const started = gate(); const release = gate();
  const hooks = createProjectBriefHooks({ org, projectOf: () => P, llmOf: () => model(async input => {
    started.resolve(); await release.promise; return extractLatest(input);
  }), logger: { warn() {} } });
  let timer;
  try {
    await capture(org, ['新会话先接续这个明确需求', { role: 'assistant', text: 'assistant-only-private-plan' }]);
    await hooks.persisted(session(), { summarize: true });
    await started.promise;
    const next = await root(org, 'pending-new-root');
    const out = await Promise.race([
      injectProjectBrief({ sections: [] }, { agent: { session: session(next.session) }, org, hooks, projectOf: () => P }),
      new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('首步装配不应等待helper')), 2000); }),
    ]);
    clearTimeout(timer);
    const section = out.sections.find(s => s.name === PROJECT_BRIEF_SECTION);
    assert.ok(section, '没有正式摘要时仍须装配待整理用户表达');
    const frame = JSON.parse(section.text.split('\n').at(-1));
    assert.ok(Array.isArray(frame.待整理用户表达) && frame.待整理用户表达.length > 0);
    assert.match(JSON.stringify(frame.待整理用户表达), /先接续这个明确需求/);
    assert.doesNotMatch(JSON.stringify(frame.待整理用户表达), /assistant-only-private-plan/);
    assert.ok(JSON.stringify(frame).length <= PROJECT_BRIEF_LIMITS.context);
  } finally { clearTimeout(timer); release.resolve(); hooks.stop(); await hooks.flush(); }
}));

it('积压用户原文仅作有界接续资料，不把长消息和全部历史塞进新会话', async () => scene(async ({ org }) => {
  await capture(org, Array.from({ length: 40 }, (_, i) => `${i}: ${'用户原文'.repeat(1500)}`));
  const frame = await org.projectBrief.read(spec());
  assert.ok(Array.isArray(frame.待整理用户表达) && frame.待整理用户表达.length > 0);
  assert.ok(frame.待整理用户表达.length < 40);
  assert.ok(JSON.stringify(frame).length <= PROJECT_BRIEF_LIMITS.context);
  assert.ok(frame.截断 || frame.待整理用户表达省略 || frame.待整理用户表达截断, '有界省略必须在读面标明');
}));

it('坏项目摘要可以由显式forget恢复，清空前在途结果和旧历史都不能复活', async () => scene(async ({ org }) => {
  const now = Date.now();
  await capture(org, ['旧摘要资料'], spec(), { at: now - 1000 }); await update(org);
  await capture(org, ['清空前未整理资料'], spec(), { at: now - 500 });
  const started = gate(); const release = gate();
  const inFlight = settle(update(org, async input => {
    started.resolve(); await release.promise; return extractLatest(input);
  }));
  try {
    await started.promise;
    await writeFile(org.projectBrief.file(P), '{broken');
    const receipt = await org.projectBrief.forget(spec());
    assert.equal(receipt.已清空, true);
    release.resolve();
    const result = await inFlight;
    assert.ok(result.error && stale(result.error), '坏账清空须使旧提炼失效');
    const state = await org.projectBrief.load(P);
    assert.ok(state.sessions.every(s => s.processed <= s.seen));
    assert.deepEqual((await org.projectBrief.read(spec())).条目, []);
    await org.projectBrief.touch(spec());
    await update(org, () => { throw Error('清空前来源不能重提炼'); });
    await capture(org, ['清空后新的需求'], spec(), { at: Date.now() + 100 });
    await update(org);
    assert.match(JSON.stringify((await org.projectBrief.read(spec())).条目), /清空后新的需求/);
  } finally { release.resolve(); await inFlight; }
}));

it('合法满摘要及目标不能挤掉最后一条新消息，固定开销按预算降载后仍能继续整理', async () => scene(async ({ org }) => {
  const target = await root(org, 'session-12345678-1234-1234-1234-123456789012');
  for (let batch = 0; batch < 4; batch++) {
    await capture(org, Array.from({ length: 20 }, (_, i) => `第${batch}批来源${i}`), target);
    await update(org, input => {
      const items = [...input.previous];
      for (let i = 0; i < input.messages.length; i += 4) items.push(item(input.messages[i].source, '中文'.repeat(160), {
        id: `source-group-${batch}-${i}`, sources: input.messages.slice(i, i + 4).map(m => m.source),
      }));
      return { items };
    }, target);
  }
  const before = await org.projectBrief.load(P);
  assert.equal(before.items.length, 20);
  assert.equal(new Set(before.items.flatMap(i => i.sources.map(source => source.hash))).size, 80);
  for (let i = 0; i < 8; i++) await org.goals.create({ subject: target.subject, 项目: P,
    期望结果: `目标${i}${'需求'.repeat(300)}`, 来源: '用户表达转述', 完成依据: ['交付可核对'], 下一步: '下一步'.repeat(100) });
  await capture(org, ['新增很短的明确更正'], target);
  let called = false;
  await update(org, input => {
    called = true;
    assert.ok(Buffer.byteLength(JSON.stringify(input)) <= PROJECT_BRIEF_LIMITS.input);
    assert.ok(input.omitted, '旧摘要或目标按预算降载必须标明省略');
    const exposed = [...new Set([...input.previous.flatMap(i => i.sources), ...input.messages.map(m => m.source)])].sort();
    assert.deepEqual(Object.keys(input.sourceInfo).sort(), exposed);
    const latest = input.messages.find(m => m.text === '新增很短的明确更正');
    assert.ok(latest, '新消息须保有最低输入预算');
    return { items: [...input.previous.slice(0, 19), item(latest.source, latest.text, { id: 'latest' })] };
  }, target);
  assert.ok(called);
  assert.equal((await org.projectBrief.read(target)).待整理消息数, 0);
  assert.equal((await org.projectBrief.read(target, { id: 'latest' })).条目[0].内容, '新增很短的明确更正');
}));

it('多会话纯工具水位变化不让真实来源版本漂移或使无关提炼失效', async () => scene(async ({ org }) => {
  await capture(org, ['A项目工作资料']); await update(org);
  const second = await root(org, 'tool-cursor-second');
  await capture(org, ['B项目补充资料'], second);
  const before = await org.projectBrief.load(P);
  await update(org, async input => {
    const position = await org.turnBuffer.position(spec());
    await org.turnBuffer.capture({ ...spec(), fromSeq: position.nextSeq, throughSeq: position.nextSeq + 1,
      records: [{ seq: position.nextSeq, type: 'skip', time: Date.now() }] });
    await org.projectBrief.touch(spec());
    assert.equal((await org.projectBrief.load(P)).sourceRevision, before.sourceRevision,
      '只有cursor/登记顺序变化时真实来源修订应稳定');
    return extractLatest(input);
  }, second);
  assert.ok((await org.projectBrief.load(P)).sessions.every(s => s.processed <= s.seen));
}));

it('缩批后留在内部引用表但没有曝光给模型的来源，仍不能被候选猜中引用', async () => scene(async ({ org }) => {
  await capture(org, Array.from({ length: 24 }, (_, i) => `消息${i}${'长用户原文'.repeat(500)}`));
  await assert.rejects(update(org, input => {
    assert.ok(input.messages.length > 0 && input.messages.length < 24);
    const hidden = `s${input.messages.length}`;
    assert.ok(!input.messages.some(m => m.source === hidden));
    assert.ok(!Object.hasOwn(input.sourceInfo, hidden));
    return { items: [item(hidden, '借未曝光来源伪造的决定')] };
  }), { code: 'INVALID_BODY' });
  assert.equal((await org.projectBrief.load(P)).sessions[0].processed, 0);
  assert.deepEqual((await org.projectBrief.read(spec())).条目, []);
}));
