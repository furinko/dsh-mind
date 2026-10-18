/**
 * 会审（v2 口述收敛 2026-10-18 条目18/19）——**与会话绑定的独立咨询功能，退出任务图**。
 *
 * 主权者原话：「按理说这应该是一个独立的功能」「会审按理说应该是和一个会话绑定的」
 * 「存到会审页里」。会审不再占任务节点、不走派发/复核/结账：
 *   抛问题（debate_open）→ N 个独立实例作答（debate_answer，盲评：未交齐互不可见）
 *   → 交齐解锁揭名（debate_unlock）→ 可选讨论（debate_round 显式开启/换轮，debate_say 发言）
 *   → 收敛（debate_converge，Lead）。每次会审完整存档：问题/各答案/分歧/结论/来源会话/时间。
 *
 * 配件裁决（条目19）：提交后解锁=留（盲评含在内）；强制反对者=砍（轻量咨询不值一次
 * 实例调用，分歧不足由零分歧报警补位）；零分歧报警=留（纯信号，存档记「零分歧异常」）；
 * 讨论段=留但默认不开（Lead 显式开启 = 第一次 debate_round），预算上限照旧。
 *
 * 分工（与旧讨论段同一规格精神）：
 *  - **状态权威在自己的事件流**：`任务图/<项目>/councils.jsonl`（append-only，与任务图
 *    同目录但独立账本）；本服务追加事件并 fold 成会审视图。旧任务图里的讨论段事件
 *    （debate_opened 等）原地只读不迁移——tasks.js 的 fold 分支保留给历史回放。
 *  - **讨论消息在总线**：发言经 `bus.send`（线程 = `会审-{id}`）落消息，审计走 send 的
 *    既有路径；换轮落「系统」边界消息，预算闸用消息流内部的边界切轮——不靠时钟对齐。
 *  - **预算现算**：每次 say 现读线程（`bus.readRaw`），不为预算另立存储。
 */
import { randomUUID } from 'node:crypto';
import { appendLines, readJsonl, serializeByKey, withLock } from './kernel/fsx.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';
import { DEFAULT_DEBATE_BUDGET } from './policy.js';
import { judgeZeroDivergence, 盲标分配 } from './review.js';

/** 讨论发言的合法类型（§9 消息类型里讨论段专用的三种）。 */
export const DEBATE_SAY_TYPES = ['分歧', '表态', '答复'];

/** 换轮边界消息的标记前缀（内容以它开头的系统消息 = 轮边界，预算按它切轮）。 */
export const ROUND_BOUNDARY_MARK = '[debate-round]';

/** 会审线程前缀：讨论消息线程 = `会审-{会审id}`（路径段合法形态——assertPathSegment 拒 `/`）。 */
export const COUNCIL_THREAD_PREFIX = '会审-';

