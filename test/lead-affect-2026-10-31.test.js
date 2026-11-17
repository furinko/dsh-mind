import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, symlink, link, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER, SOVEREIGN } from './helpers.mjs';
import { Org } from '../src/org.js';
import { LeadAffectService } from '../src/lead-affect.js';
import { runAction, READ_ONLY_ACTIONS, ACTIONS } from '../lib/actions.js';
import { injectLeadAffect, leadAffectExecution, LEAD_AFFECT_SECTION } from '../components/kernel/lib/lead-affect.js';
import { projectMindRuntimeContext, retireMindRuntimeSnapshots } from '../components/kernel/lib/runtime-context.js';
import { leadAffect路由 } from '../components/kernel/lib/routes.js';
import { ChatConnection } from '../components/kernel/lib/chat-connection.js';
import { fakeHost } from './host-harness.mjs';
import * as kernel from '../components/kernel/lib/index.js';

const P = 'lead-affect';
const B = { id: 'lead-b', kind: 'Lead', roleId: 'Lead' };
const spec = (subject = LEAD, project = P) => ({ subject, project, session: subject.id });
const human = () => ({ subject: SOVEREIGN, project: P, session: null });
const sessionOf = (subject = LEAD) => ({ id: subject.id, seq: 0, header: { cwd: process.cwd() } });
const body = (extra = {}) => ({ event: '调试的尝试没有成功', appraisal: '有些受挫，想换个思路', feelings: ['失落'], desires: ['想把问题弄明白'], affect: { valence: -0.6, arousal: -0.2 }, ...extra });
const record = (key = 'first-attempt', extra = {}) => ({ op: 'record', epoch: 0, key, account: body(), ...extra });
const context = (subject = LEAD) => ({ kind: 'model-self-report', session: subject.id, seq: 0, expression: null });
const write = (service, input = record(), subject = LEAD, project = P, extra = {}) => service.update(spec(subject, project), input, { context: context(subject), ...extra });
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project: P });
  let now = org.clock.ms(); org.clock.now = () => new Date(now);
  await org.registry.assign({ subject: SOVEREIGN, 岗位: 'Lead', 实例: B.id });
  try { await run(org.leadAffect, org, f, hours => { now += hours * 3600000; }); }
  finally { org.leadSpaceHooks?.stop(); await org.leadSpaceHooks?.flush(); await org.observability.flush(); await f.cleanup(); }
}
it('A窗口的心情与可读缘由在B窗口及服务重建后延续，不新造长期记忆或任务', async () => scene(async (service, org) => {
  const made = await write(service);
  const fromB = await new LeadAffectService({ org, clock: org.clock }).query(spec(B));
  assert.deepEqual(fromB.mood, { valence: -0.6, arousal: -0.2 });
  assert.equal(fromB.entries[0].id, made.id); assert.equal(fromB.entries[0].context.session, LEAD.id);
  assert.equal((await org.memory.query({ subject: LEAD, 项目: P, 类: '偏好' })).条目.length, 0);
  // Windows 没有 POSIX 权限位：0o600 建的文件在 NTFS 上回读是 0o666（基线实测 438）。
  // 断言只在 POSIX 上有意义；Windows 只核对「不是只读」这一位真实含义。
  const 权限 = (await stat(service.file)).mode & 0o777;
  if (process.platform === 'win32') assert.equal(权限 & 0o200, 0o200, `Windows 上不应是只读文件，实际 ${权限.toString(8)}`);
  else assert.equal(权限, 0o600);
}));
it('整体余波跨项目和关系延续，私人事件、人物、动机与来源不会随之泄漏', async () => scene(async (service, org) => {
  const made = await write(service, record('private', { account: body({ event: 'private-person-secret', desires: ['private-desire'] }) }));
  const otherProject = await service.query(spec(B, 'another'));
  assert.equal(otherProject.mood.valence, -0.6); assert.deepEqual(otherProject.entries, []);
  await org.information.admin(human(), { op: 'relationship', expectedRevision: 0, session: B.id, relationship: 'another-person' });
  const otherRelationship = await service.query(spec(B));
  assert.deepEqual(otherRelationship.mood, otherProject.mood); assert.deepEqual(otherRelationship.entries, []);
  assert.doesNotMatch(JSON.stringify(otherRelationship), /private-person|private-desire|"session":"lead"/);
  await assert.rejects(service.query(spec(B), { id: made.id }), { code: 'DENIED' });
  assert.equal((await service.query(human())).entries.length, 1);
}));
it('重复读取与同事件重试不叠加、不刷新平复时间，独立并发事件不互相覆盖', async () => scene(async (service, org, f, advance) => {
  const [a, duplicate] = await Promise.all([write(service), write(new LeadAffectService({ org, clock: org.clock }))]);
  assert.equal(a.id, duplicate.id); assert.equal((await service.load()).events.length, 1);
  advance(6); assert.equal((await service.query(spec())).mood.valence, -0.3);
  await write(service); assert.equal((await service.query(spec())).mood.valence, -0.3);
  const second = await write(service, record('new-success', { account: body({ event: '第二种方法成功了', appraisal: '看见进展，心情好了一些', feelings: ['高兴'], desires: [], affect: { valence: 0.5, arousal: 0.3 } }) }), B);
  assert.ok(second.id); assert.equal((await service.query(spec())).mood.valence, 0.2);
  const simultaneous = await Promise.all([write(service, record('one')), write(service, record('two'), B)]);
  assert.equal(new Set(simultaneous.map(r => r.id)).size, 2); assert.equal((await service.load()).events.length, 4);
}));
it('事件按半衰期平复，14天后不以旧愿望冒充当前动机，读操作不写盘', async () => scene(async (service, org, f, advance) => {
  await write(service); const bytes = await readFile(service.file, 'utf8');
  advance(6); const half = await service.query(spec()); assert.equal(half.entries[0].weight, 0.5);
  advance(24 * 14); const old = await service.query(spec()); assert.deepEqual(old.mood, { valence: 0, arousal: 0 }); assert.equal(old.entries[0].weight, 0);
  assert.equal(await readFile(service.file, 'utf8'), bytes);
}));
it('B窗口澄清A窗口的误解会替代原影响；版本竞争被拒，撤回后无正文且重试不能复活', async () => scene(async service => {
  const made = await write(service);
  const corrected = body({ event: '确认失败来自环境问题', appraisal: '原先对交流的理解有误，已澄清', feelings: ['释然'], desires: [], affect: { valence: 0.1, arousal: 0 } });
  const fixed = await write(service, { op: 'revise', epoch: 0, id: made.id, revision: 1, reason: '新信息澄清', account: corrected }, B);
  assert.equal((await service.query(spec())).mood.valence, 0.1);
  await assert.rejects(write(service, { op: 'revise', epoch: 0, id: made.id, revision: 1, reason: '迟到更改', account: body() }), { code: 'LEAD_AFFECT_CONFLICT' });
  await write(service, { op: 'remove', epoch: 0, id: made.id, revision: fixed.revision, reason: '不再保留' });
  const raw = await readFile(service.file, 'utf8'); assert.doesNotMatch(raw, /环境问题|原先对交流|想把问题/);
  await assert.rejects(write(service), { code: 'DENIED' }); assert.deepEqual((await service.query(spec())).mood, { valence: 0, arousal: 0 });
}));
it('人侧修正不被模型覆盖；清空屏障阻止晚到旧记录；开关仅人侧维护', async () => scene(async service => {
  const made = await write(service);
  await service.update(human(), { op: 'revise', epoch: 0, id: made.id, revision: 1, reason: '用户纠正', account: body({ appraisal: '已经澄清，不应继续误解' }) });
  await assert.rejects(write(service, { op: 'remove', epoch: 0, id: made.id, revision: 2, reason: '模型擅改' }), { code: 'DENIED' });
  await assert.rejects(write(service, { op: 'clear', expectedRevision: 2 }), { code: 'DENIED' });
  await service.update(human(), { op: 'clear', expectedRevision: 2 });
  await assert.rejects(write(service), { code: 'LEAD_AFFECT_CONFLICT' });
  await write(service, record('fresh', { epoch: 1 }));
  const current = await service.query(human());
  await service.update(human(), { op: 'configure', expectedRevision: current.revision, enabled: false });
  assert.deepEqual((await service.query(spec())).mood, { valence: 0, arousal: 0 });
  await assert.rejects(write(service, record('later', { epoch: 1 })), { code: 'DENIED' });
}));
it('成员、伪造会话、自报来源或扩权字段被拒，超限数值和坏Unicode不落账', async () => scene(async service => {
  await assert.rejects(service.query(spec(MEMBER)), { code: 'DENIED' });
  await assert.rejects(service.query({ ...spec(), session: 'forged' }), { code: 'DENIED' });
  for (const input of [record('x', { subject: SOVEREIGN }), record('x', { scope: { relationship: null } }), record('x', { account: body({ affect: { valence: 1.1, arousal: 0 } }) }),
    record('x', { account: body({ halfLifeHours: 0 }) }), record('x', { account: body({ appraisal: '\ud800' }) }), record('x', { account: body({ desires: ['a', 'b', 'c', 'd'] }) })]) await assert.rejects(write(service, input), { code: 'INVALID_BODY' });
  await assert.rejects(write(service, record(), LEAD, P, { context: context(B) }), { code: 'INVALID_BODY' });
  assert.equal((await service.load()).revision, 0);
}));
it('损坏账本、符号链接和硬链接均停止使用，不重置心情或改外部文件', async () => scene(async (service, org, f) => {
  await write(service); const raw = await readFile(service.file, 'utf8');
  await writeFile(service.file, '{bad'); await assert.rejects(service.query(spec()), { code: 'LEAD_AFFECT_INVALID' });
  await assert.rejects(write(service, record('later')), { code: 'LEAD_AFFECT_INVALID' });
  assert.equal(await readFile(service.file, 'utf8'), '{bad');
  if (process.platform === 'win32') return;
  const target = join(f.home, 'outside.json'); await writeFile(target, raw); await rm(service.file); await symlink(target, service.file);
  await assert.rejects(service.query(spec())); await rm(service.file); await link(target, service.file); await assert.rejects(write(service, record('later')));
  assert.equal(await readFile(target, 'utf8'), raw);
}));
it('工具真实接线，当前会话变更或关闭心智使在途写入失效', async () => scene(async (service, org, f) => {
  const session = sessionOf(); const host = { agent: { session }, project: P };
  const made = await runAction({ org, 项目: P, 主体: LEAD, 宿主: host, args: { action: 'lead_affect_update', 情绪: record() } });
  assert.ok(made.数据.id); assert.ok(ACTIONS.includes('lead_affect_update')); assert.ok(READ_ONLY_ACTIONS.includes('lead_affect_query')); assert.ok(!READ_ONLY_ACTIONS.includes('lead_affect_update'));
  await assert.rejects(runAction({ org, 项目: 'wrong', 主体: LEAD, 宿主: host, args: { action: 'lead_affect_query' } }), { code: 'DENIED' });
  org.mindConnection = await new ChatConnection(join(f.privateRoot, 'test-connection.json')).load();
  const execution = leadAffectExecution({ org, subject: LEAD, project: P, host });
  await org.mindConnection.set({ sessionId: LEAD.id, enabled: false, expectedRevision: 0 }, 0);
  await assert.rejects(service.update(execution.spec, record('late'), execution.options), { code: 'DENIED' });
  assert.equal((await service.load()).events.length, 1);
}));
it('审批冻结完整情绪入参；批准前无状态，批准后单步写入且批准不能复用', async () => scene(async (service, org, f) => {
  await f.writePrivate('集体L2-共享基础设施/defaults/部署.json', JSON.stringify({ 介入度: '审批' })); await org.policy.reload();
  const host = { agent: { session: sessionOf() }, project: P }; const args = { action: 'lead_affect_update', 情绪: record() }; let request;
  await assert.rejects(runAction({ org, 项目: P, 主体: LEAD, 宿主: host, args }), e => e.code === 'NEEDS_APPROVAL' && Boolean(request = e.detail.请求id));
  assert.equal((await service.load()).events.length, 0);
  await org.intervention.人侧决议({ 请求id: request, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证' });
  const made = await runAction({ org, 项目: P, 主体: LEAD, 宿主: host, args: { ...args, 审批引用: request } }); assert.ok(made.数据.id);
  await assert.rejects(runAction({ org, 项目: P, 主体: LEAD, 宿主: host, args: { ...args, 审批引用: request } }), { code: 'DENIED' });
}));
it('系统装配给B窗口带入共享情绪，成员/停用/失败不沿用旧段，原生快照撤掉已纠正缘由', async () => scene(async (service, org) => {
  const made = await write(service); const agent = { session: sessionOf(B) };
  const options = { org, agent, projectOf: () => P, logger: { warn() {} } };
  const first = await injectLeadAffect({ sections: [], contexts: [] }, options);
  const projected = projectMindRuntimeContext(first); assert.equal(projected.sections.length, 0);
  assert.equal(projected.contexts[0].name, LEAD_AFFECT_SECTION); assert.match(projected.contexts[0].text, /调试的尝试/);
  const stale = structuredClone(projected.contexts[0]); const nodes = [0]; const events = [{ type: 'user/message', seq: 0, data: { role: 'user', source: { kind: 'runtime-context', sections: [stale] }, content: [] } }];
  agent.session.surface = { nodes }; agent.session.eventAt = seq => events[seq];
  agent.session.append = (type, data) => { events.push({ type, data, seq: events.length }); nodes[0] = events.length - 1; };
  await write(service, { op: 'remove', epoch: 0, id: made.id, revision: 1, reason: '更正误解' });
  const second = projectMindRuntimeContext(await injectLeadAffect({ sections: [], contexts: [] }, options));
  retireMindRuntimeSnapshots(second, agent); assert.equal(events.length, 2); assert.doesNotMatch(JSON.stringify(events[1]), /调试的尝试/);
  const child = await injectLeadAffect(first, { ...options, agent: { session: { ...sessionOf(), header: { cwd: process.cwd(), origin: 'subagent' } } } }); assert.equal(child.sections.length, 0);
  const inactive = await injectLeadAffect(first, { ...options, active: () => false }); assert.equal(inactive.sections.length, 0);
  await writeFile(service.file, '{bad'); assert.equal((await injectLeadAffect(first, options)).sections.length, 0);
}));
it('真实kernel装配包含情绪工具schema及动态段，不依赖额外模型请求', async () => scene(async (service, org, f) => {
  await write(service); const host = fakeHost();
  await kernel.apply(host.ctx, { ...f, project: P, projectBindings: [{ path: process.cwd(), project: P }] });
  try {
    const tool = host.工具.get('mind'); assert.ok(tool.parameters.properties.情绪); assert.ok(tool.parameters.properties.action.enum.includes('lead_affect_query'));
    const hook = host.钩子.get('system-prompt/assemble').at(-1); const assembly = { sections: [], contexts: [], tools: [], variables: {} };
    const result = await hook(assembly, { agent: { session: sessionOf() } }, async () => assembly);
    assert.ok(result.contexts.some(s => s.name === LEAD_AFFECT_SECTION));
  } finally { host.清理(); }
}));
it('人侧查看、更正、停用和清空经认证同源端点，拒绝任意命令与自报模型事件', async () => scene(async (service, org) => {
  async function request(ctx, method = 'GET', body = null, headers = {}) {
    const req = { method, url: '/plugins/dsh-mind/lead-affect', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...headers }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    const res = { writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
    await leadAffect路由({ ctx, org, 项目: P })(req, res); return res;
  }
  const ctx = { get: () => ({ requestRejection: () => undefined }) };
  assert.equal((await request({ get: () => null })).status, 503);
  assert.equal((await request({ get: () => ({ requestRejection: () => 401 }) })).status, 401);
  assert.equal((await request(ctx, 'POST', { op: 'clear', expectedRevision: 0 }, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request(ctx, 'POST', { op: 'shell', command: 'no' })).status, 400);
  assert.equal((await request(ctx, 'POST', record())).status, 400);
  const made = await write(service);
  assert.equal((await request(ctx)).body.数据.entries[0].id, made.id);
  assert.equal((await request(ctx, 'POST', { op: 'clear', expectedRevision: 0 })).status, 409);
  assert.equal((await request(ctx, 'POST', { op: 'clear', expectedRevision: 1 })).status, 200);
  assert.deepEqual((await request(ctx)).body.数据.entries, []);
}));
