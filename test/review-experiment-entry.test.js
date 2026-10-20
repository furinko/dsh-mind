import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {apply as applyKernel} from '../components/kernel/lib/index.js';
import {fakeHost} from './host-harness.mjs';
import {forgetSharedOrg} from '../src/runtime.js';
import {reviewScene,REVIEW_PROJECT} from './review-experiment-fixture.mjs';
import {runAction,ACTIONS,READ_ONLY_ACTIONS} from '../lib/actions.js';
import {ReviewExperimentService} from '../src/review-experiments.js';

function act(s,kind,action,args={}){
  const spec=s[kind](action,args);spec.host.reviewExperiments=s.service;
  return runAction({org:s.org,项目:REVIEW_PROJECT,主体:spec.subject,面:'tool',宿主:spec.host,args:spec.args});
}
async function withKernel(s,fn,{configured=true}={}){
  const disposers=[],config={home:s.f.home,factoryRoot:s.f.factoryRoot,privateRoot:s.f.privateRoot,project:REVIEW_PROJECT,projectBindings:[{path:path.join(s.root,REVIEW_PROJECT),project:REVIEW_PROJECT}],audit工具调用:false,...(configured?{reviewExperiments:s.config}:{})};
  const host=fakeHost({提供服务:['tools','commands','systemPrompt','agents','workingDirectory','subagents','sandbox','subprocess'],服务:{agents:s.parentHost.agents,workingDirectory:{get:()=>path.join(s.root,REVIEW_PROJECT)},subagents:s.parentHost.subagents,sandbox:s.services.sandbox,subprocess:s.services.subprocess}});
  host.ctx.effect=fn=>{const disposer=fn();disposers.push(disposer);return disposer;};
  try{await applyKernel(host.ctx,config);const tool=host.工具.get('mind');const invoke=async(args,child=false)=>JSON.parse(await tool.execute({project:REVIEW_PROJECT,...args},{name:'mind',agent:child?s.childAgent:s.parentAgent}));await fn({host,tool,invoke,disposers});}
  finally{for(const dispose of disposers.reverse())await dispose?.();forgetSharedOrg(config);}
}
async function approvalMode(s){await s.f.write('集体L2-共享基础设施/defaults/介入度.json',JSON.stringify({介入度:'审批'}));await s.org.policy.reload();}
const owner={通道:'设置页',认证:'宿主 Connection 已认证（同源浏览器设置入口）'};
async function pending(promise){let id;await assert.rejects(promise,e=>{id=e.detail?.请求id;return e.name==='NeedsApproval'&&typeof id==='string';});return id;}

