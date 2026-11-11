import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {reviewScene,REVIEW_PROJECT} from './review-experiment-fixture.mjs';
import {SOVEREIGN} from './helpers.mjs';
import {runAction,ACTIONS,COMMAND_ONLY_ACTIONS} from '../lib/actions.js';
import {ReviewExperimentService} from '../src/review-experiments.js';

// One controlled deletion failure, AFTER a real scope has been allocated and a
// managed handle has proved exit. Never touches the historical residual root.
async function failed(s){
  // Explicit ownership OBSERVER DOUBLE: not actual Windows SID/ACL acceptance.
  s.services.reviewCleanupOwnership={observe:()=>({version:1,owner:'fixture-only-owner',securityDigest:'a'.repeat(64)})};
  const original=fs.rmSync;let failed=false;
  fs.rmSync=function(file,...args){if(!failed&&s.calls.scopes.includes(file)){failed=true;throw Object.assign(Error('controlled fixture denial'),{code:'EACCES',syscall:'rmdir',path:file});}return original.call(this,file,...args);};
  try{const g=await s.grant(),r=await s.run(g);assert.equal(r.状态,'EXPERIMENT_CLEANUP_FAILED');assert.equal(r.副本已清理,false);return {g,r};}finally{fs.rmSync=original;}
}
const cleanup=(s,g,r,subject=SOVEREIGN,args={})=>s.service.recoverCleanup({subject,project:REVIEW_PROJECT,args:{许可id:g.许可id,运行id:r.运行id,...args}});
test('human-only cleanup appends linked recovery after fresh exit proof, preserves finished receipt and revoked grant',()=>reviewScene(async s=>{
  const {g,r}=await failed(s),file=s.org.layout.reviewExperimentLog(REVIEW_PROJECT),before=fs.readFileSync(file),summary=await s.read(g,{},true);
  assert.equal(summary.运行[0].收据.cleanup.error.code,'EACCES');
  await s.service.allow(s.parent('review_experiment_allow',{决定:'撤回',许可id:g.许可id}));
  await assert.rejects(s.grant(),/未收口/);
  await assert.rejects(cleanup(s,g,r,s.parent('x').subject),/主权者|删除/);
  const waits=s.calls.wait,result=await cleanup(s,g,r);assert.equal(result.副本已清理,true);assert.ok(s.calls.wait>waits);
  const after=fs.readFileSync(file);assert.deepEqual(after.subarray(0,before.length),before);
  const original=(await s.read(g,{},true)).运行[0];assert.equal(original.收据.cleanup.confirmed,false);assert.equal(original.清理恢复.confirmed,true);
  assert.equal(fs.existsSync(s.calls.scopes[0]),false);await s.grant();
  await assert.rejects(s.run(g),/撤回/);await assert.rejects(cleanup(s,g,r),/已收口|恢复/);
}));
test('cleanup command cannot be reached from a model, even with spoofed human fields',()=>reviewScene(async s=>{
  const {g,r}=await failed(s),args={action:'review_experiment_cleanup',许可id:g.许可id,运行id:r.运行id};
  s.parentHost.reviewExperiments=s.service;
  assert.equal(ACTIONS.includes(args.action),false);assert.equal(COMMAND_ONLY_ACTIONS.includes(args.action),true);
  await assert.rejects(runAction({org:s.org,项目:REVIEW_PROJECT,主体:SOVEREIGN,宿主:s.parentHost,args:{...args,role:'主权者'}}),/命令面专属/);
  const result=await runAction({org:s.org,项目:REVIEW_PROJECT,主体:s.parent('x').subject,宿主:s.parentHost,面:'command',args});assert.equal(result.副本已清理,true);assert.equal(result.主体.kind,'主权者');
}));
test('restart/new service cannot adopt old residual; a missing witness never unlocks',()=>reviewScene(async s=>{
  const {g,r}=await failed(s),other=new ReviewExperimentService({org:s.org,config:s.config,services:()=>s.services});
  try{await assert.rejects(other.recoverCleanup({subject:SOVEREIGN,project:REVIEW_PROJECT,args:{许可id:g.许可id,运行id:r.运行id}}),e=>e.code==='EXPERIMENT_CLEANUP_NO_WITNESS');await assert.rejects(s.grant(),/未收口/);}finally{await other.dispose();}
}));
test('deletion without confirmed recovery audit does not unlock or rewrite finished receipt',()=>reviewScene(async s=>{
  const {g,r}=await failed(s),append=s.org.audit.append.bind(s.org.audit);
  s.org.audit.append=async row=>{if(row.动作==='复核实验事件'&&row.结果==='cleanup_recovered')throw Error('controlled audit failure');return append(row);};
  await assert.rejects(cleanup(s,g,r),e=>e.code==='EXPERIMENT_AUDIT_FAILED_AFTER_EVENT');s.org.audit.append=append;
  const view=(await s.read(g,{},true)).运行[0];assert.equal(view.收据.cleanup.confirmed,false);assert.equal(view.清理恢复.confirmed,false);
  await assert.rejects(s.grant(),/未收口/);await assert.rejects(cleanup(s,g,r));
}));
for(const attack of ['unknown-process','replaced-root','link','identity','arbitrary-path','absent-root','changed-file','hardlink','unknown-owner','changed-owner'])test(`cleanup recovery refuses ${attack}`,()=>reviewScene(async s=>{
  const {g,r}=await failed(s),root=s.calls.scopes[0];
  if(attack==='unknown-process')s.setMode('unclosed');
  if(attack==='identity')await s.org.registry.seal({subject:s.parent('x').subject,实例:s.reviewer.id,理由:'no resurrection'});
  if(attack==='changed-file')fs.appendFileSync(path.join(root,'dsh-mind','package.json'),' ');
  if(attack==='hardlink')fs.linkSync(path.join(root,'dsh-mind','package.json'),path.join(root,'extra-link'));
  if(attack==='unknown-owner')s.services.reviewCleanupOwnership.observe=()=>null;
  if(attack==='changed-owner')s.services.reviewCleanupOwnership.observe=()=>({version:1,owner:'replaced-owner',securityDigest:'b'.repeat(64)});
  if(attack==='replaced-root'){fs.renameSync(root,root+'-old');fs.mkdirSync(root);}
  if(attack==='link')fs.symlinkSync(s.source,path.join(root,'foreign-link'),'junction');
  if(attack==='absent-root'){fs.renameSync(root,root+'-old');}
  try{
    await assert.rejects(cleanup(s,g,r,SOVEREIGN,attack==='arbitrary-path'?{root:s.source}:{}));
    assert.equal((await s.read(g,{},true)).运行[0].清理恢复??null,null);
    if(attack==='link')assert.equal(fs.existsSync(s.source),true);
  }finally{
    // Fixtures only: restore exact allocated tree for the scene's cleanup.
    if(attack==='replaced-root'){fs.rmdirSync(root);fs.renameSync(root+'-old',root);}
    if(attack==='absent-root')fs.renameSync(root+'-old',root);
    if(attack==='link')fs.unlinkSync(path.join(root,'foreign-link'));
  }
}));
