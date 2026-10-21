/** 独立启动/卸载对抗：只运行真实kernel注册的guard，工具体是计数桩，不调用宿主创建。 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeFixture } from './helpers.mjs';
import { fakeHost } from './host-harness.mjs';
import { drainKernelAudit } from './kernel-drain.mjs';
import { apply } from '../components/kernel/lib/index.js';
import { shareOrg, forgetSharedOrg } from '../src/runtime.js';

const PROJECT = 'startup-independent';
const OUTSIDE = 'startup-ungranted';
const LABEL = 'dsh-mind: Lead 调度授权';
const CREATION = ['spawn_teammate', 'subagent', 'subagent_fork', 'role_spawn', 'workflow'];
const granted = { mode: 'lead-discretion', projects: [PROJECT], authorizationRef: 'isolated-explicit-test-grant' };

function refusal(host, exec) {
  for (const guard of [...host.闸]) { const reason = guard(exec); if (reason !== undefined) return reason; }
  return undefined;
}

async function scene(run, { delegation = granted, missingEffect = false, failCreationRegistration = false, envelope } = {}) {
  const f = await makeFixture(); const host = fakeHost(); let org;
  let pending, capturedEffect, effectDisposer, disposed = false, registrations = 0, beforeRemove, afterRemove;
  const effect = host.ctx.effect.bind(host.ctx), guard = host.ctx.tools.guard.bind(host.ctx.tools);
  host.ctx.tools.guard = callback => {
    registrations++;
    if (registrations === 2 && failCreationRegistration) throw new Error('isolated late creation-guard registration failure');
    const remove = guard(callback);
    return registrations === 2 ? () => { beforeRemove?.(); remove(); afterRemove?.(); } : remove;
  };
  host.ctx.effect = (callback, label) => {
    if (label !== LABEL) return effect(callback);
    pending = callback; capturedEffect = callback;
    return effect(() => () => { if (!disposed) { disposed = true; effectDisposer?.(); } });
  };
  if (missingEffect) host.ctx.effect = undefined;
  const cwd = join(f.home, 'project'), other = join(f.home, 'outside');
  const config = { home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: PROJECT,
    projectBindings: [{ path: cwd, project: PROJECT }, { path: other, project: OUTSIDE }],
    audit工具调用: false, 观测模型用量: false, ...(delegation === undefined ? {} : { delegation }) };
  try {
    await mkdir(cwd); await mkdir(other);
    if (envelope) await f.write('集体L2-共享基础设施/defaults/工具总范围.json', JSON.stringify(envelope));
    const agent = (current = cwd, child = false) => ({ id: child ? 'member-a' : 'lead', session: { id: child ? 'member-a' : 'lead', header: { cwd: current, ...(child ? { origin: 'subagent', parentSession: 'lead', delegationDepth: 1 } : {}) } } });
    const exec = (name, current = cwd, child = false) => ({ name, arguments: {}, agent: agent(current, child) });
    const loading = apply(host.ctx, config);
    assert.equal(host.闸.length, 1, '首await前已有承重闸');
    for (const name of CREATION) assert.match(refusal(host, exec(name)), /未就绪|尚未完成/);
    await loading; org = await shareOrg(config);
    const start = () => { assert.equal(disposed, false); assert.equal(typeof pending, 'function'); const callback = pending; pending = undefined; effectDisposer = callback(); };
    const stop = () => { if (!disposed) { disposed = true; effectDisposer?.(); } };
    await run({ f, org, host, config, cwd, other, exec, start, stop, staleEffect: () => capturedEffect(), onRemoval: (before, after) => { beforeRemove = before; afterRemove = after; }, registrations: () => registrations });
    stop();
  } finally {
    if (!disposed) { disposed = true; effectDisposer?.(); }
    host.清理(); if (org) await drainKernelAudit(org); forgetSharedOrg(config); await f.cleanup();
  }
}

describe('独立调度启动：已激活范围闸承接创建约束', { timeout: 60_000 }, () => {
  it('晚effect前五种裸创建均被真实单范围闸拒，安装后仍只有两道闸且理由一致', () => scene(async ({ host, exec, start, registrations }) => {
    assert.equal(host.闸.length, 1); const earlier = new Map();
    for (const name of CREATION) { const reason = refusal(host, exec(name)); assert.match(reason, /member_spawn/); earlier.set(name, reason); }
    assert.equal(refusal(host, exec('read')), undefined, '正常范围闸已activate，不以全面闭合掩盖缺口');
    start(); assert.equal(registrations(), 2); assert.equal(host.闸.length, 2, '不增第三道平行闸');
    for (const name of CREATION) assert.equal(refusal(host, exec(name)), earlier.get(name), '兜底与正式创建闸共用判据');
  }));

  it('创建专用effect从未可用时仍有定向兜底，非创建工具保持既有行为', () => scene(async ({ host, exec }) => {
    assert.equal(host.闸.length, 1); for (const name of CREATION) assert.match(refusal(host, exec(name)), /member_spawn/);
    assert.equal(refusal(host, exec('read')), undefined); assert.equal(refusal(host, exec('mind')), undefined);
  }, { missingEffect: true }));

  it('普通工具范围明确拒绝优先于创建兜底，真实安装后也不被覆盖', () => scene(async ({ host, exec, start }) => {
    const check = () => { for (const name of CREATION) { const reason = refusal(host, exec(name)); assert.match(reason, /工具总范围之外/); assert.doesNotMatch(reason, /member_spawn/); } };
    check(); start(); check();
  }, { envelope: { 允许: [], 拒绝: CREATION } }));

  it('真实成员的原有工具闭名单拒绝优先，不能被兜底换成Lead授权或放行', () => scene(async ({ host, exec, start }) => {
    for (const phase of [() => {}, start]) { phase(); for (const name of CREATION) { const reason = refusal(host, exec(name, undefined, true)); assert.match(reason, /成员工具闸/); assert.doesNotMatch(reason, /member_spawn/); } }
  }));

  it('默认explicit-user的Lead不被新增组织创建限制，晚安装前后五工具均保持官方域', () => scene(async ({ host, exec, start }) => {
    for (const phase of [() => {}, start]) { phase(); for (const name of CREATION) assert.equal(refusal(host, exec(name)), undefined); }
  }, { delegation: {} }));

  it('仅匹配可信cwd的授权项目：范围外Lead保持原行为，自报project不能扩授权', () => scene(async ({ host, exec, other, start }) => {
    for (const phase of [() => {}, start]) { phase(); for (const name of CREATION) { const e = exec(name, other); e.arguments = { project: PROJECT, 项目: PROJECT }; assert.equal(refusal(host, e), undefined); } }
  }));

  it('项目不可判时五创建工具均拒，args自报项目不能覆盖坏cwd', () => scene(async ({ host, exec, start }) => {
    for (const phase of [() => {}, start]) { phase(); for (const name of CREATION) { const e = exec(name, 'relative-unknown-project'); e.arguments.project = PROJECT; assert.match(refusal(host, e), /项目身份不可判定|项目.*fail-closed/); } }
  }));

  it('磁盘registered=true不是准入凭据，晚effect未执行也不能绕过创建约束', () => scene(async ({ org, host, exec }) => {
    await writeFile(org.layout.guardReceiptFile(), JSON.stringify({ 范围闸: { registered: true }, 调度创建闸: { registered: true } }) + '\n', 'utf8');
    assert.equal(host.闸.length, 1); for (const name of CREATION) assert.match(refusal(host, exec(name)), /member_spawn/);
  }));

  it('晚注册真实失败仍由范围闸承重，伪回执与重复读不能把它变成已安装', () => scene(async ({ org, host, exec, start, registrations }) => {
    start(); assert.equal(registrations(), 2); assert.equal(host.闸.length, 1); assert.ok(host.日志.some(line => /创建闸注册失败/.test(line)));
    await writeFile(org.layout.guardReceiptFile(), JSON.stringify({ 调度创建闸: { registered: true } }) + '\n', 'utf8');
    for (const name of CREATION) assert.match(refusal(host, exec(name)), /member_spawn|未就绪|fail-closed/);
  }, { failCreationRegistration: true }));

  it('创建闸注销前后及disposer返回后都拒绝，close须先于移除旧闸且兜底先恢复', () => scene(async ({ host, exec, start, stop, onRemoval }) => {
    start(); const samples = [];
    const sample = () => samples.push(CREATION.map(name => refusal(host, exec(name))));
    onRemoval(sample, sample); stop(); assert.equal(samples.length, 2); assert.equal(host.闸.length, 1); sample();
    for (const row of samples) for (const reason of row) assert.match(reason, /已卸载|正在重载|不接受/);
    assert.equal(refusal(host, exec('read')), undefined);
  }));

  it('范围外Lead在卸载瞬间也不能借已消失的第二闸创建，闭合状态留在范围兜底', () => scene(async ({ host, exec, other, start, stop, onRemoval }) => {
    assert.equal(refusal(host, exec('subagent', other)), undefined); start(); assert.equal(refusal(host, exec('subagent', other)), undefined);
    const samples = []; const sample = () => samples.push(refusal(host, exec('subagent', other)));
    onRemoval(sample, sample); stop(); sample(); assert.equal(samples.length, 3);
    for (const reason of samples) assert.match(reason, /已卸载|正在重载|不接受/);
  }));

  it('已注销的旧effect迟到回调不得重新注册第二闸或恢复授权', () => scene(async ({ host, exec, start, stop, staleEffect, registrations }) => {
    start(); stop(); assert.equal(registrations(), 2); assert.equal(host.闸.length, 1);
    const lateDisposer = staleEffect();
    try { assert.equal(registrations(), 2, 'closed先于任何新注册'); assert.equal(host.闸.length, 1); for (const name of CREATION) assert.match(refusal(host, exec(name)), /已卸载|正在重载|不接受/); }
    finally { lateDisposer?.(); }
  }));
});
