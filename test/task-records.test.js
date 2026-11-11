import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {reviewScene,REVIEW_PROJECT} from './review-experiment-fixture.mjs';
import {runAction,ACTIONS,READ_ONLY_ACTIONS} from '../lib/actions.js';
import {LEAD} from './helpers.mjs';

const call=(s,subject,args)=>runAction({org:s.org,项目:REVIEW_PROJECT,主体:subject,args:{action:'task_criteria',原记录:true,...args}});
async function report(s){
  const text='原始独立复核报告🙂'.repeat(9000);
  await s.org.tasks.submit(s.task.id,{subject:s.reviewer,项目:REVIEW_PROJECT,结论:text,结论层:'不过',反例面:['撤权后有创建']});
  const node=await s.org.tasks.review(s.task.id,{subject:LEAD,项目:REVIEW_PROJECT,三态:'不过',分歧清单:['保留原失败'],反例面:['synthetic']});
  const events=await s.org.tasks.events({项目:REVIEW_PROJECT});
  const row=events.find(r=>r.id===s.task.id&&r.kind==='submitted');
  return {text,row,ticket:node.最后复核?.票??node.复核经过.at(-1).票};
}
test('Lead retrieves original report bytes across all pages and original failed vote without writes',()=>reviewScene(async s=>{
  const {text,row,ticket}=await report(s),file=s.org.layout.taskLog(REVIEW_PROJECT),before=fs.readFileSync(file);
  assert.ok(ACTIONS.includes('task_criteria'));assert.ok(READ_ONLY_ACTIONS.includes('task_criteria'));
  const list=await call(s,LEAD,{id:s.task.id,limit:1});assert.equal(list.总数,2);assert.equal(list.记录.length,1);assert.equal(list.下一偏移,1);
  assert.equal((await call(s,LEAD,{id:s.task.id,偏移:1,limit:1,数据版本:list.数据版本})).记录.length,1);
  const pieces=[];let offset=0,first;
  do {const page=await call(s,LEAD,{提交序:row.seq,记录偏移:offset,记录长度:4096,...(first?{数据版本:first.数据版本}:{})});first??=page;pieces.push(Buffer.from(page.字节Base64,'base64'));offset=page.下一偏移;if(page.完整)break;}while(offset<1000000);
  const bytes=Buffer.concat(pieces);assert.equal(createHash('sha256').update(bytes).digest('hex'),first.SHA256);assert.equal(JSON.parse(bytes).结论,text);assert.equal(first.源截断,false);
  const vote=await call(s,LEAD,{票:ticket});assert.equal(JSON.parse(Buffer.from(vote.字节Base64,'base64')).三态,'不过');assert.equal(vote.来源.任务,s.task.id);
  assert.deepEqual(fs.readFileSync(file),before);
}));
test('reviewer scope survives submission for own report and explicit target only; no bus writes or rebinding',()=>reviewScene(async s=>{
  const {ticket}=await report(s);assert.equal((await call(s,s.reviewer,{id:s.task.id})).总数,2);
  assert.equal((await call(s,s.reviewer,{id:s.target.id})).总数,0);
  const other=await s.org.tasks.create({subject:LEAD,项目:REVIEW_PROJECT,描述:'unrelated private task',负责人:['插件工程'],判据:['private']});
  await assert.rejects(call(s,s.reviewer,{id:other.id}),/读域|复核/);
  await assert.rejects(call(s,s.reviewer,{票:ticket,project:'unrelated-project'}),/跨项目/);
  await assert.rejects(call(s,s.reviewer,{id:s.task.id,文件路径:s.org.layout.taskLog(REVIEW_PROJECT)}),/未知/);
  await s.org.registry.seal({subject:LEAD,实例:s.reviewer.id,理由:'retired'});
  await assert.rejects(call(s,s.reviewer,{id:s.task.id}),e=>e.code==='DENIED'&&e.rule.includes('身份停用'));
}));
test('source/version and selector mismatches fail closed without returning another task',()=>reviewScene(async s=>{
  const {row,ticket}=await report(s);await assert.rejects(call(s,LEAD,{id:s.target.id,提交序:row.seq}),/不属于|不存在/);
  await assert.rejects(call(s,LEAD,{id:s.task.id,票:ticket,提交序:row.seq}),/不能同时|唯一/);
  await assert.rejects(call(s,LEAD,{id:s.task.id,数据版本:'0'.repeat(64)}),/版本/);
  for(const args of [{记录偏移:-1},{记录长度:32769},{偏移:1.5},{limit:101}])await assert.rejects(call(s,LEAD,{id:s.task.id,...args}),/分页|越界/);
  fs.appendFileSync(s.org.layout.taskLog(REVIEW_PROJECT),'{broken');await assert.rejects(call(s,LEAD,{id:s.task.id}),/账本损坏/);
}));
test('new report read rejects stale binding credentials and ordinary same-role or spoofed actors',()=>reviewScene(async s=>{
  await report(s);const original=s.org.tasks.list.bind(s.org.tasks);
  s.org.tasks.list=async q=>(await original(q)).map(n=>n.id===s.task.id?{...n,绑定:n.绑定.map(b=>({...b,凭证:{...b.凭证,代:999}}))}:n);
  await assert.rejects(call(s,s.reviewer,{id:s.task.id}),e=>e.code==='DENIED');s.org.tasks.list=original;
  await s.org.registry.assign({subject:LEAD,岗位:'插件工程',实例:'ordinary-record-reader'});
  await assert.rejects(call(s,{id:'ordinary-record-reader',kind:'成员',roleId:'插件工程'},{id:s.task.id}),e=>e.code==='DENIED');
  await assert.rejects(call(s,s.reviewer,{id:s.task.id,role:'Lead'}),e=>e.code==='DENIED'&&e.rule.includes('Lead 身份由会话事实决定'));
}));
