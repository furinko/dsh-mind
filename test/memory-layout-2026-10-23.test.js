import { it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, link, chmod, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Layout } from '../src/paths.js';
import { memoryLayoutVersion, listMemoryProjects, MEMORY_TRANSACTION_FILE } from '../src/memory-layout.js';
import { memoryTree, planMemoryMigration, migrateMemoryLayout, recoverMemoryMigration, rollbackMemoryMigration } from '../src/memory-layout-migration.js';
import { makeFixture, LEAD } from './helpers.mjs';
import { Org } from '../src/org.js';
const offline = async () => {};
const shaName = 'a'.repeat(64);
async function scene(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mind-memory-layout-'));
  const layout = new Layout({ factoryRoot: join(directory, 'factory'), privateRoot: join(directory, 'private') });
  const root = layout.memoryRoot();
  const put = async (path, bytes) => { await mkdir(dirname(join(root, path)), { recursive: true }); await writeFile(join(root, path), bytes); };
  try {
    await mkdir(root, { recursive: true });
    await put('跨项目/偏好.jsonl', Buffer.from('\ufeff{"id":"pref","项目":"通用"}\r\n'));
    await put('repos/知识.jsonl', '{"id":"k","项目":"repos"}\n');
    await put(`轮级缓冲/repos/${shaName}.json`, '{"source":"synthetic"}');
    await put('项目接续/repos.json', '{"revision":7}');
    await put('连续性提炼/repos.json', '{"revision":3}');
    await mkdir(join(root, 'default')); // 空项目也保留独立身份。
    await run({ layout, root, put, directory, migrate: (extra = {}) => migrateMemoryLayout({ layout, assertOffline: offline, ...extra }), recover: (extra = {}) => recoverMemoryMigration({ layout, assertOffline: offline, ...extra }), rollback: (extra = {}) => rollbackMemoryMigration({ layout, assertOffline: offline, ...extra }) });
  } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }); }
}

it('旧布局只读预检排除功能目录、保留空项目，不写元数据或改源字节', () => scene(async ({ layout, root }) => {
  const before = await memoryTree(root);
  assert.deepEqual(await listMemoryProjects(root), ['default', 'repos']);
  const plan = await planMemoryMigration(layout);
  assert.equal(plan.files, 5);
  assert.deepEqual(await memoryTree(root), before);
  assert.equal(memoryLayoutVersion(root), 1);
}));

it('迁移后使用三层路径；BOM/CRLF、条目ID、空项目和旧备份全部原样保留', () => scene(async ({ layout, root, migrate }) => {
  const old = new Map((await memoryTree(root)).filter((row) => row.type === 'file').map((row) => [row.path, row.sha256]));
  const core = layout.personaCoreFile(); await mkdir(dirname(core), { recursive: true }); await writeFile(core, 'synthetic-human-core');
  const result = await migrate();
  assert.ok(result.permissions.checked > 5);
  assert.equal(memoryLayoutVersion(root), 2);
  assert.equal(layout.memoryLog('repos', '知识'), join(root, '长期记忆/项目/repos/知识.jsonl'));
  assert.equal(layout.memoryLog('跨项目', '偏好'), join(root, '长期记忆/跨项目/偏好.jsonl'));
  assert.equal(layout.turnBufferFile('repos', shaName), join(root, `工作记忆/会话缓冲/repos/${shaName}.json`));
  assert.equal(layout.projectBriefFile('repos'), join(root, '工作记忆/项目接续/repos.json'));
  assert.equal(layout.continuityCaptureFile('repos'), join(root, '提炼状态/连续性/repos.json'));
  assert.deepEqual(await listMemoryProjects(root), ['default', 'repos']);
  const plan = JSON.parse(await readFile(result.receipt, 'utf8'));
  assert.deepEqual(new Map(plan.before.filter((row) => row.type === 'file').map((row) => [row.path, row.sha256])), old);
  assert.deepEqual(await memoryTree(result.backup), plan.before);
  assert.equal(await readFile(core, 'utf8'), 'synthetic-human-core');
  assert.deepEqual(await readFile(layout.memoryLog('跨项目', '偏好')), await readFile(join(result.backup, '跨项目/偏好.jsonl')));
}));

