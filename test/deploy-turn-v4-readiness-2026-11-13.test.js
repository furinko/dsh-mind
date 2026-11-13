import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Org } from '../src/org.js';
import { canonical, digest } from '../src/kernel/text.js';
import { makeFixture, LEAD } from './helpers.mjs';
import { createTurnBufferHooks } from '../components/kernel/lib/turn-buffer-hooks.js';
import { projectTurnSurfaceEvent } from '../src/turn-buffer.js';
import { turnBufferLayoutVersion } from '../scripts/check-deployment-layout.mjs';

const project = 'deploy-v4';
async function scene(run) {
  const f = await makeFixture(); const org = await Org.open({ ...f, project });
  const spec = { subject: LEAD, project, session: LEAD.id };
  try { await run({ f, org, spec }); } finally { await org.observability.flush(); await f.cleanup(); }
}
function oldState(org, extra = {}) {
  const at = org.clock.ms() - 30 * 86400000;
  return { version: 1, project, session: LEAD.id, nextSeq: 4, floor: 2, missing: 3, removed: 5,
    open: null, rounds: [{ turn: 1, start: 2, at, status: 'closed', reason: 'completed',
      messages: [{ seq: 2, anchor: 2, role: 'user', id: 'legacy-original', text: 'OLD_PRIVATE_FULL_BODY'.repeat(5000), clipped: false, interrupted: false, at }] }, {turn:2,start:3,at,status:'closed',reason:'completed',messages:[]}], ...extra };
}
const append = (seq, turn, now) => [
  { seq, type: 'turn/start', turn, time: now },
  { seq:seq+1, type:'message', role:'user', id:'new-'+turn, text:'new experience '+turn, clipped:false, interrupted:false, turn, time:now },
  { seq:seq+2, type:'turn/end', turn, reason:'completed', time:now },
];

it('implicit migration preserves every old round across consecutive captures, reads and maintenance for seven days', () => scene(async ({ org, spec }) => {
  const file = org.turnBuffer.file(project, LEAD.id); const legacy = oldState(org);
  const original = JSON.stringify(legacy, null, 2).replace(/\n/g, '\r\n') + '\r\n';
  await org.turnBuffer.capture({...spec,records:[],fromSeq:0,throughSeq:0}); // create fixture directory only
  await writeFile(file, original);
  assert.equal((await org.turnBuffer.readOriginal({...spec,id:'legacy-original'})).找到,true,'legacy read itself must not trim old text');
  const now=org.clock.ms();
  await org.turnBuffer.capture({...spec,records:append(4,3,now),fromSeq:4,throughSeq:7});
  await org.turnBuffer.capture({...spec,records:append(7,4,now),fromSeq:7,throughSeq:10});
  await org.turnBuffer.maintain(spec);
  const current = await org.turnBuffer.load(project, LEAD.id);
  assert.equal(canonical(current.rounds[0]),canonical(legacy.rounds[0]),'original body, order, time, source and status are unchanged');
  assert.equal(canonical(current.rounds[1]),canonical(legacy.rounds[1]),'closed empty round retains its state and position through grace');
  assert.equal(current.floor,2); assert.equal(current.missing,3); assert.equal(current.removed,5);
  assert.equal(current.owner,undefined,'legacy missing owner is not retroactively fabricated');
  assert.equal(current.legacyMigration.ownerMissing,true); assert.equal(current.legacyMigration.throughSeq,4);
  assert.ok(current.coverageGaps.some(gap=>gap.kind==='legacy-owner-unknown'));
  assert.equal((await org.turnBuffer.readOriginal({...spec,id:'legacy-original'})).原文长度,legacy.rounds[0].messages[0].text.length);
  const backup=JSON.parse(await readFile(file+'.migration-backup','utf8'));
  assert.equal(backup.original,original); assert.equal(backup.originalHash,digest(original)); assert.equal(backup.postMigrationWrites,true);
  await assert.rejects(org.turnBuffer.rollbackMigration(spec),{code:'TURN_ROLLBACK_NEW_WRITES'});
  org.clock._source=()=>new Date(now+8*86400000); await org.registry.markInteraction({来源:'部署引导'});
  await org.turnBuffer.maintain(spec);
  const afterGrace = await org.turnBuffer.load(project,LEAD.id);
  assert.equal(afterGrace.rounds.length,4,'回退副本到期不能删除原始经历或空轮状态');
  assert.equal(canonical(afterGrace.rounds[0]),canonical(legacy.rounds[0]));
  assert.equal(canonical(afterGrace.rounds[1]),canonical(legacy.rounds[1]));
  await assert.rejects(readFile(file+'.migration-backup'),{code:'ENOENT'});
  assert.equal((await org.turnBuffer.readOriginal({...spec,id:'legacy-original',limit:24000})).原文长度,legacy.rounds[0].messages[0].text.length);
}));

