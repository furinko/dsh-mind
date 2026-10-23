import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {makeFixture,LEAD,MEMBER} from './helpers.mjs';
import {Org} from '../src/org.js';
import {runAction} from '../lib/actions.js';
import {captureArtifactManifest} from '../src/artifact-manifest.js';

const P='review-artifact-scope',REVIEWER={id:'reviewer',kind:'成员',roleId:'复核员'};
async function scene(fn,{attach=true}={}){
 const f=await makeFixture();try{
  const workspace=join(f.home,'workspace');await mkdir(workspace);
  const file=join(workspace,'delivery.md'),other=join(workspace,'other.md');await writeFile(file,'reviewed content');await writeFile(other,'unrelated');
  const org=await Org.open({home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project:P});
  org.tasks.configureToolFiles({read:[workspace],write:[workspace]});
  const business=await org.tasks.create({subject:LEAD,项目:P,描述:'业务文件',负责人:['插件工程'],判据:['内容可验']});
  await org.tasks.bind(business.id,{subject:LEAD,项目:P,实例:MEMBER.id,岗位:'插件工程'});
  await org.tasks.dispatch(business.id,{subject:LEAD,项目:P,工具文件范围:{读:[workspace],写:[workspace]}});
  await org.tasks.start(business.id,{subject:MEMBER,项目:P});await org.tasks.submit(business.id,{subject:MEMBER,项目:P,产出物引用:[file],结论:'文件交付'});
  const review=await org.tasks.create({subject:LEAD,项目:P,描述:'独立复核报告',负责人:['复核员'],判据:['实际读取并核对'],复核对象:[business.id]});
  await org.tasks.bind(review.id,{subject:LEAD,项目:P,实例:REVIEWER.id,岗位:'复核员'});await org.tasks.dispatch(review.id,{subject:LEAD,项目:P});
  const act=(subject,args)=>runAction({org,项目:P,主体:subject,args});
  const grant=()=>act(LEAD,{action:'task_attach',id:review.id,产出物引用:file});
  if(attach)await grant();await org.tasks.start(review.id,{subject:REVIEWER,项目:P});
  const submit=(refs=[file])=>org.tasks.submit(review.id,{subject:REVIEWER,项目:P,产出物引用:refs,结论:'独立复核报告'});
  const current=()=>org.tasks.get(review.id,{项目:P});
  const capture=async(subject,task,refs=[file])=>captureArtifactManifest(refs,{layout:f.layout,policy:org.policy,fileAuthority:org.tasks.toolFileAuthority(),subject,task});
  await fn({f,org,file,other,workspace,business,review,act,grant,submit,current,capture});
 }finally{await f.cleanup();}
}

test('复核员通过Lead公开读根冻结文件引用，正式出票/采纳仍绑定原内容',()=>scene(async s=>{
 const submitted=await s.submit();assert.equal(submitted.交付物清单.条目[0].类型,'文件树');
 const businessVote=await s.act(REVIEWER,{action:'task_review',id:s.business.id,三态:'过'});
 assert.equal(businessVote.结论.算通过,true);
 const reportVote=await s.act(LEAD,{action:'task_review',id:s.review.id,三态:'过'});
 await writeFile(s.file,'changed after review');
 await assert.rejects(s.act(LEAD,{action:'task_accept',id:s.review.id,票:reportVote.结论.票}),/交付物|内容|清单/);
 await writeFile(s.file,'reviewed content');
 assert.equal((await s.act(LEAD,{action:'task_accept',id:s.review.id,票:reportVote.结论.票})).节点.状态,'已采纳');
 assert.equal((await s.act(LEAD,{action:'task_settle',id:s.review.id,记忆处置:{}})).节点.状态,'已结账');
}));
test('读根补授不补造旧清单，必须原实例重新交卷才可复核',()=>scene(async s=>{
 const old=await s.submit();assert.equal(old.交付物清单.条目[0].类型,'不可验证');assert.ok(!old.交付物清单.条目[0].条目);
 await s.grant();await assert.rejects(s.act(LEAD,{action:'task_review',id:s.review.id,三态:'过'}),/尚不可验证/);
 const fresh=await s.submit();assert.equal(fresh.交付物清单.条目[0].类型,'文件树');assert.notEqual(fresh.交付物清单.摘要,old.交付物清单.摘要);
 assert.equal((await s.act(LEAD,{action:'task_review',id:s.review.id,三态:'过'})).结论.算通过,true);
},{attach:false}));
test('复核读根不自动成为交付物，也不能替相邻未授权文件冻结摘要',()=>scene(async s=>{
 assert.deepEqual((await s.submit([])).交付物清单.条目,[]);
 const denied=await s.submit([s.other]);assert.equal(denied.交付物清单.条目[0].类型,'不可验证');assert.ok(!denied.交付物清单.条目[0].条目);
}));
test('同岗未绑定实例与旧代凭证不能借复核读根读取算摘要',()=>scene(async s=>{
 await s.org.registry.assign({subject:LEAD,岗位:'复核员',实例:'other-reviewer'});
 const denied=await s.capture({id:'other-reviewer',kind:'成员',roleId:'复核员'},await s.current());assert.equal(denied.条目[0].类型,'不可验证');
 const identity=await s.org.registry.identity();identity.members[REVIEWER.id].代++;
 await writeFile(s.f.layout.identityFile(),JSON.stringify(identity));
 assert.equal((await s.capture(REVIEWER,await s.current())).条目[0].类型,'不可验证');
}));
test('普通岗位不能借自报复核读根绕过部署者可授上限',()=>scene(async s=>{
 const task=await s.org.tasks.get(s.business.id,{项目:P});s.org.tasks.configureToolFiles({read:[],write:[]});
 assert.equal((await s.capture(MEMBER,{...task,复核读根:[s.workspace]})).条目[0].类型,'不可验证');
 const own=await s.current();assert.equal((await s.capture(REVIEWER,own)).条目[0].类型,'文件树','复核读根沿已有专门读权，不借普通成员文件上限授写权');
 assert.equal((await s.capture(REVIEWER,{...own,复核读根:[]})).条目[0].类型,'不可验证');
}));
test('复核文件引用仍拒原始组织文件、未冻结任务和坏绑定',()=>scene(async s=>{
 const node=await s.current();
 await assert.rejects(s.capture(REVIEWER,node,[s.f.layout.identityFile()]),/组织双区原始文件/);
 for(const task of [{...node,判据冻结:false},{...node,绑定:[]},{...node,负责人:['插件工程']}])assert.equal((await s.capture(REVIEWER,task)).条目[0].类型,'不可验证');
}));
for(const target of ['reviewer','lead','task'])test(`撤回${target}后复核读根不再授权新清单读取`,()=>scene(async s=>{
 await s.org.registry.revoke({subject:{id:'sovereign',kind:'主权者'},对象id:target==='task'?s.review.id:target,理由:'撤权夹具'});
 assert.equal((await s.capture(REVIEWER,await s.current())).条目[0].类型,'不可验证');
}));
test('审批收紧时复核清单沿原交卷策略停下，不借只读权绕过写准入',()=>scene(async s=>{
 await s.f.write('集体L2-共享基础设施/defaults/介入度.json',JSON.stringify({介入度:'审批'}));await s.org.policy.reload();
 assert.equal((await s.capture(REVIEWER,await s.current())).条目[0].类型,'不可验证');
}));
