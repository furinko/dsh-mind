/**
 * 宿主能力探测与降级（2026-11-19 · rc.5）。
 *
 * rc.5 把接口改名了：listChildren → listDescendants，drainChildren → drainDescendants，
 * 并新增 resolveName(agent, name) → 子会话 id。修前 Mind 只认旧名，误判“宿主没给”，
 * 在创建后无法把名称换成 id，留下无法登记的子会话。
 *
 * 新契约：
 *  - 硬要求：官方创建通道 + sendMessage（Team 另需 listMembers）；
 *  - subagent 还需要「目录 或 resolveName」，否则创建后无法登记——在创建前就拒；
 *  - 有 resolveName 时按名称解析实例 id；有目录时按 id/名称唯一匹配；
 *  - 释放接口兼容两种历史命名。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostCapabilities, assertExecutionHost, prepareExecution } from '../lib/host-execution.js';

const agent = { id: 'parent', session: { id: 'parent' } };
const hostCreation = { prepare() {}, available: () => true };

const spawnHost = ({ subagents, value }) => ({
  agent,
  hostCreation: {
    available: () => true,
    prepare: () => ({
      tool: 'subagent', callId: 'c1',
      async execute() { return { callId: 'c1', tool: 'subagent', value }; },
    }),
  },
  subagents,
});

describe('宿主能力探测', () => {
  it('rc.5 接口名：listDescendants / resolveName 都能被识别', () => {
    const caps = hostCapabilities({
      agent, hostCreation,
      subagents: { sendMessage() {}, listDescendants() {}, resolveName() {} },
    }, 'subagent');
    assert.equal(caps.create, true);
    assert.equal(caps.send, true);
    assert.equal(caps.list, false, 'listDescendants 行形状未适配，不冒充可用目录');
    assert.equal(caps.resolveName, true);
    assert.equal(caps.listDescendants, true);
    assert.doesNotThrow(() => assertExecutionHost({ agent, hostCreation, subagents: { sendMessage() {}, listDescendants() {}, resolveName() {} } }, 'subagent'));
  });

  it('既无目录也无 resolveName：创建前就拒，避免孤儿', () => {
    const host = { agent, hostCreation, subagents: { sendMessage() {} } };
    assert.throws(() => assertExecutionHost(host, 'subagent'), /resolveName|目录/);
  });

  it('缺 sendMessage 时拒绝，理由点名 sendMessage', () => {
    assert.throws(() => assertExecutionHost({ agent, hostCreation, subagents: { resolveName() {} } }, 'subagent'), /sendMessage/);
  });

  it('释放接口兼容 drainChildren / drainContinuableChildren，缺失只是 null', () => {
    const base = { agent, hostCreation };
    assert.equal(hostCapabilities({ ...base, subagents: { drainChildren() {} } }, 'subagent').release, 'drainChildren');
    assert.equal(hostCapabilities({ ...base, subagents: { drainContinuableChildren() {} } }, 'subagent').release, 'drainContinuableChildren');
    assert.equal(hostCapabilities({ ...base, subagents: {} }, 'subagent').release, null);
  });
});

describe('创建结果识别', () => {
  it('宿主只回名称：用 resolveName 解析成实例 id', async () => {
    const host = spawnHost({
      subagents: { sendMessage() {}, resolveName: async (_agent, name) => name === 'agent-1' ? 'child-9' : null },
      value: { kind: 'activation', name: 'agent-1' },
    });
    const r = await prepareExecution({ host, mode: 'subagent', name: 'w', description: 'd' }).execute();
    assert.equal(r.实例, 'child-9');
  });

  it('宿主只回名称：有目录时按名称唯一匹配', async () => {
    const host = spawnHost({
      subagents: { sendMessage() {}, listChildren: async () => [{ id: 'child-9', name: 'agent-1', mode: 'continuable' }] },
      value: { kind: 'activation', name: 'agent-1' },
    });
    const r = await prepareExecution({ host, mode: 'subagent', name: 'w', description: 'd' }).execute();
    assert.equal(r.实例, 'child-9');
  });

  it('返回值带实例标识时直接采用（兼容旧形状）', async () => {
    const host = spawnHost({
      subagents: { sendMessage() {}, resolveName: async () => null },
      value: { kind: 'started', sessionId: 'child-9' },
    });
    const r = await prepareExecution({ host, mode: 'subagent', name: 'w', description: 'd' }).execute();
    assert.equal(r.实例, 'child-9');
  });

  it('resolveName 原样返回名字时不当作 id（拒绝登记）', async () => {
    const host = spawnHost({
      subagents: { sendMessage() {}, resolveName: async (_agent, name) => name },
      value: { kind: 'activation', name: 'agent-1' },
    });
    await assert.rejects(
      () => prepareExecution({ host, mode: 'subagent', name: 'w', description: 'd' }).execute(),
      /不登记该子会话/,
    );
  });
});
