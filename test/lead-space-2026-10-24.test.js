import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, SOVEREIGN, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { LeadSpaceService, freeTimeLocal, freeTimeConfig, LEAD_SPACE_DEFAULTS } from '../src/lead-space.js';
import { createLeadSpaceHooks, injectLeadSpace, LEAD_SPACE_SECTION } from '../components/kernel/lib/lead-space-hooks.js';
import { leadSpace路由 } from '../components/kernel/lib/routes.js';
import { runAction } from '../lib/actions.js';

const P = 'lead-free-time';
const spec = (subject = LEAD, project = P) => ({ subject, project, session: subject.id });
const human = () => spec(SOVEREIGN);
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project: P });
  let now = Date.parse('2026-10-24T02:00:00Z');
  // Presence checks use now(); keep them on the same frozen clock as activity and approvals.
  org.clock.now = () => new Date(now); org.clock.ms = () => now; org.clock.iso = () => new Date(now).toISOString();
  try { await run(org.leadSpace, org, f, value => { now = Date.parse(value); }); }
  finally { org.leadSpaceHooks?.stop(); await org.leadSpaceHooks?.flush(); await org.observability.flush(); await f.cleanup(); }
}
async function enable(service, extra = {}) {
  const s = await service.load(); return service.configure(human(), { expectedRevision: s.revision, config: { ...s.config, enabled: true, timezone: 'Asia/Shanghai', ...extra } });
}
const sessionOf = () => ({ id: LEAD.id, header: { cwd: process.cwd() }, isOwnSeq: () => true, requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture' } }) });
function hooksFor(org, choose) {
  const seen = [];
  const llm = { async prepareCall(config, signal) {
    seen.push(config); return { config, async *stream(options) {
      assert.equal(options.tools, undefined); assert.equal(options.signal.aborted, false);
      const result = await choose(JSON.parse(options.messages[0].content[0].text), options, seen.length);
      yield { type: 'block-end', index: 0, block: { type: 'text', text: JSON.stringify(result) } };
      yield { type: 'finish', reason: { kind: 'stop' } };
    } };
  } };
  const hooks = createLeadSpaceHooks({ org, projectOf: () => P, llmOf: () => llm, logger: { warn() {} } });
  org.leadSpaceHooks = hooks; return { hooks, seen };
}
it('自由活动时区、时段与预算输入有明确上限', () => {
  assert.deepEqual(freeTimeLocal(new Date('2026-10-24T02:00:00Z'), 'Asia/Shanghai'), { day: '2026-10-24', time: '10:00' });
  for (const extra of [{ dailyCalls: 5 }, { seconds: 61 }, { times: ['10:00', '10:00'] }, { times: ['24:00'] }, { timezone: '../../bad' }, { shell: true }]) assert.throws(() => freeTimeConfig({ ...LEAD_SPACE_DEFAULTS, ...extra }));
});
it('真实Lead可不建任务留下随笔，正文只在Markdown，成员不可读，关系和项目隔离', async () => scene(async (service, org) => {
  const n = await service.update(spec(), { op: 'write', title: '没写完的小鱼', text: '小鱼今天想当一朵云。' });
  assert.match(n.path, /自由空间.*随笔/);
  const got = await service.query(spec(), { id: n.id }); assert.equal(got.text, '小鱼今天想当一朵云。');
  assert.equal((await service.query(human())).total, 1);
  await assert.rejects(service.query(spec(MEMBER)), /Lead/);
  assert.equal((await service.query(spec(LEAD, 'other-project'))).total, 0);
  assert.equal((await org.memory.query({ subject: LEAD, 类: '经历', 项目: P })).条目.length, 0);
  assert.ok(!(await readFile(service.file, 'utf8')).includes('小鱼'));
  const reopened = new LeadSpaceService({ org, clock: org.clock }); assert.equal((await reopened.query(spec(), { id: n.id })).text, got.text);
}));
it('修订需要版本与指纹，人侧修订不会被模型覆盖；删除草稿不强留正文历史', async () => scene(async service => {
  const n = await service.update(spec(), { op: 'write', title: '随笔', text: '初稿' });
  await assert.rejects(service.update(spec(), { op: 'write', id: n.id, revision: n.revision, hash: 'wrong', title: '改', text: '改' }), /变化/);
  const edited = await service.update(human(), { op: 'write', id: n.id, revision: n.revision, hash: n.hash, title: '随笔', text: '人的修正' });
  await assert.rejects(service.update(spec(), { op: 'write', id: n.id, revision: edited.revision, hash: edited.hash, title: '随笔', text: '恢复初稿' }), /人侧修订/);
  await service.update(human(), { op: 'remove', id: n.id, revision: edited.revision, hash: edited.hash });
  assert.equal((await service.query(human())).total, 0); await assert.rejects(readFile(n.path), { code: 'ENOENT' });
}));
it('随笔拒绝路径穿越、符号链接和硬链接，不修改核心人设', async () => scene(async (service, org, f) => {
  await assert.rejects(service.query(spec(), { id: '../../核心人设' }), /不存在|范围/);
  const n = await service.update(spec(), { op: 'write', title: '一', text: '一' });
  if (process.platform === 'win32') return;
  const { rm } = await import('node:fs/promises'); await rm(n.path);
  const target = join(f.home, 'outside.md'); await writeFile(target, '不能动'); await symlink(target, n.path);
  await assert.rejects(service.query(spec()), /核心人设文件不可用/); assert.equal(await readFile(target, 'utf8'), '不能动');
  await rm(n.path); await link(target, n.path); await assert.rejects(service.query(spec()), /核心人设文件不可用/);
}));
it('设置只能由人侧调整，过期版本被拒；模型无法扩权或配置活动', async () => scene(async service => {
  await assert.rejects(service.configure(spec(), { expectedRevision: 0, config: { ...LEAD_SPACE_DEFAULTS, enabled: true } }), /只有已认证/);
  await enable(service); await assert.rejects(service.configure(human(), { expectedRevision: 0, config: { ...LEAD_SPACE_DEFAULTS } }), /变化/);
  await assert.rejects(service.update(spec(), { op: 'write', title: 'x', text: 'x', scope: { relationship: null } }), /只接受/);
}));
it('同一时段并发只认领一次、失败不返还；跨时区改设置不能刷预算', async () => scene(async (service, org, f, time) => {
  await enable(service);
  const wakes = await Promise.all([service.reserve(spec()), service.reserve(spec())]); const wake = wakes.find(Boolean);
  assert.equal(wakes.filter(Boolean).length, 1);
  await service.reserveCall(spec(), wake); await service.reserveCall(spec(), wake);
  await assert.rejects(service.reserveCall(spec(), wake), /预算/);
  await service.finish(wake, 'failed', new Error('fail'));
  assert.equal(await service.reserve(spec()), null); assert.equal((await service.load()).usage['2026-10-24'].calls, 2);
  time('2026-10-24T12:00:00Z'); const second = await service.reserve(spec()); assert.ok(second);
  await service.reserveCall(spec(), second); await service.reserveCall(spec(), second); await service.finish(second, 'rested');
  await enable(service, { timezone: 'UTC', times: ['12:00'] }); assert.equal(await service.reserve(spec()), null);
  time('2026-10-25T12:00:01Z'); const next = await service.reserve(spec()); assert.ok(next);
}));
it('停用和设置变动立即使在途提交及调用失效；超时和漏过时段不补跑', async () => scene(async (service, org, f, time) => {
  await enable(service); const wake = await service.reserve(spec());
  await enable(service, { enabled: false }); await assert.rejects(service.reserveCall(spec(), wake), /关闭|变化/);
  await assert.rejects(service.update(spec(), { op: 'write', title: '晚到', text: '不可提交' }, { global: true, check: () => service.check(spec(), wake) }), /关闭|变化/);
  assert.equal((await service.query(human())).total, 0);
  await enable(service); time('2026-10-24T02:31:00Z'); assert.equal(await service.reserve(spec()), null);
  time('2026-10-24T12:00:00Z'); const second = await service.reserve(spec()); time('2026-10-24T12:01:01Z'); await assert.rejects(service.reserveCall(spec(), second), /时间预算/);
}));
it('重启保留已消耗额度且不重放未知活动', async () => scene(async service => {
  await enable(service); const wake = await service.reserve(spec()); await service.reserveCall(spec(), wake);
  await service.locked(state => { state.wakes[0].pid = 99999999; }); await service.recover();
  assert.equal((await service.load()).wakes[0].state, 'interrupted'); assert.equal(await service.reserve(spec()), null);
  assert.equal((await service.load()).usage[wake.day].calls, 1);
}));
it('空闲唤醒允许休息，不造任务和记忆、不发送消息，重复节拍无额外调用', async () => scene(async (service, org) => {
  await enable(service); const { hooks, seen } = hooksFor(org, () => ({ activity: 'rest', writing: null, material: null }));
  await hooks.tick(); assert.equal(seen.length, 0);
  hooks.bind(sessionOf()); await Promise.all([hooks.tick(), hooks.tick()]); await hooks.flush(); await hooks.tick();
  assert.equal(seen.length, 1); assert.equal(seen[0].maxTokens, 1500); assert.equal((await service.load()).wakes[0].state, 'rested');
  assert.equal((await service.query(human())).total, 0); assert.equal(hooks.health().notifications, false);
}));
it('自由创作能跨会话保留自身草稿，不自动晋升正式记忆，模型返回越权字段整次拒绝', async () => scene(async (service, org, f, time) => {
  await enable(service); let malicious = false;
  const { hooks } = hooksFor(org, () => ({ activity: 'write', material: null, writing: { title: '雨的尾巴', text: '雨把尾巴留在了窗外。', share: true, ...(malicious ? { op: 'remove' } : {}) } }));
  hooks.bind(sessionOf()); await hooks.tick(); const page = await service.query(human()); assert.equal(page.total, 1);
  const n = await service.query(spec(), { id: page.entries[0].id }); assert.equal(n.scope.relationship, null); assert.equal(n.scope.project, null);
  assert.equal((await org.memory.query({ subject: LEAD, 类: '偏好', 项目: P })).条目.length, 0);
  malicious = true; time('2026-10-24T12:00:00Z'); await hooks.tick(); assert.equal((await service.query(human())).total, 1);
  assert.equal((await service.load()).wakes.at(-1).state, 'failed');
}));
it('自主阅读只能选公开跨项目材料，正式知识沿原账本落账并有真实引用', async () => scene(async (service, org) => {
  const publicScope = { project: null, audience: 'auto', roles: [], relationship: null };
  const material = await org.information.deposit(human(), { producer: 'fixture', externalId: 'public', title: '笛声', text: '竹笛可以模仿鸟鸣。', coverage: '合成资料', scope: publicScope });
  await org.information.deposit(human(), { producer: 'fixture', externalId: 'private', title: '不能泄露的私事', text: '不该进入自由创作', coverage: '合成资料', scope: { ...publicScope, audience: 'lead', relationship: LEAD.id } });
  await enable(service);
  const { hooks, seen } = hooksFor(org, (input, options) => {
    if (input.materials) { assert.deepEqual(input.materials.map(m => m.id), [material.id]); assert.ok(!JSON.stringify(input).includes('不能泄露')); return { activity: 'read', writing: null, material: material.id }; }
    assert.equal(input.source.text, '竹笛可以模仿鸟鸣。');
    return { records: [{ type: 'growth', kind: '知识', title: '笛声的模仿', text: '资料提出竹笛可以模仿鸟鸣，尚待实际听辨。', quote: '竹笛可以模仿鸟鸣。', roles: ['Lead'] }] };
  });
  hooks.bind(sessionOf()); await hooks.tick(); assert.equal(seen.length, 2);
  const knowledge = await org.memory.query({ subject: LEAD, 类: '知识', 项目: P }); assert.equal(knowledge.条目.length, 1);
  assert.ok(knowledge.条目[0].id.startsWith('know-')); assert.ok(knowledge.条目[0].收录.refs.length);
}));
it('前台回合打断在途创作，不留迟到正文，已准入请求仍占额度', async () => scene(async (service, org) => {
  await enable(service); let release; const ready = new Promise(r => { release = r; }); let entered;
  const started = new Promise(r => { entered = r; });
  const { hooks } = hooksFor(org, async () => { entered(); await ready; return { activity: 'write', material: null, writing: { title: '迟到', text: '不保存', share: false } }; });
  const callbacks = new Map(); hooks.attach({ on: (name, fn) => { callbacks.set(name, fn); return () => callbacks.delete(name); } });
  const session = sessionOf(); hooks.bind(session); const work = hooks.tick(); await started;
  callbacks.get('session/event')(session, { seq: 1, type: 'turn/start' }); release(); await work;
  assert.equal((await service.query(human())).total, 0); assert.equal((await service.load()).usage['2026-10-24'].calls, 1);
  assert.equal((await service.load()).wakes[0].state, 'interrupted'); assert.equal(hooks.health().lastFailure, null);
}));
it('模型动作和上下文说明直接入口；个人知识默认拥有关系隔离', async () => scene(async (service, org) => {
  const session = sessionOf(); const host = { agent: { session }, project: P };
  const write = await runAction({ org, 项目: P, 主体: LEAD, args: { action: 'lead_space_update', 自由空间: { op: 'write', title: '自记', text: '没有任务' } }, 宿主: host });
  assert.ok(write.数据.id);
  await assert.rejects(runAction({ org, 项目: 'other', 主体: LEAD, args: { action: 'lead_space_query' }, 宿主: host }), { code: 'DENIED' });
  const record = await runAction({ org, 项目: P, 主体: LEAD, args: { action: 'memory_write', 类: '知识', 内容: '我的待验证理解', 来源: '自己的推断，待验证', 岗位: 'Lead' }, 宿主: host });
  const memory = await org.memory.query({ subject: LEAD, 类: '知识', 项目: P, id: record.条目.id });
  assert.equal(memory.条目[0].数据归属.范围.relationship, await org.dataOwnership.relationship(LEAD.id));
  const hooks = { bind() {}, health: () => ({ bound: true }) };
  const out = await injectLeadSpace({ sections: [] }, { org, agent: { session }, hooks, projectOf: () => P });
  assert.match(out.sections.find(s => s.name === LEAD_SPACE_SECTION).text, /不必先建任务/);
}));
it('自由空间人侧路由认证、同源、配置冲突和任意动作拒绝', async () => scene(async (service, org) => {
  async function request(ctx, method, body, extra = {}) {
    const req = { method, url: '/plugins/dsh-mind/lead-space', headers: { host: '127.0.0.1:3080', origin: 'http://127.0.0.1:3080', 'sec-fetch-site': 'same-origin', 'content-type': 'application/json', ...extra }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
    const res = { writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
    await leadSpace路由({ org, ctx, 项目: P })(req, res); return res;
  }
  const ctx = { get: () => ({ requestRejection: () => undefined }) };
  assert.equal((await request({ get: () => null }, 'GET')).status, 503);
  assert.equal((await request({ get: () => ({ requestRejection: () => 401 }) }, 'GET')).status, 401);
  assert.equal((await request(ctx, 'GET', null, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await request(ctx, 'GET')).status, 200);
  assert.equal((await request(ctx, 'POST', { op: 'shell', command: 'echo nope' })).status, 400);
  await enable(service);
  assert.equal((await request(ctx, 'POST', { op: 'configure', expectedRevision: 0, config: LEAD_SPACE_DEFAULTS })).status, 409);
}));
it('审批档冻结草稿完整入参，批准前无正文，批准后单步重放且不可复用', async () => scene(async (service, org, f) => {
  await f.write('集体L2-共享基础设施/defaults/介入度.json', JSON.stringify({ 介入度: '审批' })); await org.policy.reload();
  const args = { action: 'lead_space_update', 自由空间: { op: 'write', title: '随手想法', text: '先审批再保存' } };
  const host = { agent: { session: sessionOf() }, project: P }; let request;
  await assert.rejects(runAction({ org, 项目: P, 主体: LEAD, args, 宿主: host }), error => error.code === 'NEEDS_APPROVAL' && Boolean(request = error.detail.请求id));
  assert.equal((await service.query(human())).total, 0);
  await org.intervention.人侧决议({ 请求id: request, 决定: '批准', 通道: '设置页', 认证: '宿主 Connection 已认证' });
  const out = await runAction({ org, 项目: P, 主体: LEAD, args: { ...args, 审批引用: request }, 宿主: host }); assert.ok(out.数据.id);
  assert.equal((await service.query(human())).total, 1);
  await assert.rejects(runAction({ org, 项目: P, 主体: LEAD, args: { ...args, 审批引用: request }, 宿主: host }), { code: 'DENIED' });
}));
it('损坏计量不会归零重跑；公开自由阅读不接入私人来源和私人既有理解', async () => scene(async (service, org) => {
  await enable(service); await service.locked(state => { state.usage['2026-10-24'] = { calls: -1 }; });
  await assert.rejects(service.reserve(spec()), { code: 'LEAD_SPACE_INVALID' });
  const scope = { project: null, audience: 'lead', roles: [], relationship: LEAD.id };
  const item = await org.information.deposit(human(), { producer: 'fixture', externalId: 'private', title: '私人', text: '私事不可选', coverage: '合成资料', scope });
  assert.equal(await org.information.prepareLearning(spec(), { publicOnly: true, materialId: item.id }), null);
}));
