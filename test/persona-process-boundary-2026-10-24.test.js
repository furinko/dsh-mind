import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { createPersonaProtection } from '../components/kernel/lib/persona-protection.js';
import { protectPersonaProcess } from '../components/kernel/lib/persona-process-boundary.js';

it('目录边界保留三档权限，覆盖同步命令及PTY创建，完整还原服务', async () => {
  const root = await mkdtemp(join(tmpdir(), 'persona-process-'));
  const core = join(root, 'private', '主权人设', '核心人设.md');
  let mode = 'danger-full-access'; const received = [];
  const sandboxPolicy = { resolve: () => ({ mode, workspaceRoot: root }) };
  const sandbox = { confine: (argv, policy) => ({ argv, policy, enforcement: 'full' }) };
  const handle = { done: Promise.resolve({ exitCode: 0 }) };
  const subprocess = {
    spawn(spec) { received.push(spec); return handle; },
    async spawnTerminal(spec) { received.push(spec); return {}; },
  };
  const terminals = {
    async spawn() { await subprocess.spawnTerminal({ argv: ['bash'], cwd: root }); return { sessionId: 'protected-pty' }; },
    startSend() { return 'accepted'; }, kill() { throw new Error('不应清理已证明的PTY'); },
  };
  const original = { resolve: sandboxPolicy.resolve, spawn: subprocess.spawn, pty: subprocess.spawnTerminal };
  let wrapped = 0;
  const services = { sandboxPolicy, sandbox, subprocess, terminals };
  const protection = createPersonaProtection({ org: { layout: { personaCoreFile: () => core } }, ...services,
    platform: 'linux', getServices: () => services, processBoundary(argv, roots) {
      wrapped++; assert.deepEqual(roots, [join(root, 'private', '主权人设')]); return ['directory-boundary', ...argv];
    } });
  try {
    for (mode of ['danger-full-access', 'workspace-write', 'read-only']) assert.equal(sandboxPolicy.resolve().mode, mode);
    assert.equal(subprocess.spawn({ argv: ['node'], cwd: root }), handle, '同步进程句柄不改为Promise');
    assert.deepEqual(received[0].argv, ['directory-boundary', 'node']);
    const owner = {}; await terminals.spawn(owner, {});
    assert.equal(terminals.startSend(owner, 'protected-pty', {}), 'accepted');
    assert.throws(() => terminals.startSend({}, 'protected-pty', {}), { code: 'PERSONA_CORE_TERMINAL' });
    assert.equal(wrapped, 2); assert.equal(protection.health().directoryBoundary, true);
    assert.equal(protection.guard({ name: 'write', arguments: { file_path: join(root, 'profile', 'package.json') } }), undefined);
    assert.ok(protection.guard({ name: 'write', arguments: { file_path: core } }));
    services.subprocess = undefined;
    assert.ok(protection.guard({ name: 'bash', arguments: {} }), '服务丢失必须响亮拒绝，不退回旧降级');
    assert.equal(sandboxPolicy.resolve().mode, 'read-only'); // 用户当前选择的模式仍保留。
    mode = 'danger-full-access'; assert.equal(sandboxPolicy.resolve().mode, mode);
  } finally { protection.stop(); await rm(root, { recursive: true, force: true }); }
  assert.equal(sandboxPolicy.resolve, original.resolve);
  assert.equal(subprocess.spawn, original.spawn); assert.equal(subprocess.spawnTerminal, original.pty);
});

it('Linux真实进程可写工作区外的插件profile，但核心卡、别名及祖先替换被拒绝', async t => {
  if (process.platform !== 'linux') return t.skip('Linux目录挂载边界');
  const probe = spawnSync('bwrap', ['--bind', '/', '/', '--unshare-pid', '--proc', '/proc', '--', 'true'], { timeout: 3000 });
  if (probe.status !== 0) return t.skip('当前测试机没有可用bubblewrap');
  const root = await mkdtemp(join(tmpdir(), 'persona-native-'));
  const workspace = join(root, 'workspace'), profile = join(root, 'home', '.dsh', 'profiles', 'fixture');
  const privateRoot = join(root, 'home', '.dsh', 'private'), coreRoot = join(privateRoot, '主权人设');
  const core = join(coreRoot, '核心人设.md');
  await Promise.all([mkdir(workspace), mkdir(profile, { recursive: true }), mkdir(coreRoot, { recursive: true })]);
  await writeFile(core, 'human-owned fixture');
  await symlink(coreRoot, join(workspace, 'alias'));
  const script = `const fs = require('node:fs');
    fs.writeFileSync(process.argv[1], JSON.stringify({dependencies:{fixture:'file:fixture'}}));
    fs.writeFileSync(process.argv[2], 'ordinary home file');
    for (const target of [process.argv[3], process.argv[4]]) {
      try { fs.writeFileSync(target, 'must not change'); process.exit(10); } catch(e) { if (!['EROFS','EACCES','EPERM'].includes(e.code)) throw e; }
    }
    try { fs.renameSync(process.argv[5], process.argv[5] + '-moved'); process.exit(11); } catch(e) { if (!['EBUSY','EROFS','EACCES','EPERM'].includes(e.code)) throw e; }
  `;
  try {
    const argv = protectPersonaProcess([process.execPath, '-e', script, join(profile, 'package.json'), join(root, 'home', 'new-file'), core,
      join(workspace, 'alias', '核心人设.md'), privateRoot], [coreRoot]);
    const result = spawnSync(argv[0], argv.slice(1), { cwd: workspace, encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(await readFile(join(profile, 'package.json'), 'utf8')).dependencies.fixture, 'file:fixture');
    assert.equal(await readFile(core, 'utf8'), 'human-owned fixture');
    const controlArgv = protectPersonaProcess([process.execPath, '-e', "require('node:fs').writeSync(3, 'control-pipe-intact')"], [coreRoot]);
    const control = spawnSync(controlArgv[0], controlArgv.slice(1), { cwd: workspace, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], encoding: 'utf8', timeout: 10000 });
    assert.equal(control.status, 0, control.stderr);
    assert.equal(control.output[3], 'control-pipe-intact', '宿主显式控制管道继续可用');
    const childRoot = join(coreRoot, 'nested'), bindCore = join(workspace, 'bind-core'), bindChild = join(workspace, 'bind-child');
    await Promise.all([mkdir(childRoot), mkdir(bindCore), mkdir(bindChild)]);
    await writeFile(join(childRoot, 'card.md'), 'nested human fixture');
    const aliasCheck = `import assert from 'node:assert/strict';
      const {personaMountAliases}=await import(${JSON.stringify(new URL('../components/kernel/lib/persona-process-boundary.js', import.meta.url).href)});
      const aliases=personaMountAliases([${JSON.stringify(coreRoot)}]);
      assert.ok(aliases.includes(${JSON.stringify(bindCore)}));
      assert.ok(aliases.includes(${JSON.stringify(bindChild)}));`;
    const aliases = spawnSync('bwrap', ['--bind', '/', '/', '--bind', coreRoot, bindCore, '--bind', childRoot, bindChild,
      '--', process.execPath, '--input-type=module', '-e', aliasCheck], { encoding: 'utf8', timeout: 10000 });
    assert.equal(aliases.status, 0, aliases.stderr);
    assert.equal(await readFile(join(childRoot, 'card.md'), 'utf8'), 'nested human fixture');
  } finally { await rm(root, { recursive: true, force: true }); }
});
