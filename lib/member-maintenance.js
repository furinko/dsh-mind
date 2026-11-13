/** 既有委派维护：消息与仅中断分开判据，不授予创建权限。 */
import {randomUUID} from 'node:crypto';
import {isAbsolute} from 'node:path';
import {Denied,Fault,InvalidBody} from '../src/kernel/errors.js';
import {requireLiveActor} from '../src/runtime-actor.js';
import {复核对象引用,复核用途} from '../src/review-scope.js';
import {canonical} from '../src/kernel/text.js';

const ACTIVE_TASKS = new Set(['已派发','执行中','已交卷','已打回']);
const deny = (reason, howToChange = '由真实 Lead 核对当前项目的在岗登记、委派归属、精确任务绑定与宿主直系目录；不得通过创建授权或自报字段代替。') => new Denied('既有委派维护 · 精确归属', reason, {
  howToChange,
});
const signalOf = host => host?.signal instanceof AbortSignal ? host.signal : new AbortController().signal;
const HOST_CODES = new Set(['UNAUTHORIZED','NOT_RESUMABLE','CONTINUATION_UNAVAILABLE','PERSISTENCE_UNAVAILABLE','ACTIVATION_CLOSING','SUBAGENT_CONTROL_QUERY_UNAVAILABLE','SUBAGENT_CONTROL_PROJECTIONS_UNAVAILABLE','ABORT_ERR']);
const hostCode = error => HOST_CODES.has(error?.code) ? error.code : 'UNKNOWN';

function caller({host,subject,project,sessionProject}) {
  if (subject?.kind !== 'Lead') throw deny('仅真实 Lead 可维护已有委派。');
  const agent=requireLiveActor({host,subject,project,sessionProject});
  if (typeof host?.delegation?.authorizeMaintenance !== 'function') throw new Fault('DELEGATION_NOT_WIRED','既有委派维护准入未接线：不会退回新建授权或不判权。');
  host.delegation.authorizeMaintenance({subject,project});
  return agent;
}

async function snapshot(spec) {
  const agent=caller(spec);
  await spec.org.policy.check({subject:spec.subject,action:'read',target:{id:spec.subject.id,kind:'身份',authority:'自治',zone:'私有'},context:{}});
  const identity=await spec.org.registry.identity();
  const parent=identity?.members?.[spec.subject.id];
  if (!parent || parent.status !== '在岗' || parent.岗位 !== 'Lead') throw deny('父会话没有在册在岗的 Lead 凭据。');
  const nodes=await spec.org.tasks.list({项目:spec.project});
  if (!Array.isArray(nodes)) throw new Fault('MEMBER_TASKS_UNAVAILABLE','任务表不可用，不能把未知当没有任务。');
  return {...spec,agent,identity,nodes};
}

function reviewReady(s,n) {
  const targets=复核对象引用(n);
  return targets.length>0 && targets.every(ref=>ref!==n.id && s.nodes.some(x=>x.id===ref))
    && (n.复核读根??[]).some(p=>typeof p==='string' && isAbsolute(p));
}

function reviewRecovery(s,n) {
  const targets=复核对象引用(n);
  if (!targets.length || targets.some(ref=>ref===n.id || !s.nodes.some(x=>x.id===ref))) {
    const recovery=n.状态==='已派发'
      ? `由真实 Lead 用 task_bind(id=${n.id}, 复核对象=<本项目真实被验任务id>) 补齐显式复核对象；不要用依赖代替。`
      : '当前状态不能补绑；由真实 Lead 按 task_close / task_successor 正式恢复复核任务，保留冻结判据，再绑定实例。';
    return deny(`现行任务 ${n.id} 的复核绑定缺少有效的显式复核对象。`,recovery);
  }
  return deny(`现行任务 ${n.id} 的复核绑定尚无绝对路径的复核读根。`,
    `由真实 Lead 用 task_attach(id=${n.id}, 产出物引用=<真实存在的产物文件或目录绝对路径>) 授予必要读根，再用 member_message 联系原实例；成员自报产物不授予读域，不要附私有原始账本。无需重新创建实例或申请创建授权。`);
}

