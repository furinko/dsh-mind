/** 用本会话实际记录的目标推进选择工作线索；不声称识别了当前聊天意图。 */
import { canonical, digest } from './kernel/text.js';

export function selectLeadGoals(snapshot) {
  const progress = new Map((snapshot.本会话推进 ?? []).map(item => [item.目标, item.事件序号]));
  const goals = snapshot.目标.filter(goal => !['取消', '已完成'].includes(goal.状态)).reverse()
    .sort((a, b) => (progress.get(b.id) ?? 0) - (progress.get(a.id) ?? 0) || String(b.更新于).localeCompare(String(a.更新于)));
  const focus = goals.find(goal => progress.has(goal.id) && goal.状态 !== '暂停') ?? null;
  if (focus) goals.sort((a, b) => Number(b.id === focus.id) - Number(a.id === focus.id));
  return { goals, focus };
}

export async function readLeadFocus(org, subject, project) {
  const snapshot = await org.goals.contextSnapshot({ subject, 项目: project });
  const { focus } = selectLeadGoals(snapshot);
  const query = focus ? [focus.期望结果.slice(0, 360), String(focus.需求理解?.当前理解 ?? '').slice(0, 300), focus.下一步.slice(0, 140)].join(' ').slice(0, 800) : '';
  const description = focus ? { 目标: focus.id, 修订: focus.修订, 状态: focus.状态, 依据: '本会话最近创建或推进的未收尾目标；不是当前聊天意图认证' } : null;
  return { description, query, stamp: digest(canonical({ description, query })) };
}

/** 只在内部协作教训词面检索中扩展字段，显式memory_query的检索口径不改变。 */
export function lessonSearchText(entry) {
  return [entry.内容, entry.连续性?.主题, entry.协作反馈?.调整做法, ...(entry.协作反馈?.适用条件 ?? [])].filter(value => typeof value === 'string').join('\n');
}
