import { it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { mkdir, writeFile, readFile, link, rm, symlink, readdir } from 'node:fs/promises';
import { Org } from '../src/org.js';
import { ACTIONS, COMMAND_ONLY_ACTIONS } from '../lib/actions.js';
import { createPersonaCoreSettings } from '../components/kernel/lib/persona-core-settings.js';
import { personaCore路由, 端点表 } from '../components/kernel/lib/routes.js';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { settingsScene } from '../components/board/test/settings-fixture.mjs';
import { jsonResponse } from '../components/board/test/client-harness.mjs';

async function scene(run) {
  const f = await makeFixture();
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: 'persona-settings' });
  const settings = createPersonaCoreSettings({ org, project: 'persona-settings' });
  const connection = { requestRejection(req) { assert.equal(this, connection); return req.headers.cookie === 'human-session' ? undefined : 401; } };
  const ctx = { get: name => name === 'connection' ? connection : undefined };
  const handler = personaCore路由({ ctx, settings });
  async function request(method = 'GET', body, headers = {}) {
    const req = { method, headers: { cookie: 'human-session', host: 'localhost:19387', 'sec-fetch-site': 'same-origin', ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
      async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)); } };
    const res = { status: 0, body: null, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
    await handler(req, res);
    return res;
  }
  try { await run({ f, org, settings, request, ctx }); }
  finally { await org.observability.flush(); await f.cleanup(); }
}
const data = async t => (await t.request()).body.数据;

it('认证设置页创建、修改和留空停用；原只读服务每步取得新版本，正文不复制进审计', () => scene(async t => {
  const initial = await data(t);
  assert.equal(initial.state, 'missing');
  assert.equal(existsSync(t.org.personaCore.file()), false, '读取不创建卡');
  const text = '# 核心人设\n保持好奇。🙂\r\n';
  const saved = await t.request('POST', { text, expectedFingerprint: initial.fingerprint });
  assert.equal(saved.status, 200); assert.equal(saved.body.成功, true);
  assert.equal(await readFile(initial.file, 'utf8'), text);
  const frame = await t.org.personaCore.read({ subject: LEAD, project: 'persona-settings' });
  assert.equal(frame.text, text);
  const current = await data(t);
  assert.equal(current.fingerprint, saved.body.requestedFingerprint);
  const cleared = await t.request('POST', { text: '', expectedFingerprint: current.fingerprint });
  assert.equal(cleared.body.成功, true);
  assert.equal((await data(t)).state, 'empty');
  assert.notEqual((await data(t)).fingerprint, initial.fingerprint, '空文件与不存在须有不同版本');
  assert.equal(await t.org.personaCore.read({ subject: LEAD, project: 'persona-settings' }), null);
  assert.equal(t.org.personaCore.isCurrent(frame), false);
  const files = await readdir(t.org.layout.auditDir());
  const logs = await Promise.all(files.filter(f => /^audit-.*\.jsonl$/.test(f)).map(f => readFile(join(t.org.layout.auditDir(), f), 'utf8')));
  assert.ok(logs.join('').includes('核心人设设置变更'));
  assert.equal(logs.join('').includes('保持好奇'), false);
  assert.equal(typeof t.org.personaCore.write, 'undefined');
  assert.ok(![...ACTIONS, ...COMMAND_ONLY_ACTIONS].some(x => /persona.?core/.test(x)));
  assert.equal(端点表.personaCore, '/plugins/dsh-mind/persona-core');
}));

