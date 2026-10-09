/**
 * 会审讨论段（W2 规格 2026-10-09，冻结）——协作环路的最后一块。
 *
 * 分工（状态机规格：「任务图事件流为权威，bus 只承载消息」）：
 *  - **状态权威在任务图**：`debate_opened / debate_round / debate_converged` 三个事件
 *    由 `TaskGraph` 追加并 fold 成节点的 `讨论` 子状态；本文件不写任务图事件，
 *    只做编排（齐卷重算、预算快照、揭名、消息落线）。
 *  - **消息在总线**：发言经 `bus.send`（线程 = 节点 id）落消息，审计走 send 的既有路径；
 *    换轮时落一条「系统」边界消息，预算闸用**消息流内部的边界**切轮——不靠时钟对齐。
 *  - **预算现算**：每次 say 现读线程（`bus.readRaw`，同一事实源、无闸无审计噪音），
 *    不为预算另立任何存储。
 *
 * 对 review 是**软约束**（设计取舍已定）：讨论中仍可 review，工作台会审行标注
 * 「讨论未收敛」——不许把「Lead 不收敛」变成组织死锁。
 */
import { Denied, InvalidBody } from './kernel/errors.js';
import { DEFAULT_DEBATE_BUDGET } from './policy.js';

/** 讨论发言的合法类型（§9 消息类型里讨论段专用的三种）。 */
export const DEBATE_SAY_TYPES = ['分歧', '表态', '答复'];

/** 换轮边界消息的标记前缀（内容以它开头的系统消息 = 轮边界，预算按它切轮）。 */
export const ROUND_BOUNDARY_MARK = '[debate-round]';