function tasksFor(s,id,explicit) {
  const member=s.identity?.members?.[id];
  if (!member || member.status !== '在岗') throw deny(`实例 ${id} 不在册或不在岗。`);
  if (member.委派者?.id !== s.subject.id || member.委派者?.kind !== 'Lead') throw deny(`实例 ${id} 的委派归属不属于当前 Lead。`);
  const bound=s.nodes.filter(n=>{
    if (!ACTIVE_TASKS.has(n.状态) || n.判据冻结 !== true || !Array.isArray(n.判据) || !n.判据.length || n.模式 === '独立会审') return false;
    if (!(n.绑定??[]).some(b=>b.实例===id && b.岗位===member.岗位)) return false;
    if (!(n.负责人??[]).some(owner=>owner===id || owner===member.岗位)) return false;
    return true;
  });
  const purpose=复核用途({节点:s.nodes,主体:{id,kind:'成员'},项目:s.project,成员:member});
  const reviewing=new Set(purpose.复核任务);
  const tasks=bound.filter(n=>!reviewing.has(n.id)||reviewReady(s,n));
  // 仅诊断已通过本 Lead 归属、当前项目、岗位、冻结判据和负责人检查的任务。
  // 显式指定的任务不能因另一个任务可用而被替代；多任务未点名时不猜恢复哪一单。
  const requested=explicit==null?(bound.length===1?bound[0]:null):bound.find(n=>n.id===explicit);
  if (requested && reviewing.has(requested.id) && !reviewReady(s,requested)) throw reviewRecovery(s,requested);
  if (!tasks.length) throw deny(`实例 ${id} 没有本项目可用的现行任务精确绑定（含冻结判据/岗位/复核读根要求）。`);
  return {member,tasks};
}

async function catalogs(host,agent,signal) {
  let team=[],kids=[];const unavailable=[];
  if (host.agentTeams) {
    try {
      const membership=typeof host.agentTeams.tryMembership==='function' ? host.agentTeams.tryMembership(agent) : undefined;
      if (typeof host.agentTeams.tryMembership==='function' && membership==null) team=[];
      else {
        if (membership && membership.role!=='lead') throw Error('not team lead');
        if (typeof host.agentTeams.listMembers!=='function') throw Error('no team catalog');
        team=host.agentTeams.listMembers(agent);
        if (!Array.isArray(team)) throw Error('bad team catalog');
      }
    } catch {team=[];unavailable.push('Team目录');}
  }
  if (typeof host.subagents?.listChildren==='function') {
    try {kids=await host.subagents.listChildren(agent.session.id,signal);if(!Array.isArray(kids))throw Error('bad child catalog');}
    catch {kids=[];unavailable.push('subagent目录');}
  } else unavailable.push('subagent目录');
  signal.throwIfAborted();
  return {team,kids,unavailable};
}

function routeFor(catalog,id) {
  // Team 归属未知时不能静默转普通服务，否则会绕开 Team 邮箱。
  if (catalog.unavailable.includes('Team目录')) throw new Fault('MEMBER_TEAM_CATALOG_UNAVAILABLE','Team目录不可用，不能盲退普通子会话消息。');
  const teams=catalog.team.filter(r=>r?.id===id);
  if (teams.length>1) throw new Fault('MEMBER_TEAM_CATALOG_CONFLICT','Team名册对同一实例有冲突，拒绝猜测。');
  if (teams.length===1) {
    if (teams[0].role!=='teammate' || typeof teams[0].name!=='string' || !teams[0].name
      || catalog.team.filter(r=>r?.name===teams[0].name).length!==1) throw new Fault('MEMBER_TEAM_CATALOG_CONFLICT','Team名册缺唯一精确成员名或成员身份。');
    return {channel:'team',row:teams[0]};
  }
  if (catalog.unavailable.includes('subagent目录')) throw new Fault('MEMBER_CHILD_CATALOG_UNAVAILABLE','普通子会话目录服务不可用。');
  const children=catalog.kids.filter(r=>r?.id===id);
  if (children.length!==1 || children[0].mode!=='continuable') throw deny('宿主没有唯一直接 continuable 子会话事实；one-shot/unknown/缺目录均不猜通过。');
  return {channel:'subagent',row:children[0]};
}

