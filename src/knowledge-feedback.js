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
  return feedbackFingerprintOfDigests({ 项目, 任务, 提交序, 知识id, 事件摘要: digest(canonical(事件)), 条目摘要: digest(canonical(条目)) });
}

/**
 * 同一份完整事件快照只折叠一次：全账显式seq计数、提交前代与调用方采纳观察共用该扫描。
 * 索引只留标识、原代和摘要，不保留声明原文；它不是授权，当前读权仍由调用服务复判。
 */
export function createKnowledgeFeedbackResolver({ rows, 项目, visit = null }) {
  if (!id(项目) || !Array.isArray(rows)) throw new InvalidBody('反馈见证需要项目及完整任务事件流。');
  if (visit !== null && typeof visit !== 'function') throw new InvalidBody('反馈索引观察器必须是内部同步函数。');
  const sequence = new Map();
  const submissions = new Map();
  const nodes = fold(rows, frame => {
    const { row, index, before } = frame;
    if (positive(row?.seq)) {
      const old = sequence.get(row.seq);
      sequence.set(row.seq, old ? { index: old.index, count: old.count + 1 } : { index, count: 1 });
    }
    if (row?.kind === 'submitted') {
      const fact = { 任务: row.id, seq: row.seq, 代: row.代, 提交人: row.by?.id, 前缀代: before?.代, items: new Map() };
      try {
        const adoption = validateStoredKnowledgeAdoption(row.采用知识);
        fact.事件摘要 = digest(canonical(row));
        for (const item of adoption.条目) fact.items.set(item.id, { 使用结果: item.使用结果, 条目摘要: digest(canonical(item)) });
      } catch (error) { fact.error = error; }
      submissions.set(index, fact);
    }
    if (visit) visit(frame);
  });
  const resolve = ({ 任务, 提交序, 知识id }) => {
    normalizeFeedbackReference({ 任务, 提交序 });
    if (!id(知识id)) throw new InvalidBody('反馈见证需要项目、知识id及完整任务事件流。');
    const slot = sequence.get(提交序);
    if (slot?.count !== 1) throw new Denied('知识反馈 · 提交序不唯一', '指定提交序不是全项目账本中唯一的显式事件，不能猜位置或选择其中一条。');
    const fact = submissions.get(slot.index);
    if (!fact || fact.任务 !== 任务 || !positive(fact.代) || !id(fact.提交人)) throw new Denied('知识反馈 · 不是明确本代交卷', '引用必须指向指定任务有明确代与交卷人的submitted事件，旧事件不补造代。');
    if (fact.前缀代 === undefined || fact.前缀代 !== fact.代) throw new Denied('知识反馈 · 交卷代不符', '交卷事件的代与其提交前任务前缀不一致，不能把后来代或当前位置当作证明。');
    if (fact.error) throw fact.error;
    const item = fact.items.get(知识id);
    if (!item || !['不适用', '发现问题'].includes(item.使用结果)) throw new Denied('知识反馈 · 缺少本知识负面声明', '该交卷没有唯一对应本知识的不适用或发现问题声明；有帮助、未知和显式空不能代替反馈。');
    return { 版本: 1, 指纹: feedbackFingerprintOfDigests({ 项目, 任务, 提交序, 知识id, 事件摘要: fact.事件摘要, 条目摘要: item.条目摘要 }) };
  };
  return Object.freeze({ nodes, resolve });
}

/** 兼容单笔公共入口；只从完整事件重新建索引，不接受调用方声明的前缀或核验结论。 */
export function resolveKnowledgeFeedback({ rows, 项目, 任务, 提交序, 知识id }) {
  normalizeFeedbackReference({ 任务, 提交序 });
  return createKnowledgeFeedbackResolver({ rows, 项目 }).resolve({ 任务, 提交序, 知识id });
}

function feedbackFingerprintOfDigests({ 项目, 任务, 提交序, 知识id, 事件摘要, 条目摘要 }) {
  return digest(canonical({ 版本: 1, 项目, 任务, 提交序, 知识id, 事件摘要, 条目摘要 }));
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
