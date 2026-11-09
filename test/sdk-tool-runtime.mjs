/* Compose the actual selected SDK executor. Never emulate its pipeline or tokens. */
import assert from 'node:assert/strict';

export async function installSdkTools(ctx, ToolRuntime, load) {
  const { SessionProjectionRegistry } = await load('dsh-session-projection');
  new SessionProjectionRegistry(ctx);
  if (typeof ToolRuntime.prototype.selectExecutor === 'function') {
    new ToolRuntime(ctx, {});
    const { NativeToolExecutor } = await load('dsh-tool-executor-native');
    // Same public composition as native.apply; retain the owning disposer for
    // withdrawal tests, without editing the selected executor or its pipeline.
    const executor = new NativeToolExecutor(ctx);
    return { executor, release: ctx.tools.setExecutor(executor) };
  } else new ToolRuntime(ctx, { mode: 'native' });
}

/** The 0.2.2 API accepts a raw batch, not a single ToolExecutionInput. */
export async function executeSdkTool(tools, input) {
  if (typeof tools.selectExecutor !== 'function') return tools.execute(input);
  const batch = await tools.execute({ calls: [{ id: input.callId, name: input.name, arguments: JSON.stringify(input.arguments) }],
    agent: input.agent, signal: input.signal, ...(input.toolSet ? { toolSet: input.toolSet } : {}) });
  assert.equal(batch.results.length, 1);
  assert.equal(batch.results[0].callId, input.callId);
  return batch.results[0].result;
}
