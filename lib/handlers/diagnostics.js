// 诊断域实现 —— 2026-11-17 从 handlers/index.js 按域拆出。
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

export const diagnosticHandlers = {
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
};
