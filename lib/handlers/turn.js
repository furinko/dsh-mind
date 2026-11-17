// 轮级缓冲/归档域实现 —— 2026-11-17 从 handlers/index.js 按域拆出。
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

export const turnHandlers = {
  async turn_buffer_query({ org, 项目, 会话项目, subject, args, 宿主 }) {
    const session = 宿主?.agent?.session;
    if (!session || session.id !== subject.id || 项目 !== 会话项目 || 宿主.project !== 会话项目) {
      throw new Denied('轮级缓冲 · 宿主会话范围', '只允许查询当前真实会话、本项目的私人缓冲，不接受自报会话或跨项目读取。');
    }
    await org.turnBufferHooks?.sync(session);
    if (args.原文 !== undefined && typeof args.原文 !== 'boolean') throw new InvalidBody('原文模式必须为布尔值。');
    if (args.原文 === true) {
      if (args.文本 !== undefined || /^turn-[a-f0-9]{64}$/.test(args.id ?? '')) throw new InvalidBody('原文模式需要本会话真实消息id；跨会话turn-引用请用现有正文偏移读取。');
      const end = session.seq;
      const 原文 = await org.turnBuffer.readOriginal({ subject, project: 项目, session: session.id, id: args.id,
        part: args.字段 ?? 'text', textOffset: args.正文偏移 ?? 0, limit: args.内容预算 ?? 24000, dataVersion: args.数据版本 });
      if (宿主.project !== 会话项目 || 宿主.agent.session !== session || session.seq !== end) throw new Denied('轮级原文 · 会话变化', '会话或项目变化，丢弃旧原文。');
      return { 原文, 采集: org.turnBufferHooks?.health() ?? null };
    }
    if (args.文本 !== undefined || /^turn-[a-f0-9]{64}$/.test(args.id ?? '')) {
      const end = session.seq;
      const 召回 = await org.conversationRecall.read({ subject, project: 项目, session: session.id, throughSeq: end }, {
        text: args.文本 ?? '', id: args.id, limit: args.limit ?? 8, offset: args.偏移 ?? 0,
        bodyOffset: args.正文偏移 ?? 0, budget: args.内容预算 ?? 12000, dataVersion: args.数据版本,
        scanOffset: args.扫描偏移 ?? 0, crossProject: args.跨项目 ?? true });
      if (宿主.project !== 会话项目 || 宿主.agent.session !== session || session.seq !== end) throw new Denied('轮级缓冲 · 会话变化', '会话、项目或历史位置已变化，丢弃旧召回。');
      return { 召回, 采集: org.turnBufferHooks?.health() ?? null };
    }
    const 缓冲 = await org.turnBuffer.read({ subject, project: 项目, session: session.id,
      limit: args.limit ?? 16, offset: args.偏移 ?? 0, id: args.id, dataVersion: args.数据版本, budget: args.内容预算 ?? 24000 });
    if (宿主.project !== 会话项目 || 宿主.agent.session !== session || 缓冲.下次事件序号 > session.seq) throw new Denied('轮级缓冲 · 会话变化', '会话、项目或历史位置变化，丢弃旧查询。');
    return { 缓冲, 待补事件数: 缓冲.下次事件序号 === null ? null : Math.max(0, session.seq - 缓冲.下次事件序号),
      采集: org.turnBufferHooks?.health() ?? null };
  },

  async turn_buffer_forget({ org, 项目, 会话项目, subject, 宿主 }) {
    const session = 宿主?.agent?.session;
    if (!session || session.id !== subject.id || 项目 !== 会话项目 || 宿主.project !== 会话项目) {
      throw new Denied('轮级缓冲 · 宿主会话范围', '请在当前真实会话清空本项目缓冲。');
    }
    const 结果 = await org.turnBuffer.forget({ subject, project: 项目, session: session.id, throughSeq: session.seq });
    await org.projectBrief.touch({ subject, project: 项目, session: session.id });
    return { 结果, 说明: '已清空当前会话的Mind轮级缓冲；宿主原始对话与正式长期记忆分别管理。' };
  },

  async turn_experience_retain({ org, 项目, 会话项目, subject, args, 宿主 }) {
    const session = 宿主?.agent?.session;
    if (!session || session.id !== subject.id || 项目 !== 会话项目 || 宿主.project !== 会话项目) throw new Denied('经历保留 · 当前会话', '只能整理当前真实会话的经历保留状态。');
    return { 保留: await org.turnBuffer.retain({ subject, project: 项目, session: session.id,
      start: args.起始事件序号, retained: args.保留 ?? true }) };
  },

  async turn_archive_maintain({ org, 项目, 会话项目, subject, args, 宿主 }) {
    const session = 宿主?.agent?.session;
    if (!session || session.id !== subject.id || 项目 !== 会话项目 || 宿主.project !== 会话项目) throw new Denied('轮级维护 · 当前会话', '只维护当前真实会话的Mind副本。');
    const spec = { subject, project: 项目, session: session.id };
    const operations = { maintain: 'maintain', migrate: 'migrate', rollback: 'rollbackMigration' };
    const operation = args.op ?? 'maintain';
    const method = Object.hasOwn(operations, operation) ? operations[operation] : null;
    if (!method) throw new InvalidBody('轮级维护op只能是maintain、migrate或rollback。');
    return { 维护: await org.turnBuffer[method](spec) };
  },
};
