import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, makeSlots, makeCtx, makeSessions, makeStrictRequire, createRenderer, collect, textOf, jsonResponse, settle } from './client-harness.mjs';
import { makeFixture } from '../../../test/helpers.mjs';
import { Org } from '../../../src/org.js';
import { intervention路由 } from '../../kernel/lib/routes.js';

const A = 'session-owner-a-exact'; const B = 'owner-b-no-prefix';
function row(id = 'r1', owner = A, extra = {}) {
  return { 请求id: id, 项目: 'plugins', 原主体: { id: owner, kind: 'Lead', 卡版本: 'card-v1' }, 目标: { id: 'task1', kind: '任务', 代: 4 }, 动作: 'task_submit', 档位: '审批', 状态: '待放行', 冻结于: '2026-10-18T12:00:00Z', 审阅指纹: 'preview-'+id, 内容摘要: 'digest-'+id, 完整请求: { id: 'task1', 结论: '完整正文尾：NEVER-TRUNCATE' }, 步骤: [{ 序: 1, 动作: 'write', 说明: '冻结计划', 目标: { kind: '任务', id: 'task1' }, 预览: { 正文: '计划尾：STEP-END' } }], 可选项: ['批准','拒绝','撤销'], ...extra };
}
function env(handler, options = {}) {
  const calls = []; const pending = new Set(); const loaded = loadClient({ fetch: async (url, init) => {
    if (url.startsWith('/plugins/dsh-mind/intervention')) {
      const req = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }; calls.push(req);
      const work = Promise.resolve().then(() => handler(req)); pending.add(work);
      try { return await work; } finally { pending.delete(work); }
    }
    return jsonResponse({ 成功: true });
  }, ...options });
  const strict = makeStrictRequire(); const plugin = loaded.definition.factory(strict.require); const {slots, calls: registrations} = makeSlots();
  const native = { name: 'conversation.session.header.actions', id: 'native-action' }; slots.register(native, () => null);
  const dispose = plugin.apply(makeCtx({ slots, sessions: makeSessions([{id: 'wrong-global-last', main: true}]) }));
  const entry = registrations.register.find(x => x.options.id === 'dsh-mind-intervention'); assert.ok(entry, '必须注册真实会话入口');
  return { loaded, calls, entry, registrations, dispose, async drain() {
    for (let i = 0; i < 20; i += 1) { await Promise.all([...pending]); await settle(30); if (!pending.size) return; }
    throw Error('真实传输未收敛，不能清理夹具或宣称完成');
  }, mount(sessionId = A) { const props = { sessionId }; const renderer = createRenderer(entry.Component, props); renderer.flush(); return { renderer, props }; } };
}
async function flush(r) { await settle(30); r.flush(); await settle(20); r.flush(); }
function elements(r) { return collect(r.tree, {skipStyle:true}).elements; }
function button(r, text) { return elements(r).find(x => x.type === 'button' && textOf(x) === text); }
function dialog(r) { return elements(r).find(x => x.props.role === 'dialog'); }
function click(r, text) { const b = button(r,text); assert.ok(b, 'button missing: '+text); assert.ok(!b.props.disabled, 'button disabled: '+text); b.props.onClick(); r.flush(); }
function response(sessionId, rows) { return jsonResponse({ 成功:true, 会话:sessionId, 待决:rows }); }
function tick(e) { for (const t of e.loaded.timers.intervals) t.fn(); }

test('会话header入口只追加自己的id，不依赖全局末条会话或composer takeover且不覆盖原action', async () => {
  const e = env(req => response(new URL(req.url,'http://local').searchParams.get('sessionId'), [row()])); const {renderer:r} = e.mount(); await flush(r);
  assert.equal(e.entry.options.name,'conversation.session.header.actions');
  assert.equal(e.registrations.register.filter(x=>x.options.id==='native-action').length,1);
  assert.ok(!e.registrations.inject.includes('conversation.composer') && !e.registrations.inject.includes('conversation.input.overlay'));
  assert.ok(e.calls.every(x=>new URL(x.url,'http://local').searchParams.get('sessionId')===A));
  assert.ok(dialog(r)); r.unmount(); e.dispose();
});

test('不打开设置页也主动读取并弹完整冻结计划；只有真实组件点击才发送决议', async () => {
  const e = env(() => response(A,[row()])); const {renderer:r} = e.mount(); await flush(r);
  assert.ok(dialog(r)); const text = textOf(r.tree);
  for (const field of ['plugins',A,'r1','card-v1','task1','NEVER-TRUNCATE','STEP-END','preview-r1']) assert.ok(text.includes(field),field);
  assert.equal(e.calls.filter(x=>x.method==='POST').length,0);
  assert.ok(button(r,'批准') && button(r,'拒绝'));
  const settings=e.registrations.register.find(x=>x.options.name==='settings.section'); const sr=createRenderer(settings.Component,{});sr.flush(); await flush(sr);
  assert.equal(elements(sr).filter(x=>x.props['data-dshmind']==='intervention-approvals').length,0);
  assert.ok(!button(sr,'批准') && !button(sr,'拒绝')); assert.match(textOf(sr.tree),/所属会话/);
  sr.unmount();r.unmount();e.dispose();
});

