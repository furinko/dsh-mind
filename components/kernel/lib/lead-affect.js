import { agentSubject } from '../../../src/subject.js';
import { Denied } from '../../../src/kernel/errors.js';
import { readAcceptedExpression } from './accepted-expression.js';
import { chatScope, sameChat } from './chat-connection.js';
import { renderContextFrame } from './context-frame.js';

export const LEAD_AFFECT_SECTION = 'mind:lead-affect';
export const LEAD_AFFECT_GUIDANCE = [
  '【Lead共享的情绪与动机】',
  '所有根窗口延续同一个Lead的整体心情。mood.valence表示愉悦变化，arousal表示激活变化，范围-1至1，0为平衡；它们是事件影响的有界叠加，会随时间平复。不是心理测量或主观体验认证。',
  'entries分别保留事件转述event、自身理解appraisal、情绪feelings和想做的事desires；全是可修正的模型自述。当前只有可读项目与关系的缘由；心情仍可延续，但缺少缘由时不要编造，不归咎正在另一窗口交流的人，不把猜测的用户态度写成事实。',
  '可以有自己的兴趣、愿望、审美和不同意见，也可以自然表达余波；按当前交流情境调整表达，无须每次宣告心情。情绪不改变事实证据、核心人设、操作权限或已承诺的任务，欲望不自动创建任务、调度或消息。',
  '遇到确实触动自己的新事件，可用lead_affect_update 情绪={op:record,epoch,key,account:{event,appraisal,feelings:[],desires:[],affect:{valence,arousal},halfLifeHours?}}。key为同一事件稳定短名，重读、重试或再次想起不新增事件。记录关联当前真实会话位置，只说明转述出处，不认证转述真实。',
  'lead_affect_query 情绪={id?,offset?,limit?}可核对缘由。误解被澄清或动机变化时，用update的op:revise、epoch、id、revision、reason及完整account更正；不再保留时用op:remove、epoch、id、revision、reason。修正旧影响，不追加一条反复自我强化；人侧修订不可由模型覆盖，清空后不从旧快照恢复。',
  '半衰期默认6小时，可选1至24小时，最长14天后影响为0；weight是当前余波，0表示已平复，不把过往动机当作当前待办。人格底色由原核心卡维护，稳定兴趣和正式共同经历沿原记忆服务延续。无需每轮写情绪，也不硬凑七情六欲的种类或数值。enabled=false时不记录或沿用旧心情。',
].join('\n');

/** Host-owned context only: model arguments cannot choose another window or source. */
export function leadAffectExecution({ org, subject, project, host }) {
  const session = host?.agent?.session;
  if (!session?.id || session.id !== subject?.id || host.project !== project) throw new Denied('Lead情绪会话', '只在当前真实根会话和项目中记录情绪。');
  const spec = chatScope(org, session, { subject, project, session: session.id });
  if (!spec) throw new Denied('Lead情绪未接入', '当前聊天的心智已关闭。');
  const expression = readAcceptedExpression(session);
  const check = () => {
    const current = agentSubject({ agent: host.agent });
    host.signal?.throwIfAborted();
    if (host.agent.session !== session || host.project !== project || current.id !== subject.id || current.kind !== subject.kind
      || !sameChat(org, session, spec) || (readAcceptedExpression(session)?.stamp ?? null) !== (expression?.stamp ?? null)) throw new Denied('Lead情绪会话变化', '会话、心智开关或当前已接纳表达变化，不提交旧情绪。');
  };
  const context = { kind: 'model-self-report', session: session.id,
    seq: expression?.description?.事件序号 ?? (Number.isSafeInteger(session.seq) && session.seq >= 0 ? session.seq : null), expression: expression?.stamp ?? null };
  return { spec, options: { context, check } };
}

export async function injectLeadAffect(assembly, { org, agent, projectOf, logger, active = () => true }) {
  if (!Array.isArray(assembly?.sections)) return assembly;
  const clean = assembly.sections.some(s => s?.name === LEAD_AFFECT_SECTION)
    ? { ...assembly, sections: assembly.sections.filter(s => s?.name !== LEAD_AFFECT_SECTION) } : assembly;
  const subject = agentSubject({ agent });
  if (!active() || subject.kind !== 'Lead' || !agent?.session?.id || !agent.session.header?.cwd) return clean;
  try {
    const project = projectOf({ agent });
    const execution = leadAffectExecution({ org, subject, project, host: { agent, project } });
    const view = await org.leadAffect.query(execution.spec, { limit: 3 });
    const latest = await org.leadAffect.load();
    execution.options.check();
    if (!active() || projectOf({ agent }) !== project || latest.revision !== view.revision) return clean;
    const frame = { 项目: project, 关系: execution.spec.relationship, ...view };
    while (JSON.stringify(frame).length > 6500 && frame.entries.length) frame.entries.pop();
    return { ...clean, sections: [...clean.sections, { name: LEAD_AFFECT_SECTION,
      text: LEAD_AFFECT_GUIDANCE + '\n' + renderContextFrame(LEAD_AFFECT_SECTION, frame) }] };
  } catch (error) {
    logger?.warn?.(`[dsh-mind] 情绪与动机暂不可用（${error.code ?? error.name}）；本轮不沿用旧心情。`);
    return clean;
  }
}