function selectTask(tasks,explicit) {
  if (explicit !== undefined && explicit !== null) {
    if(typeof explicit!=='string'||!explicit.trim())throw new InvalidBody('任务必须是非空精确任务id。',{missing:['任务']});
    const task=tasks.find(n=>n.id===explicit);if(!task)throw deny('指定任务没有当前实例的现行任务精确绑定。');return task;
  }
  if(tasks.length!==1)throw new InvalidBody('实例绑定多个现行任务；请显式声明 任务=<精确任务id>，不按第一条猜。',{missing:['任务']});
  return tasks[0];
}

/** Stop-only proof can use a closed task or sealed member, never permission to work. */
async function stopProof(s,id,explicit) {
  const member=s.identity.members?.[id];
  if (id===s.subject.id || !member || !['在岗','封存'].includes(member.status)) throw deny('中断目标必须是组织登记过的非自身实例。');
  if (member.委派者?.id!==s.subject.id || member.委派者?.kind!=='Lead') throw deny('中断目标的委派归属不属于当前 Lead。');
  const binding=member.会审绑定;
  if (binding) {
    if (explicit!=null || binding.项目!==s.project || binding.来源会话!==s.subject.id) throw deny('会审中断归属必须是本项目本 Lead，不能冒用任务绑定。');
    const council=await s.org.council.get(s.project,binding.会审);
    if (!council || council.来源会话!==s.subject.id || !(council.参与者?.includes(id)
      || council.创建调用?.some(c=>c.状态==='host_returned'&&c.实例===id&&c.岗位===member.岗位))) throw deny('会审没有确认本次中断目标的实际归属；意图不证明已创建。');
    return {member,council:binding.会审,stamp:canonical({member,binding,source:council.来源会话})};
  }
  const bound=s.nodes.filter(n=>n.判据冻结===true && Array.isArray(n.判据) && n.判据.length && n.模式!=='独立会审'
    && (n.绑定??[]).some(b=>b.实例===id&&b.岗位===member.岗位) && (n.负责人??[]).some(o=>o===id||o===member.岗位));
  if (!bound.length) throw deny('中断目标没有本项目冻结的精确任务绑定；不能只凭名册或目录停止。');
  const task=selectTask(bound,explicit);
  return {member,task,stamp:canonical({member,task:{id:task.id,状态:task.状态,判据:task.判据,负责人:task.负责人,绑定:task.绑定}})};
}

