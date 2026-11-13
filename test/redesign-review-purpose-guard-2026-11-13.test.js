import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {makeFixture,LEAD} from './helpers.mjs';
import {fakeHost} from './host-harness.mjs';
import {apply} from '../components/kernel/lib/index.js';
import {shareOrg,forgetSharedOrg} from '../src/runtime.js';
import {drainKernelAudit} from './kernel-drain.mjs';
import {runAction} from '../lib/actions.js';
const P='review-purpose-guard';
const technical={id:'member-b',kind:'成员',roleId:'插件工程'};
test('真实同步guard按技术成员实际复核用途授权读根与禁写，用途结束即收口，异步出口丢弃已撤销读域',async()=>{
 const f=await makeFixture(),host=fakeHost();let org;
 const cwd=join(f.home,'workspace');await mkdir(cwd);const file=join(cwd,'public.txt');await writeFile(file,'synthetic artifact');
 const config={home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project:P,projectBindings:[{path:cwd,project:P}],audit工具调用:false,观测模型用量:false};
 try{
  await apply(host.ctx,config);org=await shareOrg(config);
  const business=await org.tasks.create({subject:LEAD,项目:P,描述:'被验产物',负责人:'member-a',判据:['真实内容']});
  const review=await org.tasks.create({subject:LEAD,项目:P,描述:'技术专业实际审查',负责人:technical.id,判据:['核对'],复核对象:[business.id]});
  await org.tasks.bind(review.id,{subject:LEAD,项目:P,实例:technical.id,岗位:technical.roleId});await org.tasks.dispatch(review.id,{subject:LEAD,项目:P});
  await runAction({org,项目:P,主体:LEAD,args:{action:'task_attach',id:review.id,产出物引用:cwd}});
  const agent={id:technical.id,session:{id:technical.id,header:{origin:'subagent',parentSession:'lead',delegationDepth:1,cwd}}};
  const guard=(name,args)=>host.闸.map(g=>g({name,arguments:args,agent})).find(r=>r!==undefined);
  assert.equal(guard('read',{file_path:file}),undefined,'非复核专业也可沿真实审查读根读取');
  assert.match(guard('write',{file_path:file}),/只读闭名单|只读数/,'当前审查用途不能改被验产物');
  const check=org.policy.check.bind(org.policy);let changed=false;
  org.policy.check=async spec=>{const result=await check(spec);if(!changed&&spec.subject?.id===technical.id&&spec.action==='read'&&spec.target?.id===business.id){changed=true;await org.tasks.close(review.id,{subject:LEAD,项目:P,原因:'结束实际审查用途'});}return result;};
  await assert.rejects(runAction({org,项目:P,主体:technical,args:{action:'task_criteria',id:business.id}}),e=>e.code==='DENIED');
  assert.equal(changed,true);org.policy.check=check;
  assert.match(guard('read',{file_path:file}),/任务文件范围/,'结束用途后不能继续使用审查读根');
 }finally{host.清理();if(org)await drainKernelAudit(org);forgetSharedOrg(config);await f.cleanup();}
});
