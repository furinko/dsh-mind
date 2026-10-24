/** Bounded lexical expansion and ranking, shared by all automatic role recall. No new permissions or model calls. */
import { buildIndex, search } from './retrieval.js';

const ALIASES = [
  ['reconnect', '重连', '断线', '掉线'], ['retry', '重试'], ['backoff', '退避'], ['jitter', '抖动'],
  ['timeout', '超时'], ['cache', '缓存'], ['concurrency', '并发'], ['idempotent', '幂等'],
  ['rollback', '回滚', '回退'], ['pagination', '分页'], ['encoding', '编码'], ['decode', '解码'],
  ['permission', '权限'], ['review', '复核', '审查'], ['subtitle', '字幕'], ['transcript', '转录'],
];
export function expandRecallQuery(value) {
  const original = String(value ?? '').normalize('NFKC').trim().slice(0, 1200);
  const lower = original.toLowerCase(); const added = [];
  for (const group of ALIASES) if (group.some(word => /[a-z]/.test(word)
    ? new RegExp(`(^|[^a-z])${word}([^a-z]|$)`, 'i').test(lower) : lower.includes(word))) added.push(...group);
  return [original, ...new Set(added)].join(' ').slice(0, 1800);
}
export function rankCapabilities(rows, query, limit = 2) {
  if (!query.trim()) return [];
  const indexed = rows.map(row => ({ id: `${row.来源}:${row.id}`, 正文: `${row.名}\n${row.摘要}`, 标签: row.适用岗位 }));
  const hits = search(buildIndex(indexed), expandRecallQuery(query), { limit });
  return hits.命中.map(hit => rows.find(row => `${row.来源}:${row.id}` === hit.id));
}
export function memoryRecallText(entry) {
  return [entry.内容, entry.标题, ...Object.values(entry.知识说明 ?? {}).flat().filter(v => typeof v === 'string')].filter(Boolean).join('\n');
}
export function recallSnippet(entry, max = 600) {
  const body = String(entry.内容 ?? entry.正文 ?? '');
  const complete = entry.正文截断 !== true && body.length <= max;
  const context = {}; let contextClipped = false;
  for (const [key, value] of Object.entries(entry.知识说明 ?? {})) {
    if (Array.isArray(value)) {
      context[key] = value.slice(0, 4).map(v => String(v).slice(0, 160));
      contextClipped ||= value.length > 4 || value.some(v => String(v).length > 160);
    } else if (typeof value === 'string') { context[key] = value.slice(0, 100); contextClipped ||= value.length > 100; }
  }
  return { 内容片段: body.slice(0, max), 片段完整: complete, ...(Object.keys(context).length ? { 知识说明: context } : {}),
    适用信息截断: contextClipped, 需继续读取: !complete || contextClipped || entry.元数据截断 === true,
    声明: '来源可核与片段提供不认证正确、适用或实际采用；缺条件保持未知' };
}