/** Request cancellation only; no reactivation, identity edits, task completion or drain. */
export async function stopExistingMember(spec) {
  const {org,subject,project,host,args}=spec;
  const id=typeof args.实例==='string'?args.实例.trim():'';
  if (!id) throw new InvalidBody('实例必填。',{missing:['实例']});
  const operation=randomUUID(),signal=signalOf(host);let intent=false,started=false,proof,route,call;
  const details=()=>({操作id:operation,父:subject?.id??null,实例:id,任务:proof?.task?.id??null,会审:proof?.council??null,
    通道:route?.channel??null,...(call?{宿主调用:{工具:call.tool,调用id:call.callId}}:{})});
  const record=(result,more={})=>org.audit.append({动作:'成员中断',主体:subject,项目:project,对象:{id,kind:'执行体'},
    依据:'本Lead本项目精确委派与直属目录；仅中断，不授工作或创建权',结果:result,详情:{...details(),...more}});
  const policy=p=>org.policy.check({subject,action:'write',target:{id,kind:'执行体',authority:'自治',zone:'私有'},context:p.task?{task:p.task}:{}});
  try {
    const initial=await snapshot(spec);proof=await stopProof(initial,id,args.任务);
    route=routeFor(await catalogs(host,initial.agent,signal),id);
    // Keep values, not a mutable reference to a Host roster row.
    route={channel:route.channel,row:{id,name:route.row.name??null,mode:route.row.mode??null,role:route.row.role??null}};
    const routeStamp=canonical(route),service=route.channel==='team'?host.agentTeams:host.subagents,interrupt=service?.interrupt;
    if (typeof interrupt!=='function') throw new Fault('MEMBER_STOP_NO_CHANNEL','宿主公共中断接口不可用。');
    const lane=host.hostMaintenance;
    if (route.channel==='team' && typeof lane?.prepare!=='function') throw new Fault('MEMBER_STOP_NO_CHANNEL','Team中断需真实官方interrupt_agent工具管线；不能直调服务或转普通子会话绕过禁用/审批。');
    const recheck=async()=>{
      let now=await snapshot(spec),p=await stopProof(now,id,args.任务);
      await policy(p);
      const r=routeFor(await catalogs(host,now.agent,signal),id);
      const currentRoute={channel:r.channel,row:{id,name:r.row.name??null,mode:r.row.mode??null,role:r.row.role??null}};
      // Re-read organization facts after policy/catalog awaits as well as intent/approval waits.
      now=await snapshot(spec);p=await stopProof(now,id,args.任务);
      if (p.stamp!==proof.stamp || canonical(currentRoute)!==routeStamp || now.agent!==initial.agent
        || service!==(route.channel==='team'?host.agentTeams:host.subagents) || interrupt!==service.interrupt
        || (route.channel==='team' && host.hostMaintenance!==lane)) throw deny('等待期间中断归属、任务、目录或通道改变；旧计划不再可执行。');
      caller(spec);signal.throwIfAborted();
    };
    await policy(proof);
    if (route.channel==='team') call=lane.prepare({mode:'team',target:route.row.name,beforeDispatch:async()=>{await recheck();started=true;}});
    await record('意图');intent=true;
    await recheck();
    if (call) await call.execute();
    else {
      started=true;
      // Public SDK contract: exact live ancestor authority; no human/admin impersonation.
      await interrupt.call(service,id,{kind:'ancestor',agent:initial.agent});
    }
    const receipt={...details(),已请求中断:true,已停:null};
    try {await record('已请求',{已请求中断:true,已停:null});}
    catch {throw new Fault('AUDIT_APPEND_FAILED_AFTER_MEMBER_STOP','中断调用已返回，但回执审计失败；不得重试或声称已停。',{
      detail:receipt,
      outcome:{提交状态:'已提交',可重试:false,恢复指引:'按操作id核对宿主与审计；请求返回不证明目标停止。',已确认阶段:[{阶段:'宿主中断调用已返回',...receipt,已请求:true}]}});}
    return {...receipt,说明:'仅确认本实例当前回合的中断请求返回；未确认停止，不清空inbox、不封存身份、不完成任务，也不重新创建。非驻留目标可能是无操作。'};
  } catch(error) {
    if (error?.code==='AUDIT_APPEND_FAILED_AFTER_MEMBER_STOP') throw error;
    // Once the boundary was entered, a thrown Host object's self-reported
    // outcome is not evidence of no side effect (nor permission for a retry).
    const unknown=started;
    try {await record(unknown?'结果未知':intent?'未请求':'拒绝',{已请求中断:unknown?null:false,已停:null});}catch { /* Preserve refusal; never retry the side effect for logging. */ }
    if (unknown) throw new Fault('MEMBER_STOP_RESULT_UNKNOWN','宿主中断调用失败或结果未知；未自动重试，也不能据此声称仍运行或已停止。',{
      detail:{...details(),宿主错误码:hostCode(error),已请求中断:null,已停:null},
      outcome:{提交状态:'未知',可重试:false,恢复指引:'按操作id及原宿主调用核对目标状态；未知结果不要盲重试。',已确认阶段:[{阶段:'中断尝试已发起',...details(),已停:null}]}});
    throw error;
  }
}

