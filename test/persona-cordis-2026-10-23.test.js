/** 兼容Cordis traceable Service的回归，不依赖部署机安装SDK。 */
import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonaProtection } from '../components/kernel/lib/persona-protection.js';

const ORIGINAL = Symbol.for('cordis.original');
// 宿主每次读服务、读方法和调用时的this均是新的代理；原对象只由symbol给出。
function trace(raw) {
  const proxy = new Proxy(raw, {
    get(target, key) {
      if (key === ORIGINAL) return target;
      const value = Reflect.get(target, key);
      return typeof value === 'function' ? new Proxy(value, {
        apply(fn, receiver, args) { return Reflect.apply(fn, receiver === proxy ? trace(target) : receiver, args); },
      }) : value;
    },
  });
  return proxy;
}

function host(workspace, { enforcement = 'full', confine = true } = {}) {
  const killed = []; let next = 0;
  const raw = {
    sandboxPolicy: { resolve() { return { mode: 'danger-full-access', workspaceRoot: workspace }; } },
    sandbox: { async confine(argv, policy) { return { argv, policy, enforcement }; } },
    terminals: {
      async spawn() {
        if (confine) await trace(raw.sandbox).confine(['fixture-no-execution'], trace(raw.sandboxPolicy).resolve());
        return { sessionId: `pty-${++next}` };
      },
      startSend() { return { accepted: true }; },
      async kill(_owner, id) { killed.push(id); return true; },
    },
  };
  const originals = { resolve: raw.sandboxPolicy.resolve, confine: raw.sandbox.confine,
    spawn: raw.terminals.spawn, send: raw.terminals.startSend };
  const services = () => Object.fromEntries(Object.entries(raw).map(([key, value]) => [key, value && trace(value)]));
  return { raw, originals, services, killed };
}

async function scene(run) {
  const directory = await mkdtemp(join(tmpdir(), 'persona-cordis-'));
  const core = join(directory, 'private', '主权人设', '核心人设.md');
  const org = { layout: { personaCoreFile: () => core } };
  const h = host(join(directory, 'workspace'));
  let activeHost = h;
  const getServices = () => activeHost.services();
  const protection = createPersonaProtection({ org, ...getServices(), getServices });
  try { await run({ ...h, org, protection, directory, replace: value => { activeHost = value; } }); }
  finally { protection.stop(); await rm(directory, { recursive: true, force: true }); }
}

function restored(raw, originals) {
  assert.equal(raw.sandboxPolicy.resolve, originals.resolve);
  assert.equal(raw.sandbox.confine, originals.confine);
  assert.equal(raw.terminals.spawn, originals.spawn);
  assert.equal(raw.terminals.startSend, originals.send);
}

it('服务/方法代理身份每次变化仍只包装一次，卸载恢复全部原方法且可重新装载', async () => scene(async ({ raw, originals, services, protection, org }) => {
  assert.notEqual(services().sandboxPolicy, services().sandboxPolicy);
  const proxy = services().sandboxPolicy;
  assert.notEqual(proxy.resolve, proxy.resolve);
  const wrapper = raw.sandboxPolicy.resolve;
  for (let i = 0; i < 8; i++) {
    assert.equal(protection.guard({ name: 'bash', arguments: {} }), undefined);
    assert.notEqual(services().sandboxPolicy.resolve().mode, 'danger-full-access');
    assert.equal(raw.sandboxPolicy.resolve, wrapper);
  }
  protection.stop(); protection.stop();
  restored(raw, originals);
  const again = createPersonaProtection({ org, ...services(), getServices: services });
  try { assert.notEqual(services().sandboxPolicy.resolve().mode, 'danger-full-access'); }
  finally { again.stop(); }
  restored(raw, originals);
}));

it('新PTY跨服务/this/owner代理可以续写，旧PTY及另一个真实owner仍拒绝', async () => scene(async ({ services }) => {
  const owner = {};
  assert.throws(() => services().terminals.startSend(trace(owner), 'old-pty', {}), { code: 'PERSONA_CORE_TERMINAL' });
  const created = await services().terminals.spawn(trace(owner), {});
  assert.equal(services().terminals.startSend(trace(owner), created.sessionId, { text: 'fixture' }).accepted, true);
  assert.throws(() => services().terminals.startSend(trace({}), created.sessionId, {}), { code: 'PERSONA_CORE_TERMINAL' });
}));

it('Linux部分sandbox与没有confine证据的后端不能取得PTY续写资格，未证明PTY会清理', async () => scene(async ({ org, protection, directory }) => {
  protection.stop();
  for (const options of [{ enforcement: 'partial' }, { confine: false }]) {
    const h = host(join(directory, 'workspace'), options);
    const p = createPersonaProtection({ org, ...h.services(), getServices: h.services, platform: 'linux' });
    try {
      await assert.rejects(h.services().terminals.spawn({}, {}), error => ['PERSONA_CORE_CONFINEMENT', 'PERSONA_CORE_TERMINAL'].includes(error.code));
      if (options.confine === false) assert.deepEqual(h.killed, ['pty-1']);
      assert.throws(() => h.services().terminals.startSend({}, 'pty-1', {}), { code: 'PERSONA_CORE_TERMINAL' });
    } finally { p.stop(); }
    restored(h.raw, h.originals);
  }
}));

