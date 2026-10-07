/**
 * 检索层（§11）。
 *
 * 三个被设计点名的约束，本文件是它们唯一的实现处：
 *  1. **默认词面检索：BM25 + 长度归一化** —— 治的是「分母膨胀」，不是「排序好看」。
 *  2. **排序各维必须同量纲或显式归一化** —— 所以打分只有 BM25 一个量纲，
 *     标签命中与新鲜度都是**布尔过滤**或**显式归一化后的乘子**，不与分数直接相加。
 *  3. **报「0 命中」必须连口径一起报** —— 所以 `search()` 无论如何都返回 `口径`。
 */
import { normalizeForSearch, summarize, tokenize } from './kernel/text.js';

const K1 = 1.2;
const B = 0.75;

/**
 * 建索引。语料是小规模本地文本，用倒排表足矣；上向量化要同时满足§11 的两个条件。
 *
 * @param {Array<{ id: string, 正文: string, 标签?: string[], 来源?: string, 时间?: string }>} docs
 * @returns {{ docs: object[], df: Map<string, number>, postings: Map<string, Map<number, number>>, avgdl: number, field: string }}
 */
export function buildIndex(docs) {
  const list = docs.map((doc) => ({ ...doc, 正文: String(doc.正文 ?? '') }));
  /** @type {Map<string, number>} */
  const df = new Map();
  /** @type {Map<string, Map<number, number>>} */
  const postings = new Map();
  let total = 0;

  list.forEach((doc, index) => {
    const tokens = tokenize(`${doc.正文} ${(doc.标签 ?? []).join(' ')}`);
    total += tokens.length;
    /** @type {Map<string, number>} */
    const tf = new Map();
    for (const token of tokens) tf.set(token, (tf.get(token) ?? 0) + 1);
    for (const [token, count] of tf) {
      if (!postings.has(token)) postings.set(token, new Map());
      postings.get(token).set(index, count);
      df.set(token, (df.get(token) ?? 0) + 1);
    }
  });

  return { docs: list, df, postings, avgdl: list.length ? total / list.length : 0, field: '正文' };
}

/**
 * 检索。
 *
 * 打分只有 BM25 一个量纲：IDF 用带平滑的对数式，TF 用饱和式并**除以文档长度与平均长度之比**
 * （`B` 项）。长度归一化是显式写在公式里的，不是靠截断近似。
 *
 * @param {ReturnType<typeof buildIndex>} index
 * @param {string} query
 * @param {{ limit?: number, 范围?: string, 过滤?: (doc: object) => boolean }} [options]
 * @returns {{ 命中: Array<{id: string, 分数: number, 摘要: string, 标签?: string[], 来源?: string}>, 口径: {搜索面: string, 查询词: string, 范围: string, 文档数: number, 命中数: number} }}
 */
