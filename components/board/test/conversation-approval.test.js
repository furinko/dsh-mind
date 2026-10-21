import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadClient, makeSlots, makeCtx, makeSessions, makeStrictRequire, createRenderer, collect, textOf, jsonResponse, settle, sampleView } from './client-harness.mjs';
import { createApprovalRenderer } from './approval-renderer.mjs';
import { makeFixture } from '../../../test/helpers.mjs';
import { Org } from '../../../src/org.js';
import { intervention路由 } from '../../kernel/lib/routes.js';

const A = 'session-owner-a-exact'; const B = 'owner-b-no-prefix';
function row(id = 'r1', owner = A, extra = {}) {
  return { 请求id: id, 项目: 'plugins', 原主体: { id: owner, kind: 'Lead', 卡版本: 'card-v1' }, 目标: { id: 'task1', kind: '任务', 代: 4 }, 动作: 'task_submit', 档位: '审批', 状态: '待放行', 冻结于: '2026-10-18T12:00:00Z', 审阅指纹: 'preview-'+id, 内容摘要: 'digest-'+id, 完整请求: { id: 'task1', 结论: '完整正文尾：NEVER-TRUNCATE' }, 步骤: [{ 序: 1, 动作: 'write', 说明: '冻结计划', 目标: { kind: '任务', id: 'task1' }, 预览: { 正文: '计划尾：STEP-END' } }], 可选项: ['批准','拒绝','撤销'], ...extra };
}
function summary(id = 'r1', session = A) { return { 类型: '介入审批', 请求id: id, 会话: session, 描述: '更新任务', 原因: '审批档', 可选项: ['批准','拒绝'], 命令: '/mind intervention_resolve' }; }
function env(handler, options = {}) {
  const calls = []; const pending = new Set();
  const state = { summaries: [summary()], failProjection: false };
  const loaded = loadClient({ fetch: async (url, init) => {
    if (url.startsWith('/plugins/dsh-mind/intervention')) {
      const req = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined }; calls.push(req);
      const work = Promise.resolve().then(() => handler(req)); pending.add(work);
      try { return await work; } finally { pending.delete(work); }
    }
    if (url.startsWith('/plugins/dsh-mind/workbench')) {
      if (state.failProjection) return jsonResponse({成功:false,理由:'投影暂不可读'},503);
      return jsonResponse({...sampleView(), 项目:'plugins', 待你决定:state.summaries});
    }
    return jsonResponse({ 成功: true });
  }, ...options });
  const strict = makeStrictRequire(); const plugin = loaded.definition.factory(strict.require); const {slots, calls: registrations} = makeSlots();
  slots.register({name:'conversation.input.dock',id:'native-action'},()=>null);
  const dispose = plugin.apply(makeCtx({ slots, sessions: makeSessions([{id: 'wrong-global-last', main: true}]) }));
  const entry = registrations.register.find(x => x.options.name === 'main'); assert.ok(entry);
  return { state, loaded, calls, entry, registrations, dispose, async drain() {
    for (let i = 0; i < 20; i += 1) { await Promise.all([...pending]); await settle(30); if (!pending.size) return; }
    throw Error('真实传输未收敛');
  }, mount() { const r = createApprovalRenderer(entry.Component, {}); r.flush(); return r; } };
}
async function flush(r) { await settle(30); r.flush(); await settle(20); r.flush(); }
function elements(r) { return collect(r.tree, {skipStyle:true}).elements; }
function button(r, text) { return elements(r).find(x => x.type === 'button' && textOf(x) === text); }
function review(r) { return elements(r).find(x => x.props['data-dshmind'] === 'approval-review'); }
function click(r, text) { const b = button(r,text); assert.ok(b, 'button missing: '+text); assert.ok(!b.props.disabled, 'button disabled: '+text); b.props.onClick(); r.flush(); }
function response(sessionId, rows) { return jsonResponse({ 成功:true, 会话:sessionId, 待决:rows }); }
function tick(e) { for (const t of e.loaded.timers.intervals) t.fn(); }
async function select(r, id = 'r1') { await flush(r); const b=elements(r).find(x=>x.type==='button'&&x.props['data-review-request']===id);assert.ok(b,'real summary navigation '+id);assert.ok(!b.props.disabled);b.props.onClick();r.flush();await flush(r); }
async function open(e, id = 'r1', session = A) { e.state.summaries=[summary(id,session)];const r=e.mount();await select(r,id);return r; }

