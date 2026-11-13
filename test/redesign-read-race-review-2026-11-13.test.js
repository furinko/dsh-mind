import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { withMindReadSnapshot } from '../components/kernel/lib/runtime-context.js';
import { PROFESSIONAL_SECTION } from '../components/kernel/lib/professional-context.js';
test('a memory query crossing a completed forget must discard its old body snapshot', async () => {
  const f = await makeFixture();
  try {
    const project = 'read-race-review';
    const org = await Org.open({...f,project});
    const entry = await org.memory.remember({subject:LEAD,项目:project,类:'知识',内容:'PRIVATE_FORGOTTEN_DURING_READ',来源:'synthetic review'});
    const readable = org.memory.ownedReadable.bind(org.memory);
    let forgotten = false;
    org.memory.ownedReadable = async (candidate,...rest) => {
      if (!forgotten && candidate.id === entry.id) {
        forgotten = true;
        await org.memory.organize({subject:LEAD,项目:project,op:'forget',id:entry.id,原因:'real concurrent forget'});
      }
      return readable(candidate,...rest);
    };
    let answer; let error;
    try { answer = await org.memory.query({subject:LEAD,项目:project,id:entry.id}); }
    catch (caught) { error = caught; }
    assert.equal(forgotten,true);
    assert.ok(error || !JSON.stringify(answer).includes('PRIVATE_FORGOTTEN_DURING_READ'),'返回前已忘的旧正文不得外发');
  } finally { await f.cleanup(); }
});
test('context assembly crossing a forget must withdraw earlier automatic memory frames', async () => {
  const f = await makeFixture();
  try {
    const project = 'assembly-race-review';
    const org = await Org.open({...f,project});
    const entry = await org.memory.remember({subject:LEAD,项目:project,类:'知识',内容:'PRIVATE_OLD_CONTEXT_FRAME',来源:'synthetic review'});
    const frame = {sections:[{name:PROFESSIONAL_SECTION,text:'PRIVATE_OLD_CONTEXT_FRAME'},{name:'host',text:'host rules'}],contexts:[]};
    const output = await withMindReadSnapshot(frame,{org,logger:{warn(){}}},async()=>{
      await org.memory.query({subject:LEAD,项目:project,id:entry.id});
      await org.memory.organize({subject:LEAD,项目:project,op:'forget',id:entry.id,原因:'real forget during assembly'});
      return frame;
    });
    assert.ok(!JSON.stringify(output).includes('PRIVATE_OLD_CONTEXT_FRAME'),'后续装配不能重新发送已忘的前段');
    assert.ok(JSON.stringify(output).includes('host rules'));
  } finally { await f.cleanup(); }
});
