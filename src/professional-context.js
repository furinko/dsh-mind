/** 按当前真实岗位装配知识摘要；专业范围只缩小召回，不产生新的读权限。 */
import { canonical, digest } from './kernel/text.js';
import { Denied, InvalidBody } from './kernel/errors.js';
import { 取复核读域 } from './review-scope.js';
import { matchingBinding } from './tool-file-scope.js';

export const PROFESSIONAL_CONTEXT_LIMIT = 4;
export const PROFESSIONAL_CONTEXT_BUDGET = 6000;

async function currentScope(org, subject, project) {
  const member = (await org.registry.identity()).members?.[subject?.id];
  const role = member?.岗位;
  if (!['Lead', '成员'].includes(subject?.kind) || member?.status !== '在岗' || typeof role !== 'string' || !role || role.length > 256
      || (subject.kind === 'Lead') !== (role === 'Lead') || (subject.roleId !== undefined && subject.roleId !== role)) {
    throw new Denied('专业上下文 · 当前岗位', '没有匹配的在岗身份，不能按自报岗位召回。');
  }
  const card = await org.registry.cardOf(subject.id);
  if (card?.就绪 !== true || card.岗位 !== role || !member.卡版本?.摘要 || card.卡版本?.摘要 !== member.卡版本.摘要) {
    throw new Denied('专业上下文 · 岗位凭证', '当前岗位卡未就绪，不注入未核对的专业记忆。');
  }
  const actor = { id: subject.id, kind: subject.kind, roleId: role, 卡版本: member.卡版本.摘要 };
  const bindingMember = { ...member, 卡版本摘要: member.卡版本.摘要, 宿主代次: member.代次?.代 ?? null };
  const nodes = subject.kind === '成员' && !member.会审绑定
    ? (await org.tasks.list({ 项目: project })).filter(node => ['已派发', '执行中'].includes(node.状态)
      && (node.绑定 ?? []).some(binding => matchingBinding(binding, subject.id, bindingMember))) : [];
  for (const node of nodes.slice(0, 4)) {
    await org.policy.check({ subject: actor, action: 'read',
      target: { id: node.id, kind: '任务', authority: '自治', zone: '私有', domain: '集体', project }, context: { task: node } });
  }
  const domain = await 取复核读域({ tasks: org.tasks, 项目: project, subject: actor });
  const stamp = digest(canonical({ actor, 代: member.代, 代次: member.代次 ?? null, 委派者: member.委派者 ?? null,
    会审绑定: member.会审绑定 ?? null, nodes, domain: domain?.限定 ? [...domain.集合].sort() : null }));
  return { actor, role, nodes, domain, stamp, council: Boolean(member.会审绑定) };
}

export { currentScope as currentProfessionalScope };

export async function recallProfessionalContext({ org, subject, project }) {
  if (typeof project !== 'string' || !project.trim() || project.length > 256) throw new InvalidBody('专业上下文需要长度不超过256的当前项目键。');
  const before = await currentScope(org, subject, project);
  const base = { 版本: 1, 项目: project, 岗位: before.role, 类型: '知识', 条数上限: PROFESSIONAL_CONTEXT_LIMIT,
    任务: before.nodes.slice(0, 4).map(node => node.id).filter(id => typeof id === 'string' && id.length <= 256), 任务截断: before.nodes.length > 4 || before.nodes.some(node => typeof node.id !== 'string' || node.id.length > 256) };
  // 会审有独立资料域；普通成员未绑定活动任务时不猜工作内容，也不读专业账本。
  if (subject.kind === '成员' && (before.council || !before.nodes.length)) {
    return { ...base, 状态: before.council ? '会审资料另行提供' : '无当前有效活动绑定', 知识: [] };
  }
  const query = before.nodes.slice(0, 4).map(node => `${String(node.描述 ?? '').slice(0, 240)} ${
    (Array.isArray(node.判据) ? node.判据 : []).slice(0, 4).map(value => String(value).slice(0, 120)).join(' ')}`).join(' ').slice(0, 1000);
  const result = await org.memory.query({ subject: before.actor, 读者: before.actor, 项目: project, 类: '知识',
    岗位: before.role, 精确岗位: true, 读域: before.domain, 文本: query, 返回模式: '摘要',
    limit: PROFESSIONAL_CONTEXT_LIMIT, 条数上限: PROFESSIONAL_CONTEXT_LIMIT, 内容预算: 3000 });
  // 同次装配不把旧身份、旧绑定或旧复核读域带到最后；失败由调用方移除旧段。
  const after = await currentScope(org, subject, project);
  if (before.stamp !== after.stamp) throw new Denied('专业上下文 · 读域已变化', '身份、凭证或任务范围变化，丢弃本次召回。');
  await org.policy.check({ subject: after.actor, action: 'read',
    target: { id: `记忆/检索/${project}`, kind: '记忆', authority: '自治', zone: '私有', domain: '集体', project }, context: { 类: '知识' } });
  const knowledge = [];
  let clipped = result.内容截断 === true || result.条目截断 === true;
  const frame = { ...base, 状态: '已装配', 依据: query ? '本岗位与当前活动任务检索' : 'Lead本岗位最近有效知识',
    数据版本: result.数据版本, 候选数: result.口径?.文档数 ?? null, 知识: knowledge, 截断: clipped };
  for (const entry of result.条目 ?? []) {
    if (typeof entry.id !== 'string' || entry.id.length > 256) { clipped = true; continue; }
    const item = { id: entry.id, 摘要: String(entry.摘要 ?? '').slice(0, 160), 岗位: entry.岗位,
      项目: entry.项目 ?? null, 归属: entry.归属 ?? null };
    knowledge.push(item);
    if (JSON.stringify(frame).length > PROFESSIONAL_CONTEXT_BUDGET - 64) { knowledge.pop(); clipped = true; break; }
  }
  frame.截断 = clipped;
  return frame;
}
