// 会审域实现 —— 2026-11-17 从 handlers/index.js 按连续块拆出。
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
import { goalHandlers } from './goals.js';
import { taskHandlers } from './tasks.js';
import { memberHandlers } from './members.js';


import { 记动作拦截, 实例活动索引, 实例活动读数, 未登记敲门者, informationScope, requireExperiments, READ_ONLY_SET, 命令面专属文案, 拒讨论线程直灌, 成员可达节点, 规范读根, 断言记忆写入参数, reviewReadProof, 复核读域For, 取任务上下文, 盲评遮罩, 要求授权, 解析模型路由, 断言成员宿主就绪, 停执行体, 补偿归属复判, 登记钉版, 发成员书, 拼钉卡规程, 参数列表, 岗位清单, 断言会审计计划完整, 会审退役适配器, 中止信号, 错误信息, 目标参数, 动作提交凭据, 宿主清理凭据, 规范成员名, 查Team名, 拒他人任务线程, 记设置入账, 设置读数, 设置依据, 解析介入度, 解析复核免审, 解析开关, 解析设置小时, 读部署偏好文件, 会审咨询动作 } from '../actions.js';

export const debateHandlers = {
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
};
