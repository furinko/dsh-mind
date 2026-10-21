/**
 * 组织动作表（宿主插件与工作台共用的唯一实现）。
 *
 * 为什么动作表要独立成文件：`references/user-actions.md` 的纪律是
 * **一个操作两处调用者（工具 + UI），但只有一处实现**。
 * 于是这里既被 `mind` 工具调用，也被 `/mind` 命令调用，两条路进的是同一张表。
 */
import { Denied, Fault, InvalidBody, NeedsApproval } from '../src/kernel/errors.js';
import { atomicWrite, readTextOrNull, stripBom, withLock } from '../src/kernel/fsx.js';
import { MAX_RESPONSE_DEADLINE_HOURS } from '../src/kernel/time.js';
import { MEMORY_KINDS, 线程等价键 } from '../src/paths.js';
import { 全员已交, 负责人实例名单 } from '../src/tasks.js';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve as resolvePath } from 'node:path';
// （v2 · 2026-10-18：subjectForRole 的入口解析已随主体类「复核者」移除，
//  本文件不再 import 它——映射落点仍在 src/registry.js 供 canTouch/debate 候选池用。）
// 审计尾默认条数单源（设计评审 #17 · 2026-10-15）：动作面两处默认（workbench 的 审计条数 /
// audit_tail 的 limit）都引这里，不再各写字面量。
import { 审计尾默认条数 } from '../src/audit.js';
// ①甲（2026-10-10）：bus_send 拒往讨论线程直灌时，文案里的类型闸口径取自 debate.js 的**唯一源**
// （不在这里再抄一遍三种类型 —— 抄一遍就会漂）。
import { DEBATE_SAY_TYPES, COUNCIL_THREAD_PREFIX } from '../src/council.js';
// P1-09（全面审查 2026-10-17）：盲标只允许一个实现——总线读面与工作台/揭名共用
// review.js 的确定性置换；别再按消息到达顺序另造一套（顺序本身就是身份线索）。
import { 盲标分配 } from '../src/review.js';
// v2 口述收敛 2026-10-18 条目10：卡版本补进主体形状的**唯一** helper（审计随之带版本）。
import { 钉版主体 } from '../src/subject.js';
// v2 条目4/6 补修 · 复核读域唯一判据：复核员岗的读面按「已绑定复核任务→显式复核对象」限定，
// 不是 role 全量。workbench / task_criteria / memory_query / audit_tail / bus_read 都走它。
import { 取复核读域, 在读域, 审计行在读域, 线程在读域, 复核对象引用 } from '../src/review-scope.js';
// v2 条目14/17（2026-10-18 补修F）：主权者逐请求放行的重放上下文；步骤计划构造器是
// 宏动作 → 底层策略写的唯一翻译层（本文件只在入口处调它，不在这里另抄一份步骤）。
import { 以放行上下文, 记录本次新建 } from '../src/intervention.js';
import { 介入计划Of, 计划会挂起 } from './approval-plan.js';
import { assertMemberSpawnPlan, runMemberSpawnStages, memberSpawnBudgetReceipt, recheckMemberSpawnPlan } from './member-spawn-plan.js';
import { createMemberSpawnJournal } from './member-spawn-journal.js';
// 介入度三档的唯一来源（设置入口校验与策略引擎读同一张表，别在两处各写一份）。
import { INTERVENTION } from '../src/policy.js';
import { messageExistingMember, listExistingMembers } from './member-maintenance.js';
import { TASK_RECOVERY_RELATION_FIELDS } from '../src/task-state.js';
import { normalizeKnowledgeContext } from '../src/knowledge-applicability.js';
import { normalizeFeedbackReference } from '../src/knowledge-feedback.js';
import { assertExecutionHost, createExecution, releaseExecution, requestExecutionInterrupt, sendExecutionMessage, requireDelegation, parseModelRoute } from './host-execution.js';

export { describeFailure } from '../src/kernel/errors.js';

/**
 * 只读动作的**唯一清单**（动作面读写分类的单源，v2 条目10 补修 · 2026-10-18）。
 *
 * 两个消费者，不许各写一张表（两张表迟早漂，漂了就是一侧放行/一侧拒）：
 *  - 内核 `isConcurrencySafe`：只读动作允许并发；
 *  - `runAction` 的 Lead 钉版闸：**自治写**必须在册在岗 + 有钉版摘要可读，
 *    诊断读（status / workbench / audit_tail …）即使钉版读数缺失也照常可用。
 *
 * 归属口径：不在这里的动作一律按**写**处理（fail-closed）。新增动作先归一次类。
 */
export const READ_ONLY_ACTIONS = Object.freeze([
  'status',
  'workbench',
  'policy_check',
  'goal_query',
  'budget_query',
  'usage_query',
  'operation_query',
  'knowledge_reuse_query',
  'task_criteria',
  'memory_query',
  'memory_lineage',
  'capability_list',
  'capability_resolve',
  'capability_read',
  'bus_read',
  'audit_tail',
  'audit_verify',
  'registry_list',
  'registry_can',
  'upgrade_pending',
  'delegation_status',
  'member_list',
  'review_experiment_read',
  'monitor_query',
]);

const READ_ONLY_SET = new Set(READ_ONLY_ACTIONS);

/**
 * 这个动作是不是写动作（单源判据；未知动作按写处理）。
 * @param {string} action
 * @returns {boolean}
 */
export function 是写动作(action) {
  return !READ_ONLY_SET.has(String(action ?? ''));
}

/** 动作清单：工具 schema 的 enum 必须与它一致，别处不再枚举。 */
export const ACTIONS = [
  'monitor_query',
  'monitor_followup',
  'monitor_feedback',
  'status',
  'workbench',
  'policy_check',
  // 持久目标记录意图与进度，不修改部署设置或授予权限；人侧改动另走 goal_decide。
  'goal_create',
  'goal_query',
  'goal_revise',
  'goal_progress',
  'goal_complete',
  'goal_link_task',
  // 预算只读受管准入尝试；配置仅人侧budget_decide，模型没有计量/结算/释放入口。
  'budget_query',
  // 模型usage观察只读；只汇总已观测SDK字段，不是目标总量或费用计量。
  'usage_query',
  // 成员创建操作仅查询已落盘意图和阶段，不开放重放、恢复或清零。
  'operation_query',
  // 知识复用仅治理只读；采用声明不证明有效性或收益，不自动改知识状态。
  'knowledge_reuse_query',
  'task_create',
  // task_reassign（task-机制缺口-10th0 · 裁决③ · 2026-10-13）：改派负责人——仅 Lead、
  // 仅 待派发/已派发 态（tasks.js 的状态机与 Lead 闸守着），入审计。负责人实例消亡后
  // 节点原先只能重建，这是那条死路的正门。
  'task_reassign',
  'task_close',
  'task_successor',
  'task_dispatch',
  // task_bind（v2 口述收敛 2026-10-18 条目11）：把**实例**绑到节点，负责人仍是岗位名。
  // member_spawn 起实例时自动绑定；这个动作给「不重新起实例、把既有实例绑到另一个节点」
  // 留正门（也用来自证复核任务与被复核节点的关联，测试与人工排兵都走它）。
  'task_bind',
  // task_attach（v2 条目6 补修）：Lead/主权者把**复核读根**（源码目录/产物文件，绝对路径）
  // 附到复核任务上——这是复核员文件读面的唯一正门（不再靠任务书散文/工作区全量猜测）。
  // 成员交付产物仍可走同一服务的普通 attach（不授予文件读权限），二者在事件上分开记。
  'task_attach',
  'task_start',
  'task_submit',
  'task_review',
  // task_accept（补修K · 2026-10-18 · 主权者条目4「采纳权在 Lead」）：复核结论只出**可引用票**，
  // 采纳是 Lead 的独立一步——必须引用本任务当前有效过票（rv-N）或合法免审依据；成员/复核岗
  // 不可采纳。修前 review(过) 直接即采纳、账上无采纳引用，本动作存在的全部理由就是分开这两件事。
  'task_accept',
  // task_disagree（补修K）：Lead 记录不同意——只追加异议记录，不改复核三态、不改冻结判据。
  // 实现单源在 review.recordDisagreement（复核结论只增的既有边界），这里只补一只动作面入口。
  'task_disagree',
  // task_criteria（复核汇总后续顺序① · 2026-10-16）：受管冻结判据只读入口——被指派复核者/
  // 负责人/Lead/主权者经机制读冻结判据原文与指派事实（白名单投影，不含他人答案）。
  // 过「是不是改设置的动作」这一关：不是——纯只读投影，替代「手读任务图账本」的绕路。
  'task_criteria',
  'task_pending',
  'task_resolve',
  // task_settle（W3 批3）：结账——环路最后一步，仅 Lead（policy 的 `settle` 动作守着）。
  'task_settle',
  // review_exempt（v2 口述收敛 2026-10-18 条目5）：复核豁免登记——读部署设置「复核免审」
  // 全局开关（默认关 ⇒ 一律拒），仅 Lead/主权者。提名机制（review_nominate）随复核者
  // 降级移除：复核员是普通岗位卡，由 Lead 按任务 member_spawn 起实例。
  'review_exempt',
  'review_experiment_allow',
  'review_experiment_run',
  'review_experiment_read',
  'memory_write',
  'memory_query',
  'memory_lineage',
  'memory_lifecycle',
  'capability_list',
  'capability_resolve',
  'capability_read',
  'capability_publish',
  'bus_send',
  'bus_read',
  // bus_deliver（2026-10-14 审查 P1-4）：把「暂不投递」的消息放出去。修前 deliver()
  // 只活在服务层与测试里，动作/命令面无入口——暂不投递 落账即永久滞留（断头路，
  // 2026-10-12 报告 #7 在案）。本动作就是那条出口。
  'bus_deliver',
  'audit_tail',
  'audit_verify',
  // audit_correct（缺口2a · 主权者裁决 2026-10-12）：追加「更正声明」，把「单点 hash 不符、
  // 骨架完好」的已确认瑕疵从恒红转「已确认瑕疵」。不是改设置的动作；入口默认拒绝
  // （仅 Lead / 主权者 + 授权引用必填），写入面 audit.appendCorrection 再守三道闸。
  'audit_correct',
  // store_rollback（2026-10-14 审查 P2-20）：对象库文本版本回滚接线。修前 store.rollback
  // 实现了（含策略闸）却无任何入口——§4「只有主权者能回滚文本版本」成了空头承诺。
  // 闸仍在 store.rollback 里（target.textVersion=true ⇒ 仅主权者 kind 可过）。
  'store_rollback',
  'registry_list',
  'registry_can',
  'registry_assign',
  'registry_seal',
  'registry_revoke',
  'upgrade_pending',
  'review_zero',
  // bus_unlock 已退役（v2 条目18 补修 · 2026-10-18）：会审退出任务图后，「会审解锁」
  // 只属会话绑定的新会审（debate_unlock / src/council.js）。旧的独立会审节点是只读历史，
  // 模型面不再有这只往旧线程写广播的手；服务层 bus.unlock 只留「旧写恒拒」的墓碑守卫。
  'debate_open',
  'debate_answer',
  'debate_unlock',
  'debate_say',
  'debate_round',
  'debate_converge',
  // ── Lead 自主调度（2026-10-15 主权者授权「由 lead 根据需求判断使用团队或子智能体或都不使用」）──
  // 过「是不是改设置的动作」这一关：不是——授权真源在 profile 的 dsh-mind-kernel.delegation
  // 配置（主权者的机器层），这组动作只是消费它；创建/消息/中断全部走组织登记与审计。
  'delegation_status',
  // policy_reload（R04 · 审查 2026-10-16 · 判据③）：策略引擎显式重载 + **生效回执**
  // （重载前后规则数/digest 摘要对照）。修前只有服务层 reload()，动作面无入口——「改了
  // 不生效」时调用方无从确认；decide 的依赖签名比对已让改动自动生效，本动作是那条路的
  // 显式版与对账面。过「是不是改设置的动作」这一关：不是——它不改任何规则/设置文件，
  // 只重新读取现有文件并回报前后对照；闸＝仅 Lead / 主权者（重载是机制动作）。
  'policy_reload',
  'member_spawn',
  'member_message',
  'member_stop',
  'member_list',
];

/**
 * 命令面专属动作：**只有人能敲，模型没有这只手**。
 *
 * 为什么单立一张清单而不是直接塞进 `ACTIONS`：`ACTIONS` 就是 `mind` 工具 schema 的
 * `enum` 的来源，往里加一个动作 = 给模型加一只手。改设置这类动作（`presence`）必须
 * 只从人侧可达，而「可达性」得由**结构**保证，不能靠「配方里没写」这种约定——
 * 于是两边各一张清单：工具面 = `ACTIONS`，命令面 = `ACTIONS ∪ COMMAND_ONLY_ACTIONS`。
 * 判据（test/presence.test.js ⑦ / test/presence-command.test.js ⑤）逐项比对两张清单。
 *
 * `sovereign_interaction` 也在这一面（审查 B3 建议）：失联判定的「事实源」——主权者
 * 在线这件事——**只能由人声明**。模型可写的话，配合热重载就是「自行解冻」旁路。
 */