it('explicit lossless migration can restore original bytes but never lowers the global v4 old-reader barrier', () => scene(async ({ org, spec }) => {
  const file=org.turnBuffer.file(project,LEAD.id); await org.turnBuffer.capture({...spec,records:[],fromSeq:0,throughSeq:0});
  const legacy=oldState(org,{owner:{kind:'Lead',project,session:LEAD.id}}); const original=JSON.stringify(legacy)+'\r\n'; await writeFile(file,original);
  await org.turnBuffer.migrate(spec); const migrated=await org.turnBuffer.load(project,LEAD.id);
  assert.equal(canonical(migrated.rounds),canonical(legacy.rounds)); assert.equal(canonical(migrated.owner),canonical(legacy.owner));
  assert.equal(await turnBufferLayoutVersion(org.layout.privateRoot),4);
  await org.turnBuffer.rollbackMigration(spec); assert.equal(await readFile(file,'utf8'),original);
  assert.equal(await turnBufferLayoutVersion(org.layout.privateRoot),4,'one restored buffer is not a whole-store downgrade proof');
}));

it('source replay preserves already held expired external messages before the v4 grace boundary', () => scene(async ({ org, spec }) => {
  const at=org.clock.ms()-30*86400000;
  const events=[{seq:0,time:at,type:'turn/start',data:{turn:1}},
    {seq:1,time:at,type:'user/message',surfaceOp:'append',data:{id:'external-held',role:'user',source:{kind:'plugin:synthetic',mindExternal:{version:1,contentType:'conversation',channel:'chat'}},content:[{type:'text',text:'HELD_OLD_EXTERNAL'}]}},
    {seq:2,time:at,type:'turn/end',data:{turn:1,reason:{kind:'completed'}}}];
  const nodes=[],context={}; const records=events.map(e=>projectTurnSurfaceEvent(e,nodes,context));
  await org.turnBuffer.capture({...spec,records:records.map(row=>({...row,time:org.clock.ms()})),fromSeq:0,throughSeq:3});
  const legacy=await org.turnBuffer.load(project,LEAD.id); legacy.version=3; legacy.sourceProjection=2;
  for(const round of legacy.rounds){round.at=at;for(const message of round.messages)message.at=at;}
  await writeFile(org.turnBuffer.file(project,LEAD.id),JSON.stringify(legacy));
  const session={id:LEAD.id,header:{id:LEAD.id,cwd:process.cwd()},inheritedEventCount:0,seq:3,surface:{nodes:[1]},isOwnSeq:seq=>seq>=0&&seq<3,eventAt:seq=>events[seq]};
  const query={async observeSession(){return{source:'live',header:session.header,inheritedEventCount:0,cursor:2,events,[Symbol.dispose](){}};}};
  const hooks=createTurnBufferHooks({org,projectOf:()=>project,queryOf:()=>query,logger:{warn(){}}});
  try { await hooks.sync(session); } finally { await hooks.flush(); }
  const current=await org.turnBuffer.load(project,LEAD.id);
  assert.equal(current.rounds[0].messages[0].text,'HELD_OLD_EXTERNAL');
  assert.equal(current.rounds[0].messages[0].at,at);
  assert.equal(current.sourceProjection,3); assert.equal(current.version,4);
}));

it('compatibility probe detects v4 parts and manifest headers despite an earlier development marker of three', () => scene(async ({ org, spec }) => {
  await org.turnBuffer.capture({...spec,records:append(0,1,org.clock.ms()),fromSeq:0,throughSeq:3});
  const marker=join(org.layout.memoryRoot(),'external-conversation-layout.json');
  await writeFile(marker,JSON.stringify({version:3}));
  assert.equal(await turnBufferLayoutVersion(org.layout.privateRoot),4);
  const file=org.turnBuffer.file(project,LEAD.id), manifest=JSON.parse(await readFile(file,'utf8'));
  for(const part of manifest.parts) await rm(file+'.part-'+part);
  assert.equal(await turnBufferLayoutVersion(org.layout.privateRoot),4,'missing parts are corruption, never proof that the old format is safe');
}));
