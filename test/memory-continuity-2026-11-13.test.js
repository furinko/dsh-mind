/** Synthetic regressions: elapsed time and mechanical excerpts are not forgetting/understanding. */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { digest } from '../src/kernel/text.js';
import { projectTurnSurfaceEvent } from '../src/turn-buffer.js';
import { createTurnBufferHooks } from '../components/kernel/lib/turn-buffer-hooks.js';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';

const project = 'memory-continuity';
const spec = { subject: LEAD, project, session: LEAD.id };
const semantic = (source, text = '暂停后仍应接续原约定') => ({ 用户决定: [{ text, source }], 助手建议: [], 认识: [] });
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project });
  try { await run(org, f); } finally { await org.observability.flush(); await f.cleanup(); }
}
async function capture(org, count = 20, start = 0, scope = spec) {
  const records = [];
  for (let turn = 1; turn <= count; turn++) {
    const seq = start + records.length;
    records.push({ seq, type: 'turn/start', turn: seq + 1, time: org.clock.ms() },
      { seq: seq + 1, type: 'message', role: 'user', id: `u-${seq}`, text: '暂停接续约定：保留原来的完整工作经历。'.repeat(20), clipped: false, interrupted: false, turn: null },
      { seq: seq + 2, type: 'message', role: 'assistant', id: `a-${seq}`, text: '助手提出的待验证建议。'.repeat(20), clipped: false, interrupted: false, turn: seq + 1 },
      { seq: seq + 3, type: 'turn/end', turn: seq + 1, reason: 'completed' });
  }
  await org.turnBuffer.capture({ ...scope, records, fromSeq: start, throughSeq: start + records.length });
  return start + records.length;
}
async function pause(org, days = 180) {
  const now = org.clock.ms() + days * 86400000;
  org.clock._source = () => new Date(now);
  await org.registry.markInteraction({ 来源: '部署引导' });
  return now;
}

it('automatic excerpts leave the same sources available for semantic understanding', () => scene(async org => {
  await capture(org);
  const excerpt = await org.turnSummaries.summarize(spec);
  assert.ok(excerpt.id);
  const understood = await org.turnSummaries.summarize({ ...spec, summary: semantic('u-0') });
  assert.ok(understood.id, '摘录不能把真正总结的来源先消费掉');
  const entries = await org.memory.turnSummaries(spec);
  assert.deepEqual(entries.map(e => e.轮级总结.kind).sort(), ['extract', 'semantic']);
  assert.deepEqual(entries.find(e => e.轮级总结.kind === 'semantic').轮级总结.sources.map(s => s.id), ['u-0']);
  assert.equal((await org.turnSummaries.summarize(spec)).pendingRounds, 0, '自动摘录仍然幂等');
  await assert.rejects(org.turnSummaries.summarize({ ...spec, summary: semantic('a-0') }), { code: 'INVALID_BODY' });
}));

it('semantic progress only covers cited sources, not every pending message', () => scene(async org => {
  await capture(org, 2);
  assert.ok((await org.turnSummaries.summarize({ ...spec, summary: semantic('u-0') })).id);
  assert.ok((await org.turnSummaries.summarize({ ...spec, summary: semantic('u-4') })).id, '第一条归纳不能跳过未引用的下一轮');
  const entries = await org.memory.turnSummaries(spec);
  assert.deepEqual(entries.flatMap(e => e.轮级总结.sources.map(s => s.id)).sort(), ['u-0', 'u-4']);
}));

it('legacy excerpts without a kind never count as semantic coverage', () => scene(async org => {
  await capture(org);
  const record = org.memory.recordTurnSummary.bind(org.memory);
  org.memory.recordTurnSummary = ({ metadata, ...input }) => {
    const { kind, ...legacy } = metadata;
    return record({ ...input, metadata: legacy });
  };
  const excerpt = await org.turnSummaries.summarize(spec);
  org.memory.recordTurnSummary = record;
  assert.ok(excerpt.id);
  assert.ok((await org.turnSummaries.summarize({ ...spec, summary: semantic('u-0') })).id);
  assert.equal((await org.turnSummaries.summarize(spec)).pendingRounds, 0, '旧摘录也不能无限重复写');
}));

