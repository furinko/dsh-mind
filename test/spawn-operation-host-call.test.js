import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { makeFixture, LEAD } from './helpers.mjs';
import { SpawnOperationService } from '../src/spawn-operations.js';
import { TaskGraph } from '../src/tasks.js';
import { foldSpawnOperationLedger, readSpawnOperationLedger, spawnOperationLogPath } from '../src/spawn-operation-ledger.js';
const P = 'host-call-ledger';
const call = (mode = 'subagent') => ({ 版本: 1, 工具: mode === 'subagent' ? 'subagent' : 'spawn_teammate', 调用id: 'mind-create-' + randomUUID() });
async function fixture(t) {
  const f = await makeFixture(); t.after(() => f.cleanup());
  const tasks = new TaskGraph(f), service = new SpawnOperationService(f);
  const task = await tasks.create({ subject: LEAD, 项目: P, 描述: 'Host call association', 负责人: ['member-a'], 判据: ['No side effects in domain tests'] });
  const input = { subject: LEAD, 项目: P, 任务: task.id, 方式: 'subagent', 请求摘要: 'a'.repeat(64) };
  const begin = extra => service.begin({ ...input, ...extra });
  const record = (id, receipt) => service.record({ 项目: P, 操作id: id, 阶段: 'host_returned', 回执: receipt });
  const rows = () => readSpawnOperationLedger(spawnOperationLogPath(f.layout, P), P);
  return { f, tasks, service, input, begin, record, rows };
}
for (const mode of ['subagent', 'team']) test(`Host allocated ${mode} persists exact call before accepting actual id`, async t => {
  const f = await fixture(t), hostCall = call(mode);
  const intent = await f.begin({ 方式: mode, 宿主调用: hostCall });
  assert.equal(intent.拟用实例, null); assert.equal(intent.可创建, true); assert.deepEqual(intent.宿主调用, hostCall);
  const receipt = { 实例: 'actual-host-id', 初始消息id: null, 团队名: mode === 'team' ? 'synthetic' : null, 宿主调用id: hostCall.调用id };
  await f.record(intent.操作id, receipt);
  const replay = await new SpawnOperationService(f.f).begin({ ...f.input, 方式: mode, 宿主调用: call(mode) });
  assert.equal(replay.可创建, false); assert.deepEqual(replay.宿主调用, hostCall);
  assert.equal(f.service.findByTask(P, f.input.任务).阶段[1].回执.实例, 'actual-host-id');
  assert.equal((await f.rows()).length, 2);
});
test('wrong or absent Host call receipt cannot replace matching association', async t => {
  const f = await fixture(t), hostCall = call(), intent = await f.begin({ 宿主调用: hostCall });
  const receipt = { 实例: 'child', 初始消息id: null, 团队名: null };
  await assert.rejects(f.record(intent.操作id, receipt));
  await assert.rejects(f.record(intent.操作id, { ...receipt, 宿主调用id: call().调用id }));
  assert.equal((await f.rows()).length, 1);
  await f.record(intent.操作id, { ...receipt, 宿主调用id: hostCall.调用id });
  const rows = await f.rows(); rows[1].回执.宿主调用id = call().调用id;
  assert.throws(() => foldSpawnOperationLedger(rows, P));
});
test('old reserved-id rows remain strict; adding new call metadata cannot relax them', async t => {
  const f = await fixture(t), intent = await f.begin();
  const receipt = { 实例: 'not-the-reserved-id', 初始消息id: null, 团队名: null };
  await assert.rejects(f.record(intent.操作id, receipt));
  await assert.rejects(f.record(intent.操作id, { ...receipt, 实例: intent.拟用实例, 宿主调用id: call().调用id }));
  await f.record(intent.操作id, { ...receipt, 实例: intent.拟用实例 });
  assert.equal((await f.rows()).length, 2);
});
test('malformed protocol metadata is rejected before intent append', async t => {
  const f = await fixture(t);
  for (const bad of [null, {}, { ...call(), 版本: 2 }, call('team'), { ...call(), 调用id: 'claimed' }, { ...call(), extra: true }]) await assert.rejects(f.begin({ 宿主调用: bad }));
  assert.equal((await f.rows()).length, 0);
});
test('same call cannot be appended for another task, leaving the ledger readable', async t => {
  const f = await fixture(t), hostCall = call();
  await f.begin({ 宿主调用: hostCall });
  const other = await f.tasks.create({ subject: LEAD, 项目: P, 描述: 'Another isolated task', 负责人: ['member-a'], 判据: ['distinct host call'] });
  await assert.rejects(f.begin({ 任务: other.id, 宿主调用: hostCall }));
  assert.equal((await f.rows()).length, 1);
  assert.equal(f.service.findByTask(P, f.input.任务).状态, 'intent');
});

test('duplicated call ids or mixing reserved and allocated protocols fail closed on fold', async t => {
  const f = await fixture(t);
  await f.begin({ 宿主调用: call() });
  const rows = await f.rows(), duplicate = structuredClone(rows[0]);
  duplicate.seq = 2; duplicate.操作id = randomUUID(); duplicate.任务 = 'different-task';
  assert.throws(() => foldSpawnOperationLedger([...rows, duplicate], P));
  rows[0].拟用实例 = randomUUID();
  assert.throws(() => foldSpawnOperationLedger(rows, P));
});
