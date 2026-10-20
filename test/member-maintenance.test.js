import {test} from 'node:test';
import assert from 'node:assert/strict';
import {makeFixture,LEAD,MEMBER} from './helpers.mjs';
import {Org} from '../src/org.js';
import {runAction} from '../lib/actions.js';
import {DelegationPolicy} from '../src/delegation-policy.js';
const P='maintenance';const CHILD='precise-child';const SECRET='PRIVATE-MESSAGE-NOT-IN-AUDIT';
async function scene(fn,{role='插件工程'}={}){
 const f=await makeFixture();try{
 const org=await Org.open({home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project:P});
 await org.registry.assign({subject:LEAD,岗位:role,实例:CHILD});
 let business;if(role==='复核员')business=await org.tasks.create({subject:LEAD,项目:P,描述:'被验业务',负责人:['插件工程'],判据:['原判据']});
 const node=await org.tasks.create({subject:LEAD,项目:P,描述:'已有委派',负责人:[role],判据:['判据'],...(business?{复核对象:[business.id]}:{})});
 await org.tasks.bind(node.id,{subject:LEAD,项目:P,实例:CHILD,岗位:role});await org.tasks.dispatch(node.id,{subject:LEAD,项目:P});
 if(role==='复核员')await org.tasks.attach(node.id,{subject:LEAD,项目:P,产出物:f.factoryRoot,读根:true});
 const agent={id:LEAD.id,session:{id:LEAD.id,header:{id:LEAD.id,cwd:f.home}}};const calls={sub:[],team:[]};
 const host={project:P,agent,agents:{get:id=>id===agent.id?agent:undefined},delegation:new DelegationPolicy({}),agentTeams:{listMembers:()=>[]},subagents:{listChildren:async()=>[{id:CHILD,mode:'continuable',label:'owned',status:'inactive'}],sendMessage:async(sender,id,content,options)=>{assert.equal(sender,agent);assert.ok(options.signal instanceof AbortSignal);calls.sub.push({id,content});return 'accepted-inbox-id';}}};
 const act=(args,extra={})=>runAction({org,项目:P,主体:LEAD,面:'tool',宿主:host,args,...extra});
 const list=org.tasks.list.bind(org.tasks);const identity=org.registry.identity.bind(org.registry);
 const tasks=change=>{org.tasks.list=async q=>(await list(q)).map(n=>n.id===node.id?change(n):n).filter(Boolean);};
 const member=change=>{org.registry.identity=async()=>{const x=await identity();return {...x,members:{...x.members,[CHILD]:change(x.members[CHILD])}};};};
 await fn({org,f,node,business,host,agent,calls,act,tasks,member,list});
 }finally{await f.cleanup();}
}
const send=s=>s.act({action:'member_message',实例:CHILD,内容:SECRET});

