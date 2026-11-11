/* Actual selected SDK ToolRuntime/executor + official subagent tool; synthetic parent/service.
 * No real child, model, profile, approval prompt or production host is used.
 * The test intentionally does NOT certify full governed member integration. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHostCreationBridge } from '../src/host-creation-bridge.js';
import { installSdkTools, executeSdkTool } from './sdk-tool-runtime.mjs';
import { waitForCreationCallback } from './host-creation-fixture.mjs';
if (!process.env.DSH_SDK_ROOT) throw new Error('Set DSH_SDK_ROOT to the isolated public SDK; no fallback to a live profile.');
const sdk = createRequire(resolve(process.env.DSH_SDK_ROOT, 'package.json'));
const load = name => import(pathToFileURL(sdk.resolve('@deepseek-ai/' + name)));
const [{ Context }, { ToolRuntime, defineTool }, { Session }, native, { createScope }] = await Promise.all(['cordis', 'dsh-tools', 'dsh-session', 'dsh-tool-subagent', 'dsh-scope'].map(load));

async function fixture(t, { modelRoute = null, mode = 'native' } = {}) {
  const ctx = new Context(), controller = new AbortController();
  const state = { project: 'fixture', revision: 0, fingerprint: 'deployment-1', live: true };
  const calls = [], seen = [], checks = [];
  let bound, outer, inner, bridge;
  ctx.reflect.provide('systemPrompt', { tools: () => () => {}, section: () => () => {}, context: () => () => {}, getSectionOrder: () => 0, getContextOrder: () => 0 });
  assert.equal(mode, 'native');
  const sdkTools = await installSdkTools(ctx, ToolRuntime, load);
  const parent = { id: 'parent', options: { provider: 'fixture', model: 'no-network' }, session: Session.create('parent', [], { version: 4, id: 'parent', cwd: process.cwd(), createdAt: Date.now(), isSeeded: false }) };
  const provider = { name: 'spawn', inheritsParentContext: false, capabilities: { agentOptions: true, depthLimit: true }, prepareContinuable() {} };
  const service = { getProvider: name => name === 'spawn' ? provider : undefined, resolveMaxDepth: () => 2,
    async startActivation(spec) { spec.signal.throwIfAborted(); calls.push(spec); return { childId: 'synthetic-child-' + calls.length, messageId: 'not-exposed-by-native-tool' }; } };
  ctx.reflect.provide('subagents', service);
  await native.apply(ctx, { provider: 'spawn', maxDepth: 2 });
  bridge = createHostCreationBridge({ tools: ctx.tools, contextOf(exec) {
    assert.equal(exec.agent, parent);
    if (!state.live) throw new Error('live parent revoked');
    return { project: state.project, revision: state.revision, fingerprint: state.fingerprint };
  } });
  ctx.on('tools/execute', (exec, next) => bridge.around(exec, next), { prepend: true });
  ctx.tools.guard(exec => {
    if (exec.name !== 'subagent') return;
    inner = exec; seen.push(bridge.allows(exec));
    return bridge.allows(exec) ? undefined : 'Mind: governed route required';
  });
  ctx.on('tools/result', (exec, result) => checks.push({ name: exec.name, isError: result.isError, error: result.error }));
  ctx.tools.register(defineTool({ name: 'mind', description: 'synthetic outer request', parameters: {},
    output: { schema: { type: 'object', additionalProperties: true }, render: () => [{ type: 'text', text: 'synthetic result' }] },
    async execute(_args, exec) {
      outer = exec; bound = bridge.forExecution(exec);
      const spec = { mode: 'subagent', description: 'Synthetic creation', standby: 'Wait for governed binding; this is a fixture.', modelRoute,
        beforeDispatch: async () => { await api.beforeDispatch?.(); } };
      return api.handler ? api.handler(bound, spec) : bound.create(spec);
    } }));
  const api = { ctx, bridge, state, calls, seen, checks, parent, controller, service, sdkTools,
    get bound() { return bound; }, get outer() { return outer; }, get inner() { return inner; },
    beforeDispatch: null,
    invoke: () => executeSdkTool(ctx.tools, { callId: 'outer-call', name: 'mind', arguments: {}, agent: parent, signal: controller.signal }),
    raw: () => executeSdkTool(ctx.tools, { callId: 'raw-call', name: 'subagent', arguments: { description: 'raw', prompt: 'raw' }, agent: parent, signal: controller.signal }),
  };
  t.after(async () => { bridge.close(); await ctx.fiber.dispose(); });
  return api;
}

test('official Host tool pipeline calls its configured provider and preserves depth/default route', async t => {
  const f = await fixture(t); const result = await f.invoke();
  assert.equal(result.isError, false, JSON.stringify(result));
  assert.equal(result.value.tool, 'subagent');
  assert.deepEqual(result.value.value, { kind: 'activation', subagentId: 'synthetic-child-1' });
  assert.equal(f.calls.length, 1); assert.equal(f.calls[0].provider, 'spawn');
  assert.equal(f.calls[0].request.parent, f.parent); assert.equal(f.calls[0].request.maxDepth, 2);
  assert.equal(f.calls[0].request.agentOptions, undefined); assert.equal(f.calls[0].delivery, 'parent');
  assert.equal(Object.hasOwn(result.value.value, 'messageId'), false);
  assert.deepEqual(f.seen, [true]);
  assert.deepEqual(f.checks.map(x => x.name), ['subagent', 'mind']);
  assert.equal(f.bridge.allows(f.inner), false, 'completed lease cannot authorize replay');
  await assert.rejects(f.bound.create({ mode: 'subagent' }), /仍在执行/);
});

test('raw creation stays rejected; strings and same-id fake parent cannot mint a lease', async t => {
  const f = await fixture(t);
  assert.equal((await f.raw()).isError, true); assert.equal(f.calls.length, 0);
  await assert.rejects(f.bridge.forExecution({ name: 'mind', token: 'claimed', agent: f.parent, signal: f.controller.signal }).create({ mode: 'subagent' }), /真实 Mind/);
  f.beforeDispatch = async () => {
    assert.equal(f.bridge.allows({ ...f.inner, token: Symbol('replay') }), false);
    assert.equal(f.bridge.allows({ ...f.inner, parent: Symbol('parent') }), false);
    assert.equal(f.bridge.allows({ ...f.inner, agent: { ...f.parent } }), false);
    assert.equal(f.bridge.allows({ ...f.inner, arguments: { ...f.inner.arguments, prompt: 'changed' } }), false);
  };
  assert.equal((await f.invoke()).isError, false);
});

for (const gate of ['deny', 'ask']) test(`Host pre-execute ${gate} cannot be bypassed by governed creation`, async t => {
  const f = await fixture(t);
  f.ctx.on('tools/pre-execute', async (exec, next) => exec.name === 'subagent' ? { kind: gate, reason: 'synthetic Host decision' } : next());
  const r = await f.invoke(); assert.equal(r.isError, true); assert.equal(f.calls.length, 0);
  assert.match(r.error.message, /未获准进入执行/);
});

test('another monotonic Host guard still vetoes the exact governed call', async t => {
  const f = await fixture(t); f.ctx.tools.guard(exec => exec.name === 'subagent' ? 'independent Host restriction' : undefined);
  assert.equal((await f.invoke()).isError, true); assert.equal(f.calls.length, 0);
});

test('official model-selection disabled policy is still enforced inside the real tool', async t => {
  const f = await fixture(t, { modelRoute: { provider: 'override', model: 'not-allowed' } });
  const r = await f.invoke(); assert.equal(r.isError, true); assert.equal(f.calls.length, 0);
  assert.match(f.checks.find(x => x.name === 'subagent').error.message, /disabled|provider|unknown|unexpected/i);
});

for (const field of ['project', 'revision', 'fingerprint', 'live']) test(`Host approval wait cannot reuse stale ${field}`, async t => {
  const f = await fixture(t);
  f.ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'subagent') f.state[field] = field === 'revision' ? 1 : field === 'live' ? false : 'changed';
    return next();
  });
  assert.equal((await f.invoke()).isError, true); assert.equal(f.calls.length, 0);
});

test('task recheck failure and change during asynchronous recheck never enter native body', async t => {
  const f = await fixture(t); f.beforeDispatch = async () => { throw new Error('frozen task changed'); };
  assert.equal((await f.invoke()).isError, true); assert.equal(f.calls.length, 0);
  f.beforeDispatch = async () => { await Promise.resolve(); f.state.revision++; };
  assert.equal((await f.invoke()).isError, true); assert.equal(f.calls.length, 0);
});

test('component withdrawal while approval is pending aborts and cannot revive old capability', async t => {
  const f = await fixture(t);
  f.ctx.on('tools/pre-execute', async (exec, next) => { if (exec.name === 'subagent') f.bridge.close(); return next(); });
  const r = await f.invoke(); assert.equal(r.isError, true); assert.equal(f.calls.length, 0);
  assert.equal(f.bound.available('subagent'), false);
});

test('a post-execute veto after a side effect remains unknown and never retries', async t => {
  const f = await fixture(t);
  f.ctx.on('tools/post-execute', async (exec, result, next) => exec.name === 'subagent' ? { kind: 'block', feedback: [{ type: 'text', text: 'synthetic post veto' }] } : next());
  const r = await f.invoke(); assert.equal(r.isError, true); assert.equal(f.calls.length, 1);
  assert.match(r.error.message, /已进入执行/); assert.match(r.error.message, /不能重复创建/);
});

test('post-execute replacement of a returned child id is not an ownership receipt', async t => {
  const f = await fixture(t);
  f.ctx.on('tools/post-execute', async (exec, result, next) => exec.name === 'subagent'
    ? { kind: 'accept', value: { kind: 'activation', subagentId: 'foreign-child' } } : next());
  const r = await f.invoke(); assert.equal(r.isError, true); assert.equal(f.calls.length, 1);
  assert.match(r.error.message, /最终结果与创建执行回执不一致/);
});

test('caller cancellation before dispatch never creates a child', async t => {
  const f = await fixture(t);
  f.ctx.on('tools/pre-execute', async (exec, next) => { if (exec.name === 'subagent') f.controller.abort(); return next(); });
  assert.equal((await f.invoke()).isError, true); assert.equal(f.calls.length, 0);
});

test('restriction added during an async task check is honored before the tool body', async t => {
  const f = await fixture(t), scoped = createScope(f.ctx, f.parent);
  f.beforeDispatch = async () => { await Promise.resolve(); scoped.ctx.tools.restrict({ deny: ['subagent'] }); };
  assert.equal((await f.invoke()).isError, true); assert.equal(f.calls.length, 0);
});

test('scope change after entering the Host is unknown, not a fabricated rollback', async t => {
  const f = await fixture(t), original = f.service.startActivation;
  f.service.startActivation = async spec => { const r = await original(spec); f.state.revision++; return r; };
  const r = await f.invoke(); assert.equal(r.isError, true); assert.equal(f.calls.length, 1);
  assert.match(r.error.message, /不能假称未创建/);
});

test('hidden official tool refuses instead of falling back to a present service', async t => {
  const f = await fixture(t); const scoped = createScope(f.ctx, f.parent);
  scoped.ctx.tools.restrict({ deny: ['subagent'] });
  const r = await f.invoke(); assert.equal(r.isError, true); assert.equal(f.calls.length, 0);
  assert.match(r.error.message, /未提供可执行/);
});

test('prepare creates no child, exposes stable call association and executes once under concurrency', async t => {
  const f = await fixture(t);
  f.handler = async (bound, spec) => {
    const prepared = bound.prepare(spec);
    assert.ok(Object.isFrozen(prepared)); assert.match(prepared.callId, /^mind-create-/);
    assert.equal(f.calls.length, 0);
    const results = await Promise.allSettled([prepared.execute(), prepared.execute()]);
    assert.equal(results[0].status, 'fulfilled'); assert.equal(results[1].status, 'rejected');
    assert.equal(results[0].value.callId, prepared.callId);
    await assert.rejects(prepared.execute(), /已经执行/);
    return results[0].value;
  };
  assert.equal((await f.invoke()).isError, false); assert.equal(f.calls.length, 1);
});

test('a prepared handle expires with its outer call', async t => {
  const f = await fixture(t);
  f.handler = (bound, spec) => { f.prepared = bound.prepare(spec); return { prepared: true }; };
  assert.equal((await f.invoke()).isError, false); assert.equal(f.calls.length, 0);
  await assert.rejects(f.prepared.execute(), /仍在执行/); assert.equal(f.calls.length, 0);
});

test('public callId copied during native approval cannot acquire the live private dispatch', async t => {
  const f = await fixture(t), ready = Promise.withResolvers(), release = Promise.withResolvers();
  let first = true;
  f.ctx.on('tools/pre-execute', async (exec, decision) => {
    if (exec.name === 'subagent' && first) { first = false; ready.resolve(exec); await release.promise; }
    return decision();
  });
  const operation = f.invoke();
  try {
    const pending = await waitForCreationCallback(ready.promise, operation);
    const copied = await executeSdkTool(f.ctx.tools, { callId: pending.callId, name: pending.name, arguments: pending.arguments,
      parent: pending.parent, rootCallId: pending.rootCallId, agent: f.parent, signal: f.controller.signal });
    assert.equal(copied.isError, true); assert.equal(f.calls.length, 0);
  } finally { release.resolve(); }
  assert.equal((await operation).isError, false); assert.equal(f.calls.length, 1);
});

if (typeof ToolRuntime.prototype.selectExecutor === 'function') {
  for (const moment of ['before-prepare', 'during-admission', 'inside-body']) test(`actual selected executor withdrawal at ${moment} cannot fall back`, async t => {
    const f = await fixture(t);
    if (moment === 'before-prepare') f.handler = async (bound, spec) => { await f.sdkTools.release(); assert.equal(bound.available('subagent'), false); return bound.create(spec); };
    if (moment === 'during-admission') f.ctx.on('tools/pre-execute', async (exec, decision) => { if (exec.name === 'subagent') await f.sdkTools.release(); return decision(); });
    if (moment === 'inside-body') {
      const start = f.service.startActivation;
      f.service.startActivation = async spec => { const returned = await start(spec); await f.sdkTools.release(); return returned; };
    }
    const result = await f.invoke(); assert.equal(result.isError, true);
    assert.equal(f.calls.length, moment === 'inside-body' ? 1 : 0);
    if (moment === 'inside-body') assert.match(result.error.message, /作用域变化/);
    assert.throws(() => f.ctx.tools.selectExecutor(f.parent), /unavailable/);
  });
  test('selected actual PTC-only executor refuses raw nested batches without fallback or program execution', async t => {
    const f = await fixture(t), { PtcExecutor } = await load('dsh-tool-executor-ptc');
    f.handler = async (bound, spec) => {
      await f.sdkTools.release(); f.ctx.tools.setExecutor(new PtcExecutor(f.ctx, {}));
      return bound.create(spec);
    };
    assert.equal((await f.invoke()).isError, true); assert.equal(f.calls.length, 0);
    assert.match(f.checks.find(row => row.name === 'subagent').error.message, /only.*run_code/);
  });
}

for (const change of ['revision', 'close']) test(`prepare cannot bypass ${change} before execute`, async t => {
  const f = await fixture(t);
  f.handler = async (bound, spec) => {
    const prepared = bound.prepare(spec);
    if (change === 'revision') f.state.revision++; else f.bridge.close();
    return prepared.execute();
  };
  assert.equal((await f.invoke()).isError, true); assert.equal(f.calls.length, 0);
});
