import { it } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { readdir, readFile } from 'node:fs/promises';
import { makeFixture } from './helpers.mjs';
import { ProbeRunner } from '../src/probes.js';
import { atomicWrite } from '../src/kernel/fsx.js';
import { runStartupProbe } from '../components/guard/lib/startup-probe.js';
import { apply } from '../components/guard/lib/index.js';
import { apply as kernelApply } from '../components/kernel/lib/index.js';
import { shareOrg } from '../src/runtime.js';
import { fakeHost } from './host-harness.mjs';

const ready = { 范围闸: { registered: true }, 调度创建闸: { registered: true } };
async function fixture(fn) {
  const f = await makeFixture();
  const org = { layout: f.layout, probes: new ProbeRunner(f) };
  try { await fn(f, org); } finally { await f.cleanup(); }
}
const receipts = (f, value) => atomicWrite(f.layout.guardReceiptFile(), JSON.stringify(value));
const gate = (result) => result.结果.find((r) => r.探针 === '闸在位');

it('开机等待未确认回执变为真实注册成功，仅留一份全绿快照', async () => fixture(async (f, org) => {
  await receipts(f, { ...ready, 调度创建闸: { registered: null, error: null } });
  const pending = runStartupProbe(org, { timeoutMs: 1000, pollMs: 10 });
  await delay(30);
  assert.equal((await f.audit.read({})).filter((r) => r.动作 === '探针异常').length, 0);
  await receipts(f, ready);
  const result = await pending;
  assert.equal(result.全绿, true);
  assert.equal(gate(result).状态, '绿');
  assert.equal((await readdir(f.layout.probeSnapshotDir())).length, 1);
}));

it('尚无回执也等待；范围闸先到、调度闸后到都必须确认', async () => fixture(async (f, org) => {
  const pending = runStartupProbe(org, { timeoutMs: 1000, pollMs: 10 });
  await delay(20);
  await receipts(f, { 范围闸: ready.范围闸 });
  await delay(20);
  await receipts(f, ready);
  assert.equal((await pending).全绿, true);
}));

it('显式注册失败立即执行原探针，仍然红灯并留下失败原因', async () => fixture(async (f, org) => {
  await receipts(f, { ...ready, 调度创建闸: { registered: false, error: 'registration-denied' } });
  const result = await runStartupProbe(org, { timeoutMs: 60000 });
  assert.equal(result.全绿, false);
  assert.equal(gate(result).状态, '红');
  assert.match(gate(result).详情, /registration-denied/);
}));

for (const [name, value] of [['缺失', null], ['未确认', { ...ready, 调度创建闸: { registered: null } }], ['非布尔成功', { ...ready, 调度创建闸: { registered: 'true' } }]]) {
  it(`开机窗口超时仍将${name}判红`, async () => fixture(async (f, org) => {
    if (value) await receipts(f, value);
    const result = await runStartupProbe(org, { timeoutMs: 20, pollMs: 5 });
    assert.equal(result.全绿, false);
    assert.equal(gate(result).状态, '红');
  }));
}

it('等待期间手工巡检仍即时报告未确认，后续开机自检保留历史红快照', async () => fixture(async (f, org) => {
  await receipts(f, { ...ready, 调度创建闸: { registered: null } });
  const pending = runStartupProbe(org, { timeoutMs: 1000, pollMs: 10 });
  const manual = await org.probes.run({ subject: { id: 'system', kind: '系统' } });
  assert.equal(gate(manual).状态, '红');
  await receipts(f, ready);
  assert.equal((await pending).全绿, true);
  assert.equal((await readdir(f.layout.probeSnapshotDir())).length, 2);
}));

it('真实guard卸载取消尚未开始的自检，不在卸载后写快照', async () => fixture(async (f) => {
  const config = { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot };
  const org = await shareOrg(config);
  let runs = 0;
  const run = org.probes.run.bind(org.probes);
  org.probes.run = (...args) => { runs++; return run(...args); };
  const host = fakeHost();
  await apply(host.ctx, config);
  host.清理();
  await receipts(f, ready);
  await delay(75);
  assert.equal(runs, 0);
  assert.equal(host.日志.some((line) => line.includes('开机自检失败')), false);
}));

it('真实内核延迟执行调度注册effect时，guard自检等真实回执后才落快照', async () => fixture(async (f) => {
  const config = { home: f.home, privateRoot: f.privateRoot, factoryRoot: f.factoryRoot };
  const host = fakeHost();
  const effect = host.ctx.effect.bind(host.ctx);
  let register;
  host.ctx.effect = (fn, label) => {
    if (label === 'dsh-mind: Lead 调度授权') { register = fn; return; }
    return effect(fn, label);
  };
  try {
    await kernelApply(host.ctx, config);
    assert.equal(JSON.parse(await readFile(f.layout.guardReceiptFile(), 'utf8')).调度创建闸.registered, null);
    const org = await shareOrg(config);
    const run = org.probes.run.bind(org.probes);
    let complete;
    const completed = new Promise((resolve) => { complete = resolve; });
    let runs = 0;
    org.probes.run = (...args) => { runs++; const result = run(...args); complete(result); return result; };
    await apply(host.ctx, config);
    await delay(30);
    assert.equal(runs, 0);
    assert.equal(host.闸.length, 1);
    effect(register);
    const result = await completed;
    assert.equal(host.闸.length, 2);
    assert.equal(gate(result).状态, '绿');
    assert.equal((await readdir(f.layout.probeSnapshotDir())).length, 1);
  } finally { host.清理(); }
}));

it('损坏回执立即交原探针报错，不吞掉读取错误或伪报成功', async () => fixture(async (f, org) => {
  await atomicWrite(f.layout.guardReceiptFile(), '{broken');
  await assert.rejects(runStartupProbe(org, { timeoutMs: 60000 }), /JSON 解析失败/);
}));
