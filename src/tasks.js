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
import { Denied, InvalidBody } from './kernel/errors.js';

/** 一岗多人的两种模式（§10）。 */
export const MULTI_MODES = ['并行分担', '独立会审'];

/** 复核三态（§8）。「未验 ≠ 通过」，且不计打回。 */
export const REVIEW_VERDICTS = ['过', '不过', '未验'];

const TERMINAL = new Set(['已采纳', '已结账']);

export class TaskGraph {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock }} spec
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
  }

  /**
   * 建节点。判据是必填项，不是可选说明。
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
    await this.#append(input.项目, {
      kind: 'created',
      id,
      描述: input.描述,
      负责人,
      判据,
      依赖: input.依赖 ?? [],
      模式: input.模式 ?? (负责人.length > 1 ? null : '独立会审'),
      状态: '待派发',
    }, input.subject);
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
    await this.#require(id, spec.项目);
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
    await this.#require(id, spec.项目);
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
    await this.#require(id, spec.项目);
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
   * @param {string} id
   * @param {{ subject: object, 项目: string, 理由: string }} spec
   */
  async reject(id, spec) {
    const node = await this.#require(id, spec.项目);
    const 次数 = (node.打回次数 ?? 0) + 1;
    await this.#append(spec.项目, { kind: 'rejected', id, 打回次数: 次数, 理由: spec.理由 }, spec.subject);
    if (次数 >= 2) {
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
    await this.#require(id, spec.项目);
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
    await this.#append(spec.项目, { kind: 'resolved', id, 待决: false, 状态: node.待决前的状态 ?? node.状态, 决定: spec.决定, 已决于: this.clock.iso() }, spec.subject);
    return this.get(id, { 项目: spec.项目 });
  }

  /**
   * 挂产出物引用（只存引用，不存本体）。
   * @param {string} id
   * @param {{ subject: object, 项目: string, 产出物: string }} spec
   */
  async attach(id, spec) {
    await this.#require(id, spec.项目);
    await this.#append(spec.项目, { kind: 'artifact', id, 产出物: spec.产出物 }, spec.subject);
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

  /** @param {string} 项目 @param {object} event @param {object} subject */
  async #append(项目, event, subject) {
    const file = this.layout.taskLog(项目);
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
      const at = this.clock.iso();
      const by = subject && typeof subject === 'object' ? { id: String(subject.id), kind: String(subject.kind ?? '未知') } : { id: String(subject), kind: '未知' };
      await appendLines(file, [{ seq: rows.length + 1, at, by, ...event }]);
    });
    await this.audit.append({
      动作: '状态变更',
      主体: subject,
      对象: { id: event.id, kind: '任务' },
      依据: '任务图事件流',
      结果: event.kind,
      项目,
      详情: { 事件: event.kind, 状态: event.状态 ?? null },
    });
  }

  /** @param {string} id @param {string} 项目 */
  async #require(id, 项目) {
    const node = await this.get(id, { 项目 });
    if (!node) throw new InvalidBody(`没有这个任务节点：${id}（项目 ${项目}）`);
    return node;
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
