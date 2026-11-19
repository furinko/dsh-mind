/**
 * 宿主能力探测与降级（2026-11-19）。
 *
 * 修前 `assertExecutionHost` 把 listChildren/listMembers/drainChildren 当硬要求，
 * 宿主一升级改名或缺方法，member_spawn 在创建前就整体失败。这里钉住新契约：
 *  - 硬要求只有「官方创建通道 + sendMessage」；Team 另需名册（解析 target 必需）；
 *  - 名册缺失时 subagent 降级为信官方返回 id，并把降级事实交给调用方；
 *  - 释放接口兼容两种历史命名，缺失时只是能力清单里为 null。
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hostCapabilities, assertExecutionHost, prepareExecution } from '../lib/host-execution.js';

const agent = { id: 'parent', session: { id: 'parent' } };
const hostCreation = { prepare() {}, available: () => true };

describe('宿主能力探测', () => {
  it('缺 listChildren 时 subagent 仍可创建（降级）；Team 仍要求名册', () => {
    const host = {
      agent, hostCreation,
      subagents: { sendMessage() {} },
      agentTeams: { sendMessage() {} },
    };
    const caps = hostCapabilities(host, 'subagent');
    assert.equal(caps.create, true);
    assert.equal(caps.send, true);
    assert.equal(caps.list, false);
    assert.equal(caps.release, null);
    assert.doesNotThrow(() => assertExecutionHost(host, 'subagent'));
    assert.throws(() => assertExecutionHost(host, 'team'), /listMembers/);
  });

  it('缺 sendMessage 时拒绝，理由点名 sendMessage（不是整组接口）', () => {
    const host = { agent, hostCreation, subagents: {} };
    assert.throws(() => assertExecutionHost(host, 'subagent'), /sendMessage/);
  });

  it('释放接口兼容 drainChildren / drainContinuableChildren，缺失只是 null', () => {
    const base = { agent, hostCreation };
    assert.equal(hostCapabilities({ ...base, subagents: { drainChildren() {} } }, 'subagent').release, 'drainChildren');
    assert.equal(hostCapabilities({ ...base, subagents: { drainContinuableChildren() {} } }, 'subagent').release, 'drainContinuableChildren');
    assert.equal(hostCapabilities({ ...base, subagents: {} }, 'subagent').release, null);
  });

  it('返回值形状变化时按候选字段唯一取 id（无名册的降级路径）', async () => {
    const host = {
      agent: { id: 'parent', session: { id: 'parent' } },
      subagents: { sendMessage() {} },
      hostCreation: {
        available: () => true,
        prepare: () => ({
          tool: 'subagent', callId: 'c1',
          async execute() { return { callId: 'c1', tool: 'subagent', value: { kind: 'started', sessionId: 'child-9' } }; },
        }),
      },
    };
    const r = await prepareExecution({ host, mode: 'subagent', name: 'w', description: 'd' }).execute();
    assert.equal(r.实例, 'child-9');
    assert.match(r.目录核对 ?? '', /降级/);
  });

  it('宿主只回名称时用名册把名称解析成实例 id；无名册则明确失败', async () => {
    const make = (subagents) => ({
      agent: { id: 'parent', session: { id: 'parent' } },
      subagents,
      hostCreation: {
        available: () => true,
        prepare: () => ({
          tool: 'subagent', callId: 'c1',
          async execute() { return { callId: 'c1', tool: 'subagent', value: { kind: 'activation', name: 'agent-1' } }; },
        }),
      },
    });
    const host = make({ sendMessage() {}, listChildren: async () => [{ id: 'child-9', name: 'agent-1', mode: 'continuable' }] });
    const r = await prepareExecution({ host, mode: 'subagent', name: 'w', description: 'd' }).execute();
    assert.equal(r.实例, 'child-9');
    assert.equal(r.目录核对, undefined);

    const noRoster = make({ sendMessage() {} });
    await assert.rejects(
      () => prepareExecution({ host: noRoster, mode: 'subagent', name: 'w', description: 'd' }).execute(),
      /无法登记该子会话/,
    );
  });
});
