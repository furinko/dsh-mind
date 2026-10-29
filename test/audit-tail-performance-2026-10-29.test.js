import { it } from 'node:test';
import assert from 'node:assert/strict';
import { open, writeFile, readFile, appendFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { AuditLog } from '../src/audit.js';
import { readJsonl, readJsonlTail } from '../src/kernel/fsx.js';
import { makeFixture, LEAD } from './helpers.mjs';

async function fixture(run) { const f = await makeFixture(); try { await run(f); } finally { await f.cleanup(); } }
const entry = id => ({ 动作: '状态变更', 主体: LEAD, 对象: { id } });

it('尾部读取与原JSONL读取对空白、BOM、坏行、无尾换行和跨块中文保持一致', () => fixture(async f => {
  const file = join(f.home, 'tail.jsonl');
  for (const text of ['', '\n \n', '{broken\n', '\ufeff{"seq":1}\r\n\n', '{"seq":1}\n{bad\n', '{"seq":1}\n{"seq":2}',
    JSON.stringify({ seq: 1, text: '🦋中文'.repeat(40000) }) + '\n {bad\n\n',
    '{"seq":1}\n' + 'malformed'.repeat(20000) + '\n']) {
    await writeFile(file, text); assert.deepEqual(await readJsonlTail(file), (await readJsonl(file)).at(-1) ?? null);
  }
  await rm(file); assert.equal(await readJsonlTail(file), null);
}));

it('大账本末尾读取有界，追加审计保留原账本字节且新记录可完整核验', t => fixture(async f => {
  const audit = new AuditLog({ layout: f.layout, clock: f.clock });
  // A single large historical event models a grown monthly shard without thousands of writes.
  const first = await audit.append({ ...entry('large'), 详情: { text: '历史'.repeat(600000) } });
  await audit.append(entry('small'));
  const month = f.clock.iso().slice(0, 7), file = f.layout.auditLog(month); const before = await readFile(file);
  const probe = await open(file, 'r'); const prototype = Object.getPrototypeOf(probe); const read = prototype.read; await probe.close();
  let readBytes = 0; let reads = 0;
  const spy = t.mock.method(prototype, 'read', async function(...args) {
    const result = await read.apply(this, args); readBytes += result.bytesRead; reads++; return result;
  });
  try { assert.equal((await audit.append(entry('third'))).seq, first.seq + 2); }
  finally { spy.mock.restore(); }
  assert.ok(reads > 0); assert.ok(readBytes <= 128 * 1024, `tail bytes ${readBytes}, shard bytes ${before.length}`);
  const after = await readFile(file); assert.ok(after.subarray(0, before.length).equals(before));
  assert.equal((await audit.verify()).ok, true);
}));

it('两个独立审计实例交错和并发追加不会复用旧尾或生成重复序号', () => fixture(async f => {
  const a = new AuditLog({ layout: f.layout, clock: f.clock }); const b = new AuditLog({ layout: f.layout, clock: f.clock });
  const baseline = (await readJsonlTail(f.layout.auditLog(f.clock.iso().slice(0, 7))))?.seq ?? 0;
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).append(entry(String(i)))));
  assert.deepEqual(results.map(r => r.seq).sort((x, y) => x - y), Array.from({ length: 20 }, (_, i) => baseline + i + 1));
  assert.equal((await b.verify()).ok, true);
}));

it('日志已追加但锚未提交的崩溃断面仍恢复到实际尾，截断仍拒绝续写', () => fixture(async f => {
  const audit = new AuditLog({ layout: f.layout, clock: f.clock }); const month = f.clock.iso().slice(0, 7);
  const first = await audit.append(entry('one')); const oldAnchor = await readFile(f.layout.auditAnchor(month));
  await audit.append(entry('two')); await writeFile(f.layout.auditAnchor(month), oldAnchor);
  const recovered = new AuditLog({ layout: f.layout, clock: f.clock });
  assert.equal((await recovered.append(entry('three'))).seq, first.seq + 2); assert.equal((await recovered.verify()).ok, true);
  const rows = (await readFile(f.layout.auditLog(month), 'utf8')).trimEnd().split('\n');
  await writeFile(f.layout.auditLog(month), rows[0] + '\n');
  await assert.rejects(recovered.append(entry('refused')), /截断|不一致/);
}));

it('尾部坏行仍留在原处，完整审计核验继续报告损坏', () => fixture(async f => {
  const audit = new AuditLog({ layout: f.layout, clock: f.clock }); const first = await audit.append(entry('one'));
  const file = f.layout.auditLog(f.clock.iso().slice(0, 7)); await appendFile(file, '{broken\n');
  assert.equal((await audit.append(entry('two'))).seq, first.seq + 1);
  assert.match(await readFile(file, 'utf8'), /\{broken\n/); assert.equal((await audit.verify()).ok, false);
}));
