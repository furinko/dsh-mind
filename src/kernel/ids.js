/**
 * 对象 id 与版本号（§14.4 命名规则）。
 *
 * 为什么 id 必须可推导而不是随机：§14.4-1 要求「引用一律用 id，不用路径」，
 * 而 §12.4 要求重启后判定可重建。id 由「kind + 主体 + 序号」推导，
 * 索引丢了也能从目录名重建，随机 id 做不到这一点。
 */
import { createHash } from 'node:crypto';

/**
 * 把任意文本折成稳定的 kebab-case 片段。
 * @param {string} text
 * @param {{ maxLength?: number }} [options]
 * @returns {string}
 */
export function slug(text, options = {}) {
  const maxLength = options.maxLength ?? 48;
  const folded = String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s_/\\]+/g, '-')
    .replace(/[^\p{Letter}\p{Number}-]+/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (!folded) return 'x';
  return folded.length > maxLength ? `${folded.slice(0, maxLength).replace(/-$/, '')}` : folded;
}

/**
 * 短哈希：内容寻址用（探针快照、正文指纹、审计链）。
 * @param {string|Buffer} value
 * @param {number} [length]
 * @returns {string}
 */
export function shortHash(value, length = 12) {
  return createHash('sha256').update(value).digest('hex').slice(0, length);
}

/**
 * 生成一个对象 id：`<kind 前缀>-<slug>-<短哈希>`。
 *
 * 短哈希取自「种子 + 时间」，保证同一秒内的并发创建不会撞 id，
 * 同时保持人可读（§14.4-1：稳定、短、kebab）。
 *
 * @param {string} kind 身份/规则/能力/知识/任务/消息/产物/账目
 * @param {string} seed 人可读的区分文本（通常是标题或被作用对象 id）
 * @param {{ prefix?: string, at?: number }} [options]
 * @returns {string}
 */
export function objectId(kind, seed, options = {}) {
  const prefix = options.prefix ?? kindPrefix(kind);
  const at = options.at ?? Date.now();
  const body = slug(seed, { maxLength: 40 });
  return `${prefix}-${body}-${shortHash(`${kind}:${seed}:${at}`, 6)}`;
}

/**
 * @param {string} kind
 * @returns {string} kind 的短前缀（对象 id 的前半段）
 */
export function kindPrefix(kind) {
  return (
    {
      身份: 'ident',
      规则: 'rule',
      能力: 'cap',
      知识: 'know',
      经历: 'exp',
      偏好: 'pref',
      作答: 'answ',
      任务: 'task',
      消息: 'msg',
      产物: 'artifact',
      账目: 'ledger',
      版本: 'ver',
    }[kind] ?? 'obj'
  );
}

/**
 * @param {string} name
 * @returns {number|null} 版本文件名解析出的序号
 */
export function parseVersionName(name) {
  const m = /^v(\d+)$/.exec(String(name).replace(/\.md$/, ''));
  return m ? Number(m[1]) : null;
}