// Tests execute Dashboard and the real keyed review child. No private component is extracted.
test('只注册心智工作台、侧栏和设置；聊天输入区、Git与全局浮层均无审批入口',async()=>{
  const e=env(()=>{throw Error('未打开请求不应读私有计划');});const r=e.mount();await flush(r);
  assert.deepEqual(e.registrations.inject.slice().sort(),['main','settings.section','sidebar.panellist']);
  assert.equal(e.registrations.register.filter(x=>x.options.name==='conversation.input.dock').length,1,'只保留宿主原action');
  assert.equal(e.calls.length,0);assert.ok(!review(r));assert.ok(!button(r,'批准'));assert.ok(!elements(r).some(x=>x.props.role==='dialog'));r.unmount();e.dispose();
});

test('实时待办显式打开独立页；完整字段和执行步骤不截断，设置页没有重复决议入口',async()=>{
  const e=env(()=>response(A,[row()]));const r=await open(e);
  assert.ok(review(r));assert.equal(review(r).type,'main');assert.ok(!elements(r).some(x=>x.props.role==='dialog'));
  for(const field of ['plugins',A,'r1','card-v1','task1','NEVER-TRUNCATE','STEP-END','preview-r1','操作参数','执行计划'])assert.ok(textOf(r.tree).includes(field),field);
  assert.equal(e.calls.filter(x=>x.method==='POST').length,0);
  const sr=createRenderer(e.registrations.register.find(x=>x.options.name==='settings.section').Component,{});sr.flush();await flush(sr);
  assert.ok(!button(sr,'批准')&&!button(sr,'拒绝'));assert.match(textOf(sr.tree),/待你决定/);sr.unmount();r.unmount();e.dispose();
});

test('私有计划只按显式会话取数，拒绝猜测全局末条会话；同会话其他请求不混入审阅',async()=>{
  const e=env(()=>response(A,[row(),row('OTHER-PRIVATE')]));const r=await open(e);
  assert.ok(e.calls.every(x=>new URL(x.url,'http://local').searchParams.get('sessionId')===A));
  assert.ok(!e.calls.some(x=>x.url.includes('wrong-global-last')));assert.ok(!textOf(r.tree).includes('OTHER-PRIVATE'));r.unmount();e.dispose();
});

test('缺请求或会话导航标识不提供打开按钮，不能从描述或命令推断归属',async()=>{
  const e=env(()=>{throw Error('无范围不应取数');});e.state.summaries=[{...summary(),会话:''},{...summary('r2'),请求id:''}];const r=e.mount();await flush(r);
  assert.ok(!button(r,'查看请求'));assert.equal(e.calls.length,0);r.unmount();e.dispose();
});

test('缓存或读取失败的投影不可导航；已捕获旧按钮也不能绕过实时检查',async()=>{
  const e=env(()=>response(A,[row()]));const r=e.mount();await flush(r);const old=button(r,'查看请求');assert.ok(old);
  e.state.failProjection=true;tick(e);await flush(r);assert.equal(button(r,'查看请求').props.disabled,true);
  old.props.onClick();r.flush();await flush(r);assert.ok(!review(r));assert.equal(e.calls.length,0);r.unmount();e.dispose();
});

test('返回列表停止私有轮询，新请求不会自动打开；重开才重新读取',async()=>{
  const e=env(()=>response(A,[row(),row('new')]));const r=await open(e);click(r,'← 返回待你决定');await flush(r);
  const count=e.calls.length;e.state.summaries.push(summary('new'));tick(e);await flush(r);assert.equal(e.calls.length,count);assert.ok(!review(r));
  await select(r,'new');assert.match(textOf(r.tree),/preview-new/);assert.ok(!textOf(r.tree).includes('preview-r1'));r.unmount();const before=e.calls.length;tick(e);await settle(20);assert.equal(e.calls.length,before);e.dispose();
});

