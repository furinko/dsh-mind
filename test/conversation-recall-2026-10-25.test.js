import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Org } from '../src/org.js';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { runAction } from '../lib/actions.js';
import { injectConversationRecall, CONVERSATION_RECALL_SECTION } from '../components/kernel/lib/conversation-recall-hooks.js';
import { LOCAL_OWNER_RELATIONSHIP } from '../src/data-ownership.js';
import { migrateMemoryLayout } from '../src/memory-layout-migration.js';
import { Denied } from '../src/kernel/errors.js';
import { digest } from '../src/kernel/text.js';

const P = 'conversation-recall';
const spec = (subject = LEAD, project = P) => ({ subject, project, session: subject.id });
async function scene(work) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project: P });
  try { await work(org, f); } finally { await org.observability.flush(); await f.cleanup(); }
}
async function root(org, id = 'fresh-lead') {
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: id }); return { id, kind: 'Lead' };
}
async function capture(org, text, { subject = LEAD, project = P, at = org.clock.ms(), role = 'user', origin, interrupted = false, closed = true } = {}) {
  const current = spec(subject, project); const start = (await org.turnBuffer.position(current))?.nextSeq ?? 0;
  await org.turnBuffer.capture({ ...current, fromSeq: start, throughSeq: start + (closed ? 3 : 2), records: [
    { seq: start, time: at, type: 'turn/start', turn: start + 1 },
    { seq: start + 1, time: at, type: 'message', turn: start + 1, id: `m-${start}`, role, text, clipped: false, interrupted, ...(origin ? { origin } : {}) },
    ...(closed ? [{ seq: start + 2, time: at, type: 'turn/end', turn: start + 1, reason: 'completed' }] : []),
  ] });
}
async function bind(org, session, relationship) {
  const state = await org.information.load();
  await org.information.admin(spec(SOVEREIGN), { op: 'relationship', session, relationship, expectedRevision: state.configRevision });
}
function session(subject, source = { kind: 'user' }, text = '还记得海盐焦糖吗') {
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'user/message', surfaceOp: 'append', data: { id: 'current', role: 'user', source, content: [{ type: 'text', text }] } },
  ];
  return { id: subject.id, header: { cwd: '/fixture' }, seq: 2, surface: { nodes: [1] }, eventAt: seq => events[seq], isOwnSeq: () => true };
}
const hooks = { sync: async () => {}, health: () => ({ enabled: true, stopped: false }) };

it('新会话跨项目直接召回未提炼原文，重开服务仍可读；无需手动关联或正式记忆', () => scene(async (org, f) => {
  await capture(org, '我最喜欢海盐焦糖冰淇淋', { project: 'old-project' });
  const fresh = await root(org);
  const reopened = await Org.open({ ...f, project: P });
  const page = await reopened.conversationRecall.read(spec(fresh), { text: '海盐焦糖' });
  assert.equal(page.条目.length, 1); assert.match(page.条目[0].文本, /海盐焦糖/);
  assert.equal(page.条目[0].会话, LEAD.id); assert.equal(page.条目[0].项目, 'old-project');
  assert.equal((await reopened.memory.query({ subject: fresh, 项目: P, 类: '经历' })).条目.length, 0);
  assert.equal((await reopened.conversationRecall.read(spec(fresh), { text: '海盐焦糖', crossProject: false })).条目.length, 0);
  assert.equal(await reopened.dataOwnership.relationship(fresh.id), LOCAL_OWNER_RELATIONSHIP);
}));

it('自动装配依当前问题召回并补充近期对话，旧段替换且限制JSON预算', () => scene(async org => {
  await capture(org, '海盐焦糖是上次选定的口味');
  await capture(org, '下一次想尝试烤栗子口味');
  const fresh = await root(org); const s = session(fresh);
  const options = { org, agent: { session: s }, hooks, projectOf: () => P };
  const out = await injectConversationRecall({ sections: [{ name: CONVERSATION_RECALL_SECTION, text: 'stale-secret' }] }, options);
  assert.equal(out.sections.length, 1); assert.match(out.sections[0].text, /海盐焦糖|烤栗子/); assert.doesNotMatch(out.sections[0].text, /stale-secret/);
  const frame = JSON.parse(out.sections[0].text.split('\n').at(-1)); assert.ok(JSON.stringify(frame).length <= 7000);
  s.eventAt = () => null;
  assert.equal((await injectConversationRecall(out, options)).sections.length, 0);
}));

it('来源角色、外部出处和中断状态不丢失；外部输入不触发本地主人跨会话装配', () => scene(async org => {
  const origin = { version: 1, channel: 'fixture', producer: 'plugin:generic', direction: 'inbound', identity: 'unverified', representation: 'accepted-text', contentType: 'conversation', conversation: null, participant: null };
  await capture(org, '外部来访者提到了海盐焦糖', { role: 'external-user', origin, closed: false });
  const fresh = await root(org);
  const row = (await org.conversationRecall.read(spec(fresh), { text: '海盐焦糖' })).条目[0];
  assert.equal(row.角色, 'external-user'); assert.deepEqual(row.来源, origin); assert.equal(row.轮次状态, 'open');
  const s = session(fresh, { kind: 'plugin', plugin: 'generic', ...origin });
  const out = await injectConversationRecall({ sections: [] }, { org, agent: { session: s }, hooks, projectOf: () => P });
  assert.equal(out.sections.length, 0);
}));

