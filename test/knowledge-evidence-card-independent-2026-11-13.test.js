import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {makeFixture,LEAD,MEMBER} from './helpers.mjs';
import {Org} from '../src/org.js';
import {digest} from '../src/kernel/text.js';
const P='knowledge-evidence-card-independent';
const B={id:'member-b',kind:'成员',roleId:'插件工程'};
async function scene(run){const f=await makeFixture();try{const org=await Org.open({...f,project:P});await run(org,f);}finally{await f.cleanup();}}
async function identity(org,change){const file=org.layout.identityFile();const data=JSON.parse(await readFile(file,'utf8'));change(data);await writeFile(file,JSON.stringify(data));await org.policy.reload();}
const knowledge=(org,text,extra={})=>org.memory.remember({subject:LEAD,项目:P,类:'知识',内容:text,来源:'synthetic evidence',...extra});
async function task(org,member,objects=[]){const node=await org.tasks.create({subject:LEAD,项目:P,描述:'实际任务来源',负责人:member.id,判据:['真实来源'],复核对象:objects});await org.tasks.bind(node.id,{subject:LEAD,项目:P,实例:member.id,岗位:member.roleId});await org.tasks.dispatch(node.id,{subject:LEAD,项目:P});await org.tasks.start(node.id,{subject:member,项目:P});return node;}
const evidence=(org,subject,ids)=>org.memory.readKnowledgeEvidence({subject,项目:P,ids});
test('缺专业卡仍能捕获完整知识来源哈希并随正常交卷保存，过程不读取专业卡',()=>scene(async org=>{
  const source=await knowledge(org,'完整知识原文'.repeat(3000));
  const n=await task(org,MEMBER);
  await identity(org,data=>{delete data.members[LEAD.id].卡版本;delete data.members[MEMBER.id].卡版本;});
  org.registry.cardOf=async()=>{throw Error('ordinary evidence must not depend on a professional card');};
  for(const actor of [LEAD,MEMBER]){const sourceVersion=(await evidence(org,actor,[source.id])).get(source.id);assert.equal(sourceVersion.状态,'可核来源版本');assert.equal(sourceVersion.内容哈希,digest('完整知识原文'.repeat(3000)));}
  await org.tasks.submit(n.id,{subject:MEMBER,项目:P,结论:'完成正常交卷',采用知识:[{id:source.id,用途:'核对来源',适用判断:'合成任务',使用结果:'未知'}]});
  const submitted=(await org.tasks.events({项目:P})).findLast(row=>row.kind==='submitted');
  assert.equal(submitted.采用知识.条目[0].来源.状态,'可核来源版本');
  assert.equal(submitted.采用知识.条目[0].来源.内容哈希,digest('完整知识原文'.repeat(3000)));
}));
test('缺卡不会放宽真实身份、专业自报、封存状态与委派父链',()=>scene(async org=>{
  const source=await knowledge(org,'protected source');
  await identity(org,data=>{delete data.members[MEMBER.id].卡版本;});
  for(const actor of [{id:'ghost',kind:'成员'}, {...MEMBER,kind:'Lead'}, {...MEMBER,roleId:'不存在的专业'}]) assert.equal((await evidence(org,actor,[source.id])).get(source.id).状态,'来源未核验');
  await identity(org,data=>{data.members[MEMBER.id].status='封存';});
  assert.equal((await evidence(org,MEMBER,[source.id])).get(source.id).状态,'来源未核验');
  await identity(org,data=>{data.members[MEMBER.id].status='在岗';delete data.members[MEMBER.id].委派者;});
  assert.equal((await evidence(org,MEMBER,[source.id])).get(source.id).状态,'来源未核验');
}));
test('无卡技术专业的真实复核用途仍裁剪来源；读取期间实例代变化丢弃旧证据',()=>scene(async org=>{
  const business=await task(org,MEMBER);
  const other=await task(org,MEMBER);
  const related=await knowledge(org,'related version',{来源引用:[business.id]});
  const unrelated=await knowledge(org,'unrelated version',{来源引用:[other.id]});
  await task(org,B,[business.id]);
  await identity(org,data=>{delete data.members[B.id].卡版本;});
  const found=await evidence(org,B,[related.id,unrelated.id]);
  assert.equal(found.get(related.id).状态,'可核来源版本');assert.equal(found.get(unrelated.id).状态,'来源未核验');
  const readable=org.memory.ownedReadable.bind(org.memory);let changed=false;
  org.memory.ownedReadable=async(entry,...rest)=>{if(!changed&&entry.id===related.id){changed=true;await identity(org,data=>{data.members[B.id].代=(data.members[B.id].代??1)+1;});}return readable(entry,...rest);};
  assert.equal((await evidence(org,B,[related.id])).get(related.id).状态,'来源未核验');assert.equal(changed,true);
}));
test('无卡真实Lead可核对负反馈并关联实际处置，假身份与停岗不能取得治理权限',()=>scene(async org=>{
  const source=await knowledge(org,'knowledge with an actual negative declaration');
  const n=await task(org,MEMBER);
  await org.tasks.submit(n.id,{subject:MEMBER,项目:P,结论:'有负反馈但不冒称知识已证伪',采用知识:[{id:source.id,用途:'本次实验',适用判断:'出现反例需核对',使用结果:'发现问题'}]});
  const submitted=(await org.tasks.events({项目:P})).findLast(row=>row.kind==='submitted');
  const reference={任务:n.id,提交序:submitted.seq};
  await identity(org,data=>{delete data.members[LEAD.id].卡版本;});
  org.registry.cardOf=async()=>{throw Error('feedback governance must not read a professional card');};
  const request={subject:LEAD,项目:P,op:'demote',反馈引用:reference,原因:'核对实际负反馈'};
  const plan=await org.memory.prepareFeedbackReference(source.id,request);
  await org.memory.demote(source.id,request);
  const observe=subject=>org.memory.readFeedbackDispositions({subject,项目:P,items:[{知识id:source.id,反馈指纹:plan.指纹}]});
  const result=(await observe(LEAD)).values().next().value;
  assert.equal(result.状态,'可核对');assert.equal(result.总数,1);assert.equal(result.记录[0].动作,'降权');
  for(const subject of [MEMBER,{...MEMBER,kind:'Lead'},{id:'ghost',kind:'Lead'},{...LEAD,roleId:'错误专业'}]){
    await assert.rejects(org.memory.prepareFeedbackReference(source.id,{...request,subject}),error=>error.code==='DENIED');
    assert.equal((await observe(subject)).values().next().value.状态,'不可核对');
  }
  await identity(org,data=>{data.members[LEAD.id].status='封存';});
  await assert.rejects(org.memory.prepareFeedbackReference(source.id,request),error=>error.code==='DENIED');
  assert.equal((await observe(LEAD)).values().next().value.状态,'不可核对');
}));
