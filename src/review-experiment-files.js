import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {canonical} from './kernel/text.js';
import {Denied,Fault,InvalidBody} from './kernel/errors.js';

/** 唯一支持的部署信任边界：可信冻结代码，部分文件写隔离，不保证读/网络隔离。 */
export const EXPERIMENT_BOUNDARY='trusted-code-partial-write';
/** 封闭五配方；工具schema、许可和执行argv均消费此处，不接受模型扩展脚本。 */
export const EXPERIMENT_RECIPES=Object.freeze({
  preflight:Object.freeze(['test/preflight.mjs']),
  'root-tests':Object.freeze(['--test','test/*.test.js']),
  'board-tests':Object.freeze(['--test','components/board/test/*.test.js']),
  'client-harness':Object.freeze(['components/board/test/client-harness.mjs']),
  'install-selftest':Object.freeze(['scripts/verify-profile-install.mjs','--selftest']),
});
/** 部署预算不得超过的硬上限；上调需要新工程版本，模型参数不能修改。 */
export const EXPERIMENT_HARD_LIMITS=Object.freeze({maxRuns:8,ttlMs:86400000,timeoutMs:600000,outputBytes:4194304,closeMs:15000,maxFiles:2000,maxFileBytes:16777216,maxPackageBytes:134217728});
const HASH=/^[a-f0-9]{64}$/;
const folded=p=>process.platform==='win32'?p.toLowerCase():p;
const comparePath=(a,b)=>a.path<b.path?-1:a.path>b.path?1:0;
const freeze=value=>{if(value&&typeof value==='object'){for(const entry of Object.values(value))freeze(entry);Object.freeze(value);}return value;};
const fail=reason=>new Denied('冻结实验 · 文件与可信清单',reason,{howToChange:'只能使用部署者已审读并固定SHA的实体候选；不要通过参数提供路径或修补清单。'});

