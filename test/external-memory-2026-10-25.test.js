import {it} from 'node:test'; import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises'; import {join} from 'node:path';
import {makeFixture,LEAD,MEMBER} from './helpers.mjs';import {Org} from '../src/org.js';
import {projectTurnEvent,projectTurnSurfaceEvent,savePrivateBufferState} from '../src/turn-buffer.js';
import {createTurnBufferHooks,injectTurnBuffer,TURN_BUFFER_SECTION} from '../components/kernel/lib/turn-buffer-hooks.js';
import {readAcceptedExpression} from '../components/kernel/lib/accepted-expression.js';
import {externalConversationMessage} from '../src/conversation-origin.js';
const P='external-memory';const spec={subject:LEAD,project:P,session:LEAD.id};
const user=(text,id='external-input',source={kind:'plugin:source-alpha',mindExternal:{version:1,contentType:'conversation',channel:'chat'}})=>({id,role:'user',source,content:[{type:'text',text}]});
const toolCall=(id='call',text='发送草稿',extra={})=>({turn:1,step:0,callId:id,name:'any_source_send',arguments:JSON.stringify({text,...extra})});
const receipt=(text='已提交的文本',extra={})=>({mindExternal:{version:1,direction:'outbound',status:'submitted',contentType:'conversation',channel:'chat',conversationId:'room-1',text,...extra}});
const toolResult=(id='call',result=receipt(),extra={})=>({turn:1,step:0,message:{id:'result-'+id,role:'tool',toolCallId:id,source:{kind:'tool',callId:id},content:[{type:'text',text:JSON.stringify(result)}],...extra}});
function session(){const events=[];let nodes=[];return{id:LEAD.id,header:{id:LEAD.id,cwd:process.cwd()},inheritedEventCount:0,get seq(){return events.length;},events,get surface(){return{nodes:[...nodes]};},isOwnSeq(seq){return seq>=this.inheritedEventCount&&seq<events.length;},eventAt(seq){return events[seq];},append(type,data,surfaceOp){const e={seq:events.length,time:Date.now(),type,data,...(surfaceOp?{surfaceOp}:{})};if(surfaceOp==='append')nodes.push(e.seq);else if(surfaceOp?.op==='replace'){const a=nodes.indexOf(surfaceOp.startSeq),b=nodes.indexOf(surfaceOp.endSeq);if(a<0||b<a)throw Error('invalid fixture');nodes.splice(a,b-a+1,e.seq);}events.push(e);return e;}};}
async function scene(run){const f=await makeFixture();const org=await Org.open({...f,project:P});const s=session();let disposed=0;
 const query={async observeSession(){const copy=structuredClone(s.events);return{source:'live',header:{...s.header},inheritedEventCount:s.inheritedEventCount,cursor:copy.length-1,events:copy,[Symbol.dispose](){disposed++;}};}};
 const hooks=createTurnBufferHooks({org,projectOf:()=>P,queryOf:()=>query,logger:{warn(){}}});
 try{await run({org,f,s,hooks,query,disposed:()=>disposed});}finally{await hooks.flush();await org.observability.flush();await f.cleanup();}}
