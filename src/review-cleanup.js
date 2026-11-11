/** No path-taking maintenance API: these observations stay inside the service. */
import fs from 'node:fs';
import path from 'node:path';
import {tmpdir} from 'node:os';
import {createHash} from 'node:crypto';
import {canonical} from './kernel/text.js';
import {Fault} from './kernel/errors.js';

const fold=p=>process.platform==='win32'?p.toLowerCase():p;
const fail=()=>new Fault('EXPERIMENT_CLEANUP_UNSAFE','清理归属、实体身份或目录内容变化；拒绝恢复，保留原收据。');
function identity(file){
  const st=fs.lstatSync(file,{bigint:true});
  if(st.isSymbolicLink()||fold(fs.realpathSync(file))!==fold(path.resolve(file)))throw fail();
  return {dev:String(st.dev),ino:String(st.ino),birthtime:String(st.birthtimeNs),uid:String(st.uid),gid:String(st.gid),type:st.isDirectory()?'directory':st.isFile()?'file':'unknown',...(st.isFile()?{nlink:Number(st.nlink)}:{})};
}
export function cleanupAnchor(scope){
  const root=path.resolve(scope.root),base=fs.realpathSync(tmpdir());
  if(fold(path.dirname(root))!==fold(base)||!/^mind-review-run-[-a-zA-Z0-9]+$/.test(path.basename(root)))throw fail();
  const result={root,base,identity:identity(root),parent:identity(base)};
  if(result.identity.type!=='directory')throw fail();return result;
}
export function observeCleanupTree(anchor){
  if(canonical(cleanupAnchor({root:anchor.root}))!==canonical(anchor))throw fail();
  const rows=[];let total=0;
  function walk(file,relative=''){
    if(rows.length>=20000)throw fail();
    const id=identity(file);if(id.type==='unknown'||id.type==='file'&&id.nlink!==1)throw fail();
    if(id.type==='directory'){
      rows.push({path:relative,...id});for(const name of fs.readdirSync(file).sort())walk(path.join(file,name),relative?relative+'/'+name:name);
    }else{
      const stat=fs.statSync(file);total+=stat.size;if(total>536870912)throw fail();
      const fd=fs.openSync(file,'r');try{
        const before=fs.fstatSync(fd,{bigint:true});if(String(before.ino)!==id.ino||String(before.dev)!==id.dev||before.nlink!==1n)throw fail();
        const hash=createHash('sha256');const buffer=Buffer.alloc(65536);let n;
        while((n=fs.readSync(fd,buffer,0,buffer.length,null)))hash.update(buffer.subarray(0,n));
        const after=fs.fstatSync(fd,{bigint:true});if(before.size!==after.size||before.mtimeNs!==after.mtimeNs||canonical(identity(file))!==canonical(id))throw fail();
        rows.push({path:relative,...id,bytes:Number(after.size),sha256:hash.digest('hex')});
      }finally{fs.closeSync(fd);}
    }
  }
  walk(anchor.root);return createHash('sha256').update(canonical(rows)).digest('hex');
}
export function cleanupError(error,scope){
  const rel=typeof error?.path==='string'?path.relative(scope.root,error.path):null;
  return {code:typeof error?.code==='string'&&/^[A-Z_0-9]{1,80}$/.test(error.code)?error.code:'UNKNOWN',syscall:typeof error?.syscall==='string'?error.syscall.slice(0,40):null,relativePath:rel!==null&&!rel.startsWith('..')&&!path.isAbsolute(rel)?rel:null,phase:'remove'};
}
/** Windows stat uid/gid are not an owner SID proof. An optional TRUSTED Host
 * observer must provide real ownership facts; models cannot supply this service.
 * No observer means cleanup recovery remains closed on Windows. */
export function cleanupOwnership(scope,services){
  if(process.platform!=='win32'&&!services?.reviewCleanupOwnership){const st=fs.lstatSync(scope.root);return {uid:st.uid,gid:st.gid};}
  const value=services?.reviewCleanupOwnership?.observe?.(scope.root);
  if(!value||value.version!==1||typeof value.owner!=='string'||!value.owner||typeof value.securityDigest!=='string'||!/^[a-f0-9]{64}$/.test(value.securityDigest)||typeof value.then==='function')throw new Fault('EXPERIMENT_CLEANUP_OWNER_UNKNOWN','Windows缺可信宿主所有者/安全描述符观察；stat.uid/gid不能代替SID，不恢复删除。');
  return {version:1,owner:value.owner,securityDigest:value.securityDigest};
}
/** Re-observe the exact original managed range; never kill/adopt a PID. */
export async function confirmCleanupExit(handle,closeMs){
  if(typeof handle?.waitForExit!=='function')throw new Fault('EXPERIMENT_CLEANUP_NO_WITNESS','缺本服务原始受管范围句柄；旧收据、重启或目录消失不能证明新收口。');
  const controller=new AbortController();let timer;
  try{
    const result=await Promise.race([handle.waitForExit(controller.signal),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Fault('EXPERIMENT_CLEANUP_EXIT_UNKNOWN','无法重新确认原受管范围退出。')),closeMs);})]);
    if(result!==true)throw new Fault('EXPERIMENT_CLEANUP_EXIT_UNKNOWN','原受管范围退出未确认。');
  }finally{clearTimeout(timer);controller.abort();}
}
