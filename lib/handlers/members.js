/**
 * 动作实现表 —— 从 lib/actions.js 整体搬出（2026-11-17）。
 *
 * 为什么搬：actions.js 曾是 2700+ 行，动作层（runAction、各道闸、manifest 派生）与
 * 96 个动作实现挤在一起。搬出后这里只剩实现，动作层留 actions.js。
 *
 * 成员域实现（member_*）—— 2026-11-17 从 index.js 按域拆出的第一块；
 * 其余域仍在 index.js，后续按同一形状继续拆。
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

export const memberHandlers = {
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
