import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';
import { runAction } from '../lib/actions.js';
import { recallLeadContext } from '../src/lead-context.js';
import { recallProfessionalContext } from '../src/professional-context.js';
import { exploreSource } from '../components/kernel/lib/source-exploration.js';

const P = 'unified-intake';
const spec = (subject = LEAD) => ({ subject, project: P, session: subject.id });
const human = () => spec(SOVEREIGN);
const scope = (extra = {}) => ({ project: null, audience: 'auto', roles: [], relationship: null, ...extra });
async function scene(run, options) {
  const f = await makeFixture(options); const org = await Org.open({ ...f, project: P });
  try { await run(org, f); } finally { await org.observability.flush(); await f.cleanup(); }
}
async function material(org, extra = {}) {
  return org.information.deposit(human(), { producer: 'unified-fixture', externalId: 'source', title: '竹笛与鸟声',
    text: '竹笛可以模仿鸟叫。先听短片，比较气息，再尝试一个小样本。', coverage: '合成文字片段', scope: scope(), ...extra });
}
async function draft(org, item, extra = {}) {
  const reading = await org.information.read(spec(), { id: item.id });
  return { type: 'growth', kind: '兴趣', title: '想听竹笛', text: '我想听听竹笛如何模仿鸟声。',
    sources: [{ readingId: reading.readingId, quote: '竹笛可以模仿鸟叫' }], ...extra };
}
const query = (org, subject = LEAD, extra = {}) => org.memory.query({ subject, 读者: subject, 项目: P,
  类: '偏好', 返回模式: '全文', limit: 100, ...extra });
async function root(org, id) {
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: id }); return { id, kind: 'Lead' };
}
async function associate(org, sessions, relationship) {
  for (const session of sessions) { const state = await org.information.load();
    await org.information.admin(human(), { op: 'relationship', expectedRevision: state.configRevision, session, relationship }); }
}
async function capture(org, subject, text, at = Date.now()) {
  const s = spec(subject); const pos = await org.turnBuffer.position(s); const seq = pos?.nextSeq ?? 0;
  await org.turnBuffer.capture({ ...s, fromSeq: seq, throughSeq: seq + 3, records: [
    { seq, type: 'turn/start', turn: seq + 1, time: at },
    { seq: seq + 1, type: 'message', turn: seq + 1, id: `message-${seq}`, role: 'user', text, clipped: false, interrupted: false, time: at },
    { seq: seq + 2, type: 'turn/end', turn: seq + 1, reason: 'completed', time: at },
  ] });
  await org.projectBrief.touch(s);
}
const action = (org, args) => runAction({ org, 主体: LEAD, 项目: P, args,
  宿主: { agent: { session: { id: LEAD.id, header: { cwd: process.cwd() } } }, project: P } });

it('收录正文只存在原生记忆；人格召回、原生更正、停用和处理回执共用同一份内容', async () => scene(async org => {
  const r = await org.information.record(spec(), await draft(org, await material(org)));
  assert.match(r.nativeId, /^pref-/);
  const stored = (await org.information.load()).records[0];
  for (const key of ['text', 'method', 'conditions', 'limitations']) assert.equal(stored[key], undefined);
  assert.match(JSON.stringify((await recallLeadContext({ org, subject: LEAD, project: P })).记录), /模仿鸟声/);
  assert.doesNotMatch(JSON.stringify((await org.information.context(spec())).growth), /模仿鸟声/);
  const changed = await org.memory.overturn(r.nativeId, { subject: LEAD, 新条目: '我更想比较竹笛和口哨的音色。', 理由: '真实更正' });
  const hydrated = await org.information.hydrate(stored, spec());
  assert.equal(hydrated.nativeId, changed.新条目); assert.match(hydrated.text, /口哨/);
  await org.memory.invalidate(changed.新条目, { subject: LEAD, 原因: '不再沿用' });
  assert.equal((await query(org)).条目.length, 0);
  assert.equal((await org.information.context(spec())).growth.length, 0);
}));

