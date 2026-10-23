import {it} from 'node:test';import assert from 'node:assert/strict';import {join} from 'node:path';
import {createPersonaProtection} from '../components/kernel/lib/persona-protection.js';import {Org} from '../src/org.js';import {makeFixture,LEAD} from './helpers.mjs';import {runAction} from '../lib/actions.js';
for(const platform of ['linux','darwin','win32'])it(platform+'均遵循宿主权限，不包装命令和终端，保留人设文件接口边界',async()=>{
 const f=await makeFixture();const core=join(f.privateRoot,'主权人设','核心人设.md');let mode='danger-full-access';
 const sandboxPolicy={resolve:()=>({mode,workspaceRoot:f.home})},sandbox={confine:()=>({argv:['native'],enforcement:'partial'})},terminals={spawn:()=>({sessionId:'native'}),startSend:()=>true};
 const originals=[sandboxPolicy.resolve,sandbox.confine,terminals.spawn,terminals.startSend];const p=createPersonaProtection({org:{layout:{personaCoreFile:()=>core}},sandboxPolicy,sandbox,terminals,platform});
 try{for(mode of ['danger-full-access','workspace-write','read-only'])assert.equal(sandboxPolicy.resolve().mode,mode);assert.deepEqual([sandboxPolicy.resolve,sandbox.confine,terminals.spawn,terminals.startSend],originals);assert.equal(p.guard({name:'pwsh'}),undefined);assert.ok(p.guard({name:'write',arguments:{file_path:core}}));assert.equal(p.health().hostExecutionPolicy,'native');assert.equal(p.health().lastEnforcement,null);assert.equal(p.health().hostServicesWrapped,false);}finally{p.stop();await f.cleanup();}
});
it('状态、工作台和项目接续查询如实共享接口保护及无命令隔离声明',async()=>{
 const f=await makeFixture(),project='persona-platform';const org=await Org.open({home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project});
 try{assert.equal((await org.status()).核心人设保护,null);org.personaProtection=createPersonaProtection({org});const health=org.personaProtection.health();assert.equal((await org.status()).核心人设保护.保护范围,health.保护范围);assert.equal((await org.workbench()).核心人设保护.保护范围,health.保护范围);
 const result=await runAction({org,项目:project,主体:LEAD,args:{action:'project_brief_query'},宿主:{project,agent:{session:{id:LEAD.id,header:{cwd:process.cwd()}}}}});assert.equal(result.核心人设保护.hostServicesWrapped,false);assert.equal(result.核心人设保护.shellCoreProtection,false);assert.match(result.核心人设保护.保护范围,/完全权限shell仍可修改/);
 }finally{org.personaProtection?.stop();await org.observability.flush();await f.cleanup();}
});