test('explicit-user正控：已有在岗绑定子会话可续发，返回仅为inbox已接受',()=>scene(async s=>{const r=await send(s);assert.equal(r.通道,'subagent');assert.equal(r.已接收,true);assert.equal(r.消息id,'accepted-inbox-id');assert.equal(r.任务,s.node.id);assert.equal(s.calls.sub.length,1);assert.equal(s.host.delegation.status(P).authorized,false);}));
test('Team正控：真实名册优先，绝不通过普通服务发给Team成员',()=>scene(async s=>{s.host.agentTeams.listMembers=()=>[{id:CHILD,role:'teammate',name:'exact-name',status:'inactive'}];s.host.agentTeams.sendMessage=async(parent,args)=>{assert.equal(parent,s.agent);s.calls.team.push(args);return {messageId:'team-inbox'};};const r=await send(s);assert.equal(r.通道,'team');assert.equal(s.calls.team[0].target,'exact-name');assert.equal(s.calls.sub.length,0);}));
test('创建与中断授权不变：续发成功后member_spawn/stop仍需长期创建侧授权',()=>scene(async s=>{await send(s);for(const action of ['member_spawn','member_stop'])await assert.rejects(s.act({action,实例:CHILD}),/没有有效.*Lead 自主调度/);assert.equal(s.host.delegation.creationGuard({name:'subagent'},{subject:LEAD,project:P}),undefined);}));
test('仅真实Lead：成员和复核员不能通过既有维护路径派活',()=>scene(async s=>{await assert.rejects(s.act({action:'member_list'},{主体:MEMBER}),/仅 Lead|仅真实 Lead/);await assert.rejects(send({...s,act:args=>s.act(args,{主体:{id:CHILD,kind:'成员'}})}),/仅 Lead|仅真实 Lead/);}));
test('同id伪Agent对象不算真实live父对象',()=>scene(async s=>{s.host.agent={...s.agent};await assert.rejects(send(s),/真实.*Agent|live/);assert.equal(s.calls.sub.length,0);}));
test('宿主会话与主体id冲突不猜前缀或别名',()=>scene(async s=>{s.agent.session.id='other-parent';await assert.rejects(send(s),/会话.*不符|父会话/);assert.equal(s.calls.sub.length,0);}));
for(const [name,change,pattern]of [
 ['未登记',()=>undefined,/不在册/],['封存',m=>({...m,status:'封存'}),/不在岗|不在册/],['别父',m=>({...m,委派者:{...m.委派者,id:'another-parent'}}),/委派归属/],['缺委派归属',m=>({...m,委派者:null}),/委派归属/],
])test(name+'拒绝且零投递',()=>scene(async s=>{s.member(change);await assert.rejects(send(s),pattern);assert.equal(s.calls.sub.length,0);}));
for(const [name,change]of [
 ['缺绑定',n=>({...n,绑定:[]})],['异岗绑定',n=>({...n,绑定:n.绑定.map(b=>({...b,岗位:'文档整理'}))})],['改派到别岗',n=>({...n,负责人:['文档整理']})],['缺冻结',n=>({...n,判据冻结:false})],['旧会审只读',n=>({...n,模式:'独立会审'})],
 ...['待派发','待决','已采纳','已结账'].map(state=>[state,n=>({...n,状态:state})]),
])test('任务'+name+'不提供消息凭据',()=>scene(async s=>{s.tasks(change);await assert.rejects(send(s),/绑定|现行任务/);assert.equal(s.calls.sub.length,0);}));
test('跨项目参数不得把维护读写带出当前会话项目',()=>scene(async s=>{for(const action of ['member_message','member_list'])await assert.rejects(s.act({action,实例:CHILD,内容:SECRET,project:'foreign'}),/跨项目|会话项目/);assert.equal(s.calls.sub.length,0);}));
test('多任务绑定须显式任务id，不按第一条猜；指定另人任务仍拒',()=>scene(async s=>{const n=await s.org.tasks.create({subject:LEAD,项目:P,描述:'第二任务',负责人:['插件工程'],判据:['判据']});await s.org.tasks.bind(n.id,{subject:LEAD,项目:P,实例:CHILD,岗位:'插件工程'});await s.org.tasks.dispatch(n.id,{subject:LEAD,项目:P});await assert.rejects(send(s),/多个.*任务|显式.*任务/);const r=await s.act({action:'member_message',实例:CHILD,内容:SECRET,任务:n.id});assert.equal(r.任务,n.id);await assert.rejects(s.act({action:'member_message',实例:CHILD,内容:SECRET,任务:'other-task'}),/绑定|现行任务/);}));
for(const mode of ['one-shot','unknown','external',undefined])test('子目录模式'+mode+'不能被猜成continuable',()=>scene(async s=>{s.host.subagents.listChildren=async()=>[{id:CHILD,mode}];await assert.rejects(send(s),/continuable|直系子会话/);assert.equal(s.calls.sub.length,0);}));
test('空目录/缺目录服务/缺消息服务均fail-closed',()=>scene(async s=>{s.host.subagents.listChildren=async()=>[];await assert.rejects(send(s),/直系子会话|continuable/);delete s.host.subagents.listChildren;await assert.rejects(send(s),/目录|服务/);delete s.host.subagents;await assert.rejects(send(s),/目录|服务/);assert.equal(s.calls.sub.length,0);}));
test('Team目录查询失败不得盲退普通消息',()=>scene(async s=>{s.host.agentTeams.listMembers=()=>{throw Error('private host data');};await assert.rejects(send(s),/Team.*目录|Team.*名册/);assert.equal(s.calls.sub.length,0);}));
test('无Team成员关系时以官方tryMembership证明不属Team再走普通路径',()=>scene(async s=>{s.host.agentTeams.tryMembership=()=>null;s.host.agentTeams.listMembers=()=>{throw Error('should not query');};assert.equal((await send(s)).通道,'subagent');}));
test('宿主冷恢复缺持久描述符须响亮失败，不制造已接收或自动重发',()=>scene(async s=>{s.host.subagents.sendMessage=async()=>{s.calls.sub.push('attempt');throw Object.assign(Error(SECRET),{code:'NOT_RESUMABLE'});};await assert.rejects(send(s),e=>e.code==='MEMBER_MESSAGE_FAILED'&&e.detail?.宿主错误码==='NOT_RESUMABLE'&&!e.message.includes(SECRET));assert.equal(s.calls.sub.length,1);const rows=await s.org.audit.read({});assert.ok(rows.some(r=>r.动作==='成员消息'&&r.结果==='发送失败'));assert.ok(!JSON.stringify(rows).includes(SECRET));}));
test('列表只列自己的本项目现行绑定实例，未知/别父/未登记不扩张',()=>scene(async s=>{await s.org.registry.assign({subject:LEAD,岗位:'插件工程',实例:'foreign'});const readIdentity=s.org.registry.identity.bind(s.org.registry);s.org.registry.identity=async()=>{const x=await readIdentity();return {...x,members:{...x.members,foreign:{...x.members.foreign,委派者:{id:'other-parent',kind:'Lead'}}}};};s.host.subagents.listChildren=async()=>[{id:CHILD,mode:'continuable',label:'owned',status:'inactive'},{id:'unknown',mode:'continuable',label:'PRIVATE-OTHER'},{id:'foreign',mode:'continuable'}];const r=await s.act({action:'member_list'});assert.deepEqual(r.成员.map(x=>x.实例),[CHILD]);assert.equal(r.成员[0].状态,'inactive');assert.deepEqual(r.成员[0].任务,[s.node.id]);assert.ok(!JSON.stringify(r).includes('PRIVATE-OTHER'));}));
test('列表Team去重优先；子目录失败须明确不可用且不得冒认来源',()=>scene(async s=>{s.host.agentTeams.listMembers=()=>[{id:CHILD,role:'teammate',name:'team-name',status:'inactive'}];let r=await s.act({action:'member_list'});assert.equal(r.成员.length,1);assert.equal(r.成员[0].来源,'team');s.host.agentTeams.listMembers=()=>[];s.host.subagents.listChildren=async()=>{throw Error('private-source');};r=await s.act({action:'member_list'});assert.equal(r.可用,false);assert.equal(r.成员[0].来源,null);assert.equal(r.成员[0].状态,null);assert.ok(r.不可用.includes('subagent目录'));assert.ok(!JSON.stringify(r).includes('private-source'));}));
test('正常消息审计有父子/项目/任务和接收id，无正文，未声称已经执行',()=>scene(async s=>{await send(s);await s.act({action:'member_list'});const rows=(await s.org.audit.read({})).filter(r=>['成员消息','成员列表'].includes(r.动作));assert.equal(rows.length,3);assert.equal(rows[0].结果,'意图');assert.equal(rows[1].结果,'已接收');assert.equal(rows[1].详情.任务,s.node.id);assert.equal(rows[1].详情.父,LEAD.id);assert.equal(rows[1].详情.子,CHILD);assert.equal(rows[1].详情.消息id,'accepted-inbox-id');assert.ok(rows.every(r=>r.项目===P));assert.ok(!JSON.stringify(rows).includes(SECRET));}));
test('接收后审计失败返回已接收+不可盲重试，不回滚也不自动重发',()=>scene(async s=>{const append=s.org.audit.append.bind(s.org.audit);s.org.audit.append=async row=>{if(row.动作==='成员消息'&&row.结果==='已接收')throw Error('audit disk');return append(row);};await assert.rejects(send(s),e=>e.code==='AUDIT_APPEND_FAILED_AFTER_MEMBER_MESSAGE'&&e.detail?.已接收===true&&e.detail?.可重试===false&&e.detail?.消息id==='accepted-inbox-id');assert.equal(s.calls.sub.length,1);}));
test('意图审计失败零发送；关闭调度维护即拒；查询途中封存也零发送',()=>scene(async s=>{const append=s.org.audit.append.bind(s.org.audit);s.org.audit.append=async row=>{if(row.动作==='成员消息'&&row.结果==='意图')throw Error('audit disk');return append(row);};await assert.rejects(send(s),/audit disk/);assert.equal(s.calls.sub.length,0);s.org.audit.append=append;s.host.delegation.close();await assert.rejects(send(s),e=>e.code==='DELEGATION_DISPOSED');s.host.delegation=new DelegationPolicy({});s.host.subagents.listChildren=async()=>{await s.org.registry.seal({subject:LEAD,实例:CHILD,理由:'mid-query revoke'});return [{id:CHILD,mode:'continuable'}];};await assert.rejects(send(s),/不在册|不在岗/);assert.equal(s.calls.sub.length,0);}));
test('复核员实例正控：显式复核对象/冻结判据/正式读根齐全方能续发',()=>scene(async s=>{assert.equal((await send(s)).已接收,true);s.tasks(n=>({...n,复核读根:[]}));await assert.rejects(send(s),/绑定|现行任务/);s.tasks(n=>({...n,复核对象:[]}));await assert.rejects(send(s),/绑定|现行任务/);},{role:'复核员'}));
test('真实任务生命周期：执行中、已交卷和打回返工仍可维护，终态不靠旧绑定放行',()=>scene(async s=>{
 const child={id:CHILD,kind:'成员',roleId:'插件工程'};
 await s.org.tasks.start(s.node.id,{subject:child,项目:P});assert.equal((await send(s)).已接收,true);
 await s.org.tasks.submit(s.node.id,{subject:child,项目:P,结论:'fixture done'});assert.equal((await send(s)).已接收,true);
 await s.org.tasks.review(s.node.id,{subject:LEAD,项目:P,三态:'不过',分歧清单:['fixture rework'],反例面:['fixture']});
 assert.equal((await send(s)).已接收,true);
}));
test('消息接收凭据未知不是成功：空回执不重发且审计明确接收未知',()=>scene(async s=>{
 s.host.subagents.sendMessage=async()=>{s.calls.sub.push('attempt');return {};};
 await assert.rejects(send(s),e=>e.code==='MEMBER_MESSAGE_RECEIPT_UNKNOWN'&&e.detail?.已接收===null&&e.detail?.可重试===false);
 assert.equal(s.calls.sub.length,1);assert.ok((await s.org.audit.read({})).some(r=>r.动作==='成员消息'&&r.结果==='接收未知'));
}));
test('缺live校验服务/消息服务、子会话伪父、重复目录均零发送',()=>scene(async s=>{
 const agents=s.host.agents;delete s.host.agents;await assert.rejects(send(s),/真实.*Agent|live/);s.host.agents=agents;
 s.agent.session.header.origin='subagent';await assert.rejects(send(s),/父会话|主体不符/);delete s.agent.session.header.origin;
 s.host.subagents.listChildren=async()=>[{id:CHILD,mode:'continuable'},{id:CHILD,mode:'continuable'}];await assert.rejects(send(s),/唯一直接|continuable/);
 s.host.subagents.listChildren=async()=>[{id:CHILD,mode:'continuable'}];delete s.host.subagents.sendMessage;await assert.rejects(send(s),/消息服务/);assert.equal(s.calls.sub.length,0);
}));
test('意图后政策收紧仍在投递前复检，准入通过不缓存写许可',()=>scene(async s=>{
 const append=s.org.audit.append.bind(s.org.audit);s.org.audit.append=async row=>{
  const out=await append(row);if(row.动作==='成员消息'&&row.结果==='意图'){
   await s.f.write('集体L2-共享基础设施/defaults/介入度.json',JSON.stringify({介入度:'审批'}));await s.org.policy.reload();
  }return out;
 };await assert.rejects(send(s),e=>e.name==='NeedsApproval');assert.equal(s.calls.sub.length,0);
}));
test('宿主异常code和message都不得反射私有消息正文',()=>scene(async s=>{
 s.host.subagents.sendMessage=async()=>{throw Object.assign(Error(SECRET),{code:SECRET});};
 await assert.rejects(send(s),e=>e.code==='MEMBER_MESSAGE_FAILED'&&e.detail?.宿主错误码==='UNKNOWN');assert.ok(!JSON.stringify(await s.org.audit.read({})).includes(SECRET));
}));
test('审批档仍经唯一策略挂起，零发送，不能因维护准入而绕介入度',()=>scene(async s=>{await s.f.write('集体L2-共享基础设施/defaults/介入度.json',JSON.stringify({介入度:'审批'}));await s.org.policy.reload();await assert.rejects(send(s),e=>e.name==='NeedsApproval');assert.equal(s.calls.sub.length,0);}));
