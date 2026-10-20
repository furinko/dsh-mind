/** 预算只归属真实活动文件范围；参数里的任务/目标不是执行归属凭证。 */
import { canonical, digest } from './kernel/text.js';
import { Denied } from './kernel/errors.js';
import { agentSubject } from './subject.js';
import { readInstanceSnapshot } from './instance-snapshot.js';
import { readTaskLedgerSync } from './task-ledger.js';
import { fold } from './tasks.js';
import { constraintsForTaskInSnapshot } from './goal-ledger.js';
import { FILE_READ_TOOLS, FILE_WRITE_TOOLS } from './tool-file-scope.js';

export function memberFileBudgetScope(exec, { org, projectOf, cwdOf }) {
  if (!FILE_READ_TOOLS.has(exec?.name) && !FILE_WRITE_TOOLS.has(exec?.name)) return null;
  const subject = agentSubject(exec);
  if (subject.kind !== '成员') return null;
  const identity = readInstanceSnapshot(org.layout.identityFile());
  if (!identity.ok) throw new Denied('预算 · 身份不可判', '不能读取真实成员身份，无法确认预算归属。');
  const member = identity.成员[subject.id];
  // 复核/会审有不同读域，本轮不凭普通文件任务范围猜它们的预算归属。
  if (member?.岗位 === '复核员' || member?.会审绑定) return null;
  const parent = identity.成员[member?.委派者id];
  if (!member?.就绪 || !parent?.就绪 || parent.岗位 !== 'Lead') throw new Denied('预算 · 身份不可判', '当前成员或派发 Lead 未就绪，不能签发预算准入。');
  const project = projectOf(exec);
  const cwd = cwdOf(exec);
  const nodes = [...fold(readTaskLedgerSync(org.layout.taskLog(project))).values()].map(node => ({ ...node, 项目: project }));
  const scope = org.tasks.toolFileAuthority().scopeTasks({ tool: exec.name, args: exec.arguments, cwd, nodes, instance: subject.id, parent: member.委派者id, member });
  const snapshot = org.goals.rawSnapshot(project);
  const goalIds = [...new Set(scope.constrained.map(node => constraintsForTaskInSnapshot(node, nodes, snapshot)?.目标).filter(Boolean))].sort();
  if (!goalIds.length) return null;
  const configured = goalIds.filter(id => org.budgets.getBudgetSync(id, { 项目: project }) !== null);
  if (!configured.length) return null;
  if (goalIds.length !== 1) throw new Denied('预算 · 多目标归属不明', '本路径命中多个目标且存在受管额度，不能猜测分账；请使用归属明确的独立任务文件范围。');
  const goal = snapshot.目标.find(item => item.id === goalIds[0]);
  const credential = item => ({ 岗位: item.岗位, 代: item.代, 卡版本摘要: item.卡版本摘要, 宿主代次: item.宿主代次, 委派者id: item.委派者id ?? null });
  return {
    subject: { ...subject, roleId: member.岗位 }, project, goal: goal.id, goalRevision: goal.修订,
    fingerprint: digest(canonical({ subject: subject.id, member: credential(member), parent: credential(parent), project, cwd,
      tool: exec.name, args: exec.arguments, target: scope.target,
      // 纯进展和关联修订不改变本次约束；用户意图、限制或状态变化要求重新准入。
      goal: { id: goal.id, 状态: goal.状态, 期望结果: goal.期望结果, 约束: goal.约束, 禁止工具: goal.禁止工具, 完成依据: goal.完成依据 },
    })),
  };
}