async function audit(org,subject,project,id,result,details) {
  return org.audit.append({动作:'成员消息',主体:subject,对象:{id,kind:'身份'},项目:project,
    依据:'既有委派维护：真实父子/在岗归属/当前项目精确任务绑定；不授予新建权限',结果:result,详情:details});
}

/**
 * 精确维护既有委派；先策略与意图审计，后投递，接收后记账失败不可盲重试。
 * @param {{org:object,subject:object,project:string,sessionProject:string,host:object,args:object}} spec
 * @returns {Promise<object>} inbox 接收凭据，不代表处理或执行完成。
 * @throws {Denied|Fault|InvalidBody} 缺事实、跨域、结果未知或审计失败均响亮返回。
 */
export async function messageExistingMember(spec) {
  const {org,subject,project,host,args}=spec;
  const id=typeof args.实例==='string'?args.实例.trim():'';
  const content=typeof args.内容==='string'?args.内容.trim():'';
  if(!id||!content)throw new InvalidBody('实例和内容必须为非空字符串。',{missing:[!id?'实例':'内容']});
  const operation=randomUUID();let task=null;let route=null;let intent=false;let hostStarted=false;
  try {
    const s=await snapshot(spec);task=selectTask(tasksFor(s,id,args.任务).tasks,args.任务);
    const signal=signalOf(host);const catalog=await catalogs(host,s.agent,signal);route=routeFor(catalog,id);
    const service=route.channel==='team'?host.agentTeams:host.subagents;
    if(typeof service?.sendMessage!=='function')throw new Fault('MEMBER_MESSAGE_NO_CHANNEL','对应宿主消息服务不可用。');
    // 维护准入不是介入度豁免：普通策略仍有最终拒绝与挂起权。
    await org.policy.check({subject,action:'write',target:{id,kind:'消息',authority:'自治',zone:'私有'},context:{task}});
    const details={操作id:operation,父:subject.id,子:id,任务:task.id,通道:route.channel};
    await audit(org,subject,project,id,'意图',details);intent=true;
    // 目录/策略/审计都有等待点，提交前重读，封存或改派不能沿用旧快照。
    const current=await snapshot(spec);const currentTask=selectTask(tasksFor(current,id,task.id).tasks,task.id);
    await org.policy.check({subject,action:'write',target:{id,kind:'消息',authority:'自治',zone:'私有'},context:{task:currentTask}});
    caller(spec);signal.throwIfAborted();
    hostStarted=true;
    const receipt=route.channel==='team'
      ? await service.sendMessage(current.agent,{target:route.row.name,content:[{type:'text',text:content}],signal})
      : await service.sendMessage(current.agent,id,[{type:'text',text:content}],{signal});
    const messageId=typeof receipt==='string'?receipt:receipt?.messageId;
    if(typeof messageId!=='string'||!messageId)throw new Fault('MEMBER_MESSAGE_RECEIPT_UNKNOWN','宿主未给可判的 inbox 接收id；发送状态未知，禁止盲重试。',{
      detail:{已接收:null,可重试:false},
      outcome:{提交状态:'未知',可重试:false,恢复指引:'按操作id核对原子会话的 inbox；没有接收凭据时不要重复发送。',
        已确认阶段:[{阶段:'消息投递已发起',项目:project,实例:id,任务:task.id,操作id:operation,已请求:true}]},
    });
    try {await audit(org,subject,project,id,'已接收',{...details,消息id:messageId});}
    catch {throw new Fault('AUDIT_APPEND_FAILED_AFTER_MEMBER_MESSAGE','消息已被 inbox 接收，但接收审计失败；不要重复发送，先核对消息id。',{
      detail:{...details,消息id:messageId,已接收:true,可重试:false},
      outcome:{提交状态:'已提交',可重试:false,恢复指引:'按消息id核对原子会话的 inbox 并补记接收审计；不要重复发送，也不要把已接收当作已执行。',
        已确认阶段:[{阶段:'inbox已接收',项目:project,实例:id,任务:task.id,操作id:operation,消息id:messageId,已接收:true}]},
    });}
    return {实例:id,任务:task.id,通道:route.channel,...(route.channel==='team'?{名:route.row.name}:{}),消息id:messageId,已接收:true,回执:{messageId},说明:'仅确认 inbox 已接收，不表示已处理、已执行或复核已过。'};
  } catch(error) {
    if(error?.code==='AUDIT_APPEND_FAILED_AFTER_MEMBER_MESSAGE')throw error;
    const details={操作id:operation,父:subject?.id??null,子:id,任务:task?.id??null,通道:route?.channel??null,已发起:hostStarted,宿主错误码:hostStarted?hostCode(error):null};
    // 缺接收凭据只能记未知；准入拒绝也留父子引用，不抄消息正文或宿主异常原文。
    try { await audit(org,subject,project,id,!intent?'拒绝':error?.code==='MEMBER_MESSAGE_RECEIPT_UNKNOWN'?'接收未知':'发送失败',details); }
    catch { /* 不能让附加审计故障覆盖原拒绝，也不自动重发。 */ }
    if(hostStarted && error?.code!=='MEMBER_MESSAGE_RECEIPT_UNKNOWN')throw new Fault('MEMBER_MESSAGE_FAILED','宿主消息投递失败或结果未知；未自动重发，请核对原子会话。',{
      detail:{...details,已接收:null,可重试:false},
      outcome:{提交状态:'未知',可重试:false,恢复指引:'按操作id核对原子会话的 inbox 和宿主状态；投递结果未知时不要重复发送。',
        已确认阶段:[{阶段:'消息投递已发起',项目:project,实例:id,任务:task?.id,操作id:operation,已请求:true}]},
    });
    throw error;
  }
}

