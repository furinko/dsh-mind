// 轮摘要与记忆生命周期实现 —— 2026-11-17 从 handlers/index.js 按域拆出。
// 依赖沿用同一组命名导入（全量）；后续可按实际使用面收窄。
import { Denied, Fault, InvalidBody, NeedsApproval } from '../../src/kernel/errors.js';
import { canonical } from '../../src/kernel/text.js';
import { normalizeContinuity } from '../../src/lead-continuity.js';
import { AUTHORITIES } from '../../src/tags.js';
import { normalizeCollaborationFeedback } from '../../src/collaboration-feedback.js';
import { atomicWrite, readTextOrNull, stripBom, withLock } from '../../src/kernel/fsx.js';
import { MAX_RESPONSE_DEADLINE_HOURS } from '../../src/kernel/time.js';
import { MEMORY_KINDS, 线程等价键 } from '../../src/paths.js';
import { 全员已交, 负责人实例名单 } from '../../src/tasks.js';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
import { 审计尾默认条数 } from '../../src/audit.js';
import { DEBATE_SAY_TYPES, COUNCIL_THREAD_PREFIX } from '../../src/council.js';
import { 盲标分配 } from '../../src/review.js';
import { 钉版主体 } from '../../src/subject.js';
import { 取复核读域, 在读域, 审计行在读域, 线程在读域, 复核对象引用 } from '../../src/review-scope.js';
import { 以放行上下文, 记录本次新建 } from '../../src/intervention.js';
import { 介入计划Of, 计划会挂起 } from '../approval-plan.js';
import { assertMemberSpawnPlan, runMemberSpawnStages, memberSpawnBudgetReceipt, recheckMemberSpawnPlan } from '../member-spawn-plan.js';
import { createMemberSpawnJournal } from '../member-spawn-journal.js';
import { INTERVENTION } from '../../src/policy.js';
import { messageExistingMember, listExistingMembers, stopExistingMember } from '../member-maintenance.js';
import { TASK_RECOVERY_RELATION_FIELDS } from '../../src/task-state.js';
import { readInstanceSnapshot } from '../../src/instance-snapshot.js';
import { matchingBinding } from '../../src/tool-file-scope.js';
import { normalizeKnowledgeContext } from '../../src/knowledge-applicability.js';
import { normalizeFeedbackReference } from '../../src/knowledge-feedback.js';
import { assertExecutionHost, prepareExecution, releaseExecution, sendExecutionMessage, requireDelegation, parseModelRoute } from '../host-execution.js';
import { leadAffectExecution } from '../../components/kernel/lib/lead-affect.js';
import { readTaskRecords } from '../../src/task-records.js';
import { ACTION_MANIFEST, TOOL_ACTION_IDS, COMMAND_ONLY_ACTION_IDS, READ_ONLY_ACTION_IDS, MODEL_FACING_REJECTIONS } from '../action-manifest.js';
import { capabilityHandlers } from './capability.js';
import { busHandlers } from './bus.js';
import { debateHandlers } from './debate.js';
import { auditHandlers } from './audit-actions.js';
import { registryHandlers } from './registry.js';
import { goalHandlers } from './goals.js';
import { taskHandlers } from './tasks.js';
import { memberHandlers } from './members.js';
import { 记动作拦截, 实例活动索引, 实例活动读数, 未登记敲门者, informationScope, requireExperiments, READ_ONLY_SET, 命令面专属文案, 拒讨论线程直灌, 成员可达节点, 规范读根, 断言记忆写入参数, reviewReadProof, 复核读域For, 取任务上下文, 盲评遮罩, 要求授权, 解析模型路由, 断言成员宿主就绪, 停执行体, 补偿归属复判, 登记钉版, 发成员书, 拼钉卡规程, 参数列表, 岗位清单, 断言会审计计划完整, 会审退役适配器, 中止信号, 错误信息, 目标参数, 动作提交凭据, 宿主清理凭据, 规范成员名, 查Team名, 拒他人任务线程, 记设置入账, 设置读数, 设置依据, 解析介入度, 解析复核免审, 解析开关, 解析设置小时, 读部署偏好文件, 会审咨询动作 } from '../actions.js';