export const COMMAND_ONLY_ACTIONS = ['presence', 'sovereign_interaction', 'intervention_resolve', 'goal_decide', 'budget_decide'];

/** 命令面专属动作 = 工具面 ∪ 命令面专属（`/mind` 命令认这张，工具 schema 不认）。 */
export const COMMAND_ACTIONS = [...ACTIONS, ...COMMAND_ONLY_ACTIONS];

/**
 * 命令面专属动作的拒绝文案：按动作各写一句「为什么模型没有这只手」。
 * presence 与 sovereign_interaction 拒的都是「事实源不许模型自写」，但改的东西不同。
 */
const 命令面专属文案 = {
  presence: {
    理由: '宪章 三权（§4）：改设置的入口只给人',
    howToChange: '由人敲 /mind presence 开关=是|否 小时=<≥1 的整数> 介入度=放权|预审|审批 复核免审=是|否（不带参数则是只读的当前读数）。',
  },
  sovereign_interaction: {
    理由: '宪章 失联判定（§4）：主权者在线的事实只能由人声明',
    howToChange: '由人敲 /mind sovereign_interaction（模型没有这只手：失联判定的事实源不许模型自写）。',
  },
  intervention_resolve: {
    理由: '宪章 三权（§4）：逐请求放行只给主权者本人（人侧入口）',
    howToChange: '由人敲 /mind intervention_resolve 请求id=<介入请求id> 决定=批准|拒绝|撤销（完整内容与步骤预览在设置页「待审批」）。',
  },
  goal_decide: {
    理由: '持久目标 · 用户目标与暂停/取消/恢复决定只认人侧入口',
    howToChange: '由人敲 /mind goal_decide id=<目标id> 修订=<当前修订> 状态=暂停|取消|进行中，或用JSON给出用户要修改的期望结果/完成依据。',
  },
  budget_decide: {
    理由: '目标预算 · 受管准入上限只能由人侧配置',
    howToChange: '由人敲 /mind budget_decide id=<目标id> 预算修订=<首次0或当前修订> 上限=<非负整数>；单位固定为一次受管准入尝试，不代表token或费用预算。',
  },
};

/**
 * 动作层拦截入账（缺口1B · 2026-10-12 评审）：策略引擎自己的拒绝在 decide() 里已记
 * 「策略拒绝」，但动作层/服务层**自长**的闸（身份门①②、会审闸、状态机、披露检查……）
 * 抛出的 Denied 修前完全不入账——「谁被拦了、拦在哪条规则上」是安全信号，盲区铺满。
 * 引擎抛的 Denied 带 `已入账` 标记 ⇒ 这里跳过，同一拒绝不双记。
 * 只记主体 id + 动作名 + 规则名，**不抄入参**（防泄密，与 身份未登记拦截 同口径）；
 * 入账失败不许盖过拦截本身（与 policy #auditFault 同口径：账本坏了探针会见红）。
 *
 * @param {object} org
 * @param {{ 主体?: object|null, 项目: string, args: object, error: unknown }} spec
 */
async function 记动作拦截(org, { 主体, 项目, args, error }) {
  if (error?.name !== 'Denied' || error.已入账 === true) return;
  try {
    await org.audit?.append?.({
      动作: '动作拦截',
      主体: 主体 ?? { id: '（主体缺席）', kind: '未知' },
      对象: { id: args?.id ?? args?.action ?? null, kind: '动作' },
      依据: error.rule ?? '动作层闸',
      结果: '拒绝',
      项目,
      详情: { 动作: args?.action ?? null, 规则: error.rule ?? null },
    });
  } catch {
    /* 入账自身失败只能吞：拦截是主行为。 */
  }
}

/**
 * 实例活动索引（G3 · 交接件《复核员任命闭环缺口》2026-10-14）。
 *
 * 数据源**不新增**——审计链本身：每个在册实例「最近一次以主体身份出现在账上是何时、
 * 共几条」。这是能力卡 no-life-inference-from-permission 缺的**出路**：那张卡禁从权限面
 * 推生死，但组织此前没有任何一手活动读数可查——只有禁令没有出路。
 *
 * 口径：只数「主体 = 该实例」的行——任何动作、任何项目都算活动，**含被拒**
 * （拒绝恰恰证明活着，死物不会敲门）。不数主体缺席/系统的行。
 *
 * @param {object} org
 * @param {{ members: Record<string, object> }} identity 身份档案（已读，不重读）
 * @returns {Promise<Map<string, {最近活动于: string|null, 活动条数: number}>>}
 */
async function 实例活动索引(org, identity) {
  /** @type {Map<string, {最近活动于: string|null, 活动条数: number}>} */
  const 索引 = new Map();
  for (const id of Object.keys(identity.members ?? {})) 索引.set(id, { 最近活动于: null, 活动条数: 0 });
  if (!org.audit?.read) return 索引;
  for (const row of await org.audit.read({})) {
    const id = String(row.主体?.id ?? '').trim();
    const 桶 = 索引.get(id);
    if (!桶) continue;
    桶.活动条数 += 1;
    if (String(row.时间) > String(桶.最近活动于 ?? '')) 桶.最近活动于 = String(row.时间);
  }
  return 索引;
}

/**
 * 实例读数 = 身份档案原行 + 活动面。活动是**现算的投影**，不写回档案（不是存储）。
 * @param {{ members: Record<string, object> }} identity
 * @param {Map<string, {最近活动于: string|null, 活动条数: number}>} 索引
 */
function 实例活动读数(identity, 索引) {
  const out = {};
  for (const [id, member] of Object.entries(identity.members ?? {})) {
    out[id] = { ...member, ...(索引.get(id) ?? { 最近活动于: null, 活动条数: 0 }) };
  }
  return out;
}

/**
 * 报告面（task-机制缺口-10th0 · 裁决③）：从审计链对出「被创建但从未登记在岗」的主体。
 *
 * 数据源**不新增**——就是 8dt59 已入账的「身份未登记拦截」：陌生主体每敲一次门留一条
 * （只含主体 id 与动作名，本就不带入参内容，此处聚合不会引入泄密面）。
 * 与身份档案做差集 ⇒ 「敲过门、账上无身份」的清单。
 *
 * @param {object} org
 * @param {{ members: Record<string, object> }} identity 身份档案（已读，不重读）
 * @returns {Promise<Array<{id: string, 敲门次数: number, 最近于: string}>>}
 */
async function 未登记敲门者(org, identity) {
  if (!org.audit?.read) return [];
  const rows = (await org.audit.read({})).filter((r) => r.动作 === '身份未登记拦截');
  /** @type {Map<string, {id: string, 敲门次数: number, 最近于: string}>} */
  const agg = new Map();
  for (const row of rows) {
    const id = String(row.主体?.id ?? row.主体 ?? '').trim();
    if (!id || identity.members[id]) continue;
    const prev = agg.get(id);
    if (prev) {
      prev.敲门次数 += 1;
      if (String(row.时间) > prev.最近于) prev.最近于 = String(row.时间);
    } else {
      agg.set(id, { id, 敲门次数: 1, 最近于: String(row.时间 ?? '') });
    }
  }
  return [...agg.values()].sort((a, b) => b.最近于.localeCompare(a.最近于));
}

/**
 * 执行一个动作。
 *
 * @param {{ org: object, 项目: string, subject?: object, args: object, 面?: 'tool'|'command', 主体: object }} spec
 *   `面` 省略时按**工具面**处理（fail-closed：命令面专属动作默认够不着）。
 *   `主体` **必填**（P2 · 2026-10-10）：它就是本条动作的执行者，必须由**宿主显式给**
 *   （工具面/命令面 = `agentSubject(exec)`，路由面 = `设置页主体()`）。
 *   缺席 ⇒ `Denied`（fail-closed），不再从 `args.role` / `args.实例` 推断。
 *   `subject` 已**不再被主体链读取**（保留在各方调用签名里当宿主上下文）。
 * @returns {Promise<object>} 结构化结果；调用方负责序列化。
 */