/**
 * 当前父/当前项目的任务实例投影；不把宿主目录当组织登记。
 * @param {{org:object,subject:object,project:string,sessionProject:string,host:object}} spec
 * @returns {Promise<object>} 限域名册、未知来源以及目录不可用读数。
 * @throws {Denied|Fault} 主体、授权组件、身份或任务事实不可判时拒绝。
 */
export async function listExistingMembers(spec) {
  const s=await snapshot(spec),signal=signalOf(spec.host);const catalog=await catalogs(spec.host,s.agent,signal);
  const current=await snapshot(spec);const rows=[];
  for(const [id]of Object.entries(current.identity.members??{})) {
    let eligible;try{eligible=tasksFor(current,id);}catch(error){if(error instanceof Denied)continue;throw error;}
    let route=null;try{route=routeFor(catalog,id);}catch(error){if(!(error instanceof Denied)&&!String(error?.code??'').startsWith('MEMBER_'))throw error;}
    const row=route?.row;
    rows.push({实例:id,岗位:eligible.member.岗位,任务:eligible.tasks.map(n=>n.id),来源:route?.channel??null,
      名:typeof (route?.channel==='team'?row?.name:row?.label)==='string'?(route.channel==='team'?row.name:row.label):null,
      状态:typeof row?.status==='string'?row.status:null});
  }
  caller(spec);
  await spec.org.audit.append({动作:'成员列表',主体:spec.subject,对象:{id:spec.subject.id,kind:'身份'},项目:spec.project,
    依据:'既有委派维护的当前项目/精确归属只读投影',结果:'已读',详情:{父:spec.subject.id,实例数:rows.length,任务:[...new Set(rows.flatMap(r=>r.任务))],不可用:catalog.unavailable}});
  return {成员:rows,可用:catalog.unavailable.length===0,不可用:catalog.unavailable,
    说明:'只列本 Lead 在册在岗且当前项目现行任务精确绑定的实例。来源/状态为空表示宿主未证实，不表示死亡、运行中或完成；inactive不等于已完成。'};
}