it('legacy semantic summaries only consume the sources actually cited in their body', () => scene(async org => {
  await capture(org, 2);
  const state = await org.turnBuffer.load(project, LEAD.id);
  const sources = state.rounds.flatMap(r => r.messages).map(m => ({ seq: m.seq, id: m.id, hash: digest(m.text), role: m.role }));
  await org.memory.recordTurnSummary({ ...spec,
    body: JSON.stringify({ 形式: 'Lead有来源的理解，可随新经历修正；不认证语义正确', ...semantic('u-0') }),
    metadata: { session: digest(LEAD.id), from: 1, through: 6, sources }, check: async () => {} });
  assert.ok((await org.turnSummaries.summarize({ ...spec, summary: semantic('u-4') })).id);
}));

it('empty understanding does not claim progress or suppress later excerpts', () => scene(async org => {
  await capture(org);
  const empty = await org.turnSummaries.summarize({ ...spec, summary: { 用户决定: [], 助手建议: [], 认识: [] } });
  assert.equal(empty.id, undefined);
  assert.equal((await org.memory.turnSummaries(spec)).length, 0);
  assert.ok((await org.turnSummaries.summarize(spec)).id);
  assert.ok((await org.turnSummaries.summarize({ ...spec, summary: semantic('u-0') })).id);
}));

it('semantic understanding and automatic excerpts have independent progress', () => scene(async org => {
  await capture(org);
  assert.ok((await org.turnSummaries.summarize({ ...spec, summary: semantic('u-0') })).id);
  assert.ok((await org.turnSummaries.summarize(spec)).id, '语义进度不能被误当成已生成摘录');
  await capture(org, 20, 80);
  assert.ok((await org.turnSummaries.summarize(spec)).id);
  assert.ok((await org.turnSummaries.summarize({ ...spec, summary: semantic('u-80') })).id);
}));

it('180 days of inactivity do not hide completed originals or invalidate stable original pages', () => scene(async org => {
  await capture(org, 2);
  const before = await org.turnBuffer.readOriginal({ ...spec, id: 'u-0', limit: 30 });
  await pause(org);
  const after = await org.turnBuffer.readOriginal({ ...spec, id: 'u-0', textOffset: 30, limit: 30, dataVersion: before.数据版本 });
  assert.equal(after.找到, true);
  assert.equal(after.数据版本, before.数据版本);
  const frame = await org.turnBuffer.read(spec);
  assert.equal(frame.保留天数, null);
  assert.equal(frame.轮次.length, 2);
}));

it('maintenance, reopened capture and clearing a retention flag do not erase a paused completed round', () => scene(async (org, f) => {
  const end = await capture(org, 2);
  await org.turnBuffer.retain({ ...spec, start: 0 });
  const now = await pause(org, 365);
  const reopened = await Org.open({ ...f, project });
  reopened.clock._source = () => new Date(now);
  await reopened.registry.markInteraction({ 来源: '部署引导' });
  await reopened.turnBuffer.retain({ ...spec, start: 0, retained: false });
  await reopened.turnBuffer.maintain(spec);
  await capture(reopened, 1, end);
  const kept = await reopened.turnBuffer.load(project, LEAD.id);
  assert.equal(kept.rounds.length, 3);
  assert.equal(kept.rounds[0].retain, false, '取消价值标记不等于授权遗忘');
  assert.ok((await reopened.turnBuffer.readOriginal({ ...spec, id: 'u-0' })).找到);
}));

