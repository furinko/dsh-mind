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


import { 记动作拦截, 实例活动索引, 实例活动读数, 未登记敲门者, informationScope, requireExperiments, READ_ONLY_SET, 命令面专属文案, 拒讨论线程直灌, 成员可达节点, 规范读根, 断言记忆写入参数, reviewReadProof, 复核读域For, 取任务上下文, 盲评遮罩, 要求授权, 解析模型路由, 断言成员宿主就绪, 停执行体, 补偿归属复判, 登记钉版, 发成员书, 拼钉卡规程, 参数列表, 岗位清单, 断言会审计计划完整, 会审退役适配器, 中止信号, 错误信息, 目标参数, 动作提交凭据, 宿主清理凭据, 规范成员名, 查Team名, 拒他人任务线程, 记设置入账, 设置读数, 设置依据, 解析介入度, 解析复核免审, 解析开关, 解析设置小时, 读部署偏好文件, 会审咨询动作 } from '../actions.js';

export const HANDLERS = {
  async lead_desire_query(spec) {
    const execution = leadAffectExecution({ org: spec.org, subject: spec.subject, project: spec.项目, host: spec.宿主 });
    if (spec.项目 !== spec.会话项目) throw new Denied('Lead追求项目', '从当前会话项目查询，跨项目自身兴趣由显式关系范围提供。');
    const data = await spec.org.leadDesires.query(execution.spec, spec.args.欲望 ?? {}); execution.options.check(); return { 数据: data };
  },
  async lead_desire_update(spec) {
    const execution = leadAffectExecution({ org: spec.org, subject: spec.subject, project: spec.项目, host: spec.宿主 });
    if (spec.项目 !== spec.会话项目) throw new Denied('Lead追求项目', '使用当前真实会话项目。');
    return { 数据: await spec.org.leadDesires.update(execution.spec, spec.args.欲望 ?? {}, execution.options) };
  },
  async lead_affect_query(spec) {
    const execution = leadAffectExecution({ org: spec.org, subject: spec.subject, project: spec.项目, host: spec.宿主 });
    if (spec.项目 !== spec.会话项目) throw new Denied('Lead情绪项目', '仅在当前会话项目核对具体缘由。');
    const data = await spec.org.leadAffect.query(execution.spec, spec.args.情绪 ?? {});
    execution.options.check(); return { 数据: data };
  },
  async lead_affect_update(spec) {
    const execution = leadAffectExecution({ org: spec.org, subject: spec.subject, project: spec.项目, host: spec.宿主 });
    if (spec.项目 !== spec.会话项目) throw new Denied('Lead情绪项目', '仅在当前会话项目记录具体缘由。');
    return { 数据: await spec.org.leadAffect.update(execution.spec, spec.args.情绪 ?? {}, execution.options) };
  },
  async memory_use_query({ org, 项目, subject, args }) { return { 数据: await org.memoryUse.query({ subject, project: 项目, id: args.id, limit: args.limit ?? 20, offset: args.偏移 ?? 0 }) }; },
  async lead_space_query(spec) { return { 数据: await spec.org.leadSpace.query(informationScope(spec), spec.args.自由空间 ?? {}) }; },
  async lead_space_update(spec) { return { 数据: await spec.org.leadSpace.update(informationScope(spec), spec.args.自由空间 ?? {}) }; },
  async information_query(spec) {
    const scope = informationScope(spec);
    return { 数据: await spec.org.information.query(scope, spec.args.信息 ?? {}) };
  },
  async information_read(spec) {
    const scope = informationScope(spec);
    return { 数据: await spec.org.information.read(scope, spec.args.信息 ?? {}) };
  },
  async information_update(spec) {
    const scope = informationScope(spec);
    await spec.org.turnBufferHooks?.sync(spec.宿主.agent.session);
    return { 数据: await spec.org.information.update(scope, spec.args.信息 ?? {}) };
  },
  async monitor_query({ org, 项目, subject, args }) {
    return { 数据: await org.observability.query({ subject, project: 项目, limit: args.limit ?? 50, offset: args.监控偏移 ?? 0 }) };
  },
  async monitor_followup({ org, 项目, subject, args }) {
    return org.observability.followup({ subject, project: 项目, blockId: args.阻塞引用,
      disposition: args.跟进, reason: args.原因, reference: args.来源引用 });
  },
  async monitor_feedback({ org, 项目, subject, args }) {
    return org.observability.feedback({ subject, project: 项目, blockId: args.阻塞引用,
      category: args.原因分类, reason: args.原因, reference: args.来源引用 });
  },
  async review_experiment_allow({ 项目, 会话项目, subject, args, 宿主 }) {
    return requireExperiments(宿主).allow({ action: 'review_experiment_allow', project: 项目, sessionProject: 会话项目, subject, args, host: 宿主 });
  },
  async review_experiment_run({ 项目, 会话项目, subject, args, 宿主 }) {
    return requireExperiments(宿主).run({ action: 'review_experiment_run', project: 项目, sessionProject: 会话项目, subject, args, host: 宿主 });
  },
  async review_experiment_read({ 项目, 会话项目, subject, args, 宿主 }) {
    return requireExperiments(宿主).read({ action: 'review_experiment_read', project: 项目, sessionProject: 会话项目, subject, args, host: 宿主 });
  },
  async review_experiment_cleanup({ 项目, subject, args, 宿主 }) {
    return requireExperiments(宿主).recoverCleanup({ project: 项目, subject, args });
  },

  async status({ org, 项目 }) {
    // 项目接线（设计评审 F2 · 2026-10-15）：修前不接 `项目`，org.status() 恒用装配期
    // this.project —— status 拿 default 的组织回答别的项目的调用（任务/记忆读数全错壳）。
    return { 数据: await org.status({ 项目 }) };
  },

  async workbench({ org, 项目, subject, args }) {
    // 「全量」不是自报开关（2026-10-12 评审 P1-1）：切片是 §7.5 岗位内隔离的防线，
    // 不能由调用方手里的一个布尔掀掉。成员传了 全量:true 照切片，并如实标注——不静默升降。
    const 要全量 = args.全量 === true;
    const 给全量 = 要全量 && subject?.kind !== '成员';
    return {
      数据: await org.workbench({ 读者: 给全量 ? undefined : subject, 项目, 审计条数: args.审计条数 ?? 审计尾默认条数 }),
      说明: '工作台是投影：只读，不存储，不是第二事实源。',
      ...(要全量 && !给全量
        ? { 提示: '全量视图不对成员开放（§7.5 岗位内隔离）：已按你的岗位切片返回。' }
        : {}),
    };
  },

  async policy_check({ org, 项目, subject, args }) {
    if (!args.target || typeof args.target !== 'object' || Array.isArray(args.target)
        || typeof args.target.kind !== 'string' || !args.target.kind.trim()) {
      throw new InvalidBody('policy_check 需要 target JSON对象及非空 target.kind；例如 {"id":"真实对象id","kind":"产物","authority":"自治","zone":"私有"}。这是参数结构错误，尚未形成权限判定；请核对真实对象标签后纠正，不据此请求新授权。');
    }
    if (args.target.authority !== undefined && !AUTHORITIES.includes(args.target.authority)) {
      throw new InvalidBody(`policy_check target.authority 是对象授权标签，只能为${AUTHORITIES.join('/')}，不是任务id或主体岗位；任务上下文放在顶层「任务」。这是参数错误，尚未形成权限判定；按对象真实标签纠正后重查，不能为求allow降低有效标签。`);
    }
    // 这是预检输入合同；合并来源与旧数据保留策略引擎已有语义，不据工作目录猜区。
    if (args.target.zone !== undefined && !['出厂', '私有', '合并', '旧数据'].includes(args.target.zone)) {
      throw new InvalidBody('policy_check target.zone 是对象来源区，只能为出厂/私有/合并/旧数据，不是workspace、目录路径或主体岗位。省略时沿用私有默认；已知来源必须如实填写。这是参数错误，尚未形成权限判定，请纠正参数，不据此请求新授权。');
    }
    // 预检必须与真实写入消费同一份任务事实；任务 id 只负责寻址，不能由模型自报负责人/状态。
    const 任务 = args.任务 ? await org.tasks.get(args.任务, { 项目 }) : null;
    if (args.任务 && !任务) throw new InvalidBody(`policy_check 任务不存在：${args.任务}（项目 ${项目}）。`);
    const decision = await org.policy.decide({
      subject,
      action: args.动作 ?? 'read',
      target: {
        id: args.target.id ?? 'probe',
        kind: args.target.kind,
        authority: args.target.authority ?? '自治',
        zone: args.target.zone ?? '私有',
        // 项目接线（设计评审 F2b 普查 · 2026-10-15）：修前读 args.project（模型面省略时
        // 恒 null），而 runAction 已把「args.project ?? spec.项目」解析成 `项目`——同一个
        // schema 参数两套口径，判定 target 的 project 维与其它动作不一致（status 同族）。
        project: 项目 ?? null,
        segment: args.target.segment ?? null,
        // 沙箱资格必须经原策略判定；不透传会让已获单独授权的实验预检恒拒，字符串也不能冒充true。
        sandbox: args.target.sandbox === true,
      },
      context: 任务 ? { task: 任务 } : {},
    });
    return { 判定: decision,
      说明: '本次只预检所给对象标签与真实任务上下文，不是文件路径授权或原生工具许可；实际操作仍须经过原业务判定和工具文件范围闸。拒绝或需确认均不允许执行；先核对参数是否符合对象真实标签，不能换对象或降标签求放行。',
      ...(subject.kind === '成员' && !args.任务 && (args.动作 ?? 'read') !== 'read'
        ? { 参数提示: '本次未带顶层「任务」；任务内动作须引用本人真实已绑定的活动任务id，不能放进target.authority，也不能自报负责人或任务状态。这里只指出缺项，不推断已有权限。' } : {}),
    };
  },

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

  async task_create({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.create({ subject, 项目, 描述: args.描述, 负责人: args.负责人, 判据: args.判据, 依赖: args.依赖, ...(args.验证要求 ? { 验证要求: args.验证要求 } : {}), ...(args.复核对象 != null ? { 复核对象: args.复核对象 } : {}) }) };
  },

  /**
   * 改派负责人（task-机制缺口-10th0 · 裁决③）：仅 Lead、仅 待派发/已派发、入审计。
   * 边界判据在服务层（src/tasks.js reassign），这里是纯透传——工具面不多长一张嘴。
   */
  async task_reassign({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.reassign(args.id, { subject, 项目, 负责人: args.负责人 }) };
  },
  async task_close({ org, 项目, subject, args, 执行计划 }) {
    return org.tasks.close(args.id, { subject, 项目, 原因: args.原因, 执行计划 });
  },
  async task_successor({ org, 项目, subject, args, 执行计划 }) {
    return org.tasks.createSuccessor(args.id, {
      subject, 项目, 负责人: args.负责人, 原因: args.原因, 执行计划,
      ...(Object.hasOwn(args, '描述') ? { 描述: args.描述 } : {}),
    });
  },

  async task_dispatch({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.dispatch(args.id, { subject, 项目, 工具文件范围: args.工具文件范围 }) };
  },

  /**
   * v2 条目6/11：绑定实例到节点（负责人不动），或在排兵阶段补绑复核任务的显式复核对象。
   * 判据在服务层（tasks.bind）：仅 Lead、仅 待派发/已派发、身份/目标校验都在写入面。
   */
  async task_bind({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.bind(args.id, { subject, 项目, 实例: args.实例, 岗位: args.岗位, 复核对象: args.复核对象 }) };
  },

  /**
   * 复核读根授权（v2 条目6 补修）：Lead/主权者把**源码目录/产物文件**附到复核任务上。
   *
   * 为什么必须有一个正式入口：复核员 guard 的读根来自任务图真实绑定，没有入口就只能
   * 靠任务书散文或工作区全量——前者不可判、后者是越授。这里复用既有 attach 服务，
   * 只多一个 `读根` 标记（与成员交付产物分开记），不新造授权对象、不改判据、不冒交卷人。
   *
   * 输入是**绝对路径且真实存在**的文件/目录；散文、id、相对路径、私有组织根一律拒。
   */
  async task_attach({ org, 项目, subject, args }) {
    if (!['Lead', '主权者'].includes(subject?.kind)) {
      throw new Denied('任务图 · 复核读根仅 Lead / 主权者可授予', `复核读根会让复核员直读该文件/目录：${subject?.kind ?? '未知'} 不能给自己扩文件读域。`, {
        requireAuthority: 'Lead',
        howToChange: '成员交付产物用普通 attach（不作为复核读根）；要授予复核读根请 Lead 执行 task_attach。',
      });
    }
    const id = String(args.id ?? '').trim();
    if (!id) throw new InvalidBody('task_attach 需要 id（复核任务节点）', { missing: ['id'] });
    const 引用 = (Array.isArray(args.产出物引用) ? args.产出物引用 : [args.产出物引用])
      .map((x) => String(x ?? '').trim()).filter(Boolean);
    if (引用.length === 0) {
      throw new InvalidBody('task_attach 需要「产出物引用」：源码目录/产物文件的绝对路径（可多个，逗号分隔）。', { missing: ['产出物引用'] });
    }
    const 节点 = await org.tasks.get(id, { 项目 });
    if (!节点) throw new InvalidBody(`没有这个任务节点：${id}（项目 ${项目}）`);
    // 只对**复核任务**授予读根：必须有显式复核对象（或负责人是复核员岗）。普通业务节点
    // 附读根等于凭一个 artifact 给复核员开工作区门，不批。
    if (!(复核对象引用(节点).length > 0)) {
      throw new Denied('任务图 · 只对复核任务授予复核读根', `节点 ${id} 不是复核任务（没有复核对象、负责人也不是复核员）：读根只能加在复核任务上。`, {
        requireAuthority: 'Lead',
        howToChange: `先建复核任务并写 复核对象=['被验节点']，再 task_attach（现状负责人 ${JSON.stringify(节点.负责人 ?? [])}）。`,
      });
    }
    const 私有 = 规范读根(org.layout.privateRoot);
    let 最新 = 节点;
    for (const 路径 of 引用) {
      if (!isAbsolute(路径)) throw new InvalidBody(`复核读根必须是绝对路径（收到「${路径}」）：相对/散文引用不可判，不猜。`, { missing: ['产出物引用'] });
      if (!existsSync(路径)) throw new InvalidBody(`复核读根不存在（或读不到）：「${路径}」——只接受真实存在的文件/目录。`);
      let 真;
      try { 真 = 规范读根(realpathSync(路径)); } catch (error) {
        throw new InvalidBody(`复核读根无法解析真实路径：「${路径}」（${error instanceof Error ? error.message : String(error)}）。`);
      }
      if (私有 && (真 === 私有 || 真.startsWith(`${私有}/`) || 真.startsWith(`${私有}\\`))) {
        throw new Denied('任务图 · 私有组织根不许作为复核读根', `「${路径}」在私有区原始账本根内：raw 数据走 scoped mind API，不能授给复核员直读。`, {
          requireAuthority: 'Lead',
          howToChange: '把源码/产物复制到工作区（项目目录）后附绝对路径；raw 账本用 workbench/task_criteria/memory_query/audit_tail/bus_read。',
        });
      }
      最新 = await org.tasks.attach(id, { subject, 项目, 产出物: 真, 读根: true });
    }
    return { 节点: 最新, 附加读根: 引用, 说明: '复核读根已入任务事件与审计；复核员只能读这些绝对路径内的文件/目录。' };
  },

  async task_start({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.start(args.id, { subject, 项目 }) };
  },


  async task_submit({ org, 项目, subject, args }) {
    const 多余 = Object.keys(args).filter(key => !['action', 'project', 'role', 'id', '产出物引用', '结论', '结论层', '反例面', '知识候选', '采用知识', '审批引用'].includes(key));
    if (多余.length) throw new InvalidBody(`任务交卷含未知参数：${多余.join('、')}；知识采用声明的版本、来源及哈希封套由服务端生成。`);
    // 反例面必须原样传到任务图：§10 零分歧判据是「结论层一致且无人给出反例面」，
    // 动作层漏传会让「无人给反例面」恒真，零分歧报警名存实亡。
    // 结论层同（2026-10-14 审查 P1-1）：修前全链路不采集它，判据退化为结论全文逐字
    // 比对——两份独立答案几乎不会逐字相同，「全票一致=异常」报警事实上永不触发。
    return { 节点: await org.tasks.submit(args.id, { subject, 项目, 产出物引用: args.产出物引用, 结论: args.结论, 结论层: args.结论层, 反例面: args.反例面, 知识候选: args.知识候选, ...(Object.hasOwn(args, '采用知识') ? { 采用知识: args.采用知识 } : {}) }),
      知识采用说明: '采用知识是交卷者声明；来源哈希不证明实际使用或收益。自动知识段只反映当前活动任务，交卷后变空不证明此前未召回；应按此前实际见到的摘要/全文及实际使用核对，不确定的使用结果保留未知。Lead可用knowledge_reuse_query核对原始声明，后续口头更正不覆盖原交卷，不要重交洗账。' };
  },

  async task_review({ org, 项目, subject, args }) {
    // 复核者归属不许自报（2026-10-12 评审 P1-2，与 W2 发件人同族；v2 补修收口）：
    // 署名必须**恒等于真实执行主体**——任何 kind 都不许把自己的结论记到别人头上，
    // Lead 也不例外（修前留了 Lead 代签例外，等于给「任意字符串署名」留了正门；
    // 而只判「署名≠主体」又挡不住「换成自己 id 就绕开」的假署名旁路）。
    // Lead 的独立验收权不受影响：Lead 自己签自己就能验收别人的任务。
    if (args.复核者 != null && String(args.复核者) !== String(subject.id)) {
      throw new Denied(
        '复核归属不许代签（W2 同族：归属字段不许自报）',
        `复核者（${args.复核者}）与执行主体（${subject.id}）不一致：复核结论的署名就是复核者本人，不许替别人署名（含 Lead 代签）——署错名的结论会污染复核经过与零分歧判定。`,
        {
          requireAuthority: 'Lead',
          howToChange: '由复核者本人调 task_review（复核者参数可省略，恒取真实主体）；Lead 要独立验收就自己签自己，不占别人的名。',
        },
      );
    }
    // （v2 · 2026-10-18：复核员保持 {kind:'成员', roleId:'复核员'} 顺流到 handler，
    // 只读/禁写边界在策略引擎按 roleId 判；成员复核员还需真实复核任务关联——
    // 那条证据闸在服务层 tasks.review，与冲突排除同一判定面。）
    const 记录 = await org.review.record({
      subject,
      项目,
      节点: args.id,
      三态: args.三态,
      分歧清单: args.分歧清单,
      反例面: args.反例面,
      复核者: subject.id,
    });
    // 补修K（条目4）：复核只出**可引用票**，不代 Lead 采纳——回执必须给出真票与下一步。
    // 指路不能只活在内部字段里：模型/人读的是这段文字，不是去翻事件流找 seq。
    // 任务图缺席 = 纯协议夹具（只验归属解析，不接任务图）⇒ 不造票、也不假装知道节点状态。
    const 节点 = typeof org.tasks?.get === 'function' ? await org.tasks.get(args.id, { 项目 }) : null;
    const 待采纳 = 节点?.待采纳 ?? null;
    const 票 = 待采纳?.票 ?? 节点?.复核经过?.at(-1)?.票 ?? null;
    return {
      结论: {
        ...记录,
        票,
        节点状态: 节点?.状态 ?? null,
        ...(待采纳 ? { 待采纳 } : {}),
        下一步: 待采纳
          ? `由 Lead 执行 task_accept（id=${args.id} 票=${待采纳.票}）；复核结论不自动采纳。`
          : 记录.三态 === '过'
            ? `票 ${票 ?? '（缺）'} 已出但不满足采纳条件（节点状态 ${节点?.状态 ?? '未知'}）：先看工作台/账本，别拿旧票硬采纳。`
            : '未通过或未验：不得采纳——按节点状态走返工/补材料。',
      },
    };
  },

  /**
   * 正式采纳（补修K · 条目4「采纳权在 Lead」）：闸在服务层 `tasks.accept`（仅 Lead/主权者 +
   * 票/免审/历史确认三路验证 + 锁内复判），这里只透传 + 指路。
   */
  async task_accept({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('task_accept 需要 id（要采纳的任务节点）', { missing: ['id'] });
    const 节点 = await org.tasks.accept(args.id, { subject, 项目, 票: args.票, 依据: args.依据, 验证: args.验证 });
    return {
      节点,
      采纳: 节点.采纳 ?? null,
      说明: `已采纳（依据：${节点.采纳?.依据 ?? '未知'}${节点.采纳?.票 ? `，引用票 ${节点.采纳.票}` : ''}）：采纳由 Lead 显式执行，复核结论本身不代采纳。`,
    };
  },

  /**
   * Lead 记录不同意（补修K）：只追加异议记录，不触碰复核三态与冻结判据。
   * 授权与「只增」边界都在 `review.recordDisagreement`（单一实现），这里只补动作面入口。
   */
  async task_disagree({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('task_disagree 需要 id（任务节点）', { missing: ['id'] });
    const 理由 = String(args.理由 ?? args.依据 ?? '').trim();
    if (!理由) throw new InvalidBody('task_disagree 需要「理由」：记录的是「不同意什么」，空理由等于没记。', { missing: ['理由'] });
    const 记录 = await org.review.recordDisagreement({ subject, 项目, 节点: args.id, 理由 });
    return { ...记录, 说明: '不同意已入审计（只追加）；复核三态与冻结判据未改动。' };
  },

  /**
   * 受管冻结判据只读入口（复核汇总后续顺序① · 2026-10-16）：被指派复核者 / 节点负责人 /
   * Lead / 主权者可经机制读到目标节点的**冻结判据原文与指派事实**——替代第9/10代复核员
   * 实踩的「workbench 角色切片看不到 ⇒ policy_check 拿 allow ⇒ 手读 tasks.jsonl 原始账本」
   * 绕路（判据真源被迫拿文件系统当读面，还要求复核员懂账本行格式）。
   *
   * 闸两层，各司其职（与 拒讨论线程直灌 / 盲评遮罩 同款「事实在哪、闸就跟到哪」）：
   *  - handler 侧「在办主体」判定：负责人 / Lead / 主权者放行；**复核员岗按岗位名放行**
   *    （v2 · 2026-10-18 读面放宽：复核员是 Lead 按任务起的只读实例，判据/审计/交付物
   *    是它干活的全部输入；写面仍由策略引擎按 roleId 全拒）；
   *  - 策略引擎 read：只增对象可读的既有判定照走，不在此复制规则。
   *
   * 默认输出是**白名单投影**：只给复核对口径所需的最小字段集。绝不携带 独立答案 / 结论 /
   * 讨论 / 复核经过——他人未揭名答案不因「复核需要」从这里泄露（盲评边界不在此开口；
   * 复核员要看全量用 workbench，那里有按角色的既有切片语义）。
   * 显式 原记录=true 另走逐任务/提交/票的只读分页；仅Lead、人侧及当前凭证匹配的
   * 关联复核员可用，历史盲评任务仍拒绝，不把预览当全文。
   */
  async task_criteria({ org, 项目, subject, args }) {
    if (args.原记录 === true) return readTaskRecords({ org, 项目, subject, args });
    if (args.原记录 !== undefined && args.原记录 !== false) throw new InvalidBody('原记录必须为布尔值。');
    const id = String(args.id ?? '').trim();
    if (!id) throw new InvalidBody('task_criteria 需要 id（要读冻结判据的任务节点）', { missing: ['id'] });
    const 节点 = await org.tasks.get(id, { 项目 });
    if (!节点) throw new InvalidBody(`没有这个任务节点：${id}（项目 ${项目}）`);
    const 是负责人 = 负责人实例名单(节点).includes(subject.id);
    const 域 = await 复核读域For({ org, 项目, subject });
    const 是关联复核员 = 域?.限定 === true && 在读域(域, 节点.id);
    if (!是负责人 && !是关联复核员 && !['Lead', '主权者'].includes(subject.kind)) {
      throw new Denied(
        '冻结判据只读入口 · 仅限在办主体（负责人 / 本任务复核对象内的复核员）',
        `你（${subject.id}，${subject.kind}${subject.roleId ? `/${subject.roleId}` : ''}）不是节点 ${id} 的负责人，也不在本任务复核读域内：` +
          `${域?.限定 ? 域.说明 : '复核员岗按「已绑定复核任务→显式复核对象」限定读域'}——冻结判据是给在办主体核对验收口径用的，未关联任务读他人判据没有业务需要。`,
        {
          howToChange: '复核员由 Lead 按任务 member_spawn 起实例，并把本节点写进该复核任务的 `复核对象`；负责人与 Lead 天然可读；看任务概况用 workbench 自己那片。',
          detail: { 节点: id, 主体: subject.id, kind: subject.kind, roleId: subject.roleId ?? null, 复核读域: 域?.限定 ? { 复核任务: 域.复核任务, 复核对象: 域.复核对象 } : null },
        },
      );
    }
    await org.policy.check({
      subject,
      action: 'read',
      target: { id: 节点.id, kind: '任务', authority: '只增', zone: '私有', project: 项目 },
      context: {},
    });
    return {
      节点: {
        id: 节点.id,
        状态: 节点.状态,
        代: 节点.代 ?? 1,
        描述: 节点.描述,
        判据: 节点.判据,
        ...(节点.工具文件范围 ? { 工具文件范围: 节点.工具文件范围 } : {}),
        判据冻结: 节点.判据冻结,
        依赖: 节点.依赖,
        // v2 条目18：新节点不再有「模式」空壳；历史事件有值才透出（只读保留）。
        ...(节点.模式 != null ? { 模式: 节点.模式 } : {}),
        // v2 条目6：复核任务是「验哪一单」在这里可核对（目标节点 id 列表）。
        ...(Array.isArray(节点.复核对象) && 节点.复核对象.length > 0 ? { 复核对象: 节点.复核对象 } : {}),
        负责人: 节点.负责人,
        打回次数: 节点.打回次数,
        创建于: 节点.创建于,
        派发于: 节点.派发于,
        交卷: 节点.交卷 ? { 已交: 节点.交卷.已交, 应交: 节点.交卷.应交, 齐: 节点.交卷.齐 } : null,
        复核豁免: 节点.复核豁免 ?? null,
        复核指派: 节点.复核指派 ?? null,
      },
      说明: '冻结判据只读投影：不含成员结论/未揭名答案/讨论/复核经过。判据核对以本投影为准，不需要手读任务图账本。',
    };
  },

  async task_pending({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.markPending(args.id, { subject, 项目, 原因: args.原因, 待决类型: args.待决类型 }) };
  },

  async task_resolve({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.resolvePending(args.id, { subject, 项目, 决定: args.决定 }) };
  },

  /**
   * 结账（W3 批3）：环路最后一步。前置 = 已采纳（任务图的状态机守着），
   * 权限仅 Lead（策略引擎的 `settle` 动作守着），效果 = 归档该项目作答 + 落终态「已结账」。
   */
  async task_settle({ org, 项目, subject, args }) {
    // v2 条目16：结账必须带「记忆处置」声明（无候选就传空对象 {} 明示）——缺了由
    // 服务层拒收并在 detail 里给出候选清单。处置里的「晋升」会真实产出知识条目
    // （补修E）：产出 id 折回节点 `记忆晋升`；任一步失败则不结账（不留假结账）。
    const 节点 = await org.tasks.settle(args.id, { subject, 项目, 记忆处置: args.记忆处置 });
    const 晋升条数 = Object.keys(节点.记忆晋升 ?? {}).length;
    return {
      节点,
      说明: `已结账（归档作答 ${节点.归档条数 ?? 0} 条${晋升条数 > 0 ? `；晋升知识 ${晋升条数} 条，id 见节点.记忆晋升` : ''}）：环路走到头了，后续只能追加更正，不能复活。`,
    };
  },

  /**
   * 复核豁免登记（v2 口述收敛 2026-10-18 条目5）：授权闸在服务层（exemptReview
   * 读部署设置「复核免审」开关），这里只透传 + 指路。
   */
  async review_exempt({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('review_exempt 需要 id（任务节点）', { missing: ['id'] });
    const 节点 = await org.tasks.exemptReview(args.id, { subject, 项目, 原因: args.原因 });
    return { 节点, 说明: '复核豁免已登记（动作进事件流与审计）。「哪些产出没被复核」由节点复核豁免字段统计。' };
  },

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

  async project_brief_query({ org, 项目, 会话项目, subject, args, 宿主 }) {
    const session = 宿主?.agent?.session;
    if (!session || session.id !== subject.id || 项目 !== 会话项目 || 宿主.project !== 会话项目) {
      throw new Denied('项目接续 · 宿主范围', '只允许当前真实Lead读取本项目工作摘要。');
    }
    const 摘要 = await org.projectBrief.read({ subject, project: 项目, session: session.id }, { id: args.id });
    if (宿主.agent.session !== session || 宿主.project !== 会话项目) throw new Denied('项目接续 · 会话变化', '会话变化，丢弃旧摘要。');
    return { 摘要, 整理: org.projectBriefHooks?.health() ?? null, 协作记忆: org.continuityCaptureHooks?.health() ?? null,
      核心人设保护: org.personaProtection?.health() ?? null };
  },

  async project_brief_forget({ org, 项目, 会话项目, subject, 宿主 }) {
    const session = 宿主?.agent?.session;
    if (!session || session.id !== subject.id || 项目 !== 会话项目 || 宿主.project !== 会话项目) {
      throw new Denied('项目接续 · 宿主范围', '请在当前真实会话清空本项目摘要。');
    }
    await org.turnBufferHooks?.sync(session);
    const 结果 = await org.projectBrief.forget({ subject, project: 项目, session: session.id });
    return { 结果, 说明: '已清空本项目工作摘要并保留处理屏障；旧来源不自动重提炼，宿主对话、轮缓冲和正式长期记忆分别管理。' };
  },

  async memory_write({ org, 项目, 会话项目, subject, args }) {
    if (!MEMORY_KINDS.includes(args.类)) throw new InvalidBody(`记忆只有四类：${MEMORY_KINDS.join(' / ')}`);
    // 不许替调用方编一个来源：§7 要求「写入必带谁记的 + 怎么知道的」，
    // 缺了就拒写（写入侧义务），而不是填个「未说明」让它过关。
    const 来源 = args.来源 ?? (args.依据 ? args.依据 : null);
    if (!来源) throw new InvalidBody('memory_write 需要「来源」：这条你是怎么知道的？', { missing: ['来源'] });
    // v2 条目22 · 公共命名空间（补修E）：『通用』是**存储命名空间**，不是另一个真实项目——
    // 执行项目仍是会话项目，跨项目总闸（runAction 单点）一字不动；命名空间只决定落在哪本账。
    // 这样「通用」不用在成员跨项目闸上开例外，也没把执行项目改写成项目键。
    const 命名空间 = typeof args.命名空间 === 'string' && args.命名空间.trim() ? args.命名空间.trim() : null;
    if (命名空间 !== null && 命名空间 !== '通用') {
      throw new InvalidBody(`未知命名空间：${命名空间}。目前只有「通用」= 项目无关知识的公共命名空间（它不是项目，不参与项目隔离）。`, { detail: { 命名空间 } });
    }
    if (命名空间 && args.类 !== '知识') {
      throw new InvalidBody('「通用」命名空间只收知识：经历属组织账本、偏好属部署账本、作答属实例任务—它们不进公共命名空间。', { detail: { 类: args.类 } });
    }
    // v2 条目22 跨项目写：成员在 runAction 单点已被拦；Lead 可显式传 project 写别的
    // 项目，但「合理」要落在依据上——依据必填，且随条目与审计留痕（事后可判）。
    const 跨项目 = typeof args.project === 'string' && args.project.trim() && args.project.trim() !== 会话项目;
    if (跨项目 && subject.kind === 'Lead' && !(typeof args.依据 === 'string' && args.依据.trim())) {
      throw new InvalidBody('跨项目写记忆必须带「依据」：跨项目的「合理」落在依据上（v2 条目22），事后靠它可判。', { missing: ['依据'] });
    }
    // 公共命名空间不是项目的默认住所：Lead 往里放东西同样要把「凭什么公开」落在依据上。
    if (命名空间 === '通用' && subject.kind === 'Lead' && !(typeof args.依据 === 'string' && args.依据.trim())) {
      throw new InvalidBody('写「通用」公共命名空间必须带「依据」：项目无关知识的「合理」落在依据上（v2 条目22），事后靠它可判。', { missing: ['依据'] });
    }
    const 写入项目 = 命名空间 ?? 项目;
    const 来源引用 = Array.isArray(args.来源引用)
      ? args.来源引用.map((v) => String(v).trim()).filter(Boolean)
      : (args.来源引用 === undefined || args.来源引用 === null ? [] : String(args.来源引用).split(/[,，]/).map((s) => s.trim()).filter(Boolean));

    // 成员写知识 = 受限晋升（v2 条目15/16 · 补修E）：唯一入口是记忆服务的 promoteFromAdopted
    // （真实登记记忆整理岗 + 同项目已采纳来源 + 双标签 + 绑定执行中任务，全部在服务层判）。
    // 普通成员在这里连「直接写」的门都够不着——只能走交卷的知识候选。
    // 复核员不在这里拦：它没有知识写入通道，也不能走受限晋升——直接落到服务层/策略引擎的
    // 「复核员岗 · 只读数，不改」闸上，拒绝理由才归到它真正的岗位边界（不在半路换成「缺晋升参数」）。
    if (subject.kind === '成员' && args.类 === '知识') {
      const 任务 = await 取任务上下文({ org, 项目, args });
      if (!任务) {
        throw new InvalidBody('记忆整理岗晋升知识必须带「任务」：晋升要在你被绑定的执行中任务内（任务内全权、任务外无）。', { missing: ['任务'] });
      }
      const 任务引用 = 来源引用.filter((ref) => ref.startsWith('task-'));
      if (任务引用.length !== 1) {
        throw new InvalidBody(`受限晋升的「来源引用」必须恰好包含 1 个 task- 任务节点（已采纳来源），收到 ${任务引用.length} 个。`, { detail: { 来源引用 } });
      }
      // 候选键 = 同一来源（非任务引用）的蒸馏身份：重试同输入 ⇒ 幂等命中、不重复产知识；
      // 同一来源换了岗位/内容 ⇒ 幂等键冲突被拒（别拿旧产物冒充本次内容）。
      const 候选键 = `refs:${来源引用.filter((ref) => !ref.startsWith('task-')).sort().join(',') || 任务引用[0]}:${args.岗位 ?? ''}`;
      return {
        条目: await org.memory.promoteFromAdopted({
          subject,
          项目: 写入项目,
          岗位: args.岗位,
          内容: args.内容,
          来源,
          来源引用,
          依据: args.依据,
          标签: args.标签,
          ...(Object.hasOwn(args, '知识说明') ? { 知识说明: args.知识说明 } : {}),
          任务,
          晋升: { 来源任务: 任务引用[0], 候选键, 执行任务: 任务.id },
        }),
      };
    }

    return {
      条目: await org.memory[subject.kind === 'Lead' && (args.类 === '偏好' || ['经历', '知识'].includes(args.类) && (!args.岗位 || args.岗位 === 'Lead') && !args.任务 && !来源引用.some(ref => ref.startsWith('task-'))) ? 'rememberPersonal' : 'remember']({
        subject,
        类: args.类,
        内容: args.内容,
        来源,
        项目: 写入项目,
        岗位: args.岗位,
        标签: args.标签,
        ...(Object.hasOwn(args, '知识说明') ? { 知识说明: args.知识说明 } : {}),
        ...(Object.hasOwn(args, '连续性') ? { 连续性: args.连续性 } : {}),
        ...(Object.hasOwn(args, '协作反馈') ? { 协作反馈: args.协作反馈 } : {}),
        依据: 跨项目 || 命名空间 ? args.依据 : undefined,
        // 披露豁免只在「通用」直写有意义（v2 条目22：通用与跨项目晋升同一把披露闸）。
        披露豁免: args.披露豁免 === true,
        // 契约A：来源引用（证据/来源对象 id 列表）——服务层做存在性校验，悬空即拒。
        来源引用,
        // 任务上下文透传（2026-10-12 接口缺口修复）：成员的「任务内全权」由策略引擎
        // scopeOf 按节点负责人名单判定——这里只把调用方声明的节点**从任务图取出**交给
        // 唯一判定点；自报不算数（传别人的节点照拒），取不到 = 响亮拒，不编一个。
        任务: await 取任务上下文({ org, 项目, args }),
      }),
    };
  },

  async memory_query({ org, 项目, subject, args }) {
    // 契约B（2026-10-09）：查询也过唯一判定点。subject 来自 runAction 的主体链
    // （B3：成员/复核者必须与身份档案一致，不许 role 自报即真），不是 args 里另开的自报字段。
    // v2 条目22 读面：成员的跨项目读在 runAction 单点已拦；Lead/主权者跨项目读放行
    // （这里收到的 项目 已是目标项目，runAction 按 args.project 换过）。
    // v2 条目4/6（复核读域）：复核员岗的检索面按「已绑定复核任务→显式复核对象」限定，
    // 读域由本动作按**同一项目**现算，不凭会话 cwd、也不跨项目账本猜。
    const 域 = await 复核读域For({ org, 项目, subject });
    return {
      结果: await org.memory.query({
        subject, 类: args.类, 项目, 岗位: args.岗位, 文本: args.文本,
        显式: args.显式, 含失效: args.含失效, 读者: subject, 读域: 域,
        ...(Object.hasOwn(args, '含待复验') ? { 含待复验: args.含待复验 } : {}),
        id: args.id, 返回模式: args.返回模式 ?? '摘要', 内容预算: args.内容预算,
        偏移: args.偏移, 正文偏移: args.正文偏移, 数据版本: args.数据版本,
        limit: args.limit, 条数上限: args.条数上限,
      }),
    };
  },

  /**
   * 契约A（2026-10-09）·血缘查询：这条记忆的上下游（引用 + 推翻替换链），闭包 ≤3 层。
   * 读面与契约B 同款：subject 过判定，放行记一条「只读服务调用」汇总审计。
   */
  async memory_lineage({ org, subject, args }) {
    if (!args.id) throw new InvalidBody('memory_lineage 需要 id（要查血缘的记忆条目）', { missing: ['id'] });
    return { 血缘: await org.memory.lineage({ subject, id: args.id }) };
  },

  async memory_organize({ org, 项目, subject, args }) {
    const allowed = ['action','project','role','op','id','ids','内容','原因','类'];
    if (Object.keys(args).some(key => !allowed.includes(key))) throw new InvalidBody('记忆整理含未知字段。');
    return { 整理: await org.memory.organize({subject,项目,op:args.op,id:args.id,ids:args.ids,内容:args.内容,原因:args.原因,类:args.类}) };
  },
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

  async capability_list({ org, subject, args }) {
    const 能力 = await org.capability.list({ subject, 岗位: args.岗位, 来源: args.来源 });
    // 剥本机绝对路径（2026-10-14 审查 P2-17）：与 workbench 投影「path 不许带出」同口径——
    // 服务层内部可用 path，回给模型面的读数不许带（部署目录结构不外泄，同 errors.js 脱路径）。
    return { 能力: 能力.map(({ path: _p, ...rest }) => rest) };
  },

  async capability_resolve({ org, subject, args }) {
    // 契约B（2026-10-09）：解析也过唯一判定点（主体来自 runAction 的主体链）。
    const 解析 = await org.capability.resolve({ subject, 名: args.名 });
    return { 解析: { ...解析, 条目: (解析.条目 ?? []).map(({ path: _p, ...rest }) => rest) } };
  },

  async capability_read({ org, subject, args }) {
    // 缺 id 先响亮指路（2026-10-11 跑通测试 P3）：否则报「能力库里没有 undefined」，
    // 把人引向「库里缺条目」的错方向——按 schema 的 名 参数传参就会走到这。
    if (!args.id) throw new InvalidBody('capability_read 需要 id（能力名）；名 只用于 capability_resolve', { missing: ['id'] });
    const 条目 = await org.capability.read({ subject, id: args.id, 来源: args.来源 });
    if (!条目) throw new InvalidBody(`能力库里没有 ${args.id}`);
    const { path: _p, ...剥路径 } = 条目; // 同 capability_list：本机路径不出模型面
    return { 条目: 剥路径 };
  },

  async capability_publish({ org, 项目, subject, args }) {
    // 任务上下文透传（task-修复-lib-actions-j-649a4 · 判据①）：成员在任务内产出能力卡
    // 是「交卷」性质的写入，store.write 的策略判定需要 task 凭据（spec.task），否则被判
    // 「任务外无」拒（本会话实测：记忆整理岗落卡被拒，被迫 Lead 代发，审计 seq281）。
    // 取数走唯一取数点：自报 id 不承重，scopeOf 仍按节点负责人名单判定。
    return { 能力: await org.capability.publish({ subject, 名: args.名, 正文: args.正文, 适用岗位: args.适用岗位, 依据: args.依据 ?? '组织自治', 任务: await 取任务上下文({ org, 项目, args }) }) };
  },

  async bus_send({ org, 项目, subject, args }) {
    if (!args.线程) throw new InvalidBody('bus_send 需要 线程');
    // ①甲（2026-10-10 独立复核实证）+ 批c 补漏 P2/P3（2026-10-10 复核攻破）：
    // 动作面不许往**会审讨论线程**直灌消息。判据**只有一处实现** —— `拒讨论线程直灌`（文件末）；
    // 往旧独立会审线程的写另由服务层 `bus.send` 的墓碑守卫恒拒（模型面已无第二只写入口）。
    await 拒讨论线程直灌({ org, 项目, 线程: args.线程, 入口: 'bus_send' });
    // ㉖（2026-10-10 收口）：任务线程只许**负责人与 Lead** 直灌 —— 权限矩阵写的是
    // 「任何在岗主体写**自己**线程的消息」，而这半格在策略 target 里原本不存在（见函数注释）。
    await 拒他人任务线程({ org, 项目, 线程: args.线程, 主体: subject });
    return {
      消息: await org.bus.send({
        subject,
        项目,
        线程: args.线程,
        // W2 安全修复（2026-10-09）：发件人不许自报——「发件」冒充别人（如 'system'）
        // 是伪造轮边界/伪装机制消息的第一步。动作面恒以**主体链的真实 id** 为发件人；
        // `args.发件` 一律忽略（schema 描述已注明）。服务面的 发件 参数是内部编排用的
        // （unlock 广播 / debate 轮边界 / converge 末位表态），不在模型可达面上。
        发件: subject.id,
        收件: args.收件 ?? [],
        类型: args.类型,
        内容: args.内容,
        暂不投递: args.暂不投递,
        延后: args.延后,
        引用: args.引用,
      }),
    };
  },

  async bus_read({ org, 项目, subject, args }) {
    if (!args.线程) throw new InvalidBody('bus_read 需要 线程');
    // v2 条目4/6（复核读域单点）：复核员岗只能读读域内节点的线程（复核任务 + 显式复核对象）。
    // 这是**原文出口**——不能只遮工作台的总线投影：bus_read 拿的是消息正文与发件人，
    // 漏了这里等于「面板遮了、另一个出口照给」。同一把尺在 workbench 总线行/审查行上复用。
    const 域 = await 复核读域For({ org, 项目, subject });
    if (域?.限定 === true && !线程在读域(args.线程, 域)) {
      throw new Denied(
        '复核读域 · 线程不在本任务读域内（v2 条目4/6）',
        `线程 ${args.线程} 不在复核实例 ${subject.id} 的读域里（${域.说明}）：复核员的读面只到本次被复核任务，` +
          '未关联任务的对话不是它的读域（也不能凭 roleId=复核员 全量读）。',
        {
          howToChange: '只读复核对象/复核任务自己的线程；要看别处请 Lead 把目标写进复核任务的 `复核对象`，或由 Lead 转述。',
          detail: { 线程: args.线程, 复核任务: 域.复核任务, 复核对象: 域.复核对象 },
        },
      );
    }
    // 契约B（2026-10-09）：线程读取也过唯一判定点（主体来自 runAction 的主体链）。
    const 消息 = await org.bus.read({ subject, 项目, 线程: args.线程, 收件: args.收件, 未投递: args.未投递, limit: args.limit });
    // 盲评遮罩（2026-10-12 评审 P2-6）：未交齐的独立会审线程，成员读不到他人的发件与内容——
    // 与 workbench 投影层同一条 §10 规矩，不能只遮投影而放行总线。
    return { 消息: await 盲评遮罩({ org, 项目, 线程: args.线程, 读者: subject, 消息 }) };
  },

  /**
   * 把一条「暂不投递」的消息放出去（2026-10-14 审查 P1-4：断头路接线）。
   * 服务层 bus.deliver 过与 send 同一道闸（create + 写入目标），这里只做入口校验。
   */
  async bus_deliver({ org, 项目, subject, args }) {
    if (!args.线程) throw new InvalidBody('bus_deliver 需要 线程', { missing: ['线程'] });
    if (!args.id) throw new InvalidBody('bus_deliver 需要 id（要投递的消息 id）。', { missing: ['id'] });
    return { 投递: await org.bus.deliver({ subject, 项目, 线程: args.线程, id: args.id }) };
  },

  // ── v2（条目18 补修 · 2026-10-18）：`bus_unlock` 已退役 ──────────────────────
  // 会审退出任务图后，「全员已交后亮出彼此答案」只属于会话绑定的新会审（debate_unlock /
  // src/council.js，自己的 councils.jsonl 存档）。旧的独立会审节点是**只读历史**：
  // 模型面不再有这只往旧线程落「system 广播」的手，服务层 bus.unlock 也只留墓碑守卫
  // （对旧节点恒拒）。历史账本一字不动，fold 照旧可读。

  // ── v2 会审（口述收敛 2026-10-18 条目18/19）：会话绑定的独立动作面 ──────────
  // 发起/作答/解锁/可选讨论（换轮+发言）/收敛——全部落在 CouncilService（自己的
  // 事件流存档），不再挂任务节点。旧任务图讨论段只读留档。

  async debate_open({ org, 项目, subject, args, 宿主 }) {
    const 问题 = String(args.问题 ?? args.描述 ?? '').trim();
    if (!问题) throw new InvalidBody('debate_open 需要「问题」（会审要收敛的对象）；参与者用「参与者」或「参与岗位」参数点名。', { missing: ['问题'] });
    const 参与者 = 参数列表(args.参与者);
    const 参与岗位 = 岗位清单(args.参与岗位);
    if (参与者.length === 0 && 参与岗位.length === 0) {
      throw new InvalidBody('debate_open 需要「参与者」（已登记实例）或「参与岗位」（受管创建 N 个咨询实例）。', { missing: ['参与者', '参与岗位'] });
    }
    // 旧路径：全是已登记实例，不需要宿主适配器，行为不变。
    if (参与岗位.length === 0) {
      return { 会审: await org.council.open({ subject, 项目, 问题, 参与者 }) };
    }
    if (!['Lead', '主权者'].includes(subject?.kind)) {
      throw new Denied('会审 · 受管创建仅 Lead/主权者', `${subject?.kind ?? '未知'} 不得创建会审参与实例：这是派活面，不是咨询作答。`, { requireAuthority: 'Lead', howToChange: '由 Lead（根会话）发起；成员只作答/讨论。' });
    }
    const 方式 = args.方式 === undefined || args.方式 === null || String(args.方式).trim() === '' ? 'subagent' : String(args.方式).trim();
    if (!['team', 'subagent'].includes(方式)) throw new InvalidBody('方式 必须是 team 或 subagent。', { missing: ['方式'] });
    const 授权 = 要求授权({ 宿主, subject, 项目 });
    const agent = 宿主?.agent;
    if (!agent) throw new Fault('MEMBER_SPAWN_NO_AGENT', '宿主没有传真实 Agent：会审受管创建只能从工具/命令面调用。');
    const { 模型路由, 模型供应商, 模型, 推理档 } = 解析模型路由(args, 方式);
    断言成员宿主就绪(宿主, 方式, true);
    const 资料 = 参数列表(args.资料);
    // 审批档护栏：完整宏计划（create 会审 + N 身份）没摊出来就拒绝，避免只批第一笔后卡 N 次登记。
    await 断言会审计计划完整({ org, subject, 项目, 动作: 'debate_open', args });

    const 退役实例 = 会审退役适配器({ org, subject, 宿主, 方式 });
    let 序号 = 0;
    const 创建参与者 = async ({ 会审, 项目: 跑项目, 问题: 跑问题, 资料: 跑资料, 岗位, 来源会话, 复判 }) => {
      序号 += 1;
      const 名 = 规范成员名(`会审-${岗位}`, `${Date.now().toString(36).slice(-4)}${序号}`);
      const 待命书 = [
        `你是数字组织会审参与实例（会审 ${会审}，项目 ${跑项目}），现在处于启动自检阶段。`,
        '第一步：调用 mind action=status 确认主体；实例尚未登记时被拒是预期行为，至多重试一次，并记住拒绝里报出的真实实例 id。',
        '第二步：不要开始任何业务工作。回一句启动确认即结束本轮，等待 Lead 的会审任务书。',
      ].join('\n');
      const 创建前 = (await org.registry.identity()).members ?? {};
      if (typeof 复判 !== 'function') throw new Fault('COUNCIL_PLAN_UNAVAILABLE', '领域会审计划未提供当前资格复判，不能创建。');
      const 准备 = prepareExecution({ host: 宿主, mode: 方式, name: 名, description: `会审参与·${岗位}·${会审}`, standby: 待命书, modelRoute: 模型路由,
        beforeDispatch: async () => {
          if (要求授权({ 宿主, subject, 项目 }).fingerprint !== 授权.fingerprint) throw new Denied('会审 · 调度配置变化', '准备后的调度配置已变化，旧计划不能继续。');
          await 复判();
        } });
      await org.council.recordCreationIntent({ subject, 项目: 跑项目, 会审, 方式, 岗位, 序号, 宿主调用: 准备.hostCall });
      const 执行体 = await 准备.execute();
      // A return observation is not registration or delivery. If recording fails,
      // retain the intent and fail without business work or an unverified retry.
      await org.council.recordCreationReturn({ 项目: 跑项目, 会审, 宿主调用id: 准备.hostCall.调用id,
        实例: 执行体.实例, 团队名: 执行体.团队名 });
      if (Object.hasOwn(创建前, 执行体.实例) || Object.hasOwn((await org.registry.identity()).members ?? {}, 执行体.实例)) {
        throw new Fault('COUNCIL_CREATE_DUPLICATE_ID', `宿主返回已有身份 ${执行体.实例}：不改绑、不封存、不停用预给或别场实例。`);
      }
      const 停 = () => 停执行体({ org, subject, 宿主, 方式, agent: 执行体.agent, 实例: 执行体.实例, 团队名: 执行体.团队名, 名, 响亮: true });
      const 确认首登 = async () => {
        const 成员 = (await org.registry.identity()).members?.[执行体.实例];
        const 绑定 = 成员?.会审绑定;
        if (绑定?.会审 !== 会审 || 绑定?.来源会话 !== subject.id || 绑定?.项目 !== 跑项目) return false;
        记录本次新建(subject, { kind: '身份', id: 执行体.实例 });
        return true;
      };
      const 失败补偿 = async () => {
        const 错误 = [];
        let 已首登 = false;
        try { 已首登 = await 确认首登(); } catch (error) { 错误.push(`归属确认失败：${错误信息(error)}`); }
        if (已首登) return 退役实例({ 实例: 执行体.实例, 会审, 原因: '会审登记/钉版/审计失败补偿（本请求 owned）' });
        try { await 停(); } catch (error) { 错误.push(`停机失败：${错误信息(error)}`); }
        if (错误.length) throw new Fault('COUNCIL_RETIRE_FAILED', 错误.join('；'));
      };
      const 钉卡 = await 登记钉版({
        org,
        subject,
        岗位,
        实例: 执行体.实例,
        代次: org.boot?.代次,
        方式,
        绑定: { 会审: { id: 会审, 项目: 跑项目, 资料: 跑资料 } },
        停,
        失败补偿,
      });
      try {
        if (!await 确认首登()) throw new Error('新身份落盘绑定与本场/真实来源不符');
        await org.audit.append({
          动作: '成员创建',
          主体: subject,
          对象: { id: 执行体.实例, kind: '身份' },
          依据: '会审受管参与实例（debate_open；不占任务图，绑定=会审+来源会话）',
          结果: `已登记（${方式}${模型路由 ? `；路由 ${模型供应商}/${模型}${推理档 ? `@${推理档}` : ''}` : ''}）`,
          详情: { 方式, 岗位, 会审, 来源会话, 模型路由: 模型路由 ?? null, 授权指纹: 授权.fingerprint },
        });
      } catch (error) {
        let 补偿失败 = null;
        let 补偿回执 = null, 补偿错误 = null;
        try { 补偿回执 = await 失败补偿(); } catch (失败) { 补偿错误 = 失败; 补偿失败 = 错误信息(失败); }
        throw new Fault('AUDIT_APPEND_FAILED_AFTER_EVENT', `会审参与实例 ${执行体.实例} 已登记，但「成员创建」审计追加失败：${错误信息(error)}。已尝试停用/封存。`, {
          detail: { 阶段: 'audit', 实例: 执行体.实例, 会审, 原因: 错误信息(error), 补偿失败 }, 
          outcome: { 提交状态: '部分提交', 可重试: false,
            恢复指引: '该实例已登记，核对本场绑定、创建审计及逐实例补偿回执；封存和驻留释放不删除持久子会话，不要重放 debate_open。',
            已确认阶段: [{ 阶段: '会审实例登记及钉卡完成', 项目: 跑项目, 会审, 实例: 执行体.实例 },
              ...宿主清理凭据(补偿回执, { 项目: 跑项目, 会审, 实例: 执行体.实例 }), ...(补偿错误?.outcome?.已确认阶段 ?? [])] },
        });
      }
      return { 实例: 执行体.实例, 钉卡 };
    };

    const 发开场书 = async ({ 会审, 问题: 跑问题, 资料: 跑资料, 来源会话, 实例, 岗位, 钉卡 }) => {
      if (要求授权({ 宿主, subject, 项目 }).fingerprint !== 授权.fingerprint) throw new Denied('会审 · 调度配置变化', '创建后的调度配置已变化，不能继续旧计划的开场投递。');
      const 规 = 拼钉卡规程(钉卡);
      const 团队名 = 方式 === 'team' ? (查Team名(宿主, agent, 实例)?.name ?? null) : null;
      if (方式 === 'team' && !团队名) {
        throw new Fault('COUNCIL_TEAM_NAME_MISSING', `Team 会审参与实例 ${实例} 不在名册：不猜名发任务书。`, { detail: { 实例, 岗位 } });
      }
      const 内容 = [
        `你被选为会审参与实例（会审 ${会审}，项目 ${项目}，来源会话 ${来源会话}）。`,
        `问题：${跑问题}`,
        ...(跑资料.length > 0
          ? [`资料（唯一只读根，仅可读这些绝对路径）：${跑资料.join('、')}`]
          : ['本次没有提供文件资料：不要自行读工作区或私有账本。']),
        `实例钉住的岗位卡版本：${规.摘要 || '未钉'}；以下规程只来自钉住快照，不是现行卡：`,
        ...(规.钉L0 ? [`岗位身份（个体L0 · 已钉版）：${规.钉L0}`] : []),
        ...(规.钉L1 ? [`岗位规则（个体L1 · 已钉版）：${规.钉L1}`] : []),
        `能力引用（只引用，不内嵌正文）：${规.钉能力 || '（无）'}`,
        '只咨询、不干活：你只能作答/讨论本场会审；不得改文件、不得再派活、不得写记忆/任务。工具面与动作面已收紧。',
        `作答：mind action=debate_answer id='${会审}' 结论='...' 结论层='...'（反例面可选）。`,
        '独立作答后结束本轮；不要主动看别人的答案。等 Lead 解锁后如开启讨论，再 debate_say。',
        '如遇故障，只可向派发你的 Lead 报告（send_message 仅此收件人），不得联系其他成员。',
      ].join('\n');
      return 发成员书({ 宿主, 方式, agent, 实例, 团队名, signal: 中止信号(宿主), 内容 });
    };

    return {
      会审: await org.council.open({
        subject,
        项目,
        问题,
        参与者,
        参与岗位,
        资料,
        创建参与者,
        发开场书,
        退役实例,
        模型路由,
      }),
    };
  },

  async debate_answer({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('debate_answer 需要 id（会审 id，debate_open 的返回值）', { missing: ['id'] });
    if (!args.结论) throw new InvalidBody('debate_answer 需要「结论」：你的独立答案。结论层（结构化标签）与反例面可随卷附上。', { missing: ['结论'] });
    return { 作答: await org.council.answer({ subject, 项目, id: args.id, 结论: args.结论, 结论层: args.结论层, 反例面: args.反例面 }) };
  },

  async debate_unlock({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('debate_unlock 需要 id（会审 id）', { missing: ['id'] });
    return { 会审: await org.council.unlock({ subject, 项目, id: args.id }) };
  },

  async debate_say({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('debate_say 需要 id（会审 id）', { missing: ['id'] });
    if (!args.内容) throw new InvalidBody('debate_say 需要 内容', { missing: ['内容'] });
    return { 发言: await org.council.say({ subject, 项目, id: args.id, 类型: args.类型, 内容: args.内容 }) };
  },

  async debate_round({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('debate_round 需要 id（会审 id）。第一次调用 = 显式开启讨论（默认不开）。', { missing: ['id'] });
    return { 讨论: await org.council.round({ subject, 项目, id: args.id }) };
  },

  async debate_converge({ org, 项目, subject, args, 宿主 }) {
    if (!args.id) throw new InvalidBody('debate_converge 需要 id（会审 id）', { missing: ['id'] });
    const 计划 = await org.council.councilPlan({ 项目, 动作: 'debate_converge', args });
    const 需退役 = (计划?.步骤 ?? []).filter((步) => 步.动作 === 'seal').map((步) => 步.目标.id);
    if (需退役.length > 0) await 断言会审计计划完整({ org, subject, 项目, 动作: 'debate_converge', args });
    // 缺少任一真实停机通道就在收敛写入前拒绝，不先定格结论再声称「已停」。
    const 已记方式 = 需退役.length > 0 ? (await org.council.get(项目, args.id))?.创建调用?.[0]?.方式 : undefined;
    const 退役实例 = 需退役.length > 0 ? 会审退役适配器({ org, subject, 宿主, 方式: 已记方式, 实例集: 需退役 }) : null;
    return {
      会审: await org.council.converge({
        subject,
        项目,
        id: args.id,
        内容: args.内容,
        ...(退役实例 ? { 退役实例 } : {}),
      }),
    };
  },

  async audit_tail({ org, 项目, subject, args }) {
    const 条数 = args.limit ?? 审计尾默认条数;
    // v2 条目4/6（复核读域 · 审计面）：审计是**跨项目共享账本**，只看对象 id 会撞车
    // （同 id 出现在别的项目里），所以判据必须带项目（`审计行在读域` 已做同项目校验）。
    // 读者自己的动作行照给（明确规则：复核实例要能看见自己的留痕），其余只给读域内对象。
    const 域 = await 复核读域For({ org, 项目, subject });
    if (域?.限定 === true) {
      const 全量 = await org.audit.read({ grade: args.档位 });
      const 可见 = 全量.filter((row) => 审计行在读域(row, 域));
      return {
        审计: 条数 > 0 ? 可见.slice(-条数) : [],
        复核读域: { 复核任务: 域.复核任务, 复核对象: 域.复核对象, 说明: 域.说明 },
        说明: `审计只增：主权者也不能改，只能追加更正。本视图按复核读域裁剪（同项目 + 对象命中读域 + 本人动作行）：${域.说明}`,
      };
    }
    const rows = await org.audit.read({ grade: args.档位, limit: 条数 });
    // limit=0 是「一条都不要」，不是「slice(-0)=slice(0) 回整组」（2026-10-12 评审 P3）。
    return { 审计: 条数 > 0 ? rows.slice(-条数) : [], 说明: '审计只增：主权者也不能改，只能追加更正。' };
  },

  async audit_verify({ org }) {
    return { 校验: await org.audit.verify() };
  },

  async audit_correct({ org, subject, args }) {
    // 闸控（缺口2a · 2026-10-12）：更正声明能把一处链断裂转为「已确认瑕疵」——
    // 它动的是安全类探针的读数，入口默认拒绝：主体限 Lead / 主权者，
    // 且必须带主权者授权依据（授权引用）。载荷真实性（目标是真瑕疵、hash 现算）
    // 由 audit.appendCorrection 在写入面再守一道——两层各守各的，不互相替。
    if (!['Lead', '主权者'].includes(subject?.kind)) {
      throw new Denied('审计链 · 更正声明入口仅 Lead / 主权者', `更正声明能把链断裂转为「已确认瑕疵」：${subject?.kind ?? '未知'} 没有这个入口。`, {
        requireAuthority: '主权者',
        howToChange: '由 Lead 或主权者携带授权依据执行（授权引用 = 决议 / 任务节点 id）。',
        detail: { 主体: subject?.id ?? null, kind: subject?.kind ?? null },
      });
    }
    return { 结果: await org.audit.appendCorrection({ 主体: subject, 目标: args.id, 理由: args.原因, 授权引用: args.授权引用 }) };
  },

  async store_rollback({ org, subject, args }) {
    // 接线（2026-10-14 审查 P2-20）：store.rollback 的策略闸在写入面（仅主权者，§4），
    // 这里只校验入参完整——闸只有一道（唯一判定点），入口层不叠第二套判据。
    if (!args.对象类 || !args.id || !Number.isInteger(args.version)) {
      throw new InvalidBody('store_rollback 需要 对象类（能力/规则…，注意不是记忆类的 类）、id、version（回滚目标版本号）', { missing: ['对象类', 'id', 'version'] });
    }
    if (!args.依据) throw new InvalidBody('store_rollback 需要 依据（回滚理由，原样进版本指针账）', { missing: ['依据'] });
    return { 回滚: await org.store.rollback(args.对象类, args.id, args.version, { subject, reason: args.依据 }) };
  },

  async registry_list({ org }) {
    const identity = await org.registry.identity();
    const 活动 = await 实例活动索引(org, identity);
    return {
      岗位: await org.registry.list(),
      // 实例读数带「最近活动」面（G3 · 交接件《复核员任命闭环缺口》2026-10-14）：
      // 从审计链现算（不新增存储），与 未登记敲门者 同一条取数口径。
      // 口径（对齐能力卡 no-life-inference-from-permission）：**无活动 ≠ 不在岗**——
      // 在册态照报，活动面另列，不把两种读数糊成一个。
      实例: 实例活动读数(identity, 活动),
      // 报告面（task-机制缺口-10th0 · 裁决③）：被创建但从未登记在岗的主体可被报出。
      // 数据源＝审计链里已有的「身份未登记拦截」（8dt59）——敲过门却被 §12.2 拒的陌生主体，
      // 与身份档案对差集。**残余盲区（如实标注）**：被创建后从未登记且**从未敲过门**的主体
      // （从未调过 mind），账上没有任何痕迹，此处报不出——spawn 在宿主侧，组织侧无从感知。
      未登记敲门者: await 未登记敲门者(org, identity),
      活动读数说明: '最近活动于/活动条数 从审计链现算。判活口径：在册 ≠ 活着，无活动 ≠ 不在岗；已任命而 最近活动于 为 null 的复核员 =「已任命 · 未见活动」，执行体是否就位由主权者拉起会话后以账本活动确认（被拒也是活动证据——死物不会敲门）。',
    };
  },

  async registry_can({ org, args }) {
    if (!args.id) throw new InvalidBody('registry_can 需要 id');
    return { 能力: await org.registry.canTouch({ id: args.id }) };
  },

  async registry_assign({ org, subject, args }) {
    // 授权引用可选透传（v2 · 2026-10-18：复核员岗不再必填）；给了就进登记审计详情。
    return { 实例: await org.registry.assign({ subject, 岗位: args.岗位, 实例: args.实例, 代: args.代, 授权引用: args.授权引用 }) };
  },

  async registry_seal({ org, subject, args }) {
    return { 结果: await org.registry.seal({ subject, 实例: args.实例, 理由: args.原因 ?? '未说明' }) };
  },

  async registry_revoke({ org, subject, args }) {
    return { 结果: await org.registry.revoke({ subject, 对象id: args.id, 理由: args.原因 ?? '未说明' }) };
  },

  async upgrade_pending({ org }) {
    return { 挂起: (await org.upgrade.pending()).filter((p) => !p.已裁决 && !p.已撤回) };
  },

  async review_zero({ org, 项目, subject, args }) {
    // 结论集不再收自报（2026-10-13 审查 P1-8）：修前 Lead 递一份假「反例面」就能压掉报警；
    // 现在必须给节点 id，服务层从任务图独立答案重算（与 workbench 投影同一权威源）。
    if (!args.id) throw new InvalidBody('review_zero 需要 id（任务节点 id）：零分歧检查从任务图独立答案重算，不收自报结论集。', { missing: ['id'] });
    return { 检查: await org.review.checkZeroDivergence({ subject, 项目, 节点: args.id }) };
  },

  async sovereign_interaction({ org }) {
    // 来源必带（设计评审 #7 · 2026-10-15）：markInteraction 的来源白名单闸——本动作是
    // 命令面专属（模型没有这只手），来源如实声明为「presence命令」。
    return { 主权者: await org.registry.markInteraction({ 来源: 'presence命令' }) };
  },

  /**
   * `presence`：失联限制的**人用设置入口**（命令面专属；`mind` 工具 schema 里没有它）。
   *
   * 读：不带参数 ⇒ 只回报当前生效读数（沿用 Batch 1.5 在 `policy.presence()` 里做好的字段）。
   * 写：`/mind presence 开关=否 小时=168` ⇒ 私有 `部署.json`（`Layout.deploymentPrefs()`）。
   *
   * 四条不许让步的性质：
   *  1. **merge 写** —— 只覆盖 `失联限制` / `响应期限小时` 两个键，别的键一个不许丢
   *     （整份 replace 会把主权者写在同一个文件里的 介入度 / 安全类 顺手抹掉；
   *      其中 `安全类` 这一格**在运行态当前没有任何消费者**，所以那条属于「别动别人的东西」，
   *      不是「保住了某个行为」—— 别把它当成有行为意义的键去"修"）；
   *  2. **原子写** —— 走 `atomicWrite`（先写同目录临时文件再 rename）；
   *  3. **非法值拒不写** —— `小时` 要 ≥1 的整数且不超过 `MAX_RESPONSE_DEADLINE_HOURS`，
   *     `开关` 要是 是/否；拒绝路径一个字节都不许改；
   *  4. **无条件入账** —— 只要**意图**改设置（含原值与新值相同、无变更可写），就 `audit.append`
   *     一条，主体记**真实主体**（谁敲的命令就是谁，不许冒充主权者）；
   *     落盘之后的**回读**（`reload()` + `presence()`）也在同一个 try 里：那个环节炸了同样要入账
   *     （如实写明盘动没动），不许静默 —— 越界的大整数曾经正是在这里「先写盘、再炸、不入账」。
   */
  async presence({ org, subject, args }) {
    const 路径 = org.layout.deploymentPrefs();
    const 有开关 = args.开关 !== undefined && args.开关 !== null;
    const 有小时 = args.小时 !== undefined && args.小时 !== null;
    const 有介入度 = args.介入度 !== undefined && args.介入度 !== null;
    const 有免审 = args.复核免审 !== undefined && args.复核免审 !== null;
    if (!有开关 && !有小时 && !有介入度 && !有免审) {
      return {
        读数: 设置读数(org),
        设置文件: 路径,
        说明: '读：本次没带任何设置键，没有改任何设置，也没入账（读不是设置入口）。',
      };
    }
    // 人侧入口（v2 条目14/17 · Lead 2026-10-18 修正）：主体由 intervention 内部构造为
    // 主权者本人——命令里自报的身份不参与。模型面没有这只手（命令面专属动作）。
    const 通道 = /设置页/.test(String(args.依据 ?? '')) ? '设置页' : '命令面';
    return await org.intervention.以人侧身份({
      通道,
      执行: async (主权者) => {
        // 人侧入口先记「本人有效交互」：主权者失联时，本人来改设置这件事本身就是解冻事实
        // ——先解冻再判设置闸，否则「失联冻结」会把唯一能恢复它的手冻住（自锁）。
        const 交互 = await org.intervention.记本人交互();
        // 先校验：非法值立刻拒，且一个字节都不写。拒绝也要留痕。
        let 新开关;
        let 新小时;
        let 新介入度;
        let 新免审;
        try {
          新开关 = 有开关 ? 解析开关(args.开关) : undefined;
          新小时 = 有小时 ? 解析设置小时(args.小时) : undefined;
          新介入度 = 有介入度 ? 解析介入度(args.介入度) : undefined;
          新免审 = 有免审 ? 解析复核免审(args.复核免审) : undefined;
        } catch (error) {
          await 记设置入账(org, {
            主体: 主权者,
            路径,
            依据: 设置依据(args.依据, 通道),
            结果: '拒绝（非法值，未写盘）',
            详情: { 拒绝理由: 错误信息(error), 入口: 通道, 收到的: { 开关: args.开关 ?? null, 小时: args.小时 ?? null, 介入度: args.介入度 ?? null, 复核免审: args.复核免审 ?? null } },
          });
          throw error;
        }

        // 设置写照走唯一判定点（没接线的「改设置」曾是预审四类里的假绿）：
        // kind=设置 / 自治档。Owner 因 kind=主权者天然不受介入度（自己不批自己）；
        // 非法模型写照旧 confirm/deny——这个动作本身是命令面专属，模型面到不了。
        await org.policy.check({
          subject: 主权者,
          action: 'write',
          target: { id: '部署设置', kind: '设置', authority: '自治', zone: '私有', project: null },
          context: {},
        });

        // 读-改-写一律在锁内：同一个部署里可能有别的会话也在改这份设置。
        // **写完的回读也在这同一个 try 里** —— 落盘成功但读数炸掉的场合必须留痕、不许静默。
        let 结果;
        let 已写盘 = false;
        let 读数;
        try {
          结果 = await withLock(`${路径}.lock`, async () => {
            const 现有 = await 读部署偏好文件(路径);
            const 下一份 = { ...现有.对象 };
            const 变更 = [];
            const 无变更 = [];
            /** @type {Record<string, {原值: unknown, 新值: unknown, 变更: boolean}>} */
            const 键详情 = {};
            for (const [键, 要写, 新值] of [
              ['失联限制', 有开关, 新开关],
              ['响应期限小时', 有小时, 新小时],
              ['介入度', 有介入度, 新介入度],
              ['复核免审', 有免审, 新免审],
            ]) {
              if (!要写) continue;
              const 有原值 = Object.hasOwn(现有.对象, 键);
              const 变了 = !有原值 || !Object.is(现有.对象[键], 新值);
              键详情[键] = { 原值: 有原值 ? 现有.对象[键] : null, 新值, 变更: 变了 };
              if (变了) 变更.push(键);
              else 无变更.push(键);
              下一份[键] = 新值;
            }
            // 只有真变更才写盘（原值与新值相同 ⇒ 盘上不动，但已经入账）。
            if (变更.length > 0) await atomicWrite(路径, `${JSON.stringify(下一份, null, 2)}\n`);
            return { 变更, 无变更, 键详情 };
          });
          已写盘 = 结果.变更.length > 0;
          // 写完立刻重载：`presence()` / 工作台 / 策略引擎读的就是这一次 reload 之后的值。
          await org.policy.reload();
          读数 = 设置读数(org);
        } catch (error) {
          // 读不懂的文件、写不进去的盘、落盘之后算不出的读数：一律留痕，且如实说明盘动没动。
          const 原因 = 错误信息(error);
          await 记设置入账(org, {
            主体: 主权者,
            路径,
            依据: 设置依据(args.依据, 通道),
            结果: 已写盘 ? `已写盘，但回读失败：${原因}` : `拒绝（未写盘）：${原因}`,
            详情: { 拒绝理由: 原因, 入口: 通道, 写盘: 已写盘 },
          });
          throw error;
        }

        await 记设置入账(org, {
          主体: 主权者,
          路径,
          依据: 设置依据(args.依据, 通道),
          结果: 结果.变更.length > 0 ? `已写 ${结果.变更.join(' / ')}` : '无变更（原值与新值相同，未写盘）',
          详情: { 键: 结果.键详情, 变更: 结果.变更, 无变更: 结果.无变更, 写盘: 结果.变更.length > 0, 入口: 通道 },
        });
        // 本人改设置 = 有效本人交互（已在入口处记；这里只把读数带回）。
        return {
          设置文件: 路径,
          变更: 结果.变更,
          无变更: 结果.无变更,
          读数,
          入口: 通道,
          交互,
          说明: 结果.变更.length > 0
            ? '已改：这是 merge 写，只覆盖本次带来的键，文件里别的键原样保留。'
            : '原值与新值相同：没有需要写盘的东西，但已如实入账。',
        };
      },
    });
  },

  /**
   * 主权者逐请求放行（命令面专属；设置页的「待审批」走同一个域服务）。
   * 决议主体由 `org.intervention.人侧决议` 内部构造，这里的 `subject` 不参与归属。
   */
  async intervention_resolve({ org, args }) {
    const 请求id = String(args.请求id ?? '').trim();
    if (!请求id) throw new InvalidBody('intervention_resolve 需要 请求id（介入请求 id；设置页「待审批」里可复制）。', { missing: ['请求id'] });
    return await org.intervention.人侧决议({
      请求id,
      决定: args.决定,
      理由: args.理由 ?? '',
      通道: '命令面',
      认证: '人/命令面（命令面专属动作，模型没有这只手）',
    });
  },


  // ── Lead 自主调度：宿主执行体的统一治理入口 ──────────────────────────────────
  // 这组动作经内核注入的 宿主 服务束（真实 Agent + agentTeams/subagents）调官方运行时；
  // 准入与提示词共用同一份 DelegationPolicy（配置在 profile 的 dsh-mind-kernel.delegation）。
  // 新建必须经过本次真实 Mind 调用持有的官方工具桥；配置只判 Mind 资格，不替代 Host 准入。
  // 维护已有实例另按归属、任务与宿主目录判定；不因服务存在而认定已获创建许可。

  /** 调度授权读数（只读）：范围、指纹与适配可用性；不把授权存在当成就绪。 */
  async delegation_status({ 项目, 宿主 }) {
    if (!宿主?.delegation) {
      throw new Fault('DELEGATION_NOT_WIRED', '调度策略组件未随内核装载（旧内核或装配降级）。', { howToChange: '重启或修复 dsh-mind 内核组件后重试。' });
    }
    return { 数据: { ...宿主.delegation.status(项目), 适配: { agentTeams: Boolean(宿主.agentTeams), subagents: Boolean(宿主.subagents) } } };
  },

  /**
   * 策略引擎显式重载 + 生效回执（R04 · 审查 2026-10-16 · 判据③）。
   *
   * 为什么要有这只手：decide 的依赖签名比对让「手改规则件/部署介入度」在下一判定自动
   * 生效（判据①）；但**改了到底生效没有**需要一处可对账的显式动作——重载前后各取一次
   * describe()，把规则数、每份规则件的 digest 与加载时刻摆出来，前后不一致就是「确实换了
   * 内容」，一致就是「盘上没变或没读到」。回执里同时给 defaults来源（介入度等键的生效层）。
   *
   * 闸：仅 Lead / 主权者。重载会读盘并可能让引擎转不健康（真坏的规则件 fail-closed），
   * 属机制动作；成员/复核者没有这只手（复核者的只读守卫另有其道：它们连动作面都到不了）。
   */
  async policy_reload({ org, 项目, subject, 重载前 }) {
    if (!['Lead', '主权者'].includes(subject?.kind)) {
      throw new Denied(
        '法律 权限矩阵 · 策略重载仅 Lead / 主权者（R04）',
        `策略引擎重载是机制动作：${subject?.kind ?? '未知'} 没有这只手。`,
        {
          requireAuthority: 'Lead',
          howToChange: '由 Lead（根会话）或主权者执行；改了规则件/部署偏好后，decide 的依赖签名比对会在下一次判定自动生效，通常无需手工重载。',
        },
      );
    }
    const 前 = 重载前 ?? org.policy.describe();
    const 前摘要 = (前.rules ?? []).map((r) => `${r.id}@${r.zone}:${String(r.digest).slice(0, 8)}`);
    const ok = await org.policy.reload();
    const 后 = org.policy.describe();
    const 后摘要 = (后.rules ?? []).map((r) => `${r.id}@${r.zone}:${String(r.digest).slice(0, 8)}`);
    const 变了 = 前摘要.join('|') !== 后摘要.join('|');
    await org.audit?.append?.({
      动作: '策略重载',
      主体: subject,
      对象: { id: '策略引擎', kind: '机制' },
      依据: 'R04（审查 2026-10-16）：显式重载 + 生效回执',
      结果: ok ? (变了 ? '已重载（规则摘要有变化）' : '已重载（规则摘要无变化）') : '重载失败（引擎不健康，判定面 fail-closed）',
      项目,
      详情: { 规则数: { 前: 前摘要.length, 后: 后摘要.length }, 摘要变化: 变了, 健康: 后.healthy, 生效来源: 后.defaults来源 ?? {} },
    });
    return {
      数据: {
        健康: 后.healthy,
        加载于: 后.loadedAt,
        规则数: { 前: 前摘要.length, 后: 后摘要.length },
        摘要: { 前: 前摘要, 后: 后摘要 },
        摘要变化: 变了,
        错误: 后.error ?? null,
        生效来源: 后.defaults来源 ?? {},
      },
      说明: 变了
        ? '重载完成：规则摘要与重载前不同（盘上内容确实换了）。'
        : '重载完成：规则摘要与重载前一致（盘上没变，或改的不是引擎读取的那份——对照 摘要 与 生效来源）。',
    };
  },

  /**
   * 起一名组织成员并完成全链路就位：启动自检提示 → 取真实实例 id → 登记 → 绑定节点 →
   * 装载岗位与判据 → 发开工消息。任何一步失败都如实报阶段，不把半成品报成就绪。
   */
  async member_spawn({ org, 项目, subject, 宿主, 执行计划 }) {
    const 计划 = assertMemberSpawnPlan(执行计划);
    const args = 计划.入参;
    const 授权 = 要求授权({ 宿主, subject, 项目 });
    const 方式 = args.方式;
    const agent = 宿主.agent;
    const signal = 中止信号(宿主);
    const 节点 = 计划.节点;
    const 名 = 规范成员名(`${args.岗位}-${args.节点}`, Date.now().toString(36).slice(-4));
    const { 模型路由, 模型供应商, 模型, 推理档 } = 计划;
    const 待命书 = [
      `你是数字组织「${args.岗位}」岗位的成员实例（项目 ${项目}），现在处于启动自检阶段。`,
      '第一步：调用 mind 工具 action=status 确认主体；实例尚未登记时被拒是预期行为，至多重试一次，并记住拒绝里报出的真实实例 id。',
      '第二步：不要开始任何业务工作。回一句启动确认即结束本轮，等待 Lead 的正式开工书。',
    ].join('\n');
    let 执行体 = null, 实例 = null, 团队名 = null, 钉卡 = null;
    let 已登记 = false, 已绑定 = false, 已派发 = false, 派发节点 = null, 开工回执 = null;
    const 确认阶段 = () => [
      ...(实例 ? [{ 阶段: '宿主返回实例标识', 项目, 实例 }] : []),
      ...(执行体?.初始消息id ? [{ 阶段: '初始inbox已接收', 项目, 实例, 消息id: 执行体.初始消息id, 已接收: true }] : []),
      ...(已登记 ? [{ 阶段: '登记及钉卡就绪', 项目, 实例 }] : []),
      ...(已绑定 ? [{ 阶段: '任务绑定完成', 项目, 实例, 任务: args.节点 }] : []),
      ...(已派发 ? [{ 阶段: '任务派发完成', 项目, 任务: args.节点 }] : []),
      ...(开工回执 ? [{ 阶段: '开工书inbox已接收', 项目, 实例, 任务: args.节点, 消息id: 开工回执.messageId, 已接收: true }] : []),
    ];
    const 补偿停用 = () => 停执行体({ org, subject, 宿主, 方式, agent, 实例, 团队名, 名 });
    const journal = createMemberSpawnJournal({ org, project: 项目, subject, plan: 计划 });
    try { await runMemberSpawnStages(计划, {
      spawn: async () => {
        await recheckMemberSpawnPlan(计划);
        const call = prepareExecution({ host: 宿主, mode: 方式, name: 名,
          description: `组织成员·${args.岗位}·${args.节点}`, standby: 待命书, modelRoute: 模型路由,
          beforeDispatch: () => recheckMemberSpawnPlan(计划) });
        await journal.begin(call.hostCall);
        执行体 = await call.execute();
        ({ 实例, 团队名 } = 执行体);
        await journal.record('host_returned', { 实例, 初始消息id: 执行体.初始消息id, 团队名, 宿主调用id: 执行体.宿主调用.调用id });
      },
      register: async () => {
        // 登记 + 钉版（唯一适配器）：节点绑定走 `绑定.节点`；会审绑定走 `绑定.会审`。
        钉卡 = await 登记钉版({
          org,
          subject,
          岗位: args.岗位,
          实例,
          代次: org.boot?.代次,
          方式,
          绑定: { 节点: args.节点 },
          授权引用: args.授权引用,
          停: 补偿停用,
        });
        已登记 = true;
        await journal.record('registered', { 实例 });
      },
      'bind-dispatch': async () => {
        try {
          // v2 条目11：**绑定实例，不改负责人**。修前这里 `reassign(负责人:[实例])` 把岗位名换成
          // 实例 id——等于把「这一岗」收成「这一人」，一岗多实例 / 换人重跑都无法表达，
          // 也正是「member_spawn 一次改派即称完成绑定」要纠的形态。
          await org.tasks.bind(args.节点, { subject, 项目, 实例, 岗位: args.岗位 });
          已绑定 = true;
          await journal.record('bound', { 实例, 任务: args.节点 });
          派发节点 = await org.tasks.dispatch(args.节点, { subject, 项目, 工具文件范围: args.工具文件范围 });
          已派发 = true;
          await journal.record('dispatched', { 任务: args.节点 });
        } catch (error) {
          throw new Fault('MEMBER_SPAWN_DISPATCH_FAILED', `实例 ${实例} 已登记，但节点绑定/派发失败：${错误信息(error)}。`, {
            detail: { 阶段: 'dispatch', 实例, 已登记: true, 节点: args.节点 },
            outcome: { 提交状态: '部分提交', 可重试: false,
              恢复指引: '查询节点当前状态及绑定，并按返回的事件序号核对已提交步骤；已派发时补记审计，确认未派发后才单独 task_dispatch。实例已在册，不要重复 member_spawn。',
              已确认阶段: [...确认阶段(), ...(error.outcome?.已确认阶段 ?? [])] },
          });
        }
      },
      message: async () => {
        const { 钉L0, 钉L1, 钉能力, 摘要: 钉摘要 } = 拼钉卡规程(钉卡);
        const 开工书 = [
          `正式任务（节点 ${args.节点}）：${节点.描述}`,
          `验收判据（已冻结）：${(节点.判据 ?? []).join('；')}`,
          `通用文件范围（已冻结）：${JSON.stringify(派发节点?.工具文件范围 ?? { 读: [], 写: [] })}。只有真实绑定的本任务范围可用 read/write/edit；shell 与未知执行类需报告 Lead 处理，当前目录不构成授权。`,
          // v2 条目10：把钉住的卡版本写进开工书——成员看到的规则面与账上钉的是同一版。
          `你被绑在此节点（负责人仍是「${(节点.负责人 ?? []).join('、')}」这一岗）；实例钉住的岗位卡版本：${钉摘要 || '未钉'}。`,
          // 规程正文只取**钉住快照**（不是现行 get 的正文）：L0/L1 完整附上，能力只引用不内嵌。
          ...(钉L0 ? [`岗位身份（个体L0 · 已钉版）：${钉L0}`] : []),
          ...(钉L1 ? [`岗位规则（个体L1 · 已钉版）：${钉L1}`] : []),
          `能力引用（只引用，不内嵌正文）：${钉能力 || '（无）'}`,
          `作业规程：先 mind task_start(id='${args.节点}') 开工；需要组织读写用 mind 动作；完成后 mind task_submit(id='${args.节点}', 结论=..., 结论层=..., 产出物引用=...) 交卷；不许自批、不许改判据。`,
          `任务书：${args.任务书}`,
        ].join('\n');
        try {
          开工回执 = await 发成员书({ 宿主, 方式, agent, signal, 实例, 团队名, 内容: 开工书 });
          await journal.record('message_received', { 实例, 任务: args.节点, 消息id: 开工回执.messageId });
        } catch (error) {
          throw new Fault('MEMBER_SPAWN_MESSAGE_FAILED', `实例 ${实例} 已登记、节点已派发，但开工消息发送失败：${错误信息(error)}。`, {
            detail: { 阶段: 'sendMessage', 实例, 已登记: true, 已派发: true },
            outcome: { 提交状态: '部分提交', 可重试: false,
              恢复指引: `先核对实例 ${实例} 的 inbox 是否已接收开工书；结果未知时不要重发。登记与节点 ${args.节点} 派发已完成，不要重复 member_spawn。`,
              已确认阶段: [...确认阶段(), ...(error.outcome?.已确认阶段 ?? [])] },
          });
        }
      },
      audit: async () => {
        // P2：委派创建动作本身与模型路由/授权指纹进审计（修前只有 registry_assign/任务事件等
        // 副作用，审计链无法回答「这个成员是被哪条授权、以什么模型起的」）。
        try {
          await org.audit.append({
            动作: '成员创建',
            主体: subject,
            对象: { id: 实例, kind: '身份' },
            依据: '统一委派入口：member_spawn（先判据后创建；授权真源见 authorizationRef）',
            结果: `已登记并派发（${方式}${模型路由 ? `；路由 ${模型供应商}/${模型}${推理档 ? `@${推理档}` : ''}` : ''}）`,
            详情: { 方式, 岗位: args.岗位, 节点: args.节点, 模型路由: 模型路由 ?? null, 授权指纹: 授权.fingerprint },
          });
        } catch (error) {
          throw new Fault('AUDIT_APPEND_FAILED_AFTER_EVENT', `实例 ${实例} 已创建并派发，但「成员创建」审计追加失败：${错误信息(error)}。不要重复 member_spawn——先核对实例 ${实例} 是否在岗，再补记审计。`, {
            detail: { 阶段: 'audit', 实例, 已登记: true, 已派发: true },
            outcome: { 提交状态: '已提交', 可重试: false,
              恢复指引: '登记、派发和开工书接收均已完成，按实例/任务/消息id核对后补记成员创建审计；不要重建成员或重复发送开工书。',
              已确认阶段: 确认阶段() },
          });
        }
        await journal.record('audited', { 实例, 任务: args.节点 });
      },
    }); } catch (error) { throw await journal.failure(error, 确认阶段()); }
    const 预算回执 = memberSpawnBudgetReceipt(计划);
    return { 方式, 名: 团队名 ?? null, 实例, 岗位: args.岗位, 节点: args.节点, 已登记, 已派发, 已发开工书: true, 消息id: 开工回执.messageId, 已接收: true, 执行完成: null, 授权指纹: 授权.fingerprint, 操作: journal.receipt(), ...(预算回执 ? { 预算: 预算回执 } : {}), ...(模型路由 ? { 模型路由 } : {}) };
  },

  /** 给组织登记过的实例发消息：Team 成员走 Team 邮箱，普通 continuable 走子会话服务。 */
  async member_message({ org, 项目, 会话项目, subject, args, 宿主 }) {
    return messageExistingMember({ org, project: 项目, sessionProject: 会话项目, subject, args, host: 宿主 });
  },

  /** 中断与新建分开：精确现有归属、独立维护判断、宿主真实中断管线。 */
  async member_stop({ org, 项目, 会话项目, subject, args, 宿主 }) {
    return stopExistingMember({ org, project: 项目, sessionProject: 会话项目, subject, args, host: 宿主 });
  },

  /** 在册实例 × Team 名册 × 普通子会话 的合并读数：按真实名册分流，不猜 id。 */
  async member_list({ org, 项目, 会话项目, subject, 宿主 }) {
    return listExistingMembers({ org, project: 项目, sessionProject: 会话项目, subject, host: 宿主 });
  },
};