export class DebateService {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock, tasks: object, bus: object, review: object }} spec
   *   tasks / bus / review 由依赖注入：本服务只编排，不自己实现任务图、总线与复核协议。
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
    this.tasks = spec.tasks;
    this.bus = spec.bus;
    this.review = spec.review;
  }

  /**
   * 开启讨论。前置（与 bus_unlock 同判据，从事件流重算——**不信自报**）：
   * 节点 状态=已交卷 且 每个负责人都交过自己的独立答案。
   * 参与者 = 独立答案成员数，超过人数上限拒（提示拆会审）。
   * 开启时 `review.reveal` 揭名并**冻结预算快照**（之后改部署.json 不影响进行中的讨论）。
   *
   * @param {{ subject: object, 项目: string, 节点: string }} spec
   * @returns {Promise<{ 节点: object, 参与者: string[], 轮次: number, 轮次上限: number, 揭名: object[] }>}
   */
  async open(spec) {
    const node = await this.#node(spec.项目, spec.节点);
    const 负责人 = node.负责人 ?? [];
    const 已交 = (node.独立答案 ?? []).map((a) => a.成员);
    // 齐卷判据与 bus_unlock 同一款重算：状态已交卷 + 负责人非空 + 每人都有自己的独立答案。
    const 齐 = node.状态 === '已交卷' && 负责人.length > 0 && 负责人.every((r) => 已交.includes(r));
    if (!齐) {
      throw new Denied(
        '会审讨论段 · 全员已交才开启（与 bus_unlock 同判据）',
        `节点 ${spec.节点} 未全员交卷：状态 ${node.状态}，已交 ${已交.filter((m) => 负责人.includes(m)).length}/${负责人.length}，讨论不能开启。`,
        {
          howToChange: '等每个负责人都 task_submit 交过自己那份（结论按人留），再执行 debate_open。',
          detail: { 状态: node.状态, 负责人, 已交 },
        },
      );
    }
    const 预算 = 会审预算(this.policy);
    const 参与者 = [...已交];
    if (参与者.length > 预算.人数上限) {
      throw new Denied(
        '会审讨论段 · 人数上限',
        `参与者 ${参与者.length} 人超过人数上限 ${预算.人数上限}：讨论预算按小会审设计，大会审请拆节点。`,
        {
          requireAuthority: '主权者',
          howToChange: `把该节点拆成 ≤${预算.人数上限} 人的多个会审节点；或由主权者改私有 部署.json 的 会审讨论.人数上限。`,
          detail: { 参与人数: 参与者.length, 人数上限: 预算.人数上限 },
        },
      );
    }
    // 揭名：盲评到此为止，讨论阶段亮出彼此身份（§10）。
    const 揭名 = await this.review.reveal({ subject: spec.subject, 项目: spec.项目, 线程: spec.节点, 参与者 });
    const 预算快照 = { 每轮消息上限: 预算.每轮消息上限, 每人每轮字符上限: 预算.每人每轮字符上限 };
    const 节点投影 = await this.tasks.debateOpened(spec.节点, {
      subject: spec.subject,
      项目: spec.项目,
      参与者,
      轮次上限: 预算.轮次上限,
      预算快照,
    });
    return { 节点: 节点投影, 参与者, 轮次: 1, 轮次上限: 预算.轮次上限, 揭名: 揭名.揭名 };
  }

  /**
   * 发言：仅参与者、仅讨论中；类型 ∈ {分歧, 表态, 答复}；经 `bus.send`（线程=节点id）落消息。
   * 预算闸**现算**（读线程）：本轮消息数 < 每轮消息上限、该成员本轮累计字符 + 新内容
   * ≤ 每人每轮字符上限——用的是**开启时冻结的快照**，不是当前部署值。
   * 审计走 bus.send 既有路径（W2 规格），本方法不另记。
   *
   * @param {{ subject: object, 项目: string, 节点: string, 类型: string, 内容: string }} spec
   * @returns {Promise<{ 消息: object, 轮次: number, 本轮消息数: number, 每轮消息上限: number }>}
   */
  async say(spec) {
    const node = await this.#node(spec.项目, spec.节点);
    const 讨论 = this.#requireOpen(node);
    if (!DEBATE_SAY_TYPES.includes(spec.类型)) {
      throw new InvalidBody(`讨论发言类型只有三种：${DEBATE_SAY_TYPES.join(' / ')}；收到「${spec.类型}」。`, { missing: ['类型'] });
    }
    if (!讨论.参与者.includes(spec.subject?.id)) {
      throw new Denied(
        '会审讨论段 · 仅参与者可发言',
        `${spec.subject?.id} 不是节点 ${spec.节点} 的讨论参与者（${讨论.参与者.join('、')}）。旁听者不进讨论，看板与 bus_read 可以看。`,
        { howToChange: '讨论只在交过独立答案的参与者之间进行；要发声请先成为该会审节点的负责人并交卷。' },
      );
    }
    const 内容 = String(spec.内容 ?? '').trim();
    if (!内容) throw new InvalidBody('讨论发言内容为空。');

    // 预算闸（现算）：本轮 = 最后一条轮边界消息之后的参与者发言。
    const 消息 = await this.bus.readRaw({ 项目: spec.项目, 线程: spec.节点 });
    const 本轮 = 本轮发言(消息);
    const 上限 = 讨论.预算快照?.每轮消息上限 ?? DEFAULT_DEBATE_BUDGET.每轮消息上限;
    if (本轮.length >= 上限) {
      throw new Denied(
        '会审讨论段 · 每轮消息上限',
        `本轮发言已 ${本轮.length}/${上限} 条，预算用尽。`,
        {
          howToChange: '换轮（debate_round，Lead）或收敛（debate_converge，Lead）；上限可在私有 部署.json 的 会审讨论.每轮消息上限 调整（只影响之后开启的讨论）。',
          detail: { 本轮消息数: 本轮.length, 每轮消息上限: 上限, 轮次: 讨论.轮次 },
        },
      );
    }
    const 字上限 = 讨论.预算快照?.每人每轮字符上限 ?? DEFAULT_DEBATE_BUDGET.每人每轮字符上限;
    const 已用 = 本轮.filter((m) => m.发件 === spec.subject?.id).reduce((n, m) => n + String(m.内容 ?? '').length, 0);
    if (已用 + 内容.length > 字上限) {
      throw new Denied(
        '会审讨论段 · 每人每轮字符上限',
        `${spec.subject?.id} 本轮已用 ${已用}/${字上限} 字符，再发 ${内容.length} 字超限。`,
        {
          howToChange: '把要说的话压缩后再发，或等换轮（debate_round）后预算重置；上限调整走私有 部署.json 的 会审讨论.每人每轮字符上限。',
          detail: { 本轮已用字符: 已用, 本次字符: 内容.length, 每人每轮字符上限: 字上限, 轮次: 讨论.轮次 },
        },
      );
    }

    const sent = await this.bus.send({
      subject: spec.subject,
      项目: spec.项目,
      线程: spec.节点,
      发件: spec.subject.id,
      收件: 讨论.参与者,
      类型: spec.类型,
      内容,
    });
    return { 消息: sent, 轮次: 讨论.轮次, 本轮消息数: 本轮.length + 1, 每轮消息上限: 上限 };
  }

  /**
   * 换轮：轮次 < 轮次上限才放行（上限判定在任务图状态机面）；返回**即将结束的这轮**的
   * 可收敛提示 =（本轮零新「分歧」消息 且 每个参与者都发过「表态」）。
   * 换轮动作本身落一条「系统」边界消息——预算切轮靠消息流内部边界，不靠时钟对齐。
   *
   * @param {{ subject: object, 项目: string, 节点: string }} spec
   */
  async round(spec) {
    const node = await this.#node(spec.项目, spec.节点);
    const 讨论 = this.#requireOpen(node);
    const 消息 = await this.bus.readRaw({ 项目: spec.项目, 线程: spec.节点 });
    const 本轮 = 本轮发言(消息);
    const 提示 = 可收敛判定(本轮, 讨论.参与者);
    const 节点投影 = await this.tasks.debateRounded(spec.节点, { subject: spec.subject, 项目: spec.项目, 轮次: 讨论.轮次 + 1 });
    // 边界消息：之后的所有参与者发言都属于新轮。经 bus.send 落线（走它的闸与审计），
    // 发件是系统——预算过滤只认参与者发言（类型 ∈ 三种），系统边界不会被算进任何人头上。
    await this.bus.send({
      subject: { id: 'system', kind: '系统' },
      项目: spec.项目,
      线程: spec.节点,
      发件: 'system',
      收件: 讨论.参与者,
      类型: '系统',
      内容: `${ROUND_BOUNDARY_MARK} ${讨论.轮次 + 1}`,
    });
    return {
      节点: 节点投影,
      轮次: 讨论.轮次 + 1,
      轮次上限: 讨论.轮次上限,
      结束轮可收敛: 提示.可收敛,
      结束轮说明: 提示.说明,
    };
  }

  /**
   * 收敛：仅 Lead。Lead 的**末位表态**经 `bus.send`（类型=表态，发件=lead）落消息，
   * 消息 id 记进收敛事件；此后 `debate_say` 拒（讨论已收敛）。
   *
   * @param {{ subject: object, 项目: string, 节点: string, 内容?: string }} spec
   */
  async converge(spec) {
    const node = await this.#node(spec.项目, spec.节点);
    const 讨论 = this.#requireOpen(node);
    if (spec.subject?.kind !== 'Lead') {
      throw new Denied(
        '会审讨论段 · 收敛仅 Lead（W2 规格 2026-10-09）',
        `${spec.subject?.kind ?? '未知'} 不得执行收敛：收敛是「讨论到此为止」的流程决定，末位表态由 Lead 落。`,
        {
          requireAuthority: 'Lead',
          howToChange: '由 Lead 执行 debate_converge；成员用 debate_say（类型=表态）表达最终立场。',
        },
      );
    }
    // 末位表态不受 say 的预算闸（它是收敛动作的一部分，且之后不能再发言）；
    // 仍走 bus.send 的策略闸与审计路径（W2 规格：debate_say 的审计走 bus.send 既有路径）。
    const sent = await this.bus.send({
      subject: spec.subject,
      项目: spec.项目,
      线程: spec.节点,
      发件: 'lead',
      收件: 讨论.参与者,
      类型: '表态',
      内容: String(spec.内容 ?? '').trim() || `收敛：讨论结束（第 ${讨论.轮次} 轮）`,
    });
    const 节点投影 = await this.tasks.debateConverged(spec.节点, { subject: spec.subject, 项目: spec.项目, 表态消息id: sent.id });
    return { 节点: 节点投影, 表态消息id: sent.id, 轮次: 讨论.轮次 };
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** @param {string} 项目 @param {string} 节点 */
  async #node(项目, 节点) {
    const node = await this.tasks.get(节点, { 项目 });
    if (!node) throw new InvalidBody(`没有这个任务节点：${节点}（项目 ${项目}）`);
    return node;
  }

  /** @param {object} node */
  #requireOpen(node) {
    if (!node.讨论) {
      throw new Denied('会审讨论段 · 状态机', `节点 ${node.id} 没有开启讨论段。`, {
        howToChange: '先 debate_open（前置：全员已交卷，与 bus_unlock 同判据）。',
      });
    }
    if (node.讨论.状态 !== '讨论中') {
      throw new Denied('会审讨论段 · 已收敛', `节点 ${node.id} 的讨论已收敛（表态消息 ${node.讨论.表态消息id ?? '-'}），不再接受发言与换轮。`, {
        howToChange: '讨论已收敛：走复核（review）。',
      });
    }
    return node.讨论;
  }
}

