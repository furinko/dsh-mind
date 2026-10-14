/**
 * 组织动作表（宿主插件与工作台共用的唯一实现）。
 *
 * 为什么动作表要独立成文件：`references/user-actions.md` 的纪律是
 * **一个操作两处调用者（工具 + UI），但只有一处实现**。
 * 于是这里既被 `mind` 工具调用，也被 `/mind` 命令调用，两条路进的是同一张表。
 */
import { Denied, InvalidBody } from '../src/kernel/errors.js';
import { atomicWrite, readTextOrNull, withLock } from '../src/kernel/fsx.js';
import { MAX_RESPONSE_DEADLINE_HOURS } from '../src/kernel/time.js';
import { MEMORY_KINDS, 线程等价键 } from '../src/paths.js';
import { 全员已交 } from '../src/tasks.js';
// 复核员岗成员主体的档案解析（649a4）：subjectForRole 是「身份档案 → 主体」的唯一映射落点。
import { subjectForRole } from '../src/registry.js';
// ①甲（2026-10-10）：bus_send 拒往讨论线程直灌时，文案里的类型闸口径取自 debate.js 的**唯一源**
// （不在这里再抄一遍三种类型 —— 抄一遍就会漂）。
import { DEBATE_SAY_TYPES } from '../src/debate.js';

export { describeFailure } from '../src/kernel/errors.js';

