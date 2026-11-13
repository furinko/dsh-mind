/** One writer fence for ledger replacement and append. No permanent body history. */
import { basename, dirname, join } from 'node:path';
import { readdir, rm } from 'node:fs/promises';
import { atomicWrite, readJsonOrNull, readTextOrNull, serializeByKey, withLock } from './kernel/fsx.js';
import { Fault } from './kernel/errors.js';
import { digest } from './kernel/text.js';
import { randomUUID } from 'node:crypto';

export const maintenanceFile = layout => join(dirname(layout.memoryRoot()), 'memory-maintenance.json');
export const maintenanceLock = layout => maintenanceFile(layout) + '.lock';
export const maintenanceWriter = (layout, callback) => serializeByKey(maintenanceLock(layout), () => withLock(maintenanceLock(layout), callback));
export async function assertMemoryReady(layout) {
  const journal = await readJsonOrNull(maintenanceFile(layout));
  if (journal && journal.phase !== 'committed') throw new Fault('MEMORY_MAINTENANCE_PENDING', '记忆整理中断；先在维护窗口恢复整理，不读取半份资料。');
}
export async function memoryGeneration(layout) {
  const journal = await readJsonOrNull(maintenanceFile(layout));
  if (journal && journal.phase !== 'committed') throw new Fault('MEMORY_MAINTENANCE_PENDING', '记忆整理尚未完成，丢弃旧读取。');
  return journal?.revision ?? digest(JSON.stringify(journal));
}
export async function memoryReadSnapshot(layout, read) {
  const before = await memoryGeneration(layout);
  const result = await read();
  if (before !== await memoryGeneration(layout)) throw new Fault('MEMORY_READ_CHANGED', '记忆已修正或遗忘，丢弃旧读取并按当前状态重试。');
  return result;
}
export async function ledgerWrite(layout, file, callback) {
  return maintenanceWriter(layout, async () => {
    await assertMemoryReady(layout);
    return withLock(file + '.lock', callback);
  });
}
async function cleanTemps(file) {
  const prefix = basename(file) + '.tmp-';
  let files;
  try { files = await readdir(dirname(file)); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
  for (const name of files) if (name.startsWith(prefix)) await rm(join(dirname(file), name), {force:true});
}
/** Redo is idempotent. Refuse an unexpected writer rather than overwrite it. */
export async function finishMaintenance(layout, journal) {
  for (const change of journal.changes) {
    const current = await readTextOrNull(change.file) ?? '';
    if (digest(current) === digest(change.after)) continue;
    if (digest(current) !== change.before) throw new Fault('MEMORY_MAINTENANCE_CONFLICT', '整理后出现未登记写入，保留现场，不覆盖新成果。');
    await atomicWrite(change.file, change.after);
  }
  for (const file of [...(journal.files ?? journal.changes.map(c=>c.file)), maintenanceFile(layout)]) await cleanTemps(file);
  const receipt = { version: 1, phase: 'committed', revision: randomUUID(), at: journal.at, operation: journal.operation,
    files: journal.changes.length, bytesBefore: journal.bytesBefore,
    bytesAfter: journal.changes.reduce((n, c) => n + Buffer.byteLength(c.after), 0), undoDays: 0 };
  // The pending journal is the only redo copy; success removes every old body.
  await atomicWrite(maintenanceFile(layout), JSON.stringify(receipt) + '\n');
  return receipt;
}