it('真实服务替换重新附着并还原旧服务，服务消失时执行拒绝而不沿用旧health', async () => scene(async ({ raw, originals, protection, directory, replace }) => {
  const next = host(join(directory, 'next-workspace'));
  replace(next);
  assert.equal(protection.guard({ name: 'bash', arguments: {} }), undefined);
  restored(raw, originals);
  assert.notEqual(next.services().sandboxPolicy.resolve().mode, 'danger-full-access');
  const removed = { ...next, services: () => ({ sandboxPolicy: trace(next.raw.sandboxPolicy), terminals: trace(next.raw.terminals) }) };
  replace(removed);
  assert.ok(protection.guard({ name: 'bash', arguments: {} }));
  assert.equal(protection.health().confinedExecution, false);
  assert.equal(next.raw.sandbox.confine, next.originals.confine);
  protection.stop();
  restored(next.raw, next.originals);
}));

it('同raw对象方法被重挂立即暴露health失效并拒绝非只读工具，不盲包第三方方法', async () => {
  for (const [name, method, health] of [['sandboxPolicy', 'resolve', 'nativePolicy'], ['sandbox', 'confine', 'confinedExecution'],
    ['terminals', 'spawn', 'terminalProof'], ['terminals', 'startSend', 'terminalProof']]) await scene(async ({ raw, protection, directory }) => {
    const replaced = () => ({ mode: 'danger-full-access', workspaceRoot: directory });
    raw[name][method] = replaced;
    assert.equal(protection.health()[health], false);
    for (const tool of ['bash', 'terminal_open', 'terminal_send', 'write']) assert.ok(protection.guard({ name: tool, arguments: {} }), `${name}.${method}/${tool}`);
    assert.equal(protection.guard({ name: 'read', arguments: {} }), undefined);
    assert.equal(raw[name][method], replaced);
    protection.stop();
    assert.equal(raw[name][method], replaced, '卸载不覆盖后来的宿主实现');
  });
});

it('多个保护域共用原服务时引用计数不被trace代理打散，新加入域使旧PTY证据失效', async () => scene(async ({ raw, originals, services, protection, directory }) => {
  const owner = {};
  const prior = await services().terminals.spawn(trace(owner), {});
  const extra = createPersonaProtection({ org: { layout: { personaCoreFile: () => join(directory, 'other-private', '主权人设', '核心人设.md') } },
    ...services(), getServices: services });
  try {
    assert.throws(() => services().terminals.startSend(trace(owner), prior.sessionId, {}), { code: 'PERSONA_CORE_TERMINAL' });
    const next = await services().terminals.spawn(trace(owner), {});
    assert.equal(services().terminals.startSend(trace(owner), next.sessionId, {}).accepted, true);
    protection.stop();
    assert.notEqual(raw.sandboxPolicy.resolve, originals.resolve);
    assert.equal(services().terminals.startSend(trace(owner), next.sessionId, {}).accepted, true);
  } finally { extra.stop(); }
  restored(raw, originals);
}));

it('存在宿主bind别名时，设备/inode归一保护尚未创建的核心目录与祖先', async t => {
  const home = process.env.HOME;
  if (!home?.startsWith('/') || home.startsWith('/host/')) return t.skip('当前环境没有可检查的宿主home别名');
  const alias = `/host${home}`;
  let real; let mirrored;
  try { [real, mirrored] = await Promise.all([stat(home, { bigint: true }), stat(alias, { bigint: true })]); }
  catch { return t.skip('当前环境未提供/host同inode别名'); }
  if (real.dev !== mirrored.dev || real.ino !== mirrored.ino) return t.skip('/host路径不是当前home的bind别名');
  // 只对不存在的落点做路径判定，不写入home或读取真实核心卡正文。
  const relative = '.mind-persona-alias-probe-not-created/主权人设/核心人设.md';
  const h = host(alias);
  const p = createPersonaProtection({ org: { layout: { personaCoreFile: () => join(home, relative) } }, ...h.services(), getServices: h.services });
  try {
    assert.equal(h.services().sandboxPolicy.resolve().mode, 'read-only');
    assert.ok(p.guard({ name: 'write', arguments: { file_path: join(alias, relative) } }));
    assert.ok(p.guard({ name: 'edit', arguments: { file_path: alias } }));
    assert.equal(p.guard({ name: 'write', arguments: { file_path: join(alias, 'unrelated-persona-probe.md') } }), undefined);
  } finally { p.stop(); }
  restored(h.raw, h.originals);
});
