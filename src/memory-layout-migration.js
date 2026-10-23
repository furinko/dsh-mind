/** 仅停机维护入口调用；不注册模型动作，不打开Org，不改写记忆正文。 */
import { readFile, readdir, lstat, mkdir, open, rename, realpath, copyFile, unlink, chmod } from 'node:fs/promises';
import { constants } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { atomicWrite, stripBom } from './kernel/fsx.js';
import { Fault } from './kernel/errors.js';
import { MEMORY_LAYOUT_FILE, MEMORY_TRANSACTION_FILE, MEMORY_OPERATION_LOCK, LEGACY_MEMORY_FUNCTIONS, memoryLayoutVersion } from './memory-layout.js';
import { MEMORY_KINDS, assertPathSegment } from './paths.js';

const fail = (message) => new Fault('MEMORY_MIGRATION_REFUSED', message);
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const ordered = (a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
const readJson = async (file) => JSON.parse(stripBom(await readFile(file, 'utf8')));
const present = async (file) => { try { return await lstat(file); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code !== 'ESRCH'; } };

export async function memoryTree(root) {
  const rows = [];
  async function visit(file, path = '') {
    const info = await present(file);
    if (!info) { if (!path) return; throw fail('盘点期间源文件消失。'); }
    if (info.isSymbolicLink() || (!info.isDirectory() && (!info.isFile() || info.nlink !== 1))) throw fail('记忆目录含链接、硬链接或特殊文件，需人工核对归属。');
    if (path) rows.push(info.isDirectory() ? { path, type: 'directory' } : { path, type: 'file', bytes: info.size, sha256: sha(await readFile(file)) });
    if (info.isDirectory()) for (const name of (await readdir(file)).sort()) await visit(join(file, name), path ? `${path}/${name}` : name);
  }
  await visit(root);
  return rows.sort(ordered);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

function targetOf(row) {
  if (row.path === MEMORY_LAYOUT_FILE) return null;
  const parts = row.path.split('/');
  parts.forEach((part) => assertPathSegment(part, '迁移路径段'));
  const [first, second] = parts;
  if (LEGACY_MEMORY_FUNCTIONS.includes(first)) {
    const limit = first === '轮级缓冲' ? 3 : 2;
    if ((row.type === 'file' && (parts.length !== limit || !parts.at(-1).endsWith('.json')))
      || (row.type === 'directory' && parts.length >= limit)) throw fail(`旧功能目录有不能自动归类的路径：${row.path}`);
    const prefix = first === '连续性提炼' ? ['提炼状态', '连续性'] : ['工作记忆', first === '轮级缓冲' ? '会话缓冲' : '项目接续'];
    return [...prefix, ...parts.slice(1)].join('/');
  }
  if ((row.type === 'file' && (parts.length !== 2 || !MEMORY_KINDS.some((kind) => second === `${kind}.jsonl`)))
    || (row.type === 'directory' && parts.length !== 1)) throw fail(`旧记忆目录有未知路径：${row.path}；保留源文件，先核对用途。`);
  return ['长期记忆', ...(first === '跨项目' ? [] : ['项目']), ...parts].join('/');
}

export async function planMemoryMigration(layout) {
  const root = layout.memoryRoot();
  const version = memoryLayoutVersion(root);
  if (version === 2) return { from: 2, to: 2, root, alreadyCurrent: true, entries: [] };
  const before = await memoryTree(root);
  const entries = before.flatMap((row) => { const to = targetOf(row); return to ? [{ ...row, to }] : []; });
  const targets = new Set();
  for (const row of entries) {
    const key = row.to.normalize('NFC').toLowerCase();
    if (targets.has(key)) throw fail('目标路径存在大小写或Unicode等价冲突，不自动合并。');
    targets.add(key);
  }
  return { from: 1, to: 2, root, before, entries, files: entries.filter((row) => row.type === 'file').length };
}

async function locations(layout, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)) throw fail('迁移回执ID不合法。');
  const parent = await realpath(dirname(resolve(layout.memoryRoot())));
  return { parent, root: join(parent, '记忆服务'), stage: join(parent, `记忆服务-迁移暂存-${id}`), backup: join(parent, `记忆服务-布局1备份-${id}`), discarded: join(parent, `记忆服务-布局2回退副本-${id}`), journal: join(parent, MEMORY_TRANSACTION_FILE), lock: join(parent, MEMORY_OPERATION_LOCK), receipt: join(parent, `记忆布局回执-${id}.json`) };
}

