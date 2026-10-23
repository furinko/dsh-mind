import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPersonaProtection } from '../components/kernel/lib/persona-protection.js';
import { Org } from '../src/org.js';
import { makeFixture, LEAD } from './helpers.mjs';
import { runAction } from '../lib/actions.js';

async function scene(platform, run) {
  const directory = await mkdtemp(join(tmpdir(), 'persona-platform-'));
  const workspace = join(directory, 'workspace');
  await mkdir(workspace);
  const org = { layout: { personaCoreFile: () => join(directory, 'private', '主权人设', '核心人设.md') } };
  let reported = 'partial'; let fail = false; let next = 0;
  const result = { argv: ['native-runner'], enforcement: 'partial', denialSignatures: ['native-denial'] };
  const sandboxPolicy = { resolve: () => ({ mode: 'danger-full-access', workspaceRoot: workspace }) };
  const sandbox = { async confine() { if (fail) throw Error('provider unavailable'); return { ...result, enforcement: reported }; } };
  const terminals = {
    async spawn() { await sandbox.confine(['native-shell'], sandboxPolicy.resolve()); return { sessionId: `pty-${++next}` }; },
    startSend() { return { accepted: true }; }, async kill() { return true; },
  };
  let services = { sandboxPolicy, sandbox, terminals };
  const p = createPersonaProtection({ org, ...services, getServices: () => services, platform });
  try { await run({ p, org, workspace, sandboxPolicy, sandbox, terminals,
    report: value => { reported = value; }, fail: () => { fail = true; },
    replace: value => { services = value; } }); }
  finally { p.stop(); await rm(directory, { recursive: true, force: true }); }
}

it('Windows原生部分隔离允许命令及已证明终端，文件工具仍拒写核心和父目录', async () => scene('win32', async ({ p, org, workspace, sandbox, sandboxPolicy, terminals }) => {
  assert.equal(p.health().lastEnforcement, null);
  assert.match(p.health().执行状态, /尚未核实/);
  assert.match(p.health().保护范围, /不能保证任意命令/);
  const result = await sandbox.confine(['shell'], sandboxPolicy.resolve());
  assert.equal(result.enforcement, 'partial');
  assert.deepEqual(result.argv, ['native-runner']);
  assert.deepEqual(result.denialSignatures, ['native-denial']);
  assert.equal(p.health().lastEnforcement, 'partial');
  assert.match(p.health().执行状态, /部分隔离/);
  const exec = path => ({ name: 'write', arguments: { file_path: path }, agent: { session: { header: { cwd: workspace } } } });
  assert.ok(p.guard(exec(org.layout.personaCoreFile())));
  assert.ok(p.guard(exec(join(workspace, '..', 'private'))));
  assert.equal(p.guard(exec(join(workspace, 'work.js'))), undefined);
  const owner = {};
  assert.throws(() => terminals.startSend(owner, 'old', {}), { code: 'PERSONA_CORE_TERMINAL' });
  const created = await terminals.spawn(owner, {});
  assert.equal(terminals.startSend(owner, created.sessionId, {}).accepted, true);
  assert.throws(() => terminals.startSend({}, created.sessionId, {}), { code: 'PERSONA_CORE_TERMINAL' });
}));

it('Linux和macOS保持完整隔离要求，Windows也不接受未知或无隔离返回', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) await scene(platform, async ({ p, sandbox, sandboxPolicy, report }) => {
    if (platform !== 'win32') await assert.rejects(sandbox.confine([], sandboxPolicy.resolve()), { code: 'PERSONA_CORE_CONFINEMENT' });
    for (const invalid of [undefined, 'none', 'unknown']) {
      report(invalid);
      await assert.rejects(sandbox.confine([], sandboxPolicy.resolve()), { code: 'PERSONA_CORE_CONFINEMENT' });
      assert.equal(p.health().lastEnforcement, 'unknown');
    }
    report('full');
    assert.equal((await sandbox.confine([], sandboxPolicy.resolve())).enforcement, 'full');
    assert.equal(p.health().lastEnforcement, 'full');
  });
});

it('Windows执行失败、服务替换和服务消失不能沿用已观测的部分隔离', async () => scene('win32', async ({ p, sandbox, sandboxPolicy, fail, replace }) => {
  await sandbox.confine([], sandboxPolicy.resolve());
  fail();
  await assert.rejects(sandbox.confine([], sandboxPolicy.resolve()), /provider unavailable/);
  assert.equal(p.health().lastEnforcement, null);
  const next = { async confine() { return { argv: [], enforcement: 'partial' }; } };
  replace({ sandboxPolicy, sandbox: next });
  assert.equal(p.guard({ name: 'pwsh' }), undefined);
  assert.equal(p.health().lastEnforcement, null);
  await next.confine([], sandboxPolicy.resolve());
  assert.equal(p.health().lastEnforcement, 'partial');
  replace({});
  assert.ok(p.guard({ name: 'pwsh' }));
  assert.equal(p.health().lastEnforcement, null);
  assert.match(p.health().执行状态, /未接线/);
}));

it('状态、工作台和项目接续查询共享真实保护范围，未接线时不编造隔离结论', async () => {
  const f = await makeFixture(); const project = 'persona-platform';
  const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project });
  try {
    assert.equal((await org.status()).核心人设保护, null);
    org.personaProtection = createPersonaProtection({ org, platform: 'win32' });
    const health = org.personaProtection.health();
    assert.equal((await org.status()).核心人设保护.保护范围, health.保护范围);
    assert.equal((await org.workbench()).核心人设保护.保护范围, health.保护范围);
    const session = { id: LEAD.id, header: { cwd: process.cwd() } };
    const result = await runAction({ org, 项目: project, 主体: LEAD,
      args: { action: 'project_brief_query' }, 宿主: { project, agent: { session } } });
    assert.equal(result.核心人设保护.platform, 'win32');
    assert.equal(result.核心人设保护.lastEnforcement, null);
    assert.match(result.核心人设保护.保护范围, /部分隔离/);
  } finally { org.personaProtection?.stop(); await org.observability.flush(); await f.cleanup(); }
});
