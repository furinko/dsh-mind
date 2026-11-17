// 任务域实现 —— 2026-11-17 从 handlers/index.js 按连续块拆出。
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

export const taskHandlers = {
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

};
