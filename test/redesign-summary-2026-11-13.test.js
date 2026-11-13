import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { budgetMindContext } from '../components/kernel/lib/runtime-context.js';
import { PROFESSIONAL_SECTION } from '../components/kernel/lib/professional-context.js';
import { TURN_BUFFER_SECTION } from '../components/kernel/lib/turn-buffer-hooks.js';
const P='summary';
async function scene(run) { const f=await makeFixture();try{const org=await Org.open({...f,project:P});await run(org);}finally{await f.cleanup();} }
async function rounds(org,count=20,start=0) {
 const records=[];let seq=start;
 for(let turn=1;turn<=count;turn++) records.push({seq:seq++,type:'turn/start',turn,time:org.clock.ms()},
  {seq:seq++,type:'message',role:'user',id:'u'+start+'-'+turn,text:'user experience '.repeat(20),clipped:false,interrupted:false,turn:null},
  {seq:seq++,type:'message',role:'assistant',id:'a'+start+'-'+turn,text:'assistant suggestion '.repeat(20),clipped:false,interrupted:false,turn},
  {seq:seq++,type:'turn/end',turn,reason:'completed'});
 await org.turnBuffer.capture({subject:LEAD,project:P,session:LEAD.id,records,fromSeq:start,throughSeq:seq});return seq;
}
it('active recaps preserve source coverage separately from full originals and do not force a task',()=>scene(async org=>{
 const end=await rounds(org);const recap=await org.turnSummaries.summarize({subject:LEAD,project:P,session:LEAD.id});
 assert.equal(recap.rounds,20);assert.match(recap.mode,/摘录/);
 assert.equal((await org.turnBuffer.load(P,LEAD.id)).rounds.length,20);
 const saved=await org.memory.turnSummaries({subject:LEAD,project:P,session:LEAD.id});assert.equal(saved.length,1);assert.equal(saved[0].轮级总结.sources.length,40);
 assert.deepEqual((await org.tasks.list({项目:P})),[]);
 const again=await org.turnSummaries.summarize({subject:LEAD,project:P,session:LEAD.id});assert.equal(again.pendingRounds,0);
 await org.memory.organize({subject:LEAD,项目:P,op:'update',id:saved[0].id,内容:'corrected understanding',原因:'new counterexample'});
 assert.equal((await org.memory.query({subject:LEAD,项目:P,id:saved[0].id})).条目[0].内容,'corrected understanding');
 await org.memory.invalidate(saved[0].id,{subject:LEAD,原因:'先有新反例，旧总结已失效'});
 await org.turnBuffer.forget({subject:LEAD,project:P,session:LEAD.id,throughSeq:end});
 assert.equal((await org.memory.turnSummaries({subject:LEAD,project:P,session:LEAD.id,includeInactive:true})).length,0);
 const raw=await readFile(org.layout.memoryLog(saved[0].归属,saved[0].类),'utf8');assert.ok(!raw.includes('corrected understanding'));
}));
it('assistant suggestions cannot be recorded as user decisions; short replies do not force knowledge',()=>scene(async org=>{
 await rounds(org,1);await assert.rejects(org.turnSummaries.summarize({subject:LEAD,project:P,session:LEAD.id,summary:{用户决定:[{text:'approved',source:'a0-1'}],助手建议:[],认识:[]}}));
 const valid=await org.turnSummaries.summarize({subject:LEAD,project:P,session:LEAD.id,summary:{用户决定:[],助手建议:[{text:'try a method',source:'a0-1'}],认识:[{text:'tentative lesson',source:'u0-1'}]}});
 assert.ok(valid.id);assert.equal((await org.memory.query({subject:LEAD,项目:P,类:'知识'})).条目.length,0);
}));
it('one context budget selects whole frames without truncating their JSON or storage',()=>{
 const first={name:PROFESSIONAL_SECTION,text:'x'.repeat(700)};
 const lower={name:TURN_BUFFER_SECTION,text:'y'.repeat(700)};
 const input={sections:[first,lower,{name:'host',text:'host policy'}],contexts:[]};
 const output=budgetMindContext(input,1000);assert.ok(output.sections.includes(first));assert.ok(!output.sections.includes(lower));assert.ok(output.sections.some(s=>s.name==='host'));
 assert.equal(lower.text.length,700);
 const duplicated=budgetMindContext({sections:[first],contexts:[first]},1000);assert.equal(duplicated.sections.length+duplicated.contexts.length,1);
});
