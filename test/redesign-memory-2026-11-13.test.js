import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { makeFixture, LEAD, MEMBER } from './helpers.mjs';
import { Org } from '../src/org.js';
import { readJsonl, atomicWrite } from '../src/kernel/fsx.js';
import { maintenanceFile } from '../src/memory-maintenance.js';
import { digest } from '../src/kernel/text.js';
const P = 'redesign';
async function fixture(run) { const f = await makeFixture(); try { const org = await Org.open({ ...f, project: P }); await run(org, f); } finally { await f.cleanup(); } }
const put = (org, text, extra={}) => org.memory.remember({subject:LEAD,项目:P,类:'知识',内容:text,来源:'合成经历',...extra});
const organize = (org, spec) => org.memory.organize({subject:LEAD,项目:P,原因:'合成整理',...spec});
it('current understanding can be corrected; the previous private body is physically removed', () => fixture(async org => {
  const old = await put(org, 'OBSOLETE_PRIVATE_BODY');
  const child = await put(org,'old derived claim',{来源引用:[old.id]});
  const answer = await organize(org,{op:'update',id:old.id,内容:'new understanding'});
  assert.equal(answer.phase,'committed');
  assert.equal((await org.memory.query({subject:LEAD,项目:P,id:child.id})).条目.length,0);
  assert.equal((await org.memory.query({subject:LEAD,项目:P,id:old.id})).条目[0].内容,'new understanding');
  const raw = await readFile(old.账本,'utf8'); assert.ok(!raw.includes('OBSOLETE_PRIVATE_BODY'));
  assert.ok(! (await readFile(maintenanceFile(org.layout),'utf8')).includes('new understanding'));
}));
it('merge and compaction remove duplicate bodies; forgetting also removes transitive summaries', () => fixture(async org => {
  const a = await put(org,'duplicate '.repeat(1000)); const b = await put(org,'duplicate '.repeat(1000));
  const dependent = await put(org,'dependent fact',{来源引用:[b.id]});
  const before = (await readFile(a.账本)).length;
  await organize(org,{op:'merge',ids:[a.id,b.id],内容:'merged useful fact'});
  assert.ok((await readFile(a.账本)).length < before / 2);
  assert.deepEqual((await org.memory.query({subject:LEAD,项目:P,id:dependent.id,含失效:true})).条目[0].来源引用,[a.id]);
  const summary = await put(org,'derived private summary',{来源引用:[a.id]});
  await organize(org,{op:'forget',id:a.id});
  const raw = await readFile(a.账本,'utf8'); assert.ok(!raw.includes('merged useful fact')); assert.ok(!raw.includes('derived private summary'));
  assert.equal((await org.memory.query({subject:LEAD,项目:P,id:summary.id})).条目.length,0);
  await assert.rejects(put(org,'late import',{来源引用:[a.id]}));
}));
it('parallel appends survive compaction; ordinary member cannot organize private memories', () => fixture(async org => {
  await put(org,'seed');
  await Promise.all([organize(org,{op:'compact'}), ...Array.from({length:8},(_,i)=>put(org,'parallel '+i))]);
  assert.equal((await org.memory.query({subject:LEAD,项目:P,类:'知识'})).条目.length,9);
  await assert.rejects(org.memory.organize({subject:MEMBER,op:'compact',原因:'test'}));
}));
it('pending replacement prevents partial reads; recovery rolls forward and refuses unknown writes', () => fixture(async org => {
  const a = await put(org,'old'); const before = await readFile(a.账本,'utf8');
  const rows = await readJsonl(a.账本); rows[0].内容='recovered';
  const journal={version:1,phase:'pending',operation:'update',owners:[{id:a.id,类:'知识',项目:P,归属:P}],at:org.clock.iso(),bytesBefore:before.length,changes:[{file:a.账本,before:digest(before),after:rows.map(JSON.stringify).join('\n')+'\n'}]};
  await atomicWrite(maintenanceFile(org.layout),JSON.stringify(journal));
  await assert.rejects(org.memory.query({subject:LEAD,项目:P}),{code:'MEMORY_MAINTENANCE_PENDING'});
  await organize(org,{op:'recover'});
  assert.equal((await org.memory.query({subject:LEAD,项目:P,id:a.id})).条目[0].内容,'recovered');
  await atomicWrite(maintenanceFile(org.layout),JSON.stringify(journal)); await atomicWrite(a.账本,before+'\n');
  await assert.rejects(organize(org,{op:'recover'}),{code:'MEMORY_MAINTENANCE_CONFLICT'});
}));
