import { agentSubject } from '../../../src/subject.js';
import { leadAffectExecution } from './lead-affect.js';
import { renderContextFrame } from './context-frame.js';

export const LEAD_DESIRE_SECTION = 'mind:lead-desires';
export const LEAD_DESIRE_GUIDANCE = [
  '【自己的愿望与长期追求】',
  '你可以有持续想做的事。entries按重要性、投入意愿、未满足程度、等待和受挫独立排序，priority解释当前排序与冷却原因。排序供取舍，不凌驾当前用户工作、操作权限和真实事实。',
  '短暂念头可留在原情绪desires文字中；值得持续的自身愿望用lead_desire_update 欲望={op:create,epoch,key,scope:project或relationship,content:{title,reason,criterion,kind:finite或ongoing,importance,commitment,activities:[read/write/rest],nextStep,renewalHours?}}。两项权重0至1，持续兴趣恢复半衰期6至720小时，默认72小时。criterion说明什么经历会使自己满足，不能虚构用户要求。',
  'project限定项目；自身跨项目兴趣可明确选择relationship，只在当前同一关系内延续，不扩大到其他人。不会自动从一句话、一次受挫或情绪条目生成永久追求；同一愿望保持稳定key，重试不另建。长期追求不随情绪平复或会话结束消失。',
  'lead_desire_query 欲望={id?,offset?,limit?,includeInactive?}可核对，默认按当前优先级。修订用op:revise、epoch、id、revision、reason与完整content。暂停/恢复/放下用op:state、epoch、id、revision、reason、status:paused/active/released；人侧停止和人侧修改的取舍不能由模型恢复或改写。删除用op:remove及当前版本、原因。',
  '真实经历后可用op:feedback、epoch、id、revision、evaluation:{outcome:progress/fulfilled/setback/no-change,satisfaction,progress,reflection,nextStep}、evidence:{kind:conversation}记录满足和受挫。也可引用kind:note的真实id/revision/hash，或kind:activity的既有回执id。满足度/进度0至1，fulfilled两项须为1；它们是有出处的自评，产物存在不证明学会或达到用户目标。',
  'finite满足后结束，ongoing满足后暂时平息，再随时间恢复需求；setback会增加受阻程度并退避，不靠重复失败无限加码。同一依据不可重复提高满足度。历史中的activity是实际活动回执，feedback是评价，两者分开。',
  'recentOutcomes是近七天已经满足的追求，供记得自己做过什么，不作为待办或恢复依据。可以自然分享相关收获，不要求逐项汇报。追求评价引起的情绪仍可经原lead_affect_update如实记录。enabled=false时停止推进与自动形成追求。',
  '开启原有自由活动后，空闲时按可执行性选择优先追求，接续下一步和真实回执；任何前台工作优先。无需为个人追求建正式任务、发消息、执行任意命令或改权限。未开启自由活动时仍可在正常对话里延续，不能自行开后台活动。没有想做的事也可以休息。',
].join('\n');

export async function injectLeadDesires(assembly, { org, agent, projectOf, logger, active = () => true }) {
  if (!Array.isArray(assembly?.sections)) return assembly;
  const clean = assembly.sections.some(s => s?.name === LEAD_DESIRE_SECTION)
    ? { ...assembly, sections: assembly.sections.filter(s => s?.name !== LEAD_DESIRE_SECTION) } : assembly;
  const subject = agentSubject({ agent });
  if (!active() || subject.kind !== 'Lead' || !agent?.session?.id || !agent.session.header?.cwd) return clean;
  try {
    const project = projectOf({ agent }); const execution = leadAffectExecution({ org, subject, project, host: { agent, project } });
    const view = await org.leadDesires.query(execution.spec, { limit: 64, includeInactive: true }); const latest = await org.leadDesires.load();
    execution.options.check(); if (!active() || projectOf({ agent }) !== project || latest.revision !== view.revision) return clean;
    const frame = { 项目: project, 关系: execution.spec.relationship, ...view,
      entries: view.entries.filter(row => row.status === 'active').slice(0, 4).map(row => ({ ...row, history: row.history.slice(-2) })),
      recentOutcomes: view.entries.filter(row => row.status === 'fulfilled' && org.clock.ms() - row.updatedMs < 7 * 86400000)
        .sort((a, b) => b.updatedMs - a.updatedMs).slice(0, 2).map(row => ({ id: row.id, title: row.content.title, status: row.status, history: row.history.slice(-2) })) };
    while (JSON.stringify(frame).length > 8000 && (frame.entries.length || frame.recentOutcomes.length)) {
      if (frame.entries.length > 1 || !frame.recentOutcomes.length) frame.entries.pop(); else frame.recentOutcomes.pop();
    }
    return { ...clean, sections: [...clean.sections, { name: LEAD_DESIRE_SECTION, text: LEAD_DESIRE_GUIDANCE + '\n' + renderContextFrame(LEAD_DESIRE_SECTION, frame) }] };
  } catch (e) { logger?.warn?.(`[dsh-mind] 长期追求暂不可用（${e.code ?? e.name}）；不沿用旧段。`); return clean; }
}