test('动作单源：仅read是只读，allow/run按写守Lead及审批边界',()=>{for(const name of ['allow','run','read'])assert.ok(ACTIONS.includes('review_experiment_'+name));assert.ok(READ_ONLY_ACTIONS.includes('review_experiment_read'));assert.ok(!READ_ONLY_ACTIONS.includes('review_experiment_run'));assert.ok(!READ_ONLY_ACTIONS.includes('review_experiment_allow'));});
test('真实runAction入口正控：父登记、复核实例独立run/read',()=>reviewScene(async s=>{const g=await act(s,'parent','review_experiment_allow',s.grantArgs);const r=await act(s,'child','review_experiment_run',{许可id:g.许可id,配方:'preflight'});assert.equal(r.状态,'completed');assert.equal(r.主体.id,s.reviewer.id);const out=await act(s,'child','review_experiment_read',{许可id:g.许可id,运行id:r.运行id});assert.ok(out.字节Base64);assert.equal(s.calls.spawn.length,1);}));
test('真实注册工具schema/宿主束接线：配置后可独立运行，复核员pwsh仍被闭名单拒绝',()=>reviewScene(s=>withKernel(s,async({host,tool,invoke})=>{
  assert.ok(tool.parameters.properties.action.enum.includes('review_experiment_run'));assert.deepEqual(tool.parameters.properties.配方.enum,['preflight','root-tests','board-tests','client-harness','install-selftest']);
  const g=await invoke({action:'review_experiment_allow',...s.grantArgs});assert.equal(g.成功,true,JSON.stringify(g));
  const exec={name:'mind',arguments:{action:'review_experiment_run',许可id:g.许可id,配方:'preflight'},agent:s.childAgent};for(const guard of host.闸)assert.equal(await guard(exec),undefined);
  const r=await invoke(exec.arguments,true);assert.equal(r.成功,true,JSON.stringify(r));assert.equal(r.状态,'completed');assert.equal(s.calls.spawn.length,1);
  const rejection=host.闸.map(guard=>guard({name:'pwsh',arguments:{command:'not executed'},agent:s.childAgent})).find(Boolean);assert.match(rejection,/复核员只读|闭名单/);
})));
test('真实工具缺省未配置时关闭，不因schema可见就产生执行权',()=>reviewScene(s=>withKernel(s,async({invoke})=>{const r=await invoke({action:'review_experiment_allow',...s.grantArgs});assert.equal(r.成功,false);assert.match(r.理由,/未由部署配置启用/);assert.equal(s.calls.spawn.length,0);},{configured:false})));
test('无宿主实验服务时不可退回单步盲审批或裸执行',()=>reviewScene(async s=>{const spec=s.parent('review_experiment_allow',s.grantArgs);await assert.rejects(runAction({org:s.org,项目:REVIEW_PROJECT,主体:spec.subject,面:'tool',宿主:spec.host,args:spec.args}),e=>e.code==='EXPERIMENT_NOT_WIRED');assert.equal(s.calls.spawn.length,0);assert.equal(fs.existsSync(s.org.layout.reviewExperimentLog(REVIEW_PROJECT)),false);}));
test('审批许可：完整内容先预览，原申请者重放一次后不可复用',()=>reviewScene(async s=>{
  await approvalMode(s);const id=await pending(act(s,'parent','review_experiment_allow',s.grantArgs));
  assert.equal(fs.existsSync(s.org.layout.reviewExperimentLog(REVIEW_PROJECT)),false);
  const request=await s.org.intervention.读冻结({请求id:id,subject:s.parent('x').subject}),preview=request.步骤[0].预览;
  assert.equal(preview.manifest,s.config.candidates[0].manifestHash);assert.equal(preview.NodeSHA,s.config.node.sha256);assert.equal(preview.源候选根,s.source);assert.ok(preview.凭证代次);assert.ok(preview.配方[0].argv);
  await s.org.intervention.人侧决议({...owner,请求id:id,决定:'批准'});
  const g=await act(s,'parent','review_experiment_allow',{...s.grantArgs,审批引用:id});assert.ok(g.许可id);
  await assert.rejects(act(s,'parent','review_experiment_allow',{...s.grantArgs,审批引用:id}),/放行不可用|已执行|已完成/);assert.equal(s.calls.spawn.length,0);
}));
test('审批实验：预判携带sandbox，只解除confirm不跳过真实任务/预算',()=>reviewScene(async s=>{
  const g=await act(s,'parent','review_experiment_allow',s.grantArgs);await approvalMode(s);
  const args={许可id:g.许可id,配方:'preflight'},id=await pending(act(s,'child','review_experiment_run',args));assert.equal(s.calls.spawn.length,0);
  const req=await s.org.intervention.读冻结({请求id:id,subject:s.reviewer});assert.equal(req.步骤[0].动作,'experiment');assert.ok(req.步骤[0].预览.预算);
  await s.org.intervention.人侧决议({...owner,请求id:id,决定:'批准'});
  const r=await act(s,'child','review_experiment_run',{...args,审批引用:id});assert.equal(r.状态,'completed');assert.equal(s.calls.spawn.length,1);
  await assert.rejects(act(s,'child','review_experiment_run',{...args,审批引用:id}),/放行不可用|已完成/);assert.equal(s.calls.spawn.length,1);
}));
test('审批后部署配置变化：现在计划不同，不执行冻结标签下的新内容',()=>reviewScene(async s=>{
  await approvalMode(s);const id=await pending(act(s,'parent','review_experiment_allow',s.grantArgs));await s.org.intervention.人侧决议({...owner,请求id:id,决定:'批准'});
  const changed=new ReviewExperimentService({org:s.org,config:{...s.config,limits:{...s.config.limits,maxRuns:1}},services:()=>s.services});s.parentHost.reviewExperiments=changed;
  const spec=s.parent('review_experiment_allow',{...s.grantArgs,审批引用:id});await assert.rejects(runAction({org:s.org,项目:REVIEW_PROJECT,主体:spec.subject,面:'tool',宿主:spec.host,args:spec.args}),/放行不可用|计划|步骤/);assert.equal(s.calls.spawn.length,0);assert.equal(fs.existsSync(s.org.layout.reviewExperimentLog(REVIEW_PROJECT)),false);await changed.dispose();
}));
test('审批后身份封存恢复：同id同卡不替换原批准的实例事实',()=>reviewScene(async s=>{
  await approvalMode(s);const id=await pending(act(s,'parent','review_experiment_allow',s.grantArgs));await s.org.intervention.人侧决议({...owner,请求id:id,决定:'批准'});
  // 由受控人侧放权准备合法撤权/恢复，不用模型自报Owner绕工具入口。
  await s.f.write('集体L2-共享基础设施/defaults/介入度.json',JSON.stringify({介入度:'放权'}));await s.org.policy.reload();
  await s.org.registry.seal({subject:s.parent('x').subject,实例:s.reviewer.id,理由:'post-approval ABA'});await s.org.registry.restore({subject:s.parent('x').subject,实例:s.reviewer.id});await approvalMode(s);
  await assert.rejects(act(s,'parent','review_experiment_allow',{...s.grantArgs,审批引用:id}),/放行不可用|计划|步骤/);assert.equal(s.calls.spawn.length,0);
}));
