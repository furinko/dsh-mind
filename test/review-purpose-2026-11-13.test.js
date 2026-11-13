import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER, REVIEWER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { runAction } from '../lib/actions.js';
const P='review-purpose';
const TECH={id:'member-b',kind:'成员',roleId:'插件工程'};
async function scene(run) {
  const f=await makeFixture();
  try { const org=await Org.open({...f,project:P}); await run(org,f); }
  finally {await f.cleanup();}
}
async function task(org,owner,{objects=[],submit=false}={}) {
  const node=await org.tasks.create({subject:LEAD,项目:P,描述:'按任务用途工作',负责人:owner.id,判据:['实际证据'],复核对象:objects});
  await org.tasks.bind(node.id,{subject:LEAD,项目:P,实例:owner.id,岗位:owner.roleId});
  await org.tasks.dispatch(node.id,{subject:LEAD,项目:P});
  await org.tasks.start(node.id,{subject:owner,项目:P});
  if(submit) await org.tasks.submit(node.id,{subject:owner,项目:P,结论:'实际完成'});
  return org.tasks.get(node.id,{项目:P});
}
test('复核专业在普通任务可执行、写本人经历并交付，不按专业名全局只读',()=>scene(async org=>{
  const n=await task(org,REVIEWER);
  const remembered=await org.memory.remember({subject:REVIEWER,项目:P,任务:n,类:'经历',内容:'普通专业任务中的合成经历',来源:'实际普通任务'});
  assert.ok(remembered.id);
  await org.tasks.attach(n.id,{subject:REVIEWER,项目:P,产出物:'ordinary-reference'});
  assert.equal((await org.tasks.submit(n.id,{subject:REVIEWER,项目:P,结论:'完成普通工作'})).状态,'已交卷');
}));
test('任意专业进入真实复核用途可以独立出票，范围与只读边界跟用途走',()=>scene(async org=>{
  const business=await task(org,MEMBER,{submit:true});
  const unrelated=await task(org,MEMBER,{submit:true});
  const review=await task(org,TECH,{objects:[business.id]});
  await assert.rejects(org.memory.remember({subject:TECH,项目:P,任务:review,类:'经历',内容:'不得在审查用途修改持久资料',来源:'test'}),error=>error.code==='DENIED');
  await assert.rejects(runAction({org,项目:P,主体:TECH,args:{action:'task_criteria',id:unrelated.id}}),error=>error.code==='DENIED');
  const voted=await org.tasks.review(business.id,{subject:TECH,项目:P,三态:'过'});
  assert.match(voted.待采纳.票,/^rv-\d+$/);
  const accepted=await org.tasks.accept(business.id,{subject:LEAD,项目:P,票:voted.待采纳.票});
  assert.equal(accepted.采纳.依据,'复核结论');
  assert.equal(accepted.待采纳,undefined);
}));
test('没有真实复核用途、未派发或陈旧凭证均不能靠专业名或自报用途出票',()=>scene(async(org,f)=>{
  const business=await task(org,MEMBER,{submit:true});
  await assert.rejects(org.tasks.review(business.id,{subject:TECH,项目:P,三态:'过',复核用途:true}),error=>error.code==='DENIED');
  const review=await org.tasks.create({subject:LEAD,项目:P,描述:'尚未派发的复核',负责人:TECH.id,判据:['独立核对'],复核对象:[business.id]});
  await org.tasks.bind(review.id,{subject:LEAD,项目:P,实例:TECH.id,岗位:TECH.roleId});
  await assert.rejects(org.tasks.review(business.id,{subject:TECH,项目:P,三态:'过'}),error=>error.code==='DENIED');
  await org.tasks.dispatch(review.id,{subject:LEAD,项目:P});
  const rows=await org.tasks.events({项目:P});
  await appendFile(f.layout.taskLog(P),JSON.stringify({kind:'bound',id:review.id,seq:rows.length+1,at:org.clock.iso(),by:LEAD,绑定:{实例:TECH.id,岗位:TECH.roleId,于:org.clock.iso(),凭证:{版本:1,代:999,宿主代次:null}}})+'\n');
  await assert.rejects(org.tasks.review(business.id,{subject:TECH,项目:P,三态:'过'}),error=>error.code==='DENIED');
}));
test('专业变化不替代作者独立性，已完成复核任务不继续授权新票',()=>scene(async org=>{
  const own=await task(org,TECH,{submit:true});
  await task(org,TECH,{objects:[own.id]});
  await assert.rejects(org.tasks.review(own.id,{subject:TECH,项目:P,三态:'过'}),error=>error.code==='DENIED');
  const business=await task(org,MEMBER,{submit:true});
  const review=await task(org,REVIEWER,{objects:[business.id]});
  await org.tasks.close(review.id,{subject:LEAD,项目:P,原因:'结束此次审查用途'});
  await assert.rejects(org.tasks.review(business.id,{subject:REVIEWER,项目:P,三态:'过'}),error=>error.code==='DENIED');
}));
