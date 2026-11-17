/**
 * 组织动作表（宿主插件与工作台共用的唯一实现）。
 *
 * 为什么动作表要独立成文件：`references/user-actions.md` 的纪律是
 * **一个操作两处调用者（工具 + UI），但只有一处实现**。
 * 于是这里既被 `mind` 工具调用，也被 `/mind` 命令调用，两条路进的是同一张表。
 */
import { Denied, Fault, InvalidBody, NeedsApproval } from '../src/kernel/errors.js';
import { canonical } from '../src/kernel/text.js';
import { normalizeContinuity } from '../src/lead-continuity.js';
import { AUTHORITIES } from '../src/tags.js';
import { normalizeCollaborationFeedback } from '../src/collaboration-feedback.js';
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
import { messageExistingMember, listExistingMembers, stopExistingMember } from './member-maintenance.js';
import { TASK_RECOVERY_RELATION_FIELDS } from '../src/task-state.js';
import { readInstanceSnapshot } from '../src/instance-snapshot.js';
import { matchingBinding } from '../src/tool-file-scope.js';
import { normalizeKnowledgeContext } from '../src/knowledge-applicability.js';
import { normalizeFeedbackReference } from '../src/knowledge-feedback.js';
import { assertExecutionHost, prepareExecution, releaseExecution, sendExecutionMessage, requireDelegation, parseModelRoute } from './host-execution.js';
import { leadAffectExecution } from '../components/kernel/lib/lead-affect.js';
import { readTaskRecords } from '../src/task-records.js';
import { ACTION_MANIFEST, TOOL_ACTION_IDS, COMMAND_ONLY_ACTION_IDS, READ_ONLY_ACTION_IDS, MODEL_FACING_REJECTIONS } from './action-manifest.js';


import { HANDLERS } from './handlers/index.js';
export { HANDLERS };
export { describeFailure } from '../src/kernel/errors.js';

/**
 * 只读动作清单 —— 由 `lib/action-manifest.js` 的 `readonly` 字段派生，**不再手写**。
 *
 * 两个消费者（不许各写一张表，两张表迟早漂，漂了就是一侧放行/一侧拒）：
 *  - 内核 `isConcurrencySafe`：只读动作允许并发；
 *  - `runAction` 的 Lead 钉版闸：**自治写**必须在册在岗 + 有钉版摘要可读，
 *    诊断读（status / workbench / audit_tail …）即使钉版读数缺失也照常可用。
 *
 * 归属口径不变：manifest 里没标 `readonly: true` 的动作一律按**写**处理（fail-closed）。
 */
export const READ_ONLY_ACTIONS = READ_ONLY_ACTION_IDS;

export const READ_ONLY_SET = new Set(READ_ONLY_ACTIONS);

/**
 * 这个动作是不是写动作（单源判据；未知动作按写处理）。
 * @param {string} action
 * @returns {boolean}
 */
export function 是写动作(action) {
  return !READ_ONLY_SET.has(String(action ?? ''));
}

/** 动作清单：工具 schema 的 enum 必须与它一致，别处不再枚举（单源见 lib/action-manifest.js）。 */
export const ACTIONS = TOOL_ACTION_IDS;

/**
 * 命令面专属动作：**只有人能敲，模型没有这只手**。
 *
 * 清单与拒绝文案同源于 `lib/action-manifest.js` 的 `scope: 'command'` 行。可达性由**结构**
 * 保证（`ACTIONS` 的 enum 里根本没有它们），不靠「配方里没写」这种约定。
 */
export const COMMAND_ONLY_ACTIONS = COMMAND_ONLY_ACTION_IDS;

/** 命令面专属动作 = 工具面 ∪ 命令面专属（`/mind` 命令认这张，工具 schema 不认）。 */
export const COMMAND_ACTIONS = [...ACTIONS, ...COMMAND_ONLY_ACTIONS];

/**
 * 命令面专属动作的拒绝文案：id → { 理由, howToChange }。
 * 与动作本身同源（manifest 的 modelFacingRejection）；漏写一条由一致性测试拦下。
 */