it('正式知识由Lead分配到真实岗位；重新分配退休旧原生条目，私密来源不能扩大', async () => scene(async org => {
  await assert.rejects(org.information.record(spec(), await draft(org, await material(org), { kind: '知识', roles: ['不存在的岗位'] })), /岗位不存在/);
  assert.equal((await org.information.load()).records.length, 0, '无效岗位不能留下阻塞后续整理的草稿');
  const r = await org.information.record(spec(), await draft(org, await material(org), { kind: '知识', text: '比较短片与气息的小样本方法', roles: ['插件工程'] }));
  assert.match(r.nativeId, /^know-/);
  const knowledge = await query(org, LEAD, { 类: '知识', 岗位: '插件工程' });
  assert.ok(knowledge.条目.some(e => e.id === r.nativeId));
  const member = { id: 'actual-engineer', kind: '成员', roleId: '插件工程' };
  await org.registry.assign({ subject: LEAD, 岗位: member.roleId, 实例: member.id });
  assert.equal((await recallProfessionalContext({ org, subject: member, project: P })).知识.length, 0);
  const task = await org.tasks.create({ subject: LEAD, 项目: P, 描述: '比较短片与气息的小样本方法', 负责人: [member.roleId], 判据: ['比较短片气息小样本'] });
  await org.tasks.bind(task.id, { subject: LEAD, 项目: P, 实例: member.id, 岗位: member.roleId });
  await org.tasks.dispatch(task.id, { subject: LEAD, 项目: P });
  await org.tasks.start(task.id, { subject: member, 项目: P });
  assert.ok((await recallProfessionalContext({ org, subject: member, project: P })).知识.some(e => e.id === r.nativeId));
  const next = await org.information.distribute(spec(), { id: r.id, revision: 1, roles: [], reason: '目前仅自己试用' });
  assert.equal(await org.memory.intakeActive(r.nativeId), false);
  assert.equal(next.scope.audience, 'lead'); assert.notEqual(next.nativeId, r.nativeId);
  assert.equal((await recallProfessionalContext({ org, subject: member, project: P })).知识.length, 0);
  const privateItem = await material(org, { externalId: 'private', scope: scope({ audience: 'lead' }) });
  const privateRow = await org.information.record(spec(), await draft(org, privateItem, { kind: '知识', roles: ['插件工程'] }));
  await assert.rejects(org.information.distribute(spec(), { id: privateRow.id, revision: 1, roles: ['插件工程'], reason: '试图扩散私密知识' }), /私密|私人/);
}));

it('不同人际关系的偏好和真实共同经历默认隔离，显式关联后跨会话及重开均可调用', async () => scene(async (org, f) => {
  const other = await root(org, 'another-human');
  const own = await action(org, { action: 'memory_write', 类: '偏好', 内容: '这个用户喜欢先看图再听解释', 来源: '用户明确表达',
    连续性: { 类别: '用户偏好', 主题: '讲解方式', 依据: '明确表达', 范围: '部署' } });
  assert.equal((await query(org, other)).条目.length, 0);
  await assert.rejects(org.memory.invalidate(own.条目.id, { subject: other, 原因: '越界处置' }), /其他关系/);
  await capture(org, LEAD, '我们今天一起试了竹笛，那个跑调的鸟叫很有趣。');
  const buffer = await org.turnBuffer.load(P, LEAD.id); const msg = buffer.rounds[0].messages[0];
  const shared = await org.information.submit(spec(), { messageIds: [msg.id], title: '一起试竹笛' });
  const reading = await org.information.read(spec(), { id: shared.id });
  const r = await org.information.record(spec(), { type: 'growth', kind: '共同回忆', title: '跑调的鸟叫', text: '一起试竹笛时，跑调的鸟叫成了我们的笑点。', sources: [{ readingId: reading.readingId, quote: '一起试了竹笛' }] });
  assert.match(r.nativeId, /^exp-/);
  assert.equal((await recallLeadContext({ org, subject: other, project: P })).共同经历.length, 0);
  assert.equal((await query(org, other, { 类: '经历', id: r.nativeId, 含失效: true })).条目.length, 0);
  await associate(org, [LEAD.id, other.id], 'confirmed-human');
  const reopened = await Org.open({ ...f, project: P });
  const frame = await recallLeadContext({ org: reopened, subject: other, project: P });
  assert.match(JSON.stringify(frame), /先看图|跑调的鸟叫/); assert.equal(frame.共同经历.length, 1);
  await org.turnBuffer.forget({ ...spec(), throughSeq: (await org.turnBuffer.load(P, LEAD.id)).nextSeq });
  assert.equal((await recallLeadContext({ org, subject: other, project: P })).共同经历.length, 1, '轮缓冲清空不等同于删除已经正式保留的共同经历');
}));

