/** 按当前真实岗位装配知识摘要；专业范围只缩小召回，不产生新的读权限。 */
import { canonical, digest } from './kernel/text.js';
import { Denied, InvalidBody } from './kernel/errors.js';
import { 取复核读域 } from './review-scope.js';
import { matchingBinding } from './tool-file-scope.js';
import { expandRecallQuery, rankCapabilities, recallSnippet } from './memory-recall.js';
import { readLeadFocus } from './lead-focus.js';

export const PROFESSIONAL_CONTEXT_LIMIT = 4;
export const PROFESSIONAL_CONTEXT_BUDGET = 12000;

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
  const credential = { actor, 代: member.代, 代次: member.代次 ?? null, 委派者: member.委派者 ?? null, 会审绑定: member.会审绑定 ?? null };
  const credentialStamp = digest(canonical(credential));
  const stamp = digest(canonical({ ...credential, nodes, domain: domain?.限定 ? [...domain.集合].sort() : null }));
  return { actor, role, nodes, domain, stamp, credentialStamp, council: Boolean(member.会审绑定) };
}

export { currentScope as currentProfessionalScope };

export async function recallProfessionalContext({ org, subject, project, onAssembled, readExpression = () => null }) {
  if (typeof project !== 'string' || !project.trim() || project.length > 256) throw new InvalidBody('专业上下文需要长度不超过256的当前项目键。');
  const before = await currentScope(org, subject, project);
  const base = { 版本: 2, 项目: project, 岗位: before.role, 类型: '知识', 条数上限: PROFESSIONAL_CONTEXT_LIMIT,
    任务: before.nodes.slice(0, 4).map(node => node.id).filter(id => typeof id === 'string' && id.length <= 256), 任务截断: before.nodes.length > 4,
    阶段: before.nodes.slice(0, 4).map(n => ({ id: n.id, 状态: n.状态 })), 经历: [], 能力: [] };
  if (subject.kind === '成员' && (before.council || !before.nodes.length)) return { ...base, 状态: before.council ? '会审资料另行提供' : '无当前有效活动绑定', 知识: [] };
  const expression = readExpression();
  const focus = subject.kind === 'Lead' && !expression?.query ? await readLeadFocus(org, before.actor, project) : null;
  const tasks = before.nodes.slice(0, 4).map(n => [String(n.描述 ?? '').slice(0, 400), ...(n.判据 ?? []).slice(0, 4).map(v => String(v).slice(0, 100))].join(' '));
  const rawQueries = [...new Set([expression?.query, ...tasks, focus?.query].filter(v => v?.trim()))].slice(0, 3);
  const queries = rawQueries.length ? rawQueries.map(expandRecallQuery) : [''];
  const observations = []; const details = []; let clipped = rawQueries.length < new Set([expression?.query, ...tasks, focus?.query].filter(Boolean)).size;
  const collect = async (kind, max) => {
    const merged = new Map();
    for (const [index, query] of queries.entries()) {
      if (kind === '经历' && !query) continue;
      const spec = { subject: before.actor, 读者: before.actor, 项目: project, 类: kind, 读域: before.domain, 文本: query, 场景检索: true,
        ...(kind === '知识' ? { 岗位: before.role, 精确岗位: !query } : { 上下文经历: true }),
        返回模式: '摘要', limit: max, 条数上限: max, 内容预算: 4000 };
      const result = await org.memory.query(spec); clipped ||= result.内容截断 === true || result.条目截断 === true; observations.push({ spec, version: result.数据版本, count: result.口径?.文档数 ?? 0, kind });
      for (const [rank, entry] of (result.条目 ?? []).entries()) {
        const previous = merged.get(entry.id); const score = (index === 0 ? 2 : 1) / (60 + rank);
        merged.set(entry.id, { entry, score: (previous?.score ?? 0) + score, spec });
      }
    }
    const selected = [...merged.values()].sort((a, b) => b.score - a.score || a.entry.id.localeCompare(b.entry.id)).slice(0, max);
    const out = [];
    for (const row of selected) {
      const { 文本: _query, limit: _limit, 条数上限: _rows, ...rest } = row.spec;
      const spec = { ...rest, id: row.entry.id, 返回模式: '全文', 内容预算: 5000 };
      const full = await org.memory.query(spec); const entry = full.条目?.[0];
      if (!entry) continue;
      details.push({ spec, version: full.数据版本 });
      const snippet = recallSnippet(entry); clipped ||= snippet.需继续读取;
      out.push({ id: entry.id, 类: kind, 摘要: String(row.entry.摘要 ?? '').slice(0, 160), 岗位: entry.岗位 ?? null, 项目: entry.项目 ?? null, 归属: entry.归属 ?? null,
        ...snippet, 来源说明: String(entry.来源?.怎么知道 ?? '').slice(0, 180), 复验状态: entry.复验状态 ?? null,
        继续读取: { action: 'memory_query', id: entry.id, 类: kind, 返回模式: '全文' }, 版本摘要: digest(canonical({ 内容: entry.内容, 来源: entry.来源, 知识说明: entry.知识说明 ?? null })) });
    }
    return out;
  };
  const knowledge = await collect('知识', PROFESSIONAL_CONTEXT_LIMIT);
  const experiences = await collect('经历', 2);
  const capabilityProof = [];
  // Reviewers retain their object-limited knowledge/experience domain; capability cards are read-only procedures, never other answers.
  await org.policy.check({ subject: before.actor, action: 'read', target: { id: '能力/召回', kind: '能力', authority: '自治', zone: '私有', domain: '集体', project } });
  const capabilities = await org.capability.list({ subject: before.actor, 岗位: before.role });
  const candidateCaps = new Map();
  for (const query of queries) for (const cap of rankCapabilities(capabilities, query, 2)) if (!candidateCaps.has(cap.id) || cap.来源 === '自治') candidateCaps.set(cap.id, cap);
  const selectedCaps = [...candidateCaps.values()].slice(0, 2); const caps = [];
  for (const cap of selectedCaps) {
    const full = await org.capability.read({ subject: before.actor, id: cap.id, 来源: cap.来源 }); if (!full || !full.适用岗位.includes(before.role)) continue;
    const hash = digest(full.正文); capabilityProof.push({ id: full.id, source: full.来源, hash });
    caps.push({ id: full.id, 来源: full.来源, 类: '能力', 名: cap.名, ...recallSnippet(full, 1000), 版本摘要: hash,
      继续读取: { action: 'capability_read', id: full.id, 来源: full.来源 } });
  }
  const after = await currentScope(org, subject, project);
  if (before.stamp !== after.stamp || (expression?.stamp ?? null) !== (readExpression()?.stamp ?? null)) throw new Denied('专业上下文 · 读域已变化', '身份、凭证、任务或当前表达变化，丢弃本次召回。');
  if (focus && (await readLeadFocus(org, before.actor, project)).stamp !== focus.stamp) throw new Denied('专业上下文 · 目标变化', '目标变化，丢弃旧资料。');
  for (const row of [...observations, ...details]) await org.memory.query({ ...row.spec, 数据版本: row.version });
  for (const cap of capabilityProof) { const fresh = await org.capability.read({ subject: before.actor, id: cap.id, 来源: cap.source }); if (!fresh || digest(fresh.正文) !== cap.hash) throw new Denied('能力召回来源变化', '能力更新或撤回，丢弃旧片段。'); }
  const finalScope = await currentScope(org, subject, project);
  if (before.stamp !== finalScope.stamp || (expression?.stamp ?? null) !== (readExpression()?.stamp ?? null)) throw new Denied('专业上下文 · 最终读域变化', '校验期间身份、任务或表达变化，丢弃旧资料。');
  if (focus && (await readLeadFocus(org, before.actor, project)).stamp !== focus.stamp) throw new Denied('专业上下文 · 目标变化', '目标变化，丢弃旧资料。');
  clipped ||= caps.some(cap => cap.需继续读取);
  const frame = { ...base, 状态: '已装配', 依据: expression?.query ? '当前已接纳问题与活动任务检索' : rawQueries.length ? '本岗位与当前活动任务检索' : 'Lead本岗位最近有效知识',
    检索方式: 'BM25词面、标题与适用说明，有限术语扩展；不是通用语义检索，零命中不补无关近期项',
    数据版本: observations.find(o => o.kind === '知识')?.version ?? null, 候选数: Math.max(0, ...observations.filter(o => o.kind === '知识').map(o => o.count)),
    知识: knowledge, 经历: experiences, 能力: caps, 截断: clipped };
  while (JSON.stringify(frame).length > PROFESSIONAL_CONTEXT_BUDGET && (frame.能力.length || frame.经历.length || frame.知识.length)) {
    if (frame.能力.length) frame.能力.pop(); else if (frame.经历.length) frame.经历.pop(); else frame.知识.pop(); clipped = true;
  }
  frame.截断 = clipped;
  onAssembled?.({ stamp: after.stamp, credentialStamp: after.credentialStamp }); return frame;
}
