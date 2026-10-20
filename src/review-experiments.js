import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {Denied,Fault,InvalidBody} from './kernel/errors.js';
import {appendLines,readJsonlHealth,serializeByKey,withLock,ensureDir} from './kernel/fsx.js';
import {requireLiveActor} from './runtime-actor.js';
import {复核对象引用} from './review-scope.js';
import {EXPERIMENT_RECIPES,normalizeExperimentConfig,experimentDigest,experimentKeys,experimentId,verifyExperimentCandidate,verifyExperimentNode,copyExperimentCandidate,verifyExperimentCopy,experimentEnvironment,removeExperimentScope} from './review-experiment-files.js';
import {executeReviewProcess} from './review-experiment-process.js';

const EVENT='复核实验事件';
const READ_STATES=new Set(['已派发','执行中','已交卷','已打回']);
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const denied=message=>new Denied('冻结实验 · 任务与天然凭据',message,{howToChange:'核对真实派发Lead、复核实例、当前项目/任务代次/读根和部署可信清单；不得用聊天、自报sandbox或任意命令替代。'});
const clockMs=org=>typeof org.clock?.ms==='function'?org.clock.ms():Date.now();
const parentId=agent=>typeof agent.session?.header?.parentSession==='string'?agent.session.header.parentSession:null;
const stamp=m=>({generation:m.代??1,card:m.卡版本?.摘要??null});
const same=(a,b)=>experimentDigest(a)===experimentDigest(b);
const inside=(root,file)=>{const fold=p=>process.platform==='win32'?p.toLowerCase():p;const a=fold(root),b=fold(file);return b===a||b.startsWith(a+path.sep);};
const safeTask=n=>({id:n.id,状态:n.状态,代:n.代??1,负责人:n.负责人,绑定:n.绑定,判据冻结:n.判据冻结,复核对象:复核对象引用(n),复核读根:n.复核读根??[]});
const resultTarget=(id,project)=>({id,kind:'产物',authority:'自治',zone:'私有',project,sandbox:true});

/**
 * 任务内冻结实验服务：不提供通用命令、不创建智能体、不修改被验对象。
 * @param {{org:object,config?:object,services:()=>object}} spec
 * @throws {Denied|InvalidBody} 显式部署配置不合法时拒绝构造，不能退回不受限执行。
 */
