import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, stat, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { recallProfessionalContext, PROFESSIONAL_CONTEXT_BUDGET } from '../src/professional-context.js';
import { createMemoryUseHooks } from '../components/kernel/lib/memory-use-hooks.js';
import { injectProfessionalContext, PROFESSIONAL_SECTION } from '../components/kernel/lib/professional-context.js';
import { fakeHost } from './host-harness.mjs';
import { runAction, ACTIONS, READ_ONLY_ACTIONS } from '../lib/actions.js';
import { memoryUse路由 } from '../components/kernel/lib/routes.js';
import { injectLeadContext, LEAD_CONTEXT_SECTION } from '../components/kernel/lib/lead-context.js';
const P = 'reuse';
async function fixture(run) { const f = await makeFixture(); try { const org = await Org.open({ home:f.home, factoryRoot:f.factoryRoot, privateRoot:f.privateRoot, project:P }); await run(org, f); } finally { await f.cleanup(); } }
const remember = (org, body, extra = {}) => org.memory.remember({ subject:LEAD, 项目:P, 类:'知识', 岗位:'插件工程', 内容:body, 来源:'合成测试来源', ...extra });
async function task(org, description='重连处理') {
 const n=await org.tasks.create({subject:LEAD,项目:P,描述:description,负责人:MEMBER.roleId,判据:['连接恢复']});
 await org.tasks.bind(n.id,{subject:LEAD,项目:P,实例:MEMBER.id,岗位:MEMBER.roleId}); await org.tasks.dispatch(n.id,{subject:LEAD,项目:P}); await org.tasks.start(n.id,{subject:MEMBER,项目:P}); return n;
}
const expression = query => () => ({ query, stamp:query });
const frameOf = assembly => JSON.parse(assembly.sections.find(s=>s.name===PROFESSIONAL_SECTION).text.split('\n').at(-1));
function observe(org, subject=LEAD) {
 const agent={session:{id:subject.id,header:{cwd:process.cwd(),...(subject.kind==='成员'?{origin:'subagent',delegationDepth:1}:{})},surface:{replaceGeneration:0}}};
 const hooks=createMemoryUseHooks({org,projectOf:()=>P,logger:{warn(){}}}); org.memoryUseHooks=hooks;
 const host=fakeHost(); const close=hooks.attach(host.ctx); return {agent,hooks,host,close};
}
const toolResult = body => ({isError:false,content:[{type:'text',text:JSON.stringify({成功:true,...body})}]});
it('Lead当前问题找回旧知识，零命中不塞最近项；重启后仍可调用',async()=>fixture(async(org,f)=>{
 const old=await remember(org,'reconnect backoff 使用指数退避',{岗位:'Lead'});
 for(let i=0;i<8;i++)await remember(org,'ocean 写作 '+i,{岗位:'Lead'});
 const reopened=await Org.open({home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project:P});
 const found=await recallProfessionalContext({org:reopened,subject:LEAD,project:P,readExpression:expression('掉线后怎样重试')});
 assert.ok(found.知识.some(i=>i.id===old.id)); assert.doesNotMatch(JSON.stringify(found),/ocean/);
 assert.deepEqual((await recallProfessionalContext({org,subject:LEAD,project:P,readExpression:expression('aardvark') })).知识,[]);
}));
it('成员任务自动召回相关旧知识、同项目经历、新发布能力；不依赖改岗位卡',async()=>fixture(async org=>{
 await task(org); const k=await remember(org,'reconnect backoff 应限速');
 const e=await remember(org,'reconnect 上次雪崩事故',{类:'经历',岗位:undefined});
 await remember(org,'reconnect 外项目事故',{类:'经历',岗位:undefined,项目:'other'});
 const c=await org.capability.publish({subject:LEAD,id:'reconnect-new',名:'reconnect backoff',适用岗位:[MEMBER.roleId],正文:'reconnect 指数退避\n适用条件：幂等请求\n反例：非幂等写入不可盲重试',依据:'合成测试'});
 const frame=await recallProfessionalContext({org,subject:MEMBER,project:P});
 assert.ok(frame.知识.some(i=>i.id===k.id)); assert.deepEqual(frame.经历.map(i=>i.id),[e.id]); assert.ok(frame.能力.some(i=>i.id===c.id));
 assert.match(frame.能力[0].内容片段,/非幂等/); assert.ok(JSON.stringify(frame).length<=PROFESSIONAL_CONTEXT_BUDGET);
 assert.ok(!(await org.registry.cardOf(MEMBER.id)).能力引用.includes(c.id));
}));
it('知识适用说明和反例参与检索并装配；长文要求继续读取',async()=>fixture(async org=>{
 await task(org,'处理磁盘故障');
 const k=await remember(org,'通用方法'+ '甲'.repeat(900),{知识说明:{适用条件:['磁盘故障'],已知反例:['只读设备不执行写入']}});
 const frame=await recallProfessionalContext({org,subject:MEMBER,project:P}); const row=frame.知识.find(i=>i.id===k.id);
 assert.ok(row); assert.deepEqual(row.知识说明.已知反例,['只读设备不执行写入']); assert.equal(row.需继续读取,true); assert.equal(frame.截断,true);
 const full=await runAction({org,主体:MEMBER,项目:P,args:row.继续读取}); assert.equal(full.结果.条目[0].内容.length,904);
}));
it('个人无岗位知识默认归Lead，仍保留项目和私人关系隔离',async()=>fixture(async org=>{
 const k=await org.memory.rememberPersonal({subject:LEAD,项目:P,类:'知识',内容:'reconnect 私人经验',来源:'合成测试'});
 const frame=await recallProfessionalContext({org,subject:LEAD,project:P,readExpression:expression('重连')}); assert.ok(frame.知识.some(i=>i.id===k.id));
 await task(org); assert.ok(!(await recallProfessionalContext({org,subject:MEMBER,project:P})).知识.some(i=>i.id===k.id));
}));
it('最终版本复核期间身份或问题变化也丢弃旧帧',async()=>fixture(async org=>{
 await remember(org,'reconnect',{岗位:'Lead'}); const query=org.memory.query.bind(org.memory); let changed=false;
 org.memory.query=async spec=>{const r=await query(spec); if(spec.数据版本)changed=true;return r;};
 await assert.rejects(recallProfessionalContext({org,subject:LEAD,project:P,readExpression:()=>({query:'reconnect',stamp:changed?'new':'old'})}),/校验期间/);
}));
it('已撤回能力不召回，复核经历仍限定真实对象',async()=>fixture(async org=>{
 const target=await org.tasks.create({subject:LEAD,项目:P,描述:'reconnect',负责人:['Lead'],判据:['reconnect']});
 const review=await org.tasks.create({subject:LEAD,项目:P,描述:'reconnect review',负责人:['复核员'],判据:['reconnect'],复核对象:[target.id]});
 await org.tasks.bind(review.id,{subject:LEAD,项目:P,实例:'reviewer',岗位:'复核员'});await org.tasks.dispatch(review.id,{subject:LEAD,项目:P});
 const yes=await remember(org,'reconnect 事故',{类:'经历',岗位:undefined,来源引用:[target.id]}); await remember(org,'reconnect 禁止看到',{类:'经历',岗位:undefined});
 const read=org.capability.read.bind(org.capability); org.capability.read=async spec=>spec.id==='withdrawn'?null:read(spec);
 const list=org.capability.list.bind(org.capability); org.capability.list=async spec=>[...await list(spec),{id:'withdrawn',来源:'自治',名:'reconnect',摘要:'reconnect',适用岗位:['复核员']}];
 const frame=await recallProfessionalContext({org,subject:{id:'reviewer',kind:'成员'},project:P}); assert.deepEqual(frame.经历.map(i=>i.id),[yes.id]);assert.deepEqual(frame.能力,[]);
}));
it('选中、装配、请求观察、显式读取和采用声明分开持久化，不复制正文或查询',async()=>fixture(async(org,f)=>{
 const n=await task(org); const k=await remember(org,'reconnect secret-body-abcdef'); const {agent,hooks,close}=observe(org,MEMBER);
 const assembly=await injectProfessionalContext({sections:[]},{org,agent,projectOf:()=>P}); const section=assembly.sections[0].text; await hooks.flush();
 assert.deepEqual((await org.memoryUse.query({subject:MEMBER,project:P})).counts,{selected:1,assembled:1,'request-observed':0,'explicit-read':0,'adoption-declared':0});
 hooks.observeRequest({messages:[{role:'user',content:[{type:'text',text:section}]}]});
 hooks.observeRequest({system:section.replace('secret-body-abcdef','changed')});await hooks.flush();assert.equal((await org.memoryUse.query({subject:MEMBER,project:P})).counts['request-observed'],0);
 const request={system:section}; hooks.observeRequest(request);hooks.observeRequest(request);await hooks.flush();
 const detail=await runAction({org,主体:MEMBER,项目:P,args:{action:'memory_query',id:k.id,类:'知识',返回模式:'全文'}});
 hooks.result({agent,name:'mind',callId:'read-1',arguments:{action:'memory_query'}},toolResult(detail));await hooks.flush();
 const args={action:'task_submit',id:n.id,结论:'完成',采用知识:[{id:k.id,用途:'检查重连',适用判断:'幂等',使用结果:'未知'}]};
 const submitted=await runAction({org,主体:MEMBER,项目:P,args});hooks.result({agent,name:'mind',callId:'submit-1',arguments:args},toolResult(submitted));await hooks.flush();
 const report=await org.memoryUse.query({subject:LEAD,project:P,id:k.id}); assert.deepEqual(report.counts,{selected:1,assembled:1,'request-observed':1,'explicit-read':1,'adoption-declared':1});assert.equal(report.coverage.actualUnderstanding,'未知');
 const files=await readdir(org.memoryUse.root(P));const file=join(org.memoryUse.root(P),files.find(n=>n.endsWith('.jsonl')));const disk=await readFile(file,'utf8');assert.doesNotMatch(disk,/secret-body-abcdef|内容片段|"query":|"描述":/);assert.equal((await stat(file)).mode&0o777,0o600);
 close();const reopened=await Org.open({home:f.home,privateRoot:f.privateRoot,factoryRoot:f.factoryRoot,project:P});assert.equal((await reopened.memoryUse.query({subject:LEAD,project:P,id:k.id})).total,5);
}));
it('官方请求钩子透传同一迭代器，不改请求；卸载后不记录',async()=>fixture(async org=>{
 await remember(org,'memory-body',{岗位:'Lead'});const {agent,hooks,host,close}=observe(org);
 const assembly=await injectProfessionalContext({sections:[]},{org,agent,projectOf:()=>P});await hooks.flush();
 let callback;const h=createMemoryUseHooks({org,projectOf:()=>P,logger:{warn(){}}});const stop=h.attach({on(name,fn){if(name==='llm/stream')callback=fn;return()=>{};}});
 h.recordAssembly(agent,frameOf(assembly),assembly.sections[0].text);await h.flush();const options=Object.freeze({system:assembly.sections[0].text});const iterator=(async function*(){yield 'ok';})();assert.equal(callback(options,()=>iterator),iterator);await h.flush();stop();close();const before=(await org.memoryUse.query({subject:LEAD,project:P})).total;callback(options,()=>iterator);await h.flush();assert.equal((await org.memoryUse.query({subject:LEAD,project:P})).total,before);
}));
it('私人成员观察不跨实例，Lead私人观察不跨关系；关系重绑不追认历史',async()=>fixture(async org=>{
 await org.memoryUse.observe({subject:MEMBER,project:P,session:MEMBER.id,stage:'explicit-read',observation:'one',items:[{id:'know-1',kind:'知识'}]});
 assert.equal((await org.memoryUse.query({subject:{id:'member-b',kind:'成员'},project:P})).total,0);
 await org.memoryUse.observe({subject:LEAD,project:P,session:LEAD.id,stage:'explicit-read',observation:'private',items:[{id:'know-private',kind:'知识'}]});
 const relationship=org.dataOwnership.relationship.bind(org.dataOwnership);org.dataOwnership.relationship=async session=>session===LEAD.id?'different':relationship(session);
 assert.ok(!(await org.memoryUse.query({subject:LEAD,project:P})).entries.some(r=>r.observation==='private'));
 assert.equal((await org.memoryUse.query({subject:{id:'human',kind:'主权者'},project:P})).total,2);
}));
it('观察损坏、符号链接和过时身份不伪装成零记录',async()=>fixture(async org=>{
 const row={subject:LEAD,project:P,session:LEAD.id,stage:'assembled',observation:'test',items:[]};await org.memoryUse.observe(row);
 const root=org.memoryUse.root(P);const file=join(root,(await readdir(root)).find(n=>n.endsWith('.jsonl')));await writeFile(file,'bad\n');await assert.rejects(org.memoryUse.query({subject:LEAD,project:P}),/损坏/);
 await rm(file);await symlink(org.layout.identityFile(),file);await assert.rejects(org.memoryUse.observe(row));await assert.rejects(org.memoryUse.query({subject:LEAD,project:P}));
}));
it('队列写入时身份或关系变化丢弃旧观察，不将旧角色记入新身份',async()=>fixture(async org=>{
 let valid=true;const job=org.memoryUse.observe({subject:LEAD,project:P,session:LEAD.id,stage:'assembled',observation:'late',valid:()=>valid,items:[]});valid=false;await assert.rejects(job,/旧观察不归入/);
 assert.equal((await org.memoryUse.query({subject:LEAD,project:P})).total,0);
}));
it('只读观察工具可调用且模型没有补写或清零入口',async()=>fixture(async org=>{
 assert.ok(ACTIONS.includes('memory_use_query'));assert.ok(READ_ONLY_ACTIONS.includes('memory_use_query'));
 const r=await runAction({org,主体:LEAD,项目:P,args:{action:'memory_use_query'}});assert.equal(r.数据.total,0);assert.equal(r.数据.coverage.actualUnderstanding,'未知');
 await assert.rejects(runAction({org,主体:LEAD,项目:P,args:{action:'memory_use_write'}}),/未知/);
}));
it('人侧调用观察必须认证且同源，仅GET，不接受补写和重放',async()=>fixture(async org=>{
 async function request(ctx,method='GET',suffix='',headers={}){
 const req={method,url:'/plugins/dsh-mind/memory-use'+suffix,headers:{host:'127.0.0.1:3080',origin:'http://127.0.0.1:3080','sec-fetch-site':'same-origin',...headers}};
 const res={writeHead(status){this.status=status;},end(raw){this.body=JSON.parse(raw);}};await memoryUse路由({ctx,org,项目:P})(req,res);return res;
 }
 const ctx={get:()=>({requestRejection:()=>undefined})};
 assert.equal((await request({get:()=>null})).status,503);assert.equal((await request({get:()=>({requestRejection:()=>401})})).status,401);
 assert.equal((await request(ctx,'GET','',{'sec-fetch-site':'cross-site'})).status,403);assert.equal((await request(ctx,'POST')).status,405);
 assert.equal((await request(ctx,'GET','?limit=0')).status,400);const ok=await request(ctx);assert.equal(ok.status,200);assert.equal(ok.body.数据.coverage.actualUnderstanding,'未知');
}));
it('既有Lead偏好与共同经历也观察；两段独立更新，不把撤回旧段算入新请求',async()=>fixture(async org=>{
 const pref=await org.memory.remember({subject:LEAD,类:'偏好',项目:P,内容:'保持有趣，少些套话',来源:'合成明确表达',连续性:{类别:'用户偏好',主题:'表达',依据:'明确表达',范围:'项目'}});
 const exp=await org.memory.rememberPersonal({subject:LEAD,类:'经历',项目:P,内容:'合成共同散步',来源:'合成夹具'});
 const {agent,hooks,close}=observe(org);
 let assembly=await injectProfessionalContext({sections:[]},{org,agent,projectOf:()=>P});assembly=await injectLeadContext(assembly,{org,agent,projectOf:()=>P});await hooks.flush();
 const personal=assembly.sections.find(s=>s.name===LEAD_CONTEXT_SECTION);assert.ok(personal);hooks.observeRequest({system:assembly.sections.map(s=>s.text).join('\n')});await hooks.flush();
 for(const id of [pref.id,exp.id]){const report=await org.memoryUse.query({subject:LEAD,project:P,id});assert.equal(report.counts.assembled,1);assert.equal(report.counts['request-observed'],1);assert.equal(report.entries.find(r=>r.stage==='assembled').items.find(i=>i.id===id).partial,true);}
 await org.memory.invalidate(pref.id,{subject:LEAD,原因:'更正'});await org.memory.invalidate(exp.id,{subject:LEAD,原因:'更正'});
 const next=await injectLeadContext(assembly,{org,agent,projectOf:()=>P});assert.ok(!next.sections.some(s=>s.name===LEAD_CONTEXT_SECTION));hooks.observeRequest({system:personal.text});await hooks.flush();assert.equal((await org.memoryUse.query({subject:LEAD,project:P,id:pref.id})).counts['request-observed'],1);close();
}));
