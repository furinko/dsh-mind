import {test} from 'node:test';
import assert from 'node:assert/strict';
import {PassThrough} from 'node:stream';
import {executeReviewProcess} from '../src/review-experiment-process.js';

function fixture(mode='ok'){
  const calls={confine:[],spawn:[],terminate:0,wait:0};const stdout=new PassThrough(),stderr=new PassThrough();let resolve;const done=new Promise(r=>{resolve=r;});
  const handle={stdout,stderr,done,terminate(){calls.terminate++;if(mode!=='unclosed'){stdout.end();stderr.end();resolve({exitCode:1,signal:null});}},async waitForExit(signal){calls.wait++;if(mode==='unclosed')return false;await done;return !signal?.aborted;}};
  const sandbox={async confine(argv,policy,signal){assert.equal(this,sandbox);assert.ok(signal instanceof AbortSignal);calls.confine.push({argv,policy});if(mode==='no-sandbox')throw Object.assign(Error('missing'),{code:'SANDBOX_UNAVAILABLE'});return {argv:mode==='unwrapped'?argv:['official-runner','--',...argv],enforcement:'partial',denialSignatures:['denied'],runnerFailureRules:[{fatalSignatures:['FATAL-RUNNER']}]};}};
  const subprocess={spawn(spec){assert.equal(this,subprocess);calls.spawn.push(spec);if(mode==='spawn-throw')throw Error('throw before handle');spec.signal.addEventListener('abort',()=>handle.terminate(),{once:true});queueMicrotask(()=>{
   if(mode==='timeout'||mode==='unclosed')return;
   if(mode==='output-limit')stdout.end('x'.repeat(100));else stdout.end(mode==='runner-failure'?'FATAL-RUNNER':'hello');stderr.end();resolve({exitCode:mode==='failed'?2:0,signal:null});
  });return handle;}};
  const spec={services:{sandbox,subprocess},scope:{workspace:'C:/owned-copy/dsh-mind'},argv:['C:/owned-copy/node.exe','test/preflight.mjs'],env:{NODE_OPTIONS:undefined},limits:{timeoutMs:1000,closeMs:50,outputBytes:64}};
  return {calls,spec,handle};
}
test('进程正控：只spawn包装argv，done后另等范围，partial不升级full',async()=>{const f=fixture();const r=await executeReviewProcess(f.spec);assert.equal(r.status,'completed');assert.equal(r.exitCode,0);assert.equal(r.rangeExited,true);assert.equal(r.cleanupSafe,true);assert.equal(r.enforcement,'partial');assert.equal(r.output.stdout.bytes.toString(),'hello');assert.ok(f.calls.wait>=1);assert.deepEqual(f.calls.spawn[0].argv,['official-runner','--',...f.spec.argv]);assert.equal(f.calls.confine[0].policy.workspaceRoot,f.spec.scope.workspace);assert.equal(f.calls.spawn[0].stdio.stdout,'pipe');});
test('缺沙箱提供者或无包装回执均零spawn，不退回原argv',async()=>{for(const mode of ['no-sandbox','unwrapped']){const f=fixture(mode);await assert.rejects(executeReviewProcess(f.spec),e=>['SANDBOX_UNAVAILABLE','EXPERIMENT_SANDBOX_INVALID'].includes(e.code));assert.equal(f.calls.spawn.length,0);}});
test('有界输出：超限终止、记录截断及实收总字节，不声称完整成功',async()=>{const f=fixture('output-limit'),r=await executeReviewProcess(f.spec);assert.equal(r.status,'output-limit');assert.equal(r.output.stdout.truncated,true);assert.equal(r.output.stdout.bytes.length,64);assert.equal(r.output.stdout.totalBytes,100);assert.ok(f.calls.terminate>0);assert.equal(r.cleanupSafe,true);});
test('实际超时：先terminate再等waitForExit，不能用发出kill替代收口',async()=>{const f=fixture('timeout');f.spec.limits.timeoutMs=5;const r=await executeReviewProcess(f.spec);assert.equal(r.status,'timeout');assert.ok(f.calls.terminate>0);assert.ok(f.calls.wait>0);assert.equal(r.cleanupSafe,true);});
test('waitForExit false不是成功：不允许清理工作树',async()=>{const f=fixture('unclosed');f.spec.limits.timeoutMs=5;const r=await executeReviewProcess(f.spec);assert.equal(r.status,'unclosed');assert.equal(r.rangeExited,false);assert.equal(r.cleanupSafe,false);f.handle.stdout.destroy();f.handle.stderr.destroy();});
test('spawn抛错但无handle不能假定零副作用：保留现场',async()=>{const f=fixture('spawn-throw'),r=await executeReviewProcess(f.spec);assert.equal(r.status,'unclosed');assert.equal(r.spawnAttempted,true);assert.equal(r.cleanupSafe,false);f.handle.stdout.destroy();f.handle.stderr.destroy();});
test('正常非零退出与runner故障签名不会冒充通过',async()=>{for(const [mode,status]of [['failed','failed'],['runner-failure','runner-failure']]){const f=fixture(mode),r=await executeReviewProcess(f.spec);assert.equal(r.status,status);assert.equal(r.cleanupSafe,true);}});
test('调用者取消会终止并等待受管范围',async()=>{const f=fixture('timeout'),controller=new AbortController();f.spec.signal=controller.signal;const running=executeReviewProcess(f.spec);queueMicrotask(()=>controller.abort());const r=await running;assert.notEqual(r.status,'completed');assert.ok(!r.spawnAttempted||f.calls.terminate>0);});
