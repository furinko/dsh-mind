/** 记忆布局的唯一映射；无标记的既有目录继续按布局1读取。 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { Fault } from './kernel/errors.js';
import { stripBom } from './kernel/fsx.js';

export const MEMORY_LAYOUT_FILE = '布局.json';
export const MEMORY_TRANSACTION_FILE = '记忆布局迁移.json';
export const MEMORY_OPERATION_LOCK = '记忆布局操作.lock';
export const LEGACY_MEMORY_FUNCTIONS = ['轮级缓冲', '项目接续', '连续性提炼'];
const invalid = (message) => new Fault('MEMORY_LAYOUT_INVALID', message);
const optional = (file) => { try { return JSON.parse(stripBom(readFileSync(file, 'utf8'))); } catch (e) { if (e.code === 'ENOENT') return undefined; throw invalid(`记忆布局元数据不可读：${file}；保留原文件并核对迁移回执。`); } };

export function memoryLayoutVersion(root) {
  const parent = dirname(root);
  if (existsSync(join(parent, MEMORY_OPERATION_LOCK))) throw invalid('记忆布局正在操作，暂停读写；若上次操作中断，请停机后运行迁移恢复。');
  const transaction = optional(join(parent, MEMORY_TRANSACTION_FILE));
  if (transaction !== undefined && (!transaction || typeof transaction !== 'object' || Array.isArray(transaction)
    || transaction.version !== 1 || !['committed', 'rolled-back'].includes(transaction.phase))) throw invalid('记忆布局迁移尚未收尾或回执无效，暂停读写；请停机后运行迁移恢复。');
  const marker = optional(join(root, MEMORY_LAYOUT_FILE));
  if (marker !== undefined && (!marker || typeof marker !== 'object' || Array.isArray(marker) || Object.keys(marker).length !== 1 || ![1, 2].includes(marker.version))) throw invalid('不支持的记忆布局版本，拒绝猜测读写路径。');
  const version = marker?.version ?? 1;
  if (transaction && ((transaction.phase === 'committed' && version !== 2) || (transaction.phase === 'rolled-back' && version !== 1))) throw invalid('记忆布局标记与迁移回执不一致，停止读写。');
  if (version === 2) {
    const allowed = new Set([MEMORY_LAYOUT_FILE, '长期记忆', '工作记忆', '提炼状态']);
    if (readdirSync(root).some((name) => !allowed.has(name))) throw invalid('布局2根目录混入旧路径或未知文件，停止读写以免遗漏旧账。');
  }
  return version;
}

export function memoryScopePath(root, scope) {
  return memoryLayoutVersion(root) === 1 ? join(root, scope)
    : scope === '跨项目' ? join(root, '长期记忆', '跨项目') : join(root, '长期记忆', '项目', scope);
}
export function memoryWorkPath(root, kind, ...parts) {
  if (memoryLayoutVersion(root) === 1) return join(root, kind, ...parts);
  if (kind === '连续性提炼') return join(root, '提炼状态', '连续性', ...parts);
  return join(root, '工作记忆', kind === '轮级缓冲' ? '会话缓冲' : '项目接续', ...parts);
}

export async function listMemoryProjects(root) {
  const version = memoryLayoutVersion(root);
  const directory = version === 2 ? join(root, '长期记忆', '项目') : root;
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  const scopes = [];
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw invalid('记忆项目目录包含链接，需核对真实归属。');
    if (!entry.isDirectory()) continue;
    if (version === 1 && entry.name === '跨项目') continue;
    if (version === 1 && LEGACY_MEMORY_FUNCTIONS.includes(entry.name)) {
      if ((await readdir(join(root, entry.name))).some((name) => name.endsWith('.jsonl'))) throw invalid(`旧布局功能目录「${entry.name}」同时包含记忆账本，不能自动认领为项目或忽略旧账。`);
      continue;
    }
    scopes.push(entry.name);
  }
  return scopes.sort();
}
