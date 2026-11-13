/** Independent code review regression: a passed source check is not a commit fence. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
test('forget after source check but before summary append cannot revive forgotten text', async () => {
  const f = await makeFixture();
  try {
    const project = 'summary-race-review';
    const org = await Org.open({ ...f, project });
    await org.turnBuffer.capture({ subject: LEAD, project, session: LEAD.id, fromSeq: 0, throughSeq: 4, records: [
      {seq:0,type:'turn/start',turn:1,time:org.clock.ms()},
      {seq:1,type:'message',role:'user',id:'private-source',text:'PRIVATE_REVIEW_RACE_BODY',clipped:false,interrupted:false,turn:null},
      {seq:2,type:'message',role:'assistant',id:'answer',text:'done',clipped:false,interrupted:false,turn:1},
      {seq:3,type:'turn/end',turn:1,reason:'completed'},
    ] });
    const record = org.memory.recordTurnSummary.bind(org.memory);
    let crossed = false;
    let forgetting;
    org.memory.recordTurnSummary = spec => record({ ...spec, check: async () => {
      await spec.check();
      if (!crossed) {
        crossed = true;
        forgetting = org.turnBuffer.forget({ subject: LEAD, project, session: LEAD.id, throughSeq: 4 });
        await Promise.resolve();
      }
    } });
    let failure;
    try { await org.turnSummaries.summarize({ subject: LEAD, project, session: LEAD.id,
      summary: { 用户决定: [], 助手建议: [], 认识: [{text:'PRIVATE_REVIEW_RACE_BODY',source:'private-source'}] } }); }
    catch (error) { failure = error; }
    assert.equal(crossed, true);
    await forgetting;
    const summaries = await org.memory.turnSummaries({ subject: LEAD, project, session: LEAD.id });
    assert.equal(summaries.length, 0, '已经返回的遗忘不得被迟到总结恢复');
    assert.ok(failure || summaries.length === 0);
  } finally { await f.cleanup(); }
});
