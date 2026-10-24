import {it} from 'node:test'; import assert from 'node:assert/strict';
import {readFile,writeFile,stat} from 'node:fs/promises'; import {join} from 'node:path';
import {makeFixture,LEAD,MEMBER} from './helpers.mjs';import {Org} from '../src/org.js';
import {projectTurnEvent,projectTurnSurfaceEvent,savePrivateBufferState} from '../src/turn-buffer.js';
import {createTurnBufferHooks,injectTurnBuffer,TURN_BUFFER_SECTION} from '../components/kernel/lib/turn-buffer-hooks.js';
import {readAcceptedExpression} from '../components/kernel/lib/accepted-expression.js';
import {externalConversationMessage} from '../src/conversation-origin.js';
const P='qq-memory';const spec={subject:LEAD,project:P,session:LEAD.id};
const user=(text,id='qq-input',source={kind:'plugin:dsh-qq-bridge'})=>({id,role:'user',source,content:[{type:'text',text}]});
const toolCall=(id='call',text='发送草稿',extra={})=>({turn:1,step:0,callId:id,name:'qq_bridge_send',arguments:JSON.stringify({text,...extra})});
const toolResult=(id='call',result={sent:1,dropped:false,destination:{kind:'group',groupId:'123456'}},extra={})=>({turn:1,step:0,message:{id:'result-'+id,role:'tool',toolCallId:id,source:{kind:'tool',callId:id},content:[{type:'text',text:JSON.stringify(result)}],...extra}});
function session(){const events=[];let nodes=[];return{id:LEAD.id,header:{id:LEAD.id,cwd:process.cwd()},inheritedEventCount:0,get seq(){return events.length;},events,get surface(){return{nodes:[...nodes]};},isOwnSeq(seq){return seq>=this.inheritedEventCount&&seq<events.length;},eventAt(seq){return events[seq];},append(type,data,surfaceOp){const e={seq:events.length,time:Date.now(),type,data,...(surfaceOp?{surfaceOp}:{})};if(surfaceOp==='append')nodes.push(e.seq);else if(surfaceOp?.op==='replace'){const a=nodes.indexOf(surfaceOp.startSeq),b=nodes.indexOf(surfaceOp.endSeq);if(a<0||b<a)throw Error('invalid fixture');nodes.splice(a,b-a+1,e.seq);}events.push(e);return e;}};}
async function scene(run){const f=await makeFixture();const org=await Org.open({...f,project:P});const s=session();let disposed=0;
 const query={async observeSession(){const copy=structuredClone(s.events);return{source:'live',header:{...s.header},inheritedEventCount:s.inheritedEventCount,cursor:copy.length-1,events:copy,[Symbol.dispose](){disposed++;}};}};
 const hooks=createTurnBufferHooks({org,projectOf:()=>P,queryOf:()=>query,logger:{warn(){}}});
 try{await run({org,f,s,hooks,query,disposed:()=>disposed});}finally{await hooks.flush();await org.observability.flush();await f.cleanup();}}