it('迁移保留原有权限，新增层级沿用原根权限', () => scene(async ({ layout, root, migrate }) => {
  const source = join(root, 'repos/知识.jsonl');
  if (process.platform !== 'win32') {
    await chmod(root, 0o700); await chmod(join(root, 'repos'), 0o750); await chmod(source, 0o640);
  } else {
    const command = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=ConvertFrom-Json ([Console]::In.ReadToEnd()); $acl=[IO.File]::GetAccessControl($p); $acl.SetAccessRuleProtection($true,$true); [IO.File]::SetAccessControl($p,$acl)`;
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { input: JSON.stringify(source), encoding: 'utf8', windowsHide: true });
  }
  await migrate();
  if (process.platform !== 'win32') {
    assert.equal((await stat(root)).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, '长期记忆'))).mode & 0o777, 0o700);
    assert.equal((await stat(join(root, '长期记忆/项目/repos'))).mode & 0o777, 0o750);
    assert.equal((await stat(layout.memoryLog('repos', '知识'))).mode & 0o777, 0o640);
  } // Windows每个源与目标的DACL/所有者/组由迁移本身逐项比较；含上面禁止继承的文件。
}));

it('Windows CREATOR OWNER继承权限在新层级仍保持相同访问规则', { skip: process.platform !== 'win32' }, () => scene(async ({ root, migrate }) => {
  const command = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=ConvertFrom-Json ([Console]::In.ReadToEnd()); $acl=[IO.Directory]::GetAccessControl($p); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-3-0'),[System.Security.AccessControl.FileSystemRights]::FullControl,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::InheritOnly,[System.Security.AccessControl.AccessControlType]::Allow); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($p,$acl)`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { input: JSON.stringify(root), encoding: 'utf8', windowsHide: true });
  await migrate();
}));

it('Windows原根含拒绝规则时不自动转换继承，保留源目录等待人工核对权限顺序', { skip: process.platform !== 'win32' }, () => scene(async ({ root, migrate }) => {
  const command = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); $p=ConvertFrom-Json ([Console]::In.ReadToEnd()); $acl=[IO.Directory]::GetAccessControl($p); $rule=[System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]::new('S-1-5-21-1-2-3-9999'),[System.Security.AccessControl.FileSystemRights]::WriteData,[System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit',[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Deny); $acl.AddAccessRule($rule); [IO.Directory]::SetAccessControl($p,$acl)`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { input: JSON.stringify(root), encoding: 'utf8', windowsHide: true });
  const before = await memoryTree(root);
  try { await migrate(); assert.fail('拒绝规则必须人工核对'); }
  catch (error) { assert.match(error.stderr, /Root ACL contains deny rules/); }
  assert.equal(memoryLayoutVersion(root), 1);
  assert.deepEqual(await memoryTree(root), before);
}));

it('重复迁移只读返回当前版本；不另造备份或双写旧路径', () => scene(async ({ layout, root, migrate }) => {
  await migrate(); const before = await memoryTree(root);
  assert.equal((await migrate()).alreadyCurrent, true);
  assert.deepEqual(await memoryTree(root), before);
  await writeFile(layout.memoryLog('repos', '知识'), 'new-v2-write');
  await assert.rejects(readFile(join(root, 'repos/知识.jsonl')), { code: 'ENOENT' });
}));

for (const stage of ['prepared', 'source-renamed']) it(`中断于${stage}时运行态拒绝读写，停机恢复后完整切换`, () => scene(async ({ layout, root, migrate, recover }) => {
  await assert.rejects(migrate({ onStep: async (step) => { if (step === stage) throw Error('injected crash'); } }), /injected crash/);
  assert.throws(() => layout.memoryDir('repos'), /迁移尚未收尾/);
  await recover();
  assert.equal(memoryLayoutVersion(root), 2);
  assert.equal((await readFile(layout.projectBriefFile('repos'), 'utf8')), '{"revision":7}');
}));

it('切换前源发生变化时拒绝替换，并保留变化和暂存供核对', () => scene(async ({ root, put, migrate, recover }) => {
  await assert.rejects(migrate({ onStep: async (step) => { if (step === 'prepared') await put('repos/知识.jsonl', 'concurrent write'); } }), /迁移源.*变化/);
  assert.equal(await readFile(join(root, 'repos/知识.jsonl'), 'utf8'), 'concurrent write');
  await assert.rejects(recover(), /变化/);
}));