test('稍后处理不被每次轮询强制重弹，同会话入口可重开，新请求再主动弹出', async () => {
  let rows=[row()]; const e=env(()=>response(A,rows));const {renderer:r}=e.mount();await flush(r);
  click(r,'稍后处理'); assert.ok(!dialog(r));tick(e);await flush(r);assert.ok(!dialog(r));
  click(r,'介入审批 · 1');await flush(r);assert.ok(dialog(r));
  click(r,'稍后处理');rows=[row(),row('new-request')];tick(e);await flush(r);assert.ok(dialog(r));assert.match(textOf(r.tree),/new-request/);
  const count=e.calls.length;r.unmount();const cleared=e.loaded.timers.cleared.length;assert.ok(cleared>=1);tick(e);await settle(20);assert.equal(e.calls.length,count);e.dispose();
});

test('会话切换的慢响应不会显示或覆盖另一个会话；原样id不增删前缀', async () => {
  let release; const e=env(req=>new URL(req.url,'http://local').searchParams.get('sessionId')===A ? new Promise(resolve=>{release=resolve;}) : response(B,[row('only-b',B)]));
  const {renderer:r,props}=e.mount();props.sessionId=B;r.render();assert.ok(!textOf(r.tree).includes('r1'));r.flush();await flush(r);assert.match(textOf(r.tree),/only-b/);
  release(response(A,[row('late-a',A)]));await flush(r);assert.ok(!textOf(r.tree).includes('late-a'));assert.ok(!textOf(r.tree).includes(A));r.unmount();e.dispose();
});

test('两个会话消费者各自隔离；卸载重连从同一服务恢复待决，不消费其他会话数据', async () => {
  const e=env(req=>{const id=new URL(req.url,'http://local').searchParams.get('sessionId');return response(id,[row(id===A?'only-a':'only-b',id)]);});
  const {renderer:a}=e.mount(A);const {renderer:b}=e.mount(B);await flush(a);await flush(b);
  assert.match(textOf(a.tree),/only-a/);assert.ok(!textOf(a.tree).includes('only-b'));assert.match(textOf(b.tree),/only-b/);assert.ok(!textOf(b.tree).includes('only-a'));
  a.unmount();const {renderer:reconnected}=e.mount(A);await flush(reconnected);assert.match(textOf(reconnected.tree),/only-a/);
  b.unmount();reconnected.unmount();e.dispose();
});

test('缺会话/401/403/坏响应与超时明确可见，不静默空列表，也不缓存完整正文', async () => {
  for (const status of [401,403]) {
    const e=env(()=>jsonResponse({成功:false,理由:'认证失败 HTTP '+status},status));const {renderer:r}=e.mount();await flush(r);
    assert.match(textOf(r.tree),new RegExp(String(status)));assert.ok(!button(r,'批准'));assert.ok([...e.loaded.store.values()].every(value => !String(value).includes('NEVER-TRUNCATE') && !String(value).includes('preview-r1')), '看板缓存不得包含私有审批正文或审阅指纹');r.unmount();e.dispose();
  }
  const e=env(()=>{throw Error('缺session不得取数');});const {renderer:r}=e.mount('');await flush(r);assert.match(textOf(r.tree),/缺少所属会话/);assert.equal(e.calls.length,0);r.unmount();e.dispose();
  const bad=env(()=>response(A,[row('wrong-session',B)]));const br=bad.mount().renderer;await flush(br);assert.match(textOf(br.tree),/范围不符/);assert.ok(!textOf(br.tree).includes('wrong-session'));br.unmount();bad.dispose();
  const hang=env(()=>new Promise(()=>{}));const hr=hang.mount().renderer;hang.loaded.timers.fireTimeouts();await flush(hr);assert.match(textOf(hr.tree),/读取会话审批失败|无回应/);hr.unmount();hang.dispose();
});

test('空待决是确定零而非读取中；缺完整记录禁用决议不能盲批', async () => {
  const empty=env(()=>response(A,[]));const er=empty.mount().renderer;await flush(er);assert.ok(button(er,'介入审批 · 0'));assert.ok(!dialog(er));er.unmount();empty.dispose();
  const e=env(()=>response(A,[row('missing',A,{完整请求:undefined,步骤:[],审阅指纹:undefined,记录问题:'完整记录缺失'})]));const r=e.mount().renderer;await flush(r);
  assert.match(textOf(r.tree),/完整记录缺失/);assert.equal(button(r,'批准').props.disabled,true);assert.equal(e.calls.filter(x=>x.method==='POST').length,0);r.unmount();e.dispose();
});

