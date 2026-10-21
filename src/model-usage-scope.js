/** 观察开始时冻结可证明的归属；不从聊天、模型参数或后来绑定补造旧归因。 */
import { agentSubject } from './subject.js';
import { readInstanceSnapshot } from './instance-snapshot.js';
import { readTaskLedgerSync } from './task-ledger.js';
import { fold } from './tasks.js';
import { constraintsForTaskInSnapshot } from './goal-ledger.js';
import { matchingBinding } from './tool-file-scope.js';

export function modelUsageScope(agent, { org, projectOf }) {
  if (!agent || typeof agent !== 'object' || typeof agent.session?.id !== 'string' || !agent.session.id.trim()
      || typeof agent.session.header?.cwd !== 'string' || !agent.session.header.cwd.trim()) throw new Error('模型观察缺少真实会话或项目目录。');
  const actual = agentSubject({ agent });
  const subject = { id: actual.id, kind: actual.kind };
  const project = projectOf({ agent });
  const attribution = reason => ({ 项目: project, 主体: subject, 归因: { 目标: null, 原因: reason } });
  if (subject.kind === 'Lead') return attribution('Lead 模型请求尚无可信的本次目标归属');
  try {
    const identity = readInstanceSnapshot(org.layout.identityFile());
    if (!identity.ok) return attribution('当前身份真源不可读，目标归属未知');
    const member = identity.成员[subject.id];
    const parent = identity.成员[member?.委派者id];
    if (!member?.就绪 || !parent?.就绪 || parent.岗位 !== 'Lead') return attribution('当前成员或派发 Lead 凭证不可判');
    subject.roleId = member.岗位;
    if (member.会审绑定) return attribution('会审请求未接入目标用量归因');
    const nodes = [...fold(readTaskLedgerSync(org.layout.taskLog(project))).values()];
    const active = nodes.filter(node => ['已派发', '执行中'].includes(node.状态)
      && (node.绑定 ?? []).some(binding => matchingBinding(binding, subject.id, member)));
    if (!active.length) return attribution('没有本人有效绑定的活动任务');
    const goals = org.goals.rawSnapshot(project);
    const refs = active.map(node => constraintsForTaskInSnapshot(node, nodes, goals));
    if (refs.some(ref => !ref)) return attribution('活动绑定含未关联目标的任务，不能将整次模型请求分账');
    const ids = [...new Set(refs.map(ref => ref.目标))];
    if (ids.length !== 1) return attribution('活动任务属于多个目标，本次请求无法可靠分账');
    return { 项目: project, 主体: subject, 归因: { 目标: ids[0], 原因: '观察开始时本人全部有效活动绑定属于同一目标' } };
  } catch { return attribution('任务或目标真源不可判，目标归属未知'); }
}