it('恢复前暂存被改动时不覆盖源目录', () => scene(async ({ root, migrate, recover }) => {
  const before = await memoryTree(root);
  await assert.rejects(migrate({ onStep: async (step) => { if (step === 'prepared') throw Error('pause'); } }), /pause/);
  const tx = JSON.parse(await readFile(join(dirname(root), MEMORY_TRANSACTION_FILE), 'utf8'));
  await writeFile(join(dirname(root), `记忆服务-迁移暂存-${tx.id}/长期记忆/项目/repos/知识.jsonl`), 'changed');
  await assert.rejects(recover(), /暂存.*变化/);
  assert.deepEqual(await memoryTree(root), before);
}));

it('未产生新写入时可回退，保留布局2副本和原有字节', () => scene(async ({ root, migrate, rollback }) => {
  const before = await memoryTree(root); await migrate(); const result = await rollback();
  assert.equal(memoryLayoutVersion(root), 1);
  assert.deepEqual(await memoryTree(root), before);
  assert.equal(JSON.parse(await readFile(join(result.retainedV2, '布局.json'), 'utf8')).version, 2);
}));

it('布局2已有新数据时禁止回退覆盖', () => scene(async ({ layout, root, migrate, rollback }) => {
  await migrate(); await writeFile(layout.memoryLog('repos', '知识'), 'new data');
  await assert.rejects(rollback(), /新布局.*变化/);
  assert.equal(memoryLayoutVersion(root), 2);
  assert.equal(await readFile(layout.memoryLog('repos', '知识'), 'utf8'), 'new data');
}));

it('回退中断可恢复，期间不重新初始化空记忆目录', () => scene(async ({ root, migrate, rollback, recover }) => {
  const before = await memoryTree(root); await migrate();
  await assert.rejects(rollback({ onStep: async (step) => { if (step === 'v2-renamed') throw Error('rollback crash'); } }), /rollback crash/);
  assert.throws(() => memoryLayoutVersion(root), /尚未收尾/);
  await recover(); assert.equal(memoryLayoutVersion(root), 1); assert.deepEqual(await memoryTree(root), before);
}));

for (const marker of ['{broken', 'null', 'false', '{"version":3}']) it(`无效布局标记不猜旧路径：${marker}`, () => scene(async ({ root, put }) => {
  await put('布局.json', marker); assert.throws(() => memoryLayoutVersion(root), /布局/);
}));

it('布局2混入旧项目目录时拒绝静默忽略', () => scene(async ({ root, migrate }) => {
  await migrate(); await mkdir(join(root, 'repos')); assert.throws(() => memoryLayoutVersion(root), /混入旧路径/);
}));

it('旧功能名与正式项目账本冲突时拒绝自动归属；未知文件保留不移动', () => scene(async ({ root, layout, put }) => {
  await put('轮级缓冲/知识.jsonl', 'ambiguous');
  await assert.rejects(listMemoryProjects(root), /不能自动认领/);
  await assert.rejects(planMemoryMigration(layout), /不能自动归类/);
  assert.equal(await readFile(join(root, '轮级缓冲/知识.jsonl'), 'utf8'), 'ambiguous');
}));

it('未知文件与链接不参与自动迁移', () => scene(async ({ layout, put, root }) => {
  await put('repos/unknown.txt', 'keep'); await assert.rejects(planMemoryMigration(layout), /未知路径/);
  await rm(join(root, 'repos/unknown.txt')); await link(join(root, 'repos/知识.jsonl'), join(root, 'repos/经历.jsonl'));
  await assert.rejects(planMemoryMigration(layout), /硬链接/);
}));

it('缺少停机校核或校核仍活跃时，源目录与元数据不变', () => scene(async ({ root, layout, migrate }) => {
  const before = await memoryTree(root);
  await assert.rejects(migrateMemoryLayout({ layout }), /停机/);
  await assert.rejects(migrate({ assertOffline: async () => { throw Error('still active'); } }), /still active/);
  assert.deepEqual(await memoryTree(root), before);
}));

it('实际CLI缺省只读，未确认停机不得实际迁移', () => scene(async ({ layout, root }) => {
  const script = fileURLToPath(new URL('../scripts/migrate-memory-layout.mjs', import.meta.url));
  const before = await memoryTree(root);
  const output = execFileSync(process.execPath, [script, '--private-root', layout.privateRoot], { encoding: 'utf8' });
  assert.equal(JSON.parse(output).mode, 'plan');
  assert.throws(() => execFileSync(process.execPath, [script, '--private-root', layout.privateRoot, '--apply'], { encoding: 'utf8', stdio: 'pipe' }), /Command failed/);
  assert.deepEqual(await memoryTree(root), before);
}));