it('显式不同关系隔离；成员、自报会话与未钉Lead不能读私人旧对话', () => scene(async org => {
  await capture(org, '海盐焦糖私人细节'); await bind(org, LEAD.id, 'person-A');
  const fresh = await root(org); await bind(org, fresh.id, 'person-B');
  assert.equal((await org.conversationRecall.read(spec(fresh), { text: '海盐焦糖' })).条目.length, 0);
  await bind(org, fresh.id, 'person-A');
  assert.equal((await org.conversationRecall.read(spec(fresh), { text: '海盐焦糖' })).条目.length, 1);
  await assert.rejects(org.conversationRecall.read(spec(MEMBER), { text: '海盐焦糖' }), { code: 'DENIED' });
  await assert.rejects(org.conversationRecall.read({ ...spec(fresh), session: LEAD.id }), { code: 'DENIED' });
  await assert.rejects(org.conversationRecall.read(spec({ kind: 'Lead', id: 'unregistered' }), { text: '海盐焦糖' }), { code: 'DENIED' });
}));

it('长消息末尾细节命中后可按引用续读全文；相同消息id跨项目不串', () => scene(async org => {
  const body = '前文'.repeat(3000) + '海盐焦糖约定在周五见面';
  await capture(org, body); await capture(org, '海盐焦糖在另一项目的记录', { project: 'another' });
  const fresh = await root(org);
  const page = await org.conversationRecall.read(spec(fresh), { text: '周五见面', limit: 1 });
  assert.match(page.条目[0].文本, /周五见面/); assert.ok(page.条目[0].正文偏移 > 0);
  let result = ''; let bodyOffset = 0;
  do {
    const detail = await org.conversationRecall.read(spec(fresh), { id: page.条目[0].id, bodyOffset, budget: 2000 });
    const row = detail.条目[0]; result += row.文本; bodyOffset = row.下一正文偏移;
  } while (bodyOffset !== null);
  assert.equal(result, body);
  const both = await org.conversationRecall.read(spec(fresh), { text: '海盐焦糖' });
  assert.equal(new Set(both.条目.map(r => r.id)).size, 2);
}));

it('清空和到期立即退出召回，旧引用不复活正文，分页拒绝混合版本', () => scene(async org => {
  await capture(org, '海盐焦糖第一页'); await capture(org, '海盐焦糖第二页');
  await capture(org, '过期海盐焦糖', { project: 'expired', at: org.clock.ms() - 31 * 86400000 });
  const fresh = await root(org);
  const page = await org.conversationRecall.read(spec(fresh), { text: '海盐焦糖', limit: 1 }); assert.equal(page.下一偏移, 1);
  assert.equal(page.口径.命中数, 2);
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: LEAD.id });
  await org.turnBuffer.forget({ ...spec(), throughSeq: (await org.turnBuffer.load(P, LEAD.id)).nextSeq });
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: fresh.id });
  assert.equal((await org.conversationRecall.read(spec(fresh), { id: page.条目[0].id })).条目.length, 0);
  await assert.rejects(org.conversationRecall.read(spec(fresh), { text: '海盐焦糖', dataVersion: page.数据版本, offset: 1 }), { code: 'TURN_RECALL_VERSION_CHANGED' });
}));

it('纯工具事件推进水位不打断原文分页；宿主历史回退时不读未来正文', () => scene(async org => {
  await capture(org, '海盐焦糖第一条'); await capture(org, '海盐焦糖第二条');
  const page = await org.conversationRecall.read(spec(), { text: '海盐焦糖', limit: 1 });
  const position = await org.turnBuffer.position(spec());
  await org.turnBuffer.capture({ ...spec(), fromSeq: position.nextSeq, throughSeq: position.nextSeq + 1,
    records: [{ seq: position.nextSeq, type: 'skip' }] });
  const next = await org.conversationRecall.read(spec(), { text: '海盐焦糖', limit: 1, offset: 1, dataVersion: page.数据版本 });
  assert.equal(next.条目.length, 1);
  await assert.rejects(org.conversationRecall.read({ ...spec(), throughSeq: 0 }, { text: '海盐焦糖' }), { code: 'TURN_RECALL_HISTORY_REWOUND' });
}));

