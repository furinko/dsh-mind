import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os'; import { join } from 'node:path';
import { createPersonaProtection } from '../components/kernel/lib/persona-protection.js';
async function scene(run) {
 const root=await mkdtemp(join(tmpdir(),'persona-interface-')),workspace=join(root,'workspace'),core=join(root,'private','主权人设','核心人设.md');
 await mkdir(workspace);await mkdir(join(core,'..'),{recursive:true});await writeFile(core,'human maintained');
 const org={layout:{personaCoreFile:()=>core}},sandboxPolicy={resolve:request=>({mode:request?.mode??'danger-full-access',workspaceRoot:request?.root??workspace})};
 const sandbox={confine:(argv,policy)=>({argv,policy,enforcement:'partial'})};const p=createPersonaProtection({org,sandboxPolicy,sandbox});
 try{await run({root,workspace,core,org,sandboxPolicy,sandbox,p});}finally{p.stop();await rm(root,{recursive:true,force:true});}
}
it('Mind文件工具仍拒绝核心、父目录和符号链接别名，普通工作文件与只读工具不受影响',()=>scene(async({root,workspace,core,p})=>{
 const exec=(name,file_path)=>({name,arguments:{file_path},agent:{session:{header:{cwd:workspace}}}});
 assert.ok(p.guard(exec('write',core)));assert.ok(p.guard(exec('edit',join(root,'private'))));
 assert.equal(p.guard(exec('write',join(workspace,'app.js'))),undefined);assert.equal(p.guard(exec('read',core)),undefined);
 await symlink(join(root,'private'),join(workspace,'alias'),process.platform==='win32'?'junction':'dir');assert.ok(p.guard(exec('write',join(workspace,'alias','主权人设','核心人设.md'))));
}));
it('完全权限、工作区写和只读均保持宿主原值，即使工作区包含核心目录也不降级',()=>scene(async({root,core,sandboxPolicy,sandbox,p})=>{
 const resolve=sandboxPolicy.resolve,confine=sandbox.confine;
 for(const mode of ['danger-full-access','workspace-write','read-only']){assert.equal(sandboxPolicy.resolve({mode,root}).mode,mode);assert.equal(sandboxPolicy.resolve({mode,root:core}).mode,mode);}
 assert.equal(p.guard({name:'bash',arguments:{command:'arbitrary user-authorized command'}}),undefined);
 assert.equal(sandboxPolicy.resolve,resolve);assert.equal(sandbox.confine,confine);assert.equal(p.health().hostServicesWrapped,false);
}));
it('缺少宿主沙箱和进程服务不由Mind额外禁止命令，终端资格由宿主管理',()=>scene(async({org})=>{
 const p=createPersonaProtection({org});try{for(const name of ['bash','pwsh','terminal_open','terminal_send','job_start'])assert.equal(p.guard({name,arguments:{}}),undefined);assert.equal(p.health().shellCoreProtection,false);}finally{p.stop();}
}));
it('核心卡未创建时仍约束文件接口，不创建占位目录或卡；全权限命令不被宣称为隔离',()=>scene(async({org,core,workspace})=>{
 await rm(join(core,'..'),{recursive:true});const p=createPersonaProtection({org});
 try{await assert.rejects(stat(join(core,'..')),{code:'ENOENT'});assert.ok(p.guard({name:'write',arguments:{file_path:core},agent:{session:{header:{cwd:workspace}}}}));assert.match(p.health().保护范围,/完全权限shell仍可修改/);assert.deepEqual(p.health().acceptedEnforcement,[]);}finally{p.stop();}
}));
it('停止只关闭Mind自身接口，不重挂或恢复第三方宿主方法',()=>scene(async({org,sandboxPolicy,sandbox,p,core})=>{
 const replacement=()=>({mode:'danger-full-access',workspaceRoot:'/'});sandboxPolicy.resolve=replacement;p.stop();p.stop();
 assert.equal(sandboxPolicy.resolve,replacement);assert.equal(p.health().interfaceGuard,false);assert.ok(p.guard({name:'write',arguments:{file_path:core}}));assert.equal(p.guard({name:'read'}),undefined);
 const next=createPersonaProtection({org,sandboxPolicy,sandbox});next.stop();assert.equal(sandboxPolicy.resolve,replacement);
}));