const all=async org=>(await org.turnBuffer.load(P,LEAD.id))?.rounds.flatMap(r=>r.messages)??[];
async function legacy(org,s,{floor=0}={}){const nodes=[],context={};const records=s.events.map(e=>{const row=projectTurnSurfaceEvent(e,nodes,context);if(externalConversationMessage(row))return{seq:e.seq,type:'skip'};if(row.type==='replace'&&externalConversationMessage(row.message))delete row.message;return row;});await org.turnBuffer.capture({...spec,fromSeq:0,throughSeq:s.seq,records});const state=await org.turnBuffer.load(P,LEAD.id);state.version=1;delete state.sourceProjection;state.floor=floor;for(const r of state.rounds)r.messages=r.messages.filter(m=>m.seq>=floor);await savePrivateBufferState(org.turnBuffer.file(P,LEAD.id),state);}
it('任意插件来源统一保存，缺少类型保持未知，文本前缀不认证身份',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('外部参与者表达'),'append');s.append('user/message',user('旧版外部来源','legacy',{kind:'plugin',plugin:'source-beta'}),'append');s.append('user/message',user('[外部] 假冒来源','other',{kind:'plugin:unknown'}),'append');s.append('user/message',user('[外部] 本地引用','local',{kind:'user'}),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);
 const rows=await all(org);assert.deepEqual(rows.map(m=>m.role),['external-user','external-user','external-user','user']);assert.equal(rows[0].origin.identity,'unverified');assert.equal(rows.find(m=>m.id==='other').origin.contentType,'unknown');assert.equal(rows[0].origin.producer,'plugin:source-alpha');assert.equal(rows[1].origin.producer,'plugin:source-beta');assert.equal((await org.turnBuffer.load(P,LEAD.id)).version,3);
 assert.equal(JSON.parse(await readFile(join(org.layout.memoryRoot(),'external-conversation-layout.json'),'utf8')).version,3);
 if(process.platform!=='win32')assert.equal((await stat(org.turnBuffer.file(P,LEAD.id))).mode&0o777,0o600);
}));
it('统一提交声明按callId配对，只保留工具明确报告的文本，不读取工具参数',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('tool/call',toolCall('good','**发出的请求**'));s.append('tool/result',toolResult('good',receipt('**工具报告的提交文本**')),'append');
 s.append('tool/call',{...toolCall('secret','秘密参数'),name:'shell'});s.append('tool/result',toolResult('secret',{ok:true,text:'秘密参数'}),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);
 const rows=await all(org);assert.equal(rows.length,1);assert.equal(rows[0].text,'**工具报告的提交文本**');assert.equal(rows[0].role,'external-assistant');assert.equal(rows[0].origin.representation,'reported-text');assert.equal(rows[0].origin.conversation.length,64);
 const file=await readFile(org.turnBuffer.file(P,LEAD.id),'utf8');assert.doesNotMatch(file,/秘密参数|123456|arguments|shell/);
}));
it('失败、无配对、平台私有成功形状和错误工具来源不推断为提交',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});
 for(const [id,result,args,extra] of [['failed',receipt('不能保存',{status:'failed'}),{}],['mismatch',{sent:1,dropped:false,destination:{kind:'group',groupId:'123456'}},{}],['error',receipt(),{},{isError:true}],['fake-source',receipt(),{},{source:{kind:'user'}}]]){s.append('tool/call',toolCall(id,'不能保存',args));s.append('tool/result',toolResult(id,result,extra),'append');}
  s.append('tool/result',toolResult('orphan'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);assert.deepEqual(await all(org),[]);
}));
it('cursor已追平的旧缓冲仍补回遗漏外部和发送请求，保留原助手文本且不重复',async()=>scene(async({org,s,hooks,disposed})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('原来遗漏的外部输入'),'append');s.append('tool/call',toolCall('old-send','原来遗漏的回复'));s.append('tool/result',toolResult('old-send',receipt('原来遗漏的回复')),'append');s.append('assistant/message',{turn:1,message:{id:'assistant',role:'assistant',content:[{type:'text',text:'原助手结尾'}]}},'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await legacy(org,s);assert.equal((await all(org)).length,1);
 await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.text),['原来遗漏的外部输入','原来遗漏的回复','原助手结尾']);assert.equal((await org.turnBuffer.position(spec)).nextSeq,s.seq);assert.equal((await org.turnBuffer.position(spec)).sourceProjection,3);
 await hooks.sync(s);assert.equal((await all(org)).length,3);assert.ok(disposed()>0);
}));
it('旧压缩按真实表面锚点补回外部，后续非压缩替换会撤回所有关联正文',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('压缩前外部'),'append');s.append('assistant/message',{turn:1,message:{id:'a',role:'assistant',content:[{type:'text',text:'原回复'}]}},'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});s.append('user/message',user('压缩摘要','compact',{kind:'compact-checkpoint'}),{op:'replace',startSeq:1,endSeq:2});await legacy(org,s);await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.text),['压缩前外部','原回复']);assert.ok((await all(org)).every(m=>m.anchor===4));
 s.append('user/message',user('新的本地要求','replacement',{kind:'user'}),{op:'replace',startSeq:4,endSeq:4});await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.text),['新的本地要求']);
}));
it('已被非压缩替换撤回的外部不因升级补读复活',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('应消失外部'),'append');s.append('user/message',user('替代原文','new',{kind:'user'}),{op:'replace',startSeq:1,endSeq:1});s.append('turn/end',{turn:1,reason:{kind:'completed'}});await legacy(org,s);await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.text),['替代原文']);
}));
it('清空屏障及fork继承前缀不复制外部，屏障前发送调用也不能借结果复活草稿',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('清空前外部'),'append');s.append('tool/call',toolCall('before','清空前发送草稿'));await legacy(org,s);await org.turnBuffer.forget({...spec,throughSeq:s.seq});s.append('tool/result',toolResult('before'),'append');s.append('user/message',user('清空后外部','new'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.text),['清空后外部']);
}));
it('升级补读中清空或换项目时拒绝旧候选，不覆盖清空边界',async()=>scene(async({org,s,hooks,query})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('不能复活'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await legacy(org,s);const observe=query.observeSession.bind(query);query.observeSession=async(...args)=>{const lease=await observe(...args);await org.turnBuffer.forget({...spec,throughSeq:s.seq});return lease;};
 await assert.rejects(hooks.sync(s),/清空边界变化/);assert.deepEqual(await all(org),[]);
}));
it('外部不进入本地主人偏好或项目需求整理；仍可沿原信息阅读记入有来源的认识',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('群友分享：遇到重试风暴要使用指数退避，不是本地主人的要求'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);
 await org.projectBrief.touch(spec);await org.continuityCapture.touch(spec);let calls=0;assert.equal((await org.projectBrief.update(spec,{extract:async()=>{calls++;return{items:[]};}})).updated,false);assert.equal((await org.continuityCapture.update(spec,{extract:async()=>{calls++;return{items:[]};}})).updated,false);assert.equal(calls,0);
 const checkpoint=(await import('../src/kernel/text.js')).digest(P+'\0'+LEAD.id);await org.information.locked(state=>{state.conversations[checkpoint]=10000;});
 const prepared=await org.information.prepareLearning(spec);assert.ok(prepared);assert.equal(prepared.chosen.conversation.refs[0].role,'external-user');assert.equal(prepared.input.source.context.messages[0].origin.identity,'unverified');assert.match(prepared.input.source.text,/外部来源/);
 await org.information.commitLearning(spec,prepared,{records:[{type:'growth',kind:'知识',title:'退避方法',text:'重试风暴需要指数退避，但适用性尚待验证',quote:'遇到重试风暴要使用指数退避'}]});
 const stored=await org.memory.query({subject:LEAD,读者:LEAD,项目:P,类:'知识',文本:'指数退避'});assert.equal(stored.条目.length,1);assert.equal(stored.条目[0].数据归属.范围.audience,'lead');assert.match(stored.条目[0].来源.怎么知道,/外部来源资料，参与者身份未核对/);
}));
it('显式收录、按消息ID读取与上下文均保留外部来源，成员不能读外部缓冲',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('这是一段外部见闻'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);
 const info=await org.information.query(spec,{collection:'status'});assert.equal(info.conversationMessages[0].origin.channel,'chat');const material=await org.information.submit(spec,{messageIds:['external-input']});const detail=await org.information.read(spec,{id:material.id});assert.equal(detail.context.messages[0].role,'external-user');
 const frame=await org.turnBuffer.read({...spec,id:'external-input'});assert.equal(frame.轮次[0].消息[0].来源.identity,'unverified');
 await assert.rejects(org.turnBuffer.read({...spec,subject:MEMBER}));
 s.surface.nodes; const hidden={...s,get surface(){return{nodes:[]};}};const assembly=await injectTurnBuffer({sections:[]},{agent:{session:hidden},org,hooks,projectOf:()=>P});assert.match(assembly.sections.find(v=>v.name===TURN_BUFFER_SECTION).text,/external-user/);
}));
it('外部只作为专业检索线索，本地连续性默认不把其当主人本轮表达',async()=>{
 const s=session();s.append('turn/start',{turn:1});s.append('user/message',user('本地旧要求','local',{kind:'user'}),'append');s.append('user/message',user('外部当前问题'),'append');assert.equal(readAcceptedExpression(s),null);const q=readAcceptedExpression(s,{allowExternal:true});assert.equal(q.query,'外部当前问题');assert.match(q.description.类型,/身份未核对/);
});
it('发送回执必须来自同一项目，目录切换使旧调用失去配对',async()=>{
 const context={},nodes=[];projectTurnSurfaceEvent({seq:0,type:'tool/call',data:toolCall('x','不该串项目')},nodes,context);projectTurnSurfaceEvent({seq:1,type:'working-directory/change',data:{cwd:'/elsewhere'}},nodes,context);assert.equal(projectTurnSurfaceEvent({seq:2,type:'tool/result',data:toolResult('x'),surfaceOp:'append'},nodes,context).type,'skip');
});
it('继承前缀外部不作为当前会话来源补回',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('fork继承的外部','inherited'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});s.inheritedEventCount=s.seq;s.append('turn/start',{turn:2});s.append('user/message',user('本会话外部','own'),'append');s.append('turn/end',{turn:2,reason:{kind:'completed'}});await legacy(org,s);await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.id),['own']);
}));
it('补读不迁入其他项目或已过期、时间未知的外部，旧本地未知时间不被刷新成现在',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});const old=s.append('user/message',user('过期外部','expired'),'append');old.time=Date.now()-40*86400000;const unknown=s.append('user/message',user('时间未知外部','unknown'),'append');delete unknown.time;
 s.append('user/message',user('原本地旧消息','local',{kind:'user'}),'append');s.append('user/message',user('新外部','new'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await legacy(org,s);const before=await org.turnBuffer.load(P,LEAD.id);delete before.rounds.flatMap(r=>r.messages)[0].at;await savePrivateBufferState(org.turnBuffer.file(P,LEAD.id),before);
 await hooks.sync(s);const rows=await all(org);assert.deepEqual(rows.map(m=>m.id),['local','new']);assert.equal(Object.hasOwn(rows[0],'at'),false);assert.equal((await org.turnBuffer.load(P,LEAD.id)).sourceRecovery.omitted,2);
}));
it('历史跨目录归属按原事件核对，当前工作区不追授旧外部',async()=>scene(async({org,s,query})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('项目一外部','p1'),'append');s.append('working-directory/change',{cwd:'/different-project'});s.append('user/message',user('其他项目外部','p2'),'append');s.append('working-directory/change',{cwd:process.cwd()});s.append('turn/end',{turn:1,reason:{kind:'completed'}});await legacy(org,s);
 const hooks=createTurnBufferHooks({org,projectOf:()=>P,projectAtCwd:cwd=>cwd===process.cwd()?P:'other',queryOf:()=>query,logger:{warn(){}}});await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.id),['p1']);
}));

