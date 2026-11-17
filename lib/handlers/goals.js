// 目标/预算域实现 —— 2026-11-17 从 handlers/index.js 按连续块拆出。
/**
 * 动作实现表 —— 从 lib/actions.js 整体搬出（2026-11-17）。
 *
 * 为什么搬：actions.js 曾是 2700+ 行，动作层（runAction、各道闸、manifest 派生）与
 * 96 个动作实现挤在一起。搬出后这里只剩实现，动作层留 actions.js。
 *
 * 与 actions.js 是**单向依赖**：本文件用到它导出的 helper，它从本文件取 HANDLERS。
 * 因为 helper 只在 handler 函数体内引用（模块顶层不求值），这个环在 ESM 下是安全的。
 */
/**
 * 组织动作表（宿主插件与工作台共用的唯一实现）。
 *
 * 为什么动作表要独立成文件：`references/user-actions.md` 的纪律是
 * **一个操作两处调用者（工具 + UI），但只有一处实现**。
 * 于是这里既被 `mind` 工具调用，也被 `/mind` 命令调用，两条路进的是同一张表。
 */
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
// （v2 · 2026-10-18：subjectForRole 的入口解析已随主体类「复核者」移除，
//  本文件不再 import 它——映射落点仍在 src/registry.js 供 canTouch/debate 候选池用。）
// 审计尾默认条数单源（设计评审 #17 · 2026-10-15）：动作面两处默认（workbench 的 审计条数 /
// audit_tail 的 limit）都引这里，不再各写字面量。
import { 审计尾默认条数 } from '../../src/audit.js';
// ①甲（2026-10-10）：bus_send 拒往讨论线程直灌时，文案里的类型闸口径取自 debate.js 的**唯一源**
// （不在这里再抄一遍三种类型 —— 抄一遍就会漂）。
import { DEBATE_SAY_TYPES, COUNCIL_THREAD_PREFIX } from '../../src/council.js';
// P1-09（全面审查 2026-10-17）：盲标只允许一个实现——总线读面与工作台/揭名共用
// review.js 的确定性置换；别再按消息到达顺序另造一套（顺序本身就是身份线索）。
import { 盲标分配 } from '../../src/review.js';
// v2 口述收敛 2026-10-18 条目10：卡版本补进主体形状的**唯一** helper（审计随之带版本）。
import { 钉版主体 } from '../../src/subject.js';
// v2 条目4/6 补修 · 复核读域唯一判据：复核员岗的读面按「已绑定复核任务→显式复核对象」限定，
// 不是 role 全量。workbench / task_criteria / memory_query / audit_tail / bus_read 都走它。
import { 取复核读域, 在读域, 审计行在读域, 线程在读域, 复核对象引用 } from '../../src/review-scope.js';
// v2 条目14/17（2026-10-18 补修F）：主权者逐请求放行的重放上下文；步骤计划构造器是
// 宏动作 → 底层策略写的唯一翻译层（本文件只在入口处调它，不在这里另抄一份步骤）。
import { 以放行上下文, 记录本次新建 } from '../../src/intervention.js';
import { 介入计划Of, 计划会挂起 } from '../approval-plan.js';
import { assertMemberSpawnPlan, runMemberSpawnStages, memberSpawnBudgetReceipt, recheckMemberSpawnPlan } from '../member-spawn-plan.js';
import { createMemberSpawnJournal } from '../member-spawn-journal.js';
// 介入度三档的唯一来源（设置入口校验与策略引擎读同一张表，别在两处各写一份）。
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
import { memberHandlers } from './members.js';


import { 记动作拦截, 实例活动索引, 实例活动读数, 未登记敲门者, informationScope, requireExperiments, READ_ONLY_SET, 命令面专属文案, 拒讨论线程直灌, 成员可达节点, 规范读根, 断言记忆写入参数, reviewReadProof, 复核读域For, 取任务上下文, 盲评遮罩, 要求授权, 解析模型路由, 断言成员宿主就绪, 停执行体, 补偿归属复判, 登记钉版, 发成员书, 拼钉卡规程, 参数列表, 岗位清单, 断言会审计计划完整, 会审退役适配器, 中止信号, 错误信息, 目标参数, 动作提交凭据, 宿主清理凭据, 规范成员名, 查Team名, 拒他人任务线程, 记设置入账, 设置读数, 设置依据, 解析介入度, 解析复核免审, 解析开关, 解析设置小时, 读部署偏好文件, 会审咨询动作 } from '../actions.js';