async function exclusively(paths, fn) {
  let handle;
  try { handle = await open(paths.lock, 'wx', 0o600); } catch (e) { if (e.code === 'EEXIST') throw fail('已有记忆维护锁；请确认旧维护进程退出后运行恢复。'); throw e; }
  const token = { pid: process.pid, id: randomUUID() };
  await handle.writeFile(JSON.stringify(token));
  try { return await fn(); } finally {
    await handle.close();
    const current = await readJson(paths.lock);
    if (current.id === token.id) await unlink(paths.lock);
  }
}
async function writeTransaction(paths, transaction) {
  await atomicWrite(paths.journal, JSON.stringify(transaction, null, 2));
  if (['committed', 'rolled-back'].includes(transaction.phase)) await atomicWrite(paths.receipt, JSON.stringify(transaction, null, 2));
}
async function assertTree(root, expected, description) {
  if (!(await present(root)) || !same(await memoryTree(root), expected)) throw fail(`${description}摘要或目录清单发生变化；不覆盖、不回退新写入的数据。`);
}
async function preservePermissions(paths, entries) {
  // 新增的语义层沿用原根权限；原有目录和文件沿用各自权限。先父后子，防止继承覆盖。
  const originals = new Map(entries.map((row) => [row.to, row.path]));
  const staged = [{ path: '', type: 'directory' }, ...(await memoryTree(paths.stage)).filter((row) => row.path !== MEMORY_LAYOUT_FILE)];
  staged.sort((a, b) => a.path.split('/').length - b.path.split('/').length || ordered(a, b));
  const pairs = staged.map((row) => ({ from: join(paths.root, originals.get(row.path) ?? ''), to: join(paths.stage, row.path), newLayer: row.type === 'directory' && row.path !== '' && !originals.has(row.path) }));
  if (process.platform === 'win32') {
    // 路径只经stdin传JSON，绝不拼接为PowerShell代码；同时核对DACL、所有者和组。
    const command = `
$ErrorActionPreference='Stop'
[Console]::InputEncoding=[Text.UTF8Encoding]::new($false)
$pairs=ConvertFrom-Json ([Console]::In.ReadToEnd())
$access=[System.Security.AccessControl.AccessControlSections]::Access
$sid=[System.Security.Principal.SecurityIdentifier]
function Rules($acl,$ignoreInherited) {
  ($acl.GetAccessRules($true,$true,$sid) | ForEach-Object {
    $key=$_.IdentityReference.Value+'|'+[int]$_.FileSystemRights+'|'+[int]$_.AccessControlType+'|'+[int]$_.InheritanceFlags+'|'+[int]$_.PropagationFlags
    if(!$ignoreInherited){$key+='|'+$_.IsInherited}; $key
  } | Sort-Object) -join ';'
}
foreach($pair in $pairs) {
  if([IO.Directory]::Exists($pair.from)) {$acl=[IO.Directory]::GetAccessControl($pair.from)} else {$acl=[IO.File]::GetAccessControl($pair.from)}
  if($pair.newLayer -and @($acl.GetAccessRules($true,$true,$sid) | Where-Object {$_.AccessControlType -eq 'Deny'}).Count) {throw 'Root ACL contains deny rules; explicit permission maintenance is required before adding protected layers'}
  if([IO.Directory]::Exists($pair.to)) {$copy=[System.Security.AccessControl.DirectorySecurity]::new()} else {$copy=[System.Security.AccessControl.FileSecurity]::new()}
  $copy.SetSecurityDescriptorSddlForm($acl.GetSecurityDescriptorSddlForm($access),$access)
  # 新的语义层复制原根的有效权限并固定继承，避免多一层时CREATOR OWNER自动增加授权。
  if($pair.newLayer){$copy.SetAccessRuleProtection($true,$true)}
  if([IO.Directory]::Exists($pair.to)) {[IO.Directory]::SetAccessControl($pair.to,$copy); $actual=[IO.Directory]::GetAccessControl($pair.to)} else {[IO.File]::SetAccessControl($pair.to,$copy); $actual=[IO.File]::GetAccessControl($pair.to)}
  $protected=if($pair.newLayer){$true}else{$acl.AreAccessRulesProtected}
  if(!$acl.AreAccessRulesCanonical -or !$actual.AreAccessRulesCanonical -or $actual.AreAccessRulesProtected -ne $protected -or
    $acl.GetOwner($sid).Value -cne $actual.GetOwner($sid).Value -or $acl.GetGroup($sid).Value -cne $actual.GetGroup($sid).Value -or
    (Rules $acl $pair.newLayer) -cne (Rules $actual $pair.newLayer)) {throw 'ACL verification failed'}
}
[Console]::Write($pairs.Count)`;
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { input: JSON.stringify(pairs), encoding: 'utf8', windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    if (Number(output) !== pairs.length) throw fail('Windows访问权限核对未完成，停止切换。');
  } else {
    for (const pair of pairs) {
      const source = await lstat(pair.from); const target = await lstat(pair.to);
      if (source.uid !== target.uid || source.gid !== target.gid) throw fail('迁移会改变文件所有者或组，需由原所有者维护。');
      await chmod(pair.to, source.mode & 0o7777);
      if (((await lstat(pair.to)).mode & 0o7777) !== (source.mode & 0o7777)) throw fail('Unix文件权限核对失败，停止切换。');
    }
  }
  return { platform: process.platform, checked: pairs.length };
}
async function finishForward(paths, tx, assertOffline, onStep) {
  if (await present(paths.backup)) {
    await assertTree(paths.backup, tx.before, '旧布局备份');
    if (await present(paths.root)) await assertTree(paths.root, tx.after, '新布局');
    else { await assertTree(paths.stage, tx.after, '迁移暂存'); await assertOffline(); await rename(paths.stage, paths.root); }
  } else {
    await assertTree(paths.root, tx.before, '迁移源');
    await assertTree(paths.stage, tx.after, '迁移暂存');
    await assertOffline();
    tx.phase = 'switching'; await writeTransaction(paths, tx);
    await rename(paths.root, paths.backup);
    await onStep('source-renamed');
    await rename(paths.stage, paths.root);
  }
  await assertTree(paths.root, tx.after, '新布局');
  await assertTree(paths.backup, tx.before, '旧布局备份');
  tx.phase = 'committed'; tx.committedAt ??= new Date().toISOString();
  await writeTransaction(paths, tx);
  return { ...tx, backup: paths.backup, receipt: paths.receipt };
}

export async function migrateMemoryLayout({ layout, assertOffline, onStep = async () => {} }) {
  if (typeof assertOffline !== 'function') throw fail('迁移必须由停机维护入口核对写入进程。');
  await assertOffline();
  const plan = await planMemoryMigration(layout);
  if (plan.alreadyCurrent) return plan;
  const id = randomUUID(); const paths = await locations(layout, id);
  return exclusively(paths, async () => {
    // 加锁前后的源清单须一致；后面不经运行态Layout读写，避免把锁当成无数据。
    if (!same(plan.before, await memoryTree(paths.root))) throw fail('源目录在准备期间变化，请停机后重试。');
    await mkdir(paths.stage);
    for (const row of plan.entries.filter((row) => row.type === 'directory')) await mkdir(join(paths.stage, row.to), { recursive: true });
    for (const row of plan.entries.filter((row) => row.type === 'file')) {
      await mkdir(dirname(join(paths.stage, row.to)), { recursive: true });
      await copyFile(join(paths.root, row.path), join(paths.stage, row.to), constants.COPYFILE_EXCL);
      if (sha(await readFile(join(paths.stage, row.to))) !== row.sha256) throw fail('复制后文件摘要不一致，停止切换。');
    }
    await atomicWrite(join(paths.stage, MEMORY_LAYOUT_FILE), JSON.stringify({ version: 2 }));
    const permissions = await preservePermissions(paths, plan.entries);
    const after = await memoryTree(paths.stage);
    const tx = { version: 1, id, phase: 'prepared', createdAt: new Date().toISOString(), before: plan.before, after, permissions };
    await writeTransaction(paths, tx);
    await onStep('prepared');
    return finishForward(paths, tx, assertOffline, onStep);
  });
}

async function transaction(layout) {
  const tx = await readJson(join(dirname(layout.memoryRoot()), MEMORY_TRANSACTION_FILE));
  if (tx?.version !== 1 || !Array.isArray(tx.before) || !Array.isArray(tx.after)) throw fail('迁移回执结构无效。');
  return { tx, paths: await locations(layout, tx.id) };
}
async function finishRollback(paths, tx, assertOffline, onStep) {
  if (await present(paths.backup)) {
    await assertTree(paths.backup, tx.before, '旧布局备份');
    if (await present(paths.root)) {
      await assertTree(paths.root, tx.after, '新布局');
      if (await present(paths.discarded)) throw fail('回退副本已存在，不能覆盖。');
      await assertOffline(); await rename(paths.root, paths.discarded); await onStep('v2-renamed');
    } else await assertTree(paths.discarded, tx.after, '布局2回退副本');
    await rename(paths.backup, paths.root);
  } else { await assertTree(paths.root, tx.before, '恢复后的旧布局'); await assertTree(paths.discarded, tx.after, '布局2回退副本'); }
  tx.phase = 'rolled-back'; tx.rolledBackAt = new Date().toISOString(); await writeTransaction(paths, tx);
  return { ...tx, retainedV2: paths.discarded, receipt: paths.receipt };
}
export async function recoverMemoryMigration({ layout, assertOffline, onStep = async () => {} }) {
  if (typeof assertOffline !== 'function') throw fail('恢复必须核对停机状态。');
  await assertOffline();
  const { tx, paths } = await transaction(layout);
  if (await present(paths.lock)) {
    const old = await readJson(paths.lock);
    if (!Number.isInteger(old.pid) || old.pid <= 0 || alive(old.pid)) throw fail('维护锁的进程仍在或无法证明已退出。');
    // 只隔离已证明死亡的锁；保留原令牌供核对，不递归删除任何目录。
    await rename(paths.lock, `${paths.lock}.已退出-${randomUUID()}`);
  }
  return exclusively(paths, async () => {
    if (tx.phase === 'rolling-back') return finishRollback(paths, tx, assertOffline, onStep);
    if (['prepared', 'switching', 'committed'].includes(tx.phase)) return finishForward(paths, tx, assertOffline, onStep);
    if (tx.phase === 'rolled-back') { await assertTree(paths.root, tx.before, '已回退布局'); return tx; }
    throw fail('未知迁移阶段，停止恢复。');
  });
}
export async function rollbackMemoryMigration({ layout, assertOffline, onStep = async () => {} }) {
  if (typeof assertOffline !== 'function') throw fail('回退必须核对停机状态。');
  await assertOffline(); const { tx, paths } = await transaction(layout);
  return exclusively(paths, async () => {
    if (tx.phase !== 'committed') throw fail('仅完整迁移后可以回退；中断操作先运行恢复。');
    await assertTree(paths.root, tx.after, '新布局'); await assertTree(paths.backup, tx.before, '旧布局备份');
    tx.phase = 'rolling-back'; await writeTransaction(paths, tx);
    return finishRollback(paths, tx, assertOffline, onStep);
  });
}
