/**
 * 仅接管真实内核调度 effect 同步登记的 2000ms 确认回调，不替换注册、回执或落盘实现。
 * 捕获期间同步恢复全局计时器；不靠机器负载猜“50ms 一定早于 2s 回调”。
 * @param {object} ctx 真实 apply 使用的测试宿主。
 * @returns {{callbacks:object[],fire:(index?:number)=>unknown,restore:()=>void}}
 */
export function captureGuardReceiptTimers(ctx) {
  const effect=ctx.effect;
  if(typeof effect!=='function')throw Error('测试宿主缺 effect');
  const callbacks=[];
  ctx.effect=function controlledEffect(fn,label){
    if(label!=='dsh-mind: Lead 调度授权')return effect.call(this,fn,label);
    return effect.call(this,()=>{
      const timer=globalThis.setTimeout;
      globalThis.setTimeout=function controlledTimeout(callback,ms,...args){
        if(ms!==2000)return Reflect.apply(timer,globalThis,[callback,ms,...args]);
        if(typeof callback!=='function')throw Error('确认回调必须可调用');
        const handle={unref(){return handle;}};
        callbacks.push({callback,ms,args,fired:false,handle});return handle;
      };
      try{return fn();}finally{globalThis.setTimeout=timer;}
    },label);
  };
  return {callbacks,fire(index=0){
    const entry=callbacks[index];if(!entry)throw Error('未捕获2000ms确认回调');
    if(entry.fired)throw Error('确认回调只能由测试推进一次');
    entry.fired=true;return Reflect.apply(entry.callback,entry.handle,entry.args);
  },restore(){ctx.effect=effect;}};
}