/** 动作清单：工具 schema 的 enum 必须与它一致，别处不再枚举。 */
export const ACTIONS = [
  'status',
  'workbench',
  'policy_check',
  'task_create',
  // task_reassign（task-机制缺口-10th0 · 裁决③ · 2026-10-13）：改派负责人——仅 Lead、
  // 仅 待派发/已派发 态（tasks.js 的状态机与 Lead 闸守着），入审计。负责人实例消亡后
  // 节点原先只能重建，这是那条死路的正门。
  'task_reassign',
  'task_dispatch',
  'task_start',
  'task_submit',
  'task_review',
  'task_pending',
  'task_resolve',
  // task_settle（W3 批3）：结账——环路最后一步，仅 Lead（policy 的 `settle` 动作守着）。
  'task_settle',
  // review_nominate（G1 · 交接件《复核员任命闭环缺口》2026-10-14）：提名复核者进任务图
  // （节点转待决·复核提名，进主权者决策队列），取代「发一条总线消息」这条零机制老路。
  // 仅 Lead、仅 已交卷/未验/已打回、候选不得是本节点交卷人（§3.4）；
  // 提名 ≠ 任命：不触碰 registry_assign，任命仍由主权者的授权引用驱动（4yuxq 定案）。
  'review_nominate',
  // review_exempt（G4 · 同交接件）：复核豁免登记——主权者决定不复核时留可查询的账
  // （节点复核豁免字段，可统计「哪些产出没被复核」）。仅 Lead/主权者 + 授权引用必填
  // （空授权默认拒——防 Lead 自豁免拆掉独立复核线）。
  'review_exempt',
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
  'audit_tail',
  'audit_verify',
  // audit_correct（缺口2a · 主权者裁决 2026-10-12）：追加「更正声明」，把「单点 hash 不符、
  // 骨架完好」的已确认瑕疵从恒红转「已确认瑕疵」。不是改设置的动作；入口默认拒绝
  // （仅 Lead / 主权者 + 授权引用必填），写入面 audit.appendCorrection 再守三道闸。
  'audit_correct',
  'registry_list',
  'registry_can',
  'registry_assign',
  'registry_seal',
  'registry_revoke',
  'upgrade_pending',
  'review_zero',
  'bus_unlock',
  'debate_open',
  'debate_say',
  'debate_round',
  'debate_converge',
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
export const COMMAND_ONLY_ACTIONS = ['presence', 'sovereign_interaction'];

/** 命令面专属动作 = 工具面 ∪ 命令面专属（`/mind` 命令认这张，工具 schema 不认）。 */
export const COMMAND_ACTIONS = [...ACTIONS, ...COMMAND_ONLY_ACTIONS];

/**
 * 命令面专属动作的拒绝文案：按动作各写一句「为什么模型没有这只手」。
 * presence 与 sovereign_interaction 拒的都是「事实源不许模型自写」，但改的东西不同。
 */
const 命令面专属文案 = {
  presence: {
    理由: '宪章 三权（§4）：改设置的入口只给人',
    howToChange: '由人敲 /mind presence 开关=是|否 小时=<≥1 的整数>（不带参数则是只读的当前读数）。',
  },
  sovereign_interaction: {
    理由: '宪章 失联判定（§4）：主权者在线的事实只能由人声明',
    howToChange: '由人敲 /mind sovereign_interaction（模型没有这只手：失联判定的事实源不许模型自写）。',
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
  const 主体 = spec.主体;
  // 自报的岗位不许直接变身份（B3）：成员/复核者的权来自身份档案里的实例，
  // 档案里没有、不在岗、或岗位对不上，一律按最严拒绝——与策略引擎的 §12.2 判定同口径。
  if (主体.kind === '成员' || 主体.kind === '复核者') {
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
  }
  let 结果;
  try {
    结果 = await handler({ org, 项目, subject: 主体, args });
  } catch (error) {
    // 缺口1B（2026-10-12 评审）：服务层闸抛的 Denied 也要入账（策略引擎自己的拒绝
    // 带 已入账 标记，这里跳过不双记）。
    await 记动作拦截(org, { 主体, 项目, args, error });
    throw error;
  }
  return { action: args.action, 项目, 主体: { id: 主体.id, kind: 主体.kind, roleId: 主体.roleId ?? null }, ...结果 };
}

/** 每个动作一个函数；键名即 action 名。 */
const HANDLERS = {
  async status({ org }) {
    return { 数据: await org.status() };
  },

  async workbench({ org, 项目, subject, args }) {
    // 「全量」不是自报开关（2026-10-12 评审 P1-1）：切片是 §7.5 岗位内隔离的防线，
    // 不能由调用方手里的一个布尔掀掉。成员传了 全量:true 照切片，并如实标注——不静默升降。
    const 要全量 = args.全量 === true;
    const 给全量 = 要全量 && subject?.kind !== '成员';
    return {
      数据: await org.workbench({ 读者: 给全量 ? undefined : subject, 项目, 审计条数: args.审计条数 ?? 20 }),
      说明: '工作台是投影：只读，不存储，不是第二事实源。',
      ...(要全量 && !给全量
        ? { 提示: '全量视图不对成员开放（§7.5 岗位内隔离）：已按你的岗位切片返回。' }
        : {}),
    };
  },

  async policy_check({ org, subject, args }) {
    if (!args.target?.kind) throw new InvalidBody('policy_check 需要 target.kind');
    const decision = await org.policy.decide({
      subject,
      action: args.动作 ?? 'read',
      target: {
        id: args.target.id ?? 'probe',
        kind: args.target.kind,
        authority: args.target.authority ?? '自治',
        zone: args.target.zone ?? '私有',
        project: args.project ?? null,
        segment: args.target.segment ?? null,
      },
      context: {},
    });
    return { 判定: decision, 说明: '拒绝必须带可执行理由：哪条规则 + 改它要什么授权。' };
  },

  async task_create({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.create({ subject, 项目, 描述: args.描述, 负责人: args.负责人, 判据: args.判据, 依赖: args.依赖, 模式: args.模式 }) };
  },

  /**
   * 改派负责人（task-机制缺口-10th0 · 裁决③）：仅 Lead、仅 待派发/已派发、入审计。
   * 边界判据在服务层（src/tasks.js reassign），这里是纯透传——工具面不多长一张嘴。
   */
  async task_reassign({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.reassign(args.id, { subject, 项目, 负责人: args.负责人 }) };
  },

  async task_dispatch({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.dispatch(args.id, { subject, 项目 }) };
  },

  async task_start({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.start(args.id, { subject, 项目 }) };
  },

  async task_submit({ org, 项目, subject, args }) {
    // 反例面必须原样传到任务图：§10 零分歧判据是「结论层一致且无人给出反例面」，
    // 动作层漏传会让「无人给反例面」恒真，零分歧报警名存实亡。
    return { 节点: await org.tasks.submit(args.id, { subject, 项目, 产出物引用: args.产出物引用, 结论: args.结论, 反例面: args.反例面 }) };
  },

  async task_review({ org, 项目, subject, args }) {
    // 复核者归属不许自报（2026-10-12 评审 P1-2，与 W2 发件人同族）：结论记在谁头上
    // 必须与真实主体一致。唯独 Lead 可代录（复核者无法操作的场景）——代录事实
    // 留在审计主体里（主体恒为真），署名是复核者本人。
    if (args.复核者 != null && args.复核者 !== subject.id && subject.kind !== 'Lead') {
      throw new Denied(
        '复核归属不许代签（W2 同族：归属字段不许自报）',
        `复核者（${args.复核者}）与执行主体（${subject.id}）不一致：复核结论的署名就是复核者本人，不许替别人署名——署错名的结论会污染复核经过与零分歧判定。`,
        {
          requireAuthority: 'Lead',
          howToChange: '由复核者本人调 task_review（复核者参数可省略，默认取真实主体）；确需 Lead 代录时由 Lead 调，审计主体里看得见是代录。',
        },
      );
    }
    // 复核员岗成员主体的档案解析（task-修复-lib-actions-j-649a4 · 判据②）：teammate 复核员的
    // 宿主主体是 kind=成员（subject.js 第 1 档设计：会话事实里没有岗位，岗位由 registry_assign
    // 落在身份档案）——而复核落账的策略判定需要复核者主体形状（§2：复核者 review 放行、
    // 其余写拒）。`subjectForRole` 是「身份档案 → 主体」的唯一映射落点（registry.js），
    // 这里只信档案真源（在册且在岗且岗位=复核员），自报不算数——与缺口4 同族。
    // 修前实测：复核员第3代出结论被「任务外无」拒（tasks.review 的判定 context 无 task、
    // 成员主体也过不了 scopeOf），两节点 review 均被迫 Lead 代落。
    const 复核主体 = await 复核者主体(org, subject);
    return {
      结论: await org.review.record({
        subject: 复核主体,
        项目,
        节点: args.id,
        三态: args.三态,
        分歧清单: args.分歧清单,
        反例面: args.反例面,
        复核者: args.复核者 ?? subject.id,
      }),
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
    const 节点 = await org.tasks.settle(args.id, { subject, 项目 });
    return { 节点, 说明: `已结账（归档作答 ${节点.归档条数 ?? 0} 条）：环路走到头了，后续只能追加更正，不能复活。` };
  },

  /**
   * 提名复核者（G1 · 交接件《复核员任命闭环缺口》2026-10-14）。
   *
   * 提名/派单复核者（G1 · 交接件 2026-10-14；池化排班 2026-10-14 晚 · 主权者批准）。
   *
   * 路由在服务层（src/review.js nominate）：候选在册在岗 ⇒ 池内派单（不进待决）；
   * 池外 ⇒ 新任命提名（挂待决等主权者）；候选省略 ⇒ 池内按账上活动轮派。
   * 这里是纯透传 + 指路——工具面不多长一张嘴。
   */
  async review_nominate({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('review_nominate 需要 id（被提请复核的任务节点）', { missing: ['id'] });
    const 节点 = await org.review.nominate({ subject, 项目, 节点: args.id, 实例: args.候选, 理由: args.原因 });
    const 池内 = Boolean(节点.复核指派);
    return {
      节点,
      说明: 池内
        ? '池内派单：候选是在册在岗复核员，排班不是任命——不进待决，复核员可直接 task_review。指派事实已进事件流（复核指派记录）。'
        : '池外提名：候选不在册（或状态非在岗）——这是新任命，节点已挂待决（复核提名），主权者不批就一直挂着。批准 ⇒ registry_assign（岗位=复核员 · 实例=候选 · 授权引用=本节点 id 或常任授权决议 id）。',
    };
  },

  /**
   * 复核豁免登记（G4 · 交接件 2026-10-14）：主权者决定不复核时，把豁免变成节点上
   * 可查询、可统计的字段。授权闸在服务层（exemptReview），这里只透传 + 指路。
   */
  async review_exempt({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('review_exempt 需要 id（任务节点）', { missing: ['id'] });
    const 节点 = await org.tasks.exemptReview(args.id, { subject, 项目, 授权引用: args.授权引用, 原因: args.原因 });
    return { 节点, 说明: '复核豁免已登记（授权引用原样进链接受复核）。「哪些产出没被复核」由节点复核豁免字段统计。' };
  },

  async memory_write({ org, 项目, subject, args }) {
    if (!MEMORY_KINDS.includes(args.类)) throw new InvalidBody(`记忆只有四类：${MEMORY_KINDS.join(' / ')}`);
    // 不许替调用方编一个来源：§7 要求「写入必带谁记的 + 怎么知道的」，
    // 缺了就拒写（写入侧义务），而不是填个「未说明」让它过关。
    const 来源 = args.来源 ?? (args.依据 ? args.依据 : null);
    if (!来源) throw new InvalidBody('memory_write 需要「来源」：这条你是怎么知道的？', { missing: ['来源'] });
    return {
      条目: await org.memory.remember({
        subject,
        类: args.类,
        内容: args.内容,
        来源,
        项目,
        岗位: args.岗位,
        标签: args.标签,
        // 契约A：来源引用（证据/来源对象 id 列表）——服务层做存在性校验，悬空即拒。
        来源引用: args.来源引用,
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
    return {
      结果: await org.memory.query({ subject, 类: args.类, 项目, 岗位: args.岗位, 文本: args.文本, 显式: args.显式, 含失效: args.含失效, 读者: subject, limit: args.limit, 条数上限: args.条数上限 }),
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

  async memory_lifecycle({ org, 项目, subject, args }) {
    const op = args.op;
    // invalidate / demote / overturn 同病修复（2026-10-12）：成员在任务内处置自己记的条目
    // （§7「错误/过期/冷/被推翻」）是常规动作，与 memory_write 一样要透传任务上下文。
    // purge / promote 不透传：物理删除已被处置表闸收紧（敏感声明/主权者），晋升是 Lead 语义。
    if (op === 'invalidate') return { 结果: await org.memory.invalidate(args.id, { subject, 原因: args.原因, 任务: await 取任务上下文({ org, 项目, args }) }) };
    if (op === 'demote') return { 结果: await org.memory.demote(args.id, { subject, 原因: args.原因, 任务: await 取任务上下文({ org, 项目, args }) }) };
    if (op === 'overturn') return { 结果: await org.memory.overturn(args.id, { subject, 新条目: args.新条目, 理由: args.原因, 任务: await 取任务上下文({ org, 项目, args }) }) };
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
    return { 能力: await org.capability.list({ 岗位: args.岗位, 来源: args.来源 }) };
  },

  async capability_resolve({ org, subject, args }) {
    // 契约B（2026-10-09）：解析也过唯一判定点（主体来自 runAction 的主体链）。
    return { 解析: await org.capability.resolve({ subject, 名: args.名 }) };
  },

  async capability_read({ org, args }) {
    // 缺 id 先响亮指路（2026-10-11 跑通测试 P3）：否则报「能力库里没有 undefined」，
    // 把人引向「库里缺条目」的错方向——按 schema 的 名 参数传参就会走到这。
    if (!args.id) throw new InvalidBody('capability_read 需要 id（能力名）；名 只用于 capability_resolve', { missing: ['id'] });
    const 条目 = await org.capability.read({ id: args.id, 来源: args.来源 });
    if (!条目) throw new InvalidBody(`能力库里没有 ${args.id}`);
    return { 条目 };
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
    // 动作面不许往**会审讨论线程**直灌消息。判据**只有一处实现** —— `拒讨论线程直灌`（文件末），
    // 本 handler 与 `bus_unlock` 都调它：各抄一份就会漂，撤掉一处就是一条漏口（P2 就是这么来的）。
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
    // 契约B（2026-10-09）：线程读取也过唯一判定点（主体来自 runAction 的主体链）。
    const 消息 = await org.bus.read({ subject, 项目, 线程: args.线程, 收件: args.收件, 未投递: args.未投递, limit: args.limit });
    // 盲评遮罩（2026-10-12 评审 P2-6）：未交齐的独立会审线程，成员读不到他人的发件与内容——
    // 与 workbench 投影层同一条 §10 规矩，不能只遮投影而放行总线。
    return { 消息: await 盲评遮罩({ org, 项目, 线程: args.线程, 读者: subject, 消息 }) };
  },

  /**
   * 会审解锁的动作面入口（§9 两处边界写死之一）。
   *
   * 「全员已交」**不从调用方手里接**：那是自报的，报 true 就绕过边界了。
   * 这里从任务图**重算**——每个负责人都在 `独立答案` 里交过自己那份，才够格
   * 交给 `org.bus.unlock`（广播走 `send`，闸与审计与 `bus_send` 同一条路）。
   *
   * **它也是模型可达的一只「往线程落消息」的手**（批c 补漏 · P2，2026-10-10 复核实证）：
   * `unlock` 内部就是 `bus.send(发件='system', 类型='广播', 内容=调用方给的原文)`，
   * 所以它必须与 `bus_send` 过**同一道**讨论线程判据 —— 否则甲只是把漏口挪到了隔壁：
   * 实测修前 `bus_unlock{id:讨论节点, 线程:讨论节点}` ⇒ 放行，线程里落线
   * `发件=system / 类型=广播 / 内容=攻击者原文`，**无去重**（重复调用重复落线）。
   *
   * **顺序**（2026-10-12 评审 P1-3 后固定）：①讨论线程闸（落点是不是讨论线程——与 id
   * 无关的绝对禁区）⇒ ②绑定闸（落点必须 == 被验齐卷的节点自己）⇒ ③资格闸（齐卷重算）。
   * ①排在绑定之前：打讨论线程的攻击要拿到「讨论线程」这条最具体的拒绝，而不是绑定文案。
   */
  async bus_unlock({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('bus_unlock 需要 id（会审任务节点）', { missing: ['id'] });
    if (!args.线程) throw new InvalidBody('bus_unlock 需要 线程', { missing: ['线程'] });
    // 顺序：先讨论线程闸（它对「往讨论线程灌」给出最具体的拒绝，与 id 是不是它无关），
    // 再绑定闸（普通线程才轮到它说话）。
    await 拒讨论线程直灌({ org, 项目, 线程: args.线程, 入口: 'bus_unlock' });
    // 落点与资格必须绑死（2026-10-12 评审 P1-3）：修前齐卷重算的是 args.id、广播却落进
    // 自报的 args.线程 —— 成员用自己任一单人已交节点，就能把任意内容以 发件=system/类型=广播
    // 灌进任意非讨论线程。广播落点只允许是被重算齐卷的节点自己的线程
    // （比较走 线程等价键：判定键必须与落线键同源，大小写变体不许成旁路）。
    if (线程等价键(args.线程) !== 线程等价键(args.id)) {
      throw new Denied(
        '会审解锁 · 广播落点必须是被验齐卷的节点自己',
        `线程（${args.线程}）与节点（${args.id}）不一致：解锁广播只能落进被重算「全员已交」的那个节点自己的线程——落点与资格分离，齐卷证明就能被拿去给任意线程开广播。`,
        { howToChange: `用 线程=${args.id}（节点自己的线程）重试。`, detail: { id: args.id, 线程: args.线程 } },
      );
    }
    const 节点 = await org.tasks.get(args.id, { 项目 });
    const 负责人 = 节点?.负责人 ?? [];
    const 已交 = (节点?.独立答案 ?? []).map((a) => a.成员);
    // 齐卷判据只有一处实现（src/tasks.js 的 全员已交，按人核对）——与 debate_open /
    // 盲评遮罩同一把尺；这里不重算，只取数写拒绝文案。
    if (!全员已交(节点)) {
      throw new Denied(
        '任务图 · 会审解锁边界（§9：全员已交才解锁）',
        `节点 ${args.id} 未全员交卷：状态 ${节点?.状态 ?? '不存在'}，已交 ${已交.filter((m) => 负责人.includes(m)).length}/${负责人.length}，会审保持锁定。`,
        {
          howToChange: '等每个负责人都 task_submit 交过自己那份（结论按人留），再执行 bus_unlock。',
          detail: { 节点: args.id, 状态: 节点?.状态 ?? null, 负责人, 已交 },
        },
      );
    }
    // 幂等（P1-3 同修）：解锁广播一个节点只发一次——修前重复调用重复落线，
    // 同一条「可以亮答案了」能被刷成消息洪水。判据 = 线程里已有 system 的「广播」。
    const 既有 = await org.bus.readRaw({ 项目, 线程: args.线程 });
    if ((既有 ?? []).some((m) => m.类型 === '广播' && m.发件 === 'system')) {
      return { 结果: { 解锁: true, 广播: null, 原因: '该节点已解锁过（幂等）：解锁广播一个节点只发一次，不重复落线。' } };
    }
    return {
      // 节点 + 全员已交 都传（2026-10-13 审查 P2-4）：服务层注入了任务图就用 节点 现算（权威）；
      // 没注入的独立夹具退回这里的重算值（上方已按「全员已交()」唯一判据算过，同样不是自报）。
      结果: await org.bus.unlock({ subject, 项目, 节点: args.id, 线程: args.线程, 全员已交: true, 参与者: args.收件 ?? 负责人, 内容: args.内容 }),
    };
  },

  // ── W2 会审讨论段（2026-10-09）：四个动作面入口。主体走 runAction 的批次3身份链 ──
  // （成员发言用成员主体）；齐卷/预算/参与者等判定全部在 DebateService 服务层重算，
  // 动作面不接任何自报的「已交齐/预算余量」。

  async debate_open({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('debate_open 需要 id（会审任务节点）', { missing: ['id'] });
    return { 讨论: await org.debate.open({ subject, 项目, 节点: args.id }) };
  },

  async debate_say({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('debate_say 需要 id（会审任务节点）', { missing: ['id'] });
    if (!args.内容) throw new InvalidBody('debate_say 需要 内容', { missing: ['内容'] });
    return { 发言: await org.debate.say({ subject, 项目, 节点: args.id, 类型: args.类型, 内容: args.内容 }) };
  },

  async debate_round({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('debate_round 需要 id（会审任务节点）', { missing: ['id'] });
    return { 讨论: await org.debate.round({ subject, 项目, 节点: args.id }) };
  },

  async debate_converge({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('debate_converge 需要 id（会审任务节点）', { missing: ['id'] });
    return { 讨论: await org.debate.converge({ subject, 项目, 节点: args.id, 内容: args.内容 }) };
  },

  async audit_tail({ org, args }) {
    const rows = await org.audit.read({ grade: args.档位, limit: args.limit ?? 20 });
    // limit=0 是「一条都不要」，不是「slice(-0)=slice(0) 回整组」（2026-10-12 评审 P3）。
    const 条数 = args.limit ?? 20;
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
    // 授权引用透传（裁决②）：目标岗位＝复核员时必填（服务层守闸，空授权默认拒）。
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
    return { 主权者: await org.registry.markInteraction({}) };
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
    if (!有开关 && !有小时) {
      return {
        读数: org.policy.presence(),
        设置文件: 路径,
        说明: '读：本次没带「开关 / 小时」，没有改任何设置，也没入账（读不是设置入口）。',
      };
    }

    // 先校验：非法值立刻拒，且一个字节都不写。拒绝也要留痕。
    let 新开关;
    let 新小时;
    try {
      新开关 = 有开关 ? 解析开关(args.开关) : undefined;
      新小时 = 有小时 ? 解析设置小时(args.小时) : undefined;
    } catch (error) {
      await 记设置入账(org, {
        主体: subject,
        路径,
        依据: args.依据,
        结果: '拒绝（非法值，未写盘）',
        详情: { 拒绝理由: error instanceof Error ? error.message : String(error), 收到的: { 开关: args.开关 ?? null, 小时: args.小时 ?? null } },
      });
      throw error;
    }

    // 读-改-写一律在锁内：同一个部署里可能有别的会话也在改这份设置。
    // **写完的回读也在这同一个 try 里** —— 落盘成功但读数炸掉的场合（越界值就是这样）
    // 必须留痕、不许静默；否则盘上被改坏了、账上一条都没有、而调用方只看到一句「错误」。
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
      // 写完立刻重载：`presence()` 与工作台读的就是这一次 reload 之后的值。
      await org.policy.reload();
      读数 = org.policy.presence();
    } catch (error) {
      // 读不懂的文件、写不进去的盘、落盘之后算不出的读数：一律留痕，且如实说明盘动没动。
      const 原因 = error instanceof Error ? error.message : String(error);
      await 记设置入账(org, {
        主体: subject,
        路径,
        依据: args.依据,
        结果: 已写盘 ? `已写盘，但回读失败：${原因}` : `拒绝（未写盘）：${原因}`,
        详情: { 拒绝理由: 原因, 收到的: { 开关: args.开关 ?? null, 小时: args.小时 ?? null }, 写盘: 已写盘 },
      });
      throw error;
    }

    await 记设置入账(org, {
      主体: subject,
      路径,
      依据: args.依据,
      结果: 结果.变更.length > 0 ? `已写 ${结果.变更.join(' / ')}` : '无变更（原值与新值相同，未写盘）',
      详情: { 键: 结果.键详情, 变更: 结果.变更, 无变更: 结果.无变更, 写盘: 结果.变更.length > 0 },
    });
    return {
      设置文件: 路径,
      变更: 结果.变更,
      无变更: 结果.无变更,
      读数,
      说明: 结果.变更.length > 0
        ? '已改：这是 merge 写，只覆盖这两个键，文件里别的键原样保留。'
        : '原值与新值相同：没有需要写盘的东西，但已如实入账。',
    };
  },
};

/**
 * 「线程命中开过讨论段的节点 ⇒ 拒」——**唯一实现**，`bus_send` 与 `bus_unlock` 共用。
 *
 * 为什么必须单点：动作面往线程落消息的手有两只 —— `bus_send` 与 `bus_unlock`
 * （后者内部是 `unlock` 广播 `发件='system'`）。批c 独立复核把第一版甲（只写在 `bus_send` 里）
 * 攻破了一处（P2）：`bus_unlock{线程: 讨论节点}` 照旧放行 —— 判据抄在哪个 handler 里、
 * 就只有那个 handler 受保护。于是这里收成一处，两只手都调它；撤掉任何一处调用，
 * `test/debate-guards.test.js` 的 P2/P3 回归必红（校准读数见 `docs/设计债-2026-10-09.md` ⑰）。
 *
 * 判据（**精确到「开过讨论段」这一档**）：
 *  - 线程命中节点 **且** `node.讨论` 存在 ⇒ `Denied`。讨论**已收敛**照样拒（子状态不删，
 *    收敛后的发言在 `debate_say` 那边也会被拒 —— 动作面不开口子）；
 *  - 普通线程（根本不是节点 id / 没有讨论段的节点）⇒ 返回 `null`，调用方照旧往下走。
 *    `bus_unlock` 的正常用途正是后者：全员交卷后往**节点线程**解锁广播，而那时还没有讨论段。
 *
 * 命中的键（批c 补漏 · P3）：走 `线程等价键()`（`src/paths.js`，落线路径 `busThread` 的等价类
 * 就在那儿定义）—— **不许**用精确键：修前判定是精确键而落线走文件系统（NTFS 大小写不敏感），
 * 于是 `线程: 节点id.toUpperCase()` 判定 miss ⇒ 放行，而消息**落进同一个文件**
 * （实测 `readRaw(真 id)` 读得到，且类型闸一起废：连 `交卷` 都收）。
 *
 * 只判**落点**，不判内容：文案上的类型闸（`DEBATE_SAY_TYPES`）取自 `src/debate.js` 的唯一源。
 *
 * @param {{ org: object, 项目: string, 线程: string, 入口: 'bus_send'|'bus_unlock' }} spec
 * @returns {Promise<null>} 没命中讨论线程 ⇒ `null`（调用方继续）；命中 ⇒ 抛 `Denied`
 */
async function 拒讨论线程直灌({ org, 项目, 线程, 入口 }) {
  const 键 = 线程等价键(线程);
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
 * 复核员岗成员主体的档案解析（task-修复-lib-actions-j-649a4）。
 *
 * teammate 复核员的宿主主体是 kind=成员（subject.js 第 1 档：会话事实里没有岗位这一位，
 * 岗位由 registry_assign 落在身份档案）；而复核落账的策略判定需要复核者主体形状。
 * 这里按**档案真源**解析：在册、在岗、岗位=复核员 ⇒ 按复核者主体执行；
 * 其余一律原样返回（member 主体照旧走 scopeOf，任务外照拒——不放宽任何一格）。
 * 只在 task_review 这一个 handler 里解析：复核者的本职写权就是 review（只增证据），
 * 别的写动作仍按成员判（§2 复核者只读数、不改、不参与提案）。
 *
 * @param {object} org
 * @param {object} subject
 * @returns {Promise<object>}
 */
async function 复核者主体(org, subject) {
  if (subject?.kind !== '成员' || !org.registry?.identity) return subject;
  const member = (await org.registry.identity()).members[subject.id];
  if (member?.status === '在岗' && member.岗位 === '复核员') {
    return subjectForRole('复核员', subject.id);
  }
  return subject;
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
  const 盲标表 = new Map();
  return 消息.map((m) => {
    if (m.发件 === 读者.id || m.发件 === 'system') return m;
    if (!盲标表.has(m.发件)) 盲标表.set(m.发件, `成员 ${String.fromCharCode(65 + 盲标表.size)}`);
    return { ...m, 发件: 盲标表.get(m.发件), 内容: '（盲评期：全员交齐揭名前，他人的消息内容不可见）', 盲评遮罩: true };
  });
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
 *  - **只挂 `bus_send`**（发言场景）。`bus_unlock` **不挂**：它的落线是「齐卷解锁广播」
 *    （发件='system'，有自己的齐卷闸），全员交卷后触发是正路——⑰ 的 P2-正对照2 钉着它；
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
    解析 = JSON.parse(文本);
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
