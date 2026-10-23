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

it('Cordis服务和方法代理反复变化时，Mind从不替换宿主方法',()=>scene(async({raw,originals,services,protection})=>{
 for(let i=0;i<8;i++){assert.notEqual(services().sandboxPolicy,services().sandboxPolicy);assert.equal(protection.guard({name:'bash',arguments:{}}),undefined);assert.equal(services().sandboxPolicy.resolve().mode,'danger-full-access');restored(raw,originals);}
 const owner={};const created=await services().terminals.spawn(trace(owner),{});assert.equal(services().terminals.startSend(trace(owner),created.sessionId,{}).accepted,true);restored(raw,originals);
}));
it('宿主服务替换、移除和后续第三方包装由宿主负责，Mind不重新附着',()=>scene(async({raw,originals,protection,directory,replace})=>{
 const next=host(join(directory,'next'));replace(next);assert.equal(protection.guard({name:'pwsh',arguments:{}}),undefined);restored(raw,originals);restored(next.raw,next.originals);
 const thirdParty=()=>({mode:'danger-full-access',workspaceRoot:directory});next.raw.sandboxPolicy.resolve=thirdParty;replace({services:()=>({})});protection.stop();assert.equal(next.raw.sandboxPolicy.resolve,thirdParty);
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
    assert.equal(h.services().sandboxPolicy.resolve().mode, 'danger-full-access');
    assert.ok(p.guard({ name: 'write', arguments: { file_path: join(alias, relative) } }));
    assert.ok(p.guard({ name: 'edit', arguments: { file_path: alias } }));
    assert.equal(p.guard({ name: 'write', arguments: { file_path: join(alias, 'unrelated-persona-probe.md') } }), undefined);
  } finally { p.stop(); }
  restored(h.raw, h.originals);
});
