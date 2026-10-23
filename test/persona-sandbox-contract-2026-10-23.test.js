import { it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { createPersonaProtection } from '../components/kernel/lib/persona-protection.js';

async function scene(run) {
  const f = await makeFixture();
  const org = { layout: { personaCoreFile: () => join(f.privateRoot, '主权人设', '核心人设.md') } };
  const sandboxPolicy = { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: f.home }) };
  try { await run({ org, sandboxPolicy }); } finally { await f.cleanup(); }
}

it('宿主同步confine保持同步结果、元数据和this，终端可立即读取argv', async () => scene(async ({ org, sandboxPolicy }) => {
  let received;
  const result = { argv: ['native-runner'], enforcement: 'partial', denialSignatures: ['native-denial'], runnerFailureRules: [] };
  const sandbox = { confine(argv, policy) { assert.equal(this, sandbox); received = { argv, policy }; return result; } };
  const original = sandbox.confine;
  const p = createPersonaProtection({ org, sandboxPolicy, sandbox, platform: 'win32' });
  try {
    const out = sandbox.confine(['pwsh'], sandboxPolicy.resolve());
    assert.equal(out, result); assert.equal(out.then, undefined); assert.equal(out.argv[0], 'native-runner');
    assert.equal(received.policy.mode, 'read-only', '夹具私有根位于可写临时目录，仍沿原规则收窄为只读'); assert.deepEqual(received.argv, ['pwsh']);
    assert.equal(p.health().lastEnforcement, 'partial');
  } finally { p.stop(); }
  assert.equal(sandbox.confine, original);
}));

it('同步provider未知隔离同步拒绝；Linux部分隔离及原始异常不能被包装吞掉', async () => scene(async ({ org, sandboxPolicy }) => {
  let enforcement = 'unknown'; const failure = Error('provider failed');
  const sandbox = { confine() { if (enforcement === 'throw') throw failure; return { argv: ['must-not-start'], enforcement }; } };
  const p = createPersonaProtection({ org, sandboxPolicy, sandbox, platform: 'linux' });
  try {
    for (enforcement of [undefined, 'none', 'partial']) assert.throws(() => sandbox.confine([], sandboxPolicy.resolve()), { code: 'PERSONA_CORE_CONFINEMENT' });
    enforcement = 'throw'; assert.throws(() => sandbox.confine([], sandboxPolicy.resolve()), error => error === failure);
    assert.equal(p.health().lastEnforcement, null);
    enforcement = 'full'; assert.equal(sandbox.confine([], sandboxPolicy.resolve()).enforcement, 'full');
  } finally { p.stop(); }
}));

it('兼容异步provider仍返回Promise，成功、隔离拒绝和原始异常均保留', async () => scene(async ({ org, sandboxPolicy }) => {
  let enforcement = 'full'; const failure = Error('async provider failed');
  const sandbox = { async confine() { if (enforcement === 'throw') throw failure; return { argv: ['native'], enforcement }; } };
  const p = createPersonaProtection({ org, sandboxPolicy, sandbox, platform: 'linux' });
  try {
    const out = sandbox.confine([], sandboxPolicy.resolve()); assert.equal(typeof out.then, 'function');
    assert.equal((await out).enforcement, 'full');
    enforcement = 'partial'; await assert.rejects(sandbox.confine([], sandboxPolicy.resolve()), { code: 'PERSONA_CORE_CONFINEMENT' });
    enforcement = 'throw'; await assert.rejects(sandbox.confine([], sandboxPolicy.resolve()), error => error === failure);
    assert.equal(p.health().lastEnforcement, null);
  } finally { p.stop(); }
}));

it('真实后端的同步取argv路径可获终端证明；无证明、旧终端和其他owner仍拒绝', async () => scene(async ({ org, sandboxPolicy }) => {
  let confined = true, next = 0; const killed = [];
  const sandbox = { confine(argv) { return { argv, enforcement: 'partial' }; } };
  const terminals = {
    async spawn() { if (confined) assert.equal(sandbox.confine(['pwsh'], sandboxPolicy.resolve()).argv[0], 'pwsh'); return { sessionId: `pty-${++next}` }; },
    startSend() { return { accepted: true }; }, async kill(_owner, id) { killed.push(id); },
  };
  const p = createPersonaProtection({ org, sandboxPolicy, sandbox, terminals, platform: 'win32' });
  try {
    const owner = {};
    assert.throws(() => terminals.startSend(owner, 'old', {}), { code: 'PERSONA_CORE_TERMINAL' });
    const live = await terminals.spawn(owner, {});
    assert.equal(terminals.startSend(owner, live.sessionId, {}).accepted, true);
    assert.throws(() => terminals.startSend({}, live.sessionId, {}), { code: 'PERSONA_CORE_TERMINAL' });
    confined = false; await assert.rejects(terminals.spawn(owner, {}), { code: 'PERSONA_CORE_TERMINAL' });
    assert.deepEqual(killed, ['pty-2']);
  } finally { p.stop(); }
}));
