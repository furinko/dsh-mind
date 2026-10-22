import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {PassThrough} from 'node:stream';
import assert from 'node:assert/strict';
import {makeFixture,LEAD} from './helpers.mjs';
import {Org} from '../src/org.js';
import {ReviewExperimentService} from '../src/review-experiments.js';
import {inspectExperimentCandidate,EXPERIMENT_BOUNDARY,removeExperimentScope} from '../src/review-experiment-files.js';

export const REVIEW_PROJECT='review-experiment';
export const REVIEW_HOLDER='exact-review-child';
export const REVIEW_OUTPUT='LOCAL-TEST-STDOUT-NOT-AUDIT';
/** 真实Org/注册/任务/私有账本；只有已审候选字节、解释器字节与宿主进程是受控依赖，不证明OS隔离。 */
export async function reviewScene(fn,options={}){
  const f=await makeFixture(),root=fs.mkdtempSync(path.join(tmpdir(),'mind-review-fixture-')),source=path.join(root,'candidate'),ownedScopes=[],handles=[];let service;
  try{
    fs.mkdirSync(source);for(const file of ['test/preflight.mjs','test/example.test.js','components/board/test/example.test.js','components/board/test/client-harness.mjs','scripts/verify-profile-install.mjs','package.json']){
      const p=path.join(source,file);fs.mkdirSync(path.dirname(p),{recursive:true});fs.writeFileSync(p,file==='package.json'?'{}':'// reviewed fixed test fixture\n');
    }
    const node=path.join(root,'operator-pinned-interpreter.bin');fs.writeFileSync(node,'CONTROLLED-NODE-BYTES-NOT-A-REAL-OS-PROCESS');
    const org=await Org.open({home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project:REVIEW_PROJECT});
    await org.registry.assign({subject:LEAD,岗位:'复核员',实例:REVIEW_HOLDER});
    const target=await org.tasks.create({subject:LEAD,项目:REVIEW_PROJECT,描述:'被验业务',负责人:['插件工程'],判据:['冻结原判据']});
    const task=await org.tasks.create({subject:LEAD,项目:REVIEW_PROJECT,描述:'独立复核任务',负责人:['复核员'],判据:['独立复核'],复核对象:[target.id]});
    await org.tasks.bind(task.id,{subject:LEAD,项目:REVIEW_PROJECT,实例:REVIEW_HOLDER,岗位:'复核员'});await org.tasks.dispatch(task.id,{subject:LEAD,项目:REVIEW_PROJECT});
    await org.tasks.attach(task.id,{subject:LEAD,项目:REVIEW_PROJECT,产出物:source,读根:true});
    const reviewer={id:REVIEW_HOLDER,kind:'成员',roleId:'复核员'};await org.tasks.start(task.id,{subject:reviewer,项目:REVIEW_PROJECT});
    const parentAgent={id:LEAD.id,session:{id:LEAD.id,header:{id:LEAD.id,cwd:f.home}}},childAgent={id:REVIEW_HOLDER,session:{id:REVIEW_HOLDER,header:{id:REVIEW_HOLDER,cwd:f.home,origin:'subagent',parentSession:LEAD.id}}};
    const agents={get:id=>id===LEAD.id?parentAgent:id===REVIEW_HOLDER?childAgent:undefined};
    const parentHost={project:REVIEW_PROJECT,agent:parentAgent,agents,subagents:{listChildren:async()=>[{id:REVIEW_HOLDER,mode:'continuable'}]}};
    const childHost={project:REVIEW_PROJECT,agent:childAgent,agents};
    const calls={confine:[],spawn:[],terminate:0,wait:0,scopes:ownedScopes};let mode=options.mode??'ok';let spawnedResolve;const spawned=new Promise(resolve=>{spawnedResolve=resolve;});
    const sandbox={async confine(argv,policy,signal){calls.confine.push({argv,policy});if(mode==='sandbox-fail')throw Object.assign(Error('private host details'),{code:'SANDBOX_UNAVAILABLE'});return {argv:['official-runner','--',...argv],enforcement:options.enforcement??'partial',denialSignatures:['permission-denied-marker'],runnerFailureRules:[{fatalSignatures:['runner-fatal-marker']}]};}};
    const subprocess={spawn(spec){
      calls.spawn.push(spec);calls.scopes.push(path.dirname(spec.cwd));spawnedResolve();
      if(mode==='spawn-throw')throw Error('private spawn detail');
      const stdout=new PassThrough(),stderr=new PassThrough();let resolve;const done=new Promise(r=>{resolve=r;});let ended=false;
      const end=(exitCode,text='')=>{if(ended)return;ended=true;stdout.end(text);stderr.end();resolve({exitCode,signal:null});};
      const handle={stdout,stderr,done,terminate(){calls.terminate++;if(mode!=='unclosed')end(1);},async waitForExit(signal){calls.wait++;if(mode==='unclosed')return false;await done;return !signal?.aborted;}};
      spec.signal.addEventListener('abort',()=>handle.terminate(),{once:true});
      queueMicrotask(()=>{if(['waiting','unclosed'].includes(mode))return;if(mode==='tamper-copy')fs.writeFileSync(path.join(spec.cwd,'test/preflight.mjs'),'changed by trusted test');end(0,mode==='output-limit'?'X'.repeat(2048):REVIEW_OUTPUT);});
      handles.push(handle);return handle;
    }};
    const config={enabled:true,boundary:EXPERIMENT_BOUNDARY,node:{path:node,sha256:createHash('sha256').update(fs.readFileSync(node)).digest('hex')},candidates:[{id:'trusted-candidate',root:source,...inspectExperimentCandidate(source),reviewed:true}],limits:{maxRuns:2,ttlMs:3600000,timeoutMs:1000,outputBytes:1024,closeMs:50}};
    const services={sandbox,subprocess};service=new ReviewExperimentService({org,config,services:()=>services});
    const parent=(action,args={})=>({action,args:{action,...args},project:REVIEW_PROJECT,sessionProject:REVIEW_PROJECT,host:parentHost,subject:LEAD});
    const child=(action,args={})=>({action,args:{action,...args},project:REVIEW_PROJECT,sessionProject:REVIEW_PROJECT,host:childHost,subject:reviewer});
    const grantArgs={决定:'登记',任务:task.id,实例:REVIEW_HOLDER,候选id:'trusted-candidate',配方列表:['preflight','root-tests']};
    const grant=(args={})=>service.allow(parent('review_experiment_allow',{...grantArgs,...args}));
    const run=(permit,args={})=>service.run(child('review_experiment_run',{许可id:permit.许可id,配方:'preflight',...args}));
    const read=(permit,args={},lead=false)=>service.read((lead?parent:child)('review_experiment_read',{许可id:permit.许可id,...args}));
    await fn({f,root,source,node,org,target,task,reviewer,parentHost,childHost,parentAgent,childAgent,config,services,service,calls,spawned,parent,child,grantArgs,grant,run,read,setMode:value=>{mode=value;}});
  }finally{
    await service?.dispose();
    // fixture-only unknown host scopes have no real processes; verify generated absolute root before removing.
    for(const handle of handles){handle.stdout.destroy();handle.stderr.destroy();}
    for(const generated of new Set(ownedScopes))if(fs.existsSync(generated))removeExperimentScope({root:generated});
    const actual=fs.realpathSync(root);assert.equal(actual,path.resolve(root));assert.match(path.basename(actual),/^mind-review-fixture-/);fs.rmSync(actual,{recursive:true,force:false,maxRetries:3,retryDelay:50});
    assert.equal(fs.realpathSync(f.home),path.resolve(f.home));assert.match(path.basename(f.home),/^mind-fix-/);await f.cleanup();
  }
}
