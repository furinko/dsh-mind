/**
 * 任务图（§7「任务依赖与状态」）。
 *
 * 设计给这一件压了五条「必须保证」，本文件的形状全由它们决定：
 *  1. **验收标准必填** —— 建节点时不带判据直接拒。
 *  2. **派发后判据冻结** —— 事件流过 `dispatched` 之后，任何带 `判据` 的事件都被拒。
 *  3. **待决项是节点状态** —— 不是另一个队列；清空队列不删记录（§3 不可逆资源）。
 *  4. **一岗多人必标模式** —— 两个人以上而没声明「并行分担/独立会审」直接拒。
 *  5. **产出物只存引用** —— 节点里不出现产出物正文。
 *
 * 状态权威的实现方式是 **append-only 事件流 + 折叠**：`tasks.jsonl` 是真相，
 * 内存里的节点只是它的投影，因此重启后一切都能重算（§12.4）。
 */
import { appendLines, readJsonl, withLock } from './kernel/fsx.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';

/** 一岗多人的两种模式（§10）。 */
export const MULTI_MODES = ['并行分担', '独立会审'];

/** 复核三态（§8）。「未验 ≠ 通过」，且不计打回。 */
export const REVIEW_VERDICTS = ['过', '不过', '未验'];

const TERMINAL = new Set(['已采纳', '已结账']);

/**
 * 合法转移表：主干环路（受理→定判据→派发→执行→交卷→复核→采纳/打回）的次序由它强制执行。
 * 没有它，「已采纳」能被 start 复活、「待派发」能直接 review 成已采纳——环路次序就没有强制力。
 *  - start：已派发开工；已打回/未验返工。
 *  - submit：执行中交卷；已交卷再交 = 会审里另一个人交他自己的那份（fold 按人留）。
 *  - review：已交卷初核；未验/已打回后再核。
 *  - markPending：任何非终态、非待决；resolvePending：只在待决。
 *  - attach：任何非终态。
 */
const TRANSITIONS = {
  start: ['已派发', '已打回', '未验'],
  submit: ['执行中', '已交卷'],
  review: ['已交卷', '未验', '已打回'],
  markPending: ['待派发', '已派发', '执行中', '已交卷', '未验', '已打回'],
  resolvePending: ['待决'],
  attach: ['待派发', '已派发', '执行中', '已交卷', '未验', '已打回', '待决'],
  // settle（W3 批3）：结账是环路的**最后一步**，只从「已采纳」出发——
  // 复核没过就打回重做，没采纳的节点不许结账（那会把未验收的工作收进终态）。
  settle: ['已采纳'],
};

