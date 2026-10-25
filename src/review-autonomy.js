import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {Denied,InvalidBody} from './kernel/errors.js';
import {EXPERIMENT_HARD_LIMITS,EXPERIMENT_RECIPES,experimentDigest,experimentKeys,experimentId,inspectExperimentCandidate,verifyExperimentNode} from './review-experiment-files.js';

export const AUTONOMOUS_EXPERIMENT_BOUNDARY='lead-task-native-policy';
const MODES=['read-only','workspace-write','danger-full-access'];
let runtimeNode;
const nativeNode=()=>{runtimeNode??=Object.freeze(interpreter(process.execPath));return {...runtimeNode};};
const fail=message=>new Denied('任务复核实验 · Lead委派',message,{howToChange:'由实际派发Lead在复核任务正式读根内冻结候选根、命名配方和预算；不需要主权者逐项登记，不得超出当前宿主权限。'});
function interpreter(file){
  if(typeof file!=='string'||!path.isAbsolute(file)||file.includes('\0'))throw new InvalidBody('可执行文件须为当前宿主的绝对路径。');
  const actual=fs.realpathSync(file),st=fs.statSync(actual);
  if(!st.isFile()||st.size>134217728)throw fail('可执行文件不是有界实体文件。');
  const value={path:actual,sha256:createHash('sha256').update(fs.readFileSync(actual)).digest('hex')};verifyExperimentNode(value);return value;
}
/** 内建为任务能力；显式部署停用仍保留，旧部署白名单模式继续兼容。 */
export function autonomousExperimentConfig(raw={}){
  experimentKeys(raw,['enabled','mode','limits'],'自主实验配置');
  if(raw.enabled===false)return Object.freeze({enabled:false,reason:'当前部署已明确停用复核实验。'});
  if(raw.enabled!==undefined&&raw.enabled!==true||raw.mode!==undefined&&raw.mode!=='autonomous')throw new InvalidBody('自主实验配置不合法。');
  const limits={maxRuns:4,ttlMs:3600000,timeoutMs:300000,outputBytes:524288,closeMs:10000,maxFiles:2000,maxFileBytes:16777216,maxPackageBytes:134217728,...raw.limits};
  experimentKeys(limits,Object.keys(EXPERIMENT_HARD_LIMITS),'实验预算');
  for(const [key,value]of Object.entries(limits))if(!Number.isSafeInteger(value)||value<1||value>EXPERIMENT_HARD_LIMITS[key])throw fail('实验预算越界：'+key);
  const normalized={enabled:true,mode:'autonomous',boundary:AUTONOMOUS_EXPERIMENT_BOUNDARY,node:nativeNode(),limits};
  return Object.freeze({...normalized,digest:experimentDigest(normalized)});
}
/** 配方名到固定可执行文件/argv的单一映射；运行者只能选择名字。 */
export function prepareAutonomousCandidate(args,config){
  if(args.候选id!==undefined)throw new InvalidBody('自主实验由Lead提供候选根；不使用部署候选id。');
  if(typeof args.候选根!=='string'||!path.isAbsolute(args.候选根))throw new InvalidBody('Lead登记实验需要绝对候选根。');
  const recipes={};
  if(args.实验配方!==undefined){
    if(args.配方列表!==undefined)throw new InvalidBody('实验配方与旧配方列表不能同时提供。');
    if(!Array.isArray(args.实验配方)||!args.实验配方.length||args.实验配方.length>8)throw new InvalidBody('实验配方需为1至8项。');
    for(const recipe of args.实验配方){
      experimentKeys(recipe,['id','可执行文件','参数'],'实验配方');experimentId(recipe.id,'配方名');
      if(Object.hasOwn(recipes,recipe.id)||['__proto__','constructor','prototype'].includes(recipe.id))throw new InvalidBody('配方名重复或保留。');
      if(!Array.isArray(recipe.参数)||recipe.参数.length>64||recipe.参数.some(s=>typeof s!=='string'||s.length>4096||s.includes('\0'))||recipe.参数.join('').length>16384)throw new InvalidBody('配方参数须为有界字符串数组。');
      recipes[recipe.id]={interpreter:interpreter(recipe.可执行文件??config.node.path),args:[...recipe.参数]};
    }
  }else{
    if(!Array.isArray(args.配方列表)||!args.配方列表.length||new Set(args.配方列表).size!==args.配方列表.length||args.配方列表.some(name=>!Object.hasOwn(EXPERIMENT_RECIPES,name)))throw new InvalidBody('需要Lead命名的实验配方，或兼容的内建配方列表。');
    for(const name of args.配方列表)recipes[name]={interpreter:{...config.node},args:[...EXPERIMENT_RECIPES[name]]};
  }
  const root=fs.realpathSync(args.候选根);
  if(path.resolve(args.候选根)!==root&&process.platform!=='win32')throw fail('候选根包含路径跳转，请使用真实路径。');
  const omit=['.git','.hg','.svn'];
  const candidate={root,omit,...inspectExperimentCandidate(root,config.limits,{omit}),recipes};
  if(!candidate.manifest.length)throw fail('候选根没有可冻结的普通文件。');
  candidate.id='task-'+experimentDigest({root,manifest:candidate.manifestHash,recipes}).slice(0,32);
  return candidate;
}
/** 两个真实会话取权限交集；不写会话事件、不包装服务、不接受模型自报模式。 */
export async function autonomousExperimentPolicy(spec,ctx,services){
  if(typeof services?.sandboxPolicy?.resolve!=='function')throw fail('宿主权限解析服务尚不可用，不能猜测执行权限。');
  const result=[];
  for(const id of [ctx.owner,ctx.holder.id]){
    const agent=spec.host?.agents?.get?.(id);let policy;
    if(agent?.id===id&&agent.session)policy=services.sandboxPolicy.resolve({session:agent.session});
    else{
      if(typeof services.sessionQuery?.observeSession!=='function')throw fail('空闲复核会话缺公开观察租约，不能猜测权限。');
      const lease=await services.sessionQuery.observeSession(id,{projectionMode:'none',signal:spec.host?.signal});
      try{
        if(lease.header?.id!==id||!Number.isSafeInteger(lease.cursor)||lease.cursor< -1||lease.cursor>=100000)throw fail('会话权限历史不可核对或超出观察上限。');
        if(id===ctx.holder.id&&lease.header.parentSession!==ctx.owner)throw fail('空闲会话的真实父子归属已变化。');
        const fallback=services.sandboxPolicy.resolve(),events=lease.events;let override=null;
        if(!Array.isArray(events)||events.length!==lease.cursor+1)throw fail('会话权限历史不完整。');
        for(let seq=0;seq<events.length;seq++){
          const event=events[seq];if(event?.seq!==seq)throw fail('会话权限历史存在缺口。');
          if(event.type==='sandbox/mode'){if(!MODES.includes(event.data?.mode))throw fail('会话权限事件不合法。');override=event.data.mode;}
        }
        policy={mode:override??fallback.mode,workspaceRoot:lease.header.cwd??fallback.workspaceRoot};
      }finally{lease[Symbol.dispose]();}
    }
    if(!policy||!MODES.includes(policy.mode)||typeof policy.workspaceRoot!=='string'||!path.isAbsolute(policy.workspaceRoot))throw fail('宿主权限返回不明。');
    result.push({id,mode:policy.mode,workspaceRoot:policy.workspaceRoot});
  }
  return {mode:MODES[Math.min(...result.map(p=>MODES.indexOf(p.mode)))],sessions:result};
}
/** 返回许可中的精确顶层执行器与argv；旧五配方仅作兼容。 */
export function candidateRecipe(candidate,name,config){return candidate.recipes?.[name]??{interpreter:config.node,args:EXPERIMENT_RECIPES[name]};}
/** 执行前重新核对Lead已冻结的执行器字节。 */
export function verifyAutonomousInterpreters(candidate){for(const recipe of Object.values(candidate.recipes??{}))verifyExperimentNode(recipe.interpreter);}
