import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {makeFixture,LEAD,MEMBER,SOVEREIGN} from './helpers.mjs';
import {Org} from '../src/org.js';
import {reviewScene,REVIEW_PROJECT} from './review-experiment-fixture.mjs';
const P='no-specialty-admission';
test('缺专业卡仍可记录委派意图、受管额度准入和治理读数，真实代次及撤权继续生效',async()=>{
 const f=await makeFixture();let org;
 try{
  org=await Org.open({...f,project:P});
  const goal=await org.goals.create({subject:LEAD,项目:P,请求键:'synthetic-goal',期望结果:'实际交付',完成依据:['实际检查'],来源:'合成用户任务',下一步:'执行合成任务'});
  const task=await org.tasks.create({subject:LEAD,项目:P,描述:'真实工作',负责人:MEMBER.id,判据:['实际证据']});
  await org.budgets.configure(goal.id,{subject:SOVEREIGN,项目:P,预算修订:0,上限:3});
  const file=org.layout.identityFile();const identity=JSON.parse(await readFile(file,'utf8'));
  delete identity.members[LEAD.id].卡版本;delete identity.members[MEMBER.id].卡版本;
  await writeFile(file,JSON.stringify(identity));
  org.registry.cardOf=async()=>{throw Error('治理准入不得读取专业卡');};
  await org.registry.assign({subject:LEAD,岗位:MEMBER.roleId,实例:'new-specialist-without-parent-card'});
  assert.equal((await org.registry.identity()).members['new-specialist-without-parent-card'].委派者.id,LEAD.id);
  assert.equal((await org.spawnOperations.begin({subject:LEAD,项目:P,任务:task.id,方式:'subagent',请求摘要:'a'.repeat(64)})).可创建,true);
  const reserve=subject=>org.budgets.reserve({subject,项目:P,目标:goal.id,执行键:randomUUID(),类别:'member_file',工具:'read',指纹:'b'.repeat(64)});
  assert.equal((await reserve({id:MEMBER.id,kind:'成员'})).可放行,true);
  assert.ok(await org.budgets.query(goal.id,{subject:LEAD,项目:P}));
  assert.ok(await org.spawnOperations.query({subject:LEAD,项目:P}));
  assert.ok(await org.modelUsage.query({subject:LEAD,项目:P}));
  assert.ok(await org.knowledgeReuse.query({subject:LEAD,项目:P}));
  await org.registry.revoke({subject:SOVEREIGN,对象id:goal.id,理由:'真实用户撤回目标'});
  await assert.rejects(reserve(MEMBER),e=>e.code==='DENIED');
  const stale=await org.registry.identity();stale.members[LEAD.id].运行绑定={状态:'失效'};await writeFile(file,JSON.stringify(stale));
  for(const read of [()=>org.spawnOperations.query({subject:LEAD,项目:P}),()=>org.modelUsage.query({subject:LEAD,项目:P}),()=>org.knowledgeReuse.query({subject:LEAD,项目:P}),()=>org.budgets.query(goal.id,{subject:LEAD,项目:P})])await assert.rejects(read(),e=>e.code==='DENIED');
 }finally{await org?.observability.flush();await f.cleanup();}
});
test('实际审查实验绑定真实身份和冻结内容，缺专业卡不阻执行，宿主代次变化使旧许可失效',()=>reviewScene(async s=>{
 const file=s.org.layout.identityFile(),identity=JSON.parse(await readFile(file,'utf8'));
 delete identity.members[LEAD.id].卡版本;delete identity.members[s.reviewer.id].卡版本;await writeFile(file,JSON.stringify(identity));
 s.org.registry.cardOf=async()=>{throw Error('冻结实验不以专业卡当通行证');};
 const grant=await s.grant();const done=await s.run(grant);assert.equal(done.状态,'completed');assert.equal(s.calls.spawn.length,1);
 const current=await s.org.registry.identity();current.members[s.reviewer.id].代次={代:'changed-host',pid:process.pid};await writeFile(file,JSON.stringify(current));
 await assert.rejects(s.run(grant),e=>e.code==='DENIED');assert.equal(s.calls.spawn.length,1);
},{role:'插件工程'}));
