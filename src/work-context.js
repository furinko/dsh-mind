/** 当前工作资料：Lead看未收尾目标与交付进展，成员只看自己的活动任务。 */
import { canonical, digest } from './kernel/text.js';
import { Denied, InvalidBody } from './kernel/errors.js';
import { currentProfessionalScope } from './professional-context.js';
import { constraintsForTaskInSnapshot } from './goal-ledger.js';
import { 已被合法采纳 } from './tasks.js';

export const WORK_CONTEXT_BUDGET = 9000;
const short = (value, limit) => { const text = String(value ?? ''); return { 文本: text.slice(0, limit), 省略: text.length > limit }; };
const taskBrief = node => ({ id: node.id, 状态: node.状态, 代: node.代 ?? null,
  描述: short(node.描述, 360), 判据: (node.判据 ?? []).slice(0, 4).map(value => short(value, 160)),
  判据省略: (node.判据 ?? []).length > 4, 依赖: (node.依赖 ?? []).slice(0, 8), 依赖省略: (node.依赖 ?? []).length > 8 });

async function leadSources(org, actor, project) {
  const snapshot = await org.goals.contextSnapshot({ subject: actor, 项目: project });
  const goals = snapshot.目标.filter(goal => !['取消', '已完成'].includes(goal.状态)).reverse()
    .sort((a, b) => String(b.更新于).localeCompare(String(a.更新于)));
  const selected = goals.slice(0, 3);
  const nodes = await org.tasks.list({ 项目: project });
  const linked = new Map(selected.map(goal => [goal.id, []]));
  for (const node of nodes) {
    const scope = constraintsForTaskInSnapshot(node, nodes, snapshot);
    if (scope && linked.has(scope.目标)) linked.get(scope.目标).push(node);
  }
  for (const node of [...linked.values()].flat()) {
    await org.policy.check({ subject: actor, action: 'read', target: { id: node.id, kind: '任务', authority: '自治', zone: '私有', domain: '集体', project }, context: { task: node } });
  }
  const roles = (await org.registry.list()).filter(role => !['Lead', '主权者', '出厂作者'].includes(role.id))
    .map(role => role.id).filter(id => typeof id === 'string' && id.length <= 80);
  return { goals, selected, linked, roles, stamp: digest(canonical({ goals, linked: [...linked], roles })) };
}

export async function recallWorkContext({ org, subject, project }) {
  if (typeof project !== 'string' || !project.trim() || project.length > 256) throw new InvalidBody('工作上下文需要当前项目键。');
  const before = await currentProfessionalScope(org, subject, project);
  const frame = { 版本: 1, 项目: project, 岗位: before.role, 资料: [], 截断: false };
  const add = item => { frame.资料.push(item); if (JSON.stringify(frame).length > WORK_CONTEXT_BUDGET - 500) { frame.资料.pop(); frame.截断 = true; } };
  if (subject.kind === 'Lead') {
    const sources = await leadSources(org, before.actor, project);
    frame.选择口径 = '本项目最近更新的最多3个未收尾目标；不代表已识别当前对话焦点';
    frame.未收尾目标数 = sources.goals.length;
    frame.可咨询岗位 = sources.roles.slice(0, 12);
    frame.岗位省略 = sources.roles.length > 12;
    frame.截断 = sources.goals.length > sources.selected.length;
    for (const goal of sources.selected) {
      const tasks = sources.linked.get(goal.id);
      add({ 类型: '目标', id: goal.id, 修订: goal.修订, 状态: goal.状态, 期望结果: short(goal.期望结果, 320),
        下一步: short(goal.下一步, 240), 等待原因: short(goal.等待原因, 160),
        需求理解: goal.需求理解 ? { 原始表达: short(goal.需求理解.原始表达, 240), 当前理解: short(goal.需求理解.当前理解, 400),
          来源: short(goal.需求理解.来源, 160), 待验证: (goal.需求理解.待验证 ?? []).slice(0, 3).map(value => short(value, 160)),
          关键问题: (goal.需求理解.关键问题 ?? []).map(value => short(value, 160)), 分工: (goal.需求理解.分工 ?? []).slice(0, 3).map(item => ({ 岗位: item.岗位, 工作: short(item.工作, 240), 理由: short(item.理由, 160) })),
          省略: (goal.需求理解.待验证 ?? []).length > 3 || (goal.需求理解.分工 ?? []).length > 3 } : null,
        完成依据: goal.完成依据.slice(0, 4).map(value => short(value, 160)), 完成依据省略: goal.完成依据.length > 4,
        约束数: goal.约束.length, 禁止工具: goal.禁止工具,
        交付进展: { 关联任务: tasks.length, 合法采纳: tasks.filter(已被合法采纳).length, 整体效果: '仍需Lead依据当前目标核对，任务采纳不等于目标符合' },
        任务: tasks.slice(-2).map(taskBrief), 任务省略: tasks.length > 2 });
    }
    const afterSources = await leadSources(org, before.actor, project);
    if (sources.stamp !== afterSources.stamp) throw new Denied('工作上下文 · 目标或交付已变化', '目标理解、交付或岗位目录变化，丢弃旧工作帧。');
    frame.数据版本 = sources.stamp;
  } else if (!before.council) {
    frame.选择口径 = '当前真实凭证绑定的最多4个活动任务；不包含Lead私人理解或其他任务资料';
    frame.截断 = before.nodes.length > 4;
    for (const node of before.nodes.slice(0, 4)) add({ 类型: '任务', ...taskBrief(node) });
  }
  const after = await currentProfessionalScope(org, subject, project);
  if (before.stamp !== after.stamp) throw new Denied('工作上下文 · 当前身份或任务已变化', '身份、凭证、绑定或任务读域变化，丢弃旧工作帧。');
  return frame;
}