test('超过首屏8项仍可展开并打开后续请求；轮询不重置展开态',async()=>{
  const e=env(()=>response(A,[row('r12')]));e.state.summaries=Array.from({length:12},(_,i)=>summary('r'+(i+1)));
  const r=e.mount();await flush(r);assert.ok(!elements(r).some(x=>x.props['data-review-request']==='r12'));
  click(r,'查看全部 12 项');tick(e);await flush(r);await select(r,'r12');assert.match(textOf(r.tree),/preview-r12/);
  click(r,'← 返回待你决定');await flush(r);assert.ok(button(r,'收起待办'));assert.ok(elements(r).some(x=>x.props['data-review-request']==='r12'));r.unmount();e.dispose();
});

test('切换不同会话或同会话另一请求时迟到响应不覆盖新选择',async()=>{
  for(const session of [A,B]){
    let release;const e=env(req=>{const id=new URL(req.url,'http://local').searchParams.get('sessionId');return id===A&&!release?new Promise(resolve=>{release=resolve;}):response(session,[row('new',session)]);});
    const r=await open(e);click(r,'← 返回待你决定');e.state.summaries=[summary('new',session)];tick(e);await select(r,'new');
    release(response(A,[row('r1',A,{完整请求:{text:'LATE-OLD-PRIVATE'}})]));await flush(r);
    assert.ok(!textOf(r.tree).includes('LATE-OLD-PRIVATE'));assert.match(textOf(r.tree),/preview-new/);r.unmount();e.dispose();
  }
});

test('两个工作台消费者隔离；卸载重开从同一服务恢复，不显示其他会话内容',async()=>{
  const e=env(req=>{const id=new URL(req.url,'http://local').searchParams.get('sessionId');return response(id,[row(id===A?'only-a':'only-b',id)]);});
  const a=await open(e,'only-a',A);const b=await open(e,'only-b',B);await flush(a);
  assert.match(textOf(a.tree),/only-a/);assert.ok(!textOf(a.tree).includes('only-b'));assert.match(textOf(b.tree),/only-b/);assert.ok(!textOf(b.tree).includes('only-a'));
  a.unmount();const again=await open(e,'only-a',A);assert.match(textOf(again.tree),/only-a/);b.unmount();again.unmount();e.dispose();
});

test('401/403/坏响应/跨会话范围错误直接显示于已打开的页面；私有正文不缓存',async()=>{
  const bodies=[jsonResponse({成功:false,理由:'认证失败 HTTP 401'},401),jsonResponse({成功:false,理由:'认证失败 HTTP 403'},403),jsonResponse({成功:true,会话:A,待决:[row('wrong-session',B)]}),jsonResponse({成功:true,会话:B,待决:[row()]}),jsonResponse({成功:true,项目:'old',待决:[row()]})];
  for(const body of bodies){const e=env(()=>body);const r=await open(e);assert.ok(review(r));assert.ok(elements(r).some(x=>x.props.role==='alert'));assert.ok(!button(r,'批准'));assert.ok(!textOf(r.tree).includes('wrong-session'));assert.ok(!textOf(r.tree).includes('NEVER-TRUNCATE'));assert.ok([...e.loaded.store.values()].every(x=>!String(x).includes('NEVER-TRUNCATE')&&!String(x).includes('preview-r1')));r.unmount();e.dispose();}
});

test('超时、错误恢复和空记录在独立页可读，其他新请求不代替选中的请求',async()=>{
  let mode='hang';const e=env(()=>mode==='hang'?new Promise(()=>{}):mode==='error'?jsonResponse({成功:false,理由:'暂时不可读'},503):response(A,mode==='empty'?[]:[row('other')]));const r=await open(e);
  assert.match(textOf(r.tree),/正在读取当前请求/);e.loaded.timers.fireTimeouts();await flush(r);assert.match(textOf(r.tree),/读取会话审批失败|无回应/);
  mode='error';tick(e);await flush(r);assert.match(textOf(r.tree),/暂时不可读/);mode='empty';tick(e);await flush(r);assert.match(textOf(r.tree),/当前请求已不可用/);
  mode='other';tick(e);await flush(r);assert.match(textOf(r.tree),/当前请求已不可用/);assert.ok(!textOf(r.tree).includes('preview-other'));r.unmount();e.dispose();
});

