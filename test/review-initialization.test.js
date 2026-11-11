import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {ReviewExperimentService} from '../src/review-experiments.js';
import {autonomousExperimentConfig,prepareAutonomousCandidate} from '../src/review-autonomy.js';
import {reviewScene} from './review-experiment-fixture.mjs';

const standaloneNode=process.execPath;
// Mutate only this isolated test process, never a live DSH process; no Electron execution.
async function withHost(execPath,electron,run){
  const original=process.execPath,descriptor=Object.getOwnPropertyDescriptor(process.versions,'electron');
  process.execPath=execPath;
  if(electron)Object.defineProperty(process.versions,'electron',{value:'fixture-electron',configurable:true});
  try{return await run();}finally{
    process.execPath=original;
    if(descriptor)Object.defineProperty(process.versions,'electron',descriptor);else delete process.versions.electron;
  }
}
const args=s=>({决定:'登记',任务:s.task.id,实例:s.reviewer.id,候选根:s.source,实验配方:[{id:'explicit-node',可执行文件:s.node,参数:['test/example.test.js','--fixture']}]});

test('oversized Electron host does not prevent explicit interpreter service initialization',()=>reviewScene(async s=>{
  const large=path.join(s.root,'oversized-electron.bin');fs.writeFileSync(large,'');fs.truncateSync(large,134217729);
  await withHost(large,true,async()=>{
    const service=new ReviewExperimentService({org:s.org,services:()=>s.services});
    try{
      assert.equal(service.status().enabled,true);
      const plan=await service.plan(s.parent('review_experiment_allow',args(s)));
      assert.equal(plan.步骤[0].预览.解释器源,null,'no unused host interpreter presented as frozen');
      assert.equal(plan.步骤[0].预览.配方[0].解释器.path,fs.realpathSync(s.node));
      const grant=await service.allow(s.parent('review_experiment_allow',args(s)));
      assert.deepEqual(grant.配方详情[0].参数,['test/example.test.js','--fixture']);
      const result=await service.run(s.child('review_experiment_run',{许可id:grant.许可id,配方:'explicit-node'}));
      assert.equal(result.状态,'completed');assert.equal(s.calls.spawn.length,1);
      // This fixture counts controlled subprocess calls; it is not OS/model acceptance.
      assert.notEqual(s.calls.spawn[0].argv[0],large);
    }finally{await service.dispose();}
  });
}));

test('explicit actual standalone Node freezes SHA and argv without accessing missing default host',()=>reviewScene(async s=>{
  await withHost(path.join(s.root,'missing-host.exe'),true,async()=>{
    const config=autonomousExperimentConfig();
    const candidate=prepareAutonomousCandidate({候选根:s.source,实验配方:[{id:'node',可执行文件:standaloneNode,参数:['--test']}]},config);
    assert.deepEqual(candidate.recipes.node,{interpreter:{path:fs.realpathSync(standaloneNode),sha256:createHash('sha256').update(fs.readFileSync(standaloneNode)).digest('hex')},args:['--test']});
    assert.equal(s.calls.spawn.length,0);
  });
}));

test('even a small Electron host cannot become implicit Node for named or legacy recipes',()=>reviewScene(async s=>{
  const config=autonomousExperimentConfig();
  await withHost(s.node,true,async()=>{
    for(const recipe of [{实验配方:[{id:'implicit',参数:[]}]},{配方列表:['preflight']}])
      assert.throws(()=>prepareAutonomousCandidate({候选根:s.source,...recipe},config),/独立Node.*可执行文件/);
    assert.equal(s.calls.spawn.length,0);
  });
}));

test('unknown host identity refuses implicit executable without disabling explicit recipes',()=>reviewScene(async s=>{
  const descriptor=Object.getOwnPropertyDescriptor(process,'release');
  Object.defineProperty(process,'release',{value:{name:'unknown'},configurable:true});
  try{
    const config=autonomousExperimentConfig();
    assert.throws(()=>prepareAutonomousCandidate({候选根:s.source,实验配方:[{id:'implicit',参数:[]}]},config),/独立Node.*可执行文件/);
    assert.ok(prepareAutonomousCandidate(args(s),config).recipes['explicit-node']);
  }finally{Object.defineProperty(process,'release',descriptor);}
}));

test('explicit interpreter retains size bound and malformed input rejection',()=>reviewScene(async s=>{
  const config=autonomousExperimentConfig(),large=path.join(s.root,'large.bin');fs.writeFileSync(large,'');fs.truncateSync(large,134217729);
  const prepare=value=>prepareAutonomousCandidate({候选根:s.source,实验配方:[{id:'bad',可执行文件:value,参数:[]}]},config);
  assert.throws(()=>prepare(large),/有界实体/);assert.throws(()=>prepare('node'),/绝对路径/);
  assert.throws(()=>prepare(null),/绝对路径/);
  assert.throws(()=>autonomousExperimentConfig({limits:{maxRuns:9}}),/预算越界/);
  assert.throws(()=>autonomousExperimentConfig({node:{path:s.node}}),/未知字段/);
  assert.equal(autonomousExperimentConfig({enabled:false}).enabled,false);
  assert.equal(s.calls.spawn.length,0);
}));

test('standalone Node still supports implicit named and legacy recipes',()=>reviewScene(async s=>{
  const config=autonomousExperimentConfig();
  for(const recipe of [{实验配方:[{id:'implicit',参数:['--version']}]},{配方列表:['preflight']}]){
    const candidate=prepareAutonomousCandidate({候选根:s.source,...recipe},config);
    const executable=Object.values(candidate.recipes)[0].interpreter;
    assert.equal(executable.path,fs.realpathSync(standaloneNode));assert.match(executable.sha256,/^[a-f0-9]{64}$/);
  }
}));
