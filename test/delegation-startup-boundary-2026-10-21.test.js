import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
import { apply } from '../components/kernel/lib/index.js';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';
import { DelegationPolicy } from '../src/delegation-policy.js';
import { makeFixture } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { drainKernelAudit } from './kernel-drain.mjs';

const PROJECT = 'startup-boundary';
const LABEL = 'dsh-mind: Lead 调度授权';
const CREATION = ['spawn_teammate', 'subagent', 'subagent_fork', 'role_spawn', 'workflow'];
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function invocation(home, name) { return { name, arguments: {}, agent: { id: 'lead', session: { id: 'lead', header: { cwd: home } } } }; }
function refusal(host, exec) { for (const guard of [...host.闸]) { const reason = guard(exec); if (reason !== undefined) return reason; } }
async function scene(run) {
  const f = await makeFixture(), host = fakeHost(); let org;
  const config = { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot, project: PROJECT,
    projectBindings: [{ path: f.home, project: PROJECT }], audit工具调用: false, 观测模型用量: false,
    delegation: { mode: 'lead-discretion', projects: [PROJECT], authorizationRef: 'test-explicit-authorization' } };
  try { await run({ f, host, config, getOrg: async () => org ??= await shareOrg(config) }); }
  finally { host.清理(); org ??= await shareOrg(config); await drainKernelAudit(org); forgetSharedOrg(config); await f.cleanup(); }
}

describe('创建闸启动窗口：真实 apply 与范围闸', { timeout: 60_000 }, () => {
  it('范围已激活而第二次回执仍在 await 时，五种创建已受同源限制', () => scene(async ({ f, host, config }) => {
    const reached = deferred(), release = deferred(), rename = fs.rename;
    let writes = 0, loading;
    fs.rename = async (from, to) => {
      if (resolve(String(to)) === resolve(f.layout.guardReceiptFile()) && ++writes === 2) { reached.resolve(); await release.promise; }
      return rename(from, to);
    };
    syncBuiltinESMExports();
    try {
      loading = apply(host.ctx, config); await reached.promise;
      assert.equal(host.闸.length, 1);
      for (const name of CREATION) assert.match(refusal(host, invocation(f.home, name)), /member_spawn/);
      assert.equal(refusal(host, invocation(f.home, 'read')), undefined);
    } finally { release.resolve(); try { await loading; } finally { fs.rename = rename; syncBuiltinESMExports(); } }
  }));

  it('单独延迟创建 effect 后 apply 已完成，首闸仍承重；接通后恰为两道闸', () => scene(async ({ f, host, config }) => {
    const effect = host.ctx.effect.bind(host.ctx); let pending, dispose;
    host.ctx.effect = (callback, label) => label === LABEL ? (pending = callback) : effect(callback);
    try {
      await apply(host.ctx, config); assert.equal(host.闸.length, 1);
      const before = CREATION.map(name => refusal(host, invocation(f.home, name)));
      for (const reason of before) assert.match(reason, /member_spawn/);
      dispose = pending(); assert.equal(host.闸.length, 2);
      assert.deepEqual(CREATION.map(name => refusal(host, invocation(f.home, name))), before);
    } finally { dispose?.(); }
  }));

  it('创建 effect 首次执行前组件已卸载，迟到回调不得安装或恢复创建授权', () => scene(async ({ f, host, config }) => {
    const effect = host.ctx.effect.bind(host.ctx); let pending;
    host.ctx.effect = (callback, label) => label === LABEL ? (pending = callback) : effect(callback);
    await apply(host.ctx, config); assert.equal(host.闸.length, 1);
    host.清理(); const dispose = pending();
    try {
      assert.equal(host.闸.length, 1);
      for (const name of CREATION) assert.match(refusal(host, invocation(f.home, name)), /已卸载|正在重载|不接受/);
      assert.equal(refusal(host, invocation(f.home, 'read')), undefined);
    } finally { dispose?.(); }
  }));

  it('默认Lead允许的创建在接通前后均只判一次，正式闸在位后首闸不重复委派判断', () => scene(async ({ f, host, config }) => {
    config.delegation = {};
    const effect = host.ctx.effect.bind(host.ctx); let pending, dispose;
    host.ctx.effect = (callback, label) => label === LABEL ? (pending = callback) : effect(callback);
    await apply(host.ctx, config);
    const original = DelegationPolicy.prototype.creationGuard; let calls = 0;
    DelegationPolicy.prototype.creationGuard = function (...args) { calls++; return original.apply(this, args); };
    try {
      for (const phase of [() => {}, () => { dispose = pending(); }]) {
        phase();
        for (const name of CREATION) {
          const before = calls; assert.equal(refusal(host, invocation(f.home, name)), undefined);
          assert.equal(calls - before, 1);
        }
      }
      assert.equal(host.闸.length, 2);
    } finally { DelegationPolicy.prototype.creationGuard = original; dispose?.(); }
  }));

  it('授权部署同步注册第二闸失败，保留原降级自述与未就绪范围闸合同', () => scene(async ({ f, host, config }) => {
    const register = host.ctx.tools.guard.bind(host.ctx.tools); let registrations = 0;
    host.ctx.tools.guard = handler => {
      if (++registrations === 2) throw new Error('test: creation guard unavailable');
      return register(handler);
    };
    await apply(host.ctx, config);
    assert.equal(registrations, 2); assert.equal(host.闸.length, 1);
    assert.equal(host.命令.size, 0);
    assert.equal(refusal(host, { ...invocation(f.home, 'mind'), arguments: { action: 'status' } }), undefined);
    assert.match(refusal(host, invocation(f.home, 'read')), /未就绪|fail-closed/);
    const response = JSON.parse(await host.工具.get('mind').execute({ action: 'status' }, invocation(f.home, 'mind')));
    assert.equal(response.成功, false); assert.equal(response.结果, '组织未装配');
    assert.match(response.理由, /调度创建闸注册失败/);
    assert.ok(host.日志.some(line => /^error:.*拒绝激活/.test(line)));
  }));
});
