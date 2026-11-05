import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, symlink, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { createHostFileCeiling } from '../src/host-file-ceiling.js';
import { ToolFileAuthority, canonicalFileTarget } from '../src/tool-file-scope.js';
import { readInstanceSnapshot } from '../src/instance-snapshot.js';
import { TaskGraph } from '../src/tasks.js';
import { fileURLToPath } from 'node:url';

async function setup(config) {
  const f = await makeFixture(), cwd=join(f.home,'work'), outside=join(f.home,'outside');
  await mkdir(cwd);await mkdir(outside);await writeFile(join(cwd,'input.txt'),'input');
  let mode='danger-full-access', workspaceRoot=cwd, available=true;
  const session={id:LEAD.id,header:{id:LEAD.id,cwd}};
  const policy={resolve:({session:actual})=>{assert.equal(actual,session);return {mode,workspaceRoot,sessionId:session.id};}};
  const parent={id:session.id,session,ctx:{get:name=>name==='sandboxPolicy'?policy:undefined}};
  const agents=new Map([[parent.id,parent]]);
  const hostCeiling=createHostFileCeiling({services:()=>available?{agents}:{}});
  f.tasks=new TaskGraph(f);
  const authority=f.tasks.configureToolFiles(config,hostCeiling);
  const P='host-ceiling';
  async function dispatch(range={读:[cwd],写:[cwd]}){
    const n=await f.tasks.create({subject:LEAD,项目:P,描述:'host bounded file task',负责人:['插件工程'],判据:['bounded output']});
    await f.tasks.bind(n.id,{subject:LEAD,项目:P,实例:MEMBER.id,岗位:'插件工程'});
    return f.tasks.dispatch(n.id,{subject:LEAD,项目:P,工具文件范围:range});
  }
  const check=(node,tool='write',path=join(cwd,'new.txt'))=>f.tasks.toolFileAuthority().check({tool,args:{file_path:path},cwd,nodes:[{...node,项目:P}],instance:MEMBER.id,parent:LEAD.id,member:readInstanceSnapshot(f.layout.identityFile()).成员[MEMBER.id]});
  return {f,cwd,outside,parent,agents,policy,authority,hostCeiling,dispatch,check,setMode:v=>mode=v,setRoot:v=>workspaceRoot=v,setAvailable:v=>available=v};
}
describe('可信宿主父权限与Lead任务范围',()=>{
  it('未配置静态表时可冻结Lead选定的范围，不能从cwd扩到兄弟目录',async()=>{
    const s=await setup();try{const n=await s.dispatch();assert.deepEqual(n.工具文件范围.写,[canonicalFileTarget(s.cwd)]);s.check(n);assert.throws(()=>s.check(n,'write',join(s.outside,'no.txt')),/本人真实绑定/);assert.throws(()=>s.authority.grant({读:[s.cwd]},MEMBER),/成员不能给自己/);}finally{await s.f.cleanup();}
  });
  it('父权限改为只读立即拒写，读仍限任务根，恢复权限不扩张冻结范围',async()=>{
    const s=await setup();try{const n=await s.dispatch();s.setMode('read-only');assert.throws(()=>s.check(n),/上限已撤回/);s.check(n,'read',join(s.cwd,'input.txt'));assert.throws(()=>s.authority.grant({写:[s.cwd]},LEAD),/不在真实宿主/);s.setMode('danger-full-access');s.check(n);assert.throws(()=>s.check(n,'read',join(s.outside,'x')),/本人真实绑定/);}finally{await s.f.cleanup();}
  });
  it('workspace-write使用服务返回的现行根，忽略header.cwd与模型自报',async()=>{
    const s=await setup();try{s.setMode('workspace-write');s.parent.session.header.cwd=s.outside;const n=await s.dispatch();assert.throws(()=>s.authority.grant({写:[s.outside]},LEAD),/不在真实宿主/);assert.throws(()=>s.authority.grant({读:[s.cwd],sandbox_permissions:'danger-full-access'},LEAD),/只接受/);s.setRoot(s.outside);assert.throws(()=>s.check(n),/上限已撤回/);s.setRoot(undefined);assert.throws(()=>s.authority.grant({写:[s.cwd]},LEAD),/写根不可判/);}finally{await s.f.cleanup();}
  });
  it('显式空配置仍是拒绝，不被full-access或配置重新应用绕过',async()=>{
    const s=await setup({});try{assert.throws(()=>s.authority.grant({读:[s.cwd]},LEAD),/不在真实宿主/);s.f.tasks.configureToolFiles({read:[s.cwd],write:[s.cwd]});const n=await s.dispatch();s.setMode('read-only');assert.throws(()=>s.check(n),/上限已撤回/);s.f.tasks.configureToolFiles({read:[],write:[]});assert.throws(()=>s.check(n,'read',join(s.cwd,'input.txt')),/上限已撤回/);}finally{await s.f.cleanup();}
  });
  it('缺服务、未知策略、丢父会话、父变子、同id假对象及resolve中换实例都拒',async()=>{
    const s=await setup();try{
      s.setAvailable(false);assert.throws(()=>s.authority.grant({读:[s.cwd]},LEAD),/目录不可用/);s.setAvailable(true);
      s.setMode('unknown');assert.throws(()=>s.authority.grant({读:[s.cwd]},LEAD),/无法识别/);s.setMode('danger-full-access');
      s.agents.delete(LEAD.id);assert.throws(()=>s.authority.grant({读:[s.cwd]},LEAD),/根 Agent/);s.agents.set(LEAD.id,s.parent);
      s.parent.session.header.origin='subagent';assert.throws(()=>s.authority.grant({读:[s.cwd]},LEAD),/根 Agent/);delete s.parent.session.header.origin;
      s.agents.set(LEAD.id,{id:LEAD.id});assert.throws(()=>s.authority.grant({读:[s.cwd]},LEAD),/根 Agent/);s.agents.set(LEAD.id,s.parent);
      s.policy.resolve=()=>{s.agents.set(LEAD.id,{...s.parent});return {mode:'danger-full-access'};};assert.throws(()=>s.authority.grant({读:[s.cwd]},LEAD),/已被替换/);
    }finally{await s.f.cleanup();}
  });
  it('单次审批不参与继承，Promise/其他会话策略不能放行',async()=>{
    const s=await setup();try{
      s.policy.resolve=({session,...args})=>{assert.deepEqual(args,{});return {mode:'read-only',sessionId:session.id};};assert.throws(()=>s.authority.grant({写:[s.cwd]},LEAD),/不在真实宿主/);
      s.policy.resolve=()=>Promise.resolve({mode:'danger-full-access'});assert.throws(()=>s.authority.grant({读:[s.cwd]},LEAD),/异步/);
      s.policy.resolve=()=>({mode:'danger-full-access',sessionId:'not-parent'});assert.throws(()=>s.authority.grant({读:[s.cwd]},LEAD),/无法识别/);
    }finally{await s.f.cleanup();}
  });
  it('full-access不能授权组织双区、父目录或经junction越过workspace-write',async()=>{
    const s=await setup();try{
      for(const root of [s.f.privateRoot,s.f.factoryRoot,s.f.home])assert.throws(()=>s.authority.grant({读:[root]},LEAD),/组织原始文件|私有组织账本/);
      assert.throws(()=>s.authority.grant({写:[fileURLToPath(new URL('../src',import.meta.url))]},LEAD),/不在真实宿主/);
      const link=join(s.cwd,'escape');await symlink(s.outside,link,process.platform==='win32'?'junction':'dir');s.setMode('workspace-write');assert.throws(()=>s.authority.grant({写:[link]},LEAD),/不在真实宿主/);
    }finally{await s.f.cleanup();}
  });
  it('上限收窄不能洗掉重叠的暂停目标限制，交付捕获也复查父权限',async()=>{
    const s=await setup();try{
      const narrow=join(s.cwd,'narrow');await mkdir(narrow);const file=join(narrow,'result.txt');await writeFile(file,'bounded');
      const broad=await s.dispatch(),small=await s.dispatch({读:[narrow],写:[narrow]});
      const goals={constraintsForTask:task=>task.id===broad.id?{目标:'paused-broad',修订:1,状态:'暂停',禁止工具:[]}:null};
      const a=new ToolFileAuthority({layout:s.f.layout,policy:s.f.policy,goals,hostCeiling:s.hostCeiling});
      s.setMode('workspace-write');s.setRoot(narrow);
      const member=readInstanceSnapshot(s.f.layout.identityFile()).成员[MEMBER.id];
      assert.throws(()=>a.check({tool:'write',args:{file_path:file},cwd:s.cwd,nodes:[{...broad,项目:'host-ceiling'},{...small,项目:'host-ceiling'}],instance:MEMBER.id,parent:LEAD.id,member}),/目标.*不允许/);
      assert.equal(a.canCapture(file,{...small,项目:'host-ceiling'},MEMBER),true);
      s.agents.delete(LEAD.id);assert.equal(a.canCapture(file,{...small,项目:'host-ceiling'},MEMBER),false);
    }finally{await s.f.cleanup();}
  });
  it('冻结根被换成junction后不能沿旧任务访问新落点',async()=>{
    const s=await setup();try{
      const n=await s.dispatch(),old=join(s.f.home,'original-work');
      // Both move endpoints are verified fixture children, never live paths.
      assert.equal(s.cwd,join(s.f.home,'work'));assert.equal(old,join(s.f.home,'original-work'));
      assert.equal(canonicalFileTarget(s.cwd),canonicalFileTarget(join(s.f.home,'work')));
      await rename(s.cwd,old);await symlink(s.outside,s.cwd,process.platform==='win32'?'junction':'dir');
      assert.throws(()=>s.check(n,'write',join(s.cwd,'escaped.txt')),/本人真实绑定/);
      assert.throws(()=>s.check(n,'read',join(s.cwd,'escaped.txt')),/本人真实绑定/);
    }finally{await s.f.cleanup();}
  });
  it('无宿主桥且无静态配置的独立服务仍fail-closed',async()=>{
    const s=await setup();try{const a=new ToolFileAuthority({layout:s.f.layout});assert.throws(()=>a.grant({读:[s.cwd]},LEAD),/不在真实宿主/);}finally{await s.f.cleanup();}
  });
});
