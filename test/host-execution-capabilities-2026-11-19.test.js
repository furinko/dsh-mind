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
import { hostCapabilities, assertExecutionHost } from '../lib/host-execution.js';

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
});
