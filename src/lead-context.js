/** 仅为当前真实Lead装配连续性；每次重读，不延续旧实例身份或旧许可。 */
import { currentProfessionalScope } from './professional-context.js';
import { LEAD_MEMORY_KINDS } from './lead-continuity.js';
import { Denied, InvalidBody } from './kernel/errors.js';

export const LEAD_CONTEXT_BUDGET = 6500;
export async function recallLeadContext({ org, subject, project }) {
  if (subject?.kind !== 'Lead') throw new Denied('Lead连续性 · 当前身份', '只有当前Lead装配人格、用户偏好与协作教训。');
  if (typeof project !== 'string' || !project.trim() || project.length > 256) throw new InvalidBody('Lead连续性需要当前项目键。');
  const before = await currentProfessionalScope(org, subject, project);
  const frame = { 版本: 1, 项目: project, 依据: '已标注连续性的当前有效记录；明确表达优先，同档取最近项，未做语义相关性认证',
    每类上限: 3, 记录: [], 数据版本: {}, 截断: false };
  const observations = [];
  for (const category of LEAD_MEMORY_KINDS) {
    const result = await org.memory.query({ subject: before.actor, 读者: before.actor, 项目: project, 类: '偏好',
      连续性类别: category, 返回模式: '摘要', 条数上限: 3, 内容预算: 3000 });
    frame.数据版本[category] = result.数据版本;
    observations.push({ category, version: result.数据版本 });
    frame.截断 ||= result.内容截断 === true || result.条目截断 === true;
    for (const entry of result.条目 ?? []) {
      if (typeof entry.id !== 'string' || entry.id.length > 256 || !entry.连续性) { frame.截断 = true; continue; }
      const item = { id: entry.id, 连续性: entry.连续性, 项目: entry.项目 ?? null, 摘要: String(entry.摘要 ?? '').slice(0, 160) };
      if (entry.协作反馈摘要) item.协作反馈摘要 = entry.协作反馈摘要;
      frame.记录.push(item);
      if (JSON.stringify(frame).length > LEAD_CONTEXT_BUDGET - 512) { frame.记录.pop(); frame.截断 = true; }
    }
  }
  // 有材料进入模型前再次核对；失效、替代或来源撤回在查询中发生时，不使用旧帧。
  if (frame.记录.length) {
    for (const { category, version } of observations) {
      await org.memory.query({ subject: before.actor, 读者: before.actor, 项目: project, 类: '偏好',
        连续性类别: category, 数据版本: version, 返回模式: '摘要', 条数上限: 3, 内容预算: 3000 });
    }
  }
  const after = await currentProfessionalScope(org, subject, project);
  if (before.stamp !== after.stamp) throw new Denied('Lead连续性 · 身份已变化', '身份或凭证变化，丢弃本次连续性装配。');
  await org.policy.check({ subject: after.actor, action: 'read', target: { id: `记忆/检索/${project}`, kind: '记忆', authority: '自治', zone: '私有', domain: '集体', project }, context: { 类: '偏好' } });
  return frame;
}
