/**
 * 宿主半区回归（v2 条目13 · 2026-10-18 审计实证）：主权者失联时钟只由**真实人类消息**续命。
 *
 * 病灶：宿主 journal 里 `agent-message` / `subagent-settled` / `runtime-context` /
 * `compact-checkpoint` / `skill-catalog` 的 type 也全是 `user/message`。修前挂钩只看 type
 * ⇒ 系统自己的自动回报给自己续失联时钟，「失联」永远不会到（Lead 已用宿主日志证明）。
 *
 * 可信判据（唯一钩子）：`event.data.source.kind === 'user'` **且** `rpcId` 非空。
 * 本文件逐类造反例：真实 user 必须更新；其余 kind 与缺 source 一个都不许更新；
 * 事件包装 `event` / `event.event` 两种形状都认。判据都能**变红**（不是「跑过就算」）。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { makeFixture } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import * as plugin from '../components/kernel/lib/index.js';

const 旧时刻 = '2020-01-01T00:00:00.000Z';

/** 把夹具的 lastInteraction 钉在很久以前（测试准备；不经过被测自治通道）。 */
async function 钉旧交互(identityFile) {
  const doc = JSON.parse(await readFile(identityFile, 'utf8'));
  doc.sovereign = { ...(doc.sovereign ?? {}), lastInteraction: 旧时刻 };
  await writeFile(identityFile, `${JSON.stringify(doc, null, 2)}\n`, 'utf8');
}

/** 读当前 lastInteraction。 */
async function 读交互(identityFile) {
  return JSON.parse(await readFile(identityFile, 'utf8')).sovereign?.lastInteraction ?? null;
}

/** 有界轮询：等一个「条件成立」的事实，超时响亮失败（不静默过）。 */
async function 等到(fn, ms = 3_000) {
  const 止 = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > 止) throw new Error(`等待条件超时（${ms}ms）`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe('v2 条目13：失联时钟只认可信人类来源', () => {
  it('真实 user（kind=user + rpcId）更新；系统各类 user/message 与缺 source 全部不更新', async () => {
    const f = await makeFixture();
    const host = fakeHost();
    const identityFile = f.layout.identityFile();
    try {
      await 钉旧交互(identityFile);
      await plugin.apply(host.ctx, { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot });
      assert.equal(await 读交互(identityFile), 旧时刻, '前提：起点是旧时刻');

      // 正例：真实人类（rpcId 由用户 RPC 带来）。
      host.触发('session/event', {}, { type: 'user/message', data: { source: { kind: 'user', rpcId: 'rpc-real-1' } } });
      const 更新后 = await 等到(async () => {
        const v = await 读交互(identityFile);
        return v && v !== 旧时刻 ? v : null;
      });
      assert.notEqual(更新后, 旧时刻, '真实 user 必须续命');

      // 反例：每一类系统来源都不许续命（以当前时刻为基线，逐条触发后必须原样）。
      const 系统来源 = ['agent-message', 'subagent-settled', 'runtime-context', 'compact-checkpoint', 'skill-catalog'];
      for (const kind of 系统来源) {
        const 前 = await 读交互(identityFile);
        host.触发('session/event', {}, { type: 'user/message', data: { source: { kind, rpcId: `rpc-${kind}` } } });
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(await 读交互(identityFile), 前, `来源 kind=${kind} 不得续失联时钟`);
      }
      // 缺 source / 空 kind / user 但没有 rpcId：同样不续命（不从正文猜）。
      for (const data of [{}, { source: null }, { source: {} }, { source: { kind: 'user' } }, { source: { kind: 'user', rpcId: '' } }]) {
        const 前 = await 读交互(identityFile);
        host.触发('session/event', {}, { type: 'user/message', data });
        await new Promise((r) => setTimeout(r, 80));
        assert.equal(await 读交互(identityFile), 前, `缺可信来源时不得续命：${JSON.stringify(data)}`);
      }

      // 包装兼容：event.event 形态的真实 user 也要更新。
      await 钉旧交互(identityFile);
      host.触发('session/event', {}, { event: { type: 'user/message', data: { source: { kind: 'user', rpcId: 'rpc-real-2' } } } });
      await 等到(async () => {
        const v = await 读交互(identityFile);
        return v && v !== 旧时刻;
      });
      assert.notEqual(await 读交互(identityFile), 旧时刻, 'event.event 包装形状同样识别真实 user');
    } finally {
      host.清理();
      await f.cleanup();
    }
  });
});