it('两个相同版本并发保存仅一份提交；外部手改后的旧草稿返回409并保留原卡', () => scene(async t => {
  const initial = await data(t);
  const results = await Promise.all(['first', 'second'].map(text => t.request('POST', { text, expectedFingerprint: initial.fingerprint })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const before = await data(t);
  await writeFile(before.file, 'external human edit');
  const conflict = await t.request('POST', { text: 'stale draft', expectedFingerprint: before.fingerprint });
  assert.equal(conflict.status, 409); assert.equal(conflict.body.commit.state, 'not-started');
  assert.equal(await readFile(before.file, 'utf8'), 'external human edit');
}));

it('缺少认证、跨站请求、伪造主体/路径、非法正文均不能写卡', () => scene(async t => {
  const first = await data(t);
  const input = { text: 'human only', expectedFingerprint: first.fingerprint };
  assert.equal((await t.request('GET', undefined, { cookie: '' })).status, 401);
  assert.equal((await t.request('POST', input, { cookie: '' })).status, 401);
  assert.equal((await t.request('GET', undefined, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await t.request('POST', input, { 'sec-fetch-site': 'cross-site' })).status, 403);
  assert.equal((await t.request('POST', input, { 'content-type': 'text/plain' })).status, 415);
  assert.equal((await t.request('DELETE')).status, 405);
  assert.equal((await t.request('POST', '{broken')).status, 400);
  assert.equal((await t.request('POST', 'x'.repeat(65537))).status, 413);
  for (const body of [{ ...input, path: 'elsewhere' }, { ...input, subject: { kind: '主权者' } }, { ...input, text: '\ud800' }, { ...input, text: 'x\0' }, { ...input, text: '🙂'.repeat(3001) }, { text: 'no version' }]) {
    assert.equal((await t.request('POST', body)).status, 400);
  }
  assert.equal(existsSync(first.file), false);
  const unavailable = personaCore路由({ ctx: { get() {} }, settings: t.settings });
  const response = { writeHead(status) { this.status = status; }, end() {} };
  await unavailable({ method: 'GET', headers: {} }, response);
  assert.equal(response.status, 503);
}));

it('真实策略只允许人侧写核心卡；模型形状主体不能获得同等写权限', () => scene(async t => {
  const target = { id: '核心人设', kind: '身份', authority: '宪章', zone: '私有', domain: '个体', project: 'persona-settings' };
  for (const subject of [LEAD, MEMBER]) assert.equal((await t.org.policy.decide({ subject, action: 'write', target, context: {} })).verdict, 'deny');
  const first = await data(t);
  t.org.policy.check = async () => { throw Object.assign(new Error('policy denied'), { code: 'DENIED' }); };
  assert.equal((await t.request('POST', { text: 'blocked', expectedFingerprint: first.fingerprint })).status, 403);
  assert.equal(existsSync(first.file), false);
}));

it('符号链接祖先、硬链接、目录及坏编码保留原件并拒绝设置页读写', () => scene(async t => {
  const first = await data(t);
  await mkdir(dirname(first.file), { recursive: true });
  const other = join(t.f.home, 'linked-card'); await writeFile(other, 'original');
  await link(other, first.file);
  assert.equal((await t.request()).status, 503);
  assert.equal((await t.request('POST', { text: 'replacement', expectedFingerprint: first.fingerprint })).status, 503);
  assert.equal(await readFile(other, 'utf8'), 'original'); await rm(first.file);
  await mkdir(first.file); assert.equal((await t.request()).status, 503); await rm(first.file, { recursive: true });
  await writeFile(first.file, Buffer.from([0xc3, 0x28])); assert.equal((await t.request()).status, 503); await rm(first.file);
  await rm(dirname(first.file), { recursive: true });
  const elsewhere = join(t.f.home, 'elsewhere'); await mkdir(elsewhere);
  await symlink(elsewhere, dirname(first.file), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await t.request()).status, 503);
  assert.equal((await t.request('POST', { text: 'replacement', expectedFingerprint: first.fingerprint })).status, 503);
  assert.deepEqual(await readdir(elsewhere), []);
}));

it('审计失败报告已写入但未完整确认；UTF-8 BOM 与3000个非BMP字符回读不丢字', () => scene(async t => {
  const first = await data(t);
  const text = '🙂'.repeat(3000);
  assert.equal((await t.request('POST', { text, expectedFingerprint: first.fingerprint })).body.成功, true);
  assert.equal((await data(t)).text, text);
  const before = await data(t);
  t.org.audit.append = async () => { throw new Error('audit unavailable'); };
  const result = await t.request('POST', { text: '\ufeff# 人设\r\n', expectedFingerprint: before.fingerprint });
  assert.equal(result.status, 503); assert.equal(result.body.成功, false);
  assert.equal(result.body.commit.state, 'written'); assert.equal(result.body.audit.state, 'failed');
  assert.equal((await data(t)).text, '\ufeff# 人设\r\n');
}));

it('实际注册的设置组件经认证路由写入隔离卡，下一次根Lead读取立即采用新正文', () => scene(async t => {
  const pending = new Set();
  const ui = await settingsScene({ personaRequest(url, init) {
    const run = t.request(init.method, init.body);
    pending.add(run);
    return run.then(result => jsonResponse(result.body, result.status)).finally(() => pending.delete(run));
  } });
  async function settled() {
    while (pending.size) { await Promise.all([...pending]); await ui.flush(); }
  }
  try {
    await settled();
    ui.change('核心人设内容', '# 人侧新卡\n表达自然，有自己的判断。');
    await ui.click('保存核心人设'); await settled();
    assert.match(ui.text(), /核心人设已保存并回读一致/);
    assert.equal((await t.org.personaCore.read({ subject: LEAD, project: 'persona-settings' })).text, '# 人侧新卡\n表达自然，有自己的判断。');
    ui.change('核心人设内容', ''); await ui.click('保存核心人设'); await settled();
    assert.equal(await t.org.personaCore.read({ subject: LEAD, project: 'persona-settings' }), null);
  } finally { ui.close(); }
}));