export class TaskGraph {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock, memory?: import('./memory.js').MemoryService }} spec
   *   `memory` 只被 `settle`（结账归档作答）用；装配点（org.js）负责接上。
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
    this.memory = spec.memory ?? null;
  }

  /**
   * 建节点。判据是必填项，不是可选说明。
   *
   * 依赖校验（W3 批3·2026-10-09）在**锁内**做（见 `#assertDependencies`）：
   * 依赖指向空气会让派发永远等不到前置；依赖链成环会让「先做谁」这件事没有解。
   *
   * @param {{ subject: object, 描述: string, 负责人: string|string[], 判据: string|string[], 依赖?: string[], 项目: string, 模式?: string }} input
   * @returns {Promise<object>} 节点投影
   */
  async create(input) {
    if (!input.描述?.trim()) throw new InvalidBody('任务节点必须有描述。');
    const 判据 = normalizeList(input.判据);
    if (判据.length === 0) throw new InvalidBody('验收标准必填：没有判据的节点无法验收，也无法在派发后冻结。', { missing: ['判据'] });
    const 负责人 = normalizeList(input.负责人);
    if (负责人.length === 0) throw new InvalidBody('任务节点必须有负责人。', { missing: ['负责人'] });
    if (负责人.length > 1 && !MULTI_MODES.includes(input.模式)) {
      throw new InvalidBody(`一岗多人必须显式声明模式：${MULTI_MODES.join(' / ')}。`, { missing: ['模式'] });
    }
    const 依赖 = normalizeList(input.依赖);

    // 节点 id 要**短**到能在命令行里念出来（§14.4-1「稳定、短、kebab」）：
    // 描述里取 16 字做前缀便于认人，后缀取时间戳末 5 位 base36 保证同一毫秒内不撞。
    // 描述本身由面板整条显示，不需要挤在 id 里。
    const id = `task-${slugOf(input.描述, 'x')}-${this.clock.ms().toString(36).slice(-5)}`;
    await this.policy.check({
      subject: input.subject,
      action: 'create',
      target: { id, kind: '任务', authority: '自治', zone: '私有', domain: '集体', project: input.项目 },
      context: {},
    });
    const 事件 = {
      kind: 'created',
      id,
      描述: input.描述,
      负责人,
      判据,
      依赖,
      模式: input.模式 ?? (负责人.length > 1 ? null : '独立会审'),
      状态: '待派发',
    };
    // 校验挂在 eventBuilder 上，是为了**在锁内**跑（锁外预读会与并发 create 打架：
    // 刚建好的依赖读不到 ⇒ 误拒一个完全合法的节点）。builder 只校验、原样返回事件。
    await this.#append(input.项目, 事件, input.subject, '状态变更', (_node, rows) => {
      this.#assertDependencies(依赖, id, fold(rows));
      return 事件;
    });
    return this.get(id, { 项目: input.项目 });
  }

  /**
   * 派发。判据在此刻冻结——本方法之后没有任何接口能改它。
   * @param {string} id
   * @param {{ subject: object, 项目: string }} spec
   * @returns {Promise<object>}
   */
  async dispatch(id, spec) {
    const node = await this.#require(id, spec.项目);
    if (node.状态 !== '待派发') throw new Denied('任务图 · 状态机', `节点 ${id} 当前状态为 ${node.状态}，不能重复派发。`, { howToChange: '只对「待派发」的节点派发。' });
    await this.policy.check({
      subject: spec.subject,
      action: 'dispatch',
      target: { id, kind: '任务', authority: '自治', zone: '私有', project: spec.项目 },
      context: { task: node },
    });
    await this.#append(spec.项目, { kind: 'dispatched', id, 判据冻结: true }, spec.subject);
    return this.get(id, { 项目: spec.项目 });
  }

  /** @param {string} id @param {{ subject: object, 项目: string }} spec */
  async start(id, spec) {
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'start');
    await this.#checkWrite(id, node, spec);
    await this.#append(spec.项目, { kind: 'started', id, 状态: '执行中' }, spec.subject);
    return this.get(id, { 项目: spec.项目 });
  }

  /**
   * 交卷。产出物只存引用——正文属于对象存储，节点上只留 id。
   *
   * 结论**按人留**而不是只留最后一次：§10 要求独立会审产出「N 份独立答案 + 分歧清单」，
   * 覆盖式的单字段会让面板说不出「三份结论分别是什么」。
   *
   * @param {string} id
   * @param {{ subject: object, 项目: string, 产出物引用?: string[], 结论?: string }} spec
   */
  async submit(id, spec) {
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'submit');
    await this.#checkWrite(id, node, spec);
    await this.#append(spec.项目, {
      kind: 'submitted',
      id,
      状态: '已交卷',
      产出物引用: spec.产出物引用 ?? [],
      结论: spec.结论 ?? null,
      // 反例面由交卷人自己给：§10 的零分歧判据是「结论层一致**且无人给出反例面**」，
      // 而反例面必须来自各自的独立产出，不能事后由 Lead 补。
      反例面: spec.反例面 ?? [],
    }, spec.subject);
    return this.get(id, { 项目: spec.项目 });
  }

  /**
   * 记复核结论。结论**不经过 Lead 修改**：这里只有写入，没有改写。
   * 「未验」既不等于通过，也不计打回。
   *
   * @param {string} id
   * @param {{ subject: object, 项目: string, 三态: string, 分歧清单?: string[], 反例面?: string[], 复核者?: string }} spec
   */
  async review(id, spec) {
    if (!REVIEW_VERDICTS.includes(spec.三态)) {
      throw new InvalidBody(`复核结论只有三态：${REVIEW_VERDICTS.join(' / ')}。`, { missing: ['三态'] });
    }
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'review');
    await this.policy.check({
      subject: spec.subject,
      action: 'review',
      target: { id, kind: '任务', authority: '自治', zone: '私有', project: spec.项目 },
      context: {},
    });
    const 状态 = spec.三态 === '过' ? '已采纳' : spec.三态 === '不过' ? '已打回' : '未验';
    await this.#append(spec.项目, {
      kind: 'reviewed',
      id,
      三态: spec.三态,
      状态,
      分歧清单: spec.分歧清单 ?? [],
      反例面: spec.反例面 ?? [],
      复核者: spec.复核者 ?? spec.subject?.id,
      算通过: spec.三态 === '过',
      计打回: spec.三态 === '不过',
    }, spec.subject);
    if (spec.三态 === '不过') await this.reject(id, { subject: spec.subject, 项目: spec.项目, 理由: `复核不过：${(spec.分歧清单 ?? []).join('；') || '未给分歧清单'}` });
    return this.get(id, { 项目: spec.项目 });
  }

  /**
   * 打回：同一节点打回 ≥2 次 ⇒ 升级主权者。
   *
   * 不单独过策略引擎：唯一的调用方是 review()（复核「不过」），闸已经在那里过了；
   * 动作面也没有直达 reject 的入口。这里只守终态：已采纳/已结账的节点不许再打回。
   * @param {string} id
   * @param {{ subject: object, 项目: string, 理由: string }} spec
   */
  async reject(id, spec) {
    const node = await this.#require(id, spec.项目);
    if (TERMINAL.has(node.状态)) {
      throw new Denied('任务图 · 状态机', `节点 ${id} 已到终态 ${node.状态}，不能再打回。`, { howToChange: '终态节点只能追加更正，不能回到环路里。' });
    }
    // 打回次数以**锁内**折叠视图重算（W3 批1）：锁外预读的 node 在并发 reject 下
    // 会算出同一个次数，两个「第 2 次」落进链里——升级判定（≥2）就漂了。
    const rejected = await this.#append(spec.项目, { kind: 'rejected', id, 理由: spec.理由 }, spec.subject, '状态变更', (nodeInLock) => ({
      kind: 'rejected',
      id,
      打回次数: (nodeInLock?.打回次数 ?? 0) + 1,
      理由: spec.理由,
    }));
    if ((rejected.打回次数 ?? 0) >= 2) {
      await this.#append(spec.项目, { kind: 'escalated', id, 升级: { 原因: '打回≥2', 至: '主权者' } }, { id: 'system', kind: '系统' });
    }
    return this.get(id, { 项目: spec.项目 });
  }

  /**
   * 待决项 = 节点状态（§7）。
   * @param {string} id
   * @param {{ subject: object, 项目: string, 原因: string, 待决类型?: string }} spec
   */
  async markPending(id, spec) {
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'markPending');
    await this.#checkWrite(id, node, spec);
    await this.#append(spec.项目, { kind: 'pending', id, 状态: '待决', 待决原因: spec.原因, 待决类型: spec.待决类型 ?? '升级差异' }, spec.subject);
    return this.get(id, { 项目: spec.项目 });
  }

  /**
   * 裁决待决项。清空队列可以，但记录不消失——它变成节点上的历史。
   * @param {string} id
   * @param {{ subject: object, 项目: string, 决定: string }} spec
   */
  async resolvePending(id, spec) {
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'resolvePending');
    await this.#checkWrite(id, node, spec);
    await this.#append(spec.项目, { kind: 'resolved', id, 待决: false, 状态: node.待决前的状态 ?? node.状态, 决定: spec.决定, 已决于: this.clock.iso() }, spec.subject);
    return this.get(id, { 项目: spec.项目 });
  }

  /**
   * 挂产出物引用（只存引用，不存本体）。
   * @param {string} id
   * @param {{ subject: object, 项目: string, 产出物: string }} spec
   */
  async attach(id, spec) {
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'attach');
    await this.#checkWrite(id, node, spec);
    await this.#append(spec.项目, { kind: 'artifact', id, 产出物: spec.产出物 }, spec.subject);
    return this.get(id, { 项目: spec.项目 });
  }

  // ── W2 会审讨论段（2026-10-09）：事件流是状态权威，bus 只承载消息 ────────────
  // 三个方法只做「状态机判定 + 事件追加」；编排（揭名/预算/消息）在 src/debate.js。

  /**
   * 讨论开启事件。前置由 DebateService 编排层算好（齐卷判据与 bus_unlock 同款重算），
   * 这里守任务图自己的一面：节点存在、模式是独立会审、没开过讨论、参与者与预算快照入事件。
   * @param {string} id
   * @param {{ subject: object, 项目: string, 参与者: string[], 轮次上限: number, 预算快照: object }} spec
   */
  async debateOpened(id, spec) {
    const node = await this.#require(id, spec.项目);
    if (node.模式 !== '独立会审') {
      throw new Denied('会审讨论段 · 只属于独立会审（§10）', `节点 ${id} 的模式是「${node.模式 ?? '未声明'}」：并行分担没有盲评与讨论环节。`, {
        howToChange: '讨论段只对独立会审节点开放；并行分担节点直接交卷、复核。',
      });
    }
    if (node.讨论) {
      throw new Denied('会审讨论段 · 状态机', `节点 ${id} 的讨论已${node.讨论.状态 === '已收敛' ? '收敛' : '开启'}，不能重复开启。`, {
        howToChange: node.讨论.状态 === '已收敛' ? '讨论已收敛：走复核（review）。' : '讨论进行中：发言用 debate_say，换轮 debate_round，收敛 debate_converge。',
      });
    }
    await this.#checkWrite(id, node, spec);
    await this.#append(spec.项目, {
      kind: 'debate_opened',
      id,
      参与者: spec.参与者,
      轮次上限: spec.轮次上限,
      预算快照: spec.预算快照,
    }, spec.subject, '讨论开启');
    return this.get(id, { 项目: spec.项目 });
  }

  /**
   * 讨论换轮事件。轮次上限在此守（状态机面）：用尽即拒并提示收敛。
   * @param {string} id
   * @param {{ subject: object, 项目: string, 轮次: number }} spec
   */
  async debateRounded(id, spec) {
    const node = await this.#require(id, spec.项目);
    if (!node.讨论 || node.讨论.状态 !== '讨论中') {
      throw new Denied('会审讨论段 · 状态机', `节点 ${id} 没有「讨论中」的讨论段（未开启或已收敛）。`, {
        howToChange: '先 debate_open 开启讨论；已收敛的讨论不能再换轮。',
      });
    }
    if (node.讨论.轮次 >= node.讨论.轮次上限) {
      throw new Denied(
        '会审讨论段 · 轮次用尽，须收敛',
        `节点 ${id} 的讨论轮次 ${node.讨论.轮次}/${node.讨论.轮次上限} 已到上限，不能再换轮。`,
        {
          requireAuthority: 'Lead',
          howToChange: '由 Lead 执行 debate_converge 收敛讨论（末位表态会落消息并记进事件）；轮次上限可在私有 部署.json 的 会审讨论 键调整（只影响之后开启的讨论——预算快照在开启时冻结）。',
          detail: { 轮次: node.讨论.轮次, 轮次上限: node.讨论.轮次上限 },
        },
      );
    }
    await this.#checkWrite(id, node, spec);
    await this.#append(spec.项目, { kind: 'debate_round', id, 轮次: spec.轮次 }, spec.subject, '讨论换轮');
    return this.get(id, { 项目: spec.项目 });
  }

  /**
   * 讨论收敛事件。Lead 的末位表态消息 id 记进事件（收敛时刻可回溯）。
   * @param {string} id
   * @param {{ subject: object, 项目: string, 表态消息id: string }} spec
   */
  async debateConverged(id, spec) {
    const node = await this.#require(id, spec.项目);
    if (!node.讨论 || node.讨论.状态 !== '讨论中') {
      throw new Denied('会审讨论段 · 状态机', `节点 ${id} 没有「讨论中」的讨论段（未开启或已收敛）。`, {
        howToChange: '先 debate_open 开启讨论。',
      });
    }
    await this.#checkWrite(id, node, spec);
    await this.#append(spec.项目, { kind: 'debate_converged', id, 表态消息id: spec.表态消息id }, spec.subject, '讨论收敛');
    return this.get(id, { 项目: spec.项目 });
  }

  /**
   * @param {string} id
   * @param {{ 项目: string }} spec
   * @returns {Promise<object|null>}
   */
  async get(id, spec) {
    const nodes = fold(await this.events({ 项目: spec.项目 }));
    return nodes.get(id) ?? null;
  }

  /**
   * @param {{ 项目: string, 状态?: string }} spec
   * @returns {Promise<object[]>}
   */
  async list(spec) {
    const nodes = [...fold(await this.events({ 项目: spec.项目 })).values()];
    return (spec.状态 ? nodes.filter((n) => n.状态 === spec.状态) : nodes).sort((a, b) => String(a.创建于).localeCompare(String(b.创建于)));
  }

  /**
   * 工作台投影的输入。
   * @param {{ 项目: string }} spec
   * @returns {Promise<{ 节点: object[], 待决: object[], 升级: object[], 终端: object[] }>}
   */
  async snapshot(spec) {
    const 节点 = await this.list({ 项目: spec.项目 });
    return {
      节点,
      待决: 节点.filter((n) => n.状态 === '待决'),
      升级: 节点.filter((n) => n.升级),
      终端: 节点.filter((n) => TERMINAL.has(n.状态)),
    };
  }

  /**
   * 原始事件流：审计与重建都读它。
   * @param {{ 项目: string }} spec
   * @returns {Promise<object[]>}
   */
  async events(spec) {
    return readJsonl(this.layout.taskLog(spec.项目));
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /**
   * @param {string} 项目 @param {object} event @param {object} subject @param {string} [审计动作] 覆盖默认的「状态变更」（讨论段三事件按 W2 规格记各自动作名，档位由 ACTION_GRADE 定）
   * @param {(nodeInLock: object|null, rows: object[]) => object} [eventBuilder] 用**锁内**折叠视图重算事件字段——
   *   打回次数这类「从当前状态推导」的值必须以锁内读到的为准（W3 批1·2026-10-09）：
   *   锁外算好再进锁，两个并发 reject 会算出同一个次数，链上少一次打回。
   *   第二个参数是**锁内的原始事件行**：跨节点判定（依赖图这类）也必须在锁内做，
   *   锁外预读会与并发 create 打架（W3 批3·2026-10-09）。builder 抛错即拒写。
   * @returns {Promise<object>} 实际落线的事件（调用方接着用同一份，不许两处各算各的）
   */
  async #append(项目, event, subject, 审计动作 = '状态变更', eventBuilder = null) {
    const file = this.layout.taskLog(项目);
    let finalEvent = event;
    await withLock(this.layout.taskLock(项目), async () => {
      const rows = await readJsonl(file);
      const node = fold(rows).get(event.id);
      // 判据冻结：派发之后任何想动判据的事件都被拒绝。这是 §7 那一条的可执行形态。
      if (node?.判据冻结 && Object.hasOwn(event, '判据')) {
        throw new Denied('任务图 · 派发后判据冻结', `节点 ${event.id} 已派发，判据不能在事后改动。`, {
          requireAuthority: '主权者',
          howToChange: '判据要变就新开一个节点；改判据等于让验收标准追着结果跑。',
        });
      }
      if (eventBuilder) finalEvent = eventBuilder(node, rows);
      const at = this.clock.iso();
      const by = subject && typeof subject === 'object' ? { id: String(subject.id), kind: String(subject.kind ?? '未知') } : { id: String(subject), kind: '未知' };
      await appendLines(file, [{ seq: rows.length + 1, at, by, ...finalEvent }]);
    });
    await this.audit.append({
      动作: 审计动作,
      主体: subject,
      对象: { id: finalEvent.id, kind: '任务' },
      依据: '任务图事件流',
      结果: finalEvent.kind,
      项目,
      详情: { 事件: finalEvent.kind, 状态: finalEvent.状态 ?? null },
    });
    return finalEvent;
  }

  /** @param {string} id @param {string} 项目 */
  async #require(id, 项目) {
    const node = await this.get(id, { 项目 });
    if (!node) throw new InvalidBody(`没有这个任务节点：${id}（项目 ${项目}）`);
    return node;
  }

  /**
   * 依赖校验（W3 批3·2026-10-09）：①依赖必须指向本项目里**真实存在**的节点；
   * ②依赖链不许成环（DFS，三色标记）。
   *
   * 范围说清（别把它当成比实际更强的保证）：新节点的 id 是刚生成的，调用方不可能
   * 提前拿它当依赖 ⇒ 这一关**实际拦的是**「依赖指向空气」与「依赖链上游已经成环」
   * （手写事件流 / 旧数据 / 将来某处漏判留下的环）——两者都会让「先做谁」没有解。
   *
   * @param {string[]} 依赖
   * @param {string} 新节点id
   * @param {Map<string, object>} 节点 锁内 fold 出来的节点表
   */
  #assertDependencies(依赖, 新节点id, 节点) {
    if (依赖.length === 0) return;
    const 缺 = 依赖.filter((d) => !节点.has(d));
    if (缺.length > 0) {
      throw new InvalidBody(`依赖的节点不存在：${缺.join('、')}。依赖是「先做谁」的事实，指向空气的依赖会让这个节点永远等不到前置。`, {
        missing: 缺,
        detail: { 项目节点数: 节点.size, 已知节点: [...节点.keys()].slice(0, 20) },
      });
    }
    /** 边：新节点 → 它的依赖；既有节点 → 它自己的依赖。 */
    const 出边 = (id) => (id === 新节点id ? 依赖 : 节点.get(id)?.依赖 ?? []);
    /** 0 未访问 / 1 在当前递归栈上 / 2 已查完（无环）。 */
    const 色 = new Map();
    const 栈 = [];
    const 找环 = (id) => {
      if (色.get(id) === 1) return [...栈.slice(栈.indexOf(id)), id];
      if (色.get(id) === 2) return null;
      色.set(id, 1);
      栈.push(id);
      for (const 下 of 出边(id)) {
        const 环 = 找环(下);
        if (环) return 环;
      }
      栈.pop();
      色.set(id, 2);
      return null;
    };
    const 环 = 找环(新节点id);
    if (环) {
      throw new Denied('任务图 · 依赖不许成环（§7 任务依赖）', `依赖链成环：${环.join(' → ')}。「先做谁」在环里没有解，派发与验收都会永远悬着。`, {
        howToChange: '把环里某一条依赖去掉，或新开一个节点承担被环占住的那一步。',
        detail: { 环 },
      });
    }
  }

  /**
   * 结账：环路的最后一步（W3 批3·2026-10-09）。
   *
   * 前置 = **已采纳**（复核判「过」之后的终态）；动作面是 `task_settle`，权限仅 Lead
   * （policy 的 `settle` 动作）。做两件事，顺序有意：
   *  ① 归档该项目的作答（§7：作答在任务结束时归档，归档后成员不可读、默认检索面不再返回）；
   *  ② 落终态「已结账」——「这件事收尾了」是 Lead 的显式拍板，不是自动推进。
   * 归档先于落终态：若归档被拒（策略/权限），节点**不许**显示成已结账（否则账上写着结账、
   * 作答却还敞着）。
   *
   * @param {string} id
   * @param {{ subject: object, 项目: string }} spec
   * @returns {Promise<object>}
   */
  async settle(id, spec) {
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'settle');
    await this.policy.check({
      subject: spec.subject,
      action: 'settle',
      target: { id, kind: '任务', authority: '自治', zone: '私有', project: spec.项目 },
      context: { task: node },
    });
    if (!this.memory) {
      throw new Fault('SETTLE_NO_MEMORY', '结账要归档作答，但装配时没把记忆服务接进任务图（org.js 的接线问题，不是调用问题）。');
    }
    const 归档 = await this.memory.archiveAnswers({ 项目: spec.项目, 任务: id, subject: spec.subject });
    await this.#append(spec.项目, { kind: 'settled', id, 状态: '已结账', 归档条数: 归档.归档条数 }, spec.subject, '结账');
    return this.get(id, { 项目: spec.项目 });
  }

  /** @param {object} node @param {keyof TRANSITIONS} op */
  #requireTransition(node, op) {
    const allowed = TRANSITIONS[op];
    if (!allowed.includes(node.状态)) {
      throw new Denied('任务图 · 状态机', `节点 ${node.id} 当前状态为 ${node.状态}，不能执行 ${op}（允许的状态：${allowed.join(' / ')}）。`, {
        howToChange: '主干环路的次序是 受理→定判据→派发→执行→交卷→复核→采纳/打回；按当前状态选下一步动作。',
      });
    }
  }

  /**
   * 写动作的闸（§9：写操作先过策略引擎，无旁路）。
   * context 带上节点本体：成员的「任务内全权，任务外无」靠 scopeOf 读它判定。
   * @param {string} id @param {object} node @param {{ subject: object, 项目: string }} spec
   */
  async #checkWrite(id, node, spec) {
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id, kind: '任务', authority: '自治', zone: '私有', project: spec.项目 },
      context: { task: node },
    });
  }
}