it('读取期间清空或关系改变会丢弃旧帧，不泄露刚撤回的正文', () => scene(async org => {
  await capture(org, '海盐焦糖待撤回'); const fresh = await root(org);
  const load = org.turnBuffer.load.bind(org.turnBuffer); let once = false;
  org.turnBuffer.load = async (...args) => {
    if (!once && args[1] === LEAD.id) { once = true; return null; }
    return load(...args);
  };
  await assert.rejects(org.conversationRecall.read(spec(fresh), { text: '海盐焦糖' }), { code: 'TURN_RECALL_SOURCE_CHANGED' });
  org.turnBuffer.load = load;
  const proof = org.conversationRecall.proof.bind(org.conversationRecall); let calls = 0;
  org.conversationRecall.proof = async (...args) => { if (++calls === 2) await bind(org, fresh.id, 'new-person'); return proof(...args); };
  await assert.rejects(org.conversationRecall.read(spec(fresh), { text: '海盐焦糖' }), { code: 'DENIED' });
}));

it('跨项目逐个核对实际源文件读权，读取期间权限撤回也不返回旧正文', () => scene(async org => {
  await capture(org, '海盐焦糖受限项目', { project: 'restricted' }); const fresh = await root(org);
  const check = org.policy.check.bind(org.policy); let sourceChecks = 0;
  org.policy.check = async input => {
    if (input.target?.project === 'restricted' && input.target.id === `轮级缓冲/${digest(LEAD.id)}`) {
      sourceChecks++;
      if (sourceChecks > 1) throw new Denied('fixture source ACL', '源文件权限已撤回');
    }
    return check(input);
  };
  await assert.rejects(org.conversationRecall.read(spec(fresh), { text: '海盐焦糖' }), { code: 'DENIED' });
  const denied = await org.conversationRecall.read(spec(fresh), { text: '海盐焦糖' });
  assert.equal(denied.条目.length, 0); assert.ok(sourceChecks >= 3);
}));

it('旧缓冲不依赖项目摘要的16会话登记上限，坏文件明确报告缺口，支持迁移后的布局', () => scene(async (org, f) => {
  await capture(org, '海盐焦糖最早细节');
  for (let i = 0; i < 17; i++) { const who = await root(org, `old-${i}`); await capture(org, `普通记录-${i}`, { subject: who }); }
  const fresh = await root(org);
  const badFile = org.turnBuffer.file(P, 'damaged'); await mkdir(dirname(badFile), { recursive: true }); await writeFile(badFile, '{bad');
  const page = await org.conversationRecall.read(spec(fresh), { text: '海盐焦糖' });
  assert.equal(page.条目[0].会话, LEAD.id); assert.equal(page.不可读文件, 1); assert.equal(page.截断, true);
  // 坏文件不参与迁移案例，保留其健康报告后恢复为合法空缓冲。
  await writeFile(badFile, JSON.stringify({ version: 1, project: P, session: 'damaged', nextSeq: 0, floor: 0, missing: 0, removed: 0, open: null, rounds: [] }));
  await migrateMemoryLayout({ layout: org.layout, assertOffline: async () => {} });
  const reopened = await Org.open({ ...f, project: P });
  assert.equal((await reopened.conversationRecall.read(spec(fresh), { text: '海盐焦糖' })).条目.length, 1);
}));

it('原mind动作支持跨会话关键词和引用续读，旧式本会话浏览保持可用', () => scene(async org => {
  await capture(org, '海盐焦糖动作接线'); const fresh = await root(org); const s = session(fresh);
  const action = args => runAction({ org, 项目: P, 主体: fresh, 宿主: { agent: { session: s }, project: P }, args: { action: 'turn_buffer_query', ...args } });
  const result = await action({ 文本: '海盐焦糖' }); assert.equal(result.召回.条目.length, 1);
  const detail = await action({ id: result.召回.条目[0].id }); assert.equal(detail.召回.条目[0].文本, '海盐焦糖动作接线');
  assert.ok((await action({})).缓冲);
  await assert.rejects(action({ project: 'forged', 文本: '海盐焦糖' }), { code: 'DENIED' });
}));

it('本地主人默认关系覆盖新正式记忆和旧收录的已核来源；显式其他关系仍可隔离', () => scene(async org => {
  const memory = await org.memory.rememberPersonal({ subject: LEAD, 项目: P, 类: '知识', 内容: '海盐焦糖旧记录', 来源: { 谁记的: 'Lead', 怎么知道: '用户明确表达' } });
  await capture(org, '海盐焦糖是我们共同的回忆');
  const item = await org.information.submit(spec(), { messageIds: ['m-0'], title: '口味回忆' });
  const raw = JSON.parse(await readFile(org.information.file, 'utf8'));
  raw.items.find(i => i.id === item.id).scope.relationship = LEAD.id;
  await writeFile(org.information.file, JSON.stringify(raw));
  const fresh = await root(org);
  assert.equal((await org.memory.query({ subject: fresh, 项目: P, 类: '知识', id: memory.id })).条目.length, 1);
  assert.equal((await org.information.query(spec(fresh), { collection: 'materials' })).total, 1);
  await bind(org, fresh.id, 'other-person');
  assert.equal((await org.information.query(spec(fresh), { collection: 'materials' })).total, 0);
  assert.equal((await org.memory.query({ subject: fresh, 项目: P, 类: '知识', id: memory.id })).条目.length, 0);
}));
