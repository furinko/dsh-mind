/** 交卷知识采用声明的纯合同：声明不证明知识正确，也不产生读权或写权。 */
import { InvalidBody } from './kernel/errors.js';

export const KNOWLEDGE_ADOPTION_RESULTS = Object.freeze(['有帮助', '不适用', '发现问题', '未知']);
const INPUT_KEYS = Object.freeze(['id', '用途', '适用判断', '使用结果', '说明']);
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, allowed, required = allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
const identifier = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const text = (value, max) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const iso = (value) => typeof value === 'string' && value.length <= 64 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');

/** 省略保持未知；[]明确空；输入只验证并克隆，不裁短、去重、强转或伪造来源。 */
export function normalizeKnowledgeAdoption(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 16) throw new InvalidBody('采用知识必须为至多16项的数组；省略表示未知，null不能代替显式空数组。');
  const seen = new Set();
  for (const item of value) {
    if (!exact(item, INPUT_KEYS, ['id', '用途', '适用判断', '使用结果']) || !identifier(item.id) || !text(item.用途, 512) || !text(item.适用判断, 512) || !KNOWLEDGE_ADOPTION_RESULTS.includes(item.使用结果) || (Object.hasOwn(item, '说明') && (typeof item.说明 !== 'string' || item.说明.length > 1024))) throw new InvalidBody('知识采用条目只接受精确id、用途、适用判断、封闭使用结果与可选说明；来源、hash和身份不能由调用者声明。');
    if (seen.has(item.id)) throw new InvalidBody('一次交卷不能重复声明同一知识id；不会静默去重或改变使用结果。');
    seen.add(item.id);
  }
  return structuredClone(value);
}

/** 来源只有捕获时可核版本或未核验两类；不接收正文、路径、调用者认证或推断值。 */
export function validateKnowledgeEvidenceSource(value) {
  if (!object(value) || (value.状态 === '来源未核验' ? !exact(value, ['状态']) : value.状态 !== '可核来源版本' || !exact(value, ['状态', '内容哈希', '元数据哈希', '捕获于']) || !hash(value.内容哈希) || !hash(value.元数据哈希) || !iso(value.捕获于))) throw new InvalidBody('知识来源必须是未核验标记，或带真实内容/元数据SHA-256与ISO捕获时间的可核版本封套。');
  return structuredClone(value);
}

/** 新submitted事件的采用知识封套；缺field旧事件由调用者保留未知，不补写。 */
export function validateStoredKnowledgeAdoption(value) {
  if (!exact(value, ['版本', '声明状态', '条目']) || value.版本 !== 1 || !Array.isArray(value.条目) || value.条目.length > 16 || value.声明状态 !== (value.条目.length === 0 ? '显式空' : '已声明')) throw new InvalidBody('已存采用知识不是版本1的完整封套，声明状态须与显式空或已声明条目精确一致。');
  const inputs = value.条目.map((item) => {
    if (!exact(item, [...INPUT_KEYS, '来源'], ['id', '用途', '适用判断', '使用结果', '来源'])) throw new InvalidBody('已存知识条目缺来源或含未知字段。');
    validateKnowledgeEvidenceSource(item.来源);
    const { 来源: _source, ...input } = item;
    return input;
  });
  normalizeKnowledgeAdoption(inputs);
  return structuredClone(value);
}
