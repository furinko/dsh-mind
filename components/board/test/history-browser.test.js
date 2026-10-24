import {it} from 'node:test';import assert from 'node:assert/strict';
import {makeFixture,LEAD} from '../../../test/helpers.mjs';import {Org} from '../../../src/org.js';import {history路由,memoryUse路由} from '../../kernel/lib/routes.js';
import {loadClient,makeSlots,makeCtx,makeSessions,makeStrictRequire,collect,textOf,jsonResponse,settle,sampleView} from './client-harness.mjs';import {createApprovalRenderer} from './approval-renderer.mjs';
const P='plugins';
async function scene(run,options={}){
 const f=await makeFixture();const org=await Org.open({...f,project:P});const calls=[],cache=new Map();let view=sampleView();view.项目=P;view.记忆=null;
 const ctx={get:()=>({requestRejection:()=>undefined})};const handlers={memory:history路由({ctx,org,项目:P,mode:'memory'}),audit:history路由({ctx,org,项目:P,mode:'audit'}),'memory-use':memoryUse路由({ctx,org,项目:P})};
 const loaded=loadClient({store:cache,fetch:async(url,init)=>{
  calls.push({url,method:init.method});if(url.startsWith('/plugins/dsh-mind/workbench'))return jsonResponse({成功:true,数据:view});
  if(options.intercept){const response=await options.intercept(url,init);if(response)return response;}
  const name=new URL(url,'http://localhost').pathname.split('/').at(-1),handler=handlers[name];if(!handler)return jsonResponse({成功:true});
  const req={url,method:init.method,headers:{host:'127.0.0.1:3080',origin:'http://127.0.0.1:3080','sec-fetch-site':'same-origin'}};const res={writeHead(status){this.status=status;},end(body){this.body=JSON.parse(body);}};await handler(req,res);return jsonResponse(res.body,res.status);
 }});const slots=makeSlots();const plugin=loaded.definition.factory(makeStrictRequire().require);const dispose=plugin.apply(makeCtx({slots:slots.slots,sessions:makeSessions([{id:'owner',main:true}])}));const root=slots.calls.register.find(x=>x.options.name==='main');const renderer=createApprovalRenderer(root.Component,{});
 const elements=()=>collect(renderer.tree,{skipStyle:true}).elements;
 async function flush(){renderer.flush();await settle(35);renderer.flush();await settle(20);renderer.flush();}
 const button=label=>elements().find(e=>e.type==='button'&&textOf(e)===label);
 const e={org,f,calls,cache,loaded,renderer,elements,button,flush,text:()=>textOf(renderer.tree),setView(next){view=next;},async go(page){const b=elements().find(e=>e.props['data-page']===page);assert.ok(b,'page '+page);b.props.onClick();await flush();},async click(label){const b=button(label);assert.ok(b,'button '+label);assert.ok(!b.props.disabled,'enabled '+label);b.props.onClick();await flush();},change(label,value){const x=elements().find(e=>e.props['aria-label']===label);assert.ok(x,'field '+label);x.props.onChange({target:{value,checked:value}});renderer.flush();},async submit(){const form=elements().find(e=>e.type==='form');assert.ok(form);form.props.onSubmit({preventDefault(){}});await flush();},async poll(){loaded.timers.intervals[0].fn();await flush();}};
 try{await flush();await run(e);}finally{renderer.unmount();dispose?.();await org.observability.flush();await f.cleanup();}
}
it('记忆和审计正文只在访问时读取，阻塞反馈页与表单消失',async()=>scene(async e=>{
 const styles=e.elements().filter(x=>x.type==='style').map(x=>collect(x).text).join('');assert.match(styles,/\.dshmind-memoryLayout\{display:grid/);assert.match(styles,/\.dshmind-history \.dshmind-set__btn\{/);assert.equal(e.calls.filter(c=>/\/(memory|audit)\?/.test(c.url)).length,0);assert.ok(!e.elements().some(x=>x.props['data-page']==='monitor'));assert.ok(!e.button('记录原因反馈'));assert.ok(!e.button('提交反馈'));assert.ok(!e.elements().some(x=>textOf(x).includes('展开全部（共')));
 await e.go('memory');assert.ok(e.calls.some(c=>c.url.startsWith('/plugins/dsh-mind/memory?')));assert.match(e.text(),/当前范围没有符合条件的记忆/);assert.ok(e.calls.every(c=>c.method==='GET'));
}));
it('真实记忆正文、来源、分页和搜索可用；计数缺失不妨碍浏览，正文不缓存',async()=>scene(async e=>{
 for(let i=0;i<24;i++)await e.org.memory.remember({subject:LEAD,类:'知识',项目:P,岗位:'插件工程',标题:'回退方法-'+i,内容:'独有的私密正文回退方法-'+i,来源:'真实合成来源'});
 await e.go('memory');assert.equal(e.elements().filter(x=>x.props['data-memory-id']).length,15);await e.click('加载更多记忆');assert.equal(e.elements().filter(x=>x.props['data-memory-id']).length,24);
 await e.click('查看记忆 回退方法-0');assert.match(e.text(),/独有的私密正文回退方法-0/);assert.match(e.text(),/真实合成来源/);await e.click('复制记忆引用');const reference=e.elements().find(x=>x.props['aria-label']==='可复制的会话引用');assert.match(reference.props.value,/请按我的说明更正或遗忘/);
 await e.click('查看调用记录');assert.match(e.text(),/未观察到也不证明没用过/);await e.click('关闭记忆详情');assert.ok(!e.elements().some(x=>x.props['aria-label']==='记忆详情'));
 e.change('搜索记忆','独有的私密正文回退方法');e.change('记忆分类','知识');await e.submit();assert.ok(e.calls.some(c=>c.url.includes('q=')&&c.url.includes('kind=')));
 assert.doesNotMatch([...e.cache.values()].join(''),/独有的私密正文/);assert.ok(e.calls.every(c=>c.method==='GET'));
}));
it('正文分段续读且不切断或重复文本，来源变化后旧详情不得拼接',async()=>scene(async e=>{
 const text='长文片段。'.repeat(12000);const r=await e.org.memory.remember({subject:LEAD,类:'知识',项目:P,标题:'长文',内容:text,来源:'长文来源'});await e.go('memory');await e.click('查看记忆 长文');assert.ok(e.button('继续读取正文'));await e.click('继续读取正文');assert.ok(e.calls.some(c=>/bodyOffset=[1-9]/.test(c.url)&&c.url.includes('dataVersion=')));
 const body=()=>textOf(e.elements().find(x=>x.type==='p'&&x.props.style?.whiteSpace==='pre-wrap'));const loaded=body();assert.ok(loaded.length>16000&&loaded.length<text.length);assert.equal(loaded,text.slice(0,loaded.length));assert.ok(e.button('继续读取正文'));await e.org.memory.invalidate(r.id,{subject:LEAD,原因:'原文更正'});await e.click('继续读取正文');assert.match(e.text(),/变化|不可见|不再存在/);assert.equal(body(),loaded);
}));
it('审计加载更早访问真实历史，轮询不会重置已加载条目；筛选发新查询',async()=>scene(async e=>{
 for(let i=0;i<63;i++)await e.org.audit.append({动作:'用户操作-'+i,主体:LEAD,项目:P,依据:'具体依据-'+i});await e.go('audit');assert.equal(e.elements().filter(x=>x.props['data-audit-key']).length,20);await e.click('加载更早');assert.equal(e.elements().filter(x=>x.props['data-audit-key']).length,40);await e.poll();assert.equal(e.elements().filter(x=>x.props['data-audit-key']).length,40);await e.click('加载更早');await e.click('加载更早');assert.equal(e.elements().filter(x=>x.props['data-audit-key']).length,63);assert.match(e.text(),/当前范围已读到底/);assert.ok(!e.button('加载更早'));
 e.change('筛选审计操作','用户操作-6');await e.submit();assert.equal(e.elements().filter(x=>x.props['data-audit-key']).length,4);assert.ok(e.calls.some(c=>c.url.includes('action=')));assert.match(e.text(),/具体依据/);assert.ok(e.calls.every(c=>c.method==='GET'));
}));
it('离开页面后的迟到正文不能返回；跨项目或坏响应显示错误而非空记忆',async()=>{
 let release,hold=false;
 await scene(async e=>{
  await e.org.memory.remember({subject:LEAD,类:'知识',项目:P,标题:'原条目',内容:'正常正文',来源:'合成来源'});await e.go('memory');hold=true;const b=e.button('查看记忆 原条目');b.props.onClick();await e.flush();assert.ok(release);await e.go('tasks');release(jsonResponse({成功:true,数据:{项目:P,条目:[{id:'late',内容:'不该出现的迟到正文'}]}}));await e.flush();assert.doesNotMatch(e.text(),/不该出现的迟到正文/);
 },{intercept:async url=>{if(hold&&url.includes('/memory?')&&url.includes('id='))return new Promise(resolve=>{release=resolve;});}});
 await scene(async e=>{await e.go('memory');assert.match(e.text(),/不可核对/);assert.doesNotMatch(e.text(),/当前范围没有符合条件的记忆/);},{intercept:async url=>url.includes('/memory?')?jsonResponse({成功:true,数据:{项目:'other',条目:[],数据版本:'a'.repeat(64),下一偏移:null}}):null});
});
it('加载失败保留已有审计且不给已读到底的假结果，重新读取可恢复',async()=>{
 let fail=false;await scene(async e=>{for(let i=0;i<23;i++)await e.org.audit.append({动作:'操作',主体:LEAD,项目:P});await e.go('audit');fail=true;await e.click('加载更早');assert.equal(e.elements().filter(x=>x.props['data-audit-key']).length,20);assert.match(e.text(),/读取失败/);assert.doesNotMatch(e.text(),/当前范围已读到底/);fail=false;await e.click('加载更早');assert.equal(e.elements().filter(x=>x.props['data-audit-key']).length,23);},{intercept:async url=>fail&&url.includes('/audit?')&&url.includes('cursor=')?jsonResponse({成功:false,理由:'读取失败'},503):null});
});