it('a new session can recall another project after a long pause without prior knowledge promotion', () => scene(async org => {
  await capture(org, 1, 0, { ...spec, project: 'paused-project' });
  await pause(org);
  const fresh = { id: 'resumed-owner', kind: 'Lead' };
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: fresh.id });
  const page = await org.conversationRecall.read({ subject: fresh, project, session: fresh.id }, { text: '暂停接续约定' });
  assert.equal(page.条目.length, 1);
  assert.equal(page.条目[0].项目, 'paused-project');
  assert.equal(page.条目[0].会话, LEAD.id);
}));

for (const projection of [2, 3]) it(`old external messages recover without an age cutoff from projection ${projection}`, () => scene(async org => {
  const at = org.clock.ms() - 180 * 86400000;
  const events = [
    { seq: 0, time: at, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: at, type: 'user/message', surfaceOp: 'append', data: { id: 'old-external', role: 'user', source: { kind: 'plugin:synthetic', mindExternal: { version: 1, contentType: 'conversation', channel: 'chat' } }, content: [{ type: 'text', text: 'RECOVER_AFTER_PAUSE' }] } },
    { seq: 2, time: at, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
  ];
  const nodes = [], context = {};
  const records = events.map(e => projectTurnSurfaceEvent(e, nodes, context)).map(row => row.seq === 1 ? { seq: 1, type: 'skip' } : { ...row, time: org.clock.ms() });
  await org.turnBuffer.capture({ ...spec, records, fromSeq: 0, throughSeq: 3 });
  const legacy = await org.turnBuffer.load(project, LEAD.id); legacy.version = 3; legacy.sourceProjection = projection;
  if (projection === 3) legacy.sourceRecovery = { version: 3, throughSeq: 3, omitted: 1 };
  await writeFile(org.turnBuffer.file(project, LEAD.id), JSON.stringify(legacy));
  await org.turnBuffer.migrate(spec); // exercise a real v4 archive already marked projected
  const session = { id: LEAD.id, header: { id: LEAD.id, cwd: process.cwd() }, inheritedEventCount: 0, seq: 3, surface: { nodes: [1] }, isOwnSeq: seq => seq >= 0 && seq < 3, eventAt: seq => events[seq] };
  const query = { async observeSession() { return { source: 'live', header: session.header, inheritedEventCount: 0, cursor: 2, events, [Symbol.dispose]() {} }; } };
  const hooks = createTurnBufferHooks({ org, projectOf: () => project, queryOf: () => query, logger: { warn() {} } });
  try { await hooks.sync(session); } finally { await hooks.flush(); }
  const state = await org.turnBuffer.load(project, LEAD.id);
  assert.equal(state.rounds.flatMap(r => r.messages)[0]?.text, 'RECOVER_AFTER_PAUSE');
  assert.equal(state.sourceRecovery.omitted, 0);
}));

async function replay(org, events, records, projectAtCwd = () => project, projection = 3, retention) {
  await org.turnBuffer.capture({ ...spec, records, fromSeq: 0, throughSeq: events.length });
  if (retention) await org.turnBuffer.retain({ ...spec, ...retention });
  const file = org.turnBuffer.file(project, LEAD.id);
  const legacy = await org.turnBuffer.load(project, LEAD.id);
  legacy.version = 3; legacy.sourceProjection = projection;
  legacy.sourceRecovery = { version: 3, throughSeq: events.length, omitted: 1 };
  await writeFile(file, JSON.stringify(legacy)); await org.turnBuffer.migrate(spec);
  const session = { id: LEAD.id, header: { id: LEAD.id, cwd: process.cwd() }, inheritedEventCount: 0,
    seq: events.length, isOwnSeq: seq => seq >= 0 && seq < events.length, eventAt: seq => events[seq] };
  const query = { async observeSession() { return { source: 'live', header: session.header,
    inheritedEventCount: 0, cursor: events.length - 1, events, [Symbol.dispose]() {} }; } };
  const hooks = createTurnBufferHooks({ org, projectOf: () => project, projectAtCwd, queryOf: () => query, logger: { warn() {} } });
  try { await hooks.sync(session); } finally { await hooks.flush(); }
  return org.turnBuffer.load(project, LEAD.id);
}

for (const projection of [2, 3]) it(`replay keeps cross-project withdrawal metadata for projection ${projection}`, () => scene(async org => {
  const at = org.clock.ms(); const other = process.cwd() + '-other';
  const external = (id, text) => ({ id, role: 'user', source: { kind: 'plugin:synthetic',
    mindExternal: { version: 1, contentType: 'conversation', channel: 'chat' } }, content: [{ type: 'text', text }] });
  const events = [
    { seq: 0, time: at, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, time: at, type: 'user/message', surfaceOp: 'append', data: external('withdrawn', 'WITHDRAWN_PROJECT_A_BODY') },
    { seq: 2, time: at, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    { seq: 3, time: at, type: 'working-directory/change', data: { cwd: other } },
    { seq: 4, time: at, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 },
      data: { id: 'other-project', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'PROJECT_B_BODY' }] } },
    { seq: 5, time: at, type: 'working-directory/change', data: { cwd: process.cwd() } },
    { seq: 6, time: at, type: 'turn/start', data: { turn: 2 } },
    { seq: 7, time: at, type: 'user/message', surfaceOp: 'append', data: external('kept', 'KEPT_PROJECT_A_BODY') },
    { seq: 8, time: at, type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
  ];
  const nodes = [], context = {};
  const records = events.map(event => projectTurnSurfaceEvent(event, nodes, context)).map(row =>
    row.seq === 1 ? { seq: 1, type: 'skip' } : row.seq === 4 ? { ...row, message: undefined } : row);
  const state = await replay(org, events, records, cwd => cwd === other ? 'other-project' : project, projection);
  assert.deepEqual(state.rounds.flatMap(round => round.messages).map(message => message.id), ['kept']);
  assert.doesNotMatch(JSON.stringify(state), /WITHDRAWN_PROJECT_A_BODY|PROJECT_B_BODY/);
}));

