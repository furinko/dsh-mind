#!/usr/bin/env node
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { Layout, kernelFactoryRoot } from '../src/paths.js';
import { planMemoryMigration, migrateMemoryLayout, recoverMemoryMigration, rollbackMemoryMigration } from '../src/memory-layout-migration.js';
import { stripBom } from '../src/kernel/fsx.js';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log('记忆布局迁移（缺省只读预检）\nnode scripts/migrate-memory-layout.mjs [--private-root <私有区>]\n停机检查：--check-offline --offline（不写入）。\n停机操作：加 --offline 与 --apply / --recover / --rollback 之一。\n--offline 是部署者确认已停止所有写入者；命令另检查桌面进程及身份档案中的存活PID，拒绝已知活跃进程。\nWindows历史PID复用：部署者可用 --non-writer-proof <JSON> 提供逐进程人工核对的非写入者证据；每次检查均重新比对启动时间、可执行路径及父进程，不支持只忽略PID。');
  process.exit(0);
}
try {
  let privateRoot = join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'mind-data', 'mind-private');
  let mode = 'plan'; let offline = false; let proofFile;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--private-root' && args[i + 1] && !args[i + 1].startsWith('--')) privateRoot = resolve(args[++i]);
    else if (args[i] === '--non-writer-proof' && !proofFile && args[i + 1] && !args[i + 1].startsWith('--')) proofFile = resolve(args[++i]);
    else if (args[i] === '--offline') offline = true;
    else if (['--apply', '--recover', '--rollback', '--check-offline'].includes(args[i]) && mode === 'plan') mode = args[i].slice(2);
    else throw Error(`未知或重复参数：${args[i]}`);
  }
  const layout = new Layout({ factoryRoot: kernelFactoryRoot(), privateRoot });
  let proofs = [];
  if (proofFile) {
    if (process.platform !== 'win32') throw Error('非写入者进程证据目前仅支持Windows进程事实核对。');
    const document = JSON.parse(stripBom(await readFile(proofFile, 'utf8')));
    if (document?.version !== 1 || !Array.isArray(document.processes) || !document.processes.length) throw Error('非写入者证据结构无效。');
    proofs = document.processes;
    if (proofs.some(p => !Number.isInteger(p.pid) || p.pid <= 0 || p.confirmedNonWriter !== true || typeof p.reason !== 'string' || !p.reason.trim()
      || !Number.isFinite(Date.parse(p.startedAt)) || typeof p.executablePath !== 'string' || !p.executablePath.trim()
      || !Number.isInteger(p.parentPid) || p.parentPid <= 0 || (p.parentAbsent !== true && (!Number.isFinite(Date.parse(p.parentStartedAt))
      || typeof p.parentExecutablePath !== 'string' || !p.parentExecutablePath.trim()))) || new Set(proofs.map(p => p.pid)).size !== proofs.length) throw Error('非写入者证据缺少精确进程与父进程事实或人工结论。');
  }
  const verifiedNonWriters = [];
  function provenNonWriter(pid, processes) {
    const proof = proofs.find(p => p.pid === pid); if (!proof) return false;
    const current = processes.get(pid); const parent = processes.get(current.parentPid);
    if (current.pid !== proof.pid || current.parentPid !== proof.parentPid || current.executablePath !== proof.executablePath
      || Date.parse(current.startedAt) !== Date.parse(proof.startedAt) || (proof.parentAbsent === true ? !!parent
        : !parent || parent.executablePath !== proof.parentExecutablePath || Date.parse(parent.startedAt) !== Date.parse(proof.parentStartedAt))) throw Error(`PID ${pid} 的非写入者证据已变化，拒绝忽略。`);
    if (!verifiedNonWriters.some(p => p.pid === pid)) verifiedNonWriters.push(proof);
    return true;
  }
  const assertOffline = async () => {
    if (!offline) throw Error('实际切换需要先退出所有DSH写入进程，并显式提供 --offline；缺省预检不写任何文件。');
    let processes;
    if (process.platform === 'win32') {
      // Windows的kill(pid,0)可能对已退出的进程返回EPERM；改用成功完成的系统进程枚举。
      const command = `$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); @(Get-CimInstance Win32_Process -ErrorAction Stop | ForEach-Object { @{pid=[int]$_.ProcessId; name=$_.Name; executablePath=$_.ExecutablePath; parentPid=[int]$_.ParentProcessId; startedAt=$(if($_.CreationDate){$_.CreationDate.ToUniversalTime().ToString('o')}else{$null})} }) | ConvertTo-Json -Compress`;
      const rows = JSON.parse(execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], { encoding: 'utf8', windowsHide: true, timeout: 30000 }));
      if (!Array.isArray(rows) || !rows.length) throw Error('系统进程目录不可核对，拒绝迁移。');
      processes = new Map(rows.map(p => [p.pid, p]));
      if (rows.some(p => p.name?.toLowerCase() === 'deepseek harness.exe')) throw Error('DSH桌面进程仍在运行，请完整退出客户端后再迁移；不会强制结束进程。');
    }
    let identity;
    try { identity = JSON.parse(stripBom(await readFile(layout.identityFile(), 'utf8'))); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    const pids = new Set();
    function visit(value) { if (!value || typeof value !== 'object') return; for (const [key, child] of Object.entries(value)) { if (key === 'pid' && Number.isInteger(child) && child > 0) pids.add(child); else visit(child); } }
    visit(identity);
    for (const pid of pids) {
      let exists = processes ? processes.has(pid) : true;
      if (!processes) try { process.kill(pid, 0); } catch (e) { if (e.code === 'ESRCH') exists = false; }
      if (exists && !(processes && provenNonWriter(pid, processes))) throw Error(`身份档案记录的进程 ${pid} 仍存活或不可核对，请先停止对应写入者。`);
    }
  };
  const actions = { apply: migrateMemoryLayout, recover: recoverMemoryMigration, rollback: rollbackMemoryMigration };
  const result = mode === 'plan' ? await planMemoryMigration(layout)
    : mode === 'check-offline' ? (await assertOffline(), { offlineChecked: true }) : await actions[mode]({ layout, assertOffline });
  console.log(JSON.stringify({ mode, ...result, verifiedNonWriters }, null, 2));
} catch (error) { console.error(`记忆布局操作未完成：${error.message}`); process.exitCode = 1; }