/**
 * 读取当前生效的会审讨论预算（policy 加载期已校验并规范化成四键齐全）。
 * @param {import('./policy.js').PolicyEngine} policy
 * @returns {{ 轮次上限: number, 人数上限: number, 每轮消息上限: number, 每人每轮字符上限: number }}
 */
export function 会审预算(policy) {
  return { ...DEFAULT_DEBATE_BUDGET, ...(policy.state.defaults?.会审讨论 ?? {}) };
}

/**
 * 本轮发言：**最后一条**轮边界消息（`[debate-round]` 系统消息）之后的参与者发言
 * （类型 ∈ 分歧/表态/答复，发件非 system）。第 1 轮没有边界消息 ⇒ 全部消息算本轮。
 *
 * 用消息流内部的边界切轮而不是时钟：边界消息与发言同账同序，没有「同一秒里
 * round 与 say 谁先谁后」的对齐问题。
 *
 * @param {object[]} messages 折叠后的线程消息（`bus.readRaw` 的输出）
 * @returns {object[]}
 */
export function 本轮发言(messages) {
  const 集合 = messages ?? [];
  let 边界 = -1;
  for (let i = 集合.length - 1; i >= 0; i -= 1) {
    const m = 集合[i];
    if (m?.发件 === 'system' && String(m?.类型) === '系统' && String(m?.内容 ?? '').startsWith(ROUND_BOUNDARY_MARK)) {
      边界 = i;
      break;
    }
  }
  return 集合.slice(边界 + 1).filter((m) => DEBATE_SAY_TYPES.includes(m?.类型) && m?.发件 !== 'system');
}

