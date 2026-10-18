/**
 * 对象 id 与版本号（§14.4 命名规则）。
 *
 * 为什么 id 要可推导而不是随机：§14.4-1 要求「引用一律用 id，不用路径」——
 * 人可读的那一段（`<kind 前缀>-<slug>`）就是从「类 + 主体」推出来的，索引丢了照样读得懂。
 *
 * **但「能从目录名重建」是假的**（W3 批2 改实，2026-10-09）：完整 id 里还带一段
 * `shortHash(种子 + 时刻)`，时刻只存在于产生它的那次写入里 —— 目录名/文件名给不出它。
 * 所以：id 只能**读出来**（账本行与对象文件都带着它），不能**算出来**。
 * 真正的重建能力靠的是「事件行/条目行都写着自己的 id」，不是靠哈希可逆。
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
 * 短哈希取自「种子 + 时刻」，它保证的只有一件事：**同一种子在相邻毫秒之间不撞 id**。
 * 旧注释说它「保证同一秒内并发创建不撞 id」——那是假话：`at` 是毫秒，
 * 同毫秒 + 同种子 + 同类会算出**同一个 id**（W3 批1 已在记忆账本的锁内查重里堵过这个洞，
 * 见 `MemoryService#appendEntry`）。所以调用方若可能在同一毫秒重复写入，必须自带去重，
 * 不能指望这里。
 * 同时保持人可读（§14.4-1：稳定、短、kebab）。
 *
 * @param {string} kind 身份/规则/能力/知识/经历/偏好/作答/任务/消息/产物/账目
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
