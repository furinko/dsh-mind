/** Read-only source adapters. Files are data; their paths and contents never configure Mind. */
import { constants } from 'node:fs';
import { lstat, open, readdir, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep, extname } from 'node:path';
import { digest } from './kernel/text.js';
import { Fault, InvalidBody } from './kernel/errors.js';

export const TEXT_EXTENSIONS = Object.freeze(['.md', '.txt', '.json', '.jsonl', '.html', '.htm', '.vtt', '.srt', '.xml', '.yaml', '.yml', '.rst']);
export const DOCUMENT_EXTENSIONS = Object.freeze(['.pdf', '.docx', '.pptx', '.xlsx', '.csv', '.tsv', '.epub']);
export const INFORMATION_EXTENSIONS = Object.freeze([...TEXT_EXTENSIONS, ...DOCUMENT_EXTENSIONS]);
export const inside = (root, file) => { const p = relative(root, file); return p === '' || (!isAbsolute(p) && p !== '..' && !p.startsWith(`..${sep}`)); };
const signature = s => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;

export async function sourceRoot(directory, excluded = []) {
  if (typeof directory !== 'string' || !isAbsolute(directory)) throw new InvalidBody('信息来源需要本机绝对目录。');
  const root = resolve(directory);
  const canonical = await realpath(root);
  if (resolve(canonical) !== root) throw new InvalidBody('请填写来源目录的真实路径，不使用符号链接或目录别名。');
  if (excluded.some(p => inside(resolve(p), root) || inside(root, resolve(p)))) throw new InvalidBody('信息来源不能包含 Mind 私有数据、出厂目录或索引目录，避免自我收录。');
  const info = await lstat(root);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new InvalidBody('信息来源必须是普通目录。');
  return { path: root, identity: `${info.dev}:${info.ino}` };
}

export async function verifyRoot(source) {
  const info = await lstat(source.path);
  if (!info.isDirectory() || info.isSymbolicLink() || resolve(await realpath(source.path)) !== source.path
      || `${info.dev}:${info.ino}` !== source.identity) throw new Fault('INFORMATION_SOURCE_CHANGED', '来源目录已被替换，请在设置中重新核对并连接。');
}

/** Check every directory component as well as the opened descriptor; never follow file links. */
export async function readSourceFile(source, name, maxBytes, { binary = false } = {}) {
  if (typeof name !== 'string' || !name || name.includes('\0') || isAbsolute(name)
      || name.split(/[\\/]/).some(p => p === '..' || !p)) throw new InvalidBody('来源文件必须是目录内的相对路径。');
  await verifyRoot(source);
  const file = resolve(source.path, name);
  if (!inside(source.path, file)) throw new InvalidBody('来源文件越出目录。');
  const parts = relative(source.path, file).split(sep);
  let current = source.path;
  for (const part of parts) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || (current === file && info.nlink > 1) || (current !== file && !info.isDirectory())) throw new Fault('INFORMATION_LINK_REFUSED', '收录跳过符号链接、硬链接及非普通目录。');
  }
  const before = await lstat(file);
  if (!before.isFile() || before.size > maxBytes) throw new Fault('INFORMATION_FILE_LIMIT', '文件不是普通文本文件或超过单文件上限。');
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (signature(opened) !== signature(before)) throw new Fault('INFORMATION_FILE_CHANGED', '文件正在更新，留待下次收录。');
    const buffer = Buffer.alloc(Math.min(maxBytes + 1, before.size + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > maxBytes || length !== before.size || signature(await handle.stat()) !== signature(before)
        || signature(await lstat(file)) !== signature(before) || resolve(await realpath(file)) !== file) throw new Fault('INFORMATION_FILE_CHANGED', '读取期间文件变化，未提交该版本。');
    await verifyRoot(source);
    if (binary) return { buffer: buffer.subarray(0, length), hash: digest(buffer.subarray(0, length)), bytes: length };
    const raw = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length)).replace(/^\uFEFF/, '');
    if (raw.includes('\0')) throw new InvalidBody('包含二进制内容，未按文本收录。');
    return { raw, hash: digest(raw), bytes: length };
  } finally { await handle.close(); }
}

export function decodeMaterial(raw, name) {
  const extension = extname(name).toLowerCase();
  let text = raw; let title = name.split(/[\\/]/).at(-1); let author = null; let url = null;
  if (extension === '.json') {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      if (typeof value.title === 'string') title = value.title.slice(0, 240);
      if (typeof value.author === 'string') author = value.author.slice(0, 240);
      if (typeof value.url === 'string' && /^https?:\/\//.test(value.url)) url = value.url.slice(0, 2000);
      // Preserve all fields: summaries and transcript coverage must not be silently conflated.
    }
    text = JSON.stringify(value, null, 2);
  } else if (extension === '.jsonl') {
    text = raw.split('\n').filter(l => l.trim()).map(l => JSON.stringify(JSON.parse(l))).join('\n');
  } else if (extension === '.html' || extension === '.htm') {
    title = raw.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.slice(0, 240) ?? title;
    text = raw.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
      .replace(/<[^>]*>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
  } else title = raw.match(/^#\s+(.+)$/m)?.[1]?.slice(0, 240) ?? title;
  if (!text.trim()) throw new InvalidBody('来源没有可读取的文字。');
  return { text, title, author, url, format: extension, coverage: '仅已导出的文字；不证明完整网页、视频或亲身经历' };
}

/** Resumable sorted depth-first walk. A bounded batch never treats unseen files as deleted. */
export async function walkBatch(source, scan, limit, documentLimit = limit) {
  await verifyRoot(source);
  const files = []; const errors = []; let visited = 0; let documents = 0;
  while (scan.queue.length && visited < limit && documents < documentLimit) {
    const frame = scan.queue.at(-1);
    const directory = join(source.path, frame.dir);
    try {
      const info = await lstat(directory);
      if (!info.isDirectory() || info.isSymbolicLink() || !inside(source.path, resolve(await realpath(directory)))) throw new Error('目录链接或路径变化');
      const entries = await readdir(directory, { withFileTypes: true });
      if (entries.length > 20000) throw new Error('单目录超过20000项，请拆分来源');
      const remaining = entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).filter(e => e.name > frame.after);
      if (!remaining.length) { scan.queue.pop(); continue; }
      for (const entry of remaining) {
        if (visited >= limit || documents >= documentLimit) break;
        visited++; frame.after = entry.name;
        if (entry.name.startsWith('.') || ['node_modules', '__pycache__'].includes(entry.name)) continue;
        const rel = frame.dir ? `${frame.dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          if (source.recursive) {
            if (rel.split('/').length > 24) { errors.push({ file: rel, error: '目录层数超过24' }); scan.incomplete = true; }
            else { scan.queue.push({ dir: rel, after: '' }); break; }
          }
        } else if (entry.isFile() && source.extensions.includes(extname(entry.name).toLowerCase())) {
          files.push(rel);
          if (DOCUMENT_EXTENSIONS.includes(extname(entry.name).toLowerCase())) documents++;
        }
      }
    } catch (error) {
      errors.push({ file: frame.dir, error: error.code ?? error.message }); scan.incomplete = true; scan.queue.pop();
    }
  }
  return { files, errors, visited, complete: scan.queue.length === 0 };
}