export const goalHandlers = {
  async goal_create({ org, 项目, subject, args, 执行计划 }) {
    return { 目标: await org.goals.create(目标参数(args, subject, 项目, 执行计划)) };
  },
  async goal_query({ org, 项目, subject, args }) {
    const spec = 目标参数(args, subject, 项目);
    return args.id !== undefined
      ? { 目标: await org.goals.get(args.id, spec) }
      : { 目标清单: await org.goals.list(spec) };
  },
  async goal_revise({ org, 项目, subject, args, 执行计划 }) {
    return { 目标: await org.goals.revise(args.id, 目标参数(args, subject, 项目, 执行计划)) };
  },
  async goal_progress({ org, 项目, subject, args, 执行计划 }) {
    return { 目标: await org.goals.progress(args.id, 目标参数(args, subject, 项目, 执行计划)) };
  },
  async goal_complete({ org, 项目, subject, args, 执行计划 }) {
    return { 目标: await org.goals.complete(args.id, 目标参数(args, subject, 项目, 执行计划)) };
  },
  async goal_link_task({ org, 项目, subject, args, 执行计划 }) {
    return { 目标: await org.goals.linkTask(args.id, 目标参数(args, subject, 项目, 执行计划)) };
  },
  async goal_decide({ org, 项目, subject, args, 面, 执行计划 }) {
    if (面 !== 'command') throw new Denied('持久目标 · 人侧命令专属', '用户目标的改动与状态决定只能由人侧命令执行。');
    const spec = 目标参数(args, subject, 项目, 执行计划);
    if (执行计划?.动作 === 'goal_state') return { 目标: await org.goals.setState(args.id, spec) };
    if (执行计划?.动作 === 'goal_revise') return { 目标: await org.goals.revise(args.id, spec) };
    throw new Fault('GOAL_DECISION_PLAN_INVALID', '目标决定缺少已准备的状态或修订计划；未执行任何目标写入。');
  },
  async budget_query({ org, 项目, subject, args }) {
    return { 预算: await org.budgets.query(args.id, 目标参数(args, subject, 项目)) };
  },
  async usage_query({ org, 项目, subject, args }) {
    const { action: _action, project: _project, ...入参 } = args;
    const 用量 = await org.modelUsage.query({ ...入参, subject, 项目 });
    return { 用量: { ...用量, 采集: org.modelUsageHooks?.health() ?? { enabled: null, attached: false, 完整: false } } };
  },
  async operation_query({ org, 项目, subject, args }) {
    const 自报 = ['subject', '主体', '执行计划', '认证', '面', '回执', '阶段'].filter(key => Object.hasOwn(args, key));
    if (自报.length) throw new InvalidBody(`成员创建操作查询不接受主体、认证、执行计划或阶段自报：${自报.join('、')}。`);
    const { action: _action, project: _project, ...入参 } = args;
    return { 操作: await org.spawnOperations.query({ ...入参, subject, 项目 }) };
  },
  async knowledge_reuse_query({ org, 项目, subject, args }) {
    const 多余 = Object.keys(args).filter(key => !['action', 'project', '任务', '知识id', '条数', '偏移', '数据版本'].includes(key));
    if (多余.length) throw new InvalidBody(`知识复用查询含未知参数：${多余.join('、')}；主体、读域、哈希及计划只能由服务端确定。`);
    const { action: _action, project: _project, ...参数 } = args;
    return { 知识复用: await org.knowledgeReuse.query({ ...参数, subject, 项目 }) };
  },
  async budget_decide({ org, 项目, subject, args, 面, 执行计划 }) {
    if (面 !== 'command') throw new Denied('目标预算 · 人侧命令专属', '受管准入上限只能由人侧命令配置。');
    if (执行计划?.动作 !== 'budget_configure') throw new Fault('BUDGET_DECISION_PLAN_INVALID', '预算配置缺少领域签发计划；未执行任何预算写入。');
    return { 预算: await org.budgets.configure(args.id, 目标参数(args, subject, 项目, 执行计划)) };
  },

};
