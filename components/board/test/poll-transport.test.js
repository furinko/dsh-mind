import test from 'node:test';
import assert from 'node:assert/strict';
import {loadClient,makeCtx,makeSlots,makeSessions,makeStrictRequire,createRenderer,jsonResponse,sampleView,settle,textOf} from './client-harness.mjs';

function scene(fetch, controller = AbortController) {
  const loaded=loadClient({fetch,AbortController:controller});
  const slots=makeSlots();
  const dispose=loaded.definition.factory(makeStrictRequire().require).apply(makeCtx({slots:slots.slots,sessions:makeSessions([{id:'poll-root',main:true}])}));
  const renderer=createRenderer(slots.calls.register.find(x=>x.options.name==='main').Component,{});
  renderer.flush();
  return {loaded,renderer,async flush(){await settle(10);renderer.flush();},async poll(){loaded.timers.intervals[0].fn();await this.flush();},text:()=>textOf(renderer.tree),close(){renderer.unmount();dispose();}};
}
const projection=()=>{const view=sampleView();view.项目清单=null;return view;};
const presence=()=>jsonResponse({成功:true,读数:{失联限制:true,生效响应期限小时:72}});

test('慢投影跨过多个轮询周期时只保留一次工作台读取，其他读面照常刷新',async()=>{
  let release;let reads=0;let presenceReads=0;
  const s=scene(async(path)=>{
    if(path.includes('presence')){presenceReads++;return presence();}
    reads++;if(reads===1)await new Promise(resolve=>{release=resolve;});
    return jsonResponse(projection());
  });
  try{
    await s.flush();await s.poll();await s.poll();await s.poll();
    assert.equal(reads,1);assert.ok(presenceReads>1);
    release();await s.flush();await s.poll();
    assert.equal(reads,2);
    assert.ok(!s.text().includes('超时'));
  }finally{s.close();}
});

test('超时取消仍在排队的读取，下一轮恢复；晚到旧响应不能盖回新投影',async()=>{
  let firstSignal;let release;let reads=0;
  const s=scene(async(path,init)=>{
    if(path.includes('presence'))return presence();
    reads++;
    if(reads===1){firstSignal=init.signal;await new Promise(resolve=>{release=resolve;});const old=projection();old.项目='late-old';return jsonResponse(old);}
    const fresh=projection();fresh.项目='fresh-after-timeout';return jsonResponse(fresh);
  });
  try{
    await s.flush();assert.equal(firstSignal.aborted,false);
    s.loaded.timers.fireTimeouts();await s.flush();
    assert.equal(firstSignal.aborted,true);assert.ok(s.text().includes('超时'));
    await s.poll();assert.equal(reads,2);assert.ok(!s.text().includes('超时'));
    release();await s.flush();
    assert.ok(!s.text().includes('late-old'));
    assert.ok([...s.loaded.store.values()].some(v=>v.includes('fresh-after-timeout')));
  }finally{s.close();}
});

test('读取响应体超时也取消传输，并给出响应体阶段的错误',async()=>{
  let signal;
  const s=scene(async(path,init)=>{
    if(path.includes('presence'))return presence();
    signal=init.signal;
    return {ok:true,status:200,text:()=>new Promise((resolve,reject)=>{signal.addEventListener('abort',()=>reject(new Error('aborted')),{once:true});})};
  });
  try{
    await s.flush();s.loaded.timers.fireTimeouts();await s.flush();
    assert.equal(signal.aborted,true);
    assert.ok(s.text().includes('响应体'));assert.ok(s.text().includes('超时'));
  }finally{s.close();}
});

test('没有AbortController的旧宿主仍能超时退出并在下一轮恢复',async()=>{
  let reads=0;
  const s=scene(async(path)=>path.includes('presence')?presence():++reads===1?new Promise(()=>{}):jsonResponse(projection()),null);
  try{
    await s.flush();s.loaded.timers.fireTimeouts();await s.flush();assert.ok(s.text().includes('超时'));
    await s.poll();assert.equal(reads,2);assert.ok(!s.text().includes('超时'));
  }finally{s.close();}
});
