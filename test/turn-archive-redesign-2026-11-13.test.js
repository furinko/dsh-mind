import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Org } from '../src/org.js';
import { projectTurnEvent, projectTurnSurfaceEvent } from '../src/turn-buffer.js';
import { makeFixture, LEAD } from './helpers.mjs';

const project = 'archive-redesign';
async function scene(run) {
  const f = await makeFixture();
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project });
  const spec = { subject: LEAD, project, session: LEAD.id };
  try { await run({ org, f, spec }); } finally { await org.observability.flush(); await f.cleanup(); }
}
const message = (seq, text, id = `m-${seq}`) => projectTurnEvent({ seq, time: Date.now(), type: 'user/message', surfaceOp: 'append',
  data: { role: 'user', id, source: { kind: 'user' }, content: [{ type: 'text', text }] } });

it('140轮与超长多块正文逐字恢复，重开不重放且预算投影与保存独立', async () => scene(async ({ org, f, spec }) => {
  const long = '开头🙂' + '中段🙂汉字'.repeat(20000) + '结尾😀'; const records = [];
  for (let turn = 1; turn <= 140; turn++) {
    records.push({ seq: records.length, type: 'turn/start', turn, time: org.clock.ms() });
    records.push(message(records.length, turn === 70 ? long : `第${turn}轮`, `round-${turn}`));
    records.push({ seq: records.length, type: 'turn/end', turn, reason: 'completed', time: org.clock.ms() });
  }
  await org.turnBuffer.capture({ ...spec, records, fromSeq: 0, throughSeq: records.length });
  const file = org.turnBuffer.file(project, spec.session);
  for (const part of JSON.parse(await readFile(file, 'utf8')).parts) {
    const chunk = JSON.parse(await readFile(`${file}.part-${part}`, 'utf8'));
    assert.equal(Buffer.from(chunk, 'utf8').toString('utf8'), chunk, '分块不拆开Unicode代理对，也不引入哈希替代字符');
  }
  const reopened = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project });
  const state = await reopened.turnBuffer.load(project, spec.session);
  assert.equal(state.rounds.length, 140); assert.equal(state.rounds[69].messages[0].text, long);
  let result = ''; let textOffset = 0; let version;
  do {
    const page = await reopened.turnBuffer.readOriginal({ ...spec, id: 'round-70', textOffset, limit: 8192, dataVersion: version });
    version = page.数据版本; result += page.文本; textOffset = page.下次文本偏移;
  } while (textOffset !== null);
  assert.equal(result, long);
  const frame = await reopened.turnBuffer.read({ ...spec, id: 'round-70', budget: 100 });
  assert.equal(frame.轮次[0].消息[0].文本.length, 100); assert.equal(frame.截断, true);
  await reopened.turnBuffer.capture({ ...spec, records, fromSeq: 0, throughSeq: records.length });
  assert.equal((await reopened.turnBuffer.load(project, spec.session)).rounds.length, 140);
}));

it('公开工具事实、完整结果与附件保留声明；不保存隐藏推理或原始模型流', async () => scene(async ({ org, spec }) => {
  const result = '工具开头' + '返回值'.repeat(25000) + '工具结尾';
  const events = [
    { seq: 0, type: 'turn/start', data: { turn: 1 } },
    { seq: 1, type: 'tool/call', data: { turn: 1, callId: 'call-1', name: 'fixture', arguments: { file: 'synthetic.txt' }, stream: 'HIDDEN_STREAM' } },
    { seq: 2, type: 'tool/result', surfaceOp: 'append', data: { turn: 1, message: { role: 'tool', id: 'result-1', toolCallId: 'call-1', content: [{ type: 'text', text: result }] } } },
    { seq: 3, type: 'user/message', surfaceOp: 'append', data: { role: 'user', id: 'attachment', source: { kind: 'user' },
      content: [{ type: 'file', url: 'https://fixture.invalid/temporary', name: 'synthetic.pdf' }, { type: 'reasoning', text: 'HIDDEN_THINKING' }] } },
  ];
  const nodes = []; const context = {};
  await org.turnBuffer.capture({ ...spec, records: events.map(e => projectTurnSurfaceEvent(e, nodes, context)), fromSeq: 0, throughSeq: 4 });
  const state = await org.turnBuffer.load(project, spec.session);
  assert.equal(state.rounds[0].messages[0].public.arguments.file, 'synthetic.txt');
  assert.equal(state.rounds[0].messages[1].text, result);
  const attachment = await org.turnBuffer.readOriginal({ ...spec, id: 'attachment', part: 'public' });
  assert.equal(attachment.缺口[0].status, 'retention-unverified');
  assert.equal(JSON.parse(attachment.文本).content[0].name, 'synthetic.pdf');
  assert.doesNotMatch(JSON.stringify(state), /HIDDEN_THINKING|HIDDEN_STREAM/);
}));

