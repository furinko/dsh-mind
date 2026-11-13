import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
test('organize updates bodies without moving cross-project copies or changing audience tags', async () => {
  const f = await makeFixture();
  try {
    const project = 'copy-review';
    const org = await Org.open({...f, project});
    const entry = await org.memory.remember({subject:LEAD,项目:project,类:'知识',内容:'old private body',来源:'synthetic review',岗位:'插件工程'});
    await org.memory.promoteCrossProject(entry.id,{subject:LEAD,岗位:'文档整理',理由:'synthetic independent review'});
    const across = org.layout.memoryLog('跨项目','知识');
    const before = (await readFile(across,'utf8')).trim().split('\n').map(JSON.parse).find(row=>row.id===entry.id);
    assert.equal(before.归属,'跨项目');
    await org.memory.organize({subject:LEAD,项目:project,op:'update',id:entry.id,内容:'corrected private body',原因:'review correction'});
    const after = (await readFile(across,'utf8')).trim().split('\n').map(JSON.parse).find(row=>row.id===entry.id);
    assert.equal(after.归属,before.归属,'整理不能把跨项目副本误标成本项目');
    assert.equal(after.岗位,before.岗位,'纠正正文不能擅自修改副本专业选择范围');
    assert.deepEqual(after.跨项目判定,before.跨项目判定,'原晋升事实仍保留');
    assert.equal(after.内容,'corrected private body');
  } finally { await f.cleanup(); }
});