export const 命令面专属文案 = MODEL_FACING_REJECTIONS;

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
export async function 记动作拦截(org, { 主体, 项目, args, error }) {
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
export async function 实例活动索引(org, identity) {
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
export function 实例活动读数(identity, 索引) {
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
export async function 未登记敲门者(org, identity) {
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
  const 重载前 = args.action === 'policy_reload' ? org.policy?.describe() : null;
  const 项目 = args.project ?? spec.项目;
  // 面：'tool'（模型侧，默认）| 'command'（人侧 `/mind`）。
  // 默认按工具面处理，是 fail-closed：命令面专属动作在没显式声明「我是命令面」时够不着。
  const 面 = spec.面 ?? 'tool';
  const handler = HANDLERS[args.action];
  if (!handler) {
    throw new InvalidBody(`未知 action：${String(args.action)}`, { detail: { 可选: 面 === 'command' ? COMMAND_ACTIONS : ACTIONS } });
  }
  if (String(args.action).startsWith('memory_') && Object.hasOwn(args, '含待复验') && args.action !== 'memory_query') throw new InvalidBody('含待复验仅用于memory_query，不是记忆写入或生命周期的授权参数。');
  if (Object.hasOwn(args, '连续性类别')) throw new InvalidBody('连续性类别是内部装配筛选参数；显式查询请按偏好类或id读取。');
  if (Object.hasOwn(args, '需求理解') && !['goal_create', 'goal_progress'].includes(args.action)) throw new InvalidBody('需求理解仅用于goal_create或goal_progress；不能借其他动作改写或静默忽略。');
  if (Object.hasOwn(args, '连续性') && !['memory_write', 'memory_lifecycle'].includes(args.action)) throw new InvalidBody('连续性仅用于偏好写入或overturn替代条目。');
  if (Object.hasOwn(args, '协作反馈') && !['memory_write', 'memory_lifecycle'].includes(args.action)) throw new InvalidBody('协作反馈仅用于协作教训写入或overturn替代条目。');
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
  if (args.action === 'goal_decide' || args.action === 'budget_decide' || args.action === 'review_experiment_cleanup') {
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
  // 执行身份由策略真源核对；岗位卡只作专业资料诊断与审计版本，不另造通行证。
  let 钉版读数 = null;
  if (主体.kind === 'Lead') {
    const 工具写 = 面 === 'tool' && 是写动作(args.action);
    if (工具写) {
      if (typeof org.policy.executionIdentity !== 'function') throw new Fault('EXECUTION_IDENTITY_NOT_WIRED', '执行身份检查未接线，不能把接线错误解释为需要用户再授权。');
      const readiness = await org.policy.executionIdentity(主体);
      if (!readiness.ok) throw new Denied(readiness.decision.rule, readiness.decision.reason, readiness.decision);
    }
    try {
      const identity = await org.registry.identity();
      const member = identity?.members?.[主体.id];
      const card = await org.registry.cardOf(主体.id);
      const hash = card?.卡版本?.摘要 ?? null;
      if (hash) 主体 = 钉版主体(主体, hash);
      const 专业就绪 = card?.就绪 === true;
      钉版读数 = { 实例: String(主体.id), 在岗: member?.status === '在岗', 卡版本: hash,
        就绪: 专业就绪, 专业就绪, ...(专业就绪 ? {} : { 未就绪: true, 原因: card?.原因 ?? '专业资料不可用；普通执行按真实身份判定' }) };
    } catch (error) {
      钉版读数 = { 实例: String(主体.id), 就绪: false, 专业就绪: false, 原因: `专业资料读不到：${error.message}` };
    }
  }
  let 结果;
  const scopedReviewRead = 主体.kind === '成员' && ['task_criteria', 'audit_tail', 'bus_read'].includes(args.action);
  let reviewReadStamp;
  try {
    if (scopedReviewRead) reviewReadStamp = await reviewReadProof(org, 主体, 项目);
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
    const 跑 = (跑入参, 跑项目, 执行计划 = null) => handler({ org, 项目: 跑项目, 会话项目: spec.项目, subject: 主体, args: 跑入参, 面, 宿主: spec.宿主, 执行计划, 重载前 });
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
    if (scopedReviewRead && reviewReadStamp !== await reviewReadProof(org, 主体, 项目)) throw new Denied('复核用途读取失效', '读取期间真实用途或实例代次已变化，丢弃旧资料。');
    // R07（审查 2026-10-16）：成员可达的任务写响应走安全呈现。修前动作层把完整节点
    // （tasks.get 全量投影，含所有人的 独立答案/结论层）直接当 DTO 返回——未齐卷的
    // 独立会审里 B 合法调 task_pending 就能读到 A 的私密结论（审查实证 repro-state #1-2；
    // 第二人 submit 的返回值同族）。复核员岗/Lead/主权者不遮：复核员要看分歧清单，
    // 盲评防的是参与者互看（与 bus 读面遮罩同口径）；揭名（交齐/开讨论）后原样。
    // （v2 · 2026-10-18：复核员是成员 kind，遮罩豁免按 roleId=复核员 判。）
    if (主体.kind === '成员' && 结果?.节点 && typeof 结果.节点 === 'object' && !Array.isArray(结果.节点) && !(await 取复核读域({ tasks: org.tasks, registry: org.registry, 项目, subject: 主体 }))?.限定) {
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
export function informationScope({ subject, 项目, 会话项目, 宿主 }) {
  const session = 宿主?.agent?.session;
  if (!session?.id || session.id !== subject.id || 项目 !== 会话项目 || 宿主.project !== 会话项目) throw new Denied('信息收录会话范围', '信息资料使用当前真实会话与项目，不接受自报其他会话或跨项目读取。');
  return { subject, project: 会话项目, session: session.id };
}

export function requireExperiments(host) {
  if (!host?.reviewExperiments) throw new Fault('EXPERIMENT_NOT_WIRED', '冻结实验服务未接线或部署配置不可用；不回退通用执行。');
  return host.reviewExperiments;
}



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
export async function 拒讨论线程直灌({ org, 项目, 线程, 入口 }) {
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
export function 成员可达节点(node, 成员) {
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
export function 规范读根(路径) {
  const 绝对 = resolvePath(String(路径));
  let 真 = 绝对;
  try { 真 = realpathSync(绝对); } catch { /* 不存在时返回词法路径；调用方另有 existsSync 闸 */ }
  return process.platform === 'win32' ? 真.toLowerCase() : 真;
}

/** 入审批计划前复用领域纯合同；非法声明与伪验证字段不能先制造介入请求。 */
export function 断言记忆写入参数(args) {
  if (args.action === 'memory_write') {
    const 多余 = Object.keys(args).filter(key => !['action', 'project', 'role', '审批引用', '类', '内容', '来源', '依据', '命名空间', '来源引用', '岗位', '标签', '任务', '披露豁免', '知识说明', '连续性', '协作反馈'].includes(key));
    if (多余.length) throw new InvalidBody(`记忆写入含未知参数：${多余.join('、')}；验证状态、哈希及认证不能由调用者自报。`);
    const 说明 = normalizeKnowledgeContext(args.知识说明);
    if (说明 !== undefined && args.类 !== '知识') throw new InvalidBody('知识说明仅属于知识类，不能附在经历、偏好或作答上。');
    if (normalizeContinuity(args.连续性) !== undefined && args.类 !== '偏好') throw new InvalidBody('连续性仅属于偏好类。');
    if (normalizeCollaborationFeedback(args.协作反馈) !== undefined && (args.类 !== '偏好' || args.连续性?.类别 !== '协作教训')) throw new InvalidBody('协作反馈仅属于带协作教训连续性声明的偏好。');
  }
  if (args.action === 'memory_lifecycle') {
    const op = args.op;
    if (Object.hasOwn(args, '知识说明') && op !== 'overturn') throw new InvalidBody('知识说明只能随overturn提供给新替代知识；其他生命周期操作不能改写或静默忽略该说明。');
    if (Object.hasOwn(args, '连续性') && op !== 'overturn') throw new InvalidBody('连续性只能随overturn提供给替代偏好。');
    if (Object.hasOwn(args, '连续性') && Object.hasOwn(args, '反馈引用')) throw new InvalidBody('连续性属于偏好；知识反馈引用不能用于连续性替代。');
    if (Object.hasOwn(args, '协作反馈') && (op !== 'overturn' || Object.hasOwn(args, '反馈引用'))) throw new InvalidBody('协作反馈只能随overturn提供给新协作教训，不能用于知识反馈处置。');
    const 允许 = ['action', 'project', 'role', '审批引用', 'id', 'op', '原因', '任务', ...(['invalidate', 'demote', 'overturn'].includes(op) ? ['反馈引用'] : []), ...(op === 'overturn' ? ['新条目', '知识说明', '连续性', '协作反馈'] : []), ...(op === 'purge' ? ['敏感'] : []), ...(op === 'promote' ? ['岗位', '披露豁免'] : [])];
    const 多余 = Object.keys(args).filter(key => !允许.includes(key));
    if (多余.length) throw new InvalidBody(`记忆处置含未知参数：${多余.join('、')}；验证状态、哈希及认证不能由调用者自报。`);
    if (Object.hasOwn(args, '知识说明')) normalizeKnowledgeContext(args.知识说明);
    if (Object.hasOwn(args, '连续性')) normalizeContinuity(args.连续性);
    if (Object.hasOwn(args, '协作反馈')) normalizeCollaborationFeedback(args.协作反馈);
    if (Object.hasOwn(args, '反馈引用')) normalizeFeedbackReference(args.反馈引用);
  }
}

/** 读出口跨await的用途/实例事实回执；不接受模型提供的域或用途。 */
export async function reviewReadProof(org, subject, 项目) {
  const identity = await org.registry.identity(), member = identity.members?.[subject.id];
  if (member?.status !== '在岗') throw new Denied('复核用途读取失效', '当前真实实例不在岗，不能返回旧读域。');
  const domain = await 取复核读域({ tasks: org.tasks, registry: org.registry, 项目, subject });
  return canonical({ id: subject.id, status: member.status, role: member.岗位, generation: member.代, host: member.代次,
    limited: domain?.限定, tasks: domain?.复核任务, targets: domain?.复核对象 });
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
export async function 复核读域For({ org, 项目, subject }) {
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
export async function 取任务上下文({ org, 项目, args }) {
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
export async function 盲评遮罩({ org, 项目, 线程, 读者, 消息 }) {
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
export function 要求授权({ 宿主, subject, 项目 }) {
  return requireDelegation({ host: 宿主, subject, project: 项目 });
}

/**
 * 模型路由解析（member_spawn / debate_open 共用）：成对、推理档随路由、team 拒、不静默回落。
 * @param {object} args @param {'team'|'subagent'} 方式
 */
export function 解析模型路由(args, 方式) {
  return parseModelRoute(args, 方式);
}

/** 创建、投递和清理能力必须在任何宿主副作用前齐备；不能 spawn 后才发现无消息/退役通道。 */
export function 断言成员宿主就绪(宿主, 方式, 会审 = false) {
  return assertExecutionHost(宿主, 方式, 会审);
}

/** 公共释放/中断调用失败交给上层合并报告；不把可选调用或请求回执冒充已停止。 */
export async function 停执行体({ org, subject, 宿主, 方式, agent, 实例, 团队名, 名, 响亮 = false }) {
  return releaseExecution({ host: 宿主, mode: 方式, agent, id: 实例, teamName: 团队名 ?? 名,
    beforeDispatch: 补偿归属复判({ org, subject, 宿主, 实例 }) });
}

export function 补偿归属复判({ org, subject, 宿主, 实例 }) {
  const project = 宿主.project; let stamp;
  return async () => {
    await org.policy.check({ subject, action: 'write', target: { id: 实例, kind: '执行体', authority: '自治', zone: '私有' } });
    const members = (await org.registry.identity()).members ?? {}, parent = members[subject.id], child = members[实例];
    if (宿主.project !== project || !parent || parent.status !== '在岗' || parent.岗位 !== 'Lead'
      || (child && (child.委派者?.id !== subject.id || child.委派者?.kind !== 'Lead'
        || (child.会审绑定 && child.会审绑定.项目 !== project)))) throw new Fault('MEMBER_STOP_SCOPE_CHANGED', '等待补偿准入时父身份、项目或实例归属变化，不沿旧计划中断。');
    const current = canonical({ parent, child: child ?? null });
    if (stamp !== undefined && stamp !== current) throw new Fault('MEMBER_STOP_SCOPE_CHANGED', '等待补偿准入时身份或绑定已变化，不中断已被重新安排的实例。');
    stamp = current;
    // Missing registration is allowed only here: the caller owns this newly
    // observed creation and may be compensating registration failure, not old work.
  };
}

/**
 * 登记 + 钉版 —— 唯一实例登记适配器（member_spawn 节点绑定 / 会审 会审绑定共用）。
 * 任何失败先停执行体，再抛带阶段的 Fault；返回实例钉住的卡（规程唯一来源）。
 */
export async function 登记钉版({ org, subject, 岗位, 实例, 代次, 方式, 绑定, 授权引用, 停, 失败补偿 = null }) {
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
    throw new Fault('MEMBER_SPAWN_CARD_NOT_READY', `实例 ${实例} 已登记，但其岗位卡钉版未就绪（${错误信息(error)}）：专业资料不可用，不会发假专业任务书；可修复该专业资料，或在已有Host许可内选择普通委派或可用专业；已尝试停用${绑定?.会审 ? '并封存本次咨询实例' : ''}。`, {
      detail: { 阶段: 'card', 实例, 岗位, 就绪: 钉?.就绪 ?? null, ...(封存错误 ? { 封存错误 } : {}) },
      outcome: { 提交状态: '部分提交', 可重试: false,
        恢复指引: '实例已登记，但卡未就绪且已尝试补偿；核对登记、钉卡和宿主驻留状态，不能把中断或释放当作删除或回滚，不要重复 member_spawn。',
        已确认阶段: [{ 阶段: '实例登记完成', 实例 }, ...宿主清理凭据(补偿回执, { 实例 }), ...(补偿错误?.outcome?.已确认阶段 ?? [])] },
    });
  }
  return 钉;
}

/** 发成员书（member_spawn 开工书 / 会审任务书共用）。 */
export async function 发成员书({ 宿主, 方式, agent, signal, 实例, 团队名, 内容 }) {
  return sendExecutionMessage({ host: 宿主, mode: 方式, agent, signal, id: 实例, teamName: 团队名, content: 内容 });
}

/** 钉卡 → 注入规程：L0/L1/能力引用/摘要（不内嵌能力正文）。 */
export function 拼钉卡规程(钉卡) {
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
export function 参数列表(value) {
  const raw = Array.isArray(value) ? value : String(value ?? '').split(/[,，]/);
  return [...new Set(raw.map((x) => String(x ?? '').trim()).filter(Boolean))];
}

/** 岗位参数 → **保序不去重**（重复 N 次 = N 个受管实例）。 */
export function 岗位清单(value) {
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
export const 会审咨询动作 = new Set(['status', 'workbench', 'capability_list', 'capability_read', 'capability_resolve']);

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
export async function 断言会审计计划完整({ org, subject, 项目, 动作, args }) {
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
export function 会审退役适配器({ org, subject, 宿主, 方式, 实例集 = [] }) {
  const agent = 宿主?.agent ?? null;
  const 停机通道 = (实例) => {
    if (!agent) throw new Fault('COUNCIL_ADAPTER_NOT_READY', '收敛受管会审缺真实 Agent，已在写入前拒绝。');
    const 行 = 查Team名(宿主, agent, 实例);
    if ((方式 === 'team' && !行) || (方式 === 'subagent' && 行)) throw new Fault('COUNCIL_ADAPTER_NOT_READY', '会审实例的已记创建通道与当前目录不符，不切换通道补偿。');
    if (行 && typeof 宿主.agentTeams.interrupt === 'function') {
      const beforeDispatch = 补偿归属复判({ org, subject, 宿主, 实例 });
      return () => releaseExecution({ host: 宿主, mode: 'team', agent, id: 实例, teamName: 行.name, beforeDispatch });
    }
    if (!行 && (typeof 宿主?.subagents?.drainContinuableChildren === 'function' || typeof 宿主?.subagents?.drainChildren === 'function')) return () => releaseExecution({ host: 宿主, mode: 'subagent', agent, id: 实例 });
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
export function 中止信号(宿主) {
  if (typeof AbortSignal !== 'undefined' && 宿主?.signal instanceof AbortSignal) return 宿主.signal;
  return new AbortController().signal;
}

/** @param {unknown} error @returns {string} */
export function 错误信息(error) {
  return error instanceof Error ? error.message : String(error);
}

/** 只剥传输字段；业务参数仍由领域白名单校验，计划仅取内部参数。 */
export function 目标参数(args, subject, 项目, 执行计划) {
  const { action: _action, project: _project, 审批引用: _approval, ...入参 } = args;
  return { ...入参, subject, 项目, ...(执行计划 ? { 执行计划 } : {}) };
}

/** 只投影真实业务返回中的标识及明确回执，绝不展开正文。 */
export function 动作提交凭据(action, result, 项目) {
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
export function 宿主清理凭据(receipt, refs) {
  return [
    ...(receipt?.已封 === true ? [{ 阶段: '组织身份已封存', ...refs, 已封存: true }] : []),
    ...(receipt?.当前驻留已释放 === true ? [{ 阶段: '宿主当前驻留已释放', ...refs, 当前驻留已释放: true }] : []),
    ...(receipt?.已请求中断 === true ? [{ 阶段: '宿主中断已请求', ...refs, 已请求: true }] : []),
  ];
}

/** 成员名规范：lower-kebab + 时间后缀（Team 名册全程查重，撞名会被服务拒绝）。 */
export function 规范成员名(基名, 后缀) {
  const slug = String(基名).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'member';
  return `${slug}-${后缀}`;
}

/** Only a known non-Team parent/known absent row is null; errors never choose another lane. */
export function 查Team名(宿主, agent, 实例) {
  if (!宿主?.agentTeams || !agent) return null;
  try {
    if (typeof 宿主.agentTeams.tryMembership === 'function') {
      const membership = 宿主.agentTeams.tryMembership(agent);
      if (membership == null) return null;
      if (membership.role !== 'lead') throw Error('not a Team Lead');
    }
    const rows = 宿主.agentTeams.listMembers(agent);
    if (!Array.isArray(rows)) throw Error('unknown catalog');
    const matches = rows.filter(m => m?.id === 实例);
    if (!matches.length) return null;
    const row = matches[0];
    if (matches.length !== 1 || row.role !== 'teammate' || typeof row.name !== 'string' || !row.name.trim()
      || rows.filter(m => m?.name === row.name).length !== 1) throw Error('ambiguous target');
    return row;
  } catch {
    throw new Fault('COUNCIL_ADAPTER_NOT_READY', 'Team直属目录不可判或目标不唯一；不猜归属、不切普通子会话通道。');
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
 *  - **负责人按实例 id 或真实岗位绑定比对**：岗位负责人只向钉版凭证仍匹配的精确实例开放，
 *    不按自报 roleId 或同岗所有实例放行；
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
export async function 拒他人任务线程({ org, 项目, 线程, 主体 }) {
  const 键 = 线程等价键(线程);
  const 节点表 = await org.tasks.list({ 项目 });
  const 节点 = 节点表.find((n) => n.id === 线程) ?? 节点表.find((n) => 线程等价键(n.id) === 键);
  if (!节点) return null;
  if (主体?.kind === 'Lead') return null;
  const 负责人 = 节点.负责人 ?? [];
  if (负责人.includes(主体?.id)) return null;
  if (主体?.kind === '成员') {
    const snapshot = readInstanceSnapshot(org.layout.identityFile());
    const member = snapshot.成员?.[主体.id];
    if (snapshot.ok && member?.就绪 && 负责人.includes(member.岗位)
      && (节点.绑定 ?? []).some(binding => matchingBinding(binding, 主体.id, member))) return null;
  }
  throw new Denied(
    '消息总线 · 任务线程只有负责人与 Lead 可发（权限矩阵：任何在岗主体写自己线程的消息）',
    `线程 ${线程} 是节点 ${节点.id} 的任务线程（负责人 ${负责人.join('、') || '（空）'}），` +
      `而 ${主体?.id ?? 'unknown'} 不是其负责人、也不是 Lead —— 「写自己线程的消息」不含往别人的任务线程落消息。`,
    {
      howToChange:
        '往自己的任务线程发言；岗位负责人须有本人当前在岗凭证匹配的精确任务绑定，不能凭岗位名或旧绑定代替；或由 Lead 代发。',
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
export async function 记设置入账(org, entry) {
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
export function 设置读数(org) {
  return {
    ...org.policy.presence(),
    介入度: org.policy.intervention(),
    复核免审: org.policy.reviewExemptAllowed(),
  };
}

/** 设置变更的入账依据：路由面自带「设置页」字样，命令面写明是人敲的。 */
export function 设置依据(依据, 通道) {
  if (typeof 依据 === 'string' && 依据.trim()) return 依据;
  return `设置入口：${通道}（人侧通道；改的是私有 部署.json）`;
}

/**
 * 解析 `介入度`：只认 放权 / 预审 / 审批（与策略引擎加载期同一张表）。
 * @param {unknown} 值 @returns {string}
 */
export function 解析介入度(值) {
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
export function 解析复核免审(值) {
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
export function 解析开关(值) {
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
export function 解析设置小时(值) {
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
export async function 读部署偏好文件(路径) {
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
