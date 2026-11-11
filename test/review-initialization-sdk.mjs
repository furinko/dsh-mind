/* Actual selected public SDK Cordis/Session/ToolRuntime/native executor and full
 * Mind kernel. Synthetic task/member/catalog and subprocess service only; no
 * real Agent, model, Electron launch, live profile or production GUI acceptance. */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
import * as kernel from '../components/kernel/lib/index.js';
import {forgetSharedOrg,shareKey,shareOrg} from '../src/runtime.js';
import {reviewScene,REVIEW_PROJECT,REVIEW_OUTPUT} from './review-experiment-fixture.mjs';
import {installSdkTools,executeSdkTool} from './sdk-tool-runtime.mjs';
import {drainKernelAudit} from './kernel-drain.mjs';
if(!process.env.DSH_SDK_ROOT)throw Error('DSH_SDK_ROOT must name the isolated public SDK.');
const sdk=createRequire(path.resolve(process.env.DSH_SDK_ROOT,'package.json'));
const load=name=>import(pathToFileURL(sdk.resolve('@deepseek-ai/'+name)));
const [{Context},{ToolRuntime},{Session},{createScope}]=await Promise.all(['cordis','dsh-tools','dsh-session','dsh-scope'].map(load));
const standaloneNode=process.execPath;

async function fixture(run,options={}){
  return reviewScene(async s=>{
    const ctx=new Context(),controller=new AbortController();let sequence=0,org;
    const config={home:s.f.home,factoryRoot:s.f.factoryRoot,privateRoot:s.f.privateRoot,project:REVIEW_PROJECT,projectBindings:[{project:REVIEW_PROJECT,path:s.f.home}],memberFileAccess:{},轮级缓冲:false,项目接续:false,audit工具调用:false,webServer次数:0,...(options.config?{reviewExperiments:options.config}:{})};
    const previous=process.execPath,descriptor=Object.getOwnPropertyDescriptor(process.versions,'electron');
    const large=path.join(s.root,'synthetic-electron.exe');fs.writeFileSync(large,'');fs.truncateSync(large,134217729);
    try{
      ctx.reflect.provide('systemPrompt',{tools:()=>()=>{},section:()=>()=>{},context:()=>()=>{},getSectionOrder:()=>0,getContextOrder:()=>0});
      ctx.reflect.provide('sandboxPolicy',s.services.sandboxPolicy);
      ctx.reflect.provide('subprocess',s.services.subprocess);
      ctx.reflect.provide('sandbox',s.services.sandbox);
      await installSdkTools(ctx,ToolRuntime,load);
      for(const agent of [s.parentAgent,s.childAgent]){
        const header={...agent.session.header,version:4,createdAt:Date.now(),isSeeded:false};
        agent.session=Session.create(agent.id,[],header);agent.ctx=createScope(ctx,agent).ctx;
      }
      ctx.reflect.provide('agents',s.parentHost.agents);
      ctx.reflect.provide('subagents',s.parentHost.subagents);
      process.execPath=large;Object.defineProperty(process.versions,'electron',{value:'fixture',configurable:true});
      await kernel.apply(ctx,config);org=await shareOrg(config);
      const invoke=async(input,child=false)=>{
        const result=await executeSdkTool(ctx.tools,{callId:'review-init-'+(++sequence),name:'mind',arguments:input,agent:child?s.childAgent:s.parentAgent,signal:controller.signal});
        assert.equal(result.isError,false,JSON.stringify(result));return JSON.parse(result.value);
      };
      const args={action:'review_experiment_allow',决定:'登记',任务:s.task.id,实例:s.reviewer.id,候选根:s.source,实验配方:[{id:'fixed-node',可执行文件:standaloneNode,参数:['--test','test/example.test.js']}]};
      await run({...s,ctx,org,args,invoke});
    }finally{
      process.execPath=previous;if(descriptor)Object.defineProperty(process.versions,'electron',descriptor);else delete process.versions.electron;
      await ctx.fiber.dispose();if(org)await drainKernelAudit(org);forgetSharedOrg(shareKey(config));
    }
  },{nativeMode:'danger-full-access'});
}

