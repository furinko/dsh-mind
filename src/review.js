/**
 * 复核流程与反趋同（§8 复核流程 + §10 反趋同）。
 *
 * 两件事放一起，是因为它们回答的是同一个问题的两面：
 * 「结论可信吗」——复核给结论，反趋同给结论一个不被讨好效应污染的产生方式。
 *
 * 本文件没有「改结论」的接口。§8 写明「结论不经过 Lead 修改；Lead 可记录不同意，
 * 不能改结论」，所以 `recordDisagreement()` 只会追加一条 Lead 的意见，
 * 而复核结论本身是只增的。
 */
import { Denied, InvalidBody } from './kernel/errors.js';

/** 复核三态（§8）。 */
export const VERDICTS = ['过', '不过', '未验'];

/** 一岗多人的两种模式（§10 表）。 */
export const MULTI_MODES = ['并行分担', '独立会审'];

export class ReviewProtocol {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock, tasks?: object, bus?: object, random?: () => number }} spec
   *   tasks / bus 由依赖注入：本协议只编排，不自己实现任务图与总线。
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
    this.tasks = spec.tasks;
    this.bus = spec.bus;
    this.random = spec.random ?? Math.random;
  }

  /**
   * 提名复核者（Lead 可提名，任命权在主权者）。
   * @param {{ subject: object, 实例: string, 项目?: string }} spec
   */
  async nominate(spec) {
    await this.policy.check({
      subject: spec.subject,
      action: 'propose',
      target: { id: spec.实例, kind: '身份', authority: '法律', zone: '私有', domain: '个体', project: spec.项目 ?? null },
      context: {},
    });
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.实例, kind: '复核者' },
      依据: '§2 复核者任命：Lead 可提名',
      结果: '已提名，待主权者确认',
      项目: spec.项目 ?? null,
    });
    return { 实例: spec.实例, 状态: '已提名', 下一步: '需主权者确认' };
  }

  /**
   * 任命复核者。只有主权者能任命——**被制衡者不得单独任命制衡者**（§2）。
   *
   * 任命的持久化属于角色注册表（身份档案），本协议只负责判定与留痕；
   * 这样「谁能改复核者卡」与「谁在岗」不会出现两个事实源。
   *
   * @param {{ subject: object, 实例: string, 项目?: string }} spec
   */
  async appoint(spec) {
    await this.policy.check({
      subject: spec.subject,
      action: 'approve',
      target: { id: spec.实例, kind: '身份', authority: '法律', zone: '私有', domain: '个体', project: spec.项目 ?? null },
      context: { 任命复核者: true },
    });
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.实例, kind: '复核者' },
      依据: '§2 复核者卡的 身份+权限+判据 段属法律，由主权者改',
      结果: '已任命',
      项目: spec.项目 ?? null,
    });
    return { 实例: spec.实例, 状态: '已任命', 依据: '主权者确认' };
  }

  /**
   * 记复核结论（三态 + 分歧清单 + 反例面）。
   *
   * 「未验」的定义（§8）：复核者在权限内无法完成验证。它 **不算通过**，也 **不计打回**。
   *
   * @param {{ subject: object, 项目: string, 节点: string, 三态: string, 分歧清单?: string[], 反例面?: string[], 复核者?: string }} spec
   * @returns {Promise<object>}
   */
  async record(spec) {
    if (!VERDICTS.includes(spec.三态)) {
      throw new InvalidBody(`复核结论只有三态：${VERDICTS.join(' / ')}。`, { missing: ['三态'] });
    }
    const 未验 = spec.三态 === '未验';
    if (this.tasks) {
      await this.tasks.review(spec.节点, {
        subject: spec.subject,
        项目: spec.项目,
        三态: spec.三态,
        分歧清单: spec.分歧清单 ?? [],
        反例面: spec.反例面 ?? [],
        复核者: spec.复核者 ?? spec.subject?.id,
      });
    } else {
      await this.policy.check({
        subject: spec.subject,
        action: 'review',
        target: { id: spec.节点, kind: '任务', authority: '自治', zone: '私有', project: spec.项目 },
        context: {},
      });
      await this.audit.append({
        动作: '状态变更',
        主体: spec.subject,
        对象: { id: spec.节点, kind: '任务' },
        依据: '§8 复核三态',
        结果: spec.三态,
        项目: spec.项目,
        详情: { 分歧清单: spec.分歧清单 ?? [], 反例面: spec.反例面 ?? [] },
      });
    }
    return {
      节点: spec.节点,
      三态: spec.三态,
      算通过: spec.三态 === '过',
      计打回: spec.三态 === '不过',
      分歧清单: spec.分歧清单 ?? [],
      反例面: spec.反例面 ?? [],
      ...(未验 ? { 谁接手: '升级 Lead 补材料；补不了 ⇒ 升级主权者', 说明: '未验 ≠ 通过；未验不计打回。' } : {}),
    };
  }

  /**
   * Lead 记录不同意。**只追加意见，不触碰结论**。
   * @param {{ subject: object, 项目: string, 节点: string, 理由: string }} spec
   */
  async recordDisagreement(spec) {
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.节点, kind: '任务' },
      依据: '§8 Lead 可记录不同意，不能改结论',
      结果: 'Lead 记录不同意',
      项目: spec.项目,
      详情: { 理由: spec.理由 },
    });
    return { 节点: spec.节点, 已记录: true, 结论未改动: true, 理由: spec.理由 };
  }

  /**
   * 强制反对者：系统随机指定一名**未参与**成员，且**不重复**（§10）。
   *
   * 「不重复」的依据是审计日志里过去指定的记录——不引入第二个存储。
   *
   * @param {{ 项目: string, 节点?: string, 参与者: string[], 候选: string[] }} spec
   * @returns {Promise<{ 反对者: string, 依据: string, 已用过: string[] }>}
   */
  /**
   * @param {{ 项目: string, 节点?: string, 参与者: string[], 候选: string[], 只选不记?: boolean }} spec
   *   `只选不记`（2026-10-13 审查 P1-12）：编排层（debate.open）先把「选谁」拿到手，
   *   等任务图事件 debate_opened 成功落线后再补记审计——修前先记后开，开启失败会把
   *   该候选永久烧掉（#usedDissenters 读的是审计，事件没落、名字先耗）。
   * @returns {Promise<{ 反对者: string, 依据: string, 已用过: string[] }>}
   */
  async pickDissenter(spec) {
    const 参与者 = new Set(spec.参与者 ?? []);
    const 已用过 = await this.#usedDissenters(spec.节点 ?? null);
    const pool = (spec.候选 ?? []).filter((id) => !参与者.has(id) && !已用过.includes(id));
    if (pool.length === 0) {
      return { 反对者: '', 依据: '没有可用的未参与成员：强制反对者不可重复，宁缺毋滥。', 已用过 };
    }
    const 反对者 = pool[Math.floor(this.random() * pool.length) % pool.length];
    if (spec.只选不记 === true) {
      // 依据文案与默认路径逐字相同（外部契约不变）：只是审计行由编排层在开启成功后补记。
      return { 反对者, 依据: '系统随机指定一名未参与成员，且不重复', 已用过: [...已用过, 反对者] };
    }
    await this.audit.append({
      动作: '状态变更',
      主体: { id: 'system', kind: '系统' },
      对象: { id: spec.节点 ?? spec.项目, kind: '会审' },
      依据: '§10 反趋同 · 强制反对者',
      结果: `指定 ${反对者}`,
      项目: spec.项目,
      详情: { 强制反对者: 反对者, 节点: spec.节点 ?? null, 不用过: 已用过 },
    });
    return { 反对者, 依据: '系统随机指定一名未参与成员，且不重复', 已用过: [...已用过, 反对者] };
  }

  /**
   * 一岗多人必须显式声明模式（§10）。声明之后共享面与产出面都被写死在返回值里，
   * 因为这两列才是「独立会审」与「并行分担」的真正区别。
   *
   * @param {{ subject: object, 节点: string, 项目: string, 模式: string, 成员?: string[] }} spec
   */
  async declareMode(spec) {
    if (!MULTI_MODES.includes(spec.模式)) {
      throw new InvalidBody(`一岗多人必须显式声明模式：${MULTI_MODES.join(' / ')}。`, { missing: ['模式'] });
    }
    const 独立 = spec.模式 === '独立会审';
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.节点, kind: '任务' },
      依据: '§10 一岗多人必须显式声明模式',
      结果: spec.模式,
      项目: spec.项目,
      详情: { 成员: spec.成员 ?? [] },
    });
    return {
      节点: spec.节点,
      模式: spec.模式,
      互相可见: 独立 ? '交卷前不能' : '能',
      共享: 独立 ? '只共享岗位知识与能力' : '中间结果',
      产出: 独立 ? 'N 份独立答案 + 分歧清单' : '合起来的成果',
    };
  }

  /**
   * 提交后解锁（§10）：全员交卷后才亮出彼此答案。
   * @param {{ subject: object, 项目: string, 线程: string, 参与者: string[], 已交: string[] }} spec
   */
  async openBlind(spec) {
    const 已交 = new Set(spec.已交 ?? []);
    const 未交 = (spec.参与者 ?? []).filter((p) => !已交.has(p));
    if (未交.length > 0) {
      throw new Denied('§10 提交后解锁', `还有 ${未交.length} 人未交卷，第一轮保持盲评：${未交.join('、')}`, {
        requireAuthority: 'Lead',
        howToChange: '等全员交卷；本协议不提供「先看一眼」的口子，否则反趋同失效。',
      });
    }
    // 盲评：第一轮只显示「成员 A / B / C」，揭名在讨论阶段。
    // 盲标映射去顺序化（2026-10-13 裁决第二批 P2-13）：修前按参与者数组顺序分配——
    // 「成员 A 是谁」可由名单元顺序推断（去匿名面）。映射改为从「线程 + 排序名册」的
    // 确定性种子洗牌：顺序不再跟随数组，而 openBlind / reveal 各自独立计算仍得同一映射。
    const 盲标 = 盲标分配(spec.线程 ?? '', spec.参与者 ?? []);
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.线程, kind: '线程' },
      依据: '§10 提交后解锁 · 盲评',
      结果: '已解锁（盲标阶段）',
      项目: spec.项目,
    });
    return { 解锁: true, 盲标, 说明: '第一轮只显示成员 A/B/C；揭名在讨论阶段。' };
  }

  /**
   * 揭名：进入讨论阶段。
   * @param {{ subject: object, 项目: string, 线程: string, 参与者: string[] }} spec
   */
  async reveal(spec) {
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.线程, kind: '线程' },
      依据: '§10 盲评：揭名在讨论阶段',
      结果: '已揭名',
      项目: spec.项目,
    });
    // 揭名与 openBlind 用同一确定性映射（线程+名册种子）：两边独立算、同一个结果。
    return { 揭名: 盲标分配(spec.线程 ?? '', spec.参与者 ?? []) };
  }

  /**
   * 零分歧报警（§10）。
   *
   * 判据是 **结论层一致且无人给出反例面**，不是文本一致——
   * 三份答案措辞不同但结论相同、且没人提出反例，那才是「全票一致 = 异常信号」。
   *
   * @param {{ subject: object, 项目: string, 节点: string, 结论集: Array<{成员: string, 结论: string, 反例面?: string[], 结论层?: string}> }} spec
   * @returns {Promise<{零分歧: boolean, 触发人工抽检: boolean, 依据: string, 参与人数: number}>}
   */
  async checkZeroDivergence(spec) {
    // 结论集的权威源 = 任务图独立答案（2026-10-13 审查 P1-8）：修前完全信 `spec.结论集` 自报，
    // Lead 递一份假「反例面」就能压掉零分歧报警。接入任务图时一律现算；只有未注入 tasks
    // 的独立用法（纯函数式夹具）才接受调用方给的结论集。
    let 结论集 = spec.结论集 ?? [];
    let 结论集来源 = '调用方自报（未注入任务图，无法重算）';
    if (this.tasks && spec.节点) {
      const node = await this.tasks.get(spec.节点, { 项目: spec.项目 });
      if (!node) throw new InvalidBody(`没有这个任务节点：${spec.节点}（项目 ${spec.项目}）——零分歧检查要从任务图独立答案重算，节点不存在就没有权威源。`);
      结论集 = (node.独立答案 ?? []).map((a) => ({ 成员: a.成员, 结论: a.结论, 反例面: a.反例面 ?? [], 结论层: a.结论层 }));
      结论集来源 = `任务图独立答案重算（${结论集.length} 份）`;
    }
    const 判定 = judgeZeroDivergence(结论集);
    if (判定.零分歧) {
      await this.audit.append({
        动作: '零分歧异常',
        主体: spec.subject,
        对象: { id: spec.节点, kind: '任务' },
        依据: '§10 零分歧报警：结论层一致且无人给出反例面',
        结果: '会审零分歧异常',
        项目: spec.项目,
        告警: true,
        详情: { 参与人数: 判定.参与人数, 结论层: 判定.结论层, 触发人工抽检: true, 结论集来源 },
      });
    }
    return {
      零分歧: 判定.零分歧,
      触发人工抽检: 判定.零分歧,
      依据: 判定.依据,
      参与人数: 判定.参与人数,
      结论集来源,
    };
  }

  /**
   * 复核者的只读命令白名单（§2）。有副作用的命令默认拒绝。
   *
   * `node --test` **从白名单里去掉**（W3 批3·2026-10-09）：跑测试不是只读动作——
   * 它会落盘（临时文件、探针快照、账本行都是副作用），而且「跑哪个测试文件」由调用方自选
   * ⇒ 等于给复核者一条**不经判定**的写副作用通道，与「只读数，不改」的契约冲突。
   * 需要落盘的实验走沙箱区（`sandboxExperiment`）：单独授权、任务结束即清、全程入账。
   *
   * @param {string} command
   * @returns {{ 允许: boolean, 依据: string, howToChange?: string }}
   */
  static readonlyCommand(command) {
    const allowed = ['read', 'list', 'stat', 'search', 'grep', 'find', 'glob', 'cat', 'head', 'tail', 'wc', 'git status', 'git log', 'git diff'];
    const head = String(command).trim();
    const 允许 = allowed.some((a) => head === a || head.startsWith(`${a} `));
    return {
      允许,
      依据: 允许 ? '命中只读命令白名单' : '有副作用的命令默认拒绝（跑测试、写文件都算副作用，哪怕它们"看起来只是看一眼"）',
      ...(允许 ? {} : { howToChange: '需要落盘的实验走沙箱区（§2 单独授权）：任务结束即清、全程入账，不进持久状态。' }),
    };
  }

  /**
   * 沙箱区：复核者需要落盘的实验在这里跑，任务结束即清、全程入账（§2）。
   * @param {{ subject: object, 项目: string, 实验: string }} spec
   */
  async sandboxExperiment(spec) {
    await this.policy.check({
      subject: spec.subject,
      action: 'experiment',
      target: { id: `沙箱/${spec.项目}`, kind: '账目', authority: '自治', zone: '私有', project: spec.项目, sandbox: true },
      context: {},
    });
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: `沙箱/${spec.项目}`, kind: '沙箱区' },
      依据: '§2 复核者的落盘实验走沙箱区：单独授权 · 不进持久状态 · 任务结束即清 · 全程入账',
      结果: spec.实验,
      项目: spec.项目,
    });
    return { 授权: true, 落点: `沙箱/${spec.项目}`, 实验: spec.实验, 清理: '任务结束即清' };
  }

  /** @param {string|null} 节点 */
  async #usedDissenters(节点) {
    const rows = await this.audit.read({});
    return rows
      .filter((row) => row.动作 === '状态变更' && row.详情?.强制反对者)
      .filter((row) => (节点 ? row.详情?.节点 === 节点 : true))
      .map((row) => row.详情.强制反对者);
  }
}

