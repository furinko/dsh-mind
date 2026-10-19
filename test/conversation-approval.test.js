import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, unlink } from 'node:fs/promises';
import { makeFixture } from './helpers.mjs';
import { Org } from '../src/org.js';
import { intervention路由 } from '../components/kernel/lib/routes.js';
import { ACTIONS } from '../lib/actions.js';
import { canonical, digest } from '../src/kernel/text.js';

const A = 'session-exact-owner-a';
const B = 'b-unprefixed-owner';
async function fixture(fn) {
  const f = await makeFixture({ defaults: { 介入度: '审批' } });
  try { const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: 'default' }); await fn(org, f); }
  finally { await f.cleanup(); }
}
function spec(id = A, project = 'plugins', text = '完整冻结正文') {
  return { subject: { id, kind: 'Lead' }, action: 'write', args: { 内容: text }, 项目: project, 档位: '审批', 步骤: [{ 动作: 'write', 目标: { kind: '产物', id: 'artifact-test' }, 说明: '写冻结内容', 预览: { 内容: text } }] };
}
function request(method = 'GET', session = A, body, extra = {}) {
  return { method, url: '/plugins/dsh-mind/intervention' + (session === null ? '' : '?sessionId=' + encodeURIComponent(session)), headers: { host: '127.0.0.1:7710', 'sec-fetch-site': 'same-origin', ...(body ? { 'content-type': 'application/json' } : {}), ...extra }, async *[Symbol.asyncIterator]() { if (body) yield Buffer.from(JSON.stringify(body)); } };
}
async function call(org, req, rejection = undefined) {
  const res = { status: 0, writeHead(status) { this.status = status; }, end(body) { this.body = JSON.parse(body); } };
  const ctx = { get: name => name === 'connection' ? { requestRejection() { return rejection; } } : undefined };
  await intervention路由({ org, 项目: 'default', ctx })(req, res); return res;
}
async function preview(org, id, session = A) { const res = await call(org, request('GET', session)); assert.equal(res.status, 200); return res.body.待决.find(row => row.请求id === id); }
function decision(row, type = '批准') { return { 请求id: row.请求id, 决定: type, 审阅指纹: row.审阅指纹 }; }

test('会话路由无默认项目猜测：原样会话精确筛选，跨项目同会话保留真实项目和完整冻结计划', () => fixture(async org => {
  const a = await org.intervention.记请求(spec());
  await org.intervention.记请求(spec(A, 'second-project', '同会话另一项目'));
  await org.intervention.记请求(spec(B, 'plugins', '绝不能泄露另一会话正文'));
  const res = await call(org, request());
  assert.equal(res.status, 200); assert.equal(res.body.会话, A); assert.equal(res.body.待决.length, 2);
  assert.deepEqual(res.body.待决.map(x => x.项目).sort(), ['plugins', 'second-project']);
  assert.ok(res.body.待决.every(x => x.原主体.id === A));
  assert.ok(!JSON.stringify(res.body).includes('绝不能泄露'));
  const row = res.body.待决.find(x => x.请求id === a.请求id);
  assert.deepEqual(row.完整请求, { 内容: '完整冻结正文' }); assert.equal(row.步骤[0].预览.内容, '完整冻结正文'); assert.match(row.审阅指纹, /^[a-f0-9]{64}$/);
  assert.equal((await call(org, request('GET', null))).status, 400);
  assert.equal((await call(org, request('GET', ''))).status, 400);
  assert.deepEqual((await call(org, request('GET', 'unknown-exact-id'))).body.待决, []);
}));

test('真实路由仍前置Connection和同源栅栏，标记头/模型主体/跨站不能代替认证', () => fixture(async org => {
  await org.intervention.记请求(spec());
  for (const rejection of [401, 403]) {
    const res = await call(org, request('GET', A, undefined, { 'x-dsh-mind-panel': '1' }), rejection);
    assert.equal(res.status, rejection); assert.equal(res.body.成功, false); assert.ok(!res.body.待决);
  }
  const cross = await call(org, request('GET', A, undefined, { 'sec-fetch-site': 'cross-site' })); assert.equal(cross.status, 403);
  const row = (await org.intervention.人侧待决({ 会话: A }))[0];
  assert.equal((await call(org, request('POST', A, decision(row), { 'sec-fetch-site': 'cross-site' }))).status, 403);
  assert.ok(Array.isArray(ACTIONS) && ACTIONS.includes('task_create'), '先确认读到真实非空动作数组');
  assert.ok(['人侧决议', 'intervention', 'approve', 'intervention_resolve'].every(action => !ACTIONS.includes(action)), '模型动作表无批准入口');
  assert.equal((await org.audit.read({})).filter(x => x.动作 === '介入决议').length, 0);
}));