/**
 * 可收敛判据（W2 规格）：本轮零新「分歧」消息 **且** 每个参与者都发过「表态」。
 *
 * @param {object[]} 本轮 本轮发言（`本轮发言()` 的输出）
 * @param {string[]} 参与者
 * @returns {{ 可收敛: boolean, 说明: string, 详情: { 新分歧: number, 已表态: string[], 未表态: string[] } }}
 */
export function 可收敛判定(本轮, 参与者) {
  const 新分歧 = 本轮.filter((m) => m.类型 === '分歧').length;
  const 已表态 = [...new Set(本轮.filter((m) => m.类型 === '表态').map((m) => m.发件))];
  const 未表态 = (参与者 ?? []).filter((p) => !已表态.includes(p));
  const 可收敛 = 新分歧 === 0 && 未表态.length === 0;
  const 说明 = 可收敛
    ? '本轮零新分歧且每个参与者都已表态：可以收敛（debate_converge，Lead）。'
    : `不可收敛：${新分歧 > 0 ? `本轮还有 ${新分歧} 条新分歧未答复` : '零新分歧'}；${未表态.length > 0 ? `未表态：${未表态.join('、')}` : '已全员表态'}。`;
  return { 可收敛, 说明, 详情: { 新分歧, 已表态, 未表态 } };
}
