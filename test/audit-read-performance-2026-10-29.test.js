import { it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rename, rm, stat, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { AuditLog } from '../src/audit.js';
import { AuditReadSnapshot } from '../src/audit-read-snapshot.js';
import { readJsonl } from '../src/kernel/fsx.js';
import { Org } from '../src/org.js';
import { makeFixture, LEAD } from './helpers.mjs';

const entry = id => ({ 动作: '状态变更', 主体: LEAD, 项目: 'read-audit', 对象: { id }, 依据: 'fixture' });
async function fixture(read) { const f = await makeFixture(); try { await read(f); } finally { await f.cleanup(); } }
const countVerify = audit => {
  const original = audit.verify.bind(audit); let count = 0;
  audit.verify = async () => { count++; return original(); }; return () => count;
};

it('只读投影跨轮共享同版本解析并合并并发读取，普通读及已结束的异步作用域仍读新数据', () => fixture(async f => {
  const audit = new AuditLog({ layout: f.layout, clock: f.clock }); await audit.append(entry('one'));
  const month = f.clock.iso().slice(0, 7), file = f.layout.auditLog(month), cache = new AuditReadSnapshot(f.layout); let loads = 0;
  const read = () => cache.read(month, () => { loads++; return readJsonl(file); });
  await cache.run(async () => {
    const rows = await Promise.all(Array.from({ length: 30 }, read)); assert.equal(loads, 1);
    assert.ok(rows.every(row => row === rows[0])); assert.ok(Object.isFrozen(rows[0].at(-1).主体));
    assert.throws(() => { rows[0].at(-1).对象.id = 'mutated'; }, TypeError);
  });
  await cache.run(read); assert.equal(loads, 1);
  const fresh = await read(); assert.equal(Object.isFrozen(fresh[0]), false); assert.equal(loads, 2);
  const go = Promise.withResolvers(); let background;
  await cache.run(async () => { background = (async () => { await go.promise; return read(); })(); });
  await audit.append(entry('two')); go.resolve(); assert.equal((await background).at(-1).对象.id, 'two');
  assert.equal(Object.isFrozen((await background)[0]), false);
}));

it('只读投影复用完整核验，直接verify和普通readVerified始终重验，外部返回值不会污染缓存', () => fixture(async f => {
  const audit = new AuditLog({ layout: f.layout, clock: f.clock }); await audit.append(entry('one')); const count = countVerify(audit);
  await audit.withReadSnapshot(() => audit.readVerified()); assert.equal(count(), 1);
  await audit.withReadSnapshot(() => audit.readVerified()); assert.equal(count(), 1);
  const ordinary = await audit.read(); ordinary.at(-1).对象.id = 'changed';
  assert.equal((await audit.withReadSnapshot(() => audit.readVerified())).at(-1).对象.id, 'one');
  await audit.verify(); assert.equal(count(), 2);
  await audit.readVerified(); assert.equal(count(), 3);
  const other = new AuditLog({ layout: f.layout, clock: f.clock }); await other.append(entry('two'));
  assert.equal((await audit.withReadSnapshot(() => audit.readVerified())).at(-1).对象.id, 'two'); assert.equal(count(), 4);
}));

it('同尺寸原地篡改并恢复mtime不能命中已核验缓存；原子替换也立即生效', () => fixture(async f => {
  const audit = new AuditLog({ layout: f.layout, clock: f.clock }); await audit.append(entry('one'));
  const file = f.layout.auditLog(f.clock.iso().slice(0, 7)), original = await readFile(file, 'utf8');
  await audit.withReadSnapshot(() => audit.readVerified()); const before = await stat(file);
  const changed = original.replace('fixture', 'tamper!'); assert.equal(changed.length, original.length);
  await writeFile(file, changed); await utimes(file, before.atime, before.mtime);
  await assert.rejects(audit.withReadSnapshot(() => audit.readVerified()), /完整性/);
  await writeFile(file, original); await audit.withReadSnapshot(() => audit.readVerified());
  const temp = file + '.replacement'; await writeFile(temp, changed); await rename(temp, file);
  await assert.rejects(audit.withReadSnapshot(() => audit.readVerified()), /完整性/);
}));

it('锚、月份清单、整月日志和新月份损坏均使已有绿色读取失效', () => fixture(async f => {
  const audit = new AuditLog({ layout: f.layout, clock: f.clock }); await audit.append(entry('one'));
  const month = f.clock.iso().slice(0, 7), log = f.layout.auditLog(month), anchor = f.layout.auditAnchor(month), manifest = f.layout.auditMonthManifest();
  const saved = new Map(await Promise.all([log, anchor, manifest].map(async file => [file, await readFile(file)])));
  const extra = join(f.layout.auditDir(), 'audit-2000-01.jsonl');
  const cases = [
    () => writeFile(anchor, '{broken'), () => rm(anchor), () => writeFile(manifest, '{broken'), () => rm(manifest), () => rm(log),
    () => writeFile(extra, saved.get(log)),
    async () => { const state = JSON.parse(saved.get(manifest)); state.checkpoints[month].seq += 100; await writeFile(manifest, JSON.stringify(state)); },
  ];
  for (const change of cases) {
    for (const [file, data] of saved) await writeFile(file, data); await rm(extra, { force: true });
    await audit.withReadSnapshot(() => audit.readVerified()); await change();
    await assert.rejects(audit.withReadSnapshot(() => audit.readVerified()), /完整性/);
  }
}));

it('完整核验后发生绕过锁的修改也不能发布绿色监控，后续读取保持拒绝', () => fixture(async f => {
  const audit = new AuditLog({ layout: f.layout, clock: f.clock }); await audit.append(entry('one'));
  const read = audit.read.bind(audit), file = f.layout.auditLog(f.clock.iso().slice(0, 7)); let once = true;
  audit.read = async (...args) => {
    const rows = await read(...args); if (once) { once = false; await writeFile(file, '{broken\n'); } return rows;
  };
  await assert.rejects(audit.withReadSnapshot(() => audit.readVerified()), /文件变化/);
  await assert.rejects(audit.withReadSnapshot(() => audit.readVerified()), /完整性/);
}));

it('真实工作台投影与原路径一致、结果可独立修改，重复轮询不重复核验，角色读域仍重算', () => fixture(async f => {
  const org = await Org.open({ ...f, project: 'read-audit' }); await org.audit.append(entry('one'));
  const snapshot = org.audit.withReadSnapshot.bind(org.audit); org.audit.withReadSnapshot = read => read();
  const original = await org.workbench(); org.audit.withReadSnapshot = snapshot;
  const count = countVerify(org.audit); const first = await org.workbench(); const second = await org.workbench();
  const normalize = view => { const copy = structuredClone(view); delete copy.生成于; return copy; };
  assert.deepEqual(normalize(first), normalize(original)); assert.deepEqual(normalize(second), normalize(first)); assert.equal(count(), 1);
  first.审计尾.at(-1).结果 = 'changed'; assert.notEqual(second.审计尾.at(-1).结果, 'changed');
  const sealed = await org.registry.identity();
  assert.ok(sealed.members[LEAD.id]);
  await org.registry.seal({ subject: { id: '主权者', kind: '主权者' }, 实例: LEAD.id, 理由: 'fixture' });
  const after = await org.workbench({ 读者: LEAD }); assert.equal(after.目标, null);
}));
