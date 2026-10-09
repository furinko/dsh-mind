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
import { subjectFor } from '../src/org.js';
import { MEMORY_KINDS } from '../src/paths.js';

export { describeFailure } from '../src/kernel/errors.js';

/** 动作清单：工具 schema 的 enum 必须与它一致，别处不再枚举。 */
export const ACTIONS = [
  'status',
  'workbench',
  'policy_check',
  'task_create',
  'task_dispatch',
  'task_start',
  'task_submit',
  'task_review',
  'task_pending',
  'task_resolve',
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
 * 执行一个动作。
 *
 * @param {{ org: object, 项目: string, subject: object, args: object, 面?: 'tool'|'command', 主体?: object }} spec
 *   `面` 省略时按**工具面**处理（fail-closed：命令面专属动作默认够不着）。
 *   `主体` 显式给出时以它为准 —— 命令面用它记**真实主体**（谁敲的命令就是谁），
 *   不给的话就按 `args.role` / `args.实例` 推断（工具面的既有行为）。
 * @returns {Promise<object>} 结构化结果；调用方负责序列化。
 */
export async function runAction(spec) {
  const { org, subject } = spec;
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
  const 主体 = spec.主体 ?? subjectFor({ 岗位: args.role, 实例: args.实例, 根会话: subject?.kind === 'Lead' });
  // 自报的岗位不许直接变身份（B3）：成员/复核者的权来自身份档案里的实例，
  // 档案里没有、不在岗、或岗位对不上，一律按最严拒绝——与策略引擎的 §12.2 判定同口径。
  if (主体.kind === '成员' || 主体.kind === '复核者') {
    const member = (await org.registry.identity()).members[主体.id];
    if (!member || member.status !== '在岗' || (主体.roleId && member.岗位 !== 主体.roleId)) {
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
  const 结果 = await handler({ org, 项目, subject: 主体, args });
  return { action: args.action, 项目, 主体: { id: 主体.id, kind: 主体.kind, roleId: 主体.roleId ?? null }, ...结果 };
}

/** 每个动作一个函数；键名即 action 名。 */
const HANDLERS = {
  async status({ org }) {
    return { 数据: await org.status() };
  },

  async workbench({ org, 项目, subject, args }) {
    return {
      数据: await org.workbench({ 读者: args.全量 === true ? undefined : subject, 项目, 审计条数: args.审计条数 ?? 20 }),
      说明: '工作台是投影：只读，不存储，不是第二事实源。',
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
    return {
      结论: await org.review.record({
        subject,
        项目,
        节点: args.id,
        三态: args.三态,
        分歧清单: args.分歧清单,
        反例面: args.反例面,
        复核者: args.复核者,
      }),
    };
  },

  async task_pending({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.markPending(args.id, { subject, 项目, 原因: args.原因, 待决类型: args.待决类型 }) };
  },

  async task_resolve({ org, 项目, subject, args }) {
    return { 节点: await org.tasks.resolvePending(args.id, { subject, 项目, 决定: args.决定 }) };
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

  async memory_lifecycle({ org, subject, args }) {
    const op = args.op;
    if (op === 'invalidate') return { 结果: await org.memory.invalidate(args.id, { subject, 原因: args.原因 }) };
    if (op === 'demote') return { 结果: await org.memory.demote(args.id, { subject, 原因: args.原因 }) };
    if (op === 'overturn') return { 结果: await org.memory.overturn(args.id, { subject, 新条目: args.新条目, 理由: args.原因 }) };
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
    const 条目 = await org.capability.read({ id: args.id, 来源: args.来源 });
    if (!条目) throw new InvalidBody(`能力库里没有 ${args.id}`);
    return { 条目 };
  },

  async capability_publish({ org, subject, args }) {
    return { 能力: await org.capability.publish({ subject, 名: args.名, 正文: args.正文, 适用岗位: args.适用岗位, 依据: args.依据 ?? '组织自治' }) };
  },

  async bus_send({ org, 项目, subject, args }) {
    if (!args.线程) throw new InvalidBody('bus_send 需要 线程');
    return {
      消息: await org.bus.send({
        subject,
        项目,
        线程: args.线程,
        发件: args.发件 ?? subject.id,
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
    return { 消息: await org.bus.read({ subject, 项目, 线程: args.线程, 收件: args.收件, 未投递: args.未投递, limit: args.limit }) };
  },

  /**
   * 会审解锁的动作面入口（§9 两处边界写死之一）。
   *
   * 「全员已交」**不从调用方手里接**：那是自报的，报 true 就绕过边界了。
   * 这里从任务图**重算**——每个负责人都在 `独立答案` 里交过自己那份，才够格
   * 交给 `org.bus.unlock`（广播走 `send`，闸与审计与 `bus_send` 同一条路）。
   */
  async bus_unlock({ org, 项目, subject, args }) {
    if (!args.id) throw new InvalidBody('bus_unlock 需要 id（会审任务节点）', { missing: ['id'] });
    if (!args.线程) throw new InvalidBody('bus_unlock 需要 线程', { missing: ['线程'] });
    const 节点 = await org.tasks.get(args.id, { 项目 });
    const 负责人 = 节点?.负责人 ?? [];
    const 已交 = (节点?.独立答案 ?? []).map((a) => a.成员);
    const 全员已交 = Boolean(节点) && 节点.状态 === '已交卷' && 负责人.length > 0 && 负责人.every((r) => 已交.includes(r));
    if (!全员已交) {
      throw new Denied(
        '任务图 · 会审解锁边界（§9：全员已交才解锁）',
        `节点 ${args.id} 未全员交卷：状态 ${节点?.状态 ?? '不存在'}，已交 ${已交.filter((m) => 负责人.includes(m)).length}/${负责人.length}，会审保持锁定。`,
        {
          howToChange: '等每个负责人都 task_submit 交过自己那份（结论按人留），再执行 bus_unlock。',
          detail: { 节点: args.id, 状态: 节点?.状态 ?? null, 负责人, 已交 },
        },
      );
    }
    return {
      结果: await org.bus.unlock({ subject, 项目, 线程: args.线程, 全员已交: true, 参与者: args.收件 ?? 负责人, 内容: args.内容 }),
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
    return { 审计: rows.slice(-(args.limit ?? 20)), 说明: '审计只增：主权者也不能改，只能追加更正。' };
  },

  async audit_verify({ org }) {
    return { 校验: await org.audit.verify() };
  },

  async registry_list({ org }) {
    return { 岗位: await org.registry.list(), 实例: (await org.registry.identity()).members };
  },

  async registry_can({ org, args }) {
    if (!args.id) throw new InvalidBody('registry_can 需要 id');
    return { 能力: await org.registry.canTouch({ id: args.id }) };
  },

  async registry_assign({ org, subject, args }) {
    return { 实例: await org.registry.assign({ subject, 岗位: args.岗位, 实例: args.实例, 代: args.代 }) };
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
    return { 检查: await org.review.checkZeroDivergence({ subject, 项目, 节点: args.id, 结论集: args.结论集 ?? [] }) };
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
