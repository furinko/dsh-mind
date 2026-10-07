/**
 * 文本处理：指纹链、检索分词、条款切分。
 *
 * 为什么三件事放一个文件：它们都只依赖「一段正文 → 结构化表示」这一个输入，
 * 且被审计链、检索层、升级层共用。拆开只会产生三份各写一遍的换行/空白规则。
 */
import { createHash } from 'node:crypto';

/** @param {string} value */
export function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/**
 * 审计链的一节：把前一节的哈希裹进本节，篡改任何一节都会让后续全部对不上。
 *
 * @param {string|null} prevHash
 * @param {object} entry
 * @returns {string}
 */
export function chainHash(prevHash, entry) {
  return digest(`${prevHash ?? 'GENESIS'}\u0000${canonical(entry)}`);
}

/**
 * 稳定序列化：键按字典序，用于「同一份内容在两次运行里算出同一个哈希」。
 * @param {unknown} value
 * @returns {string}
 */
export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

/**
 * 检索归一化：折叠大小写与全半角，但**不动词序**（词序是 BM25 不需要的，
 * 而 §11 提到「治分母膨胀」靠的是长度归一化，不是改写正文）。
 * @param {string} text
 * @returns {string}
 */
export function normalizeForSearch(text) {
  return String(text)
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\u200b-\u200f\ufeff]/g, '');
}

/**
 * 检索分词：拉丁词按词，CJK 按「单字 + 相邻双字」。
 *
 * 为什么 CJK 要同时出单字和双字：单字召回高但区分度低，双字区分度高但会漏掉
 * 「数据库/数据」这类部分匹配。两者一起进 BM25，靠 IDF 自动压低高频单字的权重。
 *
 * @param {string} text
 * @returns {string[]}
 */
export function tokenize(text) {
  const s = normalizeForSearch(text);
  const tokens = [];
  const latin = /[a-z0-9]+(?:[._+-][a-z0-9]+)*/g;
  let m;
  while ((m = latin.exec(s)) !== null) tokens.push(m[0]);

  const cjkRuns = s.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+/gu) ?? [];
  for (const run of cjkRuns) {
    const chars = [...run];
    for (let i = 0; i < chars.length; i++) {
      tokens.push(chars[i]);
      if (i + 1 < chars.length) tokens.push(chars[i] + chars[i + 1]);
    }
  }
  return tokens;
}

/**
 * 把 markdown 切成条款。
 *
 * 为什么条款是升级合并的最小单位：§5「两边改了同一条 ⇒ 挂起」。
 * 「同一条」若不精确到条款，就只能整文件比对，于是任何一处改动都会
 * 把整个文件判成冲突——那会让挂起队列永远不清空。
 *
 * 条款键 = 标题路径（`## 权限矩阵/### 表`），front matter 单独成一节。
 *
 * @param {string} markdown
 * @returns {Array<{ key: string, heading: string, level: number, body: string, hash: string, start: number, end: number }>}
 */
export function splitClauses(markdown) {
  const lines = String(markdown).split('\n');
  const clauses = [];
  let fmStart = -1;
  let fmEnd = -1;
  if (lines[0]?.trim() === '---') {
    fmStart = 0;
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        fmEnd = i;
        break;
      }
    }
  }
  if (fmStart === 0 && fmEnd > 0) {
    const body = lines.slice(0, fmEnd + 1).join('\n');
    clauses.push({ key: '@frontmatter', heading: '@frontmatter', level: 0, body, hash: digest(body), start: 0, end: fmEnd + 1 });
  }

  /** @type {Array<{ level: number, heading: string, startLine: number }>} */
  const stack = [];
  const headingRe = /^(#{1,6})\s+(.*)$/;

  // 关闭栈顶条款：标题路径取「仍在栈里的祖先 + 自己」，与后续同名标题互不覆盖。
  const closeTop = (endLine) => {
    const top = stack.pop();
    if (!top) return;
    const body = lines.slice(top.startLine, endLine).join('\n');
    const path = [...stack, top].map((s) => s.heading).join('/');
    clauses.push({ key: path, heading: top.heading, level: top.level, body, hash: digest(body), start: top.startLine, end: endLine });
  };

  for (let i = (fmEnd > 0 ? fmEnd + 1 : 0); i < lines.length; i++) {
    const m = headingRe.exec(lines[i]);
    if (!m) continue;
    const level = m[1].length;
    while (stack.length && stack[stack.length - 1].level >= level) closeTop(i);
    stack.push({ level, heading: m[2].trim(), startLine: i });
  }
  while (stack.length) closeTop(lines.length);

  return clauses;
}

/**
 * 一行摘要：给拒绝理由、工作台、检索命中用的短预览。
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
export function summarize(text, max = 120) {
  const flat = String(text).replace(/\s+/g, ' ').trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}