export class ReviewExperimentService {
  #org;#config;#services;#closed=false;#active=new Map();
  constructor({org,config={},services=()=>({})}){this.#org=org;this.#config=normalizeExperimentConfig(config);this.#services=services;}
  /** 只描述准入，不把配置启用写成实际后端/enforcement通过。 */
  status(){return {enabled:this.#config.enabled&&!this.#closed,boundary:this.#config.boundary??null,configuration:this.#config.digest??null,recipes:Object.keys(EXPERIMENT_RECIPES),closed:this.#closed,actualEnforcement:'未验'};}
  #ready(){if(this.#closed)throw new Fault('EXPERIMENT_DISPOSED','实验服务已卸载。');if(!this.#config.enabled)throw new Fault('EXPERIMENT_DISABLED',this.#config.reason??'实验服务未配置。');}
  async #actor(spec){
    if(this.#closed)throw new Fault('EXPERIMENT_DISPOSED','实验服务已卸载。');
    const agent=requireLiveActor(spec),identity=await this.#org.registry.identity(),member=identity.members?.[spec.subject.id];
    const role=spec.subject.kind==='Lead'?'Lead':'复核员';
    if(!member||member.status!=='在岗'||member.岗位!==role||!['Lead','成员'].includes(spec.subject.kind))throw denied('执行者不是当前在岗Lead或复核员。');
    const card=await this.#org.registry.cardOf(spec.subject.id);if(card?.就绪!==true)throw denied('执行者钉卡事实不可用。');
    return {agent,identity,member,lead:spec.subject.kind==='Lead'};
  }
  async #reviewTask(spec,taskId,holderId,{running=false}={}){
    const actor=await this.#actor(spec),holder=actor.identity.members?.[holderId];
    if(!holder||holder.status!=='在岗'||holder.岗位!=='复核员'||!holder.委派者?.id||holder.委派者.kind!=='Lead')throw denied('目标不是有可信派发归属的在岗复核实例。');
    const owner=holder.委派者.id,lead=actor.identity.members?.[owner];
    if(!lead||lead.status!=='在岗'||lead.岗位!=='Lead')throw denied('派发Lead在岗事实缺失。');
    if(actor.lead?spec.subject.id!==owner:spec.subject.id!==holderId||parentId(actor.agent)!==owner)throw denied('复核许可不属于当前派发关系。');
    if((await this.#org.registry.cardOf(holderId))?.就绪!==true||!stamp(holder).card||!stamp(lead).card)throw denied('复核实例或派发Lead未钉卡就绪。');
    const health=await readJsonlHealth(this.#org.layout.taskLog(spec.project));if(health.坏行||!health.末行完整)throw new Fault('EXPERIMENT_TASK_LEDGER_INVALID','任务真源损坏，不使用跳行投影授予实验。');
    const node=await this.#org.tasks.get(taskId,{项目:spec.project});
    if(!node||node.模式==='独立会审'||!READ_STATES.has(node.状态)||(running&&node.状态!=='执行中')||node.判据冻结!==true||!Array.isArray(node.判据)||!node.判据.length)throw denied('复核任务不在允许状态或缺冻结判据；运行须先实际开工。');
    if((node.绑定??[]).length!==1||!node.绑定.some(b=>b.实例===holderId&&b.岗位==='复核员')||!(node.负责人??[]).some(v=>v===holderId||v==='复核员'))throw denied('复核任务缺单实例精确同岗绑定。');
    const targets=复核对象引用(node);if(!targets.length||targets.includes(node.id))throw denied('复核任务缺显式被验对象。');
    for(const id of targets)if(!await this.#org.tasks.get(id,{项目:spec.project}))throw denied('被验对象不在本项目。');
    const roots=(node.复核读根??[]).filter(p=>typeof p==='string'&&path.isAbsolute(p));if(!roots.length)throw denied('复核任务缺正式读根。');
    const audit=await this.#org.audit.read({});
    const identityAnchor=id=>audit.filter(r=>r.对象?.kind==='身份'&&r.对象.id===id&&['状态变更','主体创建','迁移补登'].includes(r.动作)).at(-1)?.hash??null;
    const taskAnchor=id=>audit.filter(r=>r.对象?.kind==='任务'&&r.对象.id===id&&r.动作==='状态变更').at(-1)?.hash??null;
    const bindingAnchor=audit.filter(r=>r.对象?.kind==='任务'&&r.对象.id===taskId&&r.动作==='状态变更'&&['bound','reassigned','attached'].includes(r.详情?.事件)).at(-1)?.hash??null;
    const credentialEpoch={holder:identityAnchor(holderId),owner:identityAnchor(owner),binding:bindingAnchor,targets:targets.map(id=>({id,anchor:taskAnchor(id)}))};
    return {...actor,node,holder,owner,ownerMember:lead,roots,targets,credentialEpoch};
  }
  #candidate(id){const candidate=this.#config.candidates?.find(c=>c.id===id);if(!candidate)throw denied('候选未在部署可信清单中。');return candidate;}
  #rootAllowed(ctx,candidate){
    const permitted=ctx.roots.some(root=>{try{return fs.statSync(root).isDirectory()&&inside(fs.realpathSync(root),candidate.root);}catch{return false;}});
    if(!permitted)throw denied('可信候选根没有落在该复核任务的正式读根内。');
  }
  async #directChild(spec,id){
    if(typeof spec.host?.subagents?.listChildren!=='function')throw new Fault('EXPERIMENT_CHILD_CATALOG_UNAVAILABLE','缺宿主直系子目录证明，不能凭登记猜归属。');
    const rows=await spec.host.subagents.listChildren(spec.subject.id,spec.host.signal);
    if(!Array.isArray(rows)||rows.filter(r=>r?.id===id&&r.mode==='continuable').length!==1||rows.filter(r=>r?.id===id).length!==1)throw denied('许可目标不是宿主唯一直接continuable子会话。');
  }
  #limits(args){
    for(const key of ['实验次数','有效秒数','运行秒数','输出上限字节'])if(args[key]!==undefined&&(!Number.isSafeInteger(args[key])||args[key]<1))throw new InvalidBody('实验预算必须为正安全整数：'+key);
    const base=this.#config.limits,limits={maxRuns:args.实验次数??base.maxRuns,ttlMs:args.有效秒数===undefined?base.ttlMs:args.有效秒数*1000,timeoutMs:args.运行秒数===undefined?base.timeoutMs:args.运行秒数*1000,outputBytes:args.输出上限字节??base.outputBytes,closeMs:base.closeMs};
    for(const [key,value]of Object.entries(limits))if(!Number.isSafeInteger(value)||value<1||value>base[key])throw denied('请求实验预算超出部署上限：'+key);return limits;
  }
  #validateArgs(action,args){
    const common=['action','project'];
    if(action==='review_experiment_allow'){
      if(args.决定==='撤回')experimentKeys(args,[...common,'审批引用','决定','许可id']);
      else{experimentKeys(args,[...common,'审批引用','决定','任务','实例','候选id','配方列表','实验次数','有效秒数','运行秒数','输出上限字节']);if(args.决定!=='登记')throw new InvalidBody('实验许可决定只能为登记/撤回。');}
    }else if(action==='review_experiment_run')experimentKeys(args,[...common,'审批引用','许可id','配方']);
    else if(action==='review_experiment_read')experimentKeys(args,[...common,'许可id','运行id','输出流','输出偏移','输出长度']);
    else throw new InvalidBody('未知实验动作。');
  }
  async #ledger(project){
    const data=await readJsonlHealth(this.#org.layout.reviewExperimentLog(project));
    if(data.坏行||!data.末行完整)throw new Fault('EXPERIMENT_LEDGER_INVALID','实验事件流损坏或尾行未完成，不将未知当空许可。');
    const grants=new Map(),runs=new Map();let previous=null;
    const audits=await this.#org.audit.read({}),audited=audits.filter(a=>a.动作===EVENT&&a.项目===project);
    const anchors=new Set(audited.map(a=>a.详情?.事件哈希)),present=new Set(data.rows.map(r=>r.hash));
    if(audited.some(a=>!present.has(a.详情?.事件哈希)))throw new Fault('EXPERIMENT_LEDGER_ROLLBACK','审计仍引用的实验事件已丢失或私有流回卷；不能恢复额度。');
    for(let i=0;i<data.rows.length;i++){
      const row=data.rows[i],{hash,...body}=row;
      if(row.version!==1||row.project!==project||row.seq!==i+1||row.prev!==previous||experimentDigest(body)!==hash)throw new Fault('EXPERIMENT_LEDGER_INVALID','实验事件序/来源/摘要不一致。');previous=hash;
      if(row.type==='granted'){
        if(grants.has(row.permit.id))throw new Fault('EXPERIMENT_LEDGER_INVALID','许可id重复。');grants.set(row.permit.id,{...row.permit,revoked:false,confirmed:anchors.has(hash),runs:[]});
      }else if(row.type==='revoked'){
        const g=grants.get(row.permitId);if(!g)throw new Fault('EXPERIMENT_LEDGER_INVALID','撤回无来源许可。');g.revoked=true;
      }else if(row.type==='reserved'){
        const g=grants.get(row.permitId);if(!g||runs.has(row.run.id))throw new Fault('EXPERIMENT_LEDGER_INVALID','运行占用无来源或重复。');const run={...row.run,permitId:row.permitId,confirmed:anchors.has(hash),receipt:null};g.runs.push(run);runs.set(run.id,run);
      }else if(row.type==='finished'){
        const run=runs.get(row.runId);if(!run||run.receipt)throw new Fault('EXPERIMENT_LEDGER_INVALID','运行收据无来源或重复。');run.receipt={...row.receipt,auditConfirmed:anchors.has(hash)};
      }else throw new Fault('EXPERIMENT_LEDGER_INVALID','未知实验事件类型。');
    }
    return {rows:data.rows,grants,runs};
  }
  async #append(project,subject,event){
    const ledger=await this.#ledger(project),body={version:1,seq:ledger.rows.length+1,prev:ledger.rows.at(-1)?.hash??null,project,at:new Date(clockMs(this.#org)).toISOString(),by:subject.id,...event},hash=experimentDigest(body);
    await appendLines(this.#org.layout.reviewExperimentLog(project),[{...body,hash}]);
    try{await this.#org.audit.append({动作:EVENT,主体:subject,对象:{id:event.permit?.id??event.permitId??event.runId,kind:'产物'},项目:project,依据:'任务内冻结实验天然凭据/只增运行事实；不是复核票',结果:event.type,详情:{事件哈希:hash,事件序:body.seq,许可:event.permit?.id??event.permitId??null,运行:event.run?.id??event.runId??null}});}
    catch{throw new Fault('EXPERIMENT_AUDIT_FAILED_AFTER_EVENT','实验事件已落线但审计未确认；禁止盲重试。',{detail:{已落线:true,可重试:false,事件哈希:hash,许可id:event.permit?.id??event.permitId??null,运行id:event.run?.id??event.runId??null}});}
    return body;
  }
  async #locked(project,fn){const file=this.#org.layout.reviewExperimentLog(project);return serializeByKey(file,()=>withLock(this.#org.layout.reviewExperimentLock(project),fn));}
  async #taskLocked(project,fn){
    const layout=this.#org.layout;
    return serializeByKey(layout.identityFile(),()=>withLock(layout.identityLock(),()=>serializeByKey(layout.taskLog(project),()=>withLock(layout.taskLock(project),fn))));
  }
  #unclosed(run){return !run.confirmed||!run.receipt||run.receipt.auditConfirmed!==true||run.receipt.rangeExited!==true||run.receipt.cleanup?.confirmed!==true;}
  #fence(ledger,holder,task){if([...ledger.runs.values()].some(r=>(r.holder===holder||r.task===task)&&this.#unclosed(r)))throw denied('前次运行占用、收据审计或未收口事实未解决，不能换许可绕预算。');}
  async #lookup(spec,id){
    experimentId(id,'许可id');const actor=await this.#actor(spec),ledger=await this.#ledger(spec.project),grant=ledger.grants.get(id);
    if(!grant||(actor.lead?grant.owner!==spec.subject.id:grant.holder!==spec.subject.id))throw denied('许可不存在或当前实例没有访问权。');return {actor,ledger,grant};
  }
  async #validGrant(spec,grant,{running=false}={}){
    this.#ready();if(!grant.confirmed)throw denied('许可事件审计未确认，不能运行。');
    if(grant.config!==this.#config.digest)throw denied('许可的可信部署配置已变化。');
    if(grant.revoked||clockMs(this.#org)>=grant.expiresAt)throw denied('许可已撤回或过期。');
    const ctx=await this.#reviewTask(spec,grant.task,grant.holder,{running});
    if((ctx.node.代??1)!==grant.generation||!same(stamp(ctx.holder),grant.holderStamp)||!same(stamp(ctx.ownerMember),grant.ownerStamp)||!same(ctx.targets,grant.targets)||!same(ctx.credentialEpoch,grant.credentialEpoch))throw denied('任务/实例/钉卡代次或被验对象已变化，旧许可不能复活。');
    const candidate=this.#candidate(grant.candidate);if(candidate.manifestHash!==grant.manifest)throw denied('候选清单已变化。');this.#rootAllowed(ctx,candidate);
    return {...ctx,candidate};
  }
  async #describe(spec){
    this.#validateArgs(spec.action,spec.args);const args=spec.args;
    if(spec.action==='review_experiment_allow'&&args.决定==='登记'){
      this.#ready();if(spec.subject.kind!=='Lead')throw denied('只有派发Lead能登记实验许可。');
      experimentId(args.候选id,'候选id');const ctx=await this.#reviewTask(spec,String(args.任务??''),String(args.实例??''));await this.#directChild(spec,ctx.holder.id);
      const candidate=this.#candidate(args.候选id);this.#rootAllowed(ctx,candidate);verifyExperimentCandidate(candidate,this.#config.limits);verifyExperimentNode(this.#config.node);
      if(!Array.isArray(args.配方列表)||!args.配方列表.length||args.配方列表.length>5||new Set(args.配方列表).size!==args.配方列表.length||args.配方列表.some(r=>typeof r!=='string'||!Object.hasOwn(EXPERIMENT_RECIPES,r)))throw denied('配方必须来自封闭五项且不得重复。');
      const recipes=[...args.配方列表].sort(),limits=this.#limits(args);const ledger=await this.#ledger(spec.project);this.#fence(ledger,ctx.holder.id,ctx.node.id);
      return {ctx,candidate,recipes,limits,policyAction:'write',target:{id:ctx.node.id,kind:'任务',authority:'自治',zone:'私有',project:spec.project}};
    }
    const found=await this.#lookup(spec,args.许可id);
    if(spec.action==='review_experiment_allow'){
      if(!found.actor.lead)throw denied('只有派发Lead能撤回实验许可。');
      const node=await this.#org.tasks.get(found.grant.task,{项目:spec.project});if(!node)throw denied('许可原任务不存在。');
      return {...found,ctx:{node},policyAction:'write',target:{id:node.id,kind:'任务',authority:'自治',zone:'私有',project:spec.project}};
    }
    if(spec.action==='review_experiment_run'){
      if(found.actor.lead)throw denied('实验由许可持有复核实例独立发起，不接受Lead代跑。');
      const ctx=await this.#validGrant(spec,found.grant,{running:true});
      if(!found.grant.recipes.includes(args.配方))throw denied('配方不在本许可的冻结列表内。');
      if(found.grant.runs.length>=found.grant.limits.maxRuns)throw denied('实验次数预算已耗尽。');this.#fence(found.ledger,found.grant.holder,found.grant.task);
      verifyExperimentCandidate(ctx.candidate,this.#config.limits);verifyExperimentNode(this.#config.node);
      const services=this.#services();if(typeof services?.sandbox?.confine!=='function'||typeof services?.subprocess?.spawn!=='function')throw new Fault('EXPERIMENT_HOST_UNAVAILABLE','缺正式沙箱/进程服务，零进程拒绝。');
      return {...found,ctx,candidate:ctx.candidate,recipes:[args.配方],limits:found.grant.limits,policyAction:'experiment',target:resultTarget(found.grant.id,spec.project)};
    }
    return found;
  }
  /** 只读完整计划；配置/候选/Node摘要和固定argv模板参与原有冻结审批逐字比对。 */
  async plan(spec){
    const d=await this.#describe(spec);if(spec.action==='review_experiment_read')return {步骤:[]};
    const grant=d.grant,nodeFacts=d.candidate?this.#config.node:grant?.nodeSnapshot;
    const preview={凭证代次:d.ctx.credentialEpoch??grant?.credentialEpoch??null,源候选根:d.candidate?.root??grant?.sourceRoot??null,解释器源:nodeFacts?.path??null,决定:spec.args.决定??'运行',任务:d.ctx.node.id,复核实例:grant?.holder??d.ctx.holder.id,许可:grant?.id??null,候选:d.candidate?.id??grant?.candidate,manifest:d.candidate?.manifestHash??grant?.manifest,可信配置:d.candidate?this.#config.digest:grant?.config??null,NodeSHA:nodeFacts?.sha256??null,边界:d.candidate?this.#config.boundary:grant?.boundary??null,
      配方:(d.recipes??grant?.recipes??[]).map(name=>({name,argv:['<本次随机专属副本>/可信Node',...EXPERIMENT_RECIPES[name]]})),预算:d.limits??grant?.limits,输出:'仅本次许可私有有界输出，非通用路径',清理:'仅宿主范围确认退出后清理；未知保留现场'};
    return {步骤:grant?.revoked&&spec.args.决定==='撤回'?[]:[{动作:d.policyAction,目标:d.target,上下文:{task:safeTask(d.ctx.node)},说明:spec.action==='review_experiment_run'?'在专属副本执行冻结实验':spec.args.决定==='撤回'?'撤回本任务实验许可':'登记本任务冻结实验许可',预览:preview}]};
  }
  async #policy(spec,d){await this.#org.policy.check({subject:spec.subject,action:d.policyAction,target:d.target,context:{task:d.ctx.node}});}
  /** Lead登记/撤回天然凭据；不改变角色卡、全局工具白名单或部署授权。 */
  async allow(spec){
    const first=await this.#describe(spec);if(first.grant?.revoked)return this.#summary(first.grant);
    await this.#policy(spec,first);
    return this.#locked(spec.project,()=>this.#taskLocked(spec.project,async()=>{
      const d=await this.#describe(spec);await this.#policy(spec,d);
      if(spec.args.决定==='撤回'){
        try{if(!d.grant.revoked)await this.#append(spec.project,spec.subject,{type:'revoked',permitId:d.grant.id});}
        finally{for(const active of this.#active.values())if(active.permitId===d.grant.id)active.controller.abort(new Error('permit-revoked'));}
        return {...this.#summary(d.grant),撤回:true};
      }
      const permit={id:'rexp-'+randomUUID(),project:spec.project,owner:spec.subject.id,holder:d.ctx.holder.id,task:d.ctx.node.id,generation:d.ctx.node.代??1,holderStamp:stamp(d.ctx.holder),ownerStamp:stamp(d.ctx.ownerMember),targets:d.ctx.targets,credentialEpoch:d.ctx.credentialEpoch,
        candidate:d.candidate.id,manifest:d.candidate.manifestHash,sourceRoot:d.candidate.root,nodeSnapshot:{...this.#config.node},boundary:this.#config.boundary,config:this.#config.digest,recipes:d.recipes,limits:d.limits,expiresAt:clockMs(this.#org)+d.limits.ttlMs};
      await this.#append(spec.project,spec.subject,{type:'granted',permit});return this.#summary({...permit,runs:[],revoked:false,confirmed:true});
    }));
  }
  #summary(g){return {许可id:g.id,任务:g.task,复核实例:g.holder,候选id:g.candidate,manifest:g.manifest,配方列表:g.recipes,预算:g.limits,到期:g.expiresAt,撤回:g.revoked,审计确认:g.confirmed,已占用:g.runs?.length??0};}
  /** 复核实例独立选冻结配方；占用一旦落线绝不自动返还，失败不是许可复活条件。 */
  async run(spec){
    const first=await this.#describe(spec);await this.#policy(spec,first);spec.host?.signal?.throwIfAborted();
    const run=await this.#locked(spec.project,()=>this.#taskLocked(spec.project,async()=>{
      const d=await this.#describe(spec);await this.#policy(spec,d);
      const run={id:'rrun-'+randomUUID(),task:d.grant.task,holder:d.grant.holder,recipe:spec.args.配方,startedAt:clockMs(this.#org)};
      await this.#append(spec.project,spec.subject,{type:'reserved',permitId:d.grant.id,run});return run;
    }));
    const controller=new AbortController(),active={controller,permitId:first.grant.id,runId:run.id,promise:null};this.#active.set(run.id,active);
    const onAbort=()=>controller.abort(spec.host.signal.reason);spec.host?.signal?.addEventListener('abort',onAbort,{once:true});if(spec.host?.signal?.aborted)onAbort();
    const execution=this.#perform(spec,first.grant,run,controller);active.promise=execution;
    try{return await execution;}finally{spec.host?.signal?.removeEventListener('abort',onAbort);this.#active.delete(run.id);}
  }
  async #perform(spec,grant,run,controller){
    let scope=null,process=null,problem=null,cleanup={confirmed:false,retainedRoot:null},originalUnchanged=false,outputs={},invocationStarted=false,provedBeforeSpawn=false,copyResidual=null;
    try{
      const candidate=this.#candidate(grant.candidate);scope=copyExperimentCandidate(candidate,this.#config);
      invocationStarted=true;
      process=await executeReviewProcess({services:this.#services(),scope,argv:[scope.nodePath,...EXPERIMENT_RECIPES[run.recipe]],env:()=>experimentEnvironment(scope),limits:grant.limits,signal:controller.signal,
        withSpawn:launch=>this.#locked(spec.project,()=>this.#taskLocked(spec.project,async()=>{
          const current=await this.#ledger(spec.project),g=current.grants.get(grant.id),reserved=current.runs.get(run.id);
          if(!reserved?.confirmed||!g)throw denied('运行占用审计未确认。');
          const ctx=await this.#validGrant(spec,g,{running:true});await this.#policy(spec,{ctx,policyAction:'experiment',target:resultTarget(grant.id,spec.project)});
          controller.signal.throwIfAborted();verifyExperimentCopy(scope,candidate,this.#config);
          // 身份/任务锁内最后同步重核live对象与工作目录，再调用真正的spawn。
          requireLiveActor(spec);return launch();
        })),
        onTick:async()=>{const live=await this.#ledger(spec.project),p=live.grants.get(grant.id);if(!p)throw denied('许可消失。');await this.#validGrant(spec,p,{running:true});}});
      for(const stream of ['stdout','stderr']){
        const out=process.output[stream],file=this.#org.layout.reviewExperimentOutput(spec.project,run.id,stream);await ensureDir(file);fs.writeFileSync(file,out.bytes,{flag:'wx'});
        outputs[stream]={bytes:out.bytes.length,totalBytes:out.totalBytes,truncated:out.truncated,sha256:sha(out.bytes)};
      }
    }catch(error){
      problem=error?.code??'EXPERIMENT_FAILED';provedBeforeSpawn=error?.detail?.spawnAttempted===false;
      if(problem==='EXPERIMENT_COPY_CLEANUP_FAILED')copyResidual=error.detail?.root??null;
      if(!process||process.running){process=null;if(invocationStarted&&!provedBeforeSpawn)controller.abort(new Error('execution-result-unknown'));}
    }
    try{verifyExperimentCandidate(this.#candidate(grant.candidate),this.#config.limits);originalUnchanged=true;}catch{problem='EXPERIMENT_ORIGINAL_CHANGED';}
    if(scope){
      if(process?.cleanupSafe===true||(!process&&problem&&(!invocationStarted||provedBeforeSpawn)&&problem!=='EXPERIMENT_COPY_CLEANUP_FAILED')){
        // executeReviewProcess抛出只表示它在spawn前硬拒；spawn后的未知必须以非cleanupSafe收据返回。
        try{removeExperimentScope(scope);cleanup={confirmed:true,retainedRoot:null};}catch{cleanup={confirmed:false,retainedRoot:scope.root};problem??='EXPERIMENT_CLEANUP_FAILED';}
      }else cleanup={confirmed:false,retainedRoot:scope.root};
    }else cleanup={confirmed:problem!=='EXPERIMENT_COPY_CLEANUP_FAILED',retainedRoot:copyResidual};
    const launchUnknown=invocationStarted&&!provedBeforeSpawn;
    const rangeExited=process?.rangeExited??!launchUnknown;
    const receipt={status:problem??process?.status??'preparation-failed',exitCode:process?.exitCode??null,signal:process?.signal??null,rangeExited,outputComplete:process?.outputComplete??false,
      enforcement:process?.enforcement??null,wrappedArgv:process?.wrappedArgv??null,denialSignatures:process?.denialSignatures??[],runnerFailureRules:process?.runnerFailureRules??[],processProof:process?.processProof??'未启动或未取得完整宿主结果',providerPrivateTempCleanup:process?.providerPrivateTempCleanup??'未观测',outputs,originalUnchanged,cleanup,needsIntervention:!cleanup.confirmed||rangeExited!==true||!originalUnchanged,finishedAt:clockMs(this.#org)};
    await this.#locked(spec.project,()=>this.#append(spec.project,spec.subject,{type:'finished',permitId:grant.id,runId:run.id,receipt}));
    return {许可id:grant.id,运行id:run.id,状态:receipt.status,退出码:receipt.exitCode,沙箱:receipt.enforcement,输出:outputs,范围已退出:receipt.rangeExited,副本已清理:cleanup.confirmed,原树未变:originalUnchanged,需介入:receipt.needsIntervention,可重试:false,说明:'实验结果不是复核票；进程证明仅限正式宿主受管范围，未知不冒充零残留。'};
  }
  /** 仅许可持有人与派发Lead读取；输出按有界字节分页，不接受文件路径。 */
  async read(spec){
    this.#validateArgs('review_experiment_read',spec.args);const {actor,ledger,grant}=await this.#lookup(spec,spec.args.许可id);
    if(!actor.lead){const ctx=await this.#reviewTask(spec,grant.task,grant.holder);if((ctx.node.代??1)!==grant.generation||!same(stamp(ctx.holder),grant.holderStamp)||ctx.credentialEpoch.holder!==grant.credentialEpoch?.holder||ctx.credentialEpoch.binding!==grant.credentialEpoch?.binding)throw denied('复核读证据的任务/实例代次已失效。');}
    const node=await this.#org.tasks.get(grant.task,{项目:spec.project});await this.#org.policy.check({subject:spec.subject,action:'read',target:resultTarget(grant.id,spec.project),context:{task:node}});
    const summary={...this.#summary(grant),运行:grant.runs.map(r=>({运行id:r.id,配方:r.recipe,审计确认:r.confirmed,收据:r.receipt?{...r.receipt,cleanup:{confirmed:r.receipt.cleanup.confirmed,...(actor.lead?{retainedRoot:r.receipt.cleanup.retainedRoot}:{})}}:null}))};
    if(spec.args.运行id===undefined)return summary;
    experimentId(spec.args.运行id,'运行id');const run=ledger.runs.get(spec.args.运行id);if(!run||run.permitId!==grant.id)throw denied('运行不属于本许可。');
    if(!run.receipt)throw denied('运行尚未产生收据。');
    const stream=spec.args.输出流??'stdout';if(!['stdout','stderr'].includes(stream))throw new InvalidBody('输出流只允许stdout/stderr。');
    const offset=spec.args.输出偏移??0,length=spec.args.输出长度??16384;if(!Number.isSafeInteger(offset)||offset<0||offset>4194304||!Number.isSafeInteger(length)||length<1||length>32768)throw new InvalidBody('输出分页越界。');
    const metadata=run.receipt.outputs[stream];if(!metadata)throw denied('该流没有已归档的原始输出。');
    const file=this.#org.layout.reviewExperimentOutput(spec.project,run.id,stream),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size!==metadata.bytes||stat.size>4194304)throw new Fault('EXPERIMENT_OUTPUT_CHANGED','输出实体/大小不符。');
    const bytes=fs.readFileSync(file);if(sha(bytes)!==metadata.sha256)throw new Fault('EXPERIMENT_OUTPUT_CHANGED','输出原字节SHA不符。');const page=bytes.subarray(offset,offset+length);
    return {许可id:grant.id,运行id:run.id,流:stream,偏移:offset,下一偏移:offset+page.length,文件字节:bytes.length,观察总字节:metadata.totalBytes,源截断:metadata.truncated,SHA256:metadata.sha256,运行审计确认:run.confirmed&&run.receipt.auditConfirmed===true,字节Base64:page.toString('base64'),文本:page.toString('utf8'),说明:'偏移按原字节；跨UTF8边界时以Base64为准。'};
  }
  /** 卸载发出取消并等待本服务正在收尾的调用；未知收口仍留在事件账本，不伪释放预算。 */
  async dispose(){this.#closed=true;for(const value of this.#active.values())value.controller.abort(new Error('service-disposed'));await Promise.allSettled([...this.#active.values()].map(v=>v.promise));}
}