/**
 * 盲标分配（§10 · 2026-10-13 裁决第二批 P2-13）：从「线程 + 排序名册」派生确定性置换，
 * 参与者数组顺序不再决定谁拿「成员 A」。同一线程/名册在 openBlind 与 reveal 各自调用
 * 都得到同一映射（无共享状态）。种子只依赖线程与名册**集合**（排序后），与会话无关。
 * @param {string} 线程
 * @param {string[]} 参与者
 * @returns {Array<{盲标: string, id: string}>}
 */
export function 盲标分配(线程, 参与者) {
  // 种子与**标位**都基于排序名册：同一集合无论传入顺序如何，id→盲标 映射恒同
  // （集合语义）；「成员 A 是谁」既不跟随数组顺序，也不可由名单元直接读出。
  const 排序 = [...参与者].sort();
  const seed = `${线程}|${排序.join(',')}`;
  let h = 2166136261;
  for (const ch of seed) {
    h ^= ch.codePointAt(0);
    h = Math.imul(h, 16777619) >>> 0;
  }
  const n = 排序.length;
  const 置换 = Array.from({ length: n }, (_, i) => i);
  for (let i = n - 1; i > 0; i--) {
    h = (Math.imul(h ^ (h >>> 15), 2246822519) + 0x9e3779b9) >>> 0;
    const j = h % (i + 1);
    [置换[i], 置换[j]] = [置换[j], 置换[i]];
  }
  const 标 = new Map(排序.map((id, i) => [id, `成员 ${String.fromCharCode(65 + 置换[i])}`]));
  return 参与者.map((id) => ({ 盲标: 标.get(id), id }));
}

