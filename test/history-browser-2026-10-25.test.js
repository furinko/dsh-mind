import {it} from 'node:test';import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {makeFixture,LEAD,SOVEREIGN} from './helpers.mjs';import {Org} from '../src/org.js';import {history路由} from '../components/kernel/lib/routes.js';
const P='history-browser';
async function scene(run){const f=await makeFixture();const org=await Org.open({...f,project:P});try{await run(org,f);}finally{await org.observability.flush();await f.cleanup();}}
async function request(org,mode,query='',options={}){const handler=history路由({org,项目:P,mode,ctx:options.noAuth?{}:{get:()=>({requestRejection:()=>options.reject})}});const req={method:options.method??'GET',url:'/plugins/dsh-mind/'+mode+'?project='+P+query,headers:{host:'127.0.0.1:3080',origin:'http://127.0.0.1:3080','sec-fetch-site':options.cross?'cross-site':'same-origin'}};const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};await handler(req,res);return res;}
async function records(org,count=65){for(let i=0;i<count;i++)await org.audit.append({动作:'测试操作-'+i,主体:LEAD,项目:P,依据:'依据-'+i});}
it('审计分页超过40条，按真实游标读取全部历史，期间新增不漏重',async()=>scene(async org=>{
 await records(org);const first=(await request(org,'audit')).body.数据;assert.equal(first.entries.length,20);assert.equal(first.total,65);assert.equal(first.entries[0].动作,'测试操作-64');
 await org.audit.append({动作:'稍后新增',主体:LEAD,项目:P});let page=first;const keys=[];
 while(true){keys.push(...page.entries.map(r=>r.key));if(!page.nextCursor)break;const r=await request(org,'audit','&cursor='+encodeURIComponent(page.nextCursor));assert.equal(r.status,200);page=r.body.数据;}
 assert.equal(keys.length,65);assert.equal(new Set(keys).size,65);assert.equal((await request(org,'audit')).body.数据.total,66);
}));
it('审计游标绑定项目和筛选，未知参数、坏游标及超量分页拒绝',async()=>scene(async org=>{
 await records(org,25);const first=(await request(org,'audit')).body.数据;
 for(const q of ['&cursor=bad','&limit=999','&action=a&cursor='+encodeURIComponent(first.nextCursor),'&subject=other','&limit=1&limit=2'])assert.equal((await request(org,'audit',q)).status,400,q);
 const filter=(await request(org,'audit','&action='+encodeURIComponent('测试操作-2'))).body.数据;assert.equal(filter.total,6);assert.ok(filter.entries.every(r=>r.动作.includes('测试操作-2')));
 const other=await org.audit.page({project:'other'});assert.equal(other.entries.length,0);
}));
it('分页间原账旧行变化拒绝拼接，不伪称已读完整历史',async()=>scene(async org=>{
 await records(org,25);const first=(await request(org,'audit')).body.数据;const file=org.layout.auditLog(org.clock.iso().slice(0,7));const raw=await readFile(file,'utf8');await writeFile(file,raw.replace('依据-0','旧行已变化'));assert.equal((await request(org,'audit','&cursor='+encodeURIComponent(first.nextCursor))).status,409);
}));
it('审计按月份与序号跨月分页，筛选时间遵守显式偏移',async()=>scene(async(org)=>{
 const original=org.clock._source;org.clock._source=()=>new Date('2026-01-31T23:55:00Z');await records(org,3);org.clock._source=()=>new Date('2026-02-01T00:05:00Z');await records(org,3);
 const p=await org.audit.page({project:P,limit:4});assert.ok(p.entries[0].key.startsWith('2026-02'));assert.ok(p.entries[3].key.startsWith('2026-01'));const q=await org.audit.page({project:P,from:'2026-02-01T08:00:00+08:00',to:'2026-02-01T08:10:00+08:00'});assert.equal(q.total,3);org.clock._source=original;
}));
it('两类正文读面都要求认证同源，不能写入或代理模型动作',async()=>scene(async org=>{
 for(const mode of ['audit','memory']){assert.equal((await request(org,mode,'',{noAuth:true})).status,503);assert.equal((await request(org,mode,'',{reject:401})).status,401);assert.equal((await request(org,mode,'',{cross:true})).status,403);assert.equal((await request(org,mode,'',{method:'POST'})).status,405);assert.equal((await request(org,mode,'&action=memory_write')).status,mode==='memory'?400:200);}
}));
it('记忆页读原生条目、来源和停用状态，搜索/分页/全文不另复制正文',async()=>scene(async org=>{
 const ids=[];for(let i=0;i<24;i++)ids.push((await org.memory.remember({subject:LEAD,类:'知识',项目:P,岗位:'插件工程',标题:'原生记忆-'+i,内容:'正文方法-'+i,来源:'直接来源'})).id);
 const a=await request(org,'memory');assert.equal(a.status,200);assert.ok(a.body.数据.条目.length<24);assert.ok(a.body.数据.下一偏移>0);
 const b=await request(org,'memory','&offset='+a.body.数据.下一偏移+'&dataVersion='+a.body.数据.数据版本);assert.equal(b.status,200);assert.equal(new Set([...a.body.数据.条目,...b.body.数据.条目].map(r=>r.id)).size,24);
 const d=await request(org,'memory','&id='+ids[0]);assert.equal(d.body.数据.条目[0].内容,'正文方法-0');assert.equal(d.body.数据.条目[0].标题,'原生记忆-0');assert.ok(d.body.数据.条目[0].来源);
 await org.memory.invalidate(ids[0],{subject:LEAD,原因:'测试停用'});assert.equal((await request(org,'memory','&id='+ids[0])).body.数据.条目.length,0);assert.equal((await request(org,'memory','&id='+ids[0]+'&includeInactive=true')).body.数据.条目.length,1);
}));
it('项目浏览不带出其他项目的私人经历与人格；部署级内容仍按原服务可见',async()=>scene(async org=>{
 await org.memory.rememberPersonal({subject:LEAD,类:'经历',项目:'other-project',内容:'其他项目的私密经历',来源:'合成经历'});
 await org.memory.rememberPersonal({subject:LEAD,类:'偏好',项目:'other-project',内容:'其他项目的偏好',来源:'合成偏好',连续性:{类别:'用户偏好',主题:'测试',依据:'明确表达',范围:'项目'}});
 const r=await request(org,'memory');assert.equal(r.status,200);assert.doesNotMatch(JSON.stringify(r.body),/其他项目的私密经历|其他项目的偏好/);
 await assert.rejects(org.memory.query({subject:LEAD,项目:P,浏览项目:true}));
}));
it('记忆源变化使旧分页失效，长正文只按同一数据版本续读',async()=>scene(async org=>{
 const r=await org.memory.remember({subject:LEAD,类:'知识',项目:P,内容:'长正文。'.repeat(6000),来源:'合成来源'});const d=(await request(org,'memory','&id='+r.id)).body.数据;assert.ok(d.下一正文偏移>0);const n=await request(org,'memory','&id='+r.id+'&bodyOffset='+d.下一正文偏移+'&dataVersion='+d.数据版本);assert.equal(n.status,200);assert.ok(n.body.数据.条目[0].内容);
 await org.memory.invalidate(r.id,{subject:LEAD,原因:'来源改变'});assert.equal((await request(org,'memory','&id='+r.id+'&bodyOffset='+d.下一正文偏移+'&dataVersion='+d.数据版本)).status,400);
}));