test('不完整冻结记录禁用所有决议；重复请求标识拒绝展示',async()=>{
  const e=env(()=>response(A,[row('r1',A,{完整请求:undefined,步骤:[],审阅指纹:undefined,记录问题:'完整记录缺失'})]));const r=await open(e);assert.match(textOf(r.tree),/完整记录缺失/);assert.equal(button(r,'批准').props.disabled,true);assert.equal(e.calls.filter(x=>x.method==='POST').length,0);r.unmount();e.dispose();
  const d=env(()=>response(A,[row(),row()]));const dr=await open(d);assert.match(textOf(dr.tree),/请求标识重复/);assert.ok(!button(dr,'批准'));dr.unmount();d.dispose();
});

test('4秒成功响应配3秒轮询不饥饿，GET始终single-flight',async()=>{
  let now=0,completed=0,maxActive=0;const queued=[];
  const e=env(()=>new Promise(resolve=>{queued.push({due:now+4000,resolve,done:false});maxActive=Math.max(maxActive,queued.filter(x=>!x.done).length);}));const r=await open(e,'slow-valid');
  try{for(now=1000;now<=24000;now+=1000){if(now%3000===0)tick(e);await flush(r);for(const q of queued.filter(x=>!x.done&&x.due<=now)){q.done=true;completed++;q.resolve(response(A,[row('slow-valid')]));}await flush(r);if(now>=4000)assert.match(textOf(r.tree),/preview-slow-valid/);}assert.ok(completed>=4);assert.equal(maxActive,1);}finally{r.unmount();e.dispose();}
});

test('4秒失败响应不被3秒轮询淘汰，下一次请求可恢复',async()=>{
  const pending=[];const e=env(()=>new Promise(resolve=>pending.push(resolve)));const r=await open(e);tick(e);await flush(r);assert.equal(pending.length,1);pending[0](jsonResponse({成功:false,理由:'慢响应可读失败'},503));await flush(r);assert.match(textOf(r.tree),/慢响应可读失败/);assert.ok(!button(r,'批准'));
  tick(e);await flush(r);pending.at(-1)(response(A,[row()]));await flush(r);assert.ok(button(r,'批准'));r.unmount();e.dispose();
});

test('POST确认等待旧GET完成后再发全新GET，不能用批准前快照宣称成功',async()=>{
  let read=0,release,approved=false;
  const e=env(req=>{if(req.method==='POST'){approved=true;return jsonResponse({成功:true,请求id:'r1',决定:'批准'});}read++;if(read===2)return new Promise(resolve=>{release=resolve;});return response(A,[row('r1',A,{状态:approved?'已批准待重放':'待放行',可选项:approved?['撤销']:['批准','拒绝']})]);});const r=await open(e);
  tick(e);await flush(r);assert.equal(read,2);click(r,'批准');await flush(r);assert.equal(read,2);assert.ok(!textOf(r.tree).includes('已回读确认'));
  release(response(A,[row()]));await e.drain();await flush(r);assert.equal(read,3);assert.match(textOf(r.tree),/已回读确认「已批准待重放」/);r.unmount();e.dispose();
});

test('批准只发原请求id和审阅指纹，双击只POST一次；批准不执行原业务，仍可撤销',async()=>{
  let state='待放行';const e=env(req=>{if(req.method==='POST'){state=req.body.决定==='撤销'?'已撤销':'已批准待重放';return jsonResponse({成功:true,请求id:req.body.请求id,决定:req.body.决定});}return response(A,[row('r1',A,{状态:state,可选项:state==='待放行'?['批准','拒绝']:state==='已批准待重放'?['撤销']:[],审阅指纹:state==='待放行'?'preview-r1':'approved-preview'})]);});const r=await open(e);
  const fn=button(r,'批准').props.onClick;fn();fn();await flush(r);const post=e.calls.findIndex(x=>x.method==='POST');assert.equal(e.calls.filter(x=>x.method==='POST').length,1);assert.deepEqual(e.calls[post].body,{请求id:'r1',决定:'批准',审阅指纹:'preview-r1'});assert.equal(e.calls[post+1].method,'GET');assert.match(textOf(r.tree),/已回读确认「已批准待重放」/);assert.ok(button(r,'撤销')&&!button(r,'批准'));
  click(r,'撤销');await flush(r);assert.match(textOf(r.tree),/已回读确认「已撤销」/);assert.ok(!button(r,'批准')&&!button(r,'撤销'));assert.ok(!e.calls.some(x=>x.url.includes('task_submit')));r.unmount();e.dispose();
});

