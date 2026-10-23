/** 核心卡的文件边界：文件工具拒写；Windows 保留宿主原生的部分隔离。 */
import { dirname, isAbsolute, resolve, relative, sep } from 'node:path';
import { lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonicalFileTarget, insideFileRoot } from '../../../src/tool-file-scope.js';
import { Fault } from '../../../src/kernel/errors.js';

const policies = new WeakMap();
const runners = new WeakMap();
const terminalSpawns = new WeakMap();
const terminalSends = new WeakMap();
const spawnEvidence = new AsyncLocalStorage();
const terminalEvidence = new WeakMap();
// Cordis 为每次服务访问生成 traceable Proxy；身份和方法还原必须以原服务为准。
const original = value => value?.[Symbol.for('cordis.original')] ?? value;
const READ_TOOLS = new Set(['read', 'read_image', 'glob', 'grep']);
const EXEC_TOOLS = new Set(['bash', 'pwsh', 'terminal', 'terminal_open', 'terminal_send', 'terminal_create', 'terminal_write', 'job_start']);

// realpath不合并bind mount别名。以存在祖先的设备/inode加剩余路径比较，
// 也保护尚未创建的核心目录；不能仅按/home与/host/home的字面位置判定。
function ancestry(path) {
  const result = [];
  for (let parent = path; ; parent = dirname(parent)) {
    try {
      const stat = lstatSync(parent, { bigint: true });
      if (stat.isSymbolicLink() || !stat.ino) throw new Error('路径祖先身份不可确认');
      result.push({ id: `${stat.dev}:${stat.ino}`, suffix: relative(parent, path) });
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (dirname(parent) === parent) return result;
  }
}
function physicalInside(path, root) {
  if (insideFileRoot(path, root)) return true;
  const parents = ancestry(root);
  return ancestry(path).some(child => parents.some(parent => child.id === parent.id
    && (child.suffix === parent.suffix || !parent.suffix || child.suffix.startsWith(`${parent.suffix}${sep}`))));
}

function constrain(policy, roots) {
  if (!roots.length) return policy;
  let mode = policy.mode === 'danger-full-access' ? 'workspace-write' : policy.mode;
  try {
    const workspace = canonicalFileTarget(policy.workspaceRoot);
    const writable = [workspace, '/tmp', tmpdir()].filter(isAbsolute).map(canonicalFileTarget);
    if (roots.some(root => writable.some(path => physicalInside(root, path) || physicalInside(path, root)))) mode = 'read-only';
  } catch { mode = 'read-only'; }
  return { ...policy, mode };
}

function attach(service, registry, method, root, factory) {
  if (typeof service?.[method] !== 'function') return null;
  let entry = registry.get(service);
  if (entry && service[method] !== entry.wrapper) throw new Fault('PERSONA_CORE_SERVICE_CHANGED', '核心人设保护的宿主方法已变化，需要重新加载保护。');
  if (!entry) {
    entry = { original: service[method], roots: new Map() };
    entry.wrapper = factory(entry);
    service[method] = entry.wrapper;
    registry.set(service, entry);
  }
  entry.roots.set(root, (entry.roots.get(root) ?? 0) + 1);
  return () => {
    const count = entry.roots.get(root) - 1;
    if (count) entry.roots.set(root, count); else entry.roots.delete(root);
    if (!entry.roots.size) {
      if (service[method] === entry.wrapper) service[method] = entry.original;
      registry.delete(service);
    }
  };
}

export function createPersonaProtection({ org, sandboxPolicy, sandbox, terminals, getServices,
  cwdOf = exec => exec?.agent?.session?.header?.cwd, platform = process.platform }) {
  const lexical = resolve(dirname(org.layout.personaCoreFile()));
  const root = canonicalFileTarget(lexical);
  const acceptedEnforcement = platform === 'win32' ? ['full', 'partial'] : ['full'];
  let stopped = false;
  const installed = new Map();
  const current = name => {
    const entry = installed.get(name);
    return !!entry && entry.service[entry.method] === entry.wrapper;
  };
  const install = (name, service, registry, method, factory) => {
    service = original(service);
    if (service && installed.get(name)?.service === service) {
      if (!current(name)) throw new Fault('PERSONA_CORE_SERVICE_CHANGED', '核心人设保护的宿主方法已变化，需要重新加载保护。');
      return;
    }
    installed.get(name)?.dispose(); installed.delete(name);
    const dispose = attach(service, registry, method, root, factory);
    if (dispose) installed.set(name, { service, method, wrapper: service[method], dispose });
  };
  const connect = (services = {}) => {
    if (stopped) return;
    install('policy', services.sandboxPolicy, policies, 'resolve', entry => function (request) {
      return constrain(entry.original.call(this, request), [...entry.roots.keys()]);
    });
    install('runner', services.sandbox, runners, 'confine', entry => function (argv, policy, signal) {
      const roots = [...entry.roots.keys()];
      entry.lastEnforcement = null;
      const evidence = spawnEvidence.getStore();
      const verify = result => {
        entry.lastEnforcement = ['full', 'partial'].includes(result?.enforcement) ? result.enforcement : 'unknown';
        if (!acceptedEnforcement.includes(result?.enforcement)) throw new Fault('PERSONA_CORE_CONFINEMENT',
          platform === 'win32' ? '执行沙箱未提供可核验的隔离程度，拒绝启动命令。' : '当前平台要求完整文件隔离，拒绝启动命令。');
        if (evidence) evidence.roots = roots;
        return result;
      };
      const result = entry.original.call(this, argv, constrain(policy, roots), signal);
      // SDK confine为同步合同，真实PTY立即读取.argv；异步provider仍沿原Promise路径核验。
      return typeof result?.then === 'function' ? Promise.resolve(result).then(verify) : verify(result);
    });
    install('spawn', services.terminals, terminalSpawns, 'spawn', entry => async function (owner, request, signal) {
      const evidence = { roots: [] };
      const result = await spawnEvidence.run(evidence, () => entry.original.call(this, owner, request, signal));
      if (![...entry.roots.keys()].every(root => evidence.roots.includes(root))) {
        await this.kill(owner, result.sessionId, '核心人设：终端未提供当前平台沙箱创建证明');
        throw new Fault('PERSONA_CORE_TERMINAL', '终端缺少核心人设沙箱创建证明。');
      }
      const identity = original(this), actor = original(owner);
      let owners = terminalEvidence.get(identity);
      if (!owners) terminalEvidence.set(identity, owners = new WeakMap());
      let sessions = owners.get(actor);
      if (!sessions) owners.set(actor, sessions = new Map());
      sessions.set(result.sessionId, evidence.roots);
      return result;
    });
    install('send', services.terminals, terminalSends, 'startSend', entry => function (owner, id, request) {
      const roots = terminalEvidence.get(original(this))?.get(original(owner))?.get(id) ?? [];
      if (![...entry.roots.keys()].every(root => roots.includes(root))) throw new Fault('PERSONA_CORE_TERMINAL', '旧终端没有当前核心人设保护证明，请新开终端。');
      return entry.original.call(this, owner, id, request);
    });
  };
  connect({ sandboxPolicy, sandbox, terminals });
  return {
    connect,
    health() {
      const wired = current('policy') && current('runner');
      const lastEnforcement = current('runner') ? runners.get(installed.get('runner').service)?.lastEnforcement ?? null : null;
      return { stopped, nativePolicy: current('policy'), confinedExecution: current('runner'),
        terminalProof: current('spawn') && current('send'), platform, acceptedEnforcement: [...acceptedEnforcement], lastEnforcement,
        执行状态: stopped ? '已停止' : !wired ? '执行服务未接线' : lastEnforcement === null ? '尚未核实执行隔离'
          : lastEnforcement === 'full' ? '最近返回完整隔离' : lastEnforcement === 'partial' ? '最近返回部分隔离' : '隔离程度未知',
        保护范围: platform === 'win32'
          ? '文件工具禁止改写核心人设；命令沿Windows原生沙箱运行，允许部分隔离，不能保证任意命令都无法改卡。'
          : '文件工具禁止改写核心人设；命令要求完整文件隔离，核心目录与可写根重叠时只读。',
      };
    },
    guard(exec) {
      if (READ_TOOLS.has(exec?.name)) return undefined;
      if (stopped) return '[dsh-mind] 核心人设保护已卸载，拒绝继续执行。';
      try {
        if (getServices) connect(getServices());
        if ([...installed.keys()].some(name => !current(name))) return '[dsh-mind] 核心人设保护的宿主方法已变化，请重新加载保护。';
      } catch { return '[dsh-mind] 核心人设保护的宿主服务已变化，请重新加载保护。'; }
      if (['terminal_open', 'terminal_send'].includes(exec?.name) && (!current('spawn') || !current('send'))) return '[dsh-mind] 终端缺少核心人设保护证明，暂不可用。';
      if (EXEC_TOOLS.has(exec?.name) && (!current('policy') || !current('runner'))) return '[dsh-mind] 核心人设缺少执行沙箱服务，命令暂不可执行。';
      // 直接文件写入不依赖模型是否把路径称作“人设”，父目录替换也受保护。
      const args = exec?.arguments;
      for (const key of ['file_path', 'path', 'source', 'destination', 'target_path', 'new_path', 'old_path']) {
        if (typeof args?.[key] !== 'string' || !args[key].trim()) continue;
        const cwd = cwdOf(exec);
        if (!isAbsolute(args[key]) && !cwd) return '[dsh-mind] 写路径缺少基准，无法核对核心人设边界。';
        try {
          const path = canonicalFileTarget(isAbsolute(args[key]) ? args[key] : resolve(cwd, args[key]));
          if (physicalInside(path, root) || physicalInside(root, path)) return '[dsh-mind] 核心人设由本地人侧维护，聊天工具不能创建、改写或替换该目录。';
        } catch (error) { return `[dsh-mind] 写路径无法可靠解析，核心人设边界拒绝该操作：${error.message}`; }
      }
      return undefined;
    },
    stop() { if (stopped) return; stopped = true; for (const entry of [...installed.values()].reverse()) entry.dispose(); installed.clear(); },
  };
}