it('replay commits withdrawals even when no external message survives', () => scene(async org => {
  const external = (id, text) => ({ id, role: 'user', source: { kind: 'plugin:synthetic' }, content: [{ type: 'text', text }] });
  const local = (id, text) => ({ id, role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] });
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: external('stale', 'WITHDRAWN_STALE_BODY') },
    { seq: 2, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 1, endSeq: 1 }, data: local('replacement', 'replacement') },
    { seq: 3, type: 'user/message', surfaceOp: 'append', data: external('omitted', 'WITHDRAWN_OMITTED_BODY') },
    { seq: 4, type: 'user/message', surfaceOp: { op: 'replace', startSeq: 3, endSeq: 3 }, data: local('kept-local', 'KEPT_LOCAL_BODY') },
    { seq: 5, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  const nodes = [], context = {};
  const records = events.map(event => projectTurnSurfaceEvent(event, nodes, context))
    .map(row => [2, 3].includes(row.seq) ? { seq: row.seq, type: 'skip' } : row);
  const state = await replay(org, events, records);
  assert.deepEqual(state.rounds.flatMap(round => round.messages).map(message => message.id), ['kept-local']);
  assert.doesNotMatch(JSON.stringify(state), /WITHDRAWN_STALE_BODY|WITHDRAWN_OMITTED_BODY/);
}));