/** 固定配置/清单指纹；不把对象键序差异解释成另一个许可。 */
export function experimentDigest(value){return createHash('sha256').update(canonical(value)).digest('hex');}
/** 严格拒额外入参，不能把未来字段暗当作执行透传。 */
export function experimentKeys(value,allowed,label='参数'){
  if(!value||typeof value!=='object'||Array.isArray(value))throw new InvalidBody(label+'须为对象。');
  const extra=Object.keys(value).filter(k=>!allowed.includes(k));if(extra.length)throw new InvalidBody(label+'含未知字段：'+extra.join('、'));
}
/** 私有随机标识也只能是单个安全路径片段。 */
export function experimentId(value,label='id'){
  if(typeof value!=='string'||!value||value.length>100||!/^[-a-zA-Z0-9_]+$/.test(value))throw new InvalidBody(label+'不是合法精确标识。');return value;
}
function safeRelative(value){
  if(typeof value!=='string'||value.length>300||value.includes('\\')||/[:*?\[\]\x00-\x1f]/.test(value)||path.posix.isAbsolute(value))throw fail('候选清单路径不合法。');
  const parts=value.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^\.dsh-review-/i.test(p)||/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p)))throw fail('候选清单含路径穿越/保留路径。');
  return value;
}
function physicalRoot(root){
  if(typeof root!=='string'||!path.isAbsolute(root))throw fail('可信候选根必须为绝对路径。');
  const actual=fs.realpathSync(root);
  if(folded(path.resolve(root))!==folded(actual)||!fs.lstatSync(root).isDirectory())throw fail('候选根或父链发生重解析/别名跳转。');return actual;
}
function filesAt(root,limits,serviceCopy=false){
  const rows=[];let bytes=0;
  function walk(dir,relative=''){
    for(const entry of fs.readdirSync(dir,{withFileTypes:true})){
      if(serviceCopy&&!relative&&[process.platform==='win32'?'.dsh-review-node.exe':'.dsh-review-node','.dsh-review-tmp'].includes(entry.name))continue;
      const rel=safeRelative(relative?relative+'/'+entry.name:entry.name),full=path.join(dir,entry.name),st=fs.lstatSync(full);
      if(st.isSymbolicLink()||folded(fs.realpathSync(full))!==folded(path.resolve(full)))throw fail('拒绝符号链接/重解析穿越。');
      if(st.isDirectory()){walk(full,rel);continue;}
      if(!st.isFile()||st.nlink!==1)throw fail('拒绝非实体文件或硬链接复用。');
      bytes+=st.size;if(st.size>limits.maxFileBytes||bytes>limits.maxPackageBytes||rows.length>=limits.maxFiles)throw fail('候选文件数量或体积超预算。');
      const fd=fs.openSync(full,'r');let data;
      try{const opened=fs.fstatSync(fd);if(!opened.isFile()||opened.ino!==st.ino||opened.dev!==st.dev||opened.nlink!==1)throw fail('文件在核对期间被替换。');data=fs.readFileSync(fd);const tail=fs.fstatSync(fd);if(tail.size!==st.size||tail.mtimeMs!==st.mtimeMs||tail.nlink!==1)throw fail('文件在核对期间变化。');}finally{fs.closeSync(fd);}
      rows.push({path:rel,sha256:createHash('sha256').update(data).digest('hex'),bytes:data.length});
    }
  }
  walk(root);return rows.sort(comparePath);
}
/** 可信配置只来自宿主部署；缺省禁用，模型不能用参数自报已经审读。 */
export function normalizeExperimentConfig(raw={}){
  experimentKeys(raw,['enabled','boundary','node','candidates','limits'],'实验部署配置');
  if(raw.enabled!==true)return Object.freeze({enabled:false,reason:'实验代理未由部署配置启用。'});
  if(raw.boundary!==EXPERIMENT_BOUNDARY)throw fail('未明确接受可信代码/部分文件写隔离边界。');
  experimentKeys(raw.node,['path','sha256'],'可信Node');if(!path.isAbsolute(raw.node.path??'')||!HASH.test(raw.node.sha256??''))throw fail('缺可信Node绝对路径/二进制SHA。');
  const limits={maxRuns:2,ttlMs:3600000,timeoutMs:300000,outputBytes:524288,closeMs:10000,maxFiles:2000,maxFileBytes:16777216,maxPackageBytes:134217728,...raw.limits};
  experimentKeys(limits,Object.keys(EXPERIMENT_HARD_LIMITS),'部署预算');
  for(const [key,value]of Object.entries(limits))if(!Number.isSafeInteger(value)||value<1||value>EXPERIMENT_HARD_LIMITS[key])throw fail('实验部署预算越界：'+key);
  if(!Array.isArray(raw.candidates)||raw.candidates.length<1||raw.candidates.length>16)throw fail('缺可信候选清单。');
  const candidates=[];const ids=new Set();
  for(const c of raw.candidates){
    experimentKeys(c,['id','root','manifest','manifestHash','reviewed'],'可信候选');experimentId(c.id,'候选id');
    if(ids.has(c.id)||c.reviewed!==true||!Array.isArray(c.manifest)||!c.manifest.length||c.manifest.length>limits.maxFiles)throw fail('候选未审读/重复或清单形状不合法。');ids.add(c.id);
    const keys=new Set();let total=0;
    const manifest=c.manifest.map(r=>{experimentKeys(r,['path','sha256','bytes'],'清单条目');safeRelative(r.path);const key=r.path.toLowerCase();if(keys.has(key)||!HASH.test(r.sha256??'')||!Number.isSafeInteger(r.bytes)||r.bytes<0||r.bytes>limits.maxFileBytes)throw fail('清单大小写碰撞/摘要或体积不合法。');keys.add(key);total+=r.bytes;return {...r};}).sort(comparePath);
    if(total>limits.maxPackageBytes||experimentDigest(manifest)!==c.manifestHash)throw fail('候选完整清单摘要不符。');
    candidates.push({id:c.id,root:physicalRoot(c.root),manifest,manifestHash:c.manifestHash});
  }
  const normalized={enabled:true,boundary:raw.boundary,node:{...raw.node,path:fs.realpathSync(raw.node.path)},limits,candidates};
  const digest=experimentDigest(normalized);return freeze(JSON.parse(JSON.stringify({...normalized,digest})));
}
/** 只读生成清单，不代表已审读或已获得任何执行许可。 */
export function inspectExperimentCandidate(root,limits=EXPERIMENT_HARD_LIMITS){const manifest=filesAt(physicalRoot(root),limits);return {manifest,manifestHash:experimentDigest(manifest)};}
/** 执行前复核副本（服务专属Node和空临时目录单独验证），不凭复制已完成自述。 */
export function verifyExperimentCopy(scope,candidate,config){
  const st=fs.lstatSync(scope.nodePath);
  if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1||folded(fs.realpathSync(scope.nodePath))!==folded(path.resolve(scope.nodePath)))throw fail('副本解释器被替换或链接复用。');
  verifyExperimentNode({...config.node,path:scope.nodePath});
  if(!fs.lstatSync(scope.temp).isDirectory()||fs.lstatSync(scope.temp).isSymbolicLink()||folded(fs.realpathSync(scope.temp))!==folded(path.resolve(scope.temp))||fs.readdirSync(scope.temp).length)throw fail('副本临时目录不为空或发生重解析。');
  const actual=filesAt(physicalRoot(scope.workspace),config.limits,true);if(experimentDigest(actual)!==candidate.manifestHash)throw fail('副本manifest变化。');
}
/** 运行前及运行后都核原树，目录集合、实体类型及每个字节均在清单内。 */
export function verifyExperimentCandidate(candidate,limits){
  const actual=filesAt(physicalRoot(candidate.root),limits);
  if(experimentDigest(actual)!==candidate.manifestHash)throw fail('原候选manifest变化或出现额外/缺失文件。');return actual;
}
/** 校验 Node 实体及字节，不接受 PATH 解析、环境预加载或模型指定的解释器。 */
export function verifyExperimentNode(node){
  const full=fs.realpathSync(node.path),st=fs.lstatSync(full);
  if(!st.isFile()||st.size>134217728||createHash('sha256').update(fs.readFileSync(full)).digest('hex')!==node.sha256)throw fail('可信Node二进制不符。');return full;
}
/** 只新建随机专属树并复制实体文件，复制后再次核摘要；不执行候选代码。 */
export function copyExperimentCandidate(candidate,config){
  verifyExperimentCandidate(candidate,config.limits);const executable=verifyExperimentNode(config.node);
  const root=fs.mkdtempSync(path.join(tmpdir(),'mind-review-run-')),workspace=path.join(root,'dsh-mind');
  try{
    fs.mkdirSync(workspace);
    for(const row of candidate.manifest){const dest=path.join(workspace,row.path);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(candidate.root,row.path),dest,fs.constants.COPYFILE_EXCL);}
    const copy={...candidate,root:workspace};verifyExperimentCandidate(copy,config.limits);
    const nodePath=path.join(workspace,process.platform==='win32'?'.dsh-review-node.exe':'.dsh-review-node');fs.copyFileSync(executable,nodePath,fs.constants.COPYFILE_EXCL);if(process.platform!=='win32')fs.chmodSync(nodePath,0o500);verifyExperimentNode({...config.node,path:nodePath});
    const temp=path.join(workspace,'.dsh-review-tmp');fs.mkdirSync(temp);
    return {root,workspace,temp,nodePath};
  }catch(error){try{removeExperimentScope({root,workspace});}catch(cleanup){throw new Fault('EXPERIMENT_COPY_CLEANUP_FAILED','副本准备失败且清理未完成。',{detail:{root,originalCode:error.code??'UNKNOWN'}});}throw error;}
}
/** 清空环境注入（含 Windows 大小写别名），只显式恢复必要系统路径与本次临时目录。 */
export function experimentEnvironment(scope){
  const env=Object.fromEntries(Object.keys(process.env).map(k=>[k,undefined]));
  for(const key of ['SystemRoot','WINDIR','ComSpec']){const found=Object.keys(process.env).find(k=>k.toUpperCase()===key.toUpperCase());if(found)env[key]=process.env[found];}
  return {...env,TEMP:scope.temp,TMP:scope.temp,TMPDIR:scope.temp,HOME:scope.workspace,USERPROFILE:scope.workspace,PATH:path.dirname(scope.nodePath),NODE_OPTIONS:undefined,NODE_PATH:undefined};
}
/** 删除前核绝对真实路径与专属命名前缀；只能删除本服务随机生成的实验根。 */
export function removeExperimentScope(scope){
  if(!scope?.root||!path.isAbsolute(scope.root))throw fail('拒绝不明清理路径。');
  const base=fs.realpathSync(tmpdir()),root=fs.realpathSync(scope.root);
  if(folded(root)!==folded(path.resolve(scope.root))||folded(path.dirname(root))!==folded(base)||!/^mind-review-run-[-a-zA-Z0-9]+$/.test(path.basename(root))||fs.lstatSync(root).isSymbolicLink())throw fail('清理根不属于已验证的专属实验目录。');
  fs.rmSync(root,{recursive:true,force:false,maxRetries:3,retryDelay:50});if(fs.existsSync(root))throw new Fault('EXPERIMENT_CLEANUP_FAILED','实验副本仍有残留。');
}
