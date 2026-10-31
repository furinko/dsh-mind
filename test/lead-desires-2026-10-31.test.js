import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { digest } from '../src/kernel/text.js';
import { Org } from '../src/org.js';
import { makeFixture, LEAD, SOVEREIGN, MEMBER } from './helpers.mjs';
import { LeadDesireService } from '../src/lead-desires.js';
import { runAction } from '../lib/actions.js';
import { injectLeadDesires, LEAD_DESIRE_SECTION } from '../components/kernel/lib/lead-desires.js';
import { createLeadSpaceHooks } from '../components/kernel/lib/lead-space-hooks.js';
import { leadDesires路由 } from '../components/kernel/lib/routes.js';
import { projectMindRuntimeContext, retireMindRuntimeSnapshots } from '../components/kernel/lib/runtime-context.js';

const P = 'desire-engine'; const B = { id: 'lead-b', kind: 'Lead', roleId: 'Lead' };
const spec = (subject = LEAD, project = P) => ({ subject, project, session: subject.id });
const human = () => ({ subject: SOVEREIGN, project: P, session: null });
const context = (seq = 0, subject = LEAD) => ({ session: subject.id, seq, expression: null });
const content = extra => ({ title: '写一首小诗', reason: '想尝试自己的表达', criterion: '写出自己愿意留下的两行诗', kind: 'finite', importance: 0.8, commitment: 0.8, activities: ['write'], nextStep: '先写两行', renewalHours: 72, ...extra });
const create = (key = 'poem', extra = {}) => ({ op: 'create', epoch: 0, key, content: content(), ...extra });
const evaluate = extra => ({ outcome: 'progress', satisfaction: 0.4, progress: 0.3, reflection: '有了第一步，还想继续', nextStep: '再改一改', ...extra });
const update = (service, input, seq = 0, subject = LEAD, project = P) => service.update(spec(subject, project), input, { context: context(seq, subject) });
const feedback = (row, extra = {}, evidence = { kind: 'conversation' }) => ({ op: 'feedback', epoch: 0, id: row.id, revision: row.revision, evaluation: evaluate(extra), evidence });
const sessionOf = (subject = LEAD) => ({ id: subject.id, seq: 0, header: { cwd: process.cwd() }, isOwnSeq: () => true, requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture' } }) });
async function scene(run) {
  const f = await makeFixture({ presence: { 失联限制: false, 响应期限小时: 72 } }); const org = await Org.open({ ...f, project: P });
  let now = Date.parse('2026-10-31T02:00:00Z'); org.clock.now = () => new Date(now);
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: B.id });
  try { await run(org.leadDesires, org, f, hours => { now += hours * 3600000; }); }
  finally { org.leadSpaceHooks?.stop(); await org.leadSpaceHooks?.flush(); await org.observability.flush(); await f.cleanup(); }
}
async function enable(org) { const s = await org.leadSpace.load(); await org.leadSpace.configure(human(), { expectedRevision: s.revision, config: { ...s.config, enabled: true, timezone: 'Asia/Shanghai' } }); }
function hooksFor(org, choose) {
  const calls = []; const llm = { async prepareCall(config) { return { config, async *stream(options) {
    const input = JSON.parse(options.messages[0].content[0].text); calls.push(input);
    const result = await choose(input, calls.length); yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(result) } }; yield { type: 'finish', reason: { kind: 'stop' } };
  } }; } };
  const hooks = createLeadSpaceHooks({ org, projectOf: () => P, llmOf: () => llm, logger: { warn() {} } }); org.leadSpaceHooks = hooks;
  return { hooks, calls };
}
it('优先级独立计算并解释因子，满足降低优先级，新反馈可改变两个追求的取舍', async () => scene(async service => {
  const a = await update(service, create()); const b = await update(service, create('flute', { content: content({ title: '了解笛声', importance: 0.5 }) }));
  let q = await service.query(spec()); assert.equal(q.entries[0].id, a.id); assert.equal(q.entries[0].priority.factors.need, 1);
  await update(service, feedback(a, { satisfaction: 0.9, progress: 0.8 }), 1);
  q = await service.query(spec()); assert.equal(q.entries[0].id, b.id); assert.equal(q.entries.find(r => r.id === a.id).priority.blocked, 'cooldown');
  assert.equal(q.entries.find(r => r.id === a.id).priority.need, 0.1);
}));
it('一次性追求满足后结束，跨窗口与重建不复活；持续兴趣满足后平息再自然恢复', async () => scene(async (service, org, f, advance) => {
  const a = await update(service, create()); await update(service, feedback(a, { outcome: 'fulfilled', satisfaction: 1, progress: 1 }), 1);
  const b = await update(service, create('music', { scope: 'relationship', content: content({ kind: 'ongoing', title: '持续探索音乐' }) }));
  await update(service, feedback(b, { outcome: 'fulfilled', satisfaction: 1, progress: 1 }), 2);
  advance(72); const reopened = new LeadDesireService({ org, clock: org.clock });
  const q = await reopened.query(spec(B), { includeInactive: true });
  assert.equal(q.entries.find(r => r.id === a.id).status, 'fulfilled');
  const music = q.entries.find(r => r.id === b.id); assert.equal(music.priority.satisfaction, 0.5); assert.equal(music.priority.eligible, true); assert.equal(music.cycles, 1);
  assert.equal((await reopened.query(spec(B, 'another'))).entries[0].id, b.id);
  await assert.rejects(update(service, { op: 'state', epoch: 0, id: a.id, revision: 2, status: 'active', reason: '擅自恢复' }), { code: 'DENIED' });
  await service.update(human(), { op: 'state', epoch: 0, id: a.id, revision: 2, status: 'active', reason: '人侧明确重新追求' });
  assert.equal((await service.query(human(), { id: a.id })).entries[0].priority.need, 1);
}));
it('多次读取与同依据重试不增长满足度，虚构随笔不能当反馈证据', async () => scene(async service => {
  const row = await update(service, create()); const input = feedback(row);
  await update(service, input, 1); await update(service, input, 1);
  const before = await readFile(service.file, 'utf8'); for (let i = 0; i < 4; i++) await service.query(spec()); assert.equal(await readFile(service.file, 'utf8'), before);
  const q = await service.query(spec()); assert.equal(q.entries[0].satisfaction, 0.4); assert.equal(q.entries[0].history.length, 1);
  await assert.rejects(update(service, feedback({ ...row, revision: 2 }, {}, { kind: 'note', id: 'note-fake', revision: 1, hash: 'bad' }), 2));
  assert.equal((await service.query(spec())).entries[0].satisfaction, 0.4);
}));
it('受挫会降低排序并逐次退避，前台打断不制造受挫或虚假进展', async () => scene(async (service, org, f, advance) => {
  const row = await update(service, create()); const baseline = (await service.query(spec())).entries[0].priority.score;
  let r = await update(service, feedback(row, { outcome: 'setback', satisfaction: 0, progress: 0 }), 1);
  let view = (await service.query(spec())).entries[0]; assert.ok(view.priority.score < baseline); assert.equal(view.cooldownUntil - org.clock.ms(), 2 * 3600000);
  advance(2); r = await update(service, feedback({ id: row.id, revision: r.revision }, { outcome: 'setback', satisfaction: 0, progress: 0 }), 2);
  view = (await service.query(spec())).entries[0]; assert.equal(view.cooldownUntil - org.clock.ms(), 4 * 3600000);
  assert.equal(view.progress, 0); assert.equal(view.setbacks, 2);
}));
it('项目与关系先于排序分页，成员不能读，人侧可查看全部且人侧停止不可自行恢复', async () => scene(async (service, org) => {
  const a = await update(service, create()); const b = await update(service, create('shared', { scope: 'relationship' }));
  assert.deepEqual((await service.query(spec(B, 'another'))).entries.map(r => r.id), [b.id]);
  await org.information.admin(human(), { op: 'relationship', expectedRevision: 0, session: B.id, relationship: 'stranger' });
  assert.equal((await service.query(spec(B))).entries.length, 0); await assert.rejects(service.query(spec(MEMBER)), { code: 'DENIED' });
  await service.update(human(), { op: 'state', epoch: 0, id: a.id, revision: 1, reason: '人侧暂停', status: 'paused' });
  await assert.rejects(update(service, { op: 'state', epoch: 0, id: a.id, revision: 2, reason: '模型恢复', status: 'active' }), { code: 'DENIED' });
  assert.equal((await service.query(human(), { includeInactive: true })).entries.length, 2);
}));
it('并发不同追求不覆盖，同一版本只接受一份修正，清空及撤回屏障阻止旧请求恢复', async () => scene(async service => {
  const [a, b] = await Promise.all([update(service, create()), update(service, create('two'))]); assert.notEqual(a.id, b.id);
  const input = { op: 'revise', epoch: 0, id: a.id, revision: 1, reason: '调整', content: content({ importance: 0.6 }) };
  const results = await Promise.allSettled([update(service, input), update(service, { ...input, content: content({ importance: 0.4 }) })]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  await update(service, { op: 'remove', epoch: 0, id: b.id, revision: 1, reason: '不再想做' }); await assert.rejects(update(service, create('two')), { code: 'DENIED' });
  const s = await service.load(); await service.update(human(), { op: 'clear', expectedRevision: s.revision });
  await assert.rejects(update(service, create('late')), { code: 'LEAD_DESIRE_CONFLICT' });
  assert.equal((await service.query(spec())).entries.length, 0);
}));
it('坏数值、任意执行字段、损坏文件和链接不落账或重置，旧情绪文件无需迁移', async () => scene(async (service, org, f) => {
  for (const extra of [{ importance: 3 }, { activities: ['shell'] }, { title: '\ud800' }, { renewalHours: 0 }, { command: 'no' }]) await assert.rejects(update(service, create('bad', { content: content(extra) })), { code: 'INVALID_BODY' });
  await update(service, create()); await writeFile(service.file, '{broken'); await assert.rejects(service.query(spec()), { code: 'LEAD_DESIRE_INVALID' });
  await assert.rejects(update(service, create('later')), { code: 'LEAD_DESIRE_INVALID' }); assert.equal(await readFile(service.file, 'utf8'), '{broken');
  if (process.platform !== 'win32') { await rm(service.file); const outside = join(f.home, 'outside'); await writeFile(outside, 'do not touch'); await symlink(outside, service.file); await assert.rejects(service.query(spec())); assert.equal(await readFile(outside, 'utf8'), 'do not touch'); }
  assert.equal((await org.leadAffect.load()).revision, 0);
}));
it('真实工具与审批完整接线，模型无整体开关；根窗口自动收到排序和长期接续资料', async () => scene(async (service, org, f) => {
  const host = { agent: { session: sessionOf() }, project: P }; const args = { action: 'lead_desire_update', 欲望: create() };
  await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' })); await org.policy.reload(); let request;
  await assert.rejects(runAction({ org, 项目: P, 主体: LEAD, args, 宿主: host }), e => e.code === 'NEEDS_APPROVAL' && Boolean(request = e.detail.请求id));
  assert.equal((await service.load()).desires.length, 0);
  await org.intervention.人侧决议({ 请求id: request, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证' });
  const result = await runAction({ org, 项目: P, 主体: LEAD, args: { ...args, 审批引用: request }, 宿主: host }); assert.ok(result.数据.id);
  await assert.rejects(runAction({ org, 项目: P, 主体: LEAD, args: { ...args, 审批引用: request }, 宿主: host }), { code: 'DENIED' });
  await assert.rejects(update(service, { op: 'configure', expectedRevision: 1, enabled: false }), { code: 'DENIED' });
  const assembly = await injectLeadDesires({ sections: [], contexts: [] }, { org, agent: host.agent, projectOf: () => P });
  const projected = projectMindRuntimeContext(assembly); assert.equal(projected.contexts[0].name, LEAD_DESIRE_SECTION); assert.match(projected.contexts[0].text, /写一首小诗/);
}));
it('无正文回执不假报满足，真实活动按优先级认领，人工暂停或清空会使旧认领失效', async () => scene(async (service, org) => {
  const made = await update(service, create()); await enable(org); const wake = await org.leadSpace.reserve(spec());
  const claim = await service.claimActivity(spec(), wake); assert.equal(claim.id, made.id);
  await assert.rejects(service.finishActivity(spec(), claim, { outcome: 'completed', activity: 'write' }), { code: 'INVALID_BODY' });
  await service.update(human(), { op: 'state', epoch: 0, id: made.id, revision: claim.lease.revision, reason: '停止当前追求', status: 'paused' });
  await assert.rejects(service.checkActivity(spec(), claim), { code: 'LEAD_ACTIVITY_CANCELED' });
  await assert.rejects(service.finishActivity(spec(), claim, { outcome: 'failed', activity: 'rest' }), { code: 'LEAD_ACTIVITY_CANCELED' });
  const row = (await service.query(human(), { id: made.id })).entries[0]; assert.equal(row.satisfaction, 0); assert.equal(row.history.length, 0);
}));
it('空闲写作到下次回读评价再满足形成完整闭环，私人愿望不进入公共创作', async () => scene(async (service, org, f, advance) => {
  const made = await update(service, create()); await enable(org);
  const { hooks, calls } = hooksFor(org, input => {
    assert.equal(input.pursuit.desire.id, made.id);
    if (!input.pursuit.lastActivity) return { activity: 'write', writing: { title: '雨的尾巴', text: '雨把尾巴留在窗外。\n风替它梳了一梳。', share: false }, material: null };
    assert.match(input.pursuit.lastActivity.artifact.text, /风替它/);
    return { activity: 'rest', writing: null, material: null, review: { checkpoint: input.pursuit.lastActivity.id, evaluation: evaluate({ outcome: 'fulfilled', progress: 1, satisfaction: 1 }) } };
  });
  hooks.bind(sessionOf()); await hooks.tick(); let row = (await service.query(spec())).entries[0]; assert.equal(row.status, 'active'); assert.equal(row.satisfaction, 0);
  const note = (await org.leadSpace.notes(spec()))[0]; assert.equal(note.scope.project, P); assert.equal(note.scope.relationship, await org.dataOwnership.relationship(LEAD.id));
  advance(10); await hooks.tick(); row = (await service.query(spec(), { id: made.id })).entries[0];
  assert.equal(row.status, 'fulfilled'); assert.equal(row.satisfaction, 1); assert.equal(calls.length, 2); assert.equal((await org.leadSpace.notes(spec())).length, 1);
}));
it('没有材料的阅读追求让位可执行写作，新愿望可在自由活动形成并留待下次', async () => scene(async (service, org, f, advance) => {
  await update(service, create('read', { content: content({ title: '看相关资料', importance: 1, activities: ['read'] }) }));
  const write = await update(service, create('write', { content: content({ title: '画面小诗', importance: 0.4 }) })); await enable(org);
  const { hooks } = hooksFor(org, input => { assert.equal(input.pursuit.desire.id, write.id); return { activity: 'rest', writing: null, material: null, aspiration: { key: 'new-curiosity', content: content({ title: '想写一个雨的系列', kind: 'ongoing' }) } }; });
  hooks.bind(sessionOf()); await hooks.tick(); const all = await service.query(spec(), { includeInactive: true });
  assert.equal(all.entries.length, 3); assert.equal(all.entries.find(r => r.content.title === '想写一个雨的系列').scope.project, P);
}));
it('没有既有追求也能从自由活动形成自身愿望，下个窗口机会按优先级继续', async () => scene(async (service, org, f, advance) => {
  await enable(org); let selected = false;
  const { hooks } = hooksFor(org, input => {
    if (!input.pursuit) return { activity: 'rest', writing: null, material: null, aspiration: { key: 'series', content: content({ title: '写雨的系列', kind: 'ongoing' }) } };
    selected = true; assert.equal(input.pursuit.desire.content.title, '写雨的系列'); return { activity: 'rest', writing: null, material: null };
  });
  hooks.bind(sessionOf()); await hooks.tick(); const row = (await service.query(spec())).entries[0]; assert.equal(row.scope.project, null);
  advance(10); hooks.bind(sessionOf(B)); await hooks.tick(); assert.equal(selected, true);
}));
it('中途退出后凭幂等随笔恢复实际产物，不重写且不凭产物存在自动满足', async () => scene(async (service, org, f, advance) => {
  await update(service, create()); await enable(org); const wake = await org.leadSpace.reserve(spec()); const claim = await service.claimActivity(spec(), wake);
  const operationKey = `${claim.id}:${wake.id}`; const planned = org.leadSpace.operationNoteId(operationKey);
  await service.stageActivity(spec(), claim, { kind: 'note', id: planned, operation: digest(operationKey) });
  const note = await org.leadSpace.update(spec(), { op: 'write', title: '半途留下的小诗', text: '雨停在树梢。', share: false }, { operationKey });
  const same = await org.leadSpace.update(spec(), { op: 'write', title: '半途留下的小诗', text: '雨停在树梢。', share: false }, { operationKey }); assert.equal(note.id, same.id);
  advance(10); const nextWake = await org.leadSpace.reserve(spec(B)); const reopened = new LeadDesireService({ org, clock: org.clock }); const next = await reopened.claimActivity(spec(B), nextWake);
  const input = await reopened.resumeContext(spec(B), next); assert.equal(input.lastActivity.receipt.id, note.id); assert.equal(input.lastActivity.recovered, true);
  assert.equal(input.desire.satisfaction, 0); assert.equal((await org.leadSpace.notes(spec())).length, 1);
  await assert.rejects(reopened.finishActivity(spec(), claim, { outcome: 'completed', activity: 'write', receipt: { kind: 'note', id: note.id, revision: note.revision, hash: note.hash } }), { code: 'LEAD_ACTIVITY_CANCELED' });
}));
it('暂停后下次装配撤掉旧自动追求快照，历史不继续支配当前模型', async () => scene(async (service, org) => {
  const made = await update(service, create()); const agent = { session: sessionOf() }; const options = { org, agent, projectOf: () => P };
  const first = projectMindRuntimeContext(await injectLeadDesires({ sections: [], contexts: [] }, options));
  const old = first.contexts[0]; const events = [{ type: 'user/message', seq: 0, data: { role: 'user', source: { kind: 'runtime-context', sections: [old] }, content: [] } }];
  agent.session.surface = { nodes: [0] }; agent.session.eventAt = seq => events[seq];
  agent.session.append = (type, data) => { events.push({ type, data, seq: events.length }); agent.session.surface.nodes[0] = events.length - 1; };
  await service.update(human(), { op: 'state', epoch: 0, id: made.id, revision: 1, status: 'paused', reason: '人侧暂停' });
  const latest = projectMindRuntimeContext(await injectLeadDesires({ sections: [], contexts: [] }, options)); retireMindRuntimeSnapshots(latest, agent);
  assert.equal(events.length, 2); assert.doesNotMatch(JSON.stringify(events[1]), /写一首小诗/);
}));
it('只有准备记录而没有真实产物时，恢复标为中断，不虚增进展', async () => scene(async (service, org, f, advance) => {
  await update(service, create()); await enable(org); const wake = await org.leadSpace.reserve(spec()); const claim = await service.claimActivity(spec(), wake);
  const key = `${claim.id}:${wake.id}`; await service.stageActivity(spec(), claim, { kind: 'note', id: org.leadSpace.operationNoteId(key), operation: digest(key) });
  advance(10); const nextWake = await org.leadSpace.reserve(spec()); await service.claimActivity(spec(), nextWake);
  const row = (await service.query(spec())).entries[0]; assert.equal(row.history[0].outcome, 'interrupted'); assert.equal(row.progress, 0); assert.equal(row.satisfaction, 0);
}));
it('已完成阅读在重建时用实际学习回执恢复，未完成调用不推测为已读', async () => scene(async (service, org, f, advance) => {
  await update(service, create('read', { content: content({ activities: ['read'] }) }));
  const material = await org.information.deposit(human(), { producer: 'fixture', externalId: 'recover-reading', title: '雨声', text: '声音可以描画雨。', coverage: '合成资料', scope: { project: null, audience: 'auto', roles: [], relationship: null } });
  await enable(org); const wake = await org.leadSpace.reserve(spec()); const claim = await service.claimActivity(spec(), wake, { canRead: true });
  const prepared = await org.information.prepareLearning(spec(), { publicOnly: true, materialId: material.id });
  await service.stageActivity(spec(), claim, { kind: 'reading', id: prepared.job.id, material: material.id, hash: prepared.chosen.hash });
  await org.information.commitLearning(spec(), prepared, { records: [] });
  advance(10); const nextWake = await org.leadSpace.reserve(spec()); const next = await service.claimActivity(spec(), nextWake, { canRead: true });
  const input = await service.resumeContext(spec(), next); assert.equal(input.lastActivity.receipt.kind, 'reading'); assert.equal(input.lastActivity.outcome, 'completed'); assert.equal(input.desire.satisfaction, 0);
}));
it('人侧在模型输出途中暂停会使旧追求与迟到写入失效', async () => scene(async (service, org) => {
  const made = await update(service, create()); await enable(org); let enter; let release; const started = new Promise(r => { enter = r; }); const hold = new Promise(r => { release = r; });
  const { hooks } = hooksFor(org, async () => { enter(); await hold; return { activity: 'write', writing: { title: '迟到', text: '不保存', share: false }, material: null }; });
  hooks.bind(sessionOf()); const running = hooks.tick(); await started; const current = (await service.query(human(), { id: made.id })).entries[0];
  await service.update(human(), { op: 'state', epoch: 0, id: made.id, revision: current.revision, status: 'paused', reason: '人侧暂停' }); release(); await running;
  assert.equal((await org.leadSpace.notes(spec())).length, 0); const row = (await service.query(human(), { id: made.id })).entries[0]; assert.equal(row.status, 'paused'); assert.equal(row.satisfaction, 0);
}));
it('实际阅读产生可核回执，来源撤回后不能拿它评价满足', async () => scene(async (service, org) => {
  await update(service, create('read', { content: content({ activities: ['read'] }) }));
  const item = await org.information.deposit(human(), { producer: 'fixture', externalId: 'public', title: '小诗资料', text: '诗可以用声音描画雨。', coverage: '合成资料', scope: { project: null, audience: 'auto', roles: [], relationship: null } });
  await enable(org); const { hooks } = hooksFor(org, input => input.materials ? { activity: 'read', writing: null, material: item.id } : { records: [] });
  hooks.bind(sessionOf()); await hooks.tick(); const row = (await service.query(spec())).entries[0]; assert.equal(row.history[0].receipt.kind, 'reading');
  await org.information.admin(human(), { op: 'forget', id: item.id, revision: item.revision });
  await assert.rejects(update(service, feedback(row, { outcome: 'fulfilled', satisfaction: 1, progress: 1 }, { kind: 'activity', id: row.history[0].id }), 1), { code: 'DENIED' });
  assert.equal((await service.query(spec())).entries[0].satisfaction, 0);
}));
it('其他窗口前台工作或人侧暂停会打断在途追求，迟到创作不保存也不自报成功', async () => scene(async (service, org) => {
  const made = await update(service, create()); await enable(org); let enter; let release;
  const started = new Promise(r => { enter = r; }); const hold = new Promise(r => { release = r; });
  const { hooks } = hooksFor(org, async () => { enter(); await hold; return { activity: 'write', writing: { title: '迟到', text: '不应保存', share: false }, material: null }; });
  const events = new Map(); hooks.attach({ on(name, fn) { events.set(name, fn); return () => {}; } }); hooks.bind(sessionOf());
  const running = hooks.tick(); await started; events.get('session/event')(sessionOf(B), { type: 'turn/start', seq: 1 }); release(); await running;
  assert.equal((await org.leadSpace.notes(spec())).length, 0); const row = (await service.query(spec(), { id: made.id })).entries[0]; assert.equal(row.satisfaction, 0); assert.equal(row.frustration, 0);
}));
it('认证人侧端点可查看和停止，未认证、跨站和任意动作不通过', async () => scene(async (service, org) => {
  const made = await update(service, create());
  async function request(ctx, method = 'GET', body, extra = {}) {
    const req = { method, url: '/plugins/dsh-mind/lead-desires', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...extra }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    const res = { writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } }; await leadDesires路由({ ctx, org, 项目: P })(req, res); return res;
  }
  const ctx = { get: () => ({ requestRejection: () => undefined }) };
  assert.equal((await request({ get: () => null })).status, 503); assert.equal((await request({ get: () => ({ requestRejection: () => 401 }) })).status, 401);
  assert.equal((await request(ctx, 'GET', null, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request(ctx, 'POST', { op: 'shell' })).status, 400);
  assert.equal((await request(ctx, 'POST', { op: 'state', epoch: 0, id: made.id, revision: 1, status: 'paused', reason: '人侧暂停' })).status, 200);
  assert.equal((await request(ctx)).body.数据.entries[0].status, 'paused');
}));
it('前台窗口退出而未送达turn/end时，以宿主真实Agent状态解除旧忙碌标记', async () => scene(async (service, org) => {
  await update(service, create()); await enable(org); const { hooks, calls } = hooksFor(org, () => ({ activity: 'rest', writing: null, material: null }));
  const agents = new Map([[LEAD.id, { status: 'idle' }], [B.id, { status: 'running' }]]); const events = new Map();
  hooks.attach({ get: name => name === 'agents' ? agents : undefined, on(name, fn) { events.set(name, fn); return () => {}; } });
  hooks.bind(sessionOf()); events.get('session/event')(sessionOf(B), { type: 'turn/start', seq: 1 }); await hooks.tick(); assert.equal(calls.length, 0);
  agents.delete(B.id); await hooks.tick(); assert.equal(calls.length, 1);
}));