/**
 * 零分歧的**唯一判据**（§10）：结论层一致，且无人给出反例面。
 *
 * 抽成纯函数是因为它有两个调用方——复核时（判定 + 入账）与工作台投影（只读重算）。
 * 两处各写一遍迟早会漂，而这条规则一旦漂了，「全票一致 = 异常信号」这个机制就废了。
 *
 * @param {Array<{成员?: string, 结论?: string, 结论层?: string, 反例面?: string[]}>} 结论集
 * @returns {{零分歧: boolean, 依据: string, 参与人数: number, 结论层: string[]}}
 */
export function judgeZeroDivergence(结论集) {
  const 集 = 结论集 ?? [];
  if (集.length < 2) {
    return { 零分歧: false, 依据: '少于两份结论，不构成会审。', 参与人数: 集.length, 结论层: [] };
  }
  const 结论层 = [...new Set(集.map((c) => String(c.结论层 ?? c.结论 ?? '').trim()))];
  const 有反例 = 集.some((c) => (c.反例面 ?? []).length > 0);
  const 零分歧 = 结论层.length === 1 && !有反例;
  return {
    零分歧,
    依据: 零分歧
      ? '结论层一致且无人给出反例面：全票一致 = 异常信号，应记一笔并触发人工抽检。'
      : `结论层分歧数 ${结论层.length}，反例面 ${有反例 ? '存在' : '不存在'}。`,
    参与人数: 集.length,
    结论层,
  };
}