it('unknown replay timestamps preserve the old round age and do not promote it to most recent', () => scene(async org => {
  const at = org.clock.ms() - 90 * 86400000;
  const recent = { ...spec, project: 'more-recent' };
  await org.turnBuffer.capture({ ...recent, fromSeq: 0, throughSeq: 3, records: [
    { seq: 0, type: 'turn/start', turn: 1, time: at + 86400000 },
    { seq: 1, type: 'message', role: 'user', id: 'recent', text: 'ACTUALLY_MORE_RECENT', clipped: false, interrupted: false, turn: 1, time: at + 86400000 },
    { seq: 2, type: 'turn/end', turn: 1, reason: 'completed' },
  ] });
  const events = [{ seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: { id: 'unknown-old', role: 'user',
      source: { kind: 'plugin:synthetic' }, content: [{ type: 'text', text: 'UNKNOWN_OLD_MESSAGE' }] } },
    { seq: 2, type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } }];
  const state = await replay(org, events, [{ seq: 0, type: 'turn/start', turn: 1, time: at },
    { seq: 2, type: 'turn/end', turn: 1, reason: 'completed' }]);
  assert.equal(state.rounds[0].at, at);
  assert.equal(Object.hasOwn(state.rounds[0].messages[0], 'at'), false);
  const page = await org.conversationRecall.read(spec, { text: '', limit: 1 });
  assert.equal(page.条目[0].消息, 'recent');
}));

for (const retained of [true, false]) it(`unknown round start changes keep explicit retention ${retained}`, () => scene(async org => {
  const time = org.clock.ms() - 90 * 86400000;
  const events = [
    { seq: 0, time, type: 'user/message', surfaceOp: 'append', data: { id: 'formerly-omitted', role: 'user', source: { kind: 'plugin:synthetic' }, content: [{ type: 'text', text: 'RECOVERED_PREFIX' }] } },
    { seq: 1, time, type: 'user/message', surfaceOp: 'append', data: { id: 'previously-kept', role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'KEPT_ORIGINAL' }] } },
  ];
  const nodes = [], context = {};
  const records = events.map(event => projectTurnSurfaceEvent(event, nodes, context)).map(row => row.seq === 0 ? { seq: 0, type: 'skip' } : row);
  const state = await replay(org, events, records, () => project, 3, { start: 1, retained });
  assert.equal(state.rounds[0].start, 0);
  assert.equal(state.rounds[0].retain, retained);
  assert.deepEqual(state.rounds[0].messages.map(message => message.id), ['formerly-omitted', 'previously-kept']);
}));

it('project continuation keeps its exact original sources across a long inactive interval', () => scene(async org => {
  await capture(org, 1);
  await org.projectBrief.touch(spec);
  await org.projectBrief.update(spec, { extract: async input => ({ items: [{
    id: 'paused-work', kind: '约束', claim: '用户表达', state: '进行中', text: '暂停后接着原工作做',
    sources: [input.messages.find(message => message.role === 'user').source],
  }] }) });
  await pause(org);
  const fresh = { id: 'resumed-project-owner', kind: 'Lead' };
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: fresh.id });
  const resumed = { subject: fresh, project, session: fresh.id };
  const frame = await org.projectBrief.read(resumed);
  assert.equal(frame.条目[0]?.内容, '暂停后接着原工作做');
  const detail = await org.projectBrief.read(resumed, { id: 'paused-work' });
  assert.match(detail.条目[0].来源[0].原文, /暂停接续约定/);
}));

it('explicit forgetting still removes originals and both summary kinds and blocks delayed replay', () => scene(async org => {
  const end = await capture(org);
  await org.turnSummaries.summarize(spec);
  await org.turnSummaries.summarize({ ...spec, summary: semantic('u-0') });
  const file = org.turnBuffer.file(project, LEAD.id);
  await org.turnBuffer.forget({ ...spec, throughSeq: end });
  assert.equal((await org.turnBuffer.readOriginal({ ...spec, id: 'u-0' })).找到, false);
  assert.equal((await org.memory.turnSummaries({ ...spec, includeInactive: true })).length, 0);
  await org.turnBuffer.capture({ ...spec, records: [], fromSeq: 0, throughSeq: end });
  await org.turnBuffer.maintain(spec);
  assert.deepEqual((await org.turnBuffer.load(project, LEAD.id)).rounds, []);
  assert.doesNotMatch(await readFile(file, 'utf8'), /暂停接续约定/);
}));