export const miscHandlers = {
  async turn_summary({ org, 项目, subject, args, 宿主 }) {
    if (!宿主?.agent?.session?.id || args.project && 项目 !== 宿主.project) throw new Denied('轮级总结会话', '需要当前真实会话。');
    return { 总结: await org.turnSummaries.summarize({subject,project:项目,session:宿主.agent.session.id,summary:args.总结}) };
  },
  async task_reconcile({ org, 项目, subject, args }) {
    return { 恢复: await org.tasks.reconcile(args.id,{subject,项目,核对:args.核对,决策:args.决策,实例:args.实例,岗位:args.岗位}) };
  },
  async task_organize({ org, 项目, subject, args }) {
    return { 整理: await org.tasks.organizeKnowledge(args.id,{subject,项目,记忆处置:args.记忆处置}) };
  },
  async memory_lifecycle({ org, 项目, subject, args, 执行计划 }) {
    const op = args.op;
    const 反馈参数 = Object.hasOwn(args, '反馈引用') ? { 反馈引用: args.反馈引用, 反馈执行计划: 执行计划 } : {};
    if (Object.hasOwn(args, '反馈引用') && !执行计划) throw new Fault('KNOWLEDGE_FEEDBACK_PLAN_MISSING', '缺少领域准备的反馈执行计划，未追加知识状态或创建替代知识。');
    // invalidate / demote / overturn 同病修复（2026-10-12）：成员在任务内处置自己记的条目
    // （§7「错误/过期/冷/被推翻」）是常规动作，与 memory_write 一样要透传任务上下文。
    // purge / promote 不透传：物理删除已被处置表闸收紧（敏感声明/主权者），晋升是 Lead 语义。
    if (op === 'invalidate') return { 结果: await org.memory.invalidate(args.id, { subject, 项目, 原因: args.原因, 任务: await 取任务上下文({ org, 项目, args }), ...反馈参数 }) };
    if (op === 'demote') return { 结果: await org.memory.demote(args.id, { subject, 项目, 原因: args.原因, 任务: await 取任务上下文({ org, 项目, args }), ...反馈参数 }) };
    if (op === 'overturn') return { 结果: await org.memory.overturn(args.id, { subject, 项目, 新条目: args.新条目, 理由: args.原因, 任务: await 取任务上下文({ org, 项目, args }), ...(Object.hasOwn(args, '知识说明') ? { 知识说明: args.知识说明 } : {}), ...(Object.hasOwn(args, '连续性') ? { 连续性: args.连续性 } : {}), ...(Object.hasOwn(args, '协作反馈') ? { 协作反馈: args.协作反馈 } : {}), ...反馈参数 }) };
    if (op === 'purge') {
      // 物理删除是全库唯一真抹内容的动作：理由与「这是敏感数据」的显式声明都要在动作层先拦住，
      // 缺了就是结构不合规，而不是放到服务层炸 TypeError。
      if (typeof args.原因 !== 'string' || !args.原因.trim()) {
        throw new InvalidBody('purge 需要「原因」：物理删除必须留依据进不可逆操作记录。', { missing: ['原因'] });
      }
      return { 结果: await org.memory.purge(args.id, { subject, 理由: args.原因, 敏感: args.敏感 === true }) };
    }
    if (op === 'promote') {
      // 契约C（2026-10-09）：晋升前过披露机械检查；披露豁免 是 Lead 专属参数
      // （服务层校验主体种类，非 Lead 带了也要拒），豁免与命中模式会一起进审计。
      return { 结果: await org.memory.promoteCrossProject(args.id, { subject, 岗位: args.岗位, 理由: args.原因, 披露豁免: args.披露豁免 === true }) };
    }
    throw new InvalidBody(`未知记忆处置：${String(op)}`, { detail: { 可选: ['invalidate', 'demote', 'overturn', 'purge', 'promote'] } });
  },
};
