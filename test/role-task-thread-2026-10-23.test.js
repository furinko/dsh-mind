import {test} from 'node:test';
import assert from 'node:assert/strict';
import {writeFile} from 'node:fs/promises';
import {makeFixture,LEAD,MEMBER} from './helpers.mjs';
import {Org} from '../src/org.js';
import {runAction} from '../lib/actions.js';
const P='role-owned-task-thread';
const threadDenied=error=>error?.code==='DENIED'&&error.rule?.includes('任务线程只有负责人与 Lead');
async function scene(fn,{bind=true}={}){
 const f=await makeFixture();try{
  const org=await Org.open({home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project:P});
  const task=await org.tasks.create({subject:LEAD,项目:P,描述:'岗位负责的正式交付',负责人:['插件工程'],判据:['可核验']});
  if(bind)await org.tasks.bind(task.id,{subject:LEAD,项目:P,实例:MEMBER.id,岗位:'插件工程'});
  await org.tasks.dispatch(task.id,{subject:LEAD,项目:P});
  const act=(subject,args)=>runAction({org,项目:P,主体:subject,args});
  const send=subject=>act(subject,{action:'bus_send',线程:task.id,类型:'交卷',内容:'本人正式任务交付消息'});
  await fn({f,org,task,act,send});
 }finally{await f.cleanup();}
}
test('岗位负责人精确绑定的真实成员可在交卷后写本人任务线程',()=>scene(async s=>{
 await s.org.tasks.start(s.task.id,{subject:MEMBER,项目:P});await s.org.tasks.submit(s.task.id,{subject:MEMBER,项目:P,结论:'已交付'});
 await s.send(MEMBER);const read=await s.act(LEAD,{action:'bus_read',线程:s.task.id});assert.equal(read.消息.length,1);assert.equal(read.消息[0].发件,MEMBER.id);
}));
test('同岗位其它实例和自报岗位不能向本人未绑定的任务线程发言',()=>scene(async s=>{
 await assert.rejects(s.send({id:'member-b',kind:'成员',roleId:'插件工程'}),threadDenied);
 await assert.rejects(s.send({id:'reviewer',kind:'成员',roleId:'插件工程'}),/岗位身份必须来自身份档案/);
 assert.equal((await s.act(LEAD,{action:'bus_read',线程:s.task.id})).消息.length,0);
}));
test('岗位名本身不授权总线发言，缺精确绑定仍拒',()=>scene(async s=>{
 await assert.rejects(s.send(MEMBER),threadDenied);
 await s.send(LEAD);assert.equal((await s.act(LEAD,{action:'bus_read',线程:s.task.id})).消息.length,1);
},{bind:false}));
test('同id换代后旧任务绑定不授予岗位线程发言',()=>scene(async s=>{
 const identity=await s.org.registry.identity();identity.members[MEMBER.id].代++;
 await writeFile(s.f.layout.identityFile(),JSON.stringify(identity));
 await assert.rejects(s.send(MEMBER),threadDenied);
 assert.equal((await s.act(LEAD,{action:'bus_read',线程:s.task.id})).消息.length,0);
}));
