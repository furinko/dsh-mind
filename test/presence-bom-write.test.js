import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {makeFixture} from './helpers.mjs';
import {Org} from '../src/org.js';
import {presence路由} from '../components/kernel/lib/routes.js';

const prefs='集体L2-共享基础设施/defaults/部署.json';
async function fixture(run){const f=await makeFixture();try{const org=await Org.open({home:f.home,factoryRoot:f.factoryRoot,privateRoot:f.privateRoot,project:'bom-settings'});await run(org,f);}finally{await f.cleanup();}}
async function call(org,body){let status,value;const req={method:body?'POST':'GET',url:'/plugins/dsh-mind/presence',headers:{host:'127.0.0.1:7710','sec-fetch-site':'same-origin','content-type':'application/json'},async *[Symbol.asyncIterator](){if(body)yield Buffer.from(JSON.stringify(body));}};await presence路由({org,项目:'bom-settings',ctx:{get:name=>name==='connection'?{requestRejection:()=>undefined}:undefined}})(req,{writeHead:s=>{status=s;},end:text=>{value=JSON.parse(text);}});return{status,value};}

test('真实设置HTTP入口读取BOM配置：同值保存不动原字节，复核免审写入后保留所有原键并独立回读',()=>fixture(async(org,f)=>{
  const original={失联限制:false,响应期限小时:72,岗位闲置天数:5,自定义配置:{说明:'保留用户内容',列表:['a','b']}};
  const text='\uFEFF'+JSON.stringify(original,null,2)+'\n';await f.writePrivate(prefs,text);await org.policy.reload();
  assert.equal(org.policy.healthy,true);assert.equal((await call(org)).value.读数.失联限制,false);
  const unchanged=await call(org,{小时:72});assert.equal(unchanged.status,200);assert.equal(unchanged.value.成功,true);assert.deepEqual(await readFile(org.layout.deploymentPrefs()),Buffer.from(text),'无变更保存不顺手重写编码');
  const saved=await call(org,{复核免审:true});assert.equal(saved.status,200,JSON.stringify(saved.value));assert.equal(saved.value.成功,true);
  assert.deepEqual(JSON.parse(await readFile(org.layout.deploymentPrefs(),'utf8')),{...original,复核免审:true});
  const back=await call(org);assert.equal(back.value.读数.复核免审,true);assert.equal(back.value.读数.生效响应期限小时,72);assert.equal(back.value.读数.失联限制,false);
  assert.equal((await org.audit.read({})).filter(x=>x.动作==='设置变更').length,2,'两次设置意图都留痕');
}));

for(const [kind,text]of [['坏JSON','\uFEFF{"失联限制":false,'],['数组','\uFEFF[]'],['null','\uFEFFnull']])test('BOM兼容不吞'+kind+'：真实设置HTTP入口拒绝且原文件逐字节保留',()=>fixture(async(org,f)=>{
  await f.writePrivate(prefs,text);
  const result=await call(org,{复核免审:true});assert.equal(result.status,200,'业务失败沿用路由的结构化回包合同');assert.equal(result.value.成功,false);assert.match(result.value.理由,/部署\.json/);
  assert.deepEqual(await readFile(org.layout.deploymentPrefs()),Buffer.from(text));
}));
