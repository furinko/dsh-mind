/** 知识适用与复验声明的纯合同；期限只改变召回提示，不判错、不追加状态。 */
import { InvalidBody } from './kernel/errors.js';

export const KNOWLEDGE_CONTEXT_LIST_FIELDS = Object.freeze(['适用条件', '已知反例', '复验条件']);
const FIELDS = Object.freeze([...KNOWLEDGE_CONTEXT_LIST_FIELDS, '复验期限']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const canonicalUtc = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');

/** 未提供保持未知；显式说明至少一项，不裁短、强转或补空元数据。 */
export function normalizeKnowledgeContext(value) {
  if (value === undefined) return undefined;
  if (!object(value) || Object.keys(value).length === 0 || Object.keys(value).some((key) => !FIELDS.includes(key))) throw new InvalidBody('知识说明必须至少包含一项适用条件、已知反例、复验条件或复验期限；不接受自报验证字段。');
  for (const key of KNOWLEDGE_CONTEXT_LIST_FIELDS) {
    if (!Object.hasOwn(value, key)) continue;
    const list = value[key];
    if (!Array.isArray(list) || list.length < 1 || list.length > 16 || [...list].some((text) => typeof text !== 'string' || !text.trim() || text.length > 512)) throw new InvalidBody(`知识说明.${key}必须为1至16项文本数组，每项1至512字符；不接受null或空数组。`);
  }
  if (Object.hasOwn(value, '复验期限') && !canonicalUtc(value.复验期限)) throw new InvalidBody('知识说明.复验期限必须是规范UTC ISO秒或毫秒时间（带Z），不能省略时区或使用无效日期。');
  return structuredClone(value);
}

/** 对旧知识不补期限；坏已存元数据或不可判时钟不能冒充“未设期限”。 */
export function knowledgeReviewStatus(entry, now) {
  if (entry?.类 !== '知识') return null;
  if (!Object.hasOwn(entry, '知识说明')) return '未设期限';
  let context;
  try { context = normalizeKnowledgeContext(entry.知识说明); } catch { return '说明不可判'; }
  if (context === undefined) return '说明不可判';
  if (!Object.hasOwn(context, '复验期限')) return '未设期限';
  const instant = now instanceof Date ? now.getTime() : typeof now === 'number' ? now : typeof now === 'string' ? Date.parse(now) : NaN;
  if (!Number.isFinite(instant)) return '说明不可判';
  return instant >= Date.parse(context.复验期限) ? '待复验' : '期限内';
}

export function knowledgeReviewWarning(status) {
  if (status === '待复验') return '已到作者声明的复验期限；需复验，不代表知识已失效。';
  if (status === '说明不可判') return '知识说明不可判，默认不推荐；未将坏说明当作无期限或已验证。';
  if (status === '未设期限') return '未设复验期限不等于永远有效；适用性仍需本次判断。';
  if (status === '期限内') return '尚未到作者声明期限，不代表机器已经验证知识正确或适用。';
  return null;
}

/** 只投影安全元数据；坏说明显式查看时也不原样输出不受约束对象。 */
export function knowledgeReviewProjection(entry, now) {
  const status = knowledgeReviewStatus(entry, now);
  if (status === null) return entry;
  const { 知识说明: raw, ...rest } = entry;
  return { ...rest, ...(Object.hasOwn(entry, '知识说明') && status !== '说明不可判' ? { 知识说明: structuredClone(raw) } : {}), 复验状态: status, 复验警示: knowledgeReviewWarning(status) };
}
