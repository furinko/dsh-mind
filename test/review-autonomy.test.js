import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {ReviewExperimentService} from '../src/review-experiments.js';
import {reviewScene,REVIEW_OUTPUT} from './review-experiment-fixture.mjs';

async function autonomous(run,options={}){
  return reviewScene(async s=>{
    const service=new ReviewExperimentService({org:s.org,services:()=>s.services});
    const args={决定:'登记',任务:s.task.id,实例:s.reviewer.id,候选根:s.source,实验配方:[{id:'any-project-test',可执行文件:s.node,参数:['test/example.test.js','--fixture']} ]};
    const allow=(changes={})=>service.allow(s.parent('review_experiment_allow',{...args,...changes}));
    const execute=(grant,changes={})=>service.run(s.child('review_experiment_run',{许可id:grant.许可id,配方:'any-project-test',...changes}));
    try{await run({...s,auto:service,args,allow,execute});}finally{await service.dispose();}
  },options);
}
test('无部署名单或人侧登记：Lead冻结任意项目命名配方，复核员独立运行与读回',()=>autonomous(async s=>{
  assert.equal(s.auto.status().enabled,true);const grant=await s.allow();assert.equal(grant.模式,'Lead自治');assert.equal(grant.宿主权限,'workspace-write');
  const result=await s.execute(grant);assert.equal(result.状态,'completed');assert.equal(result.原树未变,true);assert.equal(result.副本已清理,true);
  const read=await s.auto.read(s.child('review_experiment_read',{许可id:grant.许可id,运行id:result.运行id}));assert.equal(Buffer.from(read.字节Base64,'base64').toString(),REVIEW_OUTPUT);
  assert.deepEqual(s.calls.spawn[0].argv.slice(-2),['test/example.test.js','--fixture']);assert.equal(s.calls.confine[0].policy.mode,'workspace-write');
}));
test('代码变化使旧许可不可运行；Lead可自行重新冻结新版本，无需修改部署文件',()=>autonomous(async s=>{
  const old=await s.allow();fs.appendFileSync(path.join(s.source,'test/example.test.js'),'// changed version');await assert.rejects(s.execute(old),/manifest变化/);assert.equal(s.calls.spawn.length,0);
  const next=await s.allow();assert.notEqual(next.manifest,old.manifest);assert.equal((await s.execute(next)).状态,'completed');
}));
test('复核员不能自发许可、Lead不能代跑；run不能换命令或自报权限',()=>autonomous(async s=>{
  await assert.rejects(s.auto.allow(s.child('review_experiment_allow',s.args)),/只有派发Lead/);
  const grant=await s.allow();await assert.rejects(s.auto.run(s.parent('review_experiment_run',{许可id:grant.许可id,配方:'any-project-test'})),/独立发起|代跑/);
  for(const changes of [{配方:'not-granted'},{argv:['other']},{实验配方:[]},{sandbox:'full'}])await assert.rejects(s.execute(grant,changes),/冻结列表|未知字段/);
  assert.equal(s.calls.spawn.length,0);
}));
test('正式读根之外的代码不可自行授权，输入中的未冻结权限/环境也不透传',()=>autonomous(async s=>{
  await assert.rejects(s.allow({候选根:s.root}),/正式读根/);
  await assert.rejects(s.allow({env:{TOKEN:'fake'}}),/未知字段/);await assert.rejects(s.allow({实验配方:[{id:'bad',参数:[],sandbox:'full'}]}),/未知字段/);
  assert.equal(s.calls.spawn.length,0);
}));
test('完全权限复用正式进程服务，诚实标明无隔离，不要求安装额外sandbox包装',()=>autonomous(async s=>{
  s.services.sandbox=null;const grant=await s.allow();const result=await s.execute(grant);assert.equal(result.状态,'completed');assert.equal(result.沙箱,'none');assert.equal(s.calls.confine.length,0);assert.equal(s.calls.spawn.length,1);
},{nativeMode:'danger-full-access'}));
test('双方权限取交集：Lead完全权限不会抬高只读复核会话',()=>autonomous(async s=>{
  s.services.sandboxPolicy.resolve=({session})=>({mode:session.id===s.parentAgent.id?'danger-full-access':'read-only',workspaceRoot:session.header.cwd});
  const grant=await s.allow();assert.equal(grant.宿主权限,'read-only');assert.equal((await s.execute(grant)).状态,'completed');assert.equal(s.calls.confine[0].policy.mode,'read-only');
}));
test('许可后宿主权限变化拒绝执行，不能沿用旧的完全权限凭据',()=>autonomous(async s=>{
  const grant=await s.allow();s.services.sandboxPolicy.resolve=({session})=>({mode:'read-only',workspaceRoot:session.header.cwd});await assert.rejects(s.execute(grant),/宿主会话权限已变化/);assert.equal(s.calls.spawn.length,0);
},{nativeMode:'danger-full-access'}));
test('沙箱准备后权限改变，真正spawn前再次拒绝并清理副本',()=>autonomous(async s=>{
  const grant=await s.allow(),original=s.services.sandbox.confine.bind(s.services.sandbox);
  s.services.sandbox.confine=async(...args)=>{const wrapped=await original(...args);s.services.sandboxPolicy.resolve=({session})=>({mode:'read-only',workspaceRoot:session.header.cwd});return wrapped;};
  const result=await s.execute(grant);assert.notEqual(result.状态,'completed');assert.equal(result.副本已清理,true);assert.equal(s.calls.spawn.length,0);
}));
test('原生策略或进程服务缺失时在登记阶段说明不可用，不把模型自述当授权',()=>autonomous(async s=>{
  s.services.sandboxPolicy=null;await assert.rejects(s.allow(),/宿主权限解析/);assert.equal(s.calls.spawn.length,0);
}));
test('配方执行器变化同样失效；不能仅凭路径相同运行不同字节',()=>autonomous(async s=>{
  const grant=await s.allow();fs.appendFileSync(s.node,'changed interpreter');await assert.rejects(s.execute(grant),/Node二进制不符/);assert.equal(s.calls.spawn.length,0);
}));
test('快照排除版本库元数据，登记和复跑不会复制或改写git目录',()=>autonomous(async s=>{
  fs.mkdirSync(path.join(s.source,'.git'));fs.writeFileSync(path.join(s.source,'.git','state'),'original');const grant=await s.allow();fs.writeFileSync(path.join(s.source,'.git','state'),'metadata changed');
  const result=await s.execute(grant);assert.equal(result.状态,'completed');assert.equal(fs.readFileSync(path.join(s.source,'.git','state'),'utf8'),'metadata changed');
}));
test('运行中宿主权限撤回会取消当前实验，不能等下一次才生效',()=>autonomous(async s=>{
  const grant=await s.allow(),running=s.execute(grant);await s.spawned;s.services.sandboxPolicy.resolve=({session})=>({mode:'read-only',workspaceRoot:session.header.cwd});const result=await running;assert.notEqual(result.状态,'completed');assert.ok(s.calls.terminate>0);assert.equal(result.范围已退出,true);
},{mode:'waiting'}));

