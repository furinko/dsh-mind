/** Bounded history over the native ledger scan; no cache, secondary ledger or mutation. */
import { canonical, digest } from './kernel/text.js';
import { InvalidBody, Fault } from './kernel/errors.js';
const compare=(a,b)=>a.month.localeCompare(b.month)||a.seq-b.seq;
const key=row=>({month:row.month,seq:row.row.seq,hash:row.row.hash});
const same=(a,b)=>a&&b&&a.month===b.month&&a.seq===b.seq&&a.hash===b.hash;
const valid=k=>k&&/^\d{4}-\d{2}$/.test(k.month)&&Number.isSafeInteger(k.seq)&&k.seq>0&&/^[a-f0-9]{64}$/.test(k.hash);
const clip=(v,n)=>String(v??'').slice(0,n);
export function auditPage(rows,query={}) {
 const limit=query.limit??20;
 if(!Number.isSafeInteger(limit)||limit<1||limit>50)throw new InvalidBody('每页审计记录需为1至50条。');
 if(typeof query.project!=='string'||!query.project.trim()||query.project.length>256)throw new InvalidBody('审计浏览需要明确项目。');
 if(query.action!==undefined&&(typeof query.action!=='string'||query.action.length>160))throw new InvalidBody('操作筛选过长。');
 const boundary=value=>{if(value===undefined||value==='')return null;if(typeof value!=='string'||value.length>40||!/(?:Z|[+-]\d{2}:\d{2})$/.test(value)||!Number.isFinite(Date.parse(value)))throw new InvalidBody('时间范围需要带时区的有效时间。');return new Date(value).toISOString();};
 const from=boundary(query.from),to=boundary(query.to);if(from&&to&&from>=to)throw new InvalidBody('结束时间须晚于开始时间。');
 const scope=digest(canonical({project:query.project,action:query.action??'',from,to}));
 let selected=rows.filter(r=>r.row.项目===query.project&&(!query.action||String(r.row.动作??'').includes(query.action))
  &&(!from||Date.parse(r.row.时间)>=Date.parse(from))&&(!to||Date.parse(r.row.时间)<Date.parse(to)));
 if(selected.some(r=>!valid(key(r))))throw new Fault('AUDIT_PAGE_INVALID','部分审计定位信息不可核对，未返回不完整历史。');
 selected.sort((a,b)=>compare(key(a),key(b)));
 let cursor=null;
 if(query.cursor!==undefined){
  try{if(typeof query.cursor!=='string'||query.cursor.length>2048||!/^[A-Za-z0-9_-]+$/.test(query.cursor))throw Error();cursor=JSON.parse(Buffer.from(query.cursor,'base64url').toString('utf8'));if(cursor.version!==1||cursor.scope!==scope||!valid(cursor.head)||!valid(cursor.before)||!same(key(selected.find(r=>same(key(r),cursor.head))??{month:'',row:{}}),cursor.head))throw Error();}
  catch{throw new InvalidBody('审计分页位置失效或筛选已变化，请重新读取。');}
  selected=selected.filter(r=>compare(key(r),cursor.head)<=0);
 }
 const prefix=digest(canonical(selected));
 if(cursor&&(cursor.prefix!==prefix||!selected.some(r=>same(key(r),cursor.before))))throw new Fault('AUDIT_PAGE_CHANGED','此前审计历史已变化，请重新读取，不能拼接不同快照。');
 const head=selected.length?key(selected.at(-1)):null;
 const remaining=selected.filter(r=>!cursor||compare(key(r),cursor.before)<0).reverse();
 const page=remaining.slice(0,limit),hasMore=remaining.length>page.length;
 return {project:query.project,total:selected.length,entries:page.map(r=>({key:r.month+':'+r.row.seq+':'+r.row.hash,
  时间:r.row.时间,动作:clip(r.row.动作,160),主体:clip(r.row.主体?.id??r.row.主体,256),结果:clip(r.row.结果,500),档位:clip(r.row.档位,32),告警:r.row.告警===true,
  对象:{id:clip(r.row.对象?.id,256),kind:clip(r.row.对象?.kind,80)},依据:clip(r.row.依据,2000),依据截断:String(r.row.依据??'').length>2000})),
  nextCursor:hasMore?Buffer.from(JSON.stringify({version:1,scope,head,before:key(page.at(-1)),prefix})).toString('base64url'):null,
  hasMore,order:'按账本月份与序号从新到旧；刷新才接入新记录'};
}
