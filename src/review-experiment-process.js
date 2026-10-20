import {Fault} from './kernel/errors.js';

const errorCode=e=>typeof e?.code==='string'&&/^[A-Z_]{1,80}$/.test(e.code)?e.code:'HOST_ERROR';
function deadline(promise,ms){let timer;return Promise.race([Promise.resolve(promise),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Fault('EXPERIMENT_CLOSE_TIMEOUT','宿主范围或输出未在收口预算内结束。')),ms);})]).finally(()=>clearTimeout(timer));}
function streamDone(stream){
  if(!stream||stream.readableEnded||stream.destroyed)return Promise.resolve();
  return new Promise(resolve=>{const finish=()=>{stream.off?.('end',finish);stream.off?.('close',finish);stream.off?.('error',finish);resolve();};stream.once('end',finish);stream.once('close',finish);stream.once('error',finish);});
}

/**
 * 只使用正式 confine/spawn/terminate/waitForExit 合同；不使用裸进程回退。
 * @param {{services:object,scope:object,argv:string[],env:object|Function,limits:object,signal?:AbortSignal,onHandle?:Function,onTick?:Function,withSpawn?:Function}} spec
 * @returns {Promise<object>} 输出为有界原字节；仅 cleanupSafe=true 才允许删除实验副本。
 * @throws {Fault} 缺提供者或沙箱包装时零进程拒绝。
 */
