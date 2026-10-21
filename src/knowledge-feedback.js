/** 负面采用声明与知识处置的只读见证合同；指纹不是授权、状态或语义结论。 */
import { InvalidBody, Denied } from './kernel/errors.js';
import { canonical, digest } from './kernel/text.js';
import { fold } from './tasks.js';
import { validateStoredKnowledgeAdoption } from './knowledge-reuse-contract.js';

const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const exact = (value, allowed, required = allowed) => object(value) && Object.keys(value).every((key) => allowed.includes(key)) && required.every((key) => Object.hasOwn(value, key));
const id = (value) => typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value;
const positive = (value) => Number.isSafeInteger(value) && value > 0;
const hash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const iso = (value) => typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');

export function normalizeFeedbackReference(value) {
  if (value === undefined) return undefined;
  if (!exact(value, ['任务', '提交序']) || !id(value.任务) || !positive(value.提交序)) throw new InvalidBody('反馈引用只接受精确任务id和显式正安全整数提交序，不接受证明、hash、主体或状态。');
  return structuredClone(value);
}

export function knowledgeFeedbackFingerprint({ 项目, 任务, 提交序, 知识id, 事件, 条目 }) {
  if (!id(项目) || !id(任务) || !positive(提交序) || !id(知识id) || !object(事件) || !object(条目)) throw new InvalidBody('知识反馈指纹缺少精确引用或原始事件、采用条目。');
  return digest(canonical({ 版本: 1, 项目, 任务, 提交序, 知识id, 事件摘要: digest(canonical(事件)), 条目摘要: digest(canonical(条目)) }));
}

/** 全账本唯一显式seq；代按提交前前缀验证，返工后的当前代不能洗掉旧反馈。 */
export function resolveKnowledgeFeedback({ rows, 项目, 任务, 提交序, 知识id }) {
  normalizeFeedbackReference({ 任务, 提交序 });
  if (!id(项目) || !id(知识id) || !Array.isArray(rows)) throw new InvalidBody('反馈见证需要项目、知识id及完整任务事件流。');
  const matches = rows.map((row, index) => ({ row, index })).filter(({ row }) => row?.seq === 提交序);
  if (matches.length !== 1) throw new Denied('知识反馈 · 提交序不唯一', '指定提交序不是全项目账本中唯一的显式事件，不能猜位置或选择其中一条。');
  const { row, index } = matches[0];
  if (row.kind !== 'submitted' || row.id !== 任务 || !positive(row.代) || !id(row.by?.id)) throw new Denied('知识反馈 · 不是明确本代交卷', '引用必须指向指定任务有明确代与交卷人的submitted事件，旧事件不补造代。');
  const before = fold(rows.slice(0, index)).get(任务);
  if (!before || before.代 !== row.代) throw new Denied('知识反馈 · 交卷代不符', '交卷事件的代与其提交前任务前缀不一致，不能把后来代或当前位置当作证明。');
  const adoption = validateStoredKnowledgeAdoption(row.采用知识);
  const entries = adoption.条目.filter((entry) => entry.id === 知识id);
  if (entries.length !== 1 || !['不适用', '发现问题'].includes(entries[0].使用结果)) throw new Denied('知识反馈 · 缺少本知识负面声明', '该交卷没有唯一对应本知识的不适用或发现问题声明；有帮助、未知和显式空不能代替反馈。');
  return { 版本: 1, 指纹: knowledgeFeedbackFingerprint({ 项目, 任务, 提交序, 知识id, 事件: row, 条目: entries[0] }) };
}

/** 内部观察回执仍须闭名单，缺失或不可见同形，不能把私有见证顺手spread到读面。 */
export function validateFeedbackDispositionObservation(value) {
  if (!exact(value, ['状态', '记录', '总数', '截断']) || !['可核对', '不可核对'].includes(value.状态) || !Array.isArray(value.记录) || value.记录.length > 5) throw new InvalidBody('反馈处置观察不是有界的精确回执。');
  if (value.状态 === '不可核对') {
    if (value.记录.length !== 0 || value.总数 !== null || value.截断 !== null) throw new InvalidBody('不可核对必须匿名空记录、总数null、截断null，不能冒充未处理。');
  } else {
    if (!Number.isSafeInteger(value.总数) || value.总数 < value.记录.length || value.截断 !== (value.总数 > value.记录.length)) throw new InvalidBody('反馈处置总数与截断必须与实际记录一致。');
    for (const receipt of value.记录) if (!exact(receipt, ['动作', '记录摘要', '处置于', '主体', '替代知识'], ['动作', '记录摘要', '处置于', '主体']) || !['失效', '降权', '替代'].includes(receipt.动作) || !hash(receipt.记录摘要) || !iso(receipt.处置于) || !id(receipt.主体) || (Object.hasOwn(receipt, '替代知识') && (receipt.动作 !== '替代' || !id(receipt.替代知识)))) throw new InvalidBody('反馈处置记录只能给动作、摘要、时间、主体及独立可读的替代id，不含原因或私有指纹。');
  }
  return structuredClone(value);
}
