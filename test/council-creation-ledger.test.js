/* Domain protocol tests: generated identifiers below are NOT Host creation evidence. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
import { CouncilService, foldCouncils } from '../src/council.js';
import { COUNCIL_CREATION_RECORDER as recorder } from '../src/council-creation-ledger.js';
const P = 'council-creation-ledger';
const call = mode => ({ 版本: 1, 工具: mode === 'team' ? 'spawn_teammate' : 'subagent', 调用id: `mind-create-${randomUUID()}` });
function intent({ id = 'council-one', 序号 = 1, 方式 = 'subagent', 宿主调用 = call(方式) } = {}) {
  return { kind: 'creation_intent', id, 来源会话: LEAD.id, 方式, 岗位: '插件工程', 序号, 宿主调用,
    by: LEAD, at: '2026-11-09T03:00:00.000Z', eventId: randomUUID() };
}
function returned(i, instance = 'child-one') {
  return { kind: 'creation_returned', id: i.id, 宿主调用id: i.宿主调用.调用id, 实例: instance,
    团队名: i.方式 === 'team' ? 'team-' + instance : null, by: recorder, at: i.at, eventId: randomUUID() };
}
const bad = rows => assert.throws(() => foldCouncils(rows), e => e.code === 'COUNCIL_CREATION_LEDGER_INVALID');

for (const mode of ['subagent', 'team']) test(`intent/return/opened remains three distinct facts (${mode})`, () => {
  const a = intent({ 方式: mode }), b = intent({ 方式: mode, 序号: 2 });
  assert.equal(foldCouncils([a])[0].创建调用[0].实例, null);
  const rows = [a, returned(a), b, returned(b, 'child-two')];
  const pending = foldCouncils(rows)[0];
  assert.equal(pending.状态, '创建中'); assert.deepEqual(pending.参与者, []);
  const opened = { kind: 'opened', id: a.id, 来源会话: LEAD.id, 问题: 'test', 参与者: ['child-one', 'child-two'],
    创建实例: [{ 实例: 'child-one', 岗位: '插件工程' }, { 实例: 'child-two', 岗位: '插件工程' }], at: a.at };
  assert.equal(foldCouncils([...rows, opened])[0].状态, '作答中');
  bad([...rows, { ...opened, 创建实例: [] }]);
  bad([...rows, opened, intent({ 方式: mode, 序号: 3 })]);
});

for (const [name, change] of [
  ['extra field', i => { i.拟用实例 = 'guessed'; }],
  ['false source', i => { i.来源会话 = 'other'; }],
  ['wrong actor', i => { i.by = recorder; }],
  ['wrong mode', i => { i.方式 = 'team'; }],
  ['wrong call shape', i => { i.宿主调用.消息id = 'fabricated'; }],
  ['wrong sequence', i => { i.序号 = 2; }],
  ['wrong date', i => { i.at = 'bad-date'; }],
  ['unknown event', i => { i.kind = 'creation_fabricated'; }],
]) test(`closed creation protocol rejects ${name}`, () => { const i = intent(); change(i); bad([i]); });

test('duplicate call IDs, pending calls and mismatched returns cannot be replayed', () => {
  const i = intent(), r = returned(i);
  bad([i, i]); bad([i, returned(intent())]); bad([i, r, r]);
  bad([i, intent({ 序号: 2 })]);
  bad([i, r, intent({ id: 'another-council', 宿主调用: i.宿主调用 })]);
  const second = intent({ 序号: 2 }); bad([i, r, second, returned(second, r.实例)]);
  bad([i, { ...r, by: LEAD }]);
});

test('interrupted creation remains incomplete; halting never certifies a child stop', () => {
  const i = intent(), halted = { kind: 'creation_halted', id: i.id, 阶段: 'create', by: recorder, at: i.at, eventId: randomUUID() };
  const view = foldCouncils([i, halted])[0];
  assert.equal(view.状态, '创建未完成'); assert.equal(view.创建调用[0].状态, 'intent');
  assert.equal(view.创建调用[0].实例, null); assert.equal(view.创建调用[0].已停止, undefined);
  bad([i, halted, returned(i)]); bad([i, halted, intent({ 序号: 2 })]);
  assert.equal(foldCouncils([{ kind: 'opened', id: 'historical', 问题: 'legacy', 参与者: ['a', 'b'] }])[0].状态, '作答中');
});

async function setup(t) {
  const f = await makeFixture(); t.after(() => f.cleanup());
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: P });
  const i = intent();
  const begin = () => org.council.recordCreationIntent({ subject: LEAD, 项目: P, 会审: i.id,
    方式: i.方式, 岗位: i.岗位, 序号: i.序号, 宿主调用: i.宿主调用 });
  return { f, org, i, begin };
}

test('two contenders commit one intent; a fresh service reads it and cannot append it again', async t => {
  const s = await setup(t), results = await Promise.allSettled([s.begin(), s.begin()]);
  assert.equal(results.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(results.filter(x => x.status === 'rejected').length, 1);
  const restarted = new CouncilService(s.org.council);
  const view = await restarted.get(P, s.i.id);
  assert.equal(view.创建调用.length, 1); assert.equal(view.创建调用[0].实例, null);
  await assert.rejects(s.begin, e => e.code === 'COUNCIL_CREATION_LEDGER_INVALID');
  const before = await readFile(s.org.layout.councilLog(P), 'utf8');
  await assert.rejects(() => restarted.recordCreationReturn({ 项目: P, 会审: s.i.id,
    宿主调用id: call('subagent').调用id, 实例: 'unknown', 团队名: null }));
  assert.equal(await readFile(s.org.layout.councilLog(P), 'utf8'), before, 'invalid event is rejected before append');
});

for (const corruption of ['bad-line', 'complete-json-no-newline', 'null-row']) test(`corrupt journal is never skipped (${corruption})`, async t => {
  const s = await setup(t); await s.begin();
  const file = s.org.layout.councilLog(P), original = await readFile(file, 'utf8');
  const broken = corruption === 'bad-line' ? original + '{broken\n' : corruption === 'null-row' ? original + 'null\n' : original.trimEnd();
  await writeFile(file, broken, 'utf8');
  await assert.rejects(() => s.org.council.get(P, s.i.id), e => e.code === 'COUNCIL_CREATION_LEDGER_INVALID');
  await assert.rejects(s.begin, e => e.code === 'COUNCIL_CREATION_LEDGER_INVALID');
  assert.equal(await readFile(file, 'utf8'), broken);
});