export class CouncilService {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock, bus: object, registry: object }} spec
   *   bus / registry 依赖注入：本服务只编排，不自己实现总线与身份档案。
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
    this.bus = spec.bus;
    this.registry = spec.registry;
  }

  /**
   * 发起会审：抛问题 + 点名参与者（N 个在册在岗实例）。来源会话 = 发起人主体 id，入账。
   * @param {{ subject: object, 项目: string, 问题: string, 参与者: string[] }} spec
   */
  async open(spec) {
    const 问题 = String(spec.问题 ?? '').trim();
    if (!问题) throw new InvalidBody('会审需要「问题」：没有问题的会审没有收敛对象。', { missing: ['问题'] });
    const 参与者 = [...new Set((Array.isArray(spec.参与者) ? spec.参与者 : []).map(String))];
    if (参与者.length < 2) {
      throw new InvalidBody('会审至少要点两位参与者：独立作答的意义在多份答案互相校验，一个人的会审直接问本人即可。', { missing: ['参与者'] });
    }
    const 预算 = 会审预算(this.policy);
    if (参与者.length > 预算.人数上限) {
      throw new Denied('会审 · 人数上限', `参与者 ${参与者.length} 人超过人数上限 ${预算.人数上限}：会审按小会设计，规模上去请拆成多场。`, {
        requireAuthority: '主权者',
        howToChange: `拆成 ≤${预算.人数上限} 人的多场会审；或由主权者改私有 部署.json 的 会审讨论.人数上限。`,
        detail: { 参与人数: 参与者.length, 人数上限: 预算.人数上限 },
      });
    }
    // 参与者必须在册在岗：会审作答由成员实例承担，档案是唯一事实源（与派活同一条接线纪律）。
    const 档案 = (await this.registry.identity()).members ?? {};
    for (const id of 参与者) {
      const 记录 = 档案[id];
      if (!记录 || 记录.status === '封存') {
        throw new InvalidBody(`会审参与者 ${id} 不在身份档案的在岗名单里：会审答案要落到真实实例头上。`, {
          howToChange: '先 member_spawn / registry_assign 起实例，再把它列入参与者。',
          detail: { 参与者: id, 在册: Boolean(记录), 状态: 记录?.status ?? null },
        });
      }
    }
    const id = `council-${this.clock.ms().toString(36)}-${randomUUID().slice(0, 5)}`;
    await this.policy.check({
      subject: spec.subject,
      action: 'create',
      target: { id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: {},
    });
    const { view } = await this.#append(spec.项目, {
      kind: 'opened', id, 问题, 参与者,
      来源会话: spec.subject?.id ?? null,
      轮次上限: 预算.轮次上限,
      预算快照: { 每轮消息上限: 预算.每轮消息上限, 每人每轮字符上限: 预算.每人每轮字符上限 },
    }, spec.subject, '会审发起');
    return { 会审: view, id, 参与者, 来源会话: view.来源会话 };
  }

  /**
   * 作答：参与者各交一份独立答案（结论 + 结论层 + 反例面）。未交齐前互不可见
   * （盲评遮罩在 list 投影层）；同人再交替换自己那份。
   * @param {{ subject: object, 项目: string, id: string, 结论: string, 结论层?: string, 反例面?: string[] }} spec
   */
  async answer(spec) {
    const council = await this.#require(spec.项目, spec.id);
    if (council.状态 !== '作答中') {
      throw new Denied('会审 · 状态机', `会审 ${spec.id} 当前状态为 ${council.状态}，不再接受作答。`, {
        howToChange: council.状态 === '已解锁' || council.状态 === '讨论中' ? '已揭名：要表达立场用 debate_say（讨论开启时）；要改答案请 Lead 重新发起一场。' : '本场会审已收敛存档：结论已定格，有异议走新会审。',
      });
    }
    if (!council.参与者.includes(spec.subject?.id)) {
      throw new Denied('会审 · 仅参与者可作答', `${spec.subject?.id} 不在会审 ${spec.id} 的参与者名单（${council.参与者.join('、')}）里。`, {
        howToChange: '参与者由发起时点名；要参与请 Lead 重新发起并把你列入。',
      });
    }
    const 结论 = String(spec.结论 ?? '').trim();
    if (!结论) throw new InvalidBody('会审作答必须给「结论」：空答案不参与零分歧判定。', { missing: ['结论'] });
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id: spec.id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: { 会审: council },
    });
    const { view } = await this.#append(spec.项目, {
      kind: 'answered', id: spec.id, 成员: spec.subject.id,
      结论, 结论层: spec.结论层 ?? null, 反例面: spec.反例面 ?? [],
    }, spec.subject, '会审作答', {
      inLockGuard: (viewInLock) => {
        if (viewInLock?.状态 !== '作答中') throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 已不在作答中（锁内复检）。`);
      },
    });
    const 已交 = view.答案.length;
    return { 会审: this.#forViewer(view, spec.subject), 已交, 待交: council.参与者.length - 已交, 齐: 已交 >= council.参与者.length };
  }

  /**
   * 解锁（提交后解锁 · 条目19）：全员交齐后 Lead 揭名——盲评到此为止。
   * @param {{ subject: object, 项目: string, id: string }} spec
   */
  async unlock(spec) {
    const council = await this.#require(spec.项目, spec.id);
    if (spec.subject?.kind !== 'Lead' && spec.subject?.kind !== '主权者') {
      throw new Denied('会审 · 解锁仅 Lead', `解锁是「盲评到此为止」的流程决定：${spec.subject?.kind ?? '未知'} 不得执行。`, { requireAuthority: 'Lead' });
    }
    if (council.状态 !== '作答中') {
      throw new Denied('会审 · 状态机', `会审 ${spec.id} 当前状态为 ${council.状态}，不能解锁。`);
    }
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id: spec.id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: { 会审: council },
    });
    // 锁外那次状态读只为早失败与策略上下文；「齐卷」是读-判-写，并发两路解锁会
    // 同时读到「作答中 + 全员已交」。权威判定在锁内重做：先到的那次落线，后到的
    // 必须在锁内看见「已解锁」并拒，不许重复揭名。
    const { view } = await this.#append(spec.项目, { kind: 'unlocked', id: spec.id }, spec.subject, '会审解锁', {
      inLockGuard: (锁内) => {
        if (!锁内) throw new InvalidBody(`没有这场会审：${spec.id}（项目 ${spec.项目}）。会审存档在会审页可查。`);
        if (锁内.状态 !== '作答中') {
          throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 当前状态为 ${锁内.状态}，不能解锁（锁内复检：并发解锁 / 已揭名 / 已收敛）。`, {
            howToChange: '解锁只对「作答中」且全员已交的会审有效；已解锁的会审直接开讨论或收敛。',
          });
        }
        const 未交 = 锁内.参与者.filter((p) => !锁内.答案.some((a) => a.成员 === p));
        if (未交.length > 0) {
          throw new Denied('会审 · 全员已交才解锁（锁内复检）', `会审 ${spec.id} 未全员交卷：待交 ${未交.join('、')}。提前揭名会污染还没作答的独立判断。`, {
            detail: { 未交 },
          });
        }
      },
    });
    return { 会审: view };
  }

  /**
   * 换轮（讨论段 · 默认不开，Lead 显式开启）：第一次调用 = 开启讨论（轮次 1），
   * 之后 = 推进轮次。仅 Lead；轮次上限照旧。落「系统」边界消息切预算轮。
   * @param {{ subject: object, 项目: string, id: string }} spec
   */
  async round(spec) {
    const council = await this.#require(spec.项目, spec.id);
    this.#requireLead(spec.subject, '换轮/开启讨论');
    if (!['已解锁', '讨论中'].includes(council.状态)) {
      throw new Denied('会审 · 状态机', `会审 ${spec.id} 当前状态为 ${council.状态}：讨论在揭名之后才开得起来（先 debate_unlock）。`, {
        howToChange: '讨论是可选环节：多数会审在收敛前不需要它；确需讨论先解锁，再 debate_round。',
      });
    }
    if (council.轮次 >= council.轮次上限) {
      throw new Denied('会审 · 轮次上限', `轮次已到上限 ${council.轮次上限}：预算用尽就该收敛，无限换轮等于没有预算。`, {
        howToChange: '收敛（debate_converge）；上限调整走私有 部署.json 的 会审讨论.轮次上限（只影响之后开启的会审）。',
      });
    }
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id: spec.id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: { 会审: council },
    });
    // 新轮次只能在锁内定：锁外两路并发会读到同一个旧轮次，各自 +1 ⇒ 重复同一轮
    // 且吞掉一格上限（Lead 实证 Promise.all([round, round]) 两个都返回轮1）。
    // 事件对象按引用带进锁里改轮次，落线的行才是锁内算出的那一轮。
    const 事件 = { kind: 'rounded', id: spec.id, 轮次: 0 };
    const 结果 = { 轮次: null, 轮次上限: council.轮次上限, 提示: null };
    const { view } = await this.#append(
      spec.项目,
      事件,
      spec.subject,
      (锁内) => (锁内?.状态 === '已解锁' ? '讨论开启' : '会审换轮'),
      {
        inLockGuard: async (锁内) => {
          if (!锁内) throw new InvalidBody(`没有这场会审：${spec.id}（项目 ${spec.项目}）。会审存档在会审页可查。`);
          if (!['已解锁', '讨论中'].includes(锁内.状态)) {
            throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 当前状态为 ${锁内.状态}：讨论在揭名之后才开得起来（先 debate_unlock）（锁内复检）。`, {
              howToChange: '讨论是可选环节：多数会审在收敛前不需要它；确需讨论先解锁，再 debate_round。',
            });
          }
          if (锁内.轮次 >= 锁内.轮次上限) {
            throw new Denied('会审 · 轮次上限（锁内复检）', `轮次已到上限 ${锁内.轮次上限}：预算用尽就该收敛，无限换轮等于没有预算（锁内复检）。`, {
              howToChange: '收敛（debate_converge）；上限调整走私有 部署.json 的 会审讨论.轮次上限（只影响之后开启的会审）。',
            });
          }
          const 消息 = await this.bus.readRaw({ 项目: spec.项目, 线程: 线程名(spec.id) });
          const 边界轮 = 轮边界轮次(消息);
          // 跨存储对账：状态说第 N 轮，线程最后边界就必须是 N。上一次换轮的边界
          // 没落线时，推进下一轮会让发言落进错的一轮、把预算洗掉——拒绝并指人工补记。
          if (锁内.轮次 > 0 && 边界轮 !== 锁内.轮次) {
            throw new Fault('DEBATE_BOUNDARY_DRIFT', `会审 ${spec.id} 的状态轮次是 ${锁内.轮次}，但线程里最后一条轮边界是「${边界轮 ?? '缺失'}」：状态事件与轮边界跨存储失配。按 fail-closed 拒绝推进——先人工核对该线程并补记边界消息，再继续换轮。`, {
              detail: { 会审: spec.id, 状态轮次: 锁内.轮次, 边界轮次: 边界轮 },
            });
          }
          结果.轮次 = 锁内.轮次 + 1;
          结果.轮次上限 = 锁内.轮次上限;
          结果.提示 = 可收敛判定(本轮发言(消息, 锁内.参与者), 锁内.参与者);
          事件.轮次 = 结果.轮次;
        },
        // 边界消息与轮次事件同锁同序落线：锁外发边界会被并发换轮乱序（后发先至），
        // 预算闸按最后一条边界切轮 ⇒ 序号倒挂的那一轮切错。事件先落、边界后落：
        // 边界失败时状态已推进且可对账出来（上方 fail-closed），不会出现「边界切了轮、
        // 状态没推进」的洗预算方向。
        afterAppend: async (落线后) => {
          try {
            await this.bus.send({
              subject: { id: 'system', kind: '系统' },
              项目: spec.项目,
              线程: 线程名(spec.id),
              发件: 'system',
              收件: 落线后?.参与者 ?? council.参与者,
              类型: '系统',
              内容: `${ROUND_BOUNDARY_MARK} ${结果.轮次}`,
            });
          } catch (error) {
            throw new Fault('DEBATE_BOUNDARY_MISSING', `会审 ${spec.id} 轮次已推进到 ${结果.轮次}（事件已落线），但轮边界消息落线失败：${error instanceof Error ? error.message : String(error)}。不要重试 debate_round——请人工核对该线程并补记边界消息。`, {
              detail: { 会审: spec.id, 轮次: 结果.轮次 },
            });
          }
        },
      },
    );
    return { 会审: view, 轮次: 结果.轮次, 轮次上限: 结果.轮次上限, 结束轮可收敛: 结果.提示.可收敛, 结束轮说明: 结果.提示.说明 };
  }

  /**
   * 发言（讨论段）：参与者、仅讨论中；类型 ∈ {分歧, 表态, 答复}；经 bus.send 落线。
   * 预算闸现算（读线程），用发起时冻结的快照。
   * @param {{ subject: object, 项目: string, id: string, 类型: string, 内容: string }} spec
   */
  async say(spec) {
    const council = await this.#require(spec.项目, spec.id);
    if (council.状态 !== '讨论中') {
      throw new Denied('会审 · 没有开启讨论', `会审 ${spec.id} 当前状态为 ${council.状态}：讨论段默认不开（条目19），Lead 用 debate_round 显式开启后才能发言。`, {
        howToChange: '由 Lead 执行 debate_round 开启讨论；或直接把分歧写进自己的作答反例面。',
      });
    }
    if (!DEBATE_SAY_TYPES.includes(spec.类型)) {
      throw new InvalidBody(`讨论发言类型只有三种：${DEBATE_SAY_TYPES.join(' / ')}；收到「${spec.类型}」。`, { missing: ['类型'] });
    }
    if (!council.参与者.includes(spec.subject?.id)) {
      throw new Denied('会审 · 仅参与者可发言', `${spec.subject?.id} 不是会审 ${spec.id} 的参与者（${council.参与者.join('、')}）。旁听者看会审页 / bus_read。`);
    }
    const 内容 = String(spec.内容 ?? '').trim();
    if (!内容) throw new InvalidBody('讨论发言内容为空。');
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id: spec.id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: { 会审: council },
    });
    const 上限 = council.预算快照?.每轮消息上限 ?? DEFAULT_DEBATE_BUDGET.每轮消息上限;
    let 锁内本轮 = null;
    let 锁内轮次 = council.轮次;
    const 预算闸 = async () => {
      // 总线写锁内的最后一道预算复检（bus.send 的 锁内闸）：只读总线与事件流文件。
      // 更外层的会审串行锁已经挡住并发收敛/换轮；这里仍自洽重判预算与边界轮——
      // 两道锁各管一段（会审状态 vs 总线落线），不把口径押在同一处。
      const 锁内 = await this.#require(spec.项目, spec.id);
      if (锁内.状态 !== '讨论中') {
        throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 当前状态为 ${锁内.状态}：并发收敛/换轮之后不许复活发言（锁内复检）。`, {
          howToChange: '收敛后的结论已定格：要表达异议请 Lead 发起新会审；讨论未开启时先 debate_round。',
        });
      }
      const 消息 = await this.bus.readRaw({ 项目: spec.项目, 线程: 线程名(spec.id) });
      const 边界轮 = 轮边界轮次(消息);
      if (边界轮 !== 锁内.轮次) {
        throw new Fault('DEBATE_BOUNDARY_DRIFT', `会审 ${spec.id} 的状态轮次是 ${锁内.轮次}，但线程里最后一条轮边界是「${边界轮 ?? '缺失'}」：状态事件与轮边界跨存储失配，这条发言会洗掉预算——按 fail-closed 拒绝。先人工核对该线程并补记边界消息。`, {
          detail: { 会审: spec.id, 状态轮次: 锁内.轮次, 边界轮次: 边界轮 },
        });
      }
      const 每轮上限 = 锁内.预算快照?.每轮消息上限 ?? DEFAULT_DEBATE_BUDGET.每轮消息上限;
      const 每轮字上限 = 锁内.预算快照?.每人每轮字符上限 ?? DEFAULT_DEBATE_BUDGET.每人每轮字符上限;
      const 本轮 = 本轮发言(消息, 锁内.参与者);
      if (本轮.length >= 每轮上限) {
        throw new Denied('会审 · 每轮消息上限', `本轮发言已 ${本轮.length}/${每轮上限} 条，预算用尽。`, {
          howToChange: '换轮（debate_round，Lead）或收敛（debate_converge，Lead）。',
          detail: { 本轮消息数: 本轮.length, 每轮消息上限: 每轮上限, 轮次: 锁内.轮次 },
        });
      }
      const 已用 = 本轮.filter((m) => m.发件 === spec.subject?.id).reduce((n, m) => n + String(m.内容 ?? '').length, 0);
      if (已用 + 内容.length > 每轮字上限) {
        throw new Denied('会审 · 每人每轮字符上限', `${spec.subject?.id} 本轮已用 ${已用}/${每轮字上限} 字符，再发 ${内容.length} 字超限。`, {
          howToChange: '把要说的话压缩后再发，或等换轮后预算重置。',
          detail: { 本轮已用字符: 已用, 本次字符: 内容.length, 每人每轮字符上限: 每轮字上限 },
        });
      }
      锁内本轮 = 本轮;
      锁内轮次 = 锁内.轮次;
      return 本轮;
    };
    // 最终读-判-写与会审状态机**同一把串行锁**（锁序 council → bus）：修前 say 只拿
    // 总线线程锁，而 converge/round 持的是会审锁——复检结束到 appendLines 之间仍能
    // 插进一次收敛，旧发言就会追加到已收敛的会审上（初审实证）。现在整段进会审锁，
    // 锁内只读总线文件（不嵌套拿总线锁），真正的总线写在 bus.send 内部完成。
    const { sent, 轮次 } = await this.#withCouncilLock(spec.项目, async () => {
      const 锁内 = await this.#require(spec.项目, spec.id);
      if (锁内.状态 !== '讨论中') {
        throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 当前状态为 ${锁内.状态}：并发收敛/换轮之后不许复活发言（锁内复检）。`, {
          howToChange: '收敛后的结论已定格：要表达异议请 Lead 发起新会审；讨论未开启时先 debate_round。',
        });
      }
      const 消息 = await this.bus.readRaw({ 项目: spec.项目, 线程: 线程名(spec.id) });
      const 边界轮 = 轮边界轮次(消息);
      if (边界轮 !== 锁内.轮次) {
        throw new Fault('DEBATE_BOUNDARY_DRIFT', `会审 ${spec.id} 的状态轮次是 ${锁内.轮次}，但线程里最后一条轮边界是「${边界轮 ?? '缺失'}」：状态事件与轮边界跨存储失配，这条发言会洗掉预算——按 fail-closed 拒绝。先人工核对该线程并补记边界消息。`, {
          detail: { 会审: spec.id, 状态轮次: 锁内.轮次, 边界轮次: 边界轮 },
        });
      }
      await 预算闸();
      const sent = await this.bus.send({
        subject: spec.subject,
        项目: spec.项目,
        线程: 线程名(spec.id),
        发件: spec.subject.id,
        收件: council.参与者,
        类型: spec.类型,
        内容,
        锁内闸: 预算闸,
      });
      return { sent, 轮次: 锁内轮次 };
    });
    const 权威本轮 = 锁内本轮 ?? [];
    return { 消息: sent, 轮次, 本轮消息数: 权威本轮.length + 1, 每轮消息上限: 上限 };
  }

  /**
   * 收敛（仅 Lead）：算分歧清单（各答案反例面 ∪ 讨论分歧消息）+ 零分歧报警，
   * 存档 = 事件流里这场会审的完整视图（问题/各答案/分歧/结论/来源会话/时间齐全）。
   * @param {{ subject: object, 项目: string, id: string, 内容?: string }} spec
   */
  async converge(spec) {
    const council = await this.#require(spec.项目, spec.id);
    this.#requireLead(spec.subject, '收敛');
    if (council.状态 === '作答中') {
      throw new Denied('会审 · 未解锁不得收敛', `会审 ${spec.id} 还在作答中：先全员交齐并解锁（debate_unlock），再收敛。`);
    }
    if (council.状态 === '已收敛') {
      throw new Denied('会审 · 状态机', `会审 ${spec.id} 已收敛存档：结论已定格。`);
    }
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id: spec.id, kind: '会审', authority: '自治', zone: '私有', project: spec.项目 },
      context: { 会审: council },
    });
    // 分歧清单、零分歧判定、存档结论全部在锁内算：并发两次收敛会各自从锁外视图
    // 算一份结论，后到的必须在锁内看见「已收敛」并拒——否则同一场会审落两条结论、
    // 两笔零分歧报警（Lead 判据「并发收敛只成功一次」）。
    const 事件 = { kind: 'converged', id: spec.id, 结论: null, 分歧清单: [], 零分歧异常: false };
    const 结果 = { 分歧清单: [], 判定: null };
    const { view } = await this.#append(spec.项目, 事件, spec.subject, '会审收敛', {
      inLockGuard: async (锁内) => {
        if (!锁内) throw new InvalidBody(`没有这场会审：${spec.id}（项目 ${spec.项目}）。会审存档在会审页可查。`);
        if (锁内.状态 === '作答中') {
          throw new Denied('会审 · 未解锁不得收敛（锁内复检）', `会审 ${spec.id} 还在作答中：先全员交齐并解锁（debate_unlock），再收敛（锁内复检）。`);
        }
        if (锁内.状态 === '已收敛') {
          throw new Denied('会审 · 状态机（锁内复检）', `会审 ${spec.id} 已收敛存档：结论已定格（锁内复检：并发收敛只有一次能成功）。`);
        }
        const 消息 = await this.bus.readRaw({ 项目: spec.项目, 线程: 线程名(spec.id) });
        const 分歧清单 = [
          ...锁内.答案.flatMap((a) => (a.反例面 ?? []).map((x) => `${a.成员}: ${x}`)),
          ...本轮发言(消息, 锁内.参与者).filter((m) => m.类型 === '分歧').map((m) => `${m.发件}: ${m.内容}`),
          // 讨论里历史轮的分歧也要算（不只本轮）：收敛清的是全场的账。
          ...(消息 ?? []).filter((m) => m?.类型 === '分歧' && 锁内.参与者.includes(m?.发件)).map((m) => `${m.发件}: ${m.内容}`),
        ].filter((v, i, arr) => arr.indexOf(v) === i);
        // 零分歧报警（留 · 条目19）：结论层一致且无人给反例面 ⇒ 异常信号，随存档记。
        结果.分歧清单 = 分歧清单;
        结果.判定 = judgeZeroDivergence(锁内.答案);
        事件.结论 = String(spec.内容 ?? '').trim() || `收敛：会审结束（${锁内.答案.length} 份答案）`;
        事件.分歧清单 = 分歧清单;
        事件.零分歧异常 = 结果.判定.零分歧;
      },
      // 零分歧报警在事件落线后入账：并发第二路已在锁内被拒，不会多报；一旦这一段
      // 失败，事件已定格（不可重试），必须响亮并指人工补记。
      afterAppend: async () => {
        if (!结果.判定?.零分歧) return;
        try {
          await this.audit.append({
            动作: '零分歧异常',
            主体: { id: 'system', kind: '系统' },
            对象: { id: spec.id, kind: '会审' },
            依据: '§10 零分歧报警：结论层一致且无人给出反例面',
            结果: '会审零分歧异常',
            项目: spec.项目,
            详情: { 会审: spec.id, 结论层: 结果.判定.结论层, 参与人数: 结果.判定.参与人数 },
          });
        } catch (error) {
          throw new Fault('AUDIT_APPEND_FAILED_AFTER_EVENT', `会审 ${spec.id} 的收敛事件已落线，但「零分歧异常」审计追加失败：${error instanceof Error ? error.message : String(error)}。不要重试 debate_converge——结论已定格；请人工核对审计账本并补记。`, {
            detail: { 会审: spec.id, 项目: spec.项目 },
          });
        }
      },
    });
    return { 会审: view, 分歧清单: 结果.分歧清单, 零分歧: 结果.判定.零分歧, 零分歧依据: 结果.判定.依据 };
  }

  /**
   * 会审页数据源：本项目全部会审的存档视图（进行中的也在列，状态字段如实标）。
   * 盲评遮罩（条目19「提交后解锁含盲评」）：作答中且读者是参与者成员时，别人的答案
   * 只留盲标；Lead/主权者/复核员与解锁后全量。
   * @param {{ 项目: string, 读者?: object }} query
   */
  async list(query) {
    const views = await this.#foldAll(query.项目);
    return views.map((v) => this.#forViewer(v, query.读者));
  }

  /** @param {string} 项目 @param {string} id @returns {Promise<object|null>} */
  async get(项目, id) {
    const views = await this.#foldAll(项目);
    return views.find((v) => v.id === id) ?? null;
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  // 作答回执也是读面；只在列表遮罩会让后交卷者从自己的回执读到他人的盲评答案。
  #forViewer(view, reader) {
    if (view.状态 !== '作答中' || reader?.kind !== '成员' || reader.roleId === '复核员') return view;
    const 标 = new Map(盲标分配(线程名(view.id), view.参与者).map((e) => [e.id, e.盲标]));
    return {
      ...view,
      盲评遮罩: true,
      答案: view.答案.map((a) => a.成员 === reader.id ? a : {
        成员: 标.get(a.成员) ?? '成员?', 结论: null, 结论层: null, 反例面: [],
      }),
    };
  }

  #requireLead(subject, 动作名) {
    if (subject?.kind !== 'Lead' && subject?.kind !== '主权者') {
      throw new Denied(`会审 · ${动作名}仅 Lead`, `${subject?.kind ?? '未知'} 不得执行${动作名}：这是「流程到此为止」的决定，不是发言权的一部分。`, {
        requireAuthority: 'Lead',
        howToChange: `由 Lead 执行；成员用 debate_answer 作答、debate_say（讨论开启时）发言。`,
      });
    }
  }

  async #require(项目, id) {
    const council = await this.get(项目, id);
    if (!council) throw new InvalidBody(`没有这场会审：${id}（项目 ${项目}）。会审存档在会审页可查。`);
    return council;
  }

  /**
   * 在会审串行锁内执行一段「读-判-写」——**会审状态变更的唯一锁序**。
   *
   * 锁序固定 `council → bus`：round 的边界消息、say 的发言都在持会审锁时进总线；
   * 反过来（先 bus 再 council）一律不做——同一把锁不可重入，反向拿锁迟早互等死锁。
   * 锁内只允许**读**总线/事件流文件（`readJsonl`/`readRaw` 不拿锁），不嵌套同键锁。
   *
   * @template T
   * @param {string} 项目
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  async #withCouncilLock(项目, fn) {
    const file = this.layout.councilLog(项目);
    return serializeByKey(file, () => withLock(this.layout.councilLock(项目), fn));
  }

  /**
   * 事件落线 + 审计（与任务图 #append 同款纪律：事件落线后审计失败要响亮、不许重试）。
   *
   * @param {string} 项目
   * @param {object} event 事件行；**按引用**传进锁，锁内改字段（如轮次）后落线的是锁内值。
   * @param {object} subject
   * @param {string|((current: object|null) => string)} 审计动作 需要按锁内状态区分的动作名传函数。
   * @param {{ inLockGuard?: ((current: object|null) => (void|Promise<void>))|null, afterAppend?: ((view: object|undefined, current: object|null) => (void|Promise<void>))|null }} [hooks]
   *   `inLockGuard(current)`：锁内、落线前的权威复检（会审的解锁/换轮/收敛/作答全是读-判-写，
   *   锁外读到的视图只配早失败——并发两路会读到同一个旧视图）。
   *   `afterAppend(view, current)`：锁内、事件与审计落线后的第二步写入（换轮边界消息必须与
   *   轮次事件同锁同序；放锁外发会被并发换轮乱序，预算闸按最后一条边界切轮就切错）。
   */
  async #append(项目, event, subject, 审计动作, { inLockGuard = null, afterAppend = null } = {}) {
    const file = this.layout.councilLog(项目);
    const eventId = `${event.kind}-${randomUUID().slice(0, 8)}`;
    return this.#withCouncilLock(项目, async () => {
      const rows = await readJsonl(file);
      const views = foldCouncils(rows);
      const current = views.find((v) => v.id === event.id) ?? null;
      if (inLockGuard) await inLockGuard(current);
      const row = { ...event, at: this.clock.iso(), by: subject, eventId };
      await appendLines(file, [row]);
      const 动作 = typeof 审计动作 === 'function' ? 审计动作(current) : 审计动作;
      try {
        await this.audit.append({
          动作,
          主体: subject,
          对象: { id: event.id, kind: '会审' },
          依据: 'v2 条目18：会审 = 会话绑定的独立咨询功能，存档在自己的事件流',
          结果: event.kind,
          项目,
          详情: { kind: event.kind },
        });
      } catch (error) {
        throw new Fault('AUDIT_APPEND_FAILED_AFTER_EVENT', `会审 ${event.id} 的事件（${event.kind}）已落线，但审计追加失败：${error instanceof Error ? error.message : String(error)}。不要重试同一动作（重复事件会撞锁内复检或覆盖状态）——请人工核对审计账本并补记。`, {
          detail: { 会审: event.id, kind: event.kind, 项目 },
        });
      }
      const 落线后 = foldCouncils([...rows, row]);
      const view = 落线后.find((v) => v.id === event.id);
      if (afterAppend) await afterAppend(view, current);
      return { view };
    });
  }

  async #foldAll(项目) {
    const rows = await readJsonl(this.layout.councilLog(项目));
    return foldCouncils(rows);
  }
}

/** 会审线程名（单一拼法：actions 的直灌闸与本服务共用）。 */
export function 线程名(councilId) {
  return `${COUNCIL_THREAD_PREFIX}${councilId}`;
}

/**
 * 会审事件流 → 视图（append-only fold）。一场会审的完整存档 = 这里折出的视图：
 * 问题/各答案/分歧/结论/来源会话/时间——会审页直接读它，不另立存档库。
 */
export function foldCouncils(rows) {
  const map = new Map();
  for (const row of rows ?? []) {
    let c = map.get(row.id);
    if (!c) {
      c = { id: row.id, 问题: null, 参与者: [], 来源会话: null, 状态: '未知', 答案: [], 轮次: 0, 轮次上限: 0, 预算快照: null, 分歧清单: [], 结论: null, 创建于: null, 收敛于: null, 零分歧异常: false };
      map.set(row.id, c);
    }
    switch (row.kind) {
      case 'opened':
        c.问题 = row.问题;
        c.参与者 = row.参与者 ?? [];
        c.来源会话 = row.来源会话 ?? null;
        c.轮次上限 = row.轮次上限 ?? 0;
        c.预算快照 = row.预算快照 ?? null;
        c.状态 = '作答中';
        c.创建于 = row.at;
        break;
      case 'answered': {
        const 他人 = c.答案.filter((a) => a.成员 !== row.成员);
        c.答案 = [...他人, { 成员: row.成员, 结论: row.结论 ?? null, 结论层: row.结论层 ?? null, 反例面: row.反例面 ?? [], 于: row.at }];
        break;
      }
      case 'unlocked':
        c.状态 = '已解锁';
        c.解锁于 = row.at;
        break;
      case 'rounded':
        c.状态 = '讨论中';
        c.轮次 = row.轮次 ?? (c.轮次 + 1);
        break;
      case 'converged':
        c.状态 = '已收敛';
        c.结论 = row.结论 ?? null;
        c.分歧清单 = row.分歧清单 ?? [];
        c.零分歧异常 = row.零分歧异常 === true;
        c.收敛于 = row.at;
        break;
      default:
        break; // 未知事件类型：只增账本的旧行/未来行都不炸 fold（向前兼容）。
    }
  }
  return [...map.values()];
}

/**
 * 读取当前生效的会审讨论预算（policy 加载期已校验并规范化成四键齐全）。
 * @param {import('./policy.js').PolicyEngine} policy
 */
export function 会审预算(policy) {
  return { ...DEFAULT_DEBATE_BUDGET, ...(policy.state.defaults?.会审讨论 ?? {}) };
}

/**
 * 最后一条轮边界消息的位置与轮次 —— **轮边界判定的单一源**。
 *
 * 为什么把「认边界」抽出来：预算切轮（`本轮发言`）与跨存储对账（`轮边界轮次`）
 * 必须认同一行、同一段前缀；各写一份，对账口径先漂，预算闸就会在漂掉的那一支上
 * 静默放行（verify-integrity 配方22：匹配口径也是覆盖面）。
 *
 * @param {object[]} 集合
 * @returns {{ 位置: number, 轮次: number|null }} 无边界时 位置=-1 / 轮次=null；
 *   边界消息内容里的轮号不是整数时 轮次=null（对账侧按失配处理）。
 */
function 最后边界(集合) {
  for (let i = 集合.length - 1; i >= 0; i -= 1) {
    const m = 集合[i];
    if (m?.发件 === 'system' && String(m?.类型) === '系统' && String(m?.内容 ?? '').startsWith(ROUND_BOUNDARY_MARK)) {
      const 轮 = Number(String(m.内容 ?? '').slice(ROUND_BOUNDARY_MARK.length).trim());
      return { 位置: i, 轮次: Number.isInteger(轮) && 轮 > 0 ? 轮 : null };
    }
  }
  return { 位置: -1, 轮次: null };
}

/**
 * 线程里最后一条轮边界消息声明的轮次（无边界 ⇒ null）。
 *
 * 会审的轮次状态住在 `councils.jsonl`、预算轮住在总线线程——两个存储各自只增，
 * 因此每次「写前读」都要对一次账：状态说第 N 轮，边界就必须是 N。对不上时调用方
 * 必须 fail-closed（拒绝写并指明人工补记），不许把消息记进错的一轮把预算洗掉。
 *
 * @param {object[]} messages 折叠后的线程消息（`bus.readRaw` 的输出）
 * @returns {number|null}
 */
export function 轮边界轮次(messages) {
  return 最后边界(messages ?? []).轮次;
}

/**
 * 本轮发言：**最后一条**轮边界消息（`[debate-round]` 系统消息）之后的**名单内**发言
 * （类型 ∈ 分歧/表态/答复，且 `发件 ∈ 名单`）。第 1 轮没有边界消息 ⇒ 全部消息算本轮。
 * 名单必填：漏传会让预算闸静默失效（fail-open），按 fail-closed 拒。
 *
 * @param {object[]} messages 折叠后的线程消息（`bus.readRaw` 的输出）
 * @param {string[]} 名单 预算名单（= 会审参与者；v2 起没有强制反对者）
 * @returns {object[]}
 */
export function 本轮发言(messages, 名单) {
  if (!Array.isArray(名单)) {
    throw new InvalidBody('本轮发言 需要 名单（会审参与者）：漏传会让预算闸静默失效（fail-open），按 fail-closed 拒。', {
      missing: ['名单'],
    });
  }
  const 集合 = messages ?? [];
  const 在名单 = new Set(名单.filter((id) => typeof id === 'string' && id !== ''));
  const { 位置 } = 最后边界(集合);
  return 集合.slice(位置 + 1).filter((m) => DEBATE_SAY_TYPES.includes(m?.类型) && 在名单.has(m?.发件));
}

/**
 * 可收敛判据：本轮零新「分歧」消息 **且** 每个参与者都发过「表态」。
 * @param {object[]} 本轮 @param {string[]} 参与者
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