it('外部作品不能伪造成双方共同经历，自己的自省可跨关系延续且不改核心卡', async () => scene(async org => {
  const item = await material(org);
  await assert.rejects(org.information.record(spec(), await draft(org, item, { kind: '共同回忆' })), /真实对话/);
  const other = await root(org, 'new-root-self');
  await action(org, { action: 'memory_write', 类: '偏好', 内容: '我想多听听模仿自然声音的乐器', 来源: '自己的近期好奇',
    连续性: { 类别: '人格', 主题: '声音审美', 依据: '自省', 范围: '部署' } });
  assert.match(JSON.stringify((await recallLeadContext({ org, subject: other, project: P })).记录), /自然声音/);
}));

it('原生写入成功后回执中断：待处理正文不参与召回，重试只恢复同一原生记录', async () => scene(async org => {
  const input = await draft(org, await material(org)); const original = org.memory.rememberIntake.bind(org.memory); let once = true;
  org.memory.rememberIntake = async args => { const r = await original(args); if (once) { once = false; throw new Error('injected-receipt-crash'); } return r; };
  await assert.rejects(org.information.record(spec(), input), /injected-receipt-crash/);
  assert.equal((await query(org)).条目.length, 0);
  const pending = (await org.information.load()).records[0];
  assert.equal((await org.memory.intakeReferences(pending.id)).length, 1);
  await org.information.settlePending(spec());
  assert.equal((await query(org)).条目.length, 1);
  assert.equal((await org.memory.intakeReferences(pending.id)).length, 1);
  assert.equal((await org.information.load()).records[0].text, undefined);
}));

it('来源撤回期间的查询不返回旧帧，来源账本损坏仍可读原有无关记忆', async () => scene(async org => {
  const item = await material(org); await org.information.record(spec(), await draft(org, item));
  await org.memory.remember({ subject: LEAD, 项目: P, 类: '偏好', 内容: '原有无关记忆仍可读取', 来源: '旧服务' });
  const original = org.information.nativeReadable.bind(org.information); let once = true;
  org.information.nativeReadable = async (...args) => { const result = await original(...args); if (once) { once = false; await org.information.admin(human(), { op: 'forget', id: item.id, revision: item.revision }); } return result; };
  await assert.rejects(query(org), { code: 'DENIED' });
  await writeFile(org.information.file, '{broken');
  const result = await query(org);
  assert.match(JSON.stringify(result.条目), /原有无关记忆/); assert.match(result.来源警示, /状态不可用/);
}));

it('不同关系可以用相同摘要id，清空一方不清空另一方，迟到旧历史仍受屏障约束', async () => scene(async org => {
  const other = await root(org, 'isolated-summary'); const oldAt = Date.now() - 10000;
  const summarize = text => input => ({ items: [{ id: 'work', kind: '约束', claim: '用户表达', state: '进行中', text, sources: [input.messages[0].source] }] });
  await capture(org, LEAD, '甲的私密项目', oldAt); await org.projectBrief.update(spec(), { extract: summarize('甲的私密摘要') });
  await capture(org, other, '乙的私密项目', oldAt); await org.projectBrief.update(spec(other), { extract: summarize('乙的私密摘要') });
  assert.match(JSON.stringify(await org.projectBrief.read(spec())), /甲的私密摘要/);
  assert.doesNotMatch(JSON.stringify(await org.projectBrief.read(spec())), /乙的私密/);
  await org.projectBrief.forget(spec());
  assert.match(JSON.stringify(await org.projectBrief.read(spec(other))), /乙的私密摘要/);
  const late = await root(org, 'late-same-human'); await associate(org, [LEAD.id, late.id], 'same-after-forget');
  await capture(org, late, '迟到的甲旧历史', oldAt);
  const result = await org.projectBrief.update(spec(late), { extract() { throw Error('旧历史不得复活'); } });
  assert.equal(result.updated, false);
}));

