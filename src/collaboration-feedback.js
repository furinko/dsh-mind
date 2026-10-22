/** 有来源的协作复盘与后续案例声明；引用存在不认证采用、效果或因果。 */
import { InvalidBody, Fault } from './kernel/errors.js';

export const COLLABORATION_OUTCOMES = Object.freeze(['改善', '无改善', '变差', '未知']);
export const COLLABORATION_SOURCES = Object.freeze(['用户转述', '模型观察', '未知']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value, name, max) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InvalidBody(`协作反馈.${name}必须为1至${max}字符。`);
  return value.trim();
};
const fields = (value, allowed, name) => {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new InvalidBody(`协作反馈.${name}含非法结构或未知字段；不接受认证、分数或权限自报。`);
};
function reference(value) {
  fields(value, ['项目', '目标', '修订'], '目标引用');
  if (!Number.isSafeInteger(value.修订) || value.修订 < 1) throw new InvalidBody('协作反馈目标引用的修订必须为正整数。');
  return { 项目: text(value.项目, '引用项目', 256), 目标: text(value.目标, '引用目标', 256), 修订: value.修订 };
}

export function normalizeCollaborationFeedback(value) {
  if (value === undefined) return undefined;
  fields(value, ['基线', '反馈', '来源', '原做法', '调整做法', '适用条件', '后续案例'], '声明');
  if (!COLLABORATION_SOURCES.includes(value.来源)) throw new InvalidBody('协作反馈.来源只接受用户转述、模型观察或未知；不是用户认证。');
  if (!Array.isArray(value.适用条件) || !value.适用条件.length || value.适用条件.length > 6) throw new InvalidBody('协作反馈.适用条件必须为1至6项文本。');
  if (value.后续案例 !== undefined && (!Array.isArray(value.后续案例) || value.后续案例.length > 6)) throw new InvalidBody('协作反馈.后续案例必须为最多6项的数组。');
  const seen = new Set();
  const cases = (value.后续案例 ?? []).map(item => {
    fields(item, ['情境', '采用说明', '观察', '结果声明', '来源', '依据'], '后续案例');
    const 情境 = reference(item.情境);
    if (!COLLABORATION_OUTCOMES.includes(item.结果声明) || !COLLABORATION_SOURCES.includes(item.来源)) throw new InvalidBody('协作反馈后续案例的结果声明或来源无效；未观察保持未知。');
    const key = JSON.stringify(情境);
    if (seen.has(key)) throw new InvalidBody('协作反馈后续案例不能重复同一项目、目标和修订以放大记录数。');
    seen.add(key);
    return { 情境, 采用说明: text(item.采用说明, '采用说明', 500), 观察: text(item.观察, '观察', 1000),
      结果声明: item.结果声明, 来源: item.来源, 依据: text(item.依据, '依据', 500) };
  });
  const baseline = reference(value.基线);
  if (cases.some(item => item.情境.项目 === baseline.项目 && item.情境.目标 === baseline.目标 && item.情境.修订 <= baseline.修订)) throw new InvalidBody('同目标后续案例必须晚于基线修订；不能将原案例当作后续验证。');
  return { 基线: baseline, 反馈: text(value.反馈, '反馈', 1000), 来源: value.来源, 原做法: text(value.原做法, '原做法', 1000),
    调整做法: text(value.调整做法, '调整做法', 1000), 适用条件: value.适用条件.map(item => text(item, '适用条件', 240)), 后续案例: cases };
}

/** 原目标账本保证修订连续；<=当前修订才有真实历史版本，不限制已完成目标的反馈。 */
export async function checkCollaborationReferences(goals, subject, value) {
  if (!value) return;
  if (typeof goals?.get !== 'function') throw new Fault('COLLABORATION_GOAL_SOURCE_UNAVAILABLE', '缺少协作反馈的目标真源，不能记录未核对引用。');
  const checked = new Set();
  for (const ref of [value.基线, ...value.后续案例.map(item => item.情境)]) {
    const key = JSON.stringify(ref);
    if (checked.has(key)) continue;
    checked.add(key);
    const goal = await goals.get(ref.目标, { subject, 项目: ref.项目 });
    if (!goal || ref.修订 > goal.修订) throw new InvalidBody('协作反馈引用的目标或历史修订不存在；不接受未来修订或其他项目的同名引用。');
  }
}

/** 摘要只保留调整做法、适用条件和最近声明；全文仍由原记忆详情读回。 */
export function collaborationFeedbackSummary(value) {
  let meta;
  try { meta = normalizeCollaborationFeedback(value); } catch { return { 状态: '说明不可判' }; }
  if (!meta) return undefined;
  const excerpt = (value, limit) => ({ 文本: value.slice(0, limit), 省略: value.length > limit });
  const last = meta.后续案例.at(-1);
  return { 基线: meta.基线, 来源: meta.来源, 反馈: excerpt(meta.反馈, 100), 原做法: excerpt(meta.原做法, 100), 调整做法: excerpt(meta.调整做法, 160),
    适用条件: meta.适用条件.slice(0, 3).map(value => excerpt(value, 100)), 适用条件省略: meta.适用条件.length > 3,
    后续案例总数: meta.后续案例.length, 结果声明计数: Object.fromEntries(COLLABORATION_OUTCOMES.map(kind => [kind, meta.后续案例.filter(item => item.结果声明 === kind).length])),
    最近案例: last ? { 情境: last.情境, 采用说明: excerpt(last.采用说明, 100), 观察: excerpt(last.观察, 120), 结果声明: last.结果声明, 来源: last.来源, 依据: excerpt(last.依据, 100) } : null,
    口径: '记录者声明的有界案例；未认证用户表达、实际采用、改善或因果，历史目标引用不授予现权',
    案例省略: meta.后续案例.length > 1 };
}

export function collaborationFeedbackSchema() {
  const string = maxLength => ({ type: 'string', minLength: 1, maxLength });
  const ref = { type: 'object', properties: { 项目: string(256), 目标: string(256), 修订: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER } }, required: ['项目', '目标', '修订'], additionalProperties: false };
  const source = { type: 'string', enum: [...COLLABORATION_SOURCES] };
  return { type: 'object', properties: { 基线: ref, 反馈: string(1000), 来源: source, 原做法: string(1000), 调整做法: string(1000),
    适用条件: { type: 'array', minItems: 1, maxItems: 6, items: string(240) },
    后续案例: { type: 'array', maxItems: 6, items: { type: 'object', properties: { 情境: ref, 采用说明: string(500), 观察: string(1000),
      结果声明: { type: 'string', enum: [...COLLABORATION_OUTCOMES] }, 来源: source, 依据: string(500) },
      required: ['情境', '采用说明', '观察', '结果声明', '来源', '依据'], additionalProperties: false } } },
    required: ['基线', '反馈', '来源', '原做法', '调整做法', '适用条件'], additionalProperties: false,
    description: '仅memory_write的协作教训偏好或overturn替代教训可附；基线/案例必须引用可读真实项目目标及已存在修订。记录者声明，不认证用户、实际采用、改善或因果；未知单列，不自动训练、改规则或改变目标。最多6个后续案例，按id读全文；替代时省略不继承旧复盘。' };
}