export async function runAction(spec) {
  const { org } = spec;
  const args = spec.args ?? {};
  const 项目 = args.project ?? spec.项目;
  // 面：'tool'（模型侧，默认）| 'command'（人侧 `/mind`）。
  // 默认按工具面处理，是 fail-closed：命令面专属动作在没显式声明「我是命令面」时够不着。
  const 面 = spec.面 ?? 'tool';
  const handler = HANDLERS[args.action];
  if (!handler) {
    throw new InvalidBody(`未知 action：${String(args.action)}`, { detail: { 可选: 面 === 'command' ? COMMAND_ACTIONS : ACTIONS } });
  }
  if (String(args.action).startsWith('memory_') && Object.hasOwn(args, '含待复验') && args.action !== 'memory_query') throw new InvalidBody('含待复验仅用于memory_query，不是记忆写入或生命周期的授权参数。');
  if (String(args.action).startsWith('memory_') && Object.hasOwn(args, '知识说明') && !['memory_write', 'memory_lifecycle'].includes(args.action)) throw new InvalidBody('知识说明只能随知识写入或overturn新替代条目提供，不能用于记忆读取。');
  if (String(args.action).startsWith('memory_') && Object.hasOwn(args, '反馈引用') && args.action !== 'memory_lifecycle') throw new InvalidBody('反馈引用仅用于memory_lifecycle的invalidate、demote或overturn，不是读取或写入认证。');
  断言记忆写入参数(args);
  if (COMMAND_ONLY_ACTIONS.includes(args.action) && 面 !== 'command') {
    const 文案 = 命令面专属文案[args.action] ?? { 理由: '该动作是命令面专属：模型没有这只手', howToChange: `由人敲 /mind ${args.action}` };
    throw new Denied(
      文案.理由,
      `${args.action} 是命令面专属动作：模型没有这只手。`,
      {
        requireAuthority: '主权者',
        howToChange: 文案.howToChange,
        detail: { 面, 动作: args.action, 命令面专属: COMMAND_ONLY_ACTIONS },
      },
    );
  }
  if (String(args.action).startsWith('goal_') || String(args.action).startsWith('budget_') || args.action === 'usage_query') {
    const 自报 = ['执行计划', 'subject', '主体', '面', '认证', '人侧', '已核验', '来源已核验'].filter((key) => Object.hasOwn(args, key));
    if (自报.length) throw new InvalidBody(`目标、预算或用量观察不接受自报执行计划或人侧认证字段：${自报.join('、')}。身份与来源核验只能由可信入口提供。`);
  }
  // 门①（2026-10-10 独立复核实证 · Lead 身份落在可自报字段上）：
  // `args.role` 是**模型自己填的参数**，不许拿它声明 Lead。
  // 修前实测：`runAction({subject:{kind:'Lead'}, args:{action:'debate_round', role:'Lead'}})` ⇒ 放行
  // （这里回落到 `subjectFor({岗位:'Lead'})`，自报即成真）；配上内核 `agentSubject` 恒传
  // `根会话: true`（那时**任何**会话的 subject 都是 Lead），`debate_round` / `debate_converge`
  // 的「仅 Lead」判据在模型可达面**完全不承重**——成员一条参数就能换轮、收敛。
  // 于是：Lead 身份**只能**来自宿主注入的 `spec.主体`（命令面记真实主体）或会话事实
  // （内核 `agentSubject` 按 `header.origin` / 父会话判，见 components/kernel/lib/index.js）。
  // 这一条**先于** `spec.主体` 判定：声明本身就是越界，不因为它撞上一条可信路径而变成合法。
  if (args.role === 'Lead') {
    const 拒 = new Denied(
      '宪章 身份停用 = 最严（§12.2）：Lead 身份由会话事实决定，不由参数声明',
      '`role: "Lead"` 是自报字段：Lead 身份只由会话事实（根会话）或宿主注入的主体决定，参数里写什么都不算。',
      {
        requireAuthority: '主权者',
        howToChange: '在**根会话**里执行该动作（根会话的执行者即 Lead）；命令面由人敲 /mind（主体记真实主体）。成员改用 debate_say 发言，等 Lead 换轮 / 收敛。',
        detail: { role: args.role, 实例: args.实例 ?? null, 判据: 'args.role 不许声明 Lead' },
      },
    );
    await 记动作拦截(org, { 主体: spec.主体, 项目, args, error: 拒 });
    throw 拒;
  }
  // 门②（P2 · 2026-10-10 独立复核实证）：**主体必须由宿主显式给**。
  //
  // 修前这里是 `spec.主体 ?? subjectFor({ 岗位: args.role, 实例: args.实例, 根会话: subject?.kind === 'Lead' })`。
  // 那条兜底路在 ㉑ 落地后变成 **fail-open**：`args.实例` 只要填一个**在册在岗**的实例 id
  // （不带 `args.role` ⇒ 构造出的主体**没有** `roleId`），下面 `:177` 的岗位对账
  // 第三段就短路 ⇒ **知道实例 id 即成那个人**。复核最小复现实测（工作树、不传 `主体`）：
  //   `runAction({ org, 项目:'default', args:{ action:'status', 实例:'member-a' } })`
  //   ⇒ 放行为 `{id:'member-a', kind:'成员', roleId:null}`；**修前 HEAD 版会拒**
  //     （那时会话派生带哨兵 `roleId:'未登记'`，与档案岗位恒不匹配）。
  // 生产可达面**不可达**（3 个生产调用点全部显式传 `主体` ⇒ `??` 短路），但**将来任何漏传
  // `主体` 的新调用点会立刻被冒充**。于是这一格改成 fail-closed：缺席即拒，不给兜底。
  //
  // 为什么不改 `:177` 的对账判据：那是 ㉑ 的成果（「在册且在岗即可，岗位以档案为准」），
  // 门槛是"知道岗位名"；本条要关的是**主体从哪来**，两件事分开治（`:177` 一字未动）。
  // 为什么放在门① 与命令面判定**之后**：声明越界（`role:'Lead'`）与「面不对」是更靠前、
  // 更确定的拒绝理由，顺序不许被本条顶掉（既有断言逐字钉住这一点）。
  if (spec.主体 === undefined || spec.主体 === null) {
    const 拒 = new Denied(
      '宪章 身份停用 = 最严（§12.2）：主体只能由宿主显式给出',
      '`spec.主体` 缺席：主体必须由宿主显式给（工具面/命令面 = `agentSubject(exec)`，路由面 = 设置页主体）。'
        + '不许从 `args.role` / `args.实例` 推断 —— 那样只要知道一个在册实例的 id 就能成为它。',
      {
        requireAuthority: '主权者',
        howToChange: '由宿主把主体显式传进 `runAction({ 主体 })`（内核 `mind` 工具与 `/mind` 命令本来就传了；漏传的调用点补上即可）。',
        detail: { 缺什么: 'spec.主体', 被拒的自报字段: { role: args.role ?? null, 实例: args.实例 ?? null } },
      },
    );
    await 记动作拦截(org, { 主体: null, 项目, args, error: 拒 });
    throw 拒;
  }
  let 主体 = spec.主体;
  if (args.action === 'goal_decide' || args.action === 'budget_decide') {
    // 命令面是宿主传入的事实；参数不能把工具变为人侧。准备与执行共用同一主权者主体。
    主体 = await org.intervention.以人侧身份({ 通道: `/mind ${args.action}`, 执行: (主权者) => 主权者 });
  }
  // 自报的岗位不许直接变身份（B3）：成员/复核者的权来自身份档案里的实例，
  // 档案里没有、不在岗、或岗位对不上，一律按最严拒绝——与策略引擎的 §12.2 判定同口径。
  if (主体.kind === '成员') {
    const member = (await org.registry.identity()).members[主体.id];
    if (!member || member.status !== '在岗' || (主体.roleId && member.岗位 !== 主体.roleId)) {
      // 缺口1A（主权者批准 2026-10-12）：未登记主体的拦截也要入账——此前 spawn 成员到
      // registry_assign 之间组织账本全盲，「陌生主体敲过门」完全看不见。
      // 只记主体 id + 动作名，**不记入参内容**（防泄密：入参可能带敏感正文）；
      // 入账失败不许盖过拦截本身（与 policy #auditFault 同口径：账本坏了探针会见红）。
      try {
        await org.audit.append({
          动作: '身份未登记拦截',
          主体: { id: 主体.id, kind: 主体.kind },
          对象: { id: args.action ?? null, kind: '动作' },
          依据: '宪章 身份停用 = 最严（§12.2）',
          结果: '拒绝',
        });
      } catch {
        /* 入账自身失败只能吞：拦截是主行为，账本坏了审计链探针会见红。 */
      }
      throw new Denied(
        '宪章 身份停用 = 最严（§12.2）',
        `岗位身份必须来自身份档案：${主体.id}（${主体.roleId ?? '未登记'}）在档案里${
          member ? `状态为 ${member.status}、岗位 ${member.岗位}` : '没有登记'
        }。`,
        {
          requireAuthority: '主权者',
          howToChange: '由 Lead 先在角色注册表登记该实例（registry_assign），或改用已登记的在岗实例执行。',
        },
      );
    }
    // （v2 · 2026-10-18 复核者降级：R02 的「入口解析成复核者主体」改为**回填档案岗位**——
    // 复核员岗实例保持 {kind:'成员'}，但 roleId 取档案真源补全（teammate 形状的会话派生
    // 主体不自陈岗位）。其只读/禁写边界由策略引擎 #preGrantBoundary 按 roleId 判，
    // 单一判定点不变。）
    主体 = { ...主体, roleId: member.岗位 };
    // 补修I：会审参与实例的动作面闭名单（只从档案真源读绑定，不认自报；预给实例无绑定⇒不收紧）。
    会审参与动作闸({ subject: 主体, args, 绑定: member.会审绑定 ?? null, 项目 });
  }
  // ── v2 口述收敛 2026-10-18 条目10：Lead 也钉卡版本，且**自治写**必须真就绪 ──────
  // 修前这里 `try { cardOf } catch {}` 把「快照读不到」静默吞成「没有卡版本」继续写，
  // 加上内核只 warn 的出生登记 ⇒ 未钉版 / 已封存 / 钉版快照损坏的 Lead 照样写自治档。
  // 现在的判据（单源 是写动作/ACTIONS）：
  //  - **写动作 + 工具面（模型的手）**：必须在册在岗 + 钉版摘要可读，否则 fail-closed；
  //  - **诊断读**：读数缺失只作为 `钉版读数` 随响应返回，不挡读（否则坏了就看不见自己坏了）；
  //  - **命令/路由面**：那是人侧的入口（`/mind` 输入框 / 同源设置页），不是模型参数，
  //    不拿模型面的闸去挡人；它的入账主体与依据照旧（设置页 ≠ 活 Lead 实例）。
  let 钉版读数 = null;
  if (主体.kind === 'Lead') {
    const 工具面 = 面 === 'tool';
    const 写 = 是写动作(args.action);
    const 拒因 = (原因) => new Denied(
      'v2 条目10 · Lead 自治写必须先钉版（在册在岗 + 钉版摘要可读）',
      `Lead 实例 ${主体.id} 的钉版读数不可用：${原因}。自治写不做「先写后补钉」——写动作一律 fail-closed；status / workbench / audit 等诊断读仍可用。`,
      {
        requireAuthority: '主权者/Lead',
        howToChange: '先修好 Lead 岗位卡与身份档案（Lead 实例在岗、钉版快照可读），或由主权者重新登记 Lead 实例；读面用 status / workbench / audit_tail 诊断。',
        detail: { 实例: 主体.id, 动作: args.action, 写动作: 写, 原因 },
      },
    );
    try {
      const identity = await org.registry.identity();
      const member = identity?.members?.[主体.id];
      const 钉 = await org.registry.cardOf(主体.id);
      const 摘要 = 钉?.卡版本?.摘要 ?? null;
      // registry 的合同（2026-10-18 收紧）：cardOf 对「不是就绪」必须给 `就绪:false` + 原因，
      // 对真正可用的钉版给 `就绪:true`。**没有可判读数 = unknown ⇒ 写也拒**——
      // 不许「缺关键位就默认 ready」，那正是这次审计要收的口子。
      const 原因 = !member
        ? '身份档案里没有这个 Lead 实例（未登记）'
        : member.status !== '在岗'
          ? `Lead 实例状态为 ${member.status}（不是「在岗」）`
          : 钉?.就绪 === false
            ? (钉?.原因 ?? 'registry 报未就绪')
            : 钉?.就绪 !== true
              ? 'registry 没给可判的钉版就绪读数（unknown ⇒ 按未就绪处理）'
              : !摘要
                ? '钉版摘要缺失'
                : null;
      if (摘要) 主体 = 钉版主体(主体, 摘要);
      钉版读数 = { 实例: String(主体.id), 在岗: member?.status === '在岗', 卡版本: 摘要, 就绪: 原因 === null, ...(原因 === null ? {} : { 未就绪: true, 原因 }) };
      if (原因 !== null && 工具面 && 写) throw 拒因(原因);
    } catch (error) {
      if (error instanceof Denied) throw error;
      const 原因 = `钉版/身份读数读不到：${error instanceof Error ? error.message : String(error)}`;
      钉版读数 = { 实例: String(主体.id), 在岗: null, 卡版本: null, 就绪: false, 未就绪: true, 原因 };
      if (工具面 && 写) throw 拒因(原因);
    }
  }
  let 结果;
  try {
    // v2（口述收敛 2026-10-18 条目22）·跨项目闸（单点收口）：project 参数会整条动作换项目
    // （:251），成员实例一律不许换（写读同拒——成员只读本任务项目）；Lead/主权者可换，
    // 记忆写的「依据必填」在 memory_write 里按 会话项目≠项目 判。闸放这里而不是散进各
    // handler：漏一个 handler 就是一条侧门。
    if (typeof args.project === 'string' && args.project && args.project !== spec.项目 && 主体.kind === '成员') {
      throw new Denied('v2 · 成员禁止跨项目（条目22）', `成员实例的读/写都限定在会话项目（${spec.项目}）；跨项目是 Lead/主权者的面，无例外。`, {
        requireAuthority: 'Lead',
        howToChange: '需要跨项目的记忆/数据：报给 Lead，由 Lead 带依据执行。',
        detail: { 目标项目: args.project, 会话项目: spec.项目 },
      });
    }
    if (args.action === 'task_create') {
      const 关系字段 = TASK_RECOVERY_RELATION_FIELDS.filter((key) => Object.hasOwn(args, key));
      if (关系字段.length > 0) throw new InvalidBody(`task_create 不接受正式恢复关系字段：${关系字段.join('、')}。请先 task_close，再用 task_successor 创建唯一正式后继。`, { detail: { 字段: 关系字段 } });
    }
    if (['task_close', 'task_successor'].includes(args.action) && Object.hasOwn(args, '执行计划')) {
      throw new InvalidBody('恢复执行计划只能由领域服务准备并在内部传递，不能从工具或命令参数注入。');
    }
    if (args.action === 'memory_lifecycle' && Object.hasOwn(args, '反馈引用') && !['Lead', '主权者'].includes(主体.kind)) throw new Denied('知识负反馈处理 · 仅治理身份', '附反馈引用的知识处置只向当前真实Lead或主权者开放，普通成员和复核员不能借引用扩大处置资格。');
    const 跑 = (跑入参, 跑项目, 执行计划 = null) => handler({ org, 项目: 跑项目, 会话项目: spec.项目, subject: 主体, args: 跑入参, 面, 宿主: spec.宿主, 执行计划 });
    结果 = await (async () => {
      const 是写 = 是写动作(args.action);
      const 审批引用 = 是写 && typeof args.审批引用 === 'string' && args.审批引用.trim() ? args.审批引用.trim() : null;
      if (审批引用) {
        // 重放：只认**冻结请求**（入参与步骤计划都与记录逐字比），执行用的也是冻结入参。
        let 计划;
        try {
          计划 = await 介入计划Of({ org, 项目, action: args.action, args, 宿主: spec.宿主, subject: 主体 });
        } catch (error) {
          // 领域准备现在先判业务可执行性；旧批准不能把已派发/已完成的创建重新变成合法创建。
          if (args.action === 'member_spawn' && (error instanceof InvalidBody || error.code === 'MEMBER_SPAWN_OPERATION_EXISTS')) throw new Denied('法律 介入度 · 放行不可用（§4/v2 条目14/17）', `审批引用不能用于当前成员创建：领域计划已不可执行——${error.message}`, {
            requireAuthority: '主权者', howToChange: '核对原请求和已创建实例；不要重复创建。确需新工作时另建合法任务并重新申请。', detail: { 状态: '计划不可执行', 请求id: 审批引用 },
          });
          throw error;
        }
        const 放行 = await org.intervention.校验放行({ 请求id: 审批引用, subject: 主体, action: args.action, 入参: args, 步骤: 计划?.步骤 ?? null });
        if (!放行.ok) {
          throw new Denied('法律 介入度 · 放行不可用（§4/v2 条目14/17）', `审批引用 ${审批引用} 不能用于本次调用：${放行.状态}${放行.原因 ? `——${放行.原因}` : ''}`, {
            requireAuthority: '主权者',
            howToChange: '核对请求状态（设置页「待审批」）；要新的执行就重新发起原动作，由主权者重新批准。',
            detail: { 状态: 放行.状态, 请求id: 审批引用 },
          });
        }
        const 冻结项目 = 放行.冻结.项目 ?? 项目;
        const 冻结入参 = { ...放行.冻结.入参, action: args.action, project: 冻结项目 };
        let 业务已完成 = false;
        let 业务回执 = null;
        try {
          const 回 = await 以放行上下文({ 原主体: 主体.id, 请求id: 审批引用, 步骤: 放行.冻结.步骤 }, () => 跑(冻结入参, 冻结项目, 计划?.执行计划 ?? null));
          业务回执 = 回;
          业务已完成 = true;
          await org.intervention.记完成({ 请求id: 审批引用, 主体, 占用行: 放行.占用, 项目: 冻结项目 });
          return 回;
        } catch (error) {
          if (业务已完成) throw new Fault('APPROVAL_COMPLETION_AUDIT_FAILED', '批准动作已执行成功，但审批完成记账失败；不要重复执行原动作。', {
            cause: error, detail: { 请求id: 审批引用 },
            outcome: { 提交状态: '已提交', 可重试: false,
              恢复指引: '按请求id核对审批占用记录及业务真源，补记审批完成事实；不要重放原动作，也不要把记账失败当作业务失败。',
              已确认阶段: [{ 阶段: '批准动作已完成', 项目: 冻结项目, 请求id: 审批引用 }, ...动作提交凭据(args.action, 业务回执, 冻结项目)] },
          });
          try {
            await org.intervention.记失败({ 请求id: 审批引用, 主体, 占用行: 放行.占用, 原因: 错误信息(error), 项目: 冻结项目 });
          } catch (报告错误) {
            throw new Fault(error.code ?? 'APPROVAL_REPLAY_FAILED', `${错误信息(error)}；介入失败记账也失败：${错误信息(报告错误)}`, {
              detail: { ...error.detail, 请求id: 审批引用, 介入失败记账错误: 错误信息(报告错误) },
              outcome: error.outcome ?? { 提交状态: '未知', 可重试: false,
                恢复指引: '核对审批占用记录及业务真源；原动作和失败记账均未取得完整回执，不要自动重放。',
                已确认阶段: [{ 阶段: '审批已占用', 项目: 冻结项目, 请求id: 审批引用 }] },
            });
          }
          throw error;
        }
      }
      // 有完整计划的宏动作：**副作用之前**整单预判；会被拦就挂起整份计划，不先做半截。
      const 计划 = 是写 ? await 介入计划Of({ org, 项目, action: args.action, args, 宿主: spec.宿主, subject: 主体 }) : null;
      if (计划 && 计划会挂起({ org, subject: 主体, 项目, 计划 })) {
        const 档位 = org.policy.intervention();
        const 请求 = await org.intervention.记请求({ subject: 主体, action: args.action, args, 目标: null, 项目, 档位, 规则: `法律 介入度 · ${档位}（§4）`, 步骤: 计划.步骤 });
        throw new NeedsApproval('法律 介入度 · 挂起（§4/v2 条目14/17）', `本部署介入度为「${档位}」：该动作的完整步骤计划（${计划.步骤.length} 步）里有需要主权者先放行的写；整单在执行前挂起，未发生任何副作用。`, {
          requireAuthority: '主权者',
          howToChange: `等主权者批准后，原申请者带 审批引用=${请求.请求id} 重试原动作（执行的是冻结请求，不再逐门重新挂起）。`,
          detail: { 介入挂起: true, 档位, 请求id: 请求.请求id, 步骤数: 计划.步骤.length },
        });
      }
      try {
        return await 跑(args, 项目, 计划?.执行计划 ?? null);
      } catch (error) {
        // 没有计划器的写动作：被拦时按「这一笔写」登记单步请求，重放仍走冻结入参。
        if (error instanceof NeedsApproval && error.detail?.介入挂起 === true && !error.detail?.请求id) {
          const 步 = {
            动作: error.detail.动作 ?? 'write',
            目标: { ...(error.detail.目标 ?? {}), 新: error.detail.动作 === 'create' },
            说明: '本次被拦下的写',
          };
          const 请求 = await org.intervention.记请求({
            subject: 主体,
            action: args.action,
            args,
            目标: error.detail.目标 ?? null,
            项目,
            档位: error.detail.档位 ?? org.policy.intervention(),
            规则: error.rule,
            步骤: [步],
          });
          throw new NeedsApproval('法律 介入度 · 挂起（§4/v2 条目14/17）', error.message, {
            requireAuthority: error.requireAuthority ?? '主权者',
            howToChange: `等主权者批准后，原申请者带 审批引用=${请求.请求id} 重试原动作（执行的是冻结请求）。`,
            detail: { ...(error.detail ?? {}), 请求id: 请求.请求id },
          });
        }
        throw error;
      }
    })();
    // R07（审查 2026-10-16）：成员可达的任务写响应走安全呈现。修前动作层把完整节点
    // （tasks.get 全量投影，含所有人的 独立答案/结论层）直接当 DTO 返回——未齐卷的
    // 独立会审里 B 合法调 task_pending 就能读到 A 的私密结论（审查实证 repro-state #1-2；
    // 第二人 submit 的返回值同族）。复核员岗/Lead/主权者不遮：复核员要看分歧清单，
    // 盲评防的是参与者互看（与 bus 读面遮罩同口径）；揭名（交齐/开讨论）后原样。
    // （v2 · 2026-10-18：复核员是成员 kind，遮罩豁免按 roleId=复核员 判。）
    if (主体.kind === '成员' && 主体.roleId !== '复核员' && 结果?.节点 && typeof 结果.节点 === 'object' && !Array.isArray(结果.节点)) {
      结果 = { ...结果, 节点: 成员可达节点(结果.节点, 主体) };
    }
  } catch (error) {
    // 缺口1B（2026-10-12 评审）：服务层闸抛的 Denied 也要入账（策略引擎自己的拒绝
    // 带 已入账 标记，这里跳过不双记）。
    await 记动作拦截(org, { 主体, 项目, args, error });
    throw error;
  }
  const 响应 = { action: args.action, 项目, 主体: { id: 主体.id, kind: 主体.kind, roleId: 主体.roleId ?? null }, ...结果 };
  // 诊断读保留钉版读数（未就绪时随响应带原因）：坏了要看得见，不静默、也不挡读。
  // 只挂在**工具面**（模型侧）响应上：命令/路由面是与 `/mind presence` 同一份 JSON 契约，
  // 多出来的键会打破「同形」比对（host-routes 逐字段钉着）；且人侧入口不需要这层模型诊断。
  if (面 === 'tool' && 钉版读数 && 钉版读数.就绪 === false) 响应.钉版读数 = 钉版读数;
  return 响应;
}