it('停机CLI拒绝身份档案中仍存活的真实PID，不因人工确认而跳过检查', t => scene(async ({ layout, root }) => {
  const script = fileURLToPath(new URL('../scripts/migrate-memory-layout.mjs', import.meta.url));
  await mkdir(dirname(layout.identityFile()), { recursive: true });
  await writeFile(layout.identityFile(), JSON.stringify({ members: { synthetic: { pid: process.pid } } }));
  const before = await memoryTree(root);
  try {
    execFileSync(process.execPath, [script, '--private-root', layout.privateRoot, '--check-offline', '--offline'], { encoding: 'utf8', stdio: 'pipe' });
    assert.fail('必须拒绝活跃PID');
  } catch (error) {
    if (process.platform === 'win32' && error.stderr?.includes('0x80041003')) t.skip('当前沙箱无WMI进程目录权限；保持拒绝，需在有权限的部署检查中验证PID。');
    else assert.match(error.stderr, /仍存活|桌面进程仍在运行/);
  }
  assert.deepEqual(await memoryTree(root), before);
}));

it('真实Memory/TurnBuffer/ProjectBrief服务在迁移前后读回一致，新写入仅落布局2', async () => {
  const f = await makeFixture();
  try {
    const org = await Org.open({ home: f.home, factoryRoot: f.factoryRoot, privateRoot: f.privateRoot, project: 'layout-project' });
    const pref = await org.memory.remember({ subject: LEAD, 类: '偏好', 内容: '合成偏好', 来源: '迁移测试' });
    const knowledge = await org.memory.remember({ subject: LEAD, 类: '知识', 内容: '合成本地知识', 来源: '迁移测试', 项目: 'layout-project' });
    const other = await org.memory.remember({ subject: LEAD, 类: '知识', 内容: '另一项目合成知识', 来源: '迁移测试', 项目: 'layout-other' });
    const spec = { subject: LEAD, project: 'layout-project', session: LEAD.id };
    await org.turnBuffer.capture({ ...spec, fromSeq: 0, throughSeq: 3, records: [{ seq: 0, type: 'turn/start', turn: 1, time: Date.now() }, { seq: 1, type: 'message', turn: 1, role: 'user', text: '合成轮缓冲', id: 'message', clipped: false, interrupted: false, time: Date.now() }, { seq: 2, type: 'turn/end', turn: 1, reason: 'completed', time: Date.now() }] });
    await org.projectBrief.touch(spec);
    const buffer = await org.turnBuffer.load(spec.project, spec.session); const brief = await org.projectBrief.load(spec.project);
    await migrateMemoryLayout({ layout: org.layout, assertOffline: offline });
    assert.deepEqual(await org.turnBuffer.load(spec.project, spec.session), buffer);
    assert.deepEqual(await org.projectBrief.load(spec.project), brief);
    const ids = (await org.memory.query({ subject: LEAD, 项目: spec.project })).条目.map((row) => row.id);
    assert.ok(ids.includes(pref.id) && ids.includes(knowledge.id));
    assert.ok(!ids.includes(other.id));
    const otherIds = (await org.memory.query({ subject: LEAD, 项目: 'layout-other' })).条目.map(row => row.id);
    assert.ok(otherIds.includes(other.id) && !otherIds.includes(knowledge.id));
    await org.memory.remember({ subject: LEAD, 类: '知识', 内容: '迁移后追加', 来源: '迁移测试', 项目: spec.project });
    assert.match(await readFile(org.layout.memoryLog(spec.project, '知识'), 'utf8'), /迁移后追加/);
    await assert.rejects(readFile(join(org.layout.memoryRoot(), spec.project, '知识.jsonl')), { code: 'ENOENT' });
    await org.memory.invalidate(knowledge.id, { subject: LEAD, 原因: '合成迁移后失效' });
    assert.ok(!(await org.memory.query({ subject: LEAD, 项目: spec.project })).条目.some(row => row.id === knowledge.id));
    await org.turnBuffer.forget({ ...spec, throughSeq: 3 });
    assert.deepEqual((await org.turnBuffer.load(spec.project, spec.session)).rounds, []);
    assert.ok((await org.memory.query({ subject: LEAD, 项目: 'layout-other' })).条目.some(row => row.id === other.id));
  } finally { await f.cleanup(); }
});