test('POST假成功/失败/冻结版本冲突与错误回执均不得显示确认，拒绝成功仍可返回列表',async()=>{
  for(const mode of ['no-save','refused','wrong-request','wrong-decision']){let posted=false;const e=env(req=>{if(req.method==='POST'){posted=true;return jsonResponse(mode==='refused'?{成功:false,理由:'审阅版本已变化'}:{成功:true,请求id:mode==='wrong-request'?'wrong':'r1',决定:mode==='wrong-decision'?'拒绝':'批准'});}return response(A,[row('r1',A,{状态:posted&&mode!=='no-save'?'已批准待重放':'待放行'})]);});const r=await open(e);click(r,'批准');await flush(r);assert.match(textOf(r.tree),/决议未确认/);assert.ok(!textOf(r.tree).includes('已回读确认'));r.unmount();e.dispose();}
  let rejected=false;const e=env(req=>{if(req.method==='POST'){rejected=true;return jsonResponse({成功:true,请求id:'r1',决定:'拒绝'});}return response(A,[row('r1',A,{状态:rejected?'已拒绝':'待放行',可选项:rejected?[]:['批准','拒绝']})]);});const r=await open(e);click(r,'拒绝');await flush(r);assert.match(textOf(r.tree),/已回读确认「已拒绝」/);assert.ok(!button(r,'批准'));click(r,'← 返回待你决定');assert.ok(!review(r));r.unmount();e.dispose();
});

test('侧栏图标随实时当前项目待办计数，过期投影不报确定数量',async()=>{
  const e=env(()=>response(A,[row()]));const r=e.mount();await flush(r);const icon=createRenderer(e.registrations.register.find(x=>x.options.name==='sidebar.panellist').Component,{size:18});icon.flush();
  assert.equal(collect(icon.tree).elements.find(x=>x.type==='text').props.children,'1');assert.match(textOf(icon.tree),/当前项目有 1/);
  e.state.summaries=[];tick(e);await flush(r);icon.flush();assert.ok(!collect(icon.tree).elements.some(x=>x.type==='text'));
  e.state.summaries=[summary(),summary('r2')];tick(e);await flush(r);icon.flush();assert.equal(collect(icon.tree).elements.find(x=>x.type==='text').props.children,'2');
  e.state.failProjection=true;tick(e);await flush(r);icon.flush();assert.ok(!collect(icon.tree).elements.some(x=>x.type==='text'));icon.unmount();r.unmount();e.dispose();
});

test('真Dashboard→人侧HTTP路由→Intervention账本；只决议不执行业务，无测试私门',async()=>{
  const f=await makeFixture({defaults:{介入度:'审批'}});let e,r;
  try{const org=await Org.open({home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project:'default'});
    const req=await org.intervention.记请求({subject:{id:A,kind:'Lead'},action:'write',args:{内容:'TRUE-SERVICE-END'},项目:'plugins',档位:'审批',步骤:[{动作:'write',目标:{kind:'产物',id:'artifact-one'},说明:'真模块消费者',预览:{内容:'TRUE-SERVICE-END'}}]});
    const route=intervention路由({org,项目:'default',ctx:{get:name=>name==='connection'?{requestRejection:()=>undefined}:undefined}});
    e=env(async request=>{let status,body;await route({method:request.method,url:request.url,headers:{host:'127.0.0.1:7710','sec-fetch-site':'same-origin','content-type':'application/json'},async *[Symbol.asyncIterator](){if(request.body)yield Buffer.from(JSON.stringify(request.body));}},{writeHead:s=>{status=s;},end:b=>{body=b;}});return jsonResponse(JSON.parse(body),status);});
    r=await open(e,req.请求id);await e.drain();await flush(r);assert.match(textOf(r.tree),/TRUE-SERVICE-END/);click(r,'批准');await e.drain();await flush(r);
    assert.match(textOf(r.tree),/已回读确认「已批准待重放」/);assert.equal((await org.intervention.投影({项目:'plugins'})).find(x=>x.请求id===req.请求id).状态,'已批准待重放');
    assert.equal((await org.audit.read({})).filter(x=>x.动作==='介入决议').length,1);assert.equal((await org.audit.read({})).filter(x=>x.动作==='介入放行占用').length,0);
  }finally{if(r)r.unmount();if(e)e.dispose();await f.cleanup();}
});
