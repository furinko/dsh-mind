/**
 * 设计债㉘：探针快照保留策略（2026-10-17 批 · 节点 task-设计债批次实施-主权者-继续处理-yxu6r）。
 *
 * 债（登记+已办同批）：probe_run 每次落一个快照文件、无保留策略——真机 10 天 306 个，
 * 线性无限涨（挂账口径「心跳代盯 >200」已越过）。修法：run() 在本次巡检证据（快照+入账）
 * 落定之后 prune——触发线 200、滞回清回 150；**「最近全绿」永不在清理之列**（autoRollback
 * 「定位全绿的最近一版」的唯一目标来源）；清了多少入账（无留痕的自治变更 = 无效）；
 * 失败不吞（抛 ⇒ 巡检整体失败、账上留「工具调用失败」）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdir } from 'node:fs/promises';
import { makeFixture, LEAD } from './helpers.mjs';
import { ProbeRunner } from '../src/probes.js';

/** 夹具工厂：每用例自造自清（不共享——上一用例的种子快照会污染下一用例的计数）。 */
async function withFixture(options, fn) {
  const f = await makeFixture(options);
  try {
    return await fn(f);
  } finally {
    await f.cleanup();
  }
}

/**
 * 直接落种子快照（不经 run()）：文件名以 2024 打头，一定排在真实 run 快照（2026+）之前。
 * @param {Awaited<ReturnType<typeof makeFixture>>} f
 * @param {number} count
 * @param {number[]} greenIndexes 哪些序号是「全绿」
 */
async function seed(f, count, greenIndexes = []) {
  const names = [];
  for (let i = 0; i < count; i += 1) {
    const name = `2024-01-01T00-00-00Z-ret${String(i).padStart(4, '0')}.json`;
    await f.writePrivate(
      `升级/探针快照/${name}`,
      `${JSON.stringify({ 机制版本: 'seed', 于: '2024-01-01T00:00:00Z', 全绿: greenIndexes.includes(i), 结果: [], 见红: [] }, null, 2)}\n`,
    );
    names.push(name);
  }
  return names;
}

/** 目录里现存的快照文件名（排序后）。 */
async function listSnapshots(f) {
  return (await readdir(f.layout.probeSnapshotDir())).filter((n) => n.endsWith('.json')).sort();
}

describe('设计债㉘：探针快照保留策略', () => {
  it('㉘-回归：超限（>200）才动手，滞回清回 150，最旧先走、清量入账', async () => {
    await withFixture({}, async (f) => {
      const names = await seed(f, 205); // 全红种子 ⇒ 本次 run（全绿）是唯一的「最近全绿」
      const probes = new ProbeRunner({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, 无内核装配: true });
      const ran = await probes.run({ subject: LEAD });
      assert.equal(ran.全绿, true, '健康夹具上本次巡检应全绿（种子全红不影响探针本身）');
      const after = await listSnapshots(f);
      // 206 个（205 种子 + 1 新）> 200 ⇒ 清回 150：保留最新 150 = 种子 55..204 + 本次 run。
      assert.equal(after.length, 150, `滞回清理应清回 150；实际 ${after.length}`);
      assert.ok(!after.includes(names[0]) && !after.includes(names[55]), '最旧的必须先走');
      assert.ok(after.includes(names[56]) && after.includes(names.at(-1)), '窗口内的种子必须保留');
      const rows = await f.audit.read({});
      const 保留行 = rows.filter((r) => r.动作 === '快照保留').at(-1);
      assert.ok(保留行, '清了文件是自治的破坏性动作，必须留痕');
      assert.equal(保留行.详情.清了, 56);
      assert.equal(保留行.详情.现存, 150);
    });
  });

  it('㉘-保护最近全绿：见红长河里唯一的全绿是回滚目标，超限时永不被清', async () => {
    // 唯一全绿放在**最旧**（0 号），其余全红；再用幽灵撤回项把本次 run 也染红——
    // 这样「最近全绿」就是 0 号种子，正好落在清理窗口（最新 150）之外。
    await withFixture({ denylist: [{ id: 'ghost-card-x' }] }, async (f) => {
      const names = await seed(f, 205, [0]);
      const probes = new ProbeRunner({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, 无内核装配: true });
      const ran = await probes.run({ subject: LEAD });
      assert.equal(ran.全绿, false, '前置：撤回名单探针必须真的见红（否则「本次 run 也红」没成立）');
      assert.ok(ran.见红.some((r) => r.探针 === '撤回名单一致'));
      const after = await listSnapshots(f);
      // 206 > 200 ⇒ 清回 150；0 号全绿在窗口外但被保护 ⇒ 现存 151。
      assert.equal(after.length, 151, `保护 + 滞回 ⇒ 151；实际 ${after.length}`);
      assert.ok(after.includes(names[0]), '「最近全绿」是 autoRollback 回滚目标的唯一来源，永不在清理之列');
      assert.ok(!after.includes(names[1]), '非全绿的最旧照清');
    });
  });

  it('㉘-未超限不动盘：200 及以下不清理、不入账（保留行只在真删了文件时出现）', async () => {
    await withFixture({}, async (f) => {
      await seed(f, 199);
      const probes = new ProbeRunner({ layout: f.layout, policy: f.policy, audit: f.audit, clock: f.clock, 无内核装配: true });
      await probes.run({ subject: LEAD });
      const after = await listSnapshots(f);
      assert.equal(after.length, 200, '199 种子 + 1 新 = 200，未越过触发线（>200）⇒ 一个都不删');
      const rows = await f.audit.read({});
      assert.equal(rows.filter((r) => r.动作 === '快照保留').length, 0, '没删文件就没有保留行——不制造空转噪音');
    });
  });
});
