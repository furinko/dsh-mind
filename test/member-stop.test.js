/* Domain tests: real organization and ledgers; counted synthetic Host services. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
import { DelegationPolicy } from '../src/delegation-policy.js';
import { describeFailure } from '../src/kernel/errors.js';
const P='stop-fixture', CHILD='owned-stop-child';
async function fixture(t,{mode='subagent',role='插件工程',config={mode:'explicit-user'}}={}) {
  const f=await makeFixture(); t.after(()=>f.cleanup());
  const org=await Org.open({home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project:P});
  await org.registry.assign({subject:LEAD,岗位:role,实例:CHILD});
  const task=await org.tasks.create({subject:LEAD,项目:P,描述:'owned stop test',负责人:[role],判据:['frozen criterion']});
  await org.tasks.bind(task.id,{subject:LEAD,项目:P,实例:CHILD,岗位:role});
  await org.tasks.dispatch(task.id,{subject:LEAD,项目:P});
  const agent={id:LEAD.id,session:{id:LEAD.id,header:{id:LEAD.id,cwd:f.home}}}, calls=[];
  const rows=mode==='team'?[{id:CHILD,name:'exact-team-name',role:'teammate',status:'running'}]:[];
  const kids=mode==='subagent'?[{id:CHILD,mode:'continuable'}]:[];
  const host={project:P,agent,agents:{get:id=>id===agent.id?agent:undefined},signal:new AbortController().signal,
    delegation:new DelegationPolicy(config),agentTeams:{tryMembership:()=>({role:'lead'}),listMembers:()=>rows,
      interrupt:(parent,name)=>{assert.equal(parent,agent);calls.push({mode:'team',name});return {previousStatus:'running'};}},
    subagents:{listChildren:async parent=>{assert.equal(parent,agent.id);return kids;},
      interrupt:(id,authority)=>{assert.equal(authority.kind,'ancestor');assert.equal(authority.agent,agent);calls.push({mode:'subagent',id});}}};
  // Explicit fake capability, not an SDK admission claim. SDK tests exercise the real bridge.
  host.hostMaintenance={prepare:({mode,target,beforeDispatch})=>{assert.equal(mode,'team');return {tool:'interrupt_agent',callId:'fake-stop-call',async execute(){await beforeDispatch();return {value:await host.agentTeams.interrupt(agent,target)};}};}};
  const act=(args={},extra={})=>runAction({org,项目:P,主体:LEAD,面:'tool',宿主:host,args:{action:'member_stop',实例:CHILD,...args},...extra});
  const identity=org.registry.identity.bind(org.registry), list=org.tasks.list.bind(org.tasks);
  const member=change=>{org.registry.identity=async()=>{const view=await identity();return {...view,members:{...view.members,[CHILD]:change(view.members[CHILD])}};};};
  const tasks=change=>{org.tasks.list=async q=>(await list(q)).map(n=>n.id===task.id?change(n):n).filter(Boolean);};
  return {f,org,task,host,agent,calls,rows,kids,act,member,tasks};
}
for(const mode of ['subagent','team']) for(const config of [{mode:'explicit-user'}, {}, {mode:'host',projects:['other']}]) test(`${mode} stop does not require new-creation grant: ${JSON.stringify(config)}`,async t=>{
 const s=await fixture(t,{mode,config}),r=await s.act();assert.equal(r.已请求中断,true);assert.equal(r.已停,null);assert.equal(r.任务,s.task.id);assert.equal(s.calls.length,1);
 assert.ok((await s.org.audit.read({})).some(row=>row.动作==='成员中断'&&row.结果==='已请求'));
});
for(const kind of ['closed-task','sealed-child','review-without-scope']) test(`stop-only accepts proven ownership without work permission: ${kind}`,async t=>{
 const s=await fixture(t,{role:kind==='review-without-scope'?'复核员':'插件工程'});
 if(kind==='closed-task')await s.org.tasks.close(s.task.id,{subject:LEAD,项目:P,原因:'stop after close'});
 if(kind==='sealed-child')await s.org.registry.seal({subject:LEAD,实例:CHILD,理由:'stop after sealing'});
 assert.equal((await s.act()).已请求中断,true);assert.equal(s.calls.length,1);
});
for(const [label,mutate] of [
 ['foreign-owner',s=>s.member(m=>({...m,委派者:{id:'other',kind:'Lead'}}))],
 ['no-registry',s=>s.member(()=>null)],['no-binding',s=>s.tasks(n=>({...n,绑定:[]}))],
 ['nonfrozen',s=>s.tasks(n=>({...n,判据冻结:false}))],['wrong-role',s=>s.tasks(n=>({...n,绑定:[{实例:CHILD,岗位:'文档整理'}]}))],
 ['wrong-owner',s=>s.tasks(n=>({...n,负责人:['other']}))],['wrong-project',s=>{s.host.project='other';}],
 ['fake-live-object',s=>{s.host.agent={...s.agent};}],['no-child',s=>{s.kids.length=0;}],
 ['one-shot',s=>{s.kids[0].mode='one-shot';}],['duplicate-child',s=>{s.kids.push({...s.kids[0]});}],
 ['closed-policy',s=>s.host.delegation.close()],['missing-service',s=>{delete s.host.subagents.interrupt;}],
]) test(`stop rejects ${label} before any Host request`,async t=>{
 const s=await fixture(t,{config:{}});mutate(s);await assert.rejects(s.act());assert.equal(s.calls.length,0);
});
test('only exact Lead can stop, explicit foreign task cannot substitute another binding',async t=>{
 const s=await fixture(t,{config:{}});await assert.rejects(s.act({}, {主体:MEMBER}));await assert.rejects(s.act({任务:'task-foreign'}));assert.equal(s.calls.length,0);
});
for(const mutation of ['ownership','task','catalog','approval','abort']) test(`stop rechecks after intent: ${mutation}`,async t=>{
 const s=await fixture(t,{config:{}}),append=s.org.audit.append.bind(s.org.audit),controller=new AbortController();s.host.signal=controller.signal;
 s.org.audit.append=async row=>{const out=await append(row);if(row.动作==='成员中断'&&row.结果==='意图'){
  if(mutation==='ownership')s.member(m=>({...m,委派者:{id:'other',kind:'Lead'}}));
  if(mutation==='task')s.tasks(n=>({...n,负责人:['other']}));
  if(mutation==='catalog')s.kids.length=0;
  if(mutation==='approval'){await s.f.write('集体L2-共享基础设施/defaults/介入度.json',JSON.stringify({介入度:'审批'}));await s.org.policy.reload();}
  if(mutation==='abort')controller.abort();
 }return out;};
 await assert.rejects(s.act());assert.equal(s.calls.length,0);
});
for(const issue of ['missing-capability','catalog-unavailable','duplicate-name','changed-name'])test(`Team stop has no direct-service fallback: ${issue}`,async t=>{
 const s=await fixture(t,{mode:'team',config:{}});
 if(issue==='missing-capability')delete s.host.hostMaintenance;
 if(issue==='catalog-unavailable')s.host.agentTeams.listMembers=()=>{throw Error('unavailable');};
 if(issue==='duplicate-name')s.rows.push({...s.rows[0],id:'other-child'});
 if(issue==='changed-name'){const append=s.org.audit.append.bind(s.org.audit);s.org.audit.append=async row=>{const out=await append(row);if(row.动作==='成员中断'&&row.结果==='意图')s.rows[0].name='renamed';return out;};}
 await assert.rejects(s.act());assert.equal(s.calls.length,0);
});
for(const outcome of [undefined,{提交状态:'未提交'}])test(`Host error after entering interruption is unknown, sanitized and never retried: ${JSON.stringify(outcome)}`,async t=>{
 const s=await fixture(t);s.host.subagents.interrupt=()=>{s.calls.push('attempt');throw Object.assign(Error('PRIVATE-HOST-TEXT'),{outcome});};
 await assert.rejects(s.act(),e=>{const r=describeFailure(e);assert.equal(r.提交状态,'未知');assert.equal(r.可重试,false);assert.ok(!JSON.stringify(r).includes('PRIVATE-HOST-TEXT'));return true;});assert.equal(s.calls.length,1);
});
test('intent audit failure stops before Host; receipt audit failure preserves acknowledged request',async t=>{
 const s=await fixture(t),append=s.org.audit.append.bind(s.org.audit);let phase='意图';
 s.org.audit.append=async row=>{if(row.动作==='成员中断'&&row.结果===phase)throw Error('audit unavailable');return append(row);};
 await assert.rejects(s.act());assert.equal(s.calls.length,0);phase='已请求';
 await assert.rejects(s.act(),e=>{const r=describeFailure(e);assert.equal(r.提交状态,'已提交');assert.equal(r.可重试,false);assert.ok(r.已确认阶段.some(x=>x.已请求===true&&!Object.hasOwn(x,'已停止')));assert.equal(e.detail.已停,null);return true;});assert.equal(s.calls.length,1);
});