/**
 * 事件流折叠成节点投影。
 *
 * 投影是纯函数：同一份日志永远给出同一个状态，于是「状态权威」与「重启可重建」是同一件事。
 * @param {object[]} rows
 * @returns {Map<string, object>}
 */
export function fold(rows) {
  /** @type {Map<string, object>} */
  const nodes = new Map();
  for (const row of rows) {
    if (!row?.id || !row?.kind) continue;
    let node = nodes.get(row.id);
    if (!node) {
      node = { id: row.id, 状态: '待派发', 打回次数: 0, 产出物引用: [], 复核经过: [] };
      nodes.set(row.id, node);
    }
    switch (row.kind) {
      case 'created':
        Object.assign(node, {
          描述: row.描述,
          负责人: row.负责人,
          判据: row.判据,
          依赖: row.依赖 ?? [],
          模式: row.模式 ?? null,
          状态: '待派发',
          创建于: row.at,
          创建者: row.by?.id ?? null,
        });
        break;
      case 'dispatched':
        node.状态 = '已派发';
        node.判据冻结 = true;
        node.派发于 = row.at;
        break;
      case 'started':
        node.状态 = row.状态 ?? '执行中';
        break;
      case 'submitted': {
        node.状态 = row.状态 ?? '已交卷';
        node.产出物引用 = [...new Set([...(node.产出物引用 ?? []), ...(row.产出物引用 ?? [])])];
        node.交卷于 = row.at;
        // 按人留答案（同一个人再交一次就替换他自己那条，别人不受影响）。
        const 交卷人 = row.by?.id ?? null;
        const 他人 = (node.独立答案 ?? []).filter((a) => a.成员 !== 交卷人);
        node.独立答案 = [...他人, {
          成员: 交卷人,
          结论: row.结论 ?? null,
          反例面: row.反例面 ?? [],
          产出物引用: row.产出物引用 ?? [],
          于: row.at,
        }];
        break;
      }
      case 'reviewed':
        node.状态 = row.状态;
        node.最近三态 = row.三态;
        node.复核经过 = [...(node.复核经过 ?? []), { 三态: row.三态, 分歧清单: row.分歧清单, 反例面: row.反例面, 复核者: row.复核者, 于: row.at }];
        break;
      case 'rejected':
        node.打回次数 = row.打回次数 ?? (node.打回次数 ?? 0) + 1;
        node.最近打回理由 = row.理由;
        if (node.状态 !== '未验') node.状态 = '已打回';
        break;
      case 'pending':
        node.待决前的状态 = node.状态;
        node.状态 = '待决';
        node.待决原因 = row.待决原因;
        node.待决类型 = row.待决类型;
        break;
      case 'resolved':
        node.状态 = row.状态 ?? '已交卷';
        node.待决 = false;
        node.已决 = { 决定: row.决定, 于: row.已决于 };
        node.待决记录 = [...(node.待决记录 ?? []), { 原因: node.待决原因, 决定: row.决定, 于: row.已决于 }];
        break;
      case 'artifact':
        node.产出物引用 = [...new Set([...(node.产出物引用 ?? []), row.产出物])];
        break;
      case 'escalated':
        node.升级 = row.升级;
        break;
      // 结账（W3 批3）：环路的终态。归档条数一起折进节点——「结账时归档了几条作答」
      // 是这条终态的读数，读面板的人不用再去翻记忆账本。
      case 'settled':
        node.状态 = row.状态 ?? '已结账';
        node.结账于 = row.at;
        node.归档条数 = row.归档条数 ?? 0;
        break;
      // ── W2 会审讨论段（2026-10-09）：讨论是节点的**子状态**，不动节点主状态
      //    （已交卷保持——讨论中仍可 review，软约束不许变成死锁）。
      case 'debate_opened':
        node.讨论 = {
          状态: '讨论中',
          轮次: 1,
          轮次上限: row.轮次上限,
          参与者: row.参与者 ?? [],
          // 预算快照在开启时冻结（判据冻结同哲学）：之后改部署.json 不影响进行中的讨论。
          预算快照: row.预算快照 ?? {},
          开于: row.at,
        };
        break;
      case 'debate_round':
        if (node.讨论) node.讨论 = { ...node.讨论, 轮次: row.轮次 };
        break;
      case 'debate_converged':
        if (node.讨论) node.讨论 = { ...node.讨论, 状态: '已收敛', 表态消息id: row.表态消息id ?? null, 收敛于: row.at };
        break;
      default:
        break;
    }
    node.最近事件于 = row.at;
  }
  return nodes;
}

/** @param {string|string[]|undefined} value */
function normalizeList(value) {
  if (value === undefined || value === null) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean);
}

/** @param {string} text @param {string} fallback */
function slugOf(text, fallback) {
  // 16 字：够认出是哪个节点，又不至于让 id 变成一整句话。
  const folded = String(text).normalize('NFKC').replace(/[^\p{Letter}\p{Number}]+/gu, '-').replace(/^-|-$/g, '').slice(0, 16);
  return folded || fallback;
}
