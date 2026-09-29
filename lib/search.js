// lib/search.js — 记忆检索的最小实现（bigram 词面相似度）。
//
// 设计取舍：**不引入向量/embedding**。判据——词面盲区尚未真咬人（多次回归实测召回 39/40），
// 而向量检索会显著加重依赖与成本。这是"够用就好"的选择，不是"最先进"的选择。
//
// 相似度 = bigram Jaccard。中文按**相邻二字**切，英文/数字按词切。
// 为什么 bigram：中文没有词边界，单字切会过度命中，整句切会因语序差异失配。

/** 归一化：小写 + 空白折叠。 */
function normalize(s) {
  return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * 切 bigram（中文相邻二字）+ 词（拉丁/数字）。
 * @param {string} text
 * @returns {Set<string>}
 */
export function tokenize(text) {
  const s = normalize(text);
  const out = new Set();
  // 拉丁词与数字
  for (const m of s.matchAll(/[a-z0-9]+/g)) out.add(m[0]);
  // CJK 相邻二字（跨标点不连）
  const cjkRuns = s.match(/[\u3400-\u9fff]+/g) || [];
  for (const run of cjkRuns) {
    if (run.length === 1) { out.add(run); continue; }
    for (let i = 0; i + 1 < run.length; i += 1) out.add(run.slice(i, i + 2));
  }
  return out;
}

/**
 * Jaccard 相似度（交集 / 并集）。
 * @returns {number} 0..1
 */
export function jaccard(a, b) {
  const A = a instanceof Set ? a : tokenize(a);
  const B = b instanceof Set ? b : tokenize(b);
  if (A.size === 0 || B.size === 0) return 0;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter += 1;
  return inter / (A.size + B.size - inter);
}

/**
 * 从文本里取 frontmatter 字段（`key: value`，去引号）。CRLF 兼容。
 * @returns {string}
 */
export function fmValue(content, key) {
  const c = String(content || '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---/.exec(c);
  if (!m) return '';
  const r = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*([^\\n]+)').exec(m[1]);
  return r ? r[1].trim().replace(/^['"]|['"]$/g, '') : '';
}

/**
 * 取 frontmatter 里的字符串数组（`key: [...]`）——**两种写法都认**（2026-09-29 修）。
 *
 * ① 流式：`key: [a, b]`
 * ② 块列表：`key:` 换行后若干行 `- x`（缩进不限）
 *
 * ⚠️ **只认流式会静默读出空数组**，实测代价：存量角色卡普遍用块列表写法
 * （`tools:` → `allow:` → `  - read`），读成空 ⇒ 成员工具面「未收窄」、
 * 卡里的 `deny: [write]` 约束**静默消失**；而自测当时用流式当正例 ⇒ 缺陷不被覆盖。
 * ⇒ 判据：**两种形态都认**，并把这条写进自测的夹具臂。
 */
export function fmArray(content, key) {
  const c = String(content || '').replace(/\r\n/g, '\n');
  const m = /^---\n([\s\S]*?)\n---/.exec(c);
  if (!m) return [];
  const fm = m[1];
  const clean = (s) => String(s).trim().replace(/^['"]|['"]$/g, '');
  // ① 流式 `key: [a, b]`
  const inline = new RegExp('(?:^|\\n)\\s*' + key + ':\\s*\\[([^\\]]*)\\]').exec(fm);
  if (inline) return inline[1].split(',').map(clean).filter(Boolean);
  // ② 块列表 `key:\n  - a\n  - b`
  const block = new RegExp('(?:^|\\n)[ \\t]*' + key + ':[ \\t]*\\n((?:[ \\t]*-[ \\t]*[^\\n]*\\n?)+)').exec(fm);
  if (block) {
    return block[1].split('\n')
      .map((l) => clean(l.replace(/^[ \t]*-[ \t]*/, '')))
      .filter(Boolean);
  }
  return [];
}

/**
 * 给一段正文打分：整体 + `## ` 分节 + 首段，取最高分。
 *
 * 为什么切块：整篇算相似度会被**分母稀释**（长文里出现一个专有词也拉不过阈值）。
 * 实测：没有 `##` 的整篇与短查询相似度被稀释到阈值之下 ⇒ "写得进、召不回"。
 * @returns {number}
 */
export function scoreContent(queryTokens, content) {
  const body = String(content || '');
  let best = jaccard(queryTokens, body);
  for (const seg of body.split(/\n(?=## )/)) {
    const s = jaccard(queryTokens, seg);
    if (s > best) best = s;
  }
  const firstPara = body.split(/\n\s*\n/).find((p) => p.trim()) || '';
  const s0 = jaccard(queryTokens, firstPara);
  return s0 > best ? s0 : best;
}

/**
 * 按相关度给一组文档排序。
 * @param {string} query
 * @param {Array<{rel:string, text:string, meta?:object}>} docs
 * @param {{minScore?:number, limit?:number}} [opts]
 * @returns {Array<{rel:string, score:number, meta:object}>}
 */
export function rank(query, docs, opts = {}) {
  const min = opts.minScore ?? 0.02;
  const qt = tokenize(query);
  return docs
    .map((d) => ({ rel: d.rel, score: scoreContent(qt, d.text), meta: d.meta || {} }))
    .filter((h) => h.score >= min)
    .sort((a, b) => b.score - a.score)
    .slice(0, opts.limit ?? 4);
}
