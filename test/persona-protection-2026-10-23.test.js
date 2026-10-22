import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonaProtection } from '../components/kernel/lib/persona-protection.js';

async function scene(run) {
  const root = await mkdtemp(join(tmpdir(), 'persona-protection-'));
  const workspace = join(root, 'workspace'); const core = join(root, 'private', '主权人设', '核心人设.md');
  await mkdir(workspace); await mkdir(join(root, 'private', '主权人设'), { recursive: true });
  await writeFile(core, '由本地人侧维护');
  const org = { layout: { personaCoreFile: () => core } };
  const sandboxPolicy = { resolve: request => ({ mode: request?.mode ?? 'danger-full-access', workspaceRoot: request?.root ?? workspace }) };
  const sandbox = { async confine(argv, policy) { return { argv, policy, enforcement: 'full' }; } };
  const protection = createPersonaProtection({ org, sandboxPolicy, sandbox });
  try { await run({ root, workspace, core, org, sandboxPolicy, sandbox, protection }); }
  finally { protection.stop(); await rm(root, { recursive: true, force: true }); }
}

it('核心写路径及父目录替换被拒，普通工作文件和只读工具可用，别名仍归一', async () => scene(async ({ root, workspace, core, protection }) => {
  const exec = (name, file_path) => ({ name, arguments: { file_path }, agent: { session: { header: { cwd: workspace } } } });
  assert.ok(protection.guard(exec('write', core)));
  assert.ok(protection.guard(exec('edit', join(root, 'private'))));
  assert.equal(protection.guard(exec('write', join(workspace, 'app.js'))), undefined);
  assert.equal(protection.guard(exec('read', core)), undefined);
  for (const name of ['terminal_open', 'terminal_send']) assert.ok(protection.guard({ name, arguments: {} }), '旧持久PTY不能绕过新核心保护');
  await symlink(join(root, 'private'), join(workspace, 'alias'));
  assert.ok(protection.guard(exec('write', join(workspace, 'alias', '主权人设', '核心人设.md'))));
}));

it('任意命令和显式danger覆盖都要完整沙箱，工作区包住核心时只读', async () => scene(async ({ root, core, sandboxPolicy, sandbox }) => {
  assert.equal(sandboxPolicy.resolve({ mode: 'danger-full-access' }).mode, 'read-only', '临时目录中的核心卡也不能从临时可写根绕过');
  assert.equal(sandboxPolicy.resolve({ root }).mode, 'read-only');
  const result = await sandbox.confine(['node', '-e', 'arbitrary code'], { mode: 'danger-full-access', workspaceRoot: root });
  assert.equal(result.policy.mode, 'read-only');
  assert.equal(sandboxPolicy.resolve({ root: core }).mode, 'read-only');
}));

it('部分沙箱不能启动命令，卸载恢复原宿主方法', async () => scene(async ({ org, protection }) => {
  protection.stop();
  const resolve = () => ({ mode: 'danger-full-access', workspaceRoot: '/tmp' });
  const confine = async () => ({ argv: ['should-not-run'], enforcement: 'partial' });
  const sandboxPolicy = { resolve }; const sandbox = { confine };
  const p = createPersonaProtection({ org, sandboxPolicy, sandbox });
  await assert.rejects(sandbox.confine(['command'], resolve()), { code: 'PERSONA_CORE_CONFINEMENT' });
  p.stop();
  assert.equal(sandboxPolicy.resolve, resolve); assert.equal(sandbox.confine, confine);
  const missing = createPersonaProtection({ org });
  assert.ok(missing.guard({ name: 'bash', arguments: { command: 'anything' } }));
  missing.stop();
}));

it('仅当前完整沙箱创建的终端可续写，旧终端与其他owner不能借用证明', async () => scene(async ({ org, protection }) => {
  protection.stop();
  const owner = {}, other = {}; let sent = 0; const killed = [];
  const sandbox = { async confine(argv, policy) { return { argv, policy, enforcement: 'full' }; } };
  const sandboxPolicy = { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/tmp' }) };
  const terminals = {
    async spawn() { await sandbox.confine(['shell'], sandboxPolicy.resolve()); return { sessionId: 'new-tty' }; },
    startSend() { sent++; return 'operation'; },
    async kill(_owner, id) { killed.push(id); return true; },
  };
  const p = createPersonaProtection({ org, sandboxPolicy, sandbox, terminals });
  try {
    assert.throws(() => terminals.startSend(owner, 'old-tty', {}), { code: 'PERSONA_CORE_TERMINAL' });
    await terminals.spawn(owner, {});
    assert.equal(terminals.startSend(owner, 'new-tty', {}), 'operation');
    assert.throws(() => terminals.startSend(other, 'new-tty', {}), { code: 'PERSONA_CORE_TERMINAL' });
    assert.equal(sent, 1); assert.equal(killed.length, 0);
    assert.equal(p.health().terminalProof, true);
  } finally { p.stop(); }
  const unconfined = { ...terminals, async spawn() { return { sessionId: 'unconfined' }; } };
  const refused = createPersonaProtection({ org, sandboxPolicy, sandbox, terminals: unconfined });
  try { await assert.rejects(unconfined.spawn(owner, {}), { code: 'PERSONA_CORE_TERMINAL' }); assert.deepEqual(killed, ['unconfined']); }
  finally { refused.stop(); }
}));

it('核心尚未创建也保护未来写入，执行服务失去或更换时不沿用旧保护状态', async () => scene(async ({ core, org, protection }) => {
  protection.stop(); await rm(core);
  let services = {};
  const p = createPersonaProtection({ org, getServices: () => services });
  const exec = { name: 'bash', arguments: { command: 'anything' } };
  try {
    assert.ok(p.guard(exec));
    services = { sandboxPolicy: { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: '/tmp' }) },
      sandbox: { async confine(argv, policy) { return { argv, policy, enforcement: 'full' }; } } };
    assert.equal(p.guard(exec), undefined);
    const old = services.sandbox;
    services = {};
    assert.ok(p.guard(exec)); assert.equal(p.health().confinedExecution, false);
    assert.equal((await old.confine([], {})).policy.mode, undefined, '旧服务包装已恢复');
  } finally { p.stop(); }
  assert.equal(p.guard({ name: 'read' }), undefined);
  assert.ok(p.guard(exec));
}));