const all=async org=>(await org.turnBuffer.load(P,LEAD.id))?.rounds.flatMap(r=>r.messages)??[];
async function legacy(org,s,{floor=0}={}){const nodes=[],context={};const records=s.events.map(e=>{const row=projectTurnSurfaceEvent(e,nodes,context);if(externalConversationMessage(row))return{seq:e.seq,type:'skip'};if(row.type==='replace'&&externalConversationMessage(row.message))delete row.message;return row;});await org.turnBuffer.capture({...spec,fromSeq:0,throughSeq:s.seq,records});const state=await org.turnBuffer.load(P,LEAD.id);state.version=1;delete state.sourceProjection;state.floor=floor;for(const r of state.rounds)r.messages=r.messages.filter(m=>m.seq>=floor);await savePrivateBufferState(org.turnBuffer.file(P,LEAD.id),state);}
it('仅已知QQ来源保存为外部参与者，昵称或文本前缀不能冒充来源',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('QQ参与者表达'),'append');s.append('user/message',user('旧版QQ来源','legacy',{kind:'plugin',plugin:'qq-bridge'}),'append');s.append('user/message',user('[QQ] 假冒来源','other',{kind:'plugin:unknown'}),'append');s.append('user/message',user('[QQ] 本地引用','local',{kind:'user'}),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);
 const rows=await all(org);assert.deepEqual(rows.map(m=>m.role),['external-user','external-user','user']);assert.equal(rows[0].origin.identity,'unverified');assert.ok(!rows.some(m=>m.id==='other'));assert.equal((await org.turnBuffer.load(P,LEAD.id)).version,2);
 assert.equal(JSON.parse(await readFile(join(org.layout.memoryRoot(),'external-conversation-layout.json'),'utf8')).version,2);
 if(process.platform!=='win32')assert.equal((await stat(org.turnBuffer.file(P,LEAD.id))).mode&0o777,0o600);
}));
it('成功发送按callId配对，仅保留发送请求文本，不缓存任意工具参数或结果',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('tool/call',toolCall('good','**发出的请求**'));s.append('tool/result',toolResult('good'),'append');
 s.append('tool/call',{...toolCall('secret','秘密参数'),name:'shell'});s.append('tool/result',toolResult('secret'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);
 const rows=await all(org);assert.equal(rows.length,1);assert.equal(rows[0].text,'**发出的请求**');assert.equal(rows[0].role,'external-assistant');assert.equal(rows[0].origin.representation,'request-text');assert.equal(rows[0].origin.destination.key.length,64);
 const file=await readFile(org.turnBuffer.file(P,LEAD.id),'utf8');assert.doesNotMatch(file,/秘密参数|123456|arguments|shell/);
}));
it('失败、拒发、无配对、目的地冲突和错误工具来源均不记录为发出',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});
 for(const [id,result,args,extra] of [['failed',{sent:0,dropped:true},{}],['mismatch',{sent:1,dropped:false,destination:{kind:'group',groupId:'123456'}},{groupId:'222222'}],['error',{sent:1,dropped:false,destination:{kind:'group',groupId:'123456'}},{},{isError:true}],['fake-source',{sent:1,dropped:false,destination:{kind:'group',groupId:'123456'}},{},{source:{kind:'user'}}]]){s.append('tool/call',toolCall(id,'不能保存',args));s.append('tool/result',toolResult(id,result,extra),'append');}
 s.append('tool/result',toolResult('orphan'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);assert.deepEqual(await all(org),[]);
}));
it('cursor已追平的旧缓冲仍补回遗漏QQ和发送请求，保留原助手文本且不重复',async()=>scene(async({org,s,hooks,disposed})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('原来遗漏的QQ输入'),'append');s.append('tool/call',toolCall('old-send','原来遗漏的回复'));s.append('tool/result',toolResult('old-send'),'append');s.append('assistant/message',{turn:1,message:{id:'assistant',role:'assistant',content:[{type:'text',text:'原助手结尾'}]}},'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await legacy(org,s);assert.equal((await all(org)).length,1);
 await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.text),['原来遗漏的QQ输入','原来遗漏的回复','原助手结尾']);assert.equal((await org.turnBuffer.position(spec)).nextSeq,s.seq);assert.equal((await org.turnBuffer.position(spec)).sourceProjection,2);
 await hooks.sync(s);assert.equal((await all(org)).length,3);assert.ok(disposed()>0);
}));
it('旧压缩按真实表面锚点补回QQ，后续非压缩替换会撤回所有关联正文',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('压缩前QQ'),'append');s.append('assistant/message',{turn:1,message:{id:'a',role:'assistant',content:[{type:'text',text:'原回复'}]}},'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});s.append('user/message',user('压缩摘要','compact',{kind:'compact-checkpoint'}),{op:'replace',startSeq:1,endSeq:2});await legacy(org,s);await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.text),['压缩前QQ','原回复']);assert.ok((await all(org)).every(m=>m.anchor===4));
 s.append('user/message',user('新的本地要求','replacement',{kind:'user'}),{op:'replace',startSeq:4,endSeq:4});await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.text),['新的本地要求']);
}));
it('已被非压缩替换撤回的QQ不因升级补读复活',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('应消失QQ'),'append');s.append('user/message',user('替代原文','new',{kind:'user'}),{op:'replace',startSeq:1,endSeq:1});s.append('turn/end',{turn:1,reason:{kind:'completed'}});await legacy(org,s);await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.text),['替代原文']);
}));
it('清空屏障及fork继承前缀不复制QQ，屏障前发送调用也不能借结果复活草稿',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('清空前QQ'),'append');s.append('tool/call',toolCall('before','清空前发送草稿'));await legacy(org,s);await org.turnBuffer.forget({...spec,throughSeq:s.seq});s.append('tool/result',toolResult('before'),'append');s.append('user/message',user('清空后QQ','new'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.text),['清空后QQ']);
}));
it('升级补读中清空或换项目时拒绝旧候选，不覆盖清空边界',async()=>scene(async({org,s,hooks,query})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('不能复活'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await legacy(org,s);const observe=query.observeSession.bind(query);query.observeSession=async(...args)=>{const lease=await observe(...args);await org.turnBuffer.forget({...spec,throughSeq:s.seq});return lease;};
 await assert.rejects(hooks.sync(s),/清空边界变化/);assert.deepEqual(await all(org),[]);
}));
it('QQ不进入本地主人偏好或项目需求整理；仍可沿原信息阅读记入有来源的认识',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('群友分享：遇到重试风暴要使用指数退避，不是本地主人的要求'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);
 await org.projectBrief.touch(spec);await org.continuityCapture.touch(spec);let calls=0;assert.equal((await org.projectBrief.update(spec,{extract:async()=>{calls++;return{items:[]};}})).updated,false);assert.equal((await org.continuityCapture.update(spec,{extract:async()=>{calls++;return{items:[]};}})).updated,false);assert.equal(calls,0);
 const checkpoint=(await import('../src/kernel/text.js')).digest(P+'\0'+LEAD.id);await org.information.locked(state=>{state.conversations[checkpoint]=10000;});
 const prepared=await org.information.prepareLearning(spec);assert.ok(prepared);assert.equal(prepared.chosen.conversation.refs[0].role,'external-user');assert.equal(prepared.input.source.context.messages[0].origin.identity,'unverified');assert.match(prepared.input.source.text,/QQ插件来源/);
 await org.information.commitLearning(spec,prepared,{records:[{type:'growth',kind:'知识',title:'退避方法',text:'重试风暴需要指数退避，但适用性尚待验证',quote:'遇到重试风暴要使用指数退避'}]});
 const stored=await org.memory.query({subject:LEAD,读者:LEAD,项目:P,类:'知识',文本:'指数退避'});assert.equal(stored.条目.length,1);assert.equal(stored.条目[0].数据归属.范围.audience,'lead');assert.match(stored.条目[0].来源.怎么知道,/QQ插件会话资料，参与者身份未核对/);
}));
it('显式收录、按消息ID读取与上下文均保留外部来源，成员不能读QQ缓冲',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('这是一段QQ见闻'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await hooks.sync(s);
 const info=await org.information.query(spec,{collection:'status'});assert.equal(info.conversationMessages[0].origin.channel,'qq');const material=await org.information.submit(spec,{messageIds:['qq-input']});const detail=await org.information.read(spec,{id:material.id});assert.equal(detail.context.messages[0].role,'external-user');
 const frame=await org.turnBuffer.read({...spec,id:'qq-input'});assert.equal(frame.轮次[0].消息[0].来源.identity,'unverified');
 await assert.rejects(org.turnBuffer.read({...spec,subject:MEMBER}));
 s.surface.nodes; const hidden={...s,get surface(){return{nodes:[]};}};const assembly=await injectTurnBuffer({sections:[]},{agent:{session:hidden},org,hooks,projectOf:()=>P});assert.match(assembly.sections.find(v=>v.name===TURN_BUFFER_SECTION).text,/external-user/);
}));
it('QQ只作为专业检索线索，本地连续性默认不把其当主人本轮表达',async()=>{
 const s=session();s.append('turn/start',{turn:1});s.append('user/message',user('本地旧要求','local',{kind:'user'}),'append');s.append('user/message',user('QQ当前问题'),'append');assert.equal(readAcceptedExpression(s),null);const q=readAcceptedExpression(s,{allowExternal:true});assert.equal(q.query,'QQ当前问题');assert.match(q.description.类型,/身份未核对/);
});
it('发送回执必须来自同一项目，目录切换使旧调用失去配对',async()=>{
 const context={},nodes=[];projectTurnSurfaceEvent({seq:0,type:'tool/call',data:toolCall('x','不该串项目')},nodes,context);projectTurnSurfaceEvent({seq:1,type:'working-directory/change',data:{cwd:'/elsewhere'}},nodes,context);assert.equal(projectTurnSurfaceEvent({seq:2,type:'tool/result',data:toolResult('x'),surfaceOp:'append'},nodes,context).type,'skip');
});
it('继承前缀QQ不作为当前会话来源补回',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('fork继承的QQ','inherited'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});s.inheritedEventCount=s.seq;s.append('turn/start',{turn:2});s.append('user/message',user('本会话QQ','own'),'append');s.append('turn/end',{turn:2,reason:{kind:'completed'}});await legacy(org,s);await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.id),['own']);
}));
it('补读不迁入其他项目或已过期、时间未知的QQ，旧本地未知时间不被刷新成现在',async()=>scene(async({org,s,hooks})=>{
 s.append('turn/start',{turn:1});const old=s.append('user/message',user('过期QQ','expired'),'append');old.time=Date.now()-40*86400000;const unknown=s.append('user/message',user('时间未知QQ','unknown'),'append');delete unknown.time;
 s.append('user/message',user('原本地旧消息','local',{kind:'user'}),'append');s.append('user/message',user('新QQ','new'),'append');s.append('turn/end',{turn:1,reason:{kind:'completed'}});await legacy(org,s);const before=await org.turnBuffer.load(P,LEAD.id);delete before.rounds.flatMap(r=>r.messages)[0].at;await savePrivateBufferState(org.turnBuffer.file(P,LEAD.id),before);
 await hooks.sync(s);const rows=await all(org);assert.deepEqual(rows.map(m=>m.id),['local','new']);assert.equal(Object.hasOwn(rows[0],'at'),false);assert.equal((await org.turnBuffer.load(P,LEAD.id)).sourceRecovery.omitted,2);
}));
it('历史跨目录归属按原事件核对，当前工作区不追授旧QQ',async()=>scene(async({org,s,query})=>{
 s.append('turn/start',{turn:1});s.append('user/message',user('项目一QQ','p1'),'append');s.append('working-directory/change',{cwd:'/different-project'});s.append('user/message',user('其他项目QQ','p2'),'append');s.append('working-directory/change',{cwd:process.cwd()});s.append('turn/end',{turn:1,reason:{kind:'completed'}});await legacy(org,s);
 const hooks=createTurnBufferHooks({org,projectOf:()=>P,projectAtCwd:cwd=>cwd===process.cwd()?P:'other',queryOf:()=>query,logger:{warn(){}}});await hooks.sync(s);assert.deepEqual((await all(org)).map(m=>m.id),['p1']);
}));
