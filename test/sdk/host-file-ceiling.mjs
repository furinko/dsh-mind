// Installed-SDK contract test: real Cordis, AgentRegistry, Session log,
// SessionProjectionRegistry, SandboxPolicyService and SandboxedFileSystem.
// The runtime Agent carrier is a controlled fixture, not an LLM turn or the GUI.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER } from '../helpers.mjs';
import { TaskGraph } from '../../src/tasks.js';
import { readInstanceSnapshot } from '../../src/instance-snapshot.js';
import { createHostFileCeiling } from '../../src/host-file-ceiling.js';
const root=process.env.DSH_SDK_ROOT;
if(!root)throw Error('DSH_SDK_ROOT is required; no substitute service fallback');
const sdk=createRequire(resolve(root,'package.json'));
const load=name=>import(pathToFileURL(sdk.resolve(name)));
const [{Context},{AgentRegistry},{Session},{SessionProjectionRegistry},{SandboxPolicyService,setSandboxMode},{SandboxedFileSystem}]=await Promise.all([
  load('@deepseek-ai/cordis'),load('@deepseek-ai/dsh-agent'),load('@deepseek-ai/dsh-session'),load('@deepseek-ai/dsh-session-projection'),load('@deepseek-ai/dsh-sandbox-policy'),load('@deepseek-ai/dsh-fs-sandbox')]);
test('installed rc.5 actual policy log drives Lead grants, revocation and native FS denial',{timeout:30000},async t=>{
  const f=await makeFixture(),cwd=join(f.home,'work'),outside=join(f.home,'outside');await mkdir(cwd);await mkdir(outside);
  const input=join(cwd,'result.txt');await writeFile(input,'synthetic input');
  const ctx=new Context();let detach;
  t.after(async()=>{detach?.();await ctx.fiber.dispose();await f.cleanup();});
  new SessionProjectionRegistry(ctx);
  const policy=new SandboxPolicyService(ctx,{mode:'danger-full-access',workspaceRoot:cwd});
  const registry=new AgentRegistry(ctx),fs=new SandboxedFileSystem(ctx,{cwd,diffBasisMaxBytes:1048576});
  const session=Session.create(LEAD.id,undefined,{id:LEAD.id,version:4,createdAt:Date.now(),isSeeded:false,cwd});
  const parent={id:session.id,session,ctx,status:'idle'};
  detach=registry.enter(parent,undefined);
  assert.equal(ctx.get('agents').get(LEAD.id),parent);
  const authorityFn=createHostFileCeiling({services:()=>({agents:ctx.get('agents')})});
  const tasks=new TaskGraph(f),authority=tasks.configureToolFiles(undefined,authorityFn);
  const n=await tasks.create({subject:LEAD,项目:'sdk-file-ceiling',描述:'actual sdk policy',负责人:['插件工程'],判据:['scoped access']});
  await tasks.bind(n.id,{subject:LEAD,项目:'sdk-file-ceiling',实例:MEMBER.id,岗位:'插件工程'});
  const dispatched=await tasks.dispatch(n.id,{subject:LEAD,项目:'sdk-file-ceiling',工具文件范围:{读:[cwd],写:[cwd]}});
  const member=readInstanceSnapshot(f.layout.identityFile()).成员[MEMBER.id];
  const check=()=>authority.check({tool:'write',args:{file_path:input},cwd,nodes:[{...dispatched,项目:'sdk-file-ceiling'}],instance:MEMBER.id,parent:LEAD.id,member});
  check();assert.equal(policy.resolve({session}).mode,'danger-full-access');
  setSandboxMode(session,'read-only');
  assert.equal(policy.overrideOf(session),'read-only');assert.throws(check,/上限已撤回/);
  const target=await fs.resolve(input);
  await assert.rejects(()=>fs.checkedTarget(target,policy.resolve({session})),{code:'FS_SANDBOX_DENIED'});
  assert.throws(()=>authority.grant({写:[cwd]},LEAD),/不在真实宿主/);
  setSandboxMode(session,'workspace-write');check();
  assert.throws(()=>authority.grant({写:[outside]},LEAD),/不在真实宿主/);
  await fs.checkedTarget(target,policy.resolve({session}));
  const outsideTarget=await fs.resolve(join(outside,'not-authorized.txt'));
  // SDK also allows OS temp directories. Our bridge intentionally does not
  // delegate that ambient exception. Check a non-temp source path without writing.
  await fs.checkedTarget(outsideTarget,policy.resolve({session}));
  const nonTempTarget=await fs.resolve(resolve('src/host-file-ceiling.js'));
  await assert.rejects(()=>fs.checkedTarget(nonTempTarget,policy.resolve({session})),{code:'FS_SANDBOX_DENIED'});
  setSandboxMode(session,'danger-full-access');check();
  // A sandbox override on a DIFFERENT session cannot widen this parent's grant.
  const other=Session.create('other-session',undefined,{id:'other-session',version:4,createdAt:Date.now(),isSeeded:false,cwd:outside});setSandboxMode(other,'danger-full-access');
  setSandboxMode(session,'read-only');assert.throws(check,/上限已撤回/);
  detach();assert.throws(()=>authority.grant({读:[cwd]},LEAD),/根 Agent/);
  t.diagnostic(JSON.stringify({sdk:JSON.parse(await import('node:fs/promises').then(fs=>fs.readFile(resolve(root,'package.json'),'utf8'))).version,scope:'actual SDK services and Session events; controlled runtime carrier; no LLM/member creation, live profile or GUI',nativeReadOnlyDenial:true,nativeWorkspaceDenial:true,parentRevocation:true,registryRemoval:true}));
});