it('任意新来源无需核心注册；未知、材料和通知不能冒充共同经历',async()=>scene(async({org,s,hooks})=>{
 for(const [index,contentType] of ['unknown','material','notification'].entries()) {
  const id='kind-'+index;s.append('turn/start',{turn:index+1});
  s.append('user/message',user('一段值得了解的外部材料',id,{kind:'plugin:never-registered-'+index,mindExternal:{version:1,contentType,channel:'arbitrary'}}),'append');
  s.append('turn/end',{turn:index+1,reason:{kind:'completed'}});await hooks.sync(s);
  const item=await org.information.submit(spec,{messageIds:[id]});const reading=await org.information.read(spec,{id:item.id});
  await assert.rejects(org.information.record(spec,{type:'growth',kind:'共同回忆',title:'不能假定一起经历',text:'不能冒充我们的共同经历',sources:[{readingId:reading.readingId,quote:'值得了解'}]}),/共同回忆需要明确/);
 }
 assert.equal((await all(org)).length,3);
}));
it('来源声明不认证身份或覆盖producer；原始参与者和会话ID不落入缓冲',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('我的输入','identities',{kind:'plugin:new-origin',mindExternal:{version:1,contentType:'conversation',producer:'user',identity:'verified',channel:'community',conversationId:'room-sensitive',participantId:'person-sensitive'}}),'append');
 s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);
 const origin=(await all(org))[0].origin;assert.equal(origin.producer,'plugin:new-origin');assert.equal(origin.identity,'unverified');assert.equal(origin.participant.length,64);
 const disk=await readFile(org.turnBuffer.file(P,LEAD.id),'utf8');assert.doesNotMatch(disk,/room-sensitive|person-sensitive|"identity":"verified"/);
}));
it('不同参与者各自推进阅读位置，不被另一人的较大序号跳过',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});for(const [id,participantId] of [['a1','A'],['b1','B'],['a2','A']])s.append('user/message',user('材料-'+id,id,{kind:'plugin:community-new',mindExternal:{version:1,contentType:'conversation',channel:'room',conversationId:'shared-room',participantId}}),'append');
 s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);
 const a=await org.information.prepareLearning(spec);assert.deepEqual(a.chosen.conversation.refs.map(m=>m.id),['a1','a2']);await org.information.commitLearning(spec,a,{records:[]});
 const b=await org.information.prepareLearning(spec);assert.deepEqual(b.chosen.conversation.refs.map(m=>m.id),['b1']);assert.notEqual(a.chosen.conversation.checkpoint,b.chosen.conversation.checkpoint);await org.information.commitLearning(spec,b,{records:[]});assert.equal(await org.information.prepareLearning(spec),null);
}));
it('已完成2版投影仍补新来源，保留旧外部出处与正文而不重复',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('原有外部记录','kept'),'append');s.append('user/message',user('过去未支持的新来源','new-source',{kind:'plugin:source-unlisted'}),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);
 const old=await org.turnBuffer.load(P,LEAD.id);old.version=2;old.sourceProjection=2;delete old.sourceRecovery;
 old.rounds[0].messages=old.rounds[0].messages.filter(m=>m.id==='kept');old.rounds[0].messages[0].origin={channel:'archived',producer:'archived-producer',direction:'inbound',identity:'unverified',representation:'accepted-text'};await savePrivateBufferState(org.turnBuffer.file(P,LEAD.id),old);
 await hooks.sync(s);const rows=await all(org);assert.deepEqual(rows.map(m=>m.id),['kept','new-source']);assert.equal(rows[0].origin.producer,'archived-producer');assert.equal(rows[1].origin.contentType,'unknown');assert.equal((await org.turnBuffer.load(P,LEAD.id)).sourceProjection,3);
 const {digest}=await import('../src/kernel/text.js');await org.information.locked(state=>{state.conversations[digest(P+'\0'+LEAD.id+'\0qq-source-v1')]=9999;});
 const next=await org.information.prepareLearning(spec);assert.deepEqual(next.chosen.conversation.refs.map(m=>m.id),['new-source']);await org.information.commitLearning(spec,next,{records:[]});
 await hooks.sync(s);assert.equal((await all(org)).length,2);
}));
it('外部文本可作只读检索线索而不认证人类表达，通知不用于检索',()=>{
 for(const contentType of ['unknown','notification','material']){
  const s=session();s.append('turn/start',{turn:1});s.append('user/message',user('外部文本线索','notice',{kind:'plugin:another-new-source',mindExternal:{version:1,contentType}}),'append');
  const expression=readAcceptedExpression(s,{allowExternal:true});
  if(contentType==='notification')assert.equal(expression,null);else {assert.equal(expression.query,'外部文本线索');assert.equal(expression.description.来源.contentType,contentType);assert.doesNotMatch(expression.description.类型,/对话|用户/);}
  assert.equal(readAcceptedExpression(s),null);
 }
});
it('两个任意名称工具共用提交协议；重复调用与过大声明不留正文或参数',()=>{
 const events=[],nodes=[],context={};let seq=0;const add=(type,data,surfaceOp)=>{const r=projectTurnSurfaceEvent({seq:seq++,type,data,surfaceOp},nodes,context);if(r.type==='message')events.push(r);};
 for(const name of ['a_reader_reply','brand_new_transport']){add('tool/call',{...toolCall(name,'秘密调用参数'),name});add('tool/result',toolResult(name,receipt('报告的正文-'+name)),'append');}
 add('tool/call',toolCall('duplicate'));add('tool/call',toolCall('duplicate'));add('tool/result',toolResult('duplicate'),'append');
 add('tool/call',toolCall('large'));add('tool/result',toolResult('large',receipt('x'.repeat(16385))),'append');
 assert.equal(events.length,2);assert.deepEqual(events.map(m=>m.origin.producer),['tool:a_reader_reply','tool:brand_new_transport']);assert.doesNotMatch(JSON.stringify(context),/秘密调用参数/);
});
