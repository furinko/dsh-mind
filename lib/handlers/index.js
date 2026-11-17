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
import { leadHandlers } from './lead.js';
import { leadSpaceHandlers } from './lead-space.js';
import { informationHandlers } from './information.js';
import { monitorHandlers } from './monitor.js';
import { reviewExperimentHandlers } from './review-experiment.js';
import { diagnosticHandlers } from './diagnostics.js';
import { turnHandlers } from './turn.js';
import { projectBriefHandlers } from './project-brief.js';
import { memoryActionHandlers } from './memory-actions.js';
import { miscHandlers } from './misc.js';
import { settingsCommandHandlers } from './settings-commands.js';
import { capabilityHandlers } from './capability.js';
import { busHandlers } from './bus.js';
import { debateHandlers } from './debate.js';
import { auditHandlers } from './audit-actions.js';
import { registryHandlers } from './registry.js';
import { goalHandlers } from './goals.js';
import { taskHandlers } from './tasks.js';
import { memberHandlers } from './members.js';


import { 记动作拦截, 实例活动索引, 实例活动读数, 未登记敲门者, informationScope, requireExperiments, READ_ONLY_SET, 命令面专属文案, 拒讨论线程直灌, 成员可达节点, 规范读根, 断言记忆写入参数, reviewReadProof, 复核读域For, 取任务上下文, 盲评遮罩, 要求授权, 解析模型路由, 断言成员宿主就绪, 停执行体, 补偿归属复判, 登记钉版, 发成员书, 拼钉卡规程, 参数列表, 岗位清单, 断言会审计计划完整, 会审退役适配器, 中止信号, 错误信息, 目标参数, 动作提交凭据, 宿主清理凭据, 规范成员名, 查Team名, 拒他人任务线程, 记设置入账, 设置读数, 设置依据, 解析介入度, 解析复核免审, 解析开关, 解析设置小时, 读部署偏好文件, 会审咨询动作 } from '../actions.js';

export const HANDLERS = {
  ...leadHandlers,
  async memory_use_query({ org, 项目, subject, args }) { return { 数据: await org.memoryUse.query({ subject, project: 项目, id: args.id, limit: args.limit ?? 20, offset: args.偏移 ?? 0 }) }; },
  ...leadSpaceHandlers,
  async information_read(spec) {
    const scope = informationScope(spec);
    return { 数据: await spec.org.information.read(scope, spec.args.信息 ?? {}) };
  },
  async information_update(spec) {
    const scope = informationScope(spec);
    await spec.org.turnBufferHooks?.sync(spec.宿主.agent.session);
    return { 数据: await spec.org.information.update(scope, spec.args.信息 ?? {}) };
  },
  ...monitorHandlers,
  ...reviewExperimentHandlers,

  ...diagnosticHandlers,

  ...goalHandlers,
  ...taskHandlers,
  ...turnHandlers,

  ...projectBriefHandlers,

  ...memoryActionHandlers,
  ...miscHandlers,

  ...capabilityHandlers,

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

  ...busHandlers,

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

  ...debateHandlers,

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

  ...auditHandlers,

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

  ...registryHandlers,

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

  ...settingsCommandHandlers,

  /**
   * 起一名组织成员并完成全链路就位：启动自检提示 → 取真实实例 id → 登记 → 绑定节点 →
   * 装载岗位与判据 → 发开工消息。任何一步失败都如实报阶段，不把半成品报成就绪。
   */
  ...memberHandlers,
};