export async function executeReviewProcess({services,scope,argv,env,limits,signal,onHandle,onTick,withSpawn}){
  if(typeof services?.sandbox?.confine!=='function'||typeof services?.subprocess?.spawn!=='function')throw new Fault('EXPERIMENT_HOST_UNAVAILABLE','正式sandbox/subprocess服务未接线，不回退裸执行。');
  const controller=new AbortController();let reason=null,handle=null,spawnAttempted=false,confined=null,outcome=null,rangeExited=false,outputComplete=false,hostError=null,interval=null;
  let stopResolve;const stopped=new Promise(resolve=>{stopResolve=resolve;});
  const stop=value=>{if(reason)return;reason=value;controller.abort(new Error(value));try{handle?.terminate?.();}catch{hostError='TERMINATE_FAILED';}stopResolve({stopped:true});};
  const onAbort=()=>stop('cancelled');signal?.addEventListener('abort',onAbort,{once:true});if(signal?.aborted)stop('cancelled');
  const timer=setTimeout(()=>stop('timeout'),limits.timeoutMs);
  const captured={stdout:{chunks:[],total:0,kept:0,truncated:false},stderr:{chunks:[],total:0,kept:0,truncated:false}};let retained=0;
  const listeners=[];
  const collect=(name,stream)=>{
    const data=chunk=>{try{
      const bytes=Buffer.isBuffer(chunk)?chunk:Buffer.from(chunk),state=captured[name];state.total+=bytes.length;
      const take=Math.max(0,Math.min(bytes.length,limits.outputBytes-retained));if(take){state.chunks.push(Buffer.from(bytes.subarray(0,take)));state.kept+=take;retained+=take;}
      if(take<bytes.length){state.truncated=true;stop('output-limit');}
    }catch{hostError='OUTPUT_STREAM_FAILED';stop('output-error');}};
    const error=()=>{hostError='OUTPUT_STREAM_FAILED';stop('output-error');};stream.on('data',data);stream.on('error',error);listeners.push(()=>{stream.off('data',data);stream.off('error',error);});
  };
  try{
    controller.signal.throwIfAborted();
    const attempt=Promise.resolve().then(()=>services.sandbox.confine(argv,{mode:'workspace-write',workspaceRoot:scope.workspace},controller.signal));
    const wrapped=await Promise.race([attempt,stopped]);
    if(wrapped?.stopped)return finish('sandbox-setup-unknown',false);
    confined=wrapped;
    if(!confined||!Array.isArray(confined.argv)||confined.argv.length<=argv.length||!confined.argv.every(v=>typeof v==='string'&&v&&!v.includes('\0'))
      ||confined.argv[confined.argv.length-argv.length-1]!=='--'||confined.argv.slice(-argv.length).some((v,i)=>v!==argv[i])
      ||!['partial','full'].includes(confined.enforcement)||!Array.isArray(confined.denialSignatures)||!Array.isArray(confined.runnerFailureRules)){
      throw new Fault('EXPERIMENT_SANDBOX_INVALID','沙箱未提供真实包装argv及能力元数据；零进程，不回退原argv。');
    }
    controller.signal.throwIfAborted();
    const launch=()=>{
      controller.signal.throwIfAborted();spawnAttempted=true;
      const launchEnv=typeof env==='function'?env():env;
      handle=services.subprocess.spawn({argv:confined.argv,cwd:scope.workspace,env:launchEnv,signal:controller.signal,graceMs:1000,stdio:{stdin:'ignore',stdout:'pipe',stderr:'pipe'}});
      onHandle?.(handle,stop);return handle;
    };
    // 沙箱准备不占组织锁；只有可信域服务可以提供锁内启动回调，模型无此参数。
    if(withSpawn){const ready=await Promise.race([Promise.resolve().then(()=>withSpawn(launch)),stopped]);if(ready?.stopped&&!handle)return finish('launch-setup-unknown',false);}
    else launch();
    if(!handle||!handle.done||typeof handle.terminate!=='function'||typeof handle.waitForExit!=='function'||!handle.stdout?.on||!handle.stderr?.on)throw new Fault('EXPERIMENT_HANDLE_INVALID','宿主未返回完整受管进程/输出合同。');
    const streamsClosed=Promise.all([streamDone(handle.stdout),streamDone(handle.stderr)]);collect('stdout',handle.stdout);collect('stderr',handle.stderr);
    if(onTick){let ticking=false;interval=setInterval(()=>{if(ticking||reason)return;ticking=true;Promise.resolve().then(onTick).catch(()=>stop('authorization-changed')).finally(()=>{ticking=false;});},100);}
    const completion=Promise.resolve(handle.done).then(value=>({outcome:value}),error=>({error:errorCode(error)}));
    const first=await Promise.race([completion,stopped]);
    if(first?.outcome){outcome=first.outcome;}else if(first?.error){hostError=first.error;stop('host-failure');}
    if(reason){try{handle.terminate();}catch{hostError='TERMINATE_FAILED';}}
    const closeController=new AbortController();
    try{
      const exit=Promise.resolve(handle.waitForExit(closeController.signal));
      const observed=reason?await deadline(exit,limits.closeMs):await Promise.race([exit,stopped]);
      if(observed===true)rangeExited=true;
      else if(reason){handle.terminate();rangeExited=(await deadline(handle.waitForExit(closeController.signal),limits.closeMs))===true;}
      if(!rangeExited)hostError??='RANGE_EXIT_UNCONFIRMED';
    }catch(error){hostError=errorCode(error);}finally{closeController.abort();}
    if(rangeExited){
      try{const final=await deadline(completion,limits.closeMs);if(final.outcome)outcome=final.outcome;else hostError??=final.error;await deadline(streamsClosed,limits.closeMs);outputComplete=true;}catch(error){hostError=errorCode(error);}
    }
    if(!rangeExited)return finish('unclosed',false);
    if(!outputComplete)return finish('output-incomplete',true);
    if(!outcome||!Object.hasOwn(outcome,'exitCode')||!(outcome.exitCode===null||Number.isInteger(outcome.exitCode)))return finish('result-unknown',true);
    const rawText=Buffer.concat([...captured.stdout.chunks,...captured.stderr.chunks]).toString('utf8');
    const runnerFailure=(confined.runnerFailureRules??[]).some(rule=>(rule.fatalSignatures??[]).some(s=>typeof s==='string'&&rawText.includes(s)));
    const status=reason??(hostError?'host-failure':runnerFailure?'runner-failure':outcome.exitCode===0&&outcome.signal==null?'completed':'failed');
    return finish(status,true);
  }catch(error){
    hostError=errorCode(error);
    if(!spawnAttempted){
      if(confined===null&&reason)return finish('sandbox-setup-unknown',false);
      if(error?.code==='EXPERIMENT_SANDBOX_INVALID'||!reason)throw new Fault(errorCode(error)==='HOST_ERROR'?'EXPERIMENT_SETUP_FAILED':errorCode(error),'沙箱准备失败，尚未尝试spawn。',{detail:{spawnAttempted:false}});
      return finish(reason,true);
    }
    stop('host-failure');
    if(handle?.terminate&&handle?.waitForExit){try{handle.terminate();rangeExited=(await deadline(handle.waitForExit(),limits.closeMs))===true;}catch{rangeExited=false;}}
    return finish(rangeExited?'host-failure':'unclosed',rangeExited);
  }finally{
    clearTimeout(timer);if(interval)clearInterval(interval);signal?.removeEventListener('abort',onAbort);
    // 没确认退出时只移走本次监听，进程仍归正式宿主托管；收据保留现场，不宣称停净。
    for(const remove of listeners){try{remove();}catch{/* 坏提供者不能覆盖已记录的退出/未知事实。 */}}
  }
  function finish(status,cleanupSafe){
    const output=Object.fromEntries(Object.entries(captured).map(([name,s])=>[name,{bytes:Buffer.concat(s.chunks),totalBytes:s.total,truncated:s.truncated}]));
    return {status,cleanupSafe,rangeExited,outputComplete,spawnAttempted,exitCode:outcome?.exitCode??null,signal:outcome?.signal??null,reason,hostError,
      enforcement:confined?.enforcement??null,wrappedArgv:confined?.argv??null,denialSignatures:confined?.denialSignatures??[],runnerFailureRules:confined?.runnerFailureRules??[],
      processProof:'仅正式宿主waitForExit的受管范围；提供者可能降级，未证明恶意逃逸进程或全机零残留',providerPrivateTempCleanup:'未单独观测',output};
  }
}