test('空闲复核实例经公开权限观察登记，恢复后可用同一许可独立运行',()=>autonomous(async s=>{
 const original=s.parentHost.agents.get;let disposed=0;
 s.parentHost.agents.get=id=>id===s.reviewer.id?undefined:original(id);
 s.services.sessionQuery={observeSession:async id=>({header:{id,cwd:s.childAgent.session.header.cwd,parentSession:s.parentAgent.id},cursor:0,events:[{seq:0,type:'sandbox/mode',data:{mode:'workspace-write'}}],[Symbol.dispose](){disposed++;}})};
 const grant=await s.allow();assert.ok(disposed>0);s.parentHost.agents.get=original;assert.equal((await s.execute(grant)).状态,'completed');
}));
test('空闲会话权限历史不完整不能猜默认值，归属错误也不得生成许可',()=>autonomous(async s=>{
 const original=s.parentHost.agents.get;s.parentHost.agents.get=id=>id===s.reviewer.id?undefined:original(id);let parent=s.parentAgent.id,events=[];let disposed=0;
 s.services.sessionQuery={observeSession:async id=>({header:{id,cwd:s.childAgent.session.header.cwd,parentSession:parent},cursor:0,events,[Symbol.dispose](){disposed++;}})};
 await assert.rejects(s.allow(),/权限历史不完整/);events=[{seq:0,type:'sandbox/mode',data:{mode:'workspace-write'}}];parent='wrong-parent';await assert.rejects(s.allow(),/父子归属/);assert.equal(s.calls.spawn.length,0);assert.equal(disposed,2);
}));