/** 每个动作一个函数；键名即 action 名。 */
function requireExperiments(host) {
  if (!host?.reviewExperiments) throw new Fault('EXPERIMENT_NOT_WIRED', '冻结实验服务未接线或部署配置不可用；不回退通用执行。');
  return host.reviewExperiments;
}

const HANDLERS = {
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
    if (!args.target?.kind) throw new InvalidBody('policy_check 需要 target.kind');
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
    return { 判定: decision, 说明: '拒绝必须带可执行理由：哪条规则 + 改它要什么授权。' };
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
    return { 节点: await org.tasks.create({ subject, 项目, 描述: args.描述, 负责人: args.负责人, 判据: args.判据, 依赖: args.依赖, ...(args.复核对象 != null ? { 复核对象: args.复核对象 } : {}) }) };
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
    if (!(复核对象引用(节点).length > 0 || (节点.负责人 ?? []).includes('复核员'))) {
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
    return { 节点: await org.tasks.submit(args.id, { subject, 项目, 产出物引用: args.产出物引用, 结论: args.结论, 结论层: args.结论层, 反例面: args.反例面, 知识候选: args.知识候选, ...(Object.hasOwn(args, '采用知识') ? { 采用知识: args.采用知识 } : {}) }) };
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
    const 节点 = await org.tasks.accept(args.id, { subject, 项目, 票: args.票, 依据: args.依据 });
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
   * 输出是**白名单投影**：只给复核对口径所需的最小字段集。绝不携带 独立答案 / 结论 /
   * 讨论 / 复核经过——他人未揭名答案不因「复核需要」从这里泄露（盲评边界不在此开口；
   * 复核员要看全量用 workbench，那里有按角色的既有切片语义）。
   */
  async task_criteria({ org, 项目, subject, args }) {
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
    if (subject.kind === '成员' && args.类 === '知识' && subject.roleId !== '复核员') {
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
      条目: await org.memory.remember({
        subject,
        类: args.类,
        内容: args.内容,
        来源,
        项目: 写入项目,
        岗位: args.岗位,
        标签: args.标签,
        ...(Object.hasOwn(args, '知识说明') ? { 知识说明: args.知识说明 } : {}),
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

  async memory_lifecycle({ org, 项目, subject, args, 执行计划 }) {
    const op = args.op;
    const 反馈参数 = Object.hasOwn(args, '反馈引用') ? { 反馈引用: args.反馈引用, 反馈执行计划: 执行计划 } : {};
    if (Object.hasOwn(args, '反馈引用') && !执行计划) throw new Fault('KNOWLEDGE_FEEDBACK_PLAN_MISSING', '缺少领域准备的反馈执行计划，未追加知识状态或创建替代知识。');
    // invalidate / demote / overturn 同病修复（2026-10-12）：成员在任务内处置自己记的条目
    // （§7「错误/过期/冷/被推翻」）是常规动作，与 memory_write 一样要透传任务上下文。
    // purge / promote 不透传：物理删除已被处置表闸收紧（敏感声明/主权者），晋升是 Lead 语义。
    if (op === 'invalidate') return { 结果: await org.memory.invalidate(args.id, { subject, 项目, 原因: args.原因, 任务: await 取任务上下文({ org, 项目, args }), ...反馈参数 }) };
    if (op === 'demote') return { 结果: await org.memory.demote(args.id, { subject, 项目, 原因: args.原因, 任务: await 取任务上下文({ org, 项目, args }), ...反馈参数 }) };
    if (op === 'overturn') return { 结果: await org.memory.overturn(args.id, { subject, 项目, 新条目: args.新条目, 理由: args.原因, 任务: await 取任务上下文({ org, 项目, args }), ...(Object.hasOwn(args, '知识说明') ? { 知识说明: args.知识说明 } : {}), ...反馈参数 }) };
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

  async capability_list({ org, args }) {
    const 能力 = await org.capability.list({ 岗位: args.岗位, 来源: args.来源 });
    // 剥本机绝对路径（2026-10-14 审查 P2-17）：与 workbench 投影「path 不许带出」同口径——
    // 服务层内部可用 path，回给模型面的读数不许带（部署目录结构不外泄，同 errors.js 脱路径）。
    return { 能力: 能力.map(({ path: _p, ...rest }) => rest) };
  },

  async capability_resolve({ org, subject, args }) {
    // 契约B（2026-10-09）：解析也过唯一判定点（主体来自 runAction 的主体链）。
    const 解析 = await org.capability.resolve({ subject, 名: args.名 });
    return { 解析: { ...解析, 条目: (解析.条目 ?? []).map(({ path: _p, ...rest }) => rest) } };
  },

  async capability_read({ org, args }) {
    // 缺 id 先响亮指路（2026-10-11 跑通测试 P3）：否则报「能力库里没有 undefined」，
    // 把人引向「库里缺条目」的错方向——按 schema 的 名 参数传参就会走到这。
    if (!args.id) throw new InvalidBody('capability_read 需要 id（能力名）；名 只用于 capability_resolve', { missing: ['id'] });
    const 条目 = await org.capability.read({ id: args.id, 来源: args.来源 });
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

    const 退役实例 = 会审退役适配器({ org, subject, 宿主 });
    let 序号 = 0;
    const 创建参与者 = async ({ 会审, 项目: 跑项目, 问题: 跑问题, 资料: 跑资料, 岗位, 来源会话 }) => {
      序号 += 1;
      const 名 = 规范成员名(`会审-${岗位}`, `${Date.now().toString(36).slice(-4)}${序号}`);
      const 待命书 = [
        `你是数字组织会审参与实例（会审 ${会审}，项目 ${跑项目}），现在处于启动自检阶段。`,
        '第一步：调用 mind action=status 确认主体；实例尚未登记时被拒是预期行为，至多重试一次，并记住拒绝里报出的真实实例 id。',
        '第二步：不要开始任何业务工作。回一句启动确认即结束本轮，等待 Lead 的会审任务书。',
      ].join('\n');
      const 创建前 = (await org.registry.identity()).members ?? {};
      const 执行体 = await 起执行体({ 宿主, 方式, 名, 描述: `会审参与·${岗位}·${会审}`, 待命书, 模型路由 });
      if (Object.hasOwn(创建前, 执行体.实例)) {
        throw new Fault('COUNCIL_CREATE_DUPLICATE_ID', `宿主返回已有身份 ${执行体.实例}：不改绑、不封存、不停用预给或别场实例。`);
      }
      const 停 = () => 停执行体({ 宿主, 方式, agent: 执行体.agent, 实例: 执行体.实例, 团队名: 执行体.团队名, 名, 响亮: true });
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
    const 退役实例 = 需退役.length > 0 ? 会审退役适配器({ org, subject, 宿主, 实例集: 需退役 }) : null;
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
  // 适配器直调服务不会自动过 tools 管线，所以每个入口都在这里显式过同一道授权闸。

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
  async policy_reload({ org, 项目, subject }) {
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
    const 前 = org.policy.describe();
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
    const 补偿停用 = () => 停执行体({ 宿主, 方式, agent, 实例, 团队名, 名 });
    const journal = createMemberSpawnJournal({ org, project: 项目, subject, plan: 计划 });
    try { await runMemberSpawnStages(计划, {
      spawn: async () => {
        await recheckMemberSpawnPlan(计划);
        const intent = await journal.begin();
        执行体 = await 起执行体({
          宿主,
          方式,
          名,
          描述: `组织成员·${args.岗位}·${args.节点}`,
          待命书,
          模型路由,
          拟用实例: intent.拟用实例,
        });
        ({ 实例, 团队名 } = 执行体);
        await journal.record('host_returned', { 实例, 初始消息id: 执行体.初始消息id, 团队名 });
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

  /** 请求中断一个在册实例的当前回合（Team 走 interrupt(target)，普通走 subagents.interrupt）。 */
  async member_stop({ org, 项目, subject, args, 宿主 }) {
    要求授权({ 宿主, subject, 项目 });
    const 实例 = String(args.实例 ?? '').trim();
    if (!实例) throw new InvalidBody('实例必填。', { missing: ['实例'] });
    const agent = 宿主?.agent;
    if (!agent) throw new Fault('MEMBER_STOP_NO_AGENT', '宿主没有传真实 Agent。');
    if (!(await org.registry.identity()).members[实例]) throw new InvalidBody(`实例 ${实例} 不在组织名册。`);
    const team行 = 查Team名(宿主, agent, 实例);
    if (team行) {
      return requestExecutionInterrupt({ host: 宿主, mode: 'team', agent, id: 实例, teamName: team行.name });
    }
    if (宿主.subagents) {
      return requestExecutionInterrupt({ host: 宿主, mode: 'subagent', agent, id: 实例 });
    }
    throw new Fault('MEMBER_STOP_NO_CHANNEL', `实例 ${实例} 不在 Team 名册，宿主也没有子会话服务。`);
  },

  /** 在册实例 × Team 名册 × 普通子会话 的合并读数：按真实名册分流，不猜 id。 */
  async member_list({ org, 项目, 会话项目, subject, 宿主 }) {
    return listExistingMembers({ org, project: 项目, sessionProject: 会话项目, subject, host: 宿主 });
  },
};

/**
 * 「线程命中开过讨论段的节点 ⇒ 拒」——`bus_send` 的讨论线程闸。
 *
 * 为什么必须与落线侧同源：动作面往线程落消息的手现在只剩 `bus_send` 一只（`bus_unlock`
 * 已随 v2 条目18 退役）；判据抄在哪个 handler 里、就只有那个 handler 受保护，所以这里
 * 收成一处、只留一个入口。撤掉这道调用，历史讨论段的「只读」立刻失守。
 *
 * 判据（**精确到「开过讨论段」这一档**）：
 *  - 线程命中节点 **且** `node.讨论` 存在 ⇒ `Denied`。讨论**已收敛**照样拒（子状态不删，
 *    收敛后的发言在 `debate_say` 那边也会被拒 —— 动作面不开口子）；
 *  - 普通线程（根本不是节点 id / 没有讨论段的节点）⇒ 返回 `null`，调用方照旧往下走。
 *    历史独立会审节点的**非讨论**线程另有服务层闸（`bus.send` 对 模式=独立会审 恒拒），
 *    所以这里放行不等于旧账可写。
 *
 * 命中的键（批c 补漏 · P3）：走 `线程等价键()`（`src/paths.js`，落线路径 `busThread` 的等价类
 * 就在那儿定义）—— **不许**用精确键：修前判定是精确键而落线走文件系统（NTFS 大小写不敏感），
 * 于是 `线程: 节点id.toUpperCase()` 判定 miss ⇒ 放行，而消息**落进同一个文件**
 * （实测 `readRaw(真 id)` 读得到，且类型闸一起废：连 `交卷` 都收）。
 *
 * 只判**落点**，不判内容：文案上的类型闸（`DEBATE_SAY_TYPES`）取自 `src/debate.js` 的唯一源。
 *
 * @param {{ org: object, 项目: string, 线程: string, 入口: 'bus_send' }} spec
 * @returns {Promise<null>} 没命中讨论线程 ⇒ `null`（调用方继续）；命中 ⇒ 抛 `Denied`
 */
async function 拒讨论线程直灌({ org, 项目, 线程, 入口 }) {
  const 键 = 线程等价键(线程);
  // v2（条目18）：会审讨论线程 = `会审-{councilId}`。讨论开启后该线程只许 debate_say
  // 落线（类型闸/预算闸/发言权都在服务层）；直灌会绕过全部三道闸。判据同源：
  // 先精确、后等价类（NTFS 大小写不敏感的落线等价类在 paths.js 定义）。
  if (键.startsWith(线程等价键(COUNCIL_THREAD_PREFIX))) {
    const councilId = 线程.slice(COUNCIL_THREAD_PREFIX.length);
    // 先精确、后等价类（与下方历史节点分支同一把尺）：NTFS 落线大小写不敏感，
    // `会审-{id}.toUpperCase()` 在文件系统上是同一个线程——精确 id 找不到不许放行，
    // 否则别名就绕过了类型闸/预算闸/发言权（旧 P3 旁路在会审面的复活）。
    const 等价 = 线程等价键(councilId);
    const 会审表 = await org.council.list({ 项目 });
    const 会审 = 会审表.find((v) => v.id === councilId) ?? 会审表.find((v) => 线程等价键(v.id) === 等价);
    if (会审 && ['讨论中', '已收敛'].includes(会审.状态)) {
      throw new Denied(
        '会审 · 讨论线程的发言只走 debate_say',
        `线程 ${线程} 是会审 ${councilId} 的讨论线程（状态 ${会审.状态}）：` +
          `讨论发言只能经 debate_say 落线——那里有类型闸（${DEBATE_SAY_TYPES.join(' / ')}）、` +
          '两道预算闸（每轮消息数 / 每人每轮字符）与发言权判据（仅参与者）。' +
          `${入口} 直灌会绕过全部三道闸，把参与者的预算占死。`,
        {
          howToChange: `改用 debate_say（id=${councilId}、类型 ∈ ${DEBATE_SAY_TYPES.join('/')}、内容=…）发言；只想看内容用 bus_read（读面不动）。`,
          detail: { 线程, 会审: councilId, 状态: 会审.状态, 入口 },
        },
      );
    }
    return null;
  }
  // 历史任务图讨论段（旧数据原地只读）：节点线程命中开过讨论段的节点照样拒。
  const 节点表 = await org.tasks.list({ 项目 });
  // 先精确、后等价类：精确命中优先（不改变「命中哪个节点」的既有语义），
  // 没命中再按落线侧的等价类找 —— 两个写法在文件系统上就是**同一个线程文件**。
  const 节点 = 节点表.find((n) => n.id === 线程) ?? 节点表.find((n) => 线程等价键(n.id) === 键);
  if (!节点?.讨论) return null;
  throw new Denied(
    '会审讨论段 · 讨论线程的发言只走 debate_say',
    `线程 ${线程} 是节点 ${节点.id} 的会审讨论线程（讨论段状态 ${节点.讨论.状态 ?? '未知'}）：` +
      `讨论发言只能经 debate_say 落线 —— 那里有类型闸（${DEBATE_SAY_TYPES.join(' / ')}）、` +
      '两道预算闸（每轮消息数 / 每人每轮字符）与发言权判据（参与者或强制反对者）。' +
      `${入口} 直灌会绕过全部三道闸，把参与者的预算占死。`,
    {
      howToChange: `改用 debate_say（id=${节点.id}、类型 ∈ ${DEBATE_SAY_TYPES.join('/')}、内容=…）发言；` +
        '只想看讨论内容用 bus_read（读面不动）。换轮 / 收敛由 Lead 走 debate_round / debate_converge。',
      detail: {
        线程,
        节点: 节点.id,
        讨论状态: 节点.讨论.状态 ?? null,
        参与者: 节点.讨论.参与者 ?? [],
        命中: 节点.id === 线程 ? '精确键' : `线程等价类（${键}）`,
        入口,
      },
    },
  );
}

/**
 * 【已上移 · 2026-10-16】复核员岗成员主体的档案解析原先只服务 task_review（649a4），
 * 审查报告 R02 判定该单点解析正是越权面（复核员岗成员在其余动作上按成员判 ⇒ 持任务即
 * 得普通业务写权）。解析已上移至 runAction 门② 的「统一可信角色解析」（见上），对全部
 * handler 与守卫生效；本函数随之删除，不留第二份实现——单一取数点在入口。
 */

/**
 * 成员可达的任务节点投影（R07 · 2026-10-16）：盲评期（独立会审未齐卷且未开讨论）只保留
 * **自己的**独立答案，他人的整段剔除并标注；揭名后原样（与 bus 盲评遮罩同一判定口径：
 * 全员已交 · 唯一源）。只服务 runAction 的响应呈现——业务内部（复核、状态机、归档）
 * 一律用节点本体，不经过这里。
 *
 * @param {object} node 任务节点本体（handler 返回的全量投影）
 * @param {{ id: string }} 成员 成员主体（只取 id 比对自己的答案）
 */
function 成员可达节点(node, 成员) {
  const 揭名 = node.讨论 || 全员已交(node);
  if (揭名) return node;
  return {
    ...node,
    独立答案: (node.独立答案 ?? []).filter((a) => String(a.成员) === String(成员.id)),
    // R09（2026-10-16）：历史代的答案在当前代盲评期同样遮蔽——归档不等于揭名，
    // 他人旧卷里的结论与当前轮的盲评边界同权。
    答案历史: (node.答案历史 ?? []).map((h) => ({
      ...h,
      独立答案: (h.独立答案 ?? []).filter((a) => String(a.成员) === String(成员.id)),
    })),
    盲评遮罩: true,
  };
}

/**
 * 读根路径规范化：realpath（junction/symlink/`..` 折到真实路径）+ Windows 大小写归一。
 * 与 guard 侧 `规范路径()` 同一口径——比较真实路径，不比输入字面串。
 * @param {string} 路径
 * @returns {string}
 */
function 规范读根(路径) {
  const 绝对 = resolvePath(String(路径));
  let 真 = 绝对;
  try { 真 = realpathSync(绝对); } catch { /* 不存在时返回词法路径；调用方另有 existsSync 闸 */ }
  return process.platform === 'win32' ? 真.toLowerCase() : 真;
}

/** 入审批计划前复用领域纯合同；非法声明与伪验证字段不能先制造介入请求。 */
function 断言记忆写入参数(args) {
  if (args.action === 'memory_write') {
    const 多余 = Object.keys(args).filter(key => !['action', 'project', 'role', '审批引用', '类', '内容', '来源', '依据', '命名空间', '来源引用', '岗位', '标签', '任务', '披露豁免', '知识说明'].includes(key));
    if (多余.length) throw new InvalidBody(`记忆写入含未知参数：${多余.join('、')}；验证状态、哈希及认证不能由调用者自报。`);
    const 说明 = normalizeKnowledgeContext(args.知识说明);
    if (说明 !== undefined && args.类 !== '知识') throw new InvalidBody('知识说明仅属于知识类，不能附在经历、偏好或作答上。');
  }
  if (args.action === 'memory_lifecycle') {
    const op = args.op;
    if (Object.hasOwn(args, '知识说明') && op !== 'overturn') throw new InvalidBody('知识说明只能随overturn提供给新替代知识；其他生命周期操作不能改写或静默忽略该说明。');
    const 允许 = ['action', 'project', 'role', '审批引用', 'id', 'op', '原因', '任务', ...(['invalidate', 'demote', 'overturn'].includes(op) ? ['反馈引用'] : []), ...(op === 'overturn' ? ['新条目', '知识说明'] : []), ...(op === 'purge' ? ['敏感'] : []), ...(op === 'promote' ? ['岗位', '披露豁免'] : [])];
    const 多余 = Object.keys(args).filter(key => !允许.includes(key));
    if (多余.length) throw new InvalidBody(`记忆处置含未知参数：${多余.join('、')}；验证状态、哈希及认证不能由调用者自报。`);
    if (Object.hasOwn(args, '知识说明')) normalizeKnowledgeContext(args.知识说明);
    if (Object.hasOwn(args, '反馈引用')) normalizeFeedbackReference(args.反馈引用);
  }
}

/**
 * 复核读域的**唯一取数点**（v2 条目4/6 · 2026-10-18 补修）。
 *
 * 复核员岗之外的读者返回 `null`（读域不生效，按各自原有边界）；复核岗则用**同一项目**的
 * 任务节点表现算 `review-scope.复核读域()`——不按 role 全量、不凭会话 cwd、不跨项目猜。
 * 所有模型可达读出口都从这里取，判据只在 review-scope.js 一处。
 *
 * @param {{ org: object, 项目: string, subject: object }} spec
 * @returns {Promise<object|null>}
 */
async function 复核读域For({ org, 项目, subject }) {
  return 取复核读域({ tasks: org.tasks, 项目, subject });
}

/**
 * 任务上下文透传的**唯一取数点**（2026-10-12 接口缺口修复）。
 *
 * 调用方在入参里声明「任务」（节点 id），这里从任务图取出**节点本体**交给服务层，
 * 由策略引擎 scopeOf 按节点负责人名单判定「任务内全权」——自报的 id 本身不承重
 * （传别人的节点，scopeOf 照样拒），所以这里不做任何权限判断，只做「取真节点」。
 *
 * 省略 ⇒ `null`（由策略引擎按「未声明任务上下文」判任务外，拒因指向调用方该补的入参）；
 * 给了 id 却取不到 ⇒ `InvalidBody` 响亮拒——不编一个空节点让它滑进策略引擎。
 *
 * @param {{ org: object, 项目: string, args: object }} spec
 * @returns {Promise<object|null>} 任务节点本体，或 null（未声明）
 */
async function 取任务上下文({ org, 项目, args }) {
  if (args.任务 === undefined || args.任务 === null || String(args.任务).trim() === '') return null;
  const 节点 = await org.tasks.get(String(args.任务), { 项目 });
  if (!节点) {
    throw new InvalidBody(
      `「任务」指的任务节点不存在：${args.任务}（项目 ${项目}）。` +
        '传你名下已派发/执行中的任务节点 id（workbench 能看到自己那片）；名下没有节点时由 Lead 先派发。',
      { detail: { 任务: args.任务, 项目 } },
    );
  }
  return 节点;
}

/**
 * 盲评遮罩（2026-10-12 评审 P2-6）：「独立会审交齐揭名前互不可见」原本只遮 workbench
 * 投影层，而 bus_read 原样放行 ⇒ 负责人往自己任务线程发的「交卷+结论」未交齐就被
 * 其他成员读到，盲评名存实亡。这里把同一条 §10 规矩补到总线读面。
 *
 * 命中形状：线程是**独立会审**节点的线程（判定键与落线同源：先精确、后 线程等价键）
 * 且未齐卷（全员已交 · 唯一源）且未开讨论段 ⇒ **成员读者**的消息里，别人的条目只留
 * 盲标（发件/内容不出，标 盲评遮罩:true），自己的照给。Lead / 复核者 / 主权者不受影响——
 * 盲评防的是参与者互看，不是组织记账；已交齐或开了讨论段（揭名后）不遮。
 *
 * @param {{ org: object, 项目: string, 线程: string, 读者: object, 消息: object[] }} spec
 * @returns {Promise<object[]>}
 */
async function 盲评遮罩({ org, 项目, 线程, 读者, 消息 }) {
  if (读者?.kind !== '成员' || !Array.isArray(消息) || 消息.length === 0) return 消息;
  const 键 = 线程等价键(线程);
  const 节点表 = await org.tasks.list({ 项目 });
  const 节点 = 节点表.find((n) => n.id === 线程) ?? 节点表.find((n) => 线程等价键(n.id) === 键);
  if (!节点 || 节点.模式 !== '独立会审' || 节点.讨论 || 全员已交(节点)) return 消息;
  // 名册与 workbench/openBlind 同源：已交独立答案的成员（集合语义，内部排序）。
  // 名单外的发言者（Lead/未交成员）按排序后的额外集合补标，绝不用消息到达顺序。
  const 名册 = [...new Set((节点.独立答案 ?? []).map((a) => a.成员).filter(Boolean))].sort();
  const 盲标表 = new Map(盲标分配(线程, 名册).map((e) => [e.id, e.盲标]));
  const 额外 = [...new Set(消息.map((m) => m.发件).filter((id) => id && id !== 'system' && !盲标表.has(id)))].sort();
  额外.forEach((id, i) => 盲标表.set(id, `成员 ${String.fromCharCode(65 + 名册.length + i)}`));
  let 遮罩序 = 0;
  return 消息.map((m) => {
    if (m.发件 === 读者.id || m.发件 === 'system') return m;
    // R08 存量面（第12代复核分歧1 · 2026-10-16 裁决=读面盲标化）：旧格式 id（msg-<线程>-<发件>-<正文前24字>）
    // 本身编码着发件人与正文前缀——白名单透传它等于遮了字段漏了 id（E2 实证）。真部署存量
    // 消息全是旧格式；洗账违「只增」，所以在**输出投影**里把这类 id 换成盲标：账本一字不动。
    // 新格式（msg-<uuid>）不含内容，原样透传（判据：新 id 行为不变）。
    遮罩序 += 1;
    const 旧格式泄露 = typeof m.id === 'string'
      && ((typeof m.发件 === 'string' && m.发件 && m.id.includes(m.发件))
        || (typeof m.内容 === 'string' && m.内容.length > 0 && m.id.includes(m.内容.slice(0, 12))));
    return {
      id: 旧格式泄露 ? `msg-盲标-${遮罩序}` : m.id,
      线程: m.线程,
      类型: m.类型,
      状态: m.状态,
      追加于: m.追加于,
      发件: 盲标表.get(m.发件),
      内容: '（盲评期：全员交齐揭名前，他人的消息内容不可见）',
      盲评遮罩: true,
    };
  });
}

/**
 * 拒绝他人任务线程的辅助见下方；这里先放调度入口共用的小工具。
 * 要求授权：member_* 动作的第一道闸——同一份 DelegationPolicy，与提示词/创建闸单源。
 * @param {{ 宿主?: { delegation?: object }, subject: object, 项目: string }} spec
 */
function 要求授权({ 宿主, subject, 项目 }) {
  return requireDelegation({ host: 宿主, subject, project: 项目 });
}

/**
 * 模型路由解析（member_spawn / debate_open 共用）：成对、推理档随路由、team 拒、不静默回落。
 * @param {object} args @param {'team'|'subagent'} 方式
 */
function 解析模型路由(args, 方式) {
  return parseModelRoute(args, 方式);
}

/** 创建、投递和清理能力必须在任何宿主副作用前齐备；不能 spawn 后才发现无消息/退役通道。 */
function 断言成员宿主就绪(宿主, 方式, 会审 = false) {
  return assertExecutionHost(宿主, 方式, 会审);
}

/**
 * 起执行体 —— **唯一宿主成员创建适配器**（member_spawn 与会审受管创建共用）。
 * 只负责宿主侧 spawn + 待命书，不登记、不绑定、不发开工书；失败阶段可判。
 */
async function 起执行体({ 宿主, 方式, 名, 描述, 待命书, 模型路由, 拟用实例 }) {
  return createExecution({ host: 宿主, mode: 方式, name: 名, description: 描述, standby: 待命书, modelRoute: 模型路由, reservedChildId: 拟用实例 });
}

/** 公共释放/中断调用失败交给上层合并报告；不把可选调用或请求回执冒充已停止。 */
async function 停执行体({ 宿主, 方式, agent, 实例, 团队名, 名, 响亮 = false }) {
  return releaseExecution({ host: 宿主, mode: 方式, agent, id: 实例, teamName: 团队名 ?? 名 });
}

/**
 * 登记 + 钉版 —— 唯一实例登记适配器（member_spawn 节点绑定 / 会审 会审绑定共用）。
 * 任何失败先停执行体，再抛带阶段的 Fault；返回实例钉住的卡（规程唯一来源）。
 */
async function 登记钉版({ org, subject, 岗位, 实例, 代次, 方式, 绑定, 授权引用, 停, 失败补偿 = null }) {
  let 补偿回执 = null, 补偿错误 = null;
  const 补偿 = async () => {
    try { 补偿回执 = await (失败补偿 ?? 停)?.(); return null; }
    catch (error) { 补偿错误 = error; return 错误信息(error); }
  };
  try {
    await org.registry.assign({
      subject,
      岗位,
      实例,
      授权引用,
      代次,
      ...(绑定?.节点 ? { 节点: String(绑定.节点) } : {}),
      ...(绑定?.会审 ? { 会审: 绑定.会审 } : {}),
    });
  } catch (error) {
    const 补偿失败 = await 补偿();
    throw new Fault('MEMBER_SPAWN_ASSIGN_FAILED', `实例 ${实例} 已创建但登记失败：${错误信息(error)}。已尝试清理该实例（登记审计失败时可能已经落盘）。`, {
      detail: { 阶段: 'registry_assign', 实例, 方式, 岗位, 原因: 错误信息(error), 补偿失败 },
      outcome: { 提交状态: '部分提交', 可重试: false,
        恢复指引: '宿主已返回实例标识，登记是否落盘及补偿结果须分别核对；释放或中断不删除持久子会话。不要重复创建，确认实例归属、当前登记和卡状态后再决定恢复方式。',
        已确认阶段: [{ 阶段: '宿主返回实例标识', 实例 }, ...(error.outcome?.已确认阶段 ?? []),
          ...宿主清理凭据(补偿回执, { 实例 }), ...(补偿错误?.outcome?.已确认阶段 ?? [])] },
    });
  }
  let 钉;
  try {
    钉 = await org.registry.cardOf(实例);
    if (钉?.就绪 !== true) throw new Error(钉?.原因 ?? 'registry 没给就绪读数');
  } catch (error) {
    const 封存错误 = await 补偿();
    throw new Fault('MEMBER_SPAWN_CARD_NOT_READY', `实例 ${实例} 已登记，但其岗位卡钉版未就绪（${错误信息(error)}）：不会发假开工书；已尝试停用${绑定?.会审 ? '并封存本次咨询实例' : ''}。`, {
      detail: { 阶段: 'card', 实例, 岗位, 就绪: 钉?.就绪 ?? null, ...(封存错误 ? { 封存错误 } : {}) },
      outcome: { 提交状态: '部分提交', 可重试: false,
        恢复指引: '实例已登记，但卡未就绪且已尝试补偿；核对登记、钉卡和宿主驻留状态，不能把中断或释放当作删除或回滚，不要重复 member_spawn。',
        已确认阶段: [{ 阶段: '实例登记完成', 实例 }, ...宿主清理凭据(补偿回执, { 实例 }), ...(补偿错误?.outcome?.已确认阶段 ?? [])] },
    });
  }
  return 钉;
}

/** 发成员书（member_spawn 开工书 / 会审任务书共用）。 */
async function 发成员书({ 宿主, 方式, agent, signal, 实例, 团队名, 内容 }) {
  return sendExecutionMessage({ host: 宿主, mode: 方式, agent, signal, id: 实例, teamName: 团队名, content: 内容 });
}

/** 钉卡 → 注入规程：L0/L1/能力引用/摘要（不内嵌能力正文）。 */
function 拼钉卡规程(钉卡) {
  const 钉段 = 钉卡?.段 ?? {};
  const 取段 = (...键) => 键.map((k) => 钉段?.[k]).find((v) => typeof v === 'string' && v.trim()) ?? '';
  return {
    钉L0: String(取段('个体L0', '个体L0 · 身份核心', '个体L0 · 身份核心（锁定）', '个体L0 · 身份')).trim(),
    钉L1: String(取段('个体L1', '个体L1 · 规则')).trim(),
    钉能力: (钉卡?.能力引用 ?? []).join('、'),
    摘要: String(钉卡?.卡版本?.摘要 ?? '').slice(0, 12),
  };
}

/** 逗号/数组参数 → 去重字符串清单（参与者/资料）。 */
function 参数列表(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，]/);
  return [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))];
}

/** 岗位参数 → **保序不去重**（重复 N 次 = N 个受管实例）。 */
function 岗位清单(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，]/);
  return raw.map((x) => String(x ?? '').trim()).filter(Boolean);
}

/**
 * 会审参与实例的动作面闭名单（补修I · 条目18「只咨询不干活」）。
 *
 * 只认实例档案上的 `会审绑定`（预给参与者没有绑定 ⇒ 本闸不收紧，原任务权不变）。
 * 允许：status / workbench / capability_list|read|resolve（能力/规范读取）、自己会审的
 * debate_answer/debate_say、**本会审线程**的 bus_read；其余动作（task_*、member_spawn、
 * bus_send、memory_*、registry_*、capability_publish、debate_open/unlock/round/converge…）全拒。
 * `capability_*` 是**显式名单**，不做前缀放行（publish 是写，不在名单里）。
 * bus_read 只到 `会审-{绑定.会审}`：作答中的答案不在总线（讨论线程解锁后才建），不会成为绕过
 * 盲评的第二读面；答案读面仍只走 council.list/workbench 的既有遮罩。
 */
const 会审咨询动作 = new Set(['status', 'workbench', 'capability_list', 'capability_read', 'capability_resolve']);

/**
 * 同步咨询动作边界，供真实动作入口与宿主工具闸共同使用；不写盘、不扩权。
 * @param {{subject: object, args: object, 绑定: object|null, 项目: string}} spec
 * @returns {void}
 * @throws {Denied} 绑定不可判、跨项目、跨场或非咨询动作。
 */
export function 会审参与动作闸({ subject, args, 绑定, 项目 }) {
  if (绑定 === undefined || 绑定 === null) return;
  if (typeof 绑定 !== 'object' || Array.isArray(绑定) || 绑定.无效
    || !['会审', '项目', '来源会话'].every((键) => typeof 绑定[键] === 'string' && 绑定[键].trim())
    || !Array.isArray(绑定.资料)) {
    throw new Denied('会审参与实例 · 绑定不可用（fail-closed）', `实例 ${subject?.id} 的会审绑定形状不合法（${绑定.无效}）：不能按普通成员放行动作，先交回 Lead 诊断。`, {
      requireAuthority: 'Lead',
      howToChange: '由 Lead 核对身份档案里的 会审绑定；坏形状不猜、不放行。',
      detail: { 实例: subject?.id ?? null, 无效: 绑定.无效 },
    });
  }
  if (项目 !== 绑定.项目 || (args?.project !== undefined && args.project !== 绑定.项目)) {
    throw new Denied('会审参与实例 · 只读绑定项目', `实例 ${subject?.id} 只服务项目 ${绑定.项目}：会话目录与 project 参数都不得扩大咨询范围。`);
  }
  const 动作 = String(args?.action ?? '');
  if (会审咨询动作.has(动作)) return;
  if (动作 === 'debate_answer' || 动作 === 'debate_say') {
    if (String(args?.id ?? '') === String(绑定.会审)) return;
    throw new Denied('会审参与实例 · 只服务绑定会审', `实例 ${subject?.id} 只绑定会审 ${绑定.会审}，不能把 ${动作} 投到 ${args?.id ?? '（缺 id）'}。`, {
      requireAuthority: 'Lead',
      howToChange: '在绑定的会审里作答/发言；要参与别场请由 Lead 另起受管参与实例。',
      detail: { 绑定会审: 绑定.会审, 请求会审: args?.id ?? null },
    });
  }
  if (动作 === 'bus_read') {
    const 本场 = 线程等价键(`${COUNCIL_THREAD_PREFIX}${绑定.会审}`);
    if (线程等价键(String(args?.线程 ?? '')) === 本场) return;
    throw new Denied('会审参与实例 · bus_read 仅本会审线程', `实例 ${subject?.id} 只能读会审 ${绑定.会审} 的讨论线程（会审-${绑定.会审}）；不作答中的答案读面。`, {
      requireAuthority: 'Lead',
      howToChange: '读本会审线程即可；答案与分歧请用 workbench 的会审区（走既有盲评遮罩）。',
      detail: { 绑定会审: 绑定.会审, 请求线程: args?.线程 ?? null },
    });
  }
  throw new Denied('会审参与实例 · 只咨询不干活（条目18）', `实例 ${subject?.id} 是会审 ${绑定.会审} 的临时参与实例：只可读/作答/讨论本场会审，不得执行 ${动作}（改业务、写记忆、再派活等一律不在咨询面）。`, {
    requireAuthority: 'Lead',
    howToChange: '只作答/讨论会审；要干活请由 Lead 按任务台账正常派活（另立实例）。',
    detail: { 动作, 绑定会审: 绑定.会审 },
  });
}

/**
 * 介入度「审批」档的宏计划完整性护栏（补修I · 与 F 的 approval-plan 唯一包装配合）。
 *
 * 为什么需要：审批包装只认 `approval-plan.js` 摊出的计划；若它还没有 debate_open /
 * debate_converge case，宏会先批 create 会审，再在 N 次身份登记/退役处逐道挂起，甚至在
 * host 已 spawn 之后才挂。这里在**任何 host 副作用之前**核对「我的 councilPlan 步数 ≤
 * approval-plan 摊出的步数」；不够就响亮拒，指路 F 补 case，绝不半执行。
 */
async function 断言会审计计划完整({ org, subject, 项目, 动作, args }) {
  if (org?.policy?.intervention?.() !== '审批') return;
  const 我计划 = await org.council.councilPlan({ 项目, 动作, args });
  const 应有 = 我计划?.步骤?.length ?? 0;
  if (应有 === 0) return;
  const 审批计划 = await 介入计划Of({ org, 项目, action: 动作, args });
  const 实有 = 审批计划?.步骤?.length ?? 0;
  if (实有 < 应有) {
    throw new Fault('COUNCIL_APPROVAL_PLAN_MISSING', `本部署介入度为「审批」：${动作} 的完整宏计划有 ${应有} 步（会审 + N 个实例登记/退役），但 approval-plan 只摊出 ${实有} 步。为避免「只批 create 会审、之后卡 N 次登记」或在已 spawn 后才挂起，已在任何 host 副作用前拒绝；请 F 在 approval-plan.js 加 ${动作} case（调 org.council.councilPlan）。`, {
      detail: { 动作, 应有, 实有, 介入度: '审批' },
    });
  }
}

/** 会审退役：seal → 当前驻留释放/中断请求；只由服务对本场 owned 实例调用。 */
function 会审退役适配器({ org, subject, 宿主, 实例集 = [] }) {
  const agent = 宿主?.agent ?? null;
  const 停机通道 = (实例) => {
    if (!agent) throw new Fault('COUNCIL_ADAPTER_NOT_READY', '收敛受管会审缺真实 Agent，已在写入前拒绝。');
    const 行 = 查Team名(宿主, agent, 实例);
    if (行 && typeof 宿主.agentTeams.interrupt === 'function') return () => releaseExecution({ host: 宿主, mode: 'team', agent, id: 实例, teamName: 行.name });
    if (!行 && typeof 宿主?.subagents?.drainContinuableChildren === 'function') return () => releaseExecution({ host: 宿主, mode: 'subagent', agent, id: 实例 });
    throw new Fault('COUNCIL_ADAPTER_NOT_READY', `实例 ${实例} 没有真实停机通道：不封存、不假报已停。`);
  };
  for (const 实例 of 实例集) 停机通道(实例);
  return async ({ 实例, 会审, 原因 }) => {
    const 停机 = 停机通道(实例);
    let 已封 = false;
    let 封错 = null;
    try {
      const 成员 = (await org.registry.identity()).members?.[实例];
      if (成员?.status === '在岗') {
        await org.registry.seal({ subject, 实例, 理由: 原因 });
        已封 = true;
      }
    } catch (error) {
      封错 = error;
    }
    let 停错 = null;
    let 停回执 = null;
    try {
      停回执 = await 停机();
    } catch (error) {
      停错 = error;
    }
    if (封错 || 停错) {
      throw new Fault('COUNCIL_RETIRE_FAILED', `会审 ${会审} 的实例 ${实例} 退役失败：${封错 ? `封存失败 ${错误信息(封错)}` : ''}${封错 && 停错 ? '；' : ''}${停错 ? `停机失败 ${错误信息(停错)}` : ''}。`, {
        detail: { 实例, 会审, 封错: 封错 ? 错误信息(封错) : null, 停错: 停错 ? 错误信息(停错) : null },
        outcome: { 提交状态: 已封 || 停回执 ? '部分提交' : '未知', 可重试: false,
          恢复指引: '分别核对组织封存记录和宿主释放/中断回执；未知停止状态不能据此自动接管。不要重放会审结论。',
          已确认阶段: [
            ...(已封 ? [{ 阶段: '组织身份已封存', 实例, 会审, 已封存: true }] : []),
            ...(停回执?.当前驻留已释放 ? [{ 阶段: '宿主当前驻留已释放', 实例, 会审, 当前驻留已释放: true }] : []),
            ...(停回执?.已请求中断 ? [{ 阶段: '宿主中断已请求', 实例, 会审, 已请求: true }] : []),
            ...(封错?.outcome?.已确认阶段 ?? []), ...(停错?.outcome?.已确认阶段 ?? []),
          ] },
      });
    }
    return { 已封, ...(停回执 ?? { 已停: null }) };
  };
}

/**
 * 调用宿主生命周期服务用的中止信号：优先接宿主的 exec.signal（官方工具同款取消链），
 * 取不到就给一个永不中止的新信号——服务内部 AbortSignal.any 会校验每一项，
 * 传 undefined/null 会以 "signals[0] is not of type AbortSignal" 拒绝（本机重启后实测）。
 * @param {{ signal?: unknown }} 宿主
 * @returns {AbortSignal}
 */
function 中止信号(宿主) {
  if (typeof AbortSignal !== 'undefined' && 宿主?.signal instanceof AbortSignal) return 宿主.signal;
  return new AbortController().signal;
}

/** @param {unknown} error @returns {string} */
function 错误信息(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 只剥传输字段；业务参数仍由领域白名单校验，计划仅取内部参数。 */
function 目标参数(args, subject, 项目, 执行计划) {
  const { action: _action, project: _project, 审批引用: _approval, ...入参 } = args;
  return { ...入参, subject, 项目, ...(执行计划 ? { 执行计划 } : {}) };
}

/** 只投影真实业务返回中的标识及明确回执，绝不展开正文。 */
function 动作提交凭据(action, result, 项目) {
  const 包装 = { budget_decide: '预算', goal_create: '目标', goal_revise: '目标', goal_progress: '目标', goal_complete: '目标', goal_link_task: '目标', goal_decide: '目标',
    memory_write: '条目', capability_publish: '能力', registry_assign: '实例', registry_seal: '结果', registry_revoke: '结果', bus_send: '消息', bus_deliver: '投递',
    debate_open: '会审', debate_answer: '会审', debate_unlock: '会审', debate_round: '会审', debate_converge: '会审' }[action];
  const row = result?.数据 ?? (包装 ? result?.[包装] : null) ?? result;
  if (!row || typeof row !== 'object') return [];
  if (action === 'budget_decide' && typeof row.目标 === 'string') return [{ 阶段: '目标预算配置已返回', 项目, 对象id: row.目标 }];
  if (action.startsWith('task_')) {
    const 节点 = row.节点 && typeof row.节点 === 'object' ? row.节点 : row;
    if (typeof 节点.id === 'string') return [
      { 阶段: '任务动作已返回', 项目, 任务: 节点.id },
      ...(typeof row.前序任务 === 'string' ? [{ 阶段: '正式后继的前序任务', 项目, 任务: row.前序任务 }] : []),
      ...(row.组织任务已终止 === true ? [{ 阶段: '组织任务已终止；宿主停止未确认且未取消在途工具', 项目, 任务: 节点.id }] : []),
    ];
  }
  const 实例 = typeof row.实例 === 'string' ? row.实例 : null;
  const 任务 = typeof row.节点 === 'string' ? row.节点 : typeof row.任务 === 'string' ? row.任务 : null;
  const 对象id = typeof row.id === 'string' ? row.id : null;
  const 消息id = typeof row.消息id === 'string' ? row.消息id : action.startsWith('bus_') ? 对象id : null;
  const 会审 = typeof row.会审?.id === 'string' ? row.会审.id : action.startsWith('debate_') ? 对象id : null;
  const 线程 = typeof row.线程 === 'string' ? row.线程 : null;
  return 实例 || 任务 || 消息id || 对象id || 会审 ? [{ 阶段: '业务标识已返回', 项目, 动作: action,
    ...(typeof row.操作?.操作id === 'string' ? { 操作id: row.操作.操作id } : {}),
    ...(对象id ? { 对象id } : {}), ...(实例 ? { 实例 } : {}), ...(任务 ? { 任务 } : {}), ...(会审 ? { 会审 } : {}),
    ...(线程 ? { 线程 } : {}), ...(消息id ? { 消息id } : {}), ...(row.已接收 === true ? { 已接收: true } : {}) }] : [];
}

/** 封存、驻留释放、中断请求是独立事实；没有终局停止证据就不产生已停止字段。 */
function 宿主清理凭据(receipt, refs) {
  return [
    ...(receipt?.已封 === true ? [{ 阶段: '组织身份已封存', ...refs, 已封存: true }] : []),
    ...(receipt?.当前驻留已释放 === true ? [{ 阶段: '宿主当前驻留已释放', ...refs, 当前驻留已释放: true }] : []),
    ...(receipt?.已请求中断 === true ? [{ 阶段: '宿主中断已请求', ...refs, 已请求: true }] : []),
  ];
}

/** 成员名规范：lower-kebab + 时间后缀（Team 名册全程查重，撞名会被服务拒绝）。 */
function 规范成员名(基名, 后缀) {
  const slug = String(基名).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'member';
  return `${slug}-${后缀}`;
}

/** 在真实 Team 名册里按实例 id 找成员行；不在册返回 null（不猜 id 前缀）。 */
function 查Team名(宿主, agent, 实例) {
  if (!宿主?.agentTeams || !agent) return null;
  try {
    return (宿主.agentTeams.listMembers(agent) ?? []).find((m) => m?.id === 实例 && m?.role === 'teammate') ?? null;
  } catch {
    return null;
  }
}

/**
 * 「线程命中任务节点 且 发件人既非负责人也非 Lead ⇒ 拒」——只挂 `bus_send`（㉖ · 2026-10-10 收口）。
 *
 * 依据：`mind\集体L1-法律\权限矩阵.md`「## 各件的写权限」——消息总线「谁能写」＝
 * **「任何在岗主体写自己线程的消息」**。「自己」这半格在实现里原本不存在：
 * `bus.send` 的策略 target（`src/bus.js` 的 `#写入目标`）只有
 * `{id, kind, authority, zone, domain, project}`，**没有「线程」这一维** ⇒ 策略引擎判不了
 * 「这是谁的线程」，成员可往**别人的任务线程**落消息（probe 实测：放行且真落线，
 * `docs/设计债-2026-10-09.md` ㉖）。这是「文档口径宽于实现」的 fail-open 缺口，本函数补上。
 *
 * 边界（有意取舍，写清楚）：
 *  - **只挂 `bus_send`**（发言场景）。`bus_unlock` 已随 v2 条目18 退役（模型面没有这只手），
 *    旧独立会审线程的写由服务层 `bus.send` 墓碑守卫恒拒；
 *  - **负责人按实例 id 比对**（与 ㉔ 甲口径一致：派活时负责人写成员的会话 id；
 *    写岗位名对不上 ⇒ 拒——那正是 ㉔ 登记的语义不一致，本判据不替它兜底）；
 *  - **Lead 放行**：受理 / 表态 / 派活要跨线程写（权限矩阵同表「Lead 表态可标记延后」）；
 *  - **普通线程（非节点 id）维持开放**：⑰ 正对照1 的既有语义，不动——「线程消息面对
 *    非任务线程开放」是本仓现状，收窄它属另一条裁决；
 *  - **讨论线程先被 `拒讨论线程直灌` 拒**（本函数排在它之后；调用方若先调那道闸，
 *    「命中节点且有讨论段」根本到不了这里）。
 *
 * 命中的键与 `拒讨论线程直灌` 同款：先精确、后 `线程等价键()`（NTFS 大小写等价类，P3 的教训
 * ——判定键必须与落线键同源，否则大小写变体就是旁路）。
 *
 * @param {{ org: object, 项目: string, 线程: string, 主体: object }} spec
 * @returns {Promise<null>} 放行 ⇒ `null`（调用方继续）；命中他人任务线程 ⇒ 抛 `Denied`
 */
async function 拒他人任务线程({ org, 项目, 线程, 主体 }) {
  const 键 = 线程等价键(线程);
  const 节点表 = await org.tasks.list({ 项目 });
  const 节点 = 节点表.find((n) => n.id === 线程) ?? 节点表.find((n) => 线程等价键(n.id) === 键);
  if (!节点) return null;
  if (主体?.kind === 'Lead') return null;
  const 负责人 = 节点.负责人 ?? [];
  if (负责人.includes(主体?.id)) return null;
  throw new Denied(
    '消息总线 · 任务线程只有负责人与 Lead 可发（权限矩阵：任何在岗主体写自己线程的消息）',
    `线程 ${线程} 是节点 ${节点.id} 的任务线程（负责人 ${负责人.join('、') || '（空）'}），` +
      `而 ${主体?.id ?? 'unknown'} 不是其负责人、也不是 Lead —— 「写自己线程的消息」不含往别人的任务线程落消息。`,
    {
      howToChange:
        '往自己的任务线程发言（负责人按实例 id 比对，写岗位名对不上——派活时负责人写成员的会话 id）；或由 Lead 代发。',
      detail: {
        线程,
        节点: 节点.id,
        负责人,
        发件: 主体?.id ?? null,
        命中: 节点.id === 线程 ? '精确键' : `线程等价类（${键}）`,
      },
    },
  );
}

/**
 * 设置变更的唯一入账口。
 *
 * 为什么单独一个函数：`依据` 是这条记录的全部价值 —— 读账的人要能一眼看出
 * 「这是人从设置入口改的」，而不是某个内部流程顺手写的东西。
 *
 * `依据` 可以由调用方覆盖（同源路由那条路写明「走同源路由的浏览器设置页」），
 * 不传就是命令面的那句（`/mind presence`）—— 两条路进的是同一个入账口。
 * @param {object} org @param {{ 主体: object, 路径: string, 结果: string, 详情: object, 依据?: string }} entry
 */
async function 记设置入账(org, entry) {
  await org.audit.append({
    动作: '设置变更',
    主体: entry.主体,
    对象: { id: entry.路径, kind: '设置文件' },
    依据: entry.依据 ?? '设置入口：/mind presence（命令面专属动作；改的是私有 部署.json）',
    结果: entry.结果,
    详情: entry.详情,
  });
}

/** 设置读数：失联两键 + 介入度 + 复核免审（同一份设置入口的读面）。 */
function 设置读数(org) {
  return {
    ...org.policy.presence(),
    介入度: org.policy.intervention(),
    复核免审: org.policy.reviewExemptAllowed(),
  };
}

/** 设置变更的入账依据：路由面自带「设置页」字样，命令面写明是人敲的。 */
function 设置依据(依据, 通道) {
  if (typeof 依据 === 'string' && 依据.trim()) return 依据;
  return `设置入口：${通道}（人侧通道；改的是私有 部署.json）`;
}

/**
 * 解析 `介入度`：只认 放权 / 预审 / 审批（与策略引擎加载期同一张表）。
 * @param {unknown} 值 @returns {string}
 */
function 解析介入度(值) {
  const 文本 = String(值 ?? '').trim();
  if (!INTERVENTION.includes(文本)) {
    throw new InvalidBody(`介入度只接受 ${INTERVENTION.join(' / ')}，收到 ${JSON.stringify(值 ?? null)}。`, {
      detail: { 键: '介入度', 合法取值: INTERVENTION, 收到: 值 ?? null },
    });
  }
  return 文本;
}

/**
 * 解析 `复核免审`：只认 是 / 否（等价布尔）。
 * @param {unknown} 值 @returns {boolean}
 */
function 解析复核免审(值) {
  if (值 === true || 值 === '是' || 值 === 'true') return true;
  if (值 === false || 值 === '否' || 值 === 'false') return false;
  throw new InvalidBody(`复核免审只接受「是 / 否」（等价 true / false），收到 ${JSON.stringify(值 ?? null)}。`, {
    detail: { 键: '复核免审', 合法取值: ['是', '否', 'true', 'false'], 收到: 值 ?? null },
  });
}

/**
 * 解析 `开关`：只认「是 / 否」（等价 `true` / `false`）。
 *
 * 含糊写法（`也许` / `1` / 空串）一律拒 —— 这里不是 `presence()` 那个 fail-safe 场景：
 * 那是「文件里已有含糊值」要保持保护，这里是「人正在写」⇒ 写坏值必须当场说清合法取值。
 * @param {unknown} 值
 * @returns {boolean}
 */
function 解析开关(值) {
  if (值 === true || 值 === '是' || 值 === 'true') return true;
  if (值 === false || 值 === '否' || 值 === 'false') return false;
  throw new InvalidBody(`开关 只接受「是」或「否」（等价 true / false）：合法取值是 是 / 否，收到 ${JSON.stringify(值)}。`, {
    detail: { 键: '开关', 合法取值: ['是', '否', 'true', 'false'], 收到: 值 === undefined ? null : 值 },
  });
}

/**
 * 解析 `小时`：只认 ≥1 的整数，且不得超过 `MAX_RESPONSE_DEADLINE_HOURS`。
 *
 * 为什么连 `1.5` 与 `0x10` 都拒：这两个数都不该出现在「响应期限小时」上，
 * 而 `Number()` 会把它们照单全收 —— 于是先按字面形状卡一道，再判数值。
 *
 * 为什么上界写在**这里也要引用同一份常量**：`99999999999` 满足「≥1 的整数」，
 * 但它会让 `since + 小时×3600e3` 溢出 `Date` 上界（8.64e15ms），`toIso()` 抛 RangeError ⇒
 * `presence()` 抛 ⇒ `/mind status` 与工作台一起拿不到状态条。所以上界是**判据的一部分**，
 * 而判据只该有一份：`src/kernel/time.js` 的 `MAX_RESPONSE_DEADLINE_HOURS`。
 * @param {unknown} 值
 * @returns {number}
 */
function 解析设置小时(值) {
  const 文本 = typeof 值 === 'number' ? String(值) : String(值 ?? '').trim();
  if (!/^\d+$/.test(文本)) {
    throw new InvalidBody(`小时 只接受 ≥1 的整数（合法取值例如 小时=72 / 小时=168），收到 ${JSON.stringify(值)}。`, {
      detail: { 键: '小时', 合法取值: `1 ~ ${MAX_RESPONSE_DEADLINE_HOURS} 的整数`, 收到: 值 === undefined ? null : 值 },
    });
  }
  const 数 = Number(文本);
  if (!Number.isInteger(数) || 数 < 1 || 数 > MAX_RESPONSE_DEADLINE_HOURS) {
    throw new InvalidBody(
      `小时 只接受 ≥1 的整数，且不得超过 ${MAX_RESPONSE_DEADLINE_HOURS}（上限 ≈ 100 年：再大的期限会让失联判定算不出时刻，把整条读数链打死），收到 ${JSON.stringify(值)}。`,
      { detail: { 键: '小时', 合法取值: `1 ~ ${MAX_RESPONSE_DEADLINE_HOURS} 的整数`, 收到: 值 === undefined ? null : 值 } },
    );
  }
  return 数;
}

/**
 * 读出私有 `部署.json` 现内容（不存在 ⇒ `{}`）。
 *
 * 坏 JSON 一律拒写，**不静默覆盖**：那份文件是主权者的地方，
 * 覆盖一份读不懂的文件等于替他把内容删了（§3.6 不许静默失败）。
 * @param {string} 路径
 * @returns {Promise<{ 文本: string|null, 对象: Record<string, unknown> }>}
 */
async function 读部署偏好文件(路径) {
  const 文本 = await readTextOrNull(路径);
  if (文本 === null || 文本.trim() === '') return { 文本: null, 对象: {} };
  let 解析;
  try {
    // 与策略加载使用同一个编码归一化：Windows UTF-8 BOM 不属于 JSON 内容。
    解析 = JSON.parse(stripBom(文本));
  } catch (error) {
    throw new InvalidBody(
      `私有 部署.json 解析不了（${error instanceof Error ? error.message : String(error)}）：本动作不覆盖读不懂的文件，请先修好 ${路径} 再重试。`,
      { detail: { 文件: 路径 } },
    );
  }
  if (typeof 解析 !== 'object' || 解析 === null || Array.isArray(解析)) {
    throw new InvalidBody(
      `私有 部署.json 必须是 JSON 对象（键值对），当前是 ${Array.isArray(解析) ? '数组' : typeof 解析}：${路径}`,
      { detail: { 文件: 路径 } },
    );
  }
  return { 文本, 对象: 解析 };
}