test('决议强制预览指纹和原申请者会话，body不能声明身份或替换冻结参数', () => fixture(async org => {
  const r = await org.intervention.记请求(spec()); const row = await preview(org, r.请求id);
  const initial = (await org.audit.read({})).length;
  await assert.rejects(() => org.intervention.人侧决议({ 请求id: r.请求id, 决定: '批准', 会话: B, 通道: '隔离人侧适配器', 认证: '测试认证事实' }), /不属于此会话/, '直接域入口的会话绑定不借审阅过滤代偿');
  assert.equal((await call(org, request('POST', A, { 请求id: r.请求id, 决定: '批准' }))).status, 400);
  assert.equal((await call(org, request('POST', null, decision(row)))).status, 400);
  assert.equal((await call(org, request('POST', B, decision(row)))).body.成功, false);
  assert.equal((await call(org, request('POST', A, { ...decision(row), 审阅指纹: 'stale' }))).body.成功, false);
  assert.equal((await org.audit.read({})).length, initial);
  const ok = await call(org, request('POST', A, { ...decision(row), 主体: { id: 'model-owner', kind: '主权者' }, args: { 内容: '置换' } }));
  assert.equal(ok.status, 200); assert.equal(ok.body.主体.id, 'sovereign');
  assert.equal((await org.intervention.读冻结({ 请求id: r.请求id, subject: { id: A } })).入参.内容, '完整冻结正文');
  assert.equal((await preview(org, r.请求id)).状态, '已批准待重放');
  assert.equal((await org.audit.read({})).filter(x => x.动作 === '介入放行占用' || x.动作 === '介入完成').length, 0, '人侧批准不重放原写');
}));

test('并发双击批准与拒绝只产生一条决议，过期预览不得重复副作用', () => fixture(async org => {
  const r = await org.intervention.记请求(spec()); const row = await preview(org, r.请求id);
  const replies = await Promise.all([call(org, request('POST', A, decision(row))), call(org, request('POST', A, decision(row, '拒绝')))]);
  assert.equal(replies.filter(x => x.body.成功).length, 1);
  assert.equal((await org.audit.read({})).filter(x => x.动作 === '介入决议').length, 1);
  assert.equal((await call(org, request('POST', A, decision(row)))).body.成功, false);
}));

test('批准拒绝撤销均回读真实状态，重建Org后仍从唯一账本恢复', () => fixture(async (org, f) => {
  const r = await org.intervention.记请求(spec()); const row = await preview(org, r.请求id);
  assert.equal((await call(org, request('POST', A, decision(row, '拒绝')))).body.成功, true);
  assert.equal((await preview(org, r.请求id)).状态, '已拒绝');
  const rebuilt = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: 'default' });
  assert.equal((await preview(rebuilt, r.请求id)).状态, '已拒绝');
  const r2 = await org.intervention.记请求(spec(A, 'plugins', '可撤销的另一单')); const row2 = await preview(org, r2.请求id);
  assert.equal((await call(org, request('POST', A, decision(row2)))).body.成功, true);
  const approved = await preview(org, r2.请求id); assert.notEqual(approved.审阅指纹, row2.审阅指纹);
  assert.equal((await call(org, request('POST', A, decision(approved, '撤销')))).body.成功, true);
  assert.equal((await preview(org, r2.请求id)).状态, '已撤销');
}));

test('冻结内容篡改且自重算摘要仍不能换掉账本绑定，缺记录也不能盲批', () => fixture(async (org, f) => {
  const r = await org.intervention.记请求(spec()); const row = await preview(org, r.请求id);
  const file = org.layout.private('介入请求', r.请求id + '.json'); const original = await readFile(file, 'utf8');
  const changed = JSON.parse(original); changed.入参.内容 = '篡改正文'; delete changed.内容摘要; changed.内容摘要 = digest(canonical(changed));
  await writeFile(file, JSON.stringify(changed));
  const corrupt = await preview(org, r.请求id); assert.match(corrupt.记录问题, /账本不符/); assert.equal(corrupt.完整请求, undefined);
  assert.equal((await call(org, request('POST', A, decision(row)))).body.成功, false);
  await unlink(file); const missing = await preview(org, r.请求id); assert.match(missing.记录问题, /缺失/);
  assert.equal((await call(org, request('POST', A, decision(row)))).body.成功, false);
  assert.equal((await org.audit.read({})).filter(x => x.动作 === '介入决议').length, 0);
}));

test('钉版/档位变化使旧审阅指纹失效，批准不能用旧预览绕过现行状态', () => fixture(async org => {
  let card = 'card-version-a'; org.intervention.卡版本Of = async () => card;
  const r = await org.intervention.记请求(spec()); const row = await preview(org, r.请求id);
  card = 'card-version-b'; assert.equal((await preview(org, r.请求id)).状态, '已失效');
  assert.equal((await call(org, request('POST', A, decision(row)))).body.成功, false);
  assert.equal((await org.audit.read({})).filter(x => x.动作 === '介入决议').length, 0);
}));

test('非法请求id在请求锁前硬拒，不能借决议路径创建任意锁目录', () => fixture(async org => {
  const before = await readdir(org.layout.privateRoot, { recursive: true });
  const res = await call(org, request('POST', A, { 请求id: '../../outside', 决定: '批准', 审阅指纹: 'invalid' }));
  assert.equal(res.body.成功, false); assert.match(res.body.理由, /合法请求id/);
  assert.deepEqual(await readdir(org.layout.privateRoot, { recursive: true }), before);
}));
