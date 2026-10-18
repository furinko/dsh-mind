import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {makeFixture} from './helpers.mjs';
import {Org} from '../src/org.js';
import {canonical,digest} from '../src/kernel/text.js';
const owner={id:'repair-original-applicant',kind:'Lead'};
const source={subject:owner,action:'write',args:{内容:'OWNER-APPROVED-ORIGINAL'},项目:'plugins',档位:'审批',步骤:[{动作:'write',目标:{kind:'产物',id:'artifact-proof'},预览:{内容:'OWNER-APPROVED-ORIGINAL'},说明:'冻结写'}]};
async function scene(fn){const f=await makeFixture({defaults:{介入度:'审批'}});try{const org=await Org.open({home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project:'plugins'});const request=await org.intervention.记请求(source);await org.intervention.人侧决议({请求id:request.请求id,决定:'批准',通道:'隔离真实人侧适配器',认证:'测试认证事实'});const file=org.layout.private('介入请求',request.请求id+'.json');const record=JSON.parse(await readFile(file,'utf8'));await fn(org,request,file,record);}finally{await f.cleanup();}}
function seal(record){delete record.内容摘要;record.内容摘要=digest(canonical(record));return record;}
async function zeroUse(org){assert.equal((await org.audit.read({})).filter(x=>x.动作==='介入放行占用').length,0,'校验拒绝前不可占用或执行');}

test('批准后原冻结记录正控：原申请者原参数原步骤可占用一次，不把安全修复做成恒拒',()=>scene(async(org,r)=>{const a=await org.intervention.校验放行({请求id:r.请求id,subject:owner,action:'write',入参:source.args,步骤:source.步骤});assert.equal(a.ok,true);assert.equal(a.冻结.入参.内容,'OWNER-APPROVED-ORIGINAL');assert.equal((await org.intervention.校验放行({请求id:r.请求id,subject:owner})).ok,false);}));

test('批准后篡改入参并自重算摘要，同步提交篡改参数/步骤仍须被原请求账本拒绝',()=>scene(async(org,r,file,record)=>{record.入参.内容='AFTER-APPROVAL-SWAP';await writeFile(file,JSON.stringify(seal(record)));const a=await org.intervention.校验放行({请求id:r.请求id,subject:owner,action:'write',入参:record.入参,步骤:record.步骤});assert.equal(a.ok,false,'批准后的自摘要置换不能通过重放');assert.match(a.原因,/账本不符|规范请求指纹/);await zeroUse(org);}));

test('批准后仅改计划且自重算摘要：规范请求id不含计划，仍须以原账本摘要绑定拒绝',()=>scene(async(org,r,file,record)=>{record.步骤[0].预览.内容='CHANGED-PLAN';record.步骤[0].内容指纹=digest(canonical({说明:record.步骤[0].说明,预览:record.步骤[0].预览}));await writeFile(file,JSON.stringify(seal(record)));assert.equal(org.intervention.请求指纹(source),r.请求id,'正控：这次坏面不依赖规范请求id变化');const a=await org.intervention.校验放行({请求id:r.请求id,subject:owner,入参:record.入参,步骤:record.步骤});assert.equal(a.ok,false);assert.match(a.原因,/账本不符/);await zeroUse(org);}));

test('重放须绑定当前批准行内容摘要：冻结文件与请求行不变，错误批准摘要不能消费',()=>scene(async(org,r)=>{await org.audit.append({动作:'介入决议',主体:{id:'sovereign',kind:'主权者'},对象:{id:r.请求id,kind:'介入请求'},项目:'plugins',结果:'批准',依据:'独立错误批准摘要夹具',详情:{请求记录:{请求id:r.请求id,摘要:'f'.repeat(64)}}});const a=await org.intervention.校验放行({请求id:r.请求id,subject:owner,入参:source.args,步骤:source.步骤});assert.equal(a.ok,false);assert.match(a.原因,/决议.*摘要/);await zeroUse(org);}));

test('规范请求id独立绑定：自摘要及请求/批准摘要相互一致也不能换掉规范请求身份',()=>scene(async(org,r,file,record)=>{const fake='d'.repeat(64);record.请求id=fake;record.请求指纹=fake;seal(record);await writeFile(org.layout.private('介入请求',fake+'.json'),JSON.stringify(record));await org.audit.append({动作:'介入请求',主体:owner,对象:{id:fake,kind:'介入请求'},项目:'plugins',结果:'待放行',依据:'规范指纹错误独立夹具',详情:{动作:'write',档位:'审批',目标:null,请求记录:{请求id:fake,摘要:record.内容摘要}}});await org.audit.append({动作:'介入决议',主体:{id:'sovereign',kind:'主权者'},对象:{id:fake,kind:'介入请求'},项目:'plugins',结果:'批准',依据:'夹具批准',详情:{请求记录:{请求id:fake,摘要:record.内容摘要}}});const a=await org.intervention.校验放行({请求id:fake,subject:owner,入参:record.入参,步骤:record.步骤});assert.equal(a.ok,false);assert.match(a.原因,/规范请求指纹/);await zeroUse(org);}));
