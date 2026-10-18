/**
 * Batch 4a · 提交前总复核挑出的必修项（宿主侧）。
 *
 * 三条都是「读数面」的缺陷，共同点是**看得见的那一层与实际机制不一致**：
 *  - F1 `presence()` 在**开关打开**时不返回 `失联限制` 键 ⇒ 设置页把它显示成「未知」，
 *       而且每一次「开关=是」都被回读判据报成「没写进去」（写其实成功了）；
 *  - F3 `状态条.闸.错误` 恒 null（投影读 `错误`，唯一生产者给的是 `error`）⇒ 面板永远拿不到错误原文；
 *  - F4 `lastInteraction` 是**合法但贴近 Date 上界**的时刻时，`presence()` 抛 RangeError ⇒
 *       `/mind status` 与 `/mind workbench` 双双失败，而引擎还报 healthy。
 *
 * 每条断言先证明能变红：红证据见 `E:\dsh-mind-backup\batch4a-red-evidence.txt`。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeFixture, writeUnder } from './helpers.mjs';
import { readTextOrNull } from '../src/kernel/fsx.js';
import { fakeHost, fakeExec } from './host-harness.mjs';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';
import * as kernel from '../components/kernel/lib/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const FACTORY = join(here, '..', 'mind');
const 部署偏好 = '集体L2-共享基础设施/defaults/部署.json';
/** Date 能表示的最大时刻（加上任何正的小时数都会溢出）。 */
const DATE_MAX_ISO = '+275760-09-13T00:00:00.000Z';
const 前 = (小时) => new Date(Date.now() - 小时 * 3600_000).toISOString();