it('维护只清冗余副本，不因暂停删除完整轮次；明确遗忘仍清正文并阻断迟到回灌', async () => scene(async ({ org, spec }) => {
  const records = [
    { seq: 0, type: 'turn/start', turn: 1 }, message(1, '暂停正文'.repeat(25000)), { seq: 2, type: 'turn/end', turn: 1, reason: 'completed' },
    { seq: 3, type: 'turn/start', turn: 2 }, message(4, '长期保留经历'), { seq: 5, type: 'turn/end', turn: 2, reason: 'completed' },
    { seq: 6, type: 'turn/start', turn: 3 }, message(7, '尚未完成'),
  ];
  await org.turnBuffer.capture({ ...spec, records, fromSeq: 0, throughSeq: 8 });
  await org.turnBuffer.retain({ ...spec, start: 3 });
  const file = org.turnBuffer.file(project, spec.session);
  const before = (await org.turnBuffer.storageUsage(spec)).总字节;
  await writeFile(`${file}.tmp-1234-abcd`, '临时私人副本');
  org.clock._source = () => new Date(Date.now() + 180 * 86400000);
  await org.registry.markInteraction({ 来源: '部署引导' }); // synthetic maintenance owner remains present
  await org.turnBuffer.maintain(spec);
  const kept = await org.turnBuffer.load(project, spec.session);
  assert.deepEqual(kept.rounds.map(r => r.messages[0].text), ['暂停正文'.repeat(25000), '长期保留经历', '尚未完成']);
  assert.ok((await org.turnBuffer.storageUsage(spec)).总字节 <= before);
  await assert.rejects(readFile(`${file}.tmp-1234-abcd`), { code: 'ENOENT' });
  await org.turnBuffer.forget({ ...spec, throughSeq: 8 });
  await org.turnBuffer.capture({ ...spec, records, fromSeq: 0, throughSeq: 8 });
  assert.deepEqual((await org.turnBuffer.load(project, spec.session)).rounds, []);
  for (const name of await readdir(dirname(file))) {
    if (name.startsWith(file.split(/[\\/]/).at(-1))) assert.doesNotMatch(await readFile(join(dirname(file), name), 'utf8'), /暂停正文|长期保留经历|尚未完成|临时私人副本/);
  }
}));

it('迁移中断可续，旧缺口不伪造，新写入阻止旧副本覆盖且回退副本到期实际删除', async () => scene(async ({ org, spec }) => {
  const file = org.turnBuffer.file(project, spec.session);
  await org.turnBuffer.capture({ ...spec, records: [message(0, '旧正文', 'old')], fromSeq: 0, throughSeq: 1 });
  const legacy = await org.turnBuffer.load(project, spec.session); legacy.version = 1;
  const legacyBytes = JSON.stringify(legacy, null, 2) + '\n';
  await writeFile(file, legacyBytes);
  const save = org.turnBuffer.saveState;
  org.turnBuffer.saveState = async () => { throw Object.assign(new Error('synthetic interruption'), { code: 'EIO' }); };
  await assert.rejects(org.turnBuffer.migrate(spec), { code: 'EIO' });
  assert.equal((await org.turnBuffer.load(project, spec.session)).version, 1);
  org.turnBuffer.saveState = save;
  const receipt = await org.turnBuffer.migrate(spec); assert.equal(receipt.已迁移, true);
  assert.match(receipt.缺口[0].detail, /不能凭空恢复/);
  await org.turnBuffer.rollbackMigration(spec);
  assert.equal(await readFile(file, 'utf8'), legacyBytes);
  assert.equal((await org.turnBuffer.load(project, spec.session)).version, 1);
  await org.turnBuffer.migrate(spec);
  await org.turnBuffer.capture({ ...spec, records: [message(1, '新写入必须保留', 'new')], fromSeq: 1, throughSeq: 2 });
  await assert.rejects(org.turnBuffer.rollbackMigration(spec), { code: 'TURN_ROLLBACK_NEW_WRITES' });
  org.clock._source = () => new Date(Date.now() + 8 * 86400000);
  await org.registry.markInteraction({ 来源: '部署引导' }); // synthetic maintenance owner remains present
  await org.turnBuffer.maintain(spec);
  await assert.rejects(readFile(file + '.migration-backup'), { code: 'ENOENT' });
  assert.equal((await org.turnBuffer.load(project, spec.session)).rounds.flatMap(r => r.messages).at(-1).text, '新写入必须保留');
}));
