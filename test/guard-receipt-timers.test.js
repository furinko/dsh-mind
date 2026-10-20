import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {apply} from '../components/kernel/lib/index.js';
import {forgetSharedOrg} from '../src/runtime.js';
import {fakeHost} from './host-harness.mjs';
import {captureGuardReceiptTimers} from './guard-receipt-timers.mjs';
const LABEL='dsh-mind: Lead 调度授权';
async function until(read,predicate){const deadline=Date.now()+15000;let last;for(;;){try{last=await read();if(predicate(last))return last;}catch(error){last=error.message;}if(Date.now()>deadline)throw Error('读取证据超时：'+JSON.stringify(last,(_key,value)=>typeof value==='bigint'?String(value):value));await new Promise(resolve=>setTimeout(resolve,20));}}
async function kernelScene(fn,{failCreation=false}={}){
 const home=await mkdtemp(join(tmpdir(),'mind-r06-'));
 const host=fakeHost({提供服务:['tools','commands','systemPrompt']});
 const scheduler=captureGuardReceiptTimers(host.ctx);
 if(failCreation){const guard=host.ctx.tools.guard;let calls=0;host.ctx.tools.guard=callback=>{if(++calls===2)throw Error('真实创建闸注入失败');return guard(callback);};}
 const receipt=join(home,'private','集体L2-共享基础设施','defaults','工具闸回执.json');
 try{await apply(host.ctx,{home,privateRoot:join(home,'private'),factoryRoot:fileURLToPath(new URL('../mind',import.meta.url)),delegation:{mode:'explicit-user'}});
 await fn({home,host,scheduler,receipt,read:async()=>JSON.parse(await readFile(receipt,'utf8'))});
 }finally{scheduler.restore();host.清理();forgetSharedOrg();await rm(home,{recursive:true,force:true,maxRetries:5,retryDelay:60});}
}

test('测试调度器只捕获目标effect中的真实2000ms回调，推进一次且不改全局计时器',()=>{
 const timer=globalThis.setTimeout;const ctx={effect:fn=>fn()};const effect=ctx.effect;const captured=captureGuardReceiptTimers(ctx);let called=0;
 try{ctx.effect(()=>setTimeout(()=>{called++;},2000),LABEL);assert.equal(globalThis.setTimeout,timer);assert.equal(captured.callbacks.length,1);assert.equal(captured.callbacks[0].ms,2000);assert.equal(called,0);captured.fire();assert.equal(called,1);assert.throws(()=>captured.fire(),/只能.*一次/);}finally{captured.restore();}
 assert.equal(ctx.effect,effect);assert.equal(globalThis.setTimeout,timer);
});
test('测试effect抛错时仍恢复原始全局计时器及宿主effect',()=>{
 const timer=globalThis.setTimeout;const ctx={effect:fn=>fn()};const effect=ctx.effect;const captured=captureGuardReceiptTimers(ctx);
 try{assert.throws(()=>ctx.effect(()=>{setTimeout(()=>{},2000);throw Error('injected');},LABEL),/injected/);assert.equal(globalThis.setTimeout,timer);}finally{captured.restore();}
 assert.equal(ctx.effect,effect);
});
test('真实调度创建闸失败保持false：不登记成功确认回调，不能由测试调度器造绿',()=>kernelScene(async({host,scheduler,read})=>{
 const doc=await until(read,x=>x.调度创建闸?.registered===false);assert.equal(doc.范围闸.registered,true);assert.match(doc.调度创建闸.error,/真实创建闸注入失败/);assert.equal(scheduler.callbacks.length,0);assert.equal(host.闸.length,1);
},{failCreation:true}));
test('时序反例：真实确认写已消费后才覆写，不等于仍有待执行的2秒补偿',()=>kernelScene(async({host,scheduler,receipt,read})=>{
 const first=await until(read,x=>x.调度创建闸?.registered===true);assert.equal(host.闸.length,2);assert.equal(scheduler.callbacks.length,1);assert.equal(scheduler.callbacks[0].ms,2000);
 const timeline=[{phase:'首写已提交',guards:host.闸.length,confirmationDelay:scheduler.callbacks[0].ms,pending:1,receipt:first}];
 const before=await stat(receipt,{bigint:true});scheduler.fire();
 await until(()=>stat(receipt,{bigint:true}),s=>s.ino!==before.ino||s.mtimeNs!==before.mtimeNs);
 const confirmed=await read();assert.equal(confirmed.调度创建闸.registered,true,'确认写实际已提交');timeline.push({phase:'确认写已提交',pending:0,receipt:confirmed});
 await writeFile(receipt,JSON.stringify({范围闸:{registered:true,error:null},调度创建闸:{registered:null,error:null}}));
 const overwritten=await read();assert.equal(overwritten.调度创建闸.registered,null);timeline.push({phase:'确认之后才覆写',guards:host.闸.length,pending:0,receipt:overwritten});console.log('R06_TIMELINE '+JSON.stringify(timeline));
 assert.equal(scheduler.callbacks.filter(x=>!x.fired).length,0,'已经没有未来的确认回调，旧测试不能假定它还在2秒窗之前');assert.equal(host.闸.length,2,'本体闸仍真实在位；不能将这个测试后置覆写当作注册失败');
}));