test('SDK Electron-shaped kernel wires full plan, explicit Node grant, reviewer run/read',()=>fixture(async s=>{
  const grant=await s.invoke(s.args);assert.equal(grant.成功,true,JSON.stringify(grant));
  assert.equal(grant.模式,'Lead自治');assert.equal(grant.配方详情[0].可执行文件,fs.realpathSync(standaloneNode));
  assert.equal(grant.配方详情[0].SHA256,createHash('sha256').update(fs.readFileSync(standaloneNode)).digest('hex'));
  assert.deepEqual(grant.配方详情[0].参数,['--test','test/example.test.js']);
  assert.equal(s.calls.spawn.length,0,'registration is not execution');
  const input={action:'review_experiment_run',许可id:grant.许可id,配方:'fixed-node'};
  const wrong=await s.invoke(input);assert.equal(wrong.成功,false);assert.match(wrong.理由,/独立发起|代跑/);assert.equal(s.calls.spawn.length,0);
  const result=await s.invoke(input,true);assert.equal(result.成功,true,JSON.stringify(result));assert.equal(result.状态,'completed');assert.equal(s.calls.spawn.length,1);
  const output=await s.invoke({action:'review_experiment_read',许可id:grant.许可id,运行id:result.运行id},true);
  assert.equal(output.成功,true,JSON.stringify(output));assert.equal(Buffer.from(output.字节Base64,'base64').toString(),REVIEW_OUTPUT);
}));

test('SDK implicit Electron executable refuses at plan instead of missing-service fallback',()=>fixture(async s=>{
  const {实验配方,...base}=s.args;
  for(const recipe of [{实验配方:[{id:'implicit',参数:[]}]},{配方列表:['preflight']}]){
    const result=await s.invoke({...base,...recipe});assert.equal(result.成功,false,JSON.stringify(result));
    assert.notEqual(result.故障码,'EXPERIMENT_NOT_WIRED');assert.match(result.理由,/独立Node.*可执行文件/);
  }
  assert.equal(s.calls.spawn.length,0);
  assert.equal(fs.existsSync(s.org.layout.reviewExperimentLog(REVIEW_PROJECT)),false);
}));

test('SDK explicit deployment disable remains a closed service',()=>fixture(async s=>{
  const result=await s.invoke(s.args);assert.equal(result.成功,false,JSON.stringify(result));
  assert.match(result.理由,/停用|未启用|不可用/);assert.equal(s.calls.spawn.length,0);
},{config:{enabled:false}}));

test('SDK malformed configuration still fails closed without raw execution',()=>fixture(async s=>{
  const result=await s.invoke(s.args);assert.equal(result.成功,false,JSON.stringify(result));
  assert.equal(result.故障码,'EXPERIMENT_NOT_WIRED');assert.equal(s.calls.spawn.length,0);
},{config:{mode:'invalid'}}));

test('SDK reviewer cannot self-grant and explicit input cannot expand roots or inject environment',()=>fixture(async s=>{
  const self=await s.invoke(s.args,true);assert.equal(self.成功,false,JSON.stringify(self));
  const outside=await s.invoke({...s.args,候选根:s.root});assert.equal(outside.成功,false,JSON.stringify(outside));assert.match(outside.理由,/正式读根/);
  const injected=await s.invoke({...s.args,env:{NODE_OPTIONS:'not-used'}});assert.equal(injected.成功,false,JSON.stringify(injected));assert.match(injected.理由,/未知字段/);
  assert.equal(s.calls.spawn.length,0);
}));

test('SDK full kernel exposes original report and failed ticket through scoped read schema',()=>fixture(async s=>{
  const project=REVIEW_PROJECT,subject=s.reviewer;
  await s.org.tasks.submit(s.task.id,{subject,项目:project,结论:'original report full text',结论层:'不过',反例面:['zero creation criterion unmet']});
  const voted=await s.org.tasks.review(s.task.id,{subject:s.parent('x').subject,项目:project,三态:'不过',分歧清单:['retain failure'],反例面:[]});
  const list=await s.invoke({action:'task_criteria',原记录:true,id:s.task.id},true);assert.equal(list.成功,true,JSON.stringify(list));assert.equal(list.总数,2);
  const ticket=voted.复核经过.at(-1).票,page=await s.invoke({action:'task_criteria',原记录:true,票:ticket});
  assert.equal(page.成功,true,JSON.stringify(page));assert.equal(JSON.parse(Buffer.from(page.字节Base64,'base64')).三态,'不过');
  const outside=await s.org.tasks.create({subject:s.parent('x').subject,项目:project,描述:'outside read domain',负责人:['插件工程'],判据:['outside']});
  assert.equal((await s.invoke({action:'task_criteria',原记录:true,id:outside.id},true)).成功,false);
  assert.equal((await s.invoke({action:'review_experiment_cleanup',许可id:'not-a-permit',运行id:'not-a-run'})).成功,false);
}));
