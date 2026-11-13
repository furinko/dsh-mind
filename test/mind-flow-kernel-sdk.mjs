/* Actual selected SDK Cordis, Session, ToolRuntime/executor, native tools and Mind kernel.
 * All roots, roles, tasks and child catalog entries are synthetic. The counted
 * creation service never starts a child Agent or a model. No live profile loads. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { makeFixture, LEAD, SOVEREIGN } from './helpers.mjs';
import { shareOrg, shareKey, forgetSharedOrg } from '../src/runtime.js';
import * as kernel from '../components/kernel/lib/index.js';
import { drainKernelAudit } from './kernel-drain.mjs';
import { installSdkTools, executeSdkTool } from './sdk-tool-runtime.mjs';
if (!process.env.DSH_SDK_ROOT) throw Error('DSH_SDK_ROOT must point to the isolated public SDK.');
const sdk = createRequire(resolve(process.env.DSH_SDK_ROOT, 'package.json'));
const load = name => import(pathToFileURL(sdk.resolve('@deepseek-ai/' + name)));
const [{ Context }, { ToolRuntime }, { Session }, native, nativeTeam, { createScope }] = await Promise.all(['cordis', 'dsh-tools', 'dsh-session', 'dsh-tool-subagent', 'dsh-experimental-tool-agent-team', 'dsh-scope'].map(load));
const P = 'flow-sdk';
async function fixture(t, mode = 'subagent', purpose = 'member', options = {}) {
  const f = await makeFixture(), ctx = new Context(), controller = new AbortController();
  const spec = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P };
  let org, sequence = 0;
  t.after(async () => { await ctx.fiber.dispose(); if (org) await drainKernelAudit(org); forgetSharedOrg(shareKey(spec)); await f.cleanup(); });
  ctx.reflect.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, context: () => () => {}, getSectionOrder: () => 0, getContextOrder: () => 0 });
  ctx.reflect.provide('sandboxPolicy', { resolve: ({ session }) => ({ mode: 'workspace-write', workspaceRoot: f.home, sessionId: session.id }) });
  await installSdkTools(ctx, ToolRuntime, load);
  const parent = { id: LEAD.id, ctx, options: { provider: 'fixture', model: 'no-network' }, session: Session.create(LEAD.id, [], { version: 4, id: LEAD.id, cwd: f.home, createdAt: Date.now(), isSeeded: false }) };
  parent.ctx = createScope(ctx, parent).ctx;
  const agents = new Map([[parent.id, parent]]), children = [], roster = [], calls = [], sends = [], interrupts = [], nativeResults = [];
  ctx.reflect.provide('agents', { get: id => agents.get(id), list: () => [...agents.values()] });
  ctx.on('tools/result', (exec, result) => { if (exec.name !== 'mind') nativeResults.push({ name: exec.name, callId: exec.callId, result }); });
  const checkMemberIntent = async tool => {
    if (purpose !== 'member') {
      const pending = (await org.council.list({ 项目: P, 读者: LEAD })).find(c => c.状态 === '创建中');
      assert.ok(pending, 'council intent must exist on disk before a native side effect');
      const call = pending.创建调用.at(-1);
      assert.equal(call.状态, 'intent'); assert.equal(call.实例, null);
      assert.equal(call.宿主调用.工具, tool); assert.equal(call.序号, calls.length);
      return;
    }
    const operation = org.spawnOperations.findByTask(P, api.task.id);
    assert.equal(operation.状态, 'intent', 'intent must exist before native side effect');
    assert.equal(operation.拟用实例, null, 'official tools assign the actual child id');
    assert.equal(operation.宿主调用.工具, tool);
  };
  const provider = { name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, depthLimit: true }, prepareContinuable() {} };
  const service = {
    getProvider: name => name === 'spawn' ? provider : undefined, resolveMaxDepth: () => 2,
    async startActivation(request) {
      request.signal.throwIfAborted(); calls.push(request);
      await checkMemberIntent('subagent');
      assert.equal(request.childId, undefined, 'no fabricated reserved id passed to native tool');
      await api.onCreate?.();
      const id = api.returnId ?? randomUUID();
      children.push({ id, mode: api.childMode ?? 'continuable' });
      return { childId: id, messageId: 'native-internal-id-not-exposed' };
    },
    async listChildren(id) { assert.equal(id, parent.id); return api.catalog?.(children) ?? children.map(r => ({ ...r })); },
    async sendMessage(agent, id, content) {
      assert.equal(agent, parent);
      if (purpose === 'member') assert.equal((await org.tasks.get(api.task.id, { 项目: P })).状态, '已派发');
      else assert.ok((await org.council.list({ 项目: P, 读者: LEAD })).some(c => c.状态 === '作答中' && c.参与者.includes(id)), 'council opened must be durable before any business message');
      assert.equal((await org.registry.cardOf(id)).就绪, true);
      sends.push({ id, content }); return { messageId: 'business-message-' + sends.length };
    },
    async drainChildren(_parent, ids) { interrupts.push(...ids); },
    interrupt(id, authority) { assert.equal(authority.kind, 'ancestor'); assert.equal(authority.agent, parent); interrupts.push(id); },
  };
  ctx.reflect.provide('subagents', service);
  if (options.route) ctx.reflect.provide('llm', { resolveCallConfig: (route, signal) => api.onRoute(route, signal) });
  await native.apply(ctx, { provider: 'spawn', maxDepth: 2, ...(options.route ? { agentOptions: { provider: 'fixture', model: 'no-network' } } : {}) });
  const teamService = {
    tryMembership: agent => agent === parent && mode === 'team' ? { role: 'lead', name: 'lead' } : undefined,
    membership: () => ({ role: 'lead', name: 'lead' }),
    async spawnTeammate(agent, request) {
      assert.equal(agent, parent); request.signal.throwIfAborted(); calls.push({ agent, request });
      await checkMemberIntent('spawn_teammate');
      await api.onCreate?.();
      const member = { id: api.returnId ?? randomUUID(), name: api.teamName ?? request.name, role: api.teamRole ?? 'teammate',
        status: api.teamStatus ?? 'inactive', diagnostics: [], provider: request.provider, context: request.context, description: request.description };
      roster.push(member); return { member };
    },
    listMembers(agent) { assert.equal(agent, parent); return api.catalog?.(roster) ?? roster.map(r => ({ ...r })); },
    async sendMessage(agent, request) { const member = roster.find(r => r.name === request.target); assert.ok(member); return service.sendMessage(agent, member.id, request.content); },
    async interrupt(agent, name) { assert.equal(agent, parent); interrupts.push(name); await api.onStop?.(); return { previousStatus: 'running' }; },
  };
  if (mode === 'team') { ctx.reflect.provide('agentTeams', teamService); await nativeTeam.apply(ctx, { interrupt: options.interrupt ?? true }); }
  await kernel.apply(ctx, { ...spec, projectBindings: [{ project: P, path: f.home }], memberFileAccess: {},
    delegation: Object.hasOwn(options, 'delegation') ? options.delegation : { mode: 'lead-discretion', projects: [P], authorizationRef: 'isolated-fixture-only' },
    轮级缓冲: false, 项目接续: false, audit工具调用: false, webServer次数: 0 });
  org = await shareOrg(spec);
  const task = purpose === 'member' ? await org.tasks.create({ subject: LEAD, 项目: P, 描述: '隔离官方派工测试', 负责人: [options.role ?? '插件工程'], 判据: ['只验证调度，不启动业务模型'] }) : null;
  const args = purpose === 'member'
    ? { action: 'member_spawn', 方式: mode, ...(mode === 'team' ? { 名: 'sdk-teammate' } : {}), 岗位: '插件工程', 节点: task.id, 任务书: 'Synthetic business opening, no real model.' }
    : { action: 'debate_open', 方式: mode, 参与岗位: '插件工程,插件工程', 问题: 'Synthetic native council, no real model.' };
  const api = { f, ctx, org, parent, agents, children, roster, calls, sends, interrupts, service, teamService, task, nativeResults,
    invoke: async (input = args) => {
      const result = await executeSdkTool(ctx.tools, { callId: 'mind-' + (++sequence), name: 'mind', arguments: input, agent: parent, signal: controller.signal });
      assert.equal(result.isError, false, JSON.stringify(result));
      return JSON.parse(result.value);
    },
    operation: () => task ? org.spawnOperations.findByTask(P, task.id) : null,
  };
  return api;
}

for (const mutation of ['task', 'permission', 'parent']) test(`route-preflight wait revocation prevents service entry: ${mutation}`, async t => {
  const f = await fixture(t, 'subagent', 'member', { route: true });
  let reached, release;
  const entered = new Promise(r => { reached = r; }), held = new Promise(r => { release = r; });
  let routeSignal;
  f.onRoute = async (_route, signal) => { routeSignal = signal; reached(); await held; };
  const running = f.invoke();
  await Promise.race([entered, running.then(r => { throw Error('never reached actual SDK route preflight: ' + JSON.stringify(r)); })]);
  assert.equal(f.calls.length, 0, 'SDK has not entered the creation service');
  if (mutation === 'task') await f.org.tasks.close(f.task.id, { subject: LEAD, 项目: P, 原因: 'withdraw while actual SDK route resolver is suspended' });
  if (mutation === 'permission') await f.f.writePrivate('集体L2-共享基础设施/defaults/部署.json', JSON.stringify({ 介入度: '审批' })), await f.org.policy.reload();
  if (mutation === 'parent') f.agents.set(f.parent.id, { ...f.parent });
  // Bounded observation, no resampling; SDK resolver remains held until cancellation.
  let timer;
  try { await Promise.race([new Promise(r => { if (routeSignal.aborted) r(); else routeSignal.addEventListener('abort', r, { once: true }); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('stale plan signal was not cancelled during route wait')), 2500); })]); }
  finally { clearTimeout(timer); release(); }
  const result = await running;
  assert.equal(result.成功, false); assert.equal(f.calls.length, 0); assert.equal(f.children.length, 0); assert.equal(f.sends.length, 0); assert.equal(f.interrupts.length, 0);
  if (mutation === 'task') await assertTaskClosed(f);
  assert.equal(f.operation().状态, 'intent');
});

test('route-preflight held current plan can release and create through the official body once',async t=>{
  const f=await fixture(t,'subagent','member',{route:true});let release,reached;
  const wait=new Promise(r=>{release=r;}),entered=new Promise(r=>{reached=r;});
  f.onRoute=async()=>{reached();await wait;};
  const running=f.invoke();await Promise.race([entered,running.then(()=>{throw Error('route was not entered');})]);
  assert.equal(f.calls.length,0);release();const r=await running;
  assert.equal(r.成功,true,JSON.stringify(r));assert.equal(f.calls.length,1);assert.equal(f.sends.length,1);assert.equal(f.interrupts.length,0);
});

for (const mode of ['team', 'subagent']) {
  test(`SDK ${mode} real parent without specialty card traverses budget and durable intent before native creation`, async t => {
    const f = await fixture(t, mode);
    const goal = await f.org.goals.create({ subject: LEAD, 项目: P, 期望结果: '合成受管委派', 完成依据: ['官方入口只创建一次'], 来源: '隔离用户任务', 下一步: '执行合成委派' });
    await f.org.goals.linkTask(goal.id, { subject: LEAD, 项目: P, 修订: goal.修订, 任务: f.task.id });
    await f.org.budgets.configure(goal.id, { subject: SOVEREIGN, 项目: P, 预算修订: 0, 上限: 1 });
    const identity = await f.org.registry.identity(), hash = identity.members[LEAD.id].卡版本?.摘要;
    delete identity.members[LEAD.id].卡版本;
    await writeFile(f.org.layout.identityFile(), JSON.stringify(identity));
    for (const root of [f.f.factoryRoot, f.f.privateRoot]) await rm(resolve(root, '集体L3-成员角色卡', 'Lead.md'), { force: true });
    if (hash) await rm(f.org.layout.cardSnapshot(hash), { force: true });
    assert.equal((await f.org.registry.cardOf(LEAD.id)).就绪, false, 'professional contents are genuinely unavailable');
    const result = await f.invoke();
    assert.equal(result.成功, true, JSON.stringify(result));
    assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.interrupts.length, 0);
    assert.equal(f.operation().状态, 'audited');
    const budget = await f.org.budgets.query(goal.id, { subject: LEAD, 项目: P });
    assert.equal(budget.累计准入, 1); assert.equal(budget.尝试页.条目[0].类别, 'member_spawn');
    assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 1, 'already-created work is not replayed');
  });
  for (const [label, delegation, allow] of [
    ['absent', undefined, true], ['empty', {}, true], ['explicit-old', { mode: 'explicit-user' }, false],
    ['partial-old', { projects: [] }, false], ['scoped-out', { mode: 'host', projects: ['other'] }, false],
    ['invalid', { mode: null }, false],
  ]) test(`SDK ${mode} configuration ${label} preserves admission boundaries`, async t => {
    const f = await fixture(t, mode, 'member', { delegation });
    const state = (await f.invoke({ action: 'delegation_status' })).数据;
    assert.equal(state.canAttempt, allow); assert.equal(state.authorized, false);
    assert.equal(state.hostAdmission, 'not-evaluated');
    const result = await f.invoke();
    assert.equal(result.成功, allow, JSON.stringify(result));
    assert.equal(f.calls.length, allow ? 1 : 0); assert.equal(f.sends.length, allow ? 1 : 0);
    assert.equal(f.interrupts.length, 0);
    if (allow) assert.equal(f.operation().状态, 'audited');
    else assert.equal(f.operation(), null, 'Mind restriction precedes creation intent');
  });
  for (const decision of ['deny', 'ask']) test(`SDK ${mode} default Host mode does not override native ${decision}`, async t => {
    const f = await fixture(t, mode, 'member', { delegation: undefined });
    f.ctx.on('tools/pre-execute', async (exec, next) => exec.name === (mode === 'team' ? 'spawn_teammate' : 'subagent') ? { kind: decision, reason: 'default still needs Host' } : next());
    assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
    assert.equal(f.operation().状态, 'intent');
  });
}

for(const decision of ['allow','deny','ask','disabled','changed-target','changed-owner','sealed-parent','changed-policy','unknown-catalog','missing-target','changed-role'])test(`SDK Team council compensation uses official interruption: ${decision}`,async t=>{
  const f=await fixture(t,'team','council',{delegation:{},interrupt:decision!=='disabled'});let creationAdmissions=0;
  f.ctx.on('tools/pre-execute',async(exec,next)=>{
    if(exec.name==='spawn_teammate'&&++creationAdmissions===2){
      if(decision==='unknown-catalog'||decision==='missing-target'){
        f.service.drainContinuableChildren=f.service.drainChildren;
        f.catalog=()=>{if(decision==='unknown-catalog')throw Error('synthetic unavailable Team catalog');return [];};
      }
      return {kind:'deny',reason:'synthetic second creation refusal'};
    }
    if(exec.name==='interrupt_agent'){
      if(decision==='deny'||decision==='ask')return {kind:decision,reason:'synthetic cleanup restriction'};
      if(decision==='changed-target')f.roster.push({...f.roster[0],id:randomUUID()});
      if(decision==='changed-policy'){await f.f.writePrivate('集体L2-共享基础设施/defaults/部署.json',JSON.stringify({介入度:'审批'}));await f.org.policy.reload();}
      if(decision==='changed-owner'||decision==='sealed-parent'||decision==='changed-role'){
        const original=f.org.registry.identity.bind(f.org.registry);
        f.org.registry.identity=async()=>{const view=structuredClone(await original());
          if(decision==='changed-owner')view.members[f.roster[0].id].委派者={id:'foreign-lead',kind:'Lead'};
          else if(decision==='changed-role')view.members[f.roster[0].id].岗位='文档整理';
          else view.members[LEAD.id].status='封存';return view;};
      }
    }
    return next();
  });
  const r=await f.invoke();assert.equal(r.成功,false);assert.equal(f.calls.length,1);assert.equal(f.sends.length,0);
  assert.equal(f.interrupts.length,decision==='allow'?1:0,'cleanup cannot bypass the official disabled/denied/approval boundary or changed roster');
  if(decision==='allow')assert.ok(f.nativeResults.some(x=>x.name==='interrupt_agent'&&x.result.isError===false),'even cleanup must traverse the native tool');
});

for(const decision of ['allow','deny','ask','disabled'])test(`SDK Team member registration compensation uses official interruption: ${decision}`,async t=>{
  const f=await fixture(t,'team','member',{delegation:{},interrupt:decision!=='disabled'});
  f.org.registry.assign=async()=>{throw Error('synthetic registration failure');};
  f.ctx.on('tools/pre-execute',(exec,next)=>exec.name==='interrupt_agent'&&(decision==='deny'||decision==='ask')?{kind:decision,reason:'synthetic cleanup restriction'}:next());
  const r=await f.invoke();assert.equal(r.成功,false);assert.equal(f.calls.length,1);assert.equal(f.sends.length,0);
  assert.equal(f.interrupts.length,decision==='allow'?1:0);
  if(decision==='allow')assert.ok(f.nativeResults.some(x=>x.name==='interrupt_agent'&&x.result.isError===false));
});
for(const observed of [true,false])test(`SDK partial council stop needs actual host_returned evidence: ${observed}`,async t=>{
  const f=await fixture(t,'team','council',{delegation:{}});let creations=0,cleanup=true;
  f.ctx.on('tools/pre-execute',(exec,next)=>{
    if(exec.name==='spawn_teammate'&&++creations===2)return {kind:'deny',reason:'synthetic creation refusal'};
    if(exec.name==='interrupt_agent'&&cleanup)return {kind:'deny',reason:'synthetic cleanup refusal'};
    return next();
  });
  assert.equal((await f.invoke()).成功,false);assert.equal(f.calls.length,1);assert.equal(f.interrupts.length,0);
  const child=f.roster[0].id;assert.equal((await f.org.registry.identity()).members[child].status,'封存');
  if(!observed){const get=f.org.council.get.bind(f.org.council);f.org.council.get=async(...args)=>{
    const c=structuredClone(await get(...args));c.创建调用=c.创建调用.map(call=>({...call,状态:'intent',实例:null}));return c;};}
  cleanup=false;const r=await f.invoke({action:'member_stop',实例:child});assert.equal(r.成功,observed);assert.equal(f.interrupts.length,observed?1:0);assert.equal(f.calls.length,1);
});

async function seedExisting(f, mode, role='插件工程') {
  const id=randomUUID();
  await f.org.registry.assign({subject:LEAD,岗位:role,实例:id});
  await f.org.tasks.bind(f.task.id,{subject:LEAD,项目:P,实例:id,岗位:role});
  await f.org.tasks.dispatch(f.task.id,{subject:LEAD,项目:P});
  if(mode==='team')f.roster.push({id,name:'existing-owned',role:'teammate',status:'running'});
  else f.children.push({id,mode:'continuable'});
  return id;
}
for(const mode of ['team','subagent'])for(const delegation of [{mode:'explicit-user'}, {}, {mode:'host',projects:['other']}])test(`SDK ${mode} existing stop independent of creation: ${JSON.stringify(delegation)}`,async t=>{
  const f=await fixture(t,mode,'member',{delegation}),id=await seedExisting(f,mode);
  const r=await f.invoke({action:'member_stop',实例:id});
  assert.equal(r.成功,true,JSON.stringify(r));assert.equal(r.已请求中断,true);assert.equal(r.已停,null);
  assert.equal(f.interrupts.length,1);assert.equal(f.calls.length,0);assert.equal(f.sends.length,0);
  if(mode==='team')assert.ok(f.nativeResults.some(x=>x.name==='interrupt_agent'&&x.result.isError===false));
});
for(const decision of ['deny','ask'])test(`SDK Team stop respects Host ${decision}`,async t=>{
  const f=await fixture(t,'team','member',{delegation:{mode:'explicit-user'}}),id=await seedExisting(f,'team');
  f.ctx.on('tools/pre-execute',async(exec,next)=>exec.name==='interrupt_agent'?{kind:decision,reason:'stop restricted'}:next());
  const r=await f.invoke({action:'member_stop',实例:id});assert.equal(r.成功,false);assert.equal(f.interrupts.length,0);assert.equal(f.calls.length,0);
});
test('SDK disabled official Team interrupt never falls back to present service',async t=>{
  const f=await fixture(t,'team','member',{delegation:{},interrupt:false}),id=await seedExisting(f,'team');
  assert.equal(typeof f.teamService.interrupt,'function');
  assert.equal((await f.invoke({action:'member_stop',实例:id})).成功,false);assert.equal(f.interrupts.length,0);
});
for(const mutation of ['owner','catalog','sealed-parent'])test(`SDK Team stop rechecks after Host approval wait: ${mutation}`,async t=>{
  const f=await fixture(t,'team','member',{delegation:{mode:'explicit-user'}}),id=await seedExisting(f,'team');
  f.ctx.on('tools/pre-execute',async(exec,next)=>{
    if(exec.name==='interrupt_agent'){
      if(mutation==='owner'){const identity=f.org.registry.identity.bind(f.org.registry);f.org.registry.identity=async()=>{const view=await identity();view.members[id].委派者.id='other-lead';return view;};}
      if(mutation==='catalog')f.roster[0].name='changed-target';
      if(mutation==='sealed-parent'){const identity=f.org.registry.identity.bind(f.org.registry);f.org.registry.identity=async()=>{const view=await identity();view.members[LEAD.id].status='封存';return view;};}
    }return next();
  });
  assert.equal((await f.invoke({action:'member_stop',实例:id})).成功,false);assert.equal(f.interrupts.length,0);
});
for(const mode of ['team','subagent'])test(`SDK ${mode} review repair reuses exact existing instance without creation grant`,async t=>{
  const f=await fixture(t,mode,'member',{role:'复核员',delegation:{mode:'explicit-user'}}),id=await seedExisting(f,mode,'复核员');
  const business=await f.org.tasks.create({subject:LEAD,项目:P,描述:'synthetic review target',负责人:['插件工程'],判据:['original business criterion']});
  const message={action:'member_message',实例:id,任务:f.task.id,内容:'Read only granted synthetic review materials.'};
  let r=await f.invoke(message);assert.equal(r.成功,true,'专业名称不把普通任务变成复核用途');assert.equal(f.sends.length,1);assert.equal(f.sends[0].id,id);
  assert.equal((await f.invoke({action:'member_stop',实例:id})).已请求中断,true,'missing review scope does not block stop-only');
  assert.equal((await f.invoke({action:'task_bind',id:f.task.id,复核对象:[business.id]})).成功,true);
  r=await f.invoke(message);assert.equal(r.成功,false);assert.match(r.怎么改,/task_attach/);assert.equal(f.sends.length,1);
  assert.equal((await f.invoke({action:'task_attach',id:f.task.id,产出物引用:f.f.factoryRoot})).成功,true);
  r=await f.invoke(message);assert.equal(r.成功,true,JSON.stringify(r));assert.equal(r.已接收,true);assert.equal(f.sends[0].id,id);
  assert.equal(f.calls.length,0);assert.equal(f.sends.length,2);assert.equal((await f.invoke({action:'delegation_status'})).数据.authorized,false);
});
test('SDK Team stop post-body failure stays unknown, not replayed',async t=>{
  const f=await fixture(t,'team','member',{delegation:{mode:'explicit-user'}}),id=await seedExisting(f,'team');
  f.onStop=()=>{throw Error('private host exception');};
  const r=await f.invoke({action:'member_stop',实例:id});assert.equal(r.成功,false);assert.equal(r.提交状态,'未知');assert.equal(r.可重试,false);assert.equal(f.interrupts.length,1);assert.ok(!JSON.stringify(r).includes('private host exception'));
});

for(const mode of ['team','subagent'])for(const state of ['active','sealed','foreign-project'])test(`SDK ${mode} council stop-only ownership: ${state}`,async t=>{
  const f=await fixture(t,mode,'council',{delegation:{}});
  const created=await f.invoke();assert.equal(created.成功,true,JSON.stringify(created));
  const id=(mode==='team'?f.roster:f.children)[0].id;
  if(state==='sealed')await f.org.registry.seal({subject:LEAD,实例:id,理由:'synthetic stop after sealing'});
  if(state==='foreign-project'){const identity=f.org.registry.identity.bind(f.org.registry);f.org.registry.identity=async()=>{const x=await identity();x.members[id].会审绑定.项目='other';return x;};}
  const r=await f.invoke({action:'member_stop',实例:id});assert.equal(r.成功,state!=='foreign-project',JSON.stringify(r));
  assert.equal(f.interrupts.length,state==='foreign-project'?0:1);assert.equal(f.calls.length,2,'stop never recreates council participants');
  if(r.成功){assert.equal(r.已停,null);assert.ok(r.会审);assert.equal(r.任务,null);}
});

test('official Team target-only receipt resolves exactly one new parent-owned roster member', async t => {
  const f = await fixture(t, 'team'), result = await f.invoke();
  const nativeResult = f.nativeResults.find(r => r.name === 'spawn_teammate').result;
  assert.equal(nativeResult.isError, false, JSON.stringify(nativeResult));
  assert.equal(nativeResult.value.member.target, f.calls[0].request.name);
  assert.equal(Object.hasOwn(nativeResult.value.member, 'id'), false);
  assert.equal(Object.hasOwn(nativeResult.value.member, 'name'), false);
  assert.equal(result.成功, true, JSON.stringify(result));
  assert.equal(result.实例, f.roster[0].id); assert.equal(f.sends.length, 1);
  assert.equal(f.operation().状态, 'audited'); assert.equal(f.operation().阶段[1].回执.初始消息id, null);
  assert.equal(f.calls[0].request.provider, 'spawn');
  assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 1);
});

for (const decision of ['deny', 'ask']) test(`official Team honors Host ${decision} before creation`, async t => {
  const f = await fixture(t, 'team');
  f.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'spawn_teammate' ? { kind: decision, reason: 'isolated Team restriction' } : next());
  assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.operation().状态, 'intent');
});

for (const kind of ['wrong-target', 'wrong-role', 'missing-member', 'duplicate-name', 'old-id', 'failed', 'provisioning']) test(`official Team rejects ${kind} without registration or blind cleanup`, async t => {
  const f = await fixture(t, 'team');
  if (['failed', 'provisioning'].includes(kind)) f.teamStatus = kind;
  if (kind === 'wrong-target') f.teamName = 'unrelated-member';
  if (kind === 'wrong-role') f.teamRole = 'lead';
  if (kind === 'missing-member') f.catalog = () => [];
  if (kind === 'duplicate-name') f.catalog = rows => rows.length ? [...rows, { ...rows[0], id: 'second-id' }] : [];
  if (kind === 'old-id') { f.returnId = 'existing-id'; f.roster.push({ id: f.returnId, name: 'existing-name', role: 'teammate' }); }
  const result = await f.invoke();
  assert.equal(result.成功, false); assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.interrupts.length, 0);
  assert.equal(f.operation().状态, 'intent'); assert.equal(f.operation().阶段.length, 1);
});

test('Team name appearing during admission stops creation before the native body', async t => {
  const f = await fixture(t, 'team');
  f.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'spawn_teammate') f.roster.push({ id: 'earlier-member', name: exec.arguments.name, role: 'teammate', status: 'inactive' });
    return next();
  });
  assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.operation().状态, 'intent');
});

async function assertTaskClosed(f) {
  assert.equal((await f.org.tasks.list({项目:P})).find(n=>n.id===f.task.id)?.状态,'已终止','revocation must actually persist, not just throw a malformed fixture call');
}
test('Team task revoked inside native body does not receive business instructions', async t => {
  const f = await fixture(t, 'team');
  f.onCreate = () => f.org.tasks.close(f.task.id, { subject: LEAD, 项目: P, 原因: 'isolated Team withdrawal' });
  assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.interrupts.length, 0);
  await assertTaskClosed(f);assert.equal(f.roster.length,1,'Host body returned a real-shaped new roster entry');
  assert.equal(f.operation().状态, 'intent');
});

test('Team post-processing target replacement cannot register or clean up a foreign member', async t => {
  const f = await fixture(t, 'team');
  f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name === 'spawn_teammate'
    ? { kind: 'accept', value: { member: { target: 'unrelated', role: 'teammate', status: 'inactive', diagnostics: [] } } } : next());
  assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.interrupts.length, 0);
  assert.equal(f.operation().问题.at(-1).故障码, 'HOST_CREATION_RESULT_UNKNOWN');
  assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 1);
});

test('kernel official pipeline persists call before creation then registers, binds and delivers once', async t => {
  const f = await fixture(t), result = await f.invoke();
  assert.equal(result.成功, true, JSON.stringify(result));
  assert.equal(result.已登记, true); assert.equal(result.已派发, true); assert.equal(result.已发开工书, true);
  assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 1); assert.equal(f.interrupts.length, 0);
  assert.equal(f.calls[0].request.parent, f.parent);
  const operation = f.operation();
  assert.equal(operation.状态, 'audited');
  assert.equal(operation.阶段[1].回执.实例, result.实例);
  assert.equal(operation.阶段[1].回执.初始消息id, null);
  assert.equal(operation.阶段[1].回执.宿主调用id, operation.宿主调用.调用id);
  assert.equal(operation.阶段.find(r => r.阶段 === 'message_received').回执.消息id, 'business-message-1');
  const again = await f.invoke();
  assert.equal(again.成功, false); assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 1);
});

for (const decision of ['deny', 'ask']) test(`kernel respects actual native pre-policy ${decision} without creation or retry`, async t => {
  const f = await fixture(t);
  f.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'subagent' ? { kind: decision, reason: 'isolated host restriction' } : next());
  const result = await f.invoke();
  assert.equal(result.成功, false, JSON.stringify(result)); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.operation().状态, 'intent');
  assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 0);
});

test('kernel refuses a stale task after native approval but before body', async t => {
  const f = await fixture(t);
  f.ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (exec.name === 'subagent') await f.org.tasks.close(f.task.id, { subject: LEAD, 项目: P, 原因: 'isolated withdrawal during Host admission' });
    return decision;
  });
  const result = await f.invoke();
  assert.equal(result.成功, false, JSON.stringify(result)); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  await assertTaskClosed(f);assert.equal(f.children.length,0);
  assert.equal(f.operation().状态, 'intent');
});

test('kernel treats a task revoked inside native body as unknown, never starts or blindly interrupts', async t => {
  const f = await fixture(t);
  f.onCreate = () => f.org.tasks.close(f.task.id, { subject: LEAD, 项目: P, 原因: 'isolated withdrawal inside native await' });
  const result = await f.invoke();
  assert.equal(result.成功, false, JSON.stringify(result)); assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.interrupts.length, 0);
  await assertTaskClosed(f);assert.equal(f.children.length,1,'Host completed synthetic creation after real task termination');
  assert.equal(f.operation().状态, 'intent');
  assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 1);
});

test('kernel rechecks current Lead credentials after Host admission', async t => {
  const f = await fixture(t);
  f.ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (exec.name === 'subagent') await f.org.registry.seal({ subject: SOVEREIGN, 实例: LEAD.id, 理由: 'isolated human-side withdrawal during admission' });
    return decision;
  });
  const result = await f.invoke();
  assert.equal(result.成功, false, JSON.stringify(result)); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.operation().状态, 'intent');
});

test('kernel rejects a replaced live parent after admission', async t => {
  const f = await fixture(t);
  f.ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next();
    if (exec.name === 'subagent') f.agents.set(f.parent.id, { ...f.parent });
    return decision;
  });
  assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  assert.equal(f.operation().状态, 'intent');
});

for (const outcome of ['block', 'replace']) test(`kernel retains unknown intent after native post-${outcome}`, async t => {
  const f = await fixture(t);
  f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name !== 'subagent' ? next() : outcome === 'block'
    ? { kind: 'block', feedback: [{ type: 'text', text: 'isolated veto after creation' }] }
    : { kind: 'accept', value: { kind: 'activation', subagentId: 'unrelated-child' } });
  const result = await f.invoke();
  assert.equal(result.成功, false); assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.interrupts.length, 0);
  assert.equal(f.operation().状态, 'intent');
  assert.equal(f.operation().问题.at(-1).故障码, 'HOST_CREATION_RESULT_UNKNOWN');
  assert.equal((await f.invoke()).成功, false); assert.equal(f.calls.length, 1);
});

for (const kind of ['old-child', 'one-shot', 'foreign-child']) test(`kernel never registers or cleans up ${kind}`, async t => {
  const f = await fixture(t);
  if (kind === 'old-child') { f.returnId = 'already-there'; f.children.push({ id: f.returnId, mode: 'continuable' }); }
  if (kind === 'one-shot') f.childMode = 'run';
  if (kind === 'foreign-child') f.catalog = () => [];
  const result = await f.invoke();
  assert.equal(result.成功, false, JSON.stringify(result)); assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.interrupts.length, 0);
  assert.equal(f.operation().状态, 'intent');
});

for (const mode of ['subagent', 'team']) {
  const nativeName = mode === 'team' ? 'spawn_teammate' : 'subagent';
  test(`actual SDK council ${mode} creates two members through distinct native calls without task nodes`, async t => {
    const f = await fixture(t, mode, 'council'), result = await f.invoke();
    assert.equal(result.成功, true, JSON.stringify(result));
    assert.equal(f.calls.length, 2); assert.equal(f.sends.length, 2); assert.equal(f.interrupts.length, 0);
    assert.equal(result.会审.参与者.length, 2);
    assert.equal(new Set(result.会审.参与者).size, 2);
    const nativeCalls = f.nativeResults.filter(r => r.name === nativeName);
    assert.equal(nativeCalls.length, 2); assert.equal(new Set(nativeCalls.map(r => r.callId)).size, 2);
    for (const row of nativeCalls) assert.match(row.callId, /^mind-create-/);
    const persisted = await f.org.council.get(P, result.会审.id);
    assert.deepEqual(persisted.创建调用.map(c => c.宿主调用.调用id), nativeCalls.map(c => c.callId));
    assert.deepEqual(persisted.创建调用.map(c => c.实例), result.会审.参与者);
    assert.ok(persisted.创建调用.every(c => c.状态 === 'host_returned'));
    assert.equal((await f.org.tasks.list({ 项目: P })).length, 0);
    for (const id of result.会审.参与者) {
      const binding = (await f.org.registry.identity()).members[id].会审绑定;
      assert.equal(binding.会审, result.会审.id); assert.equal(binding.来源会话, f.parent.id); assert.equal(binding.项目, P);
    }
  });
  for (const decision of ['deny', 'ask']) test(`actual SDK council ${mode} honors native ${decision} before either creation`, async t => {
    const f = await fixture(t, mode, 'council');
    f.ctx.on('tools/pre-execute', async (exec, next) => exec.name === nativeName ? { kind: decision, reason: 'isolated council restriction' } : next());
    const result = await f.invoke();
    assert.equal(result.成功, false, JSON.stringify(result)); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0); assert.equal(f.interrupts.length, 0);
    const [pending] = await f.org.council.list({ 项目: P, 读者: LEAD });
    assert.equal(pending.状态, '创建未完成'); assert.equal(pending.创建调用.length, 1);
    assert.equal(pending.创建调用[0].状态, 'intent'); assert.equal(pending.创建调用[0].实例, null);
  });
  test(`actual SDK council ${mode} post-replacement is unknown, never registered or blindly cleaned up`, async t => {
    const f = await fixture(t, mode, 'council');
    const before = Object.keys((await f.org.registry.identity()).members);
    f.ctx.on('tools/post-execute', async (exec, _result, next) => exec.name !== nativeName ? next()
      : { kind: 'accept', value: mode === 'team' ? { member: { target: 'foreign', role: 'teammate', status: 'inactive' } } : { kind: 'activation', subagentId: 'foreign' } });
    const result = await f.invoke();
    assert.equal(result.成功, false); assert.equal(result.可重试, false);
    assert.equal(f.calls.length, 1); assert.equal(f.sends.length, 0); assert.equal(f.interrupts.length, 0);
    assert.deepEqual(Object.keys((await f.org.registry.identity()).members), before);
  });
  test(`SDK council ${mode} observes current policy after Host admission wait`, async t => {
    const f = await fixture(t, mode, 'council');
    f.ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next();
      if (exec.name === nativeName) {
        await f.f.writePrivate('集体L2-共享基础设施/defaults/部署.json', JSON.stringify({ 介入度: '审批' }));
        await f.org.policy.reload();
      }
      return decision;
    });
    const result = await f.invoke();
    assert.equal(result.成功, false); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
    assert.equal((await f.org.council.list({ 项目: P, 读者: LEAD }))[0].状态, '创建未完成');
  });
  for (const stage of ['会审创建调用意图', '会审宿主返回观察']) test(`SDK council ${mode} stops before business on ${stage} audit failure`, async t => {
    const f = await fixture(t, mode, 'council'), before = Object.keys((await f.org.registry.identity()).members);
    const append = f.org.audit.append.bind(f.org.audit);
    f.org.audit.append = row => { if (row.动作 === stage) throw Error('injected creation observation audit failure'); return append(row); };
    const result = await f.invoke();
    assert.equal(result.成功, false); assert.equal(result.可重试, false);
    assert.equal(f.calls.length, stage === '会审创建调用意图' ? 0 : 1);
    assert.equal(f.sends.length, 0); assert.equal(f.interrupts.length, 0);
    assert.deepEqual(Object.keys((await f.org.registry.identity()).members), before);
    const [pending] = await f.org.council.list({ 项目: P, 读者: LEAD });
    assert.equal(pending.状态, '创建未完成'); assert.equal(pending.创建调用.length, 1);
    assert.equal(pending.创建调用[0].状态, stage === '会审创建调用意图' ? 'intent' : 'host_returned');
  });
  for (const timing of ['first-admission', 'second-admission', 'inside-body']) test(`SDK council ${mode} rechecks role content at ${timing}`, async t => {
    const f = await fixture(t, mode, 'council');
    const file = resolve(f.org.layout.roleCardDir('出厂'), '插件工程.md');
    const original = await readFile(file, 'utf8');
    const change = () => writeFile(file, original + '\nChanged role while Host was awaiting admission.\n', 'utf8');
    if (timing === 'inside-body') f.onCreate = change;
    else {
      let admissions = 0;
      f.ctx.on('tools/pre-execute', async (exec, next) => {
        const decision = await next();
        if (exec.name === nativeName && ++admissions === (timing === 'second-admission' ? 2 : 1)) await change();
        return decision;
      });
    }
    const result = await f.invoke();
    assert.equal(result.成功, false, JSON.stringify(result));
    assert.equal(f.calls.length, timing === 'first-admission' ? 0 : 1, 'changed plan must never start the next native body');
    assert.equal(f.sends.length, 0);
    assert.equal(f.interrupts.length, timing === 'second-admission' ? 1 : 0, 'only the earlier confirmed owned child may be cleaned up; an unknown return is not a cleanup credential');
  });
  test(`SDK council ${mode} rechecks supplied material path after admission`, async t => {
    const f = await fixture(t, mode, 'council'), material = resolve(f.f.home, 'council-material');
    await mkdir(material);
    f.ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next();
      if (exec.name === nativeName) await rename(material, material + '-moved');
      return decision;
    });
    const result = await f.invoke({ action: 'debate_open', 方式: mode, 参与岗位: '插件工程,插件工程', 问题: 'Material withdrawal', 资料: material });
    assert.equal(result.成功, false); assert.equal(f.calls.length, 0); assert.equal(f.sends.length, 0);
  });
}
