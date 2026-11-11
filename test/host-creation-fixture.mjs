/**
 * Explicit DOMAIN-TEST double for the server-only Host creation capability.
 * It does not implement or prove SDK policy/approval. Real ToolRuntime and native
 * tool coverage lives in host-creation-bridge-sdk / mind-flow-kernel-sdk.mjs.
 * Only tests import this file; production has no direct-service fallback.
 * Catalogs belong to each fake service, NOT to this adapter: a returned foreign
 * id must not become an owned child just because a receipt mentions it.
 */
import { randomUUID } from 'node:crypto';
import { Fault } from '../src/kernel/errors.js';

/** Domain-test barrier: early operation failure must fail the test, not hang it. */
export async function waitForCreationCallback(ready, operation, timeoutMs = 10000) {
  let timer;
  try {
    return await Promise.race([
      ready,
      operation.then(result => { throw result?.error ?? new Error('Operation completed before the expected callback'); }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('TEST_CALLBACK_TIMEOUT')), timeoutMs); }),
    ]);
  } finally { clearTimeout(timer); }
}

/** Explicit test-only interruption lane, separate from the creation double. */
export function fakeMaintenanceCapability(host) {
  return { prepare({ mode, target, beforeDispatch }) {
    if (mode !== 'team' || typeof beforeDispatch !== 'function') throw Error('Invalid test maintenance request');
    let used = false;
    return { tool: 'interrupt_agent', callId: `fake-stop-${randomUUID()}`, async execute() {
      if (used) throw Error('Test maintenance capability cannot replay');
      used = true; await beforeDispatch();
      return { value: await host.agentTeams.interrupt(host.agent, target) };
    } };
  } };
}

export function fakeCreationCapability(host) {
  const calls = [];
  return {
    calls,
    available(mode) { return typeof (mode === 'team' ? host.agentTeams?.spawnTeammate : host.subagents?.startContinuable) === 'function'; },
    prepare({ mode, name, description, standby, modelRoute, beforeDispatch }) {
      const callId = `mind-create-${randomUUID()}`, tool = mode === 'team' ? 'spawn_teammate' : 'subagent';
      const agent = host.agent, signal = host.signal ?? new AbortController().signal;
      const record = { callId, tool, entered: 0 }; calls.push(record);
      let used = false;
      return Object.freeze({ callId, tool, async execute() {
        if (used) throw new Error('Test capability cannot replay');
        used = true;
        await beforeDispatch();
        signal.throwIfAborted();
        record.entered++;
        try {
          const value = mode === 'team'
            ? await host.agentTeams.spawnTeammate(agent, { name, description, prompt: [{ type: 'text', text: standby }], context: 'fresh', provider: 'isolated-test-provider', signal })
            : await host.subagents.startContinuable({ provider: 'isolated-test-provider', label: description,
              request: { parent: agent, prompt: standby, ...(modelRoute ? { agentOptions: modelRoute } : {}) }, signal });
          const { id: _id, name: target, ...details } = value?.member ?? {};
          return { callId, tool, value: mode === 'team' ? { member: { target, ...details } } : { kind: 'activation', subagentId: value?.childId } };
        } catch (cause) {
          throw new Fault('HOST_CREATION_RESULT_UNKNOWN', 'Test Host entered creation, but the response was lost.', { cause,
            outcome: { 提交状态: '未知', 可重试: false, 已确认阶段: [], 恢复指引: 'Inspect the original intent; do not retry.' } });
        }
      } });
    },
  };
}
