/** 本地人侧维护的公共人格骨架；只读，不从对话或成长记忆反向生成。 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { digest } from './kernel/text.js';

export const PERSONA_CORE_LIMITS = Object.freeze({ bytes: 12000, characters: 3000 });
const invalid = () => new Fault('PERSONA_CORE_INVALID', '核心人设文件不可用；保留原文件，本轮不沿用旧人设。');
const changed = () => new Fault('PERSONA_CORE_CHANGED', '核心人设在读取中变化，本轮不沿用旧人设。');
const same = (a, b) => ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'mode', 'nlink'].every(key => a[key] === b[key]);

function noLinks(file) {
  for (let path = file; ; path = dirname(path)) {
    const info = lstatSync(path, { bigint: true });
    if (info.isSymbolicLink() || (info.isFile() && info.nlink !== 1n)) throw invalid();
    if (dirname(path) === path) return;
  }
}

/** 至多12KiB的同步复核使最终装配检查后不再让出事件循环。 */
function readCore(file) {
  let named;
  try { named = lstatSync(file, { bigint: true }); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!named.isFile() || named.isSymbolicLink() || named.nlink !== 1n || named.size > BigInt(PERSONA_CORE_LIMITS.bytes)) throw invalid();
  noLinks(file);
  const handle = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(handle, { bigint: true });
    if (!same(named, before) || !before.isFile()) throw changed();
    const buffer = Buffer.alloc(PERSONA_CORE_LIMITS.bytes + 1);
    let size = 0;
    while (size < buffer.length) {
      const bytesRead = readSync(handle, buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    if (size > PERSONA_CORE_LIMITS.bytes) throw invalid();
    const after = fstatSync(handle, { bigint: true });
    if (size !== Number(before.size) || !same(before, after) || !same(after, lstatSync(file, { bigint: true }))) throw changed();
    noLinks(file);
    const bytes = buffer.subarray(0, size);
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(text) || [...text].length > PERSONA_CORE_LIMITS.characters) throw invalid();
    return text.trim() ? Object.freeze({ text, digest: digest(bytes), bytes: size }) : null;
  } finally { closeSync(handle); }
}

export class PersonaCoreService {
  #frames = new WeakMap();
  constructor({ layout, policy, clock }) { Object.assign(this, { layout, policy, clock }); }
  file() { return this.layout.personaCoreFile(); }

  /** 仅核对此service已授权读出的不可改帧；不返回正文，也不产生写入口。 */
  isCurrent(frame) {
    const file = frame && this.#frames.get(frame);
    if (!file) return false;
    try {
      if (resolve(this.file()) !== file) return false;
      return readCore(file)?.digest === frame.digest;
    } catch { return false; }
  }

  async read({ subject, project }) {
    if (subject?.kind !== 'Lead' || typeof subject.id !== 'string' || !subject.id.trim()) {
      throw new Denied('核心人设 · 根会话', '只有根Lead会话读取公共人格骨架；不向成员提供全文。');
    }
    if (typeof project !== 'string' || !project.trim() || project.length > 256) throw new InvalidBody('核心人设读取需要当前项目键。');
    const authorize = () => this.policy.check({ subject, action: 'read', target: {
      id: '核心人设', kind: '身份', authority: '自治', zone: '私有', domain: '个体', project,
    } });
    await authorize();
    let frame; let file;
    try {
      file = resolve(this.file());
      const inside = relative(resolve(this.layout.privateRoot), file);
      if (!inside || inside === '..' || inside.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(inside)) throw invalid();
      frame = readCore(file);
    } catch (error) {
      if (['PERSONA_CORE_INVALID', 'PERSONA_CORE_CHANGED'].includes(error.code)) throw error;
      throw invalid();
    }
    await authorize();
    if (frame) this.#frames.set(frame, file);
    return frame;
  }
}