test('批准只发冻结请求id与审阅版本，双击不重发；POST后独立GET确认才给成功', async () => {
  let state='待放行';const e=env(req=>{if(req.method==='POST'){state=req.body.决定==='撤销'?'已撤销':'已批准待重放';return jsonResponse({成功:true,请求id:req.body.请求id,决定:req.body.决定});}return response(A,[row('r1',A,{状态:state,可选项:state==='待放行'?['批准','拒绝']:state==='已批准待重放'?['撤销']:[],审阅指纹:state==='待放行'?'preview-r1':'approved-preview'})]);});
  const r=e.mount().renderer;await flush(r);const fn=button(r,'批准').props.onClick;fn();fn();await flush(r);
  const post=e.calls.findIndex(x=>x.method==='POST');assert.equal(e.calls.filter(x=>x.method==='POST').length,1);
  assert.deepEqual(e.calls[post].body,{请求id:'r1',决定:'批准',审阅指纹:'preview-r1'});assert.equal(e.calls[post+1].method,'GET');assert.match(textOf(r.tree),/已回读确认「已批准待重放」/);
  assert.ok(button(r,'撤销') && !button(r,'批准'), '已批未重放保留原撤销入口，不误画执行完成');
  click(r,'撤销');await flush(r);assert.match(textOf(r.tree),/已回读确认「已撤销」/);assert.ok(!button(r,'批准') && !button(r,'撤销'), '收口态无可重复决议');
  assert.ok(!e.calls.some(x=>x.url.includes('task_submit')));r.unmount();e.dispose();
});

test('拒绝回读可见；POST假成功/失败/冻结版本冲突均不得显示已确认', async () => {
  for(const mode of ['no-save','refused','wrong-reply']) {
    const e=env(req=>req.method==='POST'?jsonResponse(mode==='refused'?{成功:false,理由:'审阅版本已变化'}:{成功:true,请求id:mode==='wrong-reply'?'wrong':'r1',决定:'批准'}):response(A,[row()]));
    const r=e.mount().renderer;await flush(r);click(r,'批准');await flush(r);assert.match(textOf(r.tree),/决议未确认/);assert.ok(!textOf(r.tree).includes('已回读确认'));r.unmount();e.dispose();
  }
  let rejected=false;const e=env(req=>{if(req.method==='POST'){rejected=true;return jsonResponse({成功:true,请求id:'r1',决定:'拒绝'});}return response(A,[row('r1',A,{状态:rejected?'已拒绝':'待放行',可选项:rejected?[]:['批准','拒绝']})]);});const r=e.mount().renderer;await flush(r);click(r,'拒绝');await flush(r);assert.match(textOf(r.tree),/已回读确认「已拒绝」/);r.unmount();e.dispose();
});

test('真客户端完整模块→真HTTP路由→真Intervention/账本闭环，非提取函数或复刻状态机', async () => {
  const f=await makeFixture({defaults:{介入度:'审批'}});
  let e;let r;
  try {
    const org=await Org.open({home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project:'default'});
    const req=await org.intervention.记请求({subject:{id:A,kind:'Lead'},action:'write',args:{内容:'TRUE-SERVICE-END'},项目:'plugins',档位:'审批',步骤:[{动作:'write',目标:{kind:'产物',id:'artifact-one'},说明:'真模块消费者',预览:{内容:'TRUE-SERVICE-END'}}]});
    const route=intervention路由({org,项目:'default',ctx:{get:name=>name==='connection'?{requestRejection:()=>undefined}:undefined}});
    e=env(async request=>{let status;let body;await route({method:request.method,url:request.url,headers:{host:'127.0.0.1:7710','sec-fetch-site':'same-origin','content-type':'application/json'},async *[Symbol.asyncIterator](){if(request.body)yield Buffer.from(JSON.stringify(request.body));}},{writeHead:s=>{status=s;},end:b=>{body=b;}});return jsonResponse(JSON.parse(body),status);});
    r=e.mount(A).renderer;await e.drain();await flush(r);assert.ok(dialog(r));assert.match(textOf(r.tree),/TRUE-SERVICE-END/);click(r,'批准');await e.drain();await flush(r);
    assert.match(textOf(r.tree),/已回读确认「已批准待重放」/);assert.equal((await org.intervention.投影({项目:'plugins'})).find(x=>x.请求id===req.请求id).状态,'已批准待重放');
    assert.equal((await org.audit.read({})).filter(x=>x.动作==='介入决议').length,1);assert.equal((await org.audit.read({})).filter(x=>x.动作==='介入放行占用').length,0);
  } finally {if(r)r.unmount();if(e)e.dispose();await f.cleanup();}
});
