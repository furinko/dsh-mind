/** Scoped original submissions/votes. Read only; no bus handoff or task revival. */
import {Denied,Fault,InvalidBody} from './kernel/errors.js';
import {canonical,digest} from './kernel/text.js';
import {复核读域,在读域} from './review-scope.js';
import {readInstanceSnapshot} from './instance-snapshot.js';
import {matchingBinding} from './tool-file-scope.js';

const deny=()=>new Denied('任务原记录 · 复核读域','原记录不存在、不属于指定任务或当前主体的复核读域。');
async function currentDomain(org,项目,subject){
  if(subject?.kind!=='成员')return null;
  const snapshot=readInstanceSnapshot(org.layout.identityFile()),member=snapshot.成员?.[subject.id];
  if(!snapshot.ok||member?.就绪!==true)throw deny();
  const nodes=await org.tasks.list({项目});
  const domain = 复核读域({节点:nodes,主体:subject,项目,成员:member});
  if(!domain.限定)throw deny();return domain;
}
export async function readTaskRecords({org,项目,subject,args}){
  const allowed=['action','project','原记录','id','提交序','票','偏移','limit','记录偏移','记录长度','数据版本'];
  if(Object.keys(args).some(k=>!allowed.includes(k)))throw new InvalidBody('任务原记录含未知参数。');
  if(!['Lead','主权者','成员'].includes(subject?.kind))throw deny();
  if(args.票!==undefined&&args.提交序!==undefined)throw new InvalidBody('提交序和票不能同时提供；须唯一选择原记录。');
  if(args.提交序!==undefined&&(!Number.isSafeInteger(args.提交序)||args.提交序<1))throw new InvalidBody('提交序不合法。');
  if(args.票!==undefined&&!/^rv-[1-9]\d*$/.test(args.票))throw new InvalidBody('票必须是原始rv-序号。');
  const offset=args.偏移??0,limit=args.limit??20,start=args.记录偏移??0,length=args.记录长度??16384;
  if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(start)||start<0||!Number.isSafeInteger(length)||length<1||length>32768)throw new InvalidBody('任务原记录分页越界。');
  const rows=await org.tasks.events({项目});
  // The task ledger assigns project-wide seq. Legacy rows use the same folding
  // convention (one-based physical event index), without fabricating a generation.
  const records=rows.map((row,i)=>({row,seq:Number.isSafeInteger(row.seq)?row.seq:i+1})).filter(r=>['submitted','reviewed'].includes(r.row.kind));
  const selected=args.提交序!==undefined?records.find(r=>r.seq===args.提交序&&r.row.kind==='submitted'):args.票!==undefined?records.find(r=>'rv-'+r.seq===args.票&&r.row.kind==='reviewed'):null;
  const id=args.id??selected?.row.id;
  if(typeof id!=='string'||!id||id.length>256)throw deny();
  if((args.提交序!==undefined||args.票!==undefined)&&(!selected||selected.row.id!==id))throw deny();
  const node=await org.tasks.get(id,{项目}),domain=await currentDomain(org,项目,subject);
  if(!node||!在读域(domain,id))throw deny();
  // Historical blind tasks retain their existing closed read surfaces.
  if(node.模式==='独立会审')throw new Denied('任务原记录 · 历史盲评','历史盲评任务须使用其既有盲评读面。');
  await org.policy.check({subject,action:'read',target:{id,kind:'任务',authority:'自治',zone:'私有',project:项目},context:{task:node}});
  const own=records.filter(r=>r.row.id===id),version=digest(canonical({项目,任务:id,记录:own}));
  if(args.数据版本!==undefined&&args.数据版本!==version)throw new Fault('TASK_RECORD_VERSION_CHANGED','任务原记录版本已变化，请从首页重新核对来源与分页。');
  const source=r=>({项目,任务:id,事件:r.row.kind,序:r.seq,代:r.row.代??null,主体:r.row.by??null,于:r.row.at??null});
  const meta=r=>{const bytes=Buffer.from(canonical(r.row));return {来源:source(r),...(r.row.kind==='submitted'?{提交序:r.seq}:{票:'rv-'+r.seq}),SHA256:digest(bytes.toString()),字节:bytes.length};};
  // Re-read scope after asynchronous policy checks; no parameters can extend it.
  if(!在读域(await currentDomain(org,项目,subject),id))throw deny();
  if(!selected)return {任务:id,项目,数据版本:version,总数:own.length,偏移:offset,下一偏移:Math.min(own.length,offset+limit),完整:offset+limit>=own.length,记录:own.slice(offset,offset+limit).map(meta),说明:'仅元数据列表；原文须按提交序或票分页读取，不是全文预览。'};
  const bytes=Buffer.from(canonical(selected.row));if(start>bytes.length)throw new InvalidBody('原记录字节分页越界。');
  const page=bytes.subarray(start,start+length);
  return {...meta(selected),数据版本:version,偏移:start,下一偏移:start+page.length,完整:start+page.length===bytes.length,源截断:false,字节Base64:page.toString('base64'),文本:page.toString('utf8'),编码:'UTF-8 / canonical JSON',说明:'SHA256对应选定原事件的完整规范JSON；偏移按字节，跨UTF8字符以Base64为准。未改交卷、票据、采纳或结账。'};
}