it('审批冻结覆盖正式记忆全部写入，批准前没有草稿或原生记忆，批准后真实重放', async () => scene(async org => {
  const input = await draft(org, await material(org)); const args = { action: 'information_update', 信息: { op: 'record', data: input } };
  await assert.rejects(action(org, args));
  assert.equal((await org.information.load()).records.length, 0); assert.equal((await query(org)).条目.length, 0);
  const requests = await org.intervention.投影({ 项目: P }); assert.equal(requests.length, 1);
  const id = requests[0].请求id; const frozen = await org.intervention.读冻结({ 请求id: id, subject: LEAD });
  assert.ok(frozen.步骤.some(s => s.目标.kind === '偏好')); assert.equal(frozen.入参.信息.data.text, input.text);
  await org.intervention.人侧决议({ 请求id: id, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证（同源浏览器设置入口）' });
  await assert.rejects(action(org, { ...args, 信息: { op: 'record', data: { ...input, text: '偷换正文' } }, 审批引用: id }));
  const result = await action(org, { ...args, 审批引用: id }); assert.match(result.数据.nativeId, /^pref-/);
  assert.equal((await query(org)).条目.length, 1);
}, { defaults: { 介入度: '审批' } }));

function fixtureModel(select) {
  return { async prepareCall(config) { return { config, async *stream(options) {
    assert.equal(options.tools, undefined); const input = JSON.parse(options.messages[0].content[0].text);
    const result = await select(input); yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(result) } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  } }; } };
}

it('多岗位知识的审批包括每次正式写入，重新分配的审批同时覆盖旧岗位停用', async () => scene(async org => {
  async function approve(args) {
    await assert.rejects(action(org, args));
    const id = (await org.intervention.投影({ 项目: P })).at(-1).请求id;
    await org.intervention.人侧决议({ 请求id: id, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证（同源浏览器设置入口）' });
    return action(org, { ...args, 审批引用: id });
  }
  const input = await draft(org, await material(org), { kind: '知识', text: '先比较一段短片，再检查气息的小样本方法', roles: ['Lead', '插件工程'] });
  const r = (await approve({ action: 'information_update', 信息: { op: 'record', data: input } })).数据;
  assert.equal(r.native.length, 2);
  const next = (await approve({ action: 'information_update', 信息: { op: 'distribute', data: { id: r.id, revision: r.revision, roles: [], reason: '收回Lead继续核对' } } })).数据;
  assert.equal(next.native.length, 1);
  for (const old of r.native) assert.equal(await org.memory.intakeActive(old.id), false);
}, { defaults: { 介入度: '审批' } }));
it('自主探索使用当前真实Agent和完整工具流水线，选题与取稿有统一预算，材料走原记忆', async () => scene(async org => {
  const session = { id: LEAD.id, header: { cwd: process.cwd() } }; const agent = { session }; const calls = [];
  const tools = { get: () => ({}), async execute(exec) {
    assert.equal(exec.agent, agent); assert.ok(exec.signal instanceof AbortSignal); calls.push(exec.name);
    const value = exec.name === 'bili_humanism_candidates' ? { result: [{ bvid: 'BV1xx411c7mD', title: '鸟声与竹笛', author: '合成作者' }] }
      : { result: { segments: [{ text: '竹笛可以模仿鸟叫。' }], coverage: '合成一页字幕' } };
    return { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] };
  } };
  const args = { org, session, spec: spec(), tools, agents: { get: () => agent }, route: { provider: 'fixture', model: 'fixture' },
    signal: new AbortController().signal, active: () => true, llm: fixtureModel(input => ({ id: input.candidates[0].id })) };
  const result = await exploreSource(args); assert.ok(result.material);
  assert.deepEqual(calls, ['bili_humanism_candidates', 'bili_humanism_read']);
  assert.equal((await exploreSource(args)).skipped, true); assert.equal(calls.length, 2);
  const state = await org.information.load(); assert.equal(Object.values(state.usage)[0].sourceReads, 1);
  assert.equal(Object.values(state.usage)[0].modelCalls, 1);
  const prepared = await org.information.prepareLearning(spec());
  await org.information.commitLearning(spec(), prepared, { records: [{ type: 'growth', kind: '兴趣', title: '鸟声乐器', text: '我想多听听模仿鸟声的乐器。', quote: '竹笛可以模仿鸟叫' }] });
  assert.match(JSON.stringify((await recallLeadContext({ org, subject: LEAD, project: P })).记录), /鸟声乐器|模仿鸟声/);
}));

it('探索不能抓取模型自造目标；宿主拒绝、暂停和Agent被替换均不收录或重试', async () => scene(async org => {
  const session = { id: LEAD.id, header: { cwd: process.cwd() } }; const agent = { session }; let calls = 0;
  const tools = { get: () => ({}), async execute() { calls++; return { isError: true, content: [{ type: 'text', text: 'host-denied' }] }; } };
  const args = { org, session, spec: spec(), tools, agents: { get: () => agent }, route: { provider: 'fixture', model: 'fixture' }, signal: new AbortController().signal,
    active: () => true, llm: fixtureModel(() => { throw Error('拒绝后不能调用模型'); }) };
  await assert.rejects(exploreSource(args), { code: 'INFORMATION_SOURCE_FAILED' });
  assert.equal(calls, 1); assert.equal((await org.information.load()).items.length, 0);
  assert.equal((await exploreSource(args)).skipped, true);
  assert.equal((await exploreSource({ ...args, agents: { get: () => ({ session: {} }) } })).available, false);
}));

for (const mode of ['invented', 'pause', 'agent-change']) it(`探索边界 ${mode}：取稿前复核候选、暂停和真实Agent，不写入无效来源`, async () => scene(async org => {
  const session = { id: LEAD.id, header: { cwd: process.cwd() } }; const agent = { session }; let live = agent; let calls = 0;
  const tools = { get: () => ({}), async execute() { calls++; return { isError: false, content: [{ type: 'text', text: JSON.stringify({ result: [{ bvid: 'BV1xx411c7mD', title: '合成候选' }] }) }] }; } };
  const llm = fixtureModel(async input => {
    if (mode === 'pause') { const state = await org.information.load(); await org.information.admin(human(), { op: 'configure', expectedRevision: state.configRevision, config: { ...state.config, paused: true } }); }
    if (mode === 'agent-change') live = { session };
    return { id: mode === 'invented' ? 'BV1xx411c7mE' : input.candidates[0].id };
  });
  await assert.rejects(exploreSource({ org, session, spec: spec(), tools, agents: { get: () => live }, route: { provider: 'fixture', model: 'fixture' },
    signal: new AbortController().signal, active: () => true, llm }),
  { code: mode === 'invented' ? 'INFORMATION_SELECTION_INVALID' : mode === 'pause' ? 'INFORMATION_SCOPE_CHANGED' : 'INFORMATION_SOURCE_CHANGED' });
  assert.equal(calls, 1); assert.equal((await org.information.load()).items.length, 0);
}));

it('B站取稿成功但没有实际文字时，只留探索回执，元数据不冒充阅读或知识', async () => scene(async org => {
  const session = { id: LEAD.id, header: { cwd: process.cwd() } }; const agent = { session };
  const tools = { get: () => ({}), async execute(exec) { return { isError: false, content: [{ type: 'text', text: JSON.stringify({ result:
    exec.name === 'bili_humanism_candidates' ? [{ bvid: 'BV1xx411c7mD', title: '只有元数据' }] : { title: '只有元数据', route: null, segments: [], coverage: '未取得字幕' } }) }] }; } };
  const result = await exploreSource({ org, session, spec: spec(), tools, agents: { get: () => agent }, route: { provider: 'fixture', model: 'fixture' },
    signal: new AbortController().signal, active: () => true, llm: fixtureModel(input => ({ id: input.candidates[0].id })) });
  assert.equal(result.reason, 'no-readable-text');
  const state = await org.information.load(); assert.equal(state.items.length, 0); assert.equal(state.records.length, 0);
  assert.equal(state.jobs.at(-1).state, 'completed'); assert.equal(state.jobs.at(-1).material, null);
}));
