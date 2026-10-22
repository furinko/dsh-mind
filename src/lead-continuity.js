/** Lead 连续性只是有来源的记忆资料，不是身份、权限或已认证的用户意图。 */
import { InvalidBody } from './kernel/errors.js';
import { normalizeCollaborationFeedback } from './collaboration-feedback.js';

export const LEAD_MEMORY_KINDS = Object.freeze(['用户偏好', '人格', '协作教训']);
export function normalizeContinuity(value) {
  if (value === undefined) return undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value)
      || Object.keys(value).length !== 4 || Object.keys(value).some(key => !['类别', '主题', '依据', '范围'].includes(key))
      || !LEAD_MEMORY_KINDS.includes(value.类别) || !['明确表达', '推断', '自省'].includes(value.依据)
      || !['部署', '项目'].includes(value.范围) || typeof value.主题 !== 'string' || !value.主题.trim() || value.主题.length > 80) {
    throw new InvalidBody('连续性须包含类别（用户偏好/人格/协作教训）、主题（1至80字符）、依据（明确表达/推断/自省）、范围（部署/项目）；不接受认证或授权字段。');
  }
  if (value.类别 === '用户偏好' && value.依据 === '自省') throw new InvalidBody('用户偏好只能标为明确表达或推断；Lead自省不是用户表达。');
  return { ...value, 主题: value.主题.trim() };
}

export function applicableContinuity(entry, project, category) {
  try {
    const meta = normalizeContinuity(entry.连续性);
    if (Object.hasOwn(entry, '协作反馈') && (meta?.类别 !== '协作教训' || normalizeCollaborationFeedback(entry.协作反馈) === undefined)) return false;
    return entry.类 === '偏好' && meta !== undefined && meta.类别 === category
      && (meta.范围 === '部署' || entry.项目 === project);
  } catch { return false; }
}

/** 来源撤回后，引用它的摘要也停止自动使用；替代链的派生自不是证据引用。 */
export function continuityBlockedSources(all, invalid) {
  const blocked = new Set();
  const children = new Map();
  for (const entry of all.values()) {
    if (invalid(entry) || entry.状态 === '已降权' || entry.状态 === '物理删除') blocked.add(entry.id);
    for (const ref of entry.来源引用 ?? []) {
      if (!/^(know|exp|pref|answ)-/.test(ref)) continue;
      if (!all.has(ref)) blocked.add(entry.id);
      if (!children.has(ref)) children.set(ref, []);
      children.get(ref).push(entry.id);
    }
  }
  const pending = [...blocked];
  for (let i = 0; i < pending.length; i++) {
    for (const child of children.get(pending[i]) ?? []) {
      if (!blocked.has(child)) { blocked.add(child); pending.push(child); }
    }
  }
  return blocked;
}