async function 起宿主() {
  const home = await mkdtemp(join(tmpdir(), 'mind-readout-'));
  const host = fakeHost();
  await kernel.apply(host.ctx, { home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
  const org = await shareOrg({ home, factoryRoot: FACTORY, privateRoot: join(home, 'mind-private') });
  await org.policy.reload();
  return {
    home,
    host,
    org,
    命令: host.命令.get('mind'),
    工具: host.工具.get('mind'),
    文件: org.layout.deploymentPrefs(),
    写私有: (rel, text) => writeUnder(join(home, 'mind-private'), rel, text),
    清理: async () => {
      host.清理();
      forgetSharedOrg();
      await rm(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 60 });
    },
  };
}

async function 敲(t, rawInput, agent = {}) {
  const 回复 = await t.命令.handler({ agent, rawInput });
  return { 回复, 包: JSON.parse(回复.text) };
}

describe('Batch 4a：读数的键与错误原文必须真的到位', () => {
  // ── F1 `失联限制` 键恒在（开状态也要有）────────────────────────────────────
  it('F1a 开状态（出厂默认 true）⇒ presence() 必须带 `失联限制: true`', async () => {
    const t = await 起宿主();
    try {
      const p = t.org.policy.presence();
      assert.ok(Object.hasOwn(p, '失联限制'), `开状态下必须返回 失联限制 键（实际键：${Object.keys(p).join(', ')}）`);
      assert.equal(p.失联限制, true, '开关开着 ⇒ 失联限制 是 true');
      assert.equal(p.lost, false, '前提：主权者刚启动过，没失联');
      // 键存在 ≠ 值对：来源与生效期限也一起核（别为了补键把别的字段弄丢）。
      assert.equal(p.生效响应期限小时, 72);
      assert.equal(p.响应期限小时来源, '出厂');
      assert.equal(p.失联限制来源, '出厂');
    } finally {
      await t.清理();
    }
  });

  it('F1b 开状态经 `/mind presence` 与 `/mind status` 也带这个键（人能看见的那一层）', async () => {
    const t = await 起宿主();
    try {
      const 读 = await 敲(t, 'presence');
      assert.equal(读.包.成功, true, 读.回复.text);
      assert.ok(Object.hasOwn(读.包.读数, '失联限制'), `命令面读数必须有这个键：${JSON.stringify(读.包.读数)}`);
      assert.equal(读.包.读数.失联限制, true);

      const 状态 = await 敲(t, 'status');
      assert.equal(状态.包.成功, true, 状态.回复.text);
      assert.ok(Object.hasOwn(状态.包.数据.失联, '失联限制'), 'status 的失联读数也要有');
      assert.equal(状态.包.数据.失联.失联限制, true);

      const 工具 = JSON.parse(await t.工具.execute({ action: 'status' }, fakeExec({ name: 'mind' })));
      assert.equal(工具.成功, true);
      assert.equal(工具.数据.失联.失联限制, true, '模型侧同一条路：读数形状必须一致');
    } finally {
      await t.清理();
    }
  });

  it('F1c 写「开关=是」之后回读仍带 `失联限制: true`（回读判据不许被放宽）', async () => {
    const t = await 起宿主();
    try {
      // 先写「否」，再写「是」——「是」这一次正是复核官实测被误报「没写进去」的那一步。
      assert.equal((await 敲(t, 'presence 开关=否 小时=168')).包.成功, true);
      assert.equal(t.org.policy.presence().失联限制, false, '关状态本来是好的');
      const 是 = await 敲(t, 'presence 开关=是 小时=72');
      assert.equal(是.包.成功, true, 是.回复.text);
      assert.equal(是.包.读数.失联限制, true, '写「是」的回读必须读得出 true（否则设置页会报「没写进去」）');
      assert.equal(Object.hasOwn(是.包.读数, '失联限制'), true);
      assert.equal(t.org.policy.presence().失联限制, true);
      assert.equal(JSON.parse(await readTextOrNull(t.文件)).失联限制, true, '盘上也确实是 true');
    } finally {
      await t.清理();
    }
  });

  it('F1d 含糊值（"false" / 0 / null）⇒ 键仍在且是 true（fail-safe 不许摘掉开关）', async () => {
    for (const 含糊 of ['false', 0, null]) {
      const g = await makeFixture({ presence: { 失联限制: 含糊, 响应期限小时: 1 } });
      try {
        const p = g.policy.presence();
        const 标注 = JSON.stringify(含糊);
        assert.ok(Object.hasOwn(p, '失联限制'), `${标注}：键也必须恒在`);
        assert.equal(p.失联限制, true, `${标注}：含糊值不是严格 false ⇒ 开关保持开着`);
        assert.notEqual(p.已关闭, true, `${标注}：含糊值不许被当成「关了」`);
      } finally {
        await g.cleanup();
      }
    }
  });

  it('F1e 关状态照旧：`失联限制: false` + `已关闭: true`（别把修好的那一半弄坏）', async () => {
    const g = await makeFixture({ presence: { 失联限制: false, 响应期限小时: 1 } });
    try {
      const p = g.policy.presence();
      assert.equal(p.失联限制, false);
      assert.equal(p.已关闭, true);
      assert.equal(p.lost, false);
    } finally {
      await g.cleanup();
    }
  });

  // ── F3 `状态条.闸.错误` 不许恒 null ────────────────────────────────────────
  it('F3a 策略不健康时 ⇒ 工作台 `状态条.闸.错误` 有值（真装配路径）', async () => {
    const f = await makeFixture();
    forgetSharedOrg();
    try {
      // 让引擎真的不健康：出厂 响应期限.json 写成坏 JSON（Batch 1.5 的 ④ 已证明这条路 ⇒ 引擎 fail-closed）。
      await f.write('集体L2-共享基础设施/defaults/响应期限.json', '{ 这不是 JSON');
      const org = await shareOrg({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot });
      assert.equal(org.policy.healthy, false, '前提：引擎确实不健康');
      const 原文 = org.policy.describe().error;
      assert.ok(原文, '前提：引擎自述里有错误原文');

      const view = await org.workbench({ 项目: 'p-dirty' });
      assert.equal(view.状态条.闸.在位, false, '不健康 ⇒ 闸不在位');
      assert.notEqual(view.状态条.闸.错误, null, '面板必须拿得到策略引擎的错误原文（改前这里恒 null）');
      assert.ok(view.状态条.闸.错误, `错误字段必须有值：${JSON.stringify(view.状态条.闸)}`);
      assert.match(String(view.状态条.闸.错误), /无法解析/, '错误原文要是真原因，不是一句「不健康」');
    } finally {
      await f.cleanup();
      forgetSharedOrg();
    }
  });

  it('F3b 反例面：策略健康时 `状态条.闸.错误` 仍是 null（不许恒给值）', async () => {
    const t = await 起宿主();
    try {
      const 台 = (await 敲(t, 'workbench')).包.数据.状态条;
      assert.equal(台.闸.在位, true);
      assert.equal(台.闸.错误, null, '健康时没有错误可说 ⇒ null');
    } finally {
      await t.清理();
    }
  });

  // ── F4 极值 since ⇒ presence() 永不抛 ──────────────────────────────────────
  it('F4a `lastInteraction` 贴着 Date 上界 ⇒ presence() 不抛，status 与工作台仍可用', async () => {
    const t = await 起宿主();
    try {
      await t.写私有('身份档案/identity.json', JSON.stringify({ members: {}, sovereign: { lastInteraction: DATE_MAX_ISO }, denylist: [] }, null, 2));
      assert.equal(await t.org.policy.reload(), true);
      assert.equal(t.org.policy.healthy, true, '前提：引擎是健康的（这是「合法时刻」不是坏值）');

      let 读数;
      assert.doesNotThrow(() => {
        读数 = t.org.policy.presence();
      }, 'presence() 永不抛：算不出到期时刻也要给确定读数');
      assert.equal(读数.deadline, null, '到期时刻表示不出来 ⇒ null，不许抛、也不许编一个时刻');
      assert.equal(typeof 读数.lost, 'boolean', 'lost 必须有确定结论（拿不准按最严）');
      assert.equal(读数.lost, true, '算不出到期时刻 ⇒ 按最严判失联（fail-safe，§12.2 查不到 = 最严）');
      assert.ok(读数.判定说明, '为什么算不出要如实说明，不许静默');
      assert.match(String(读数.判定说明), /到期时刻|Date/, '说明要指向真原因');

      const 状态 = await 敲(t, 'status');
      assert.equal(状态.包.成功, true, `/mind status 必须仍可用：${状态.回复.text}`);
      assert.equal(状态.包.数据.失联.lost, true);
      const 台 = await 敲(t, 'workbench');
      assert.equal(台.包.成功, true, `/mind workbench 必须仍可用：${台.回复.text}`);
      assert.ok(['在位', '已失联', '已关闭', '未知'].includes(台.包.数据.状态条.失联), `状态条.失联 必须是四态之一：${台.包.数据.状态条.失联}`);
      const 工具 = JSON.parse(await t.工具.execute({ action: 'workbench' }, fakeExec({ name: 'mind' })));
      assert.equal(工具.成功, true, '模型侧的工作台同样不许废掉');
    } finally {
      await t.清理();
    }
  });

  it('F4b 极值 since + 开关关掉 ⇒ 同样不抛，且如实说「已关闭」', async () => {
    const t = await 起宿主();
    try {
      await t.写私有(部署偏好, JSON.stringify({ 失联限制: false, 响应期限小时: 876000 }, null, 2));
      await t.写私有('身份档案/identity.json', JSON.stringify({ members: {}, sovereign: { lastInteraction: DATE_MAX_ISO }, denylist: [] }, null, 2));
      assert.equal(await t.org.policy.reload(), true);
      const 读数 = t.org.policy.presence();
      assert.equal(读数.已关闭, true);
      assert.equal(读数.失联限制, false);
      assert.equal((await 敲(t, 'status')).包.成功, true);
    } finally {
      await t.清理();
    }
  });

  it('F4c 反例面：正常 tick ⇒ deadline 仍是 ISO 时刻（不许为了「不抛」把 deadline 全变成 null）', async () => {
    const t = await 起宿主();
    try {
      const p = t.org.policy.presence();
      assert.match(String(p.deadline), /^\d{4}-\d{2}-\d{2}T/, `正常路径必须给出到期时刻：${JSON.stringify(p)}`);
      assert.equal(typeof p.hours, 'number');
      assert.equal(p.since !== null, true);
      assert.equal(p.判定说明, undefined, '正常路径不该带「算不出」的说明');
    } finally {
      await t.清理();
    }
  });

  it('F4d 极早方向的时刻照旧可用（别把正常范围也一起挡住）', async () => {
    const t = await 起宿主();
    try {
      await t.写私有('身份档案/identity.json', JSON.stringify({ members: {}, sovereign: { lastInteraction: '1970-01-01T00:00:00.000Z' }, denylist: [] }, null, 2));
      assert.equal(await t.org.policy.reload(), true);
      const p = t.org.policy.presence();
      assert.equal(p.lost, true, '1970 年到现在远超 72 小时 ⇒ 失联');
      assert.match(String(p.deadline), /^\d{4}-\d{2}-\d{2}T/, '极早时刻的 deadline 仍然表示得出来');
    } finally {
      await t.清理();
    }
  });
});