export function search(index, query, options = {}) {
  const limit = options.limit ?? 10;
  const scope = options.范围 ?? '默认检索面';
  const candidateIndexes = [];
  index.docs.forEach((doc, i) => {
    if (options.过滤 && !options.过滤(doc)) return;
    candidateIndexes.push(i);
  });

  const terms = tokenize(query);
  const scoreById = new Map();
  /** 每条候选文档命中的「证据」：CJK 双字与拉丁词分开记。 */
  const evidenceById = new Map();
  const N = index.docs.length || 1;

  for (const term of terms) {
    const posting = index.postings.get(term);
    if (!posting) continue;
    const df = index.df.get(term) ?? 0;
    // 平滑 IDF：df 接近 N 时趋近 0，高频虚词自动失去权重。
    const idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
    for (const i of candidateIndexes) {
      const tf = posting.get(i);
      if (!tf) continue;
      const doc = index.docs[i];
      const dl = Math.max(1, tokenize(doc.正文).length);
      const norm = 1 - B + B * (index.avgdl > 0 ? dl / index.avgdl : 1);
      const score = idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
      scoreById.set(doc.id, (scoreById.get(doc.id) ?? 0) + score);
      const evidence = evidenceById.get(doc.id) ?? { bigram: 0, latin: 0, unigram: 0 };
      if (isLatinTerm(term)) evidence.latin += 1;
      else if ([...term].length >= 2) evidence.bigram += 1;
      else evidence.unigram += 1;
      evidenceById.set(doc.id, evidence);
    }
  }

  // 证据门槛：CJK 单字会让几乎任何查询都"命中"点什么，于是 0 命中永远不出现，
  // 使用者再也分不清「没有这条知识」和「搜到了一堆无关的字」。
  // 因此含双字词或拉丁词的查询，必须至少命中一个同级的词才算数。
  const queryHasBigram = terms.some((t) => !isLatinTerm(t) && [...t].length >= 2);
  const queryHasLatin = terms.some(isLatinTerm);

  const 命中 = [...scoreById.entries()]
    .filter(([id]) => {
      if (!queryHasBigram && !queryHasLatin) return true;
      const evidence = evidenceById.get(id) ?? { bigram: 0, latin: 0 };
      return (queryHasBigram && evidence.bigram > 0) || (queryHasLatin && evidence.latin > 0);
    })
    .map(([id, 分数]) => {
      const doc = index.docs.find((d) => d.id === id);
      return { doc, id, 分数 };
    })
    // 分数降序；同分按 id 升序 —— 相同输入必须给出相同排序（检索回归集的前提）。
    .sort((a, b) => b.分数 - a.分数 || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(({ doc, id, 分数 }) => ({
      id,
      分数: Number(分数.toFixed(6)),
      摘要: summarize(doc.正文, 160),
      ...(doc.标签 ? { 标签: doc.标签 } : {}),
      ...(doc.来源 ? { 来源: doc.来源 } : {}),
    }));

  return {
    命中,
    口径: {
      搜索面: index.field,
      查询词: normalizeForSearch(query).trim(),
      范围: scope,
      文档数: candidateIndexes.length,
      命中数: 命中.length,
    },
  };
}

/**
 * 拉丁词与数字组成的词。区分它是为了给证据门槛分档：
 * CJK 单字命中不算证据，拉丁词命中算。
 * @param {string} term
 * @returns {boolean}
 */
function isLatinTerm(term) {
  return /^[a-z0-9]/.test(term);
}

/**
 * 「0 命中」的可读报告。§11 要求它必须连口径一起给，
 * 否则调用方无法区分「没有这条知识」和「我搜错了地方」。
 * @param {{搜索面: string, 查询词: string, 范围: string, 文档数: number, 命中数: number}} 口径
 * @returns {string}
 */
export function formatMiss(口径) {
  return `0 命中。搜索面=${口径.搜索面}；查询词=「${口径.查询词}」；范围=${口径.范围}；候选文档数=${口径.文档数}。改口径必须跑回归集。`;
}

/**
 * 检索回归集：改任何检索口径必跑（§11）。
 *
 * @param {{ 回归集: Array<{ 查询: string, 期望: string }>, 基线?: Array<{ 查询: string, 实际: string }>, 执行: (query: string) => string }} spec
 * @returns {Promise<{ 通过: boolean, 用例: Array<{查询: string, 期望: string, 实际: string, 通过: boolean, 与基线一致: boolean|null}>, 差异: string[] }>}
 */
export async function runRegression(spec) {
  const baseline = new Map((spec.基线 ?? []).map((row) => [row.查询, row.实际]));
  const 用例 = [];
  const 差异 = [];
  for (const item of spec.回归集) {
    const 实际 = spec.执行(item.查询);
    const 一致 = baseline.has(item.查询) ? baseline.get(item.查询) === 实际 : null;
    const 通过 = 实际 === item.期望;
    用例.push({ 查询: item.查询, 期望: item.期望, 实际, 通过, 与基线一致: 一致 });
    if (!通过) 差异.push(`「${item.查询}」期望 ${item.期望}，实际 ${实际}`);
    else if (一致 === false) 差异.push(`「${item.查询}」结果变了（基线 ${baseline.get(item.查询)} → ${实际}）：口径变更必须显式确认`);
  }
  return { 通过: 用例.every((c) => c.通过) && 差异.length === 0, 用例, 差异 };
}
