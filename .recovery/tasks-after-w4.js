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
import { stat } from 'node:fs/promises';
import { appendLines, readJsonl, serializeByKey, withLock } from './kernel/fsx.js';
import { Denied, Fault, InvalidBody } from './kernel/errors.js';

/** （v2 · 条目18：MULTI_MODES 删除——多人只剩并行分担，模式字段不再存在。） */

/** 复核三态（§8）。「未验 ≠ 通过」，且不计打回。 */
export const REVIEW_VERDICTS = ['过', '不过', '未验'];

const TERMINAL = new Set(['已采纳', '已结账']);

/**
 * 合法转移表：主干环路（受理→定判据→派发→执行→交卷→复核→采纳/打回）的次序由它强制执行。
 * 没有它，「已采纳」能被 start 复活、「待派发」能直接 review 成已采纳——环路次序就没有强制力。
 *  - start：已派发开工；已打回/未验返工。
 *  - submit：执行中交卷；已交卷再交 = 会审里另一个人交他自己的那份（fold 按人留）。
 *    讨论段存在即拒（锁内判，2026-10-12 评审 P1-4：揭名后不许洗卷）。
 *  - review：已交卷初核；未验/已打回后再核。
 *  - markPending：任何非终态、非待决；resolvePending：只在待决。
 *  - attach：任何非终态。
 *  - exemptReview：复核豁免登记，只标记不转移（与 attach 同格，
 *    任何非终态可挂，待决中也可——裁决=不复核本身就是一种决定）。
 *    （v2 · 2026-10-18：豁免从逐案授权引用改为读部署设置「复核免审」全局开关；
 *    提名/池化派单 nominateReview/assignReview 随复核者降级整体移除——
 *    复核员由 Lead 按任务 member_spawn 手动起实例。历史账本里的 review_nominated /
 *    review_assigned 事件仍由 fold 折出，只增账本不回头改。）
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
  // reassign（task-机制缺口-10th0 · 裁决③ · 2026-10-13）：改派负责人。
  // 只许在「待派发 / 已派发」改——执行中改派会让「谁在干活」与已交的作业归属脱钩，
  // 交卷后改派会洗掉「谁交的卷」。负责人实例消亡 ⇒ 只能重建节点的死路由此打通。
  reassign: ['待派发', '已派发'],
  // exemptReview：复核豁免登记。豁免是**标记**不是状态转移，
  // 任何非终态可挂（与 attach 同格）——待决中的提名也可就地豁免（裁决 = 不复核）。
  exemptReview: ['待派发', '已派发', '执行中', '已交卷', '未验', '已打回', '待决'],
  // （v2 · 条目18：debate_* 三键随写路径一并删除——会审退出任务图，没有人再能
  //  追加 debate_* 事件；历史事件仍由 fold 折出。）
};

/**
 * 齐卷判据的**唯一源**（§9 会审解锁 / §10 盲评遮罩 / 讨论开启，三处共用一把尺）：
 * 状态已交卷 + 负责人非空 + **每个负责人**都在独立答案里交过自己那份。
 * 按人核对，不是计数——计数会被「非负责人垫一份」骗开（2026-10-12 评审：
 * Lead 往会审节点交一份垫数 ⇒ 计数齐、按人不齐 ⇒ 遮罩提前揭开而 debate_open 反而拒）。
 * 判据漂一处，盲评与解锁就分叉；所以它只能住在这里。
 *
 * @param {object|null} node 任务图节点（fold 投影）
 * @returns {boolean}
 */
export function 全员已交(node) {
  const 负责人 = node?.负责人 ?? [];
  const 已交 = (node?.独立答案 ?? []).map((a) => a.成员);
  return Boolean(node) && node.状态 === '已交卷' && 负责人.length > 0 && 负责人.every((r) => 已交.includes(r));
}

export class TaskGraph {
  /**
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock, memory?: import('./memory.js').MemoryService, registry?: import('./registry.js').RoleRegistry }} spec
   *   `memory` 只被 `settle`（结账归档作答）用；`registry` 只被派发闸（`#assertOwnersSeated`）用。
   *   两者都由装配点（org.js）负责接上；**直接构造不接它们 = 夹具口径**（对应机制自动退位，
   *   不是旁路——装配面 org.js 恒注入，见 test/dispatch-liveness.test.js 的夹具口径用例）。
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
    this.memory = spec.memory ?? null;
    this.registry = spec.registry ?? null;
    /**
     * 事件流读缓存（2026-10-13 第三批性能收口）：键 = 账本路径，值 = {签名, rows}。
     * 为什么安全：**真源仍是文件**，签名（mtimeMs+size+本进程写计数）一变即重读。
     * 修前每个公开操作都要重读+重解析整条事件流（get/list/#append/写后再读），
     * 一次 submit 最多 4 遍全量；账本上万行时写路径明显劣化。
     */
    this.#readCache = new Map();
    /** 本进程写计数（写后即使 mtime/size 撞车也重读——同一个写者自己知道自己写过）。 */
    this.#writeCount = new Map();
  }

  /** @type {Map<string, {签名: string, rows: object[]}>} */
  #readCache;
  /** @type {Map<string, number>} */
  #writeCount;

  /**
   * 事件行（带读缓存）：签名 = 盘上 mtime+size + 本进程对这条账本的写次数。
   * @param {string} 项目
   * @returns {Promise<object[]>}
   */
  async #rowsOf(项目) {
    const file = this.layout.taskLog(项目);
    let 签名;
    try {
      const st = await stat(file);
      签名 = `${st.mtimeMs}:${st.size}:${this.#writeCount.get(file) ?? 0}`;
    } catch {
      签名 = `absent:${this.#writeCount.get(file) ?? 0}`;
    }
    const hit = this.#readCache.get(file);
    if (hit?.签名 === 签名) return hit.rows;
    const rows = await readJsonl(file);
    this.#readCache.set(file, { 签名, rows });
    return rows;
  }

  /** 记一次本进程写入：让缓存签名失效（下一次读必然重读）。 */
  #bumpWrite(项目) {
    const file = this.layout.taskLog(项目);
    this.#writeCount.set(file, (this.#writeCount.get(file) ?? 0) + 1);
  }

  /**
   * 建节点。判据是必填项，不是可选说明。
   *
   * 依赖校验（W3 批3·2026-10-09）在**锁内**做（见 `#assertDependencies`）：
   * 依赖指向空气会让派发永远等不到前置；依赖链成环会让「先做谁」这件事没有解。
   *
   * @param {{ subject: object, 描述: string, 负责人: string|string[], 判据: string|string[], 依赖?: string[], 项目: string }} input
   * @returns {Promise<object>} 节点投影
   */
  async create(input) {
    if (!input.描述?.trim()) throw new InvalidBody('任务节点必须有描述。');
    const 判据 = normalizeList(input.判据);
    if (判据.length === 0) throw new InvalidBody('验收标准必填：没有判据的节点无法验收，也无法在派发后冻结。', { missing: ['判据'] });
    // 去重（2026-10-12 评审 P3）：['A','A'] 会让会审进度/参与者数虚增，
    // 「交齐」判据虽按人去重判定不受影响，但读数说谎就是缺陷。
    const 负责人 = [...new Set(normalizeList(input.负责人))];
    if (负责人.length === 0) throw new InvalidBody('任务节点必须有负责人。', { missing: ['负责人'] });
    // v2（条目18）：「模式」字段删除——独立会审退出任务图后，多人形态只剩并行分担
    // 一种，无需声明。历史事件里的 模式 仍由 fold 原样折出（旧数据只读不迁移）。
    const 依赖 = normalizeList(input.依赖);

    // 节点 id 要**短**到能在命令行里念出来（§14.4-1「稳定、短、kebab」）：
    // 描述里取 16 字做前缀便于认人，后缀取时间戳末 5 位 base36 保证同一毫秒内不撞。
    // 描述本身由面板整条显示，不需要挤在 id 里。
    const 初始id = `task-${slugOf(input.描述, 'x')}-${this.clock.ms().toString(36).slice(-5)}`;
    await this.policy.check({
      subject: input.subject,
      action: 'create',
      target: { id: 初始id, kind: '任务', authority: '自治', zone: '私有', domain: '集体', project: input.项目 },
      context: {},
    });
    const 事件 = {
      kind: 'created',
      id: 初始id,
      描述: input.描述,
      负责人,
      判据,
      依赖,
      状态: '待派发',
    };
    // 校验挂在 eventBuilder 上，是为了**在锁内**跑（锁外预读会与并发 create 打架：
    // 刚建好的依赖读不到 ⇒ 误拒一个完全合法的节点）。builder 只校验、原样返回事件。
    // id 撞车自动换号重试（2026-10-14 审查 P3）：id = 描述16字 + 毫秒末5位 base36，
    // 同毫秒同描述必撞——锁内查重命中就换一个新号再来（最多 3 次，仍撞则响亮拒）。
    let 节点 = null;
    for (let 尝试 = 0; 尝试 < 3 && !节点; 尝试 += 1) {
      const id = 尝试 === 0 ? 初始id : `task-${slugOf(input.描述, 'x')}-${(this.clock.ms() + 尝试).toString(36).slice(-5)}${尝试}`;
      try {
        ({ 节点 } = await this.#append(input.项目, { ...事件, id }, input.subject, '状态变更', (_node, rows) => {
          if (fold(rows).has(id)) {
            throw new InvalidBody(`节点 id 撞车：${id} 已存在（同毫秒同描述）。`, { detail: { id } });
          }
          this.#assertDependencies(依赖, id, fold(rows));
          return { ...事件, id };
        }));
      } catch (error) {
        if (error instanceof InvalidBody && /id 撞车/.test(error.message) && 尝试 < 2) continue;
        throw error;
      }
    }
    return 节点;
  }

  /**
   * 派发闸（派活闭环 2026-10-15·主权者裁决）：派活派的是**身份**，不是名字。
   *
   * 每个负责人必须「就位」，三条正路任一即可：
   *  ① **在册在岗实例 id** —— 身份档案 members[id].status === '在岗'（拉起子会话后
   *     先 `registry_assign` 登记再派，这是主干顺序）；
   *  ② **岗位名且有在岗实例** —— scopeOf 既有的岗位寻址语义（债㉔ 只登记不改）：
   *     该岗至少一名在册在岗实例，派岗位名 = 派给「这个岗上活着的人」；
   *     该岗零在岗实例的岗位名 = 派给空气的另一种写法，照拒。
   *  ③ **Lead/主权者自领** —— 负责人就是本次主体自己（一次性、判据清楚的活，
   *     Lead 顺手干；自领不查档案——Lead 的身份来自会话事实，不来自 members）。
   *
   * `registry` 缺席（直接构造的夹具）时跳过本闸——装配点 org.js 恒注入。
   * @param {string[]} 负责人
   * @param {object} subject
   * @param {string} 动作 'dispatch' | 'reassign'（排兵动作共用一把闸）
   */
  async #assertOwnersSeated(负责人, subject, 动作) {
    if (!this.registry) return;
    const identity = await this.registry.identity();
    const members = identity?.members ?? {};
    const 在岗岗位 = new Set(Object.values(members).filter((m) => m?.status === '在岗').map((m) => m.岗位));
    const 未就位 = (负责人 ?? []).filter((id) => {
      if (members[id]?.status === '在岗') return false;
      if (在岗岗位.has(id)) return false;
      if (id === subject?.id && (subject?.kind === 'Lead' || subject?.kind === '主权者')) return false;
      return true;
    });
    if (未就位.length > 0) {
      throw new Denied(
        '任务图 · 派发闸（派活闭环 2026-10-15）',
        `${动作}的负责人未就位：${未就位.join('、')} 既不是在册在岗的实例，也不是有在岗实例的岗位。派活派的是身份，不是名字——「拉起了会话却没登记」与「压根没拉」在这里同一个下场。`,
        {
          detail: { 未就位, 身份档案里的在岗实例: Object.keys(members).filter((id) => members[id]?.status === '在岗') },
          howToChange: `三条正路任一：① 宿主侧拉起成员会话后先 registry_assign（实例=<会话id>，岗位=<有卡的岗位>）再${动作}；② 按岗位名${动作}，且该岗至少留一名在岗实例；③ Lead 自领（负责人写本次主体自己）。`,
        },
      );
    }
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
    await this.#assertOwnersSeated(node.负责人, spec.subject, '派发');
    const { 节点 } = await this.#append(
      spec.项目,
      { kind: 'dispatched', id, 判据冻结: true },
      spec.subject,
      '状态变更',
      null,
      (nodeInLock) => {
        // 锁内复检（P1-6）：派发只对「待派发」——锁外读过之后节点可能已被并发派发/推进。
        if (!nodeInLock || nodeInLock.状态 !== '待派发') {
          throw new Denied('任务图 · 状态机', `节点 ${id} 在锁内已推进为 ${nodeInLock?.状态 ?? '不存在'}，不能重复派发。`, { howToChange: '只对「待派发」的节点派发。' });
        }
      },
    );
    return 节点;
  }

  /** @param {string} id @param {{ subject: object, 项目: string }} spec */
  async start(id, spec) {
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'start');
    await this.#checkWrite(id, node, spec);
    const { 节点 } = await this.#append(spec.项目, { kind: 'started', id, 状态: '执行中' }, spec.subject, '状态变更', null, this.#transitionGuard(id, 'start'));
    return 节点;
  }

  /**
   * 改派负责人（task-机制缺口-10th0 · 裁决③ · 2026-10-13）。
   *
   * 背景：`create` 之后再没有任何接口能动 `负责人`——负责人实例消亡后节点只能重建
   * （workbench 三个节点全卡在「派了活但成员跑不起来」就是这条死路）。
   *
   * 三条边界（裁决原文）：
   *  - **仅 Lead**：改派是「把活从一个人手里挪到另一个人手里」的排兵动作，成员不能自派；
   *  - **仅 待派发 / 已派发**：执行中改派会让作业归属脱钩、交卷后改派会洗掉交卷人（状态机守着）；
   *  - **入审计**：谁把哪个节点从谁改派给谁，走事件流（fold 可重建）+ 审计一条。
   *
   * @param {string} id
   * @param {{ subject: object, 项目: string, 负责人: string|string[] }} spec
   */
  async reassign(id, spec) {
    if (spec.subject?.kind !== 'Lead') {
      throw new Denied('任务图 · 改派负责人仅 Lead', `改派是排兵动作（把节点的负责人换成别人）：${spec.subject?.kind ?? '未知'} 没有这只手，成员不能自派、也不能把别人的活挪走。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 执行 task_reassign（改派事实与新旧负责人都进审计）。',
      });
    }
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'reassign');
    const 负责人 = [...new Set(normalizeList(spec.负责人))];
    if (负责人.length === 0) throw new InvalidBody('改派后的负责人名单不能为空。', { missing: ['负责人'] });
    // v2（条目18）：多人不再要「模式」——只剩并行分担一种形态，名单即全部事实。
    await this.#checkWrite(id, node, spec);
    // 派发闸同款（排兵动作共用一把尺）：改派给「未就位」的负责人 = 把活挪给空气。
    await this.#assertOwnersSeated(负责人, spec.subject, '改派');
    const 旧负责人 = node.负责人 ?? [];
    const { 节点: after } = await this.#append(
      spec.项目,
      { kind: 'reassigned', id, 负责人 },
      spec.subject,
      '状态变更',
      (nodeInLock) => {
        // 锁内复检状态：拿号到落笔之间节点可能已被推进（执行中/交卷后不许改派）。
        if (!['待派发', '已派发'].includes(nodeInLock.状态)) {
          throw new Denied('任务图 · 状态机', `节点 ${id} 在锁内已推进为 ${nodeInLock.状态}，不能执行 reassign（允许的状态：待派发 / 已派发）。`, {
            howToChange: '主干环路的次序是 受理→定判据→派发→执行→交卷→复核→采纳/打回；按当前状态选下一步动作。',
          });
        }
        return { kind: 'reassigned', id, 负责人 };
      },
    );
    return { ...after, 改派: { 从: 旧负责人, 到: 负责人 } };
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
    const event = {
      kind: 'submitted',
      id,
      状态: '已交卷',
      产出物引用: spec.产出物引用 ?? [],
      结论: spec.结论 ?? null,
      // 结论层是 §10 零分歧判据的**主键**（2026-10-14 审查 P1-1）：修前全链路不采集它，
      // judgeZeroDivergence 恒退化为「结论全文逐字相等」——独立写的两份答案几乎不会逐字
      // 相同 ⇒ 「全票一致=异常」报警事实上永不触发。结论层由交卷人自标（结构化短语，
      // 如「方案A/可修/不可修」），措辞漂不了的判据才成立。
      结论层: spec.结论层 ?? null,
      // 反例面由交卷人自己给：§10 的零分歧判据是「结论层一致**且无人给出反例面**」，
      // 而反例面必须来自各自的独立产出，不能事后由 Lead 补。
      反例面: spec.反例面 ?? [],
      // v2 条目15/16：交卷可附「知识候选」（值得蒸馏成知识的点）。成员不得直接写知识，
      // 候选随交卷入账，结账时的记忆处置逐条判它（晋升 / 留账本 / 丢弃）。
      知识候选: (Array.isArray(spec.知识候选) ? spec.知识候选 : []).map((s) => String(s).trim()).filter(Boolean),
    };
    const { 节点 } = await this.#append(spec.项目, event, spec.subject, undefined, (nodeInLock) => {
      // 讨论段存在 ⇒ 答案已揭名（或已收敛）：从「已交卷」再交卷会在 fold 里按「同人替换」
      // 静默洗掉本人那份独立答案（2026-10-12 评审 P1-4），零分歧判定就跑在洗过的答案集上。
      // 判定必须在锁内（builder）：debate_opened 与 submit 走同一把项目锁，锁外预读有竞态。
      // 返工环路不受影响：打回后状态是 已打回/执行中（不是已交卷）， rework 的提交照常放行；
      // R09（2026-10-16）：打回已把讨论段随代清空——这里拦的恒是**当前代**的改卷，
      // 上一代的讨论不再误伤新代交卷（审查实证：B 的新卷曾被旧讨论拦死）。
      if (nodeInLock?.讨论 && nodeInLock.状态 === '已交卷') {
        throw new Denied(
          '任务图 · 讨论段开启后不许改卷（§10 独立会审完整性）',
          `节点 ${id} 已开启讨论段（${nodeInLock.讨论.状态 ?? '未知'}）：答案已揭名，再交卷会静默替换你原来的独立答案——那不是交卷，是洗卷。`,
          { howToChange: '要改答案走返工环路：请复核者 review「不过」打回 → task_start → task_submit。' },
        );
      }
      return event;
    }, this.#transitionGuard(id, 'submit'));
    return 节点;
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
    // P1-02（全面审查 2026-10-17）：打回会关闭当前代并清空独立答案；若此时允许复核(过)，
    // 就是「没有新证据也能把不合格产出洗成已采纳」。返工必须先 start → submit 再核。
    if (node.状态 === '已打回' && (node.独立答案 ?? []).length === 0) {
      throw new Denied(
        '任务图 · 返工未交卷不得复核（P1-02）',
        `节点 ${id} 已打回且当前代没有独立答案：打回已关闭当前代，复核(过)会让不合格产出一份新证据都没有就被采纳。`,
        {
          requireAuthority: 'Lead',
          howToChange: '先 task_start 返工、task_submit 交新卷，再 task_review；不要用复核撤销打回。',
        },
      );
    }
    // 冲突排除硬规则（§3.4 提审分离 + v2 口述收敛 2026-10-18 条目2）：独立性由这条规则承担
    // （复核者降级后不再有任命授权那道闸）——**交卷人 / 任务负责人都不得复核本节点**。
    // 判据看独立答案按人留与负责人名单的事实，不看自报；「同会话者」在统一实例模型下
    // 被同一 id 覆盖（实例键 = 会话 id，负责人/交卷人用的是同一位）。
    // 判的是**归属复核者**这一位（2026-10-14 校准复核）：操作者（常是 Lead 会话代执行）
    // 不在判据里——能交卷又能复核的复合身份只有 Lead，而 Lead 代执行 + 复核者署名是
    // 合规形态（host.test.js 全链路用例钉着它）；真主体与署名复核者双双入账，谎可见。
    const 复核者id = String(spec.复核者 ?? spec.subject?.id ?? '');
    const 撞人 = (node.独立答案 ?? []).some((a) => String(a.成员) === 复核者id) ? 复核者id : null;
    if (撞人) {
      throw new Denied('任务图 · 交卷人不得复核自己的卷（§3.4 提审分离）', `复核者 ${撞人} 在本节点的独立答案里：交卷人复核自己的卷 = 给自己发合格证。`, {
        howToChange: '由未参与交卷的主体执行 task_review（复核员或 Lead/主权者）；交卷人有异议走返工环路（review 不过 → task_start 重做）。',
      });
    }
    // v2 条目2：负责人（执行者）同样不得复核本任务——哪怕他没有亲自交卷
    // （一岗多人里「没交卷的那个负责人」照样参与了产出，独立性一样破）。
    if ((node.负责人 ?? []).includes(复核者id)) {
      throw new Denied('任务图 · 负责人不得复核自己的任务（v2 冲突排除）', `复核者 ${复核者id} 是节点 ${id} 的负责人：执行者复核自己的任务 = 自己验收自己。`, {
        howToChange: '由 Lead 用 member_spawn 起一位与本节点无关的复核员实例复核；该实例用完即封存。',
      });
    }
    await this.policy.check({
      subject: spec.subject,
      action: 'review',
      target: { id, kind: '任务', authority: '自治', zone: '私有', project: spec.项目 },
      context: {},
    });
    const 状态 = spec.三态 === '过' ? '已采纳' : spec.三态 === '不过' ? '已打回' : '未验';
    const { 节点: reviewed } = await this.#append(spec.项目, {
      kind: 'reviewed',
      id,
      三态: spec.三态,
      状态,
      分歧清单: spec.分歧清单 ?? [],
      反例面: spec.反例面 ?? [],
      复核者: spec.复核者 ?? spec.subject?.id,
      算通过: spec.三态 === '过',
      计打回: spec.三态 === '不过',
    }, spec.subject, '状态变更', null, this.#提审分离Guard(id, 'review', 复核者id));
    if (spec.三态 === '不过') await this.reject(id, { subject: spec.subject, 项目: spec.项目, 理由: `复核不过：${(spec.分歧清单 ?? []).join('；') || '未给分歧清单'}` });
    // 打回路径下 reject 又写了一条事件：返回它折出来的最新节点才是真读数。
    return spec.三态 === '不过' ? this.get(id, { 项目: spec.项目 }) : reviewed;
  }

  /**
   * 复核豁免登记（G4 · 交接件《复核员任命闭环缺口》2026-10-14；v2 改写 2026-10-18）。
   *
   * 缺口：主权者选择不复核时，「未经独立复核」只能写在交卷正文里——不可查询、
   * 不可统计，进不了「谁没被复核」的账。本方法给豁免一个**可查询的节点字段**，
   * 使「哪些产出没被复核」成为兜底统计面（产出者不得自己回答交付得好不好）。
   *
   * 边界（v2 口述收敛 2026-10-18 条目5）：
   *  - **仅 Lead / 主权者**：豁免免除的是独立复核本身，门槛取最高；
   *  - **部署设置「复核免审」全局开关**：豁免从「逐案授权引用」改为部署级开关——
   *    关（默认）⇒ 一律拒；开 ⇒ 允许登记且动作照进事件流与审计接受复核；
   *  - **只标记、不转移**：不动状态机（与 attach 同格，任何非终态可挂）。
   *
   * @param {string} id
   * @param {{ subject: object, 项目: string, 原因?: string }} spec
   */
  async exemptReview(id, spec) {
    if (!['Lead', '主权者'].includes(spec.subject?.kind)) {
      throw new Denied('任务图 · 复核豁免仅 Lead / 主权者', `豁免免除的是独立复核本身：${spec.subject?.kind ?? '未知'} 没有这个入口。`, {
        requireAuthority: '主权者',
        howToChange: '由 Lead 或主权者执行 review_exempt；前提是部署设置「复核免审」已打开。',
      });
    }
    if (this.policy.reviewExemptAllowed?.() !== true) {
      throw new Denied(
        '任务图 · 复核豁免已由部署设置全局关闭',
        '部署设置「复核免审」当前为关（默认）：豁免复核 = 放弃「组织不给自己发合格证」这道防线，v2 起它是部署级全局开关，不再逐案授权。',
        {
          requireAuthority: '主权者',
          howToChange: '由主权者在 部署.json 把「复核免审」设为 true 后重载（policy.reload）再执行；开关变化与每次豁免登记都进审计。',
        },
      );
    }
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'exemptReview');
    await this.#checkWrite(id, node, spec);
    const { 节点 } = await this.#append(
      spec.项目,
      { kind: 'review_exempted', id, 豁免原因: spec.原因 ?? '' },
      spec.subject,
      '状态变更',
      null,
      this.#transitionGuard(id, 'exemptReview'),
    );
    return 节点;
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
    }), (nodeInLock) => {
      // 锁内复检（P1-6）：终态不许打回——锁外读的 TERMINAL 判定可能与并发 review(过) 竞态。
      if (!nodeInLock) throw new InvalidBody(`没有这个任务节点：${id}（在锁内折叠视图中不存在）`);
      if (TERMINAL.has(nodeInLock.状态)) {
        throw new Denied('任务图 · 状态机', `节点 ${id} 已到终态 ${nodeInLock.状态}（锁内复检），不能再打回。`, { howToChange: '终态节点只能追加更正，不能回到环路里。' });
      }
    });
    if ((rejected.事件.打回次数 ?? 0) === 2) {
      // 去重判据就是「恰好第 2 次」本身（2026-10-14 审查 P2-8）：打回次数在锁内单调
      // 递增算出，全事件流里只有一条 rejected 携带次数==2 ⇒ 并发两个 reject 也只有
      // 一个满足条件。修前用 `>=2` + 锁外查「已升过」，两个并发 reject 都在对方
      // escalated 落线前读缓存 ⇒ 双 escalated（告警疲劳正是这条要防的）。
      const { 节点: 升级后 } = await this.#append(spec.项目, { kind: 'escalated', id, 升级: { 原因: '打回≥2', 至: '主权者' } }, { id: 'system', kind: '系统' });
      return 升级后;
    }
    return rejected.节点;
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
    const { 节点 } = await this.#append(spec.项目, { kind: 'pending', id, 状态: '待决', 待决原因: spec.原因, 待决类型: spec.待决类型 ?? '升级差异' }, spec.subject, '状态变更', null, this.#transitionGuard(id, 'markPending'));
    return 节点;
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
    // 恢复状态在**锁内**用最新折叠视图取（2026-10-13 审查 M3 顺修）：锁外算好的
    // `待决前的状态` 与并发 markPending 竞态时会把节点恢复到陈旧状态。
    const { 节点 } = await this.#append(
      spec.项目,
      { kind: 'resolved', id, 待决: false, 决定: spec.决定, 已决于: this.clock.iso() },
      spec.subject,
      '状态变更',
      (nodeInLock) => ({ kind: 'resolved', id, 待决: false, 状态: nodeInLock?.待决前的状态 ?? nodeInLock?.状态 ?? null, 决定: spec.决定, 已决于: this.clock.iso() }),
      this.#transitionGuard(id, 'resolvePending'),
    );
    return 节点;
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
    const { 节点 } = await this.#append(spec.项目, { kind: 'artifact', id, 产出物: spec.产出物 }, spec.subject, '状态变更', null, this.#transitionGuard(id, 'attach'));
    return 节点;
  }

  // ── v2（口述收敛 2026-10-18 条目18）：会审讨论段退出任务图 ──────────────────
  // debateOpened/debateRounded/debateConverged 三个写路径已删——会审是与会话绑定的
  // 独立功能（src/council.js，自己的 councils.jsonl 事件流）。旧事件（debate_*）
  // 仍由下方 fold 分支折出（历史数据原地只读不迁移）；TRANSITIONS 里的 debate_*
  // 条目同步失效：没有人再能追加它们，状态机自然封闭。

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
    return this.#rowsOf(spec.项目);
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /**
   * @param {string} 项目 @param {object} event @param {object} subject @param {string} [审计动作] 覆盖默认的「状态变更」（讨论段三事件按 W2 规格记各自动作名，档位由 ACTION_GRADE 定）
   * @param {(nodeInLock: object|null, rows: object[]) => object} [eventBuilder] 用**锁内**折叠视图重算事件字段——
   *   打回次数这类「从当前状态推导」的值必须以锁内读到的为准（W3 批1·2026-10-09）：
   *   锁外算好再进锁，两个并发 reject 会算出同一个次数，链上少一次打回。
   *   第二个参数是**锁内的原始事件行**：跨节点判定（依赖图这类）也必须在锁内做，
   *   锁外预读会与并发 create 打架（W3 批3·2026-10-09）。builder 抛错即拒写。
   * @param {(nodeInLock: object|null, rows: object[]) => void} [inLockGuard] **锁内状态机复检**
   *   （2026-10-13 审查 P1-6）：锁外 #require/#requireTransition 读到的状态与落笔时刻可能不同——
   *   review(过) 与 submit 并发时，submit 在锁外过闸、锁内把已采纳节点洗回「已交卷」就是这条路。
   *   所有转移类事件在锁内用最新折叠视图再验一次；抛错即拒写。
   * @returns {Promise<{事件: object, 节点: object|null}>} 实际落线的事件 + **锁内投影出的节点**
   *   （2026-10-13 第三批性能收口：修前调用方落线后再 `get()` 一次全量读+折叠；
   *   现在锁内已经把新行折进去了，直接给——顺带消掉「写后再读」可能读到别人中途写入的竞态。）
   */
  async #append(项目, event, subject, 审计动作 = '状态变更', eventBuilder = null, inLockGuard = null) {
    const file = this.layout.taskLog(项目);
    let finalEvent = event;
    let 新节点 = null;
    // F4（设计评审 2026-10-15）：在 withLock 外套 serializeByKey（同 key = 本账本文件）。
    // 为什么有了 withLock 还要它：Windows 上「名字式」文件锁存在 rm/create 竞态——持有者的
    // rm 与等待者的 open('wx') 在删除挂起窗口内交错时，两个等待者可以先后各自建出锁文件
    // 并都进入临界区（fsx.js:302-309 自认；审计链曾因此 fork，见 identity-chain E3）。
    // 审计账本已补这层（audit.js append 的双层范例：serializeByKey(file, () => withLock(...))），
    // 任务图与总线此前没有——同一竞态对 tasks.jsonl 意味着可能的双行事件，且任务图没有
    // 审计链那样的自检兜底。进程内这条 await 链保证同 key 的写绝不重叠。
    // 注意 withLock 不可重入（fsx.js 头注释）：serializeByKey 的 fn 里不得再拿同一把锁。
    await serializeByKey(file, () =>
      withLock(this.layout.taskLock(项目), async () => {
        // 锁内必须重读真源（fresh）：缓存可能落后于别的进程刚写下的行，
        // 状态机复检/依赖校验都建立在锁内折叠视图上，读旧表就是判错。
        const rows = await readJsonl(file);
        const node = fold(rows).get(event.id);
        if (inLockGuard) inLockGuard(node, rows);
        if (eventBuilder) finalEvent = eventBuilder(node, rows);
        // 判据冻结：派发之后任何想动判据的事件都被拒绝。这是 §7 那一条的可执行形态。
        // 查 builder **之后**的 finalEvent（2026-10-14 审查 P3）：builder 有权改写事件，
        // 只查入参会漏掉 builder 产出里夹带的判据。
        if (node?.判据冻结 && Object.hasOwn(finalEvent, '判据')) {
          throw new Denied('任务图 · 派发后判据冻结', `节点 ${event.id} 已派发，判据不能在事后改动。`, {
            requireAuthority: '主权者',
            howToChange: '判据要变就新开一个节点；改判据等于让验收标准追着结果跑。',
          });
        }
        const at = this.clock.iso();
        const by = subject && typeof subject === 'object' ? { id: String(subject.id), kind: String(subject.kind ?? '未知') } : { id: String(subject), kind: '未知' };
        const 落线行 = { seq: rows.length + 1, at, by, ...finalEvent };
        await appendLines(file, [落线行]);
        // 本进程写过了：让读缓存签名失效（下一次读必重读），并把新行折进来的投影直接给出。
        this.#bumpWrite(项目);
        新节点 = fold([...rows, 落线行]).get(event.id) ?? null;
      }),
    );
    // 事件已落线、审计是第二笔（2026-10-14 审查 P2-9）：审计追加失败时状态已变、链上
    // 缺条——调用方若只收到裸错误可能误判「没写成」而重试（submit 重试 = 洗自己答案的
    // 合法窗口）。错误必须明示「事件已落线、仅审计缺失」，并把事件 id 带上供人工补账。
    try {
      await this.audit.append({
        动作: 审计动作,
        主体: subject,
        对象: { id: finalEvent.id, kind: '任务' },
        依据: '任务图事件流',
        结果: finalEvent.kind,
        项目,
        详情: { 事件: finalEvent.kind, 状态: finalEvent.状态 ?? null },
      });
    } catch (error) {
      throw new Fault('AUDIT_APPEND_FAILED_AFTER_EVENT', `任务事件 ${finalEvent.kind}（${finalEvent.id}）已落线，但审计追加失败：${error instanceof Error ? error.message : String(error)}。不要重试本操作——重试会在任务图上再落一条同效事件；请人工核对账本并补记。`, {
        detail: { 事件: finalEvent.kind, id: finalEvent.id, 项目 },
      });
    }
    return { 事件: finalEvent, 节点: 新节点 };
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
   * 为什么**不翻转**这个顺序（#14 · 设计评审 2026-10-15，勿「顺手优化」）：事件先行会造成
   * 「已结账但归档永久缺失」——结账事件落线后重试 settle 会被状态机以「已结账非已采纳」
   * 拒掉，归档没有重试路；而归档先行失败后重试 settle 可以收敛（archiveAnswers 按
   * fold 出的「未归档」现算候选集，已归档的不会重复归档，幂等）。代价是存在「已归档、
   * 事件未落线」的失败窗口——仅在事件落线前失败（含锁内 guard 拒）时追加告警补偿。
   * 若事件已落线、仅审计失败，则保留 #append 的不可重试 Fault，不制造相反的审计事实。
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
    // v2（口述收敛 2026-10-18 条目16）：结账强制记忆处置——无声明一律拒收，并把
    // 本任务候选（挂账经历 + 交卷附的知识候选）列出来供逐条判。主动发起不靠 Lead
    // 记得，靠环路不结案。
    const 经历候选 = await this.memory.settleCandidates({ 项目: spec.项目, 任务: id });
    const 交卷候选 = [];
    for (const a of node.独立答案 ?? []) {
      (a.知识候选 ?? []).forEach((文本, i) => 交卷候选.push({ 键: `候选/${a.成员}/${i}`, 成员: a.成员, 内容: 文本 }));
    }
    const 候选清单 = [
      ...经历候选.map((c) => ({ 键: c.id, 类: '经历', 标题: c.标题 })),
      ...交卷候选.map((c) => ({ 键: c.键, 类: '交卷候选', 标题: String(c.内容).slice(0, 40) })),
    ];
    const 处置 = spec.记忆处置;
    if (!处置 || typeof 处置 !== 'object' || Array.isArray(处置)) {
      throw new Denied('任务图 · 结账必须带「记忆处置」声明（v2 条目16）', `节点 ${id} 结账被拒：先逐条判本任务的记忆候选（晋升 / 留账本 / 丢弃），再结账。候选清单在本拒绝的 detail.候选清单里；确无候选就传 记忆处置={} 明示「无产出需处置」。`, {
        howToChange: '重发 task_settle 并带 记忆处置（候选键 → 晋升/留账本/丢弃）。',
        detail: { 候选清单 },
      });
    }
    for (const c of 候选清单) {
      if (!['晋升', '留账本', '丢弃'].includes(处置[c.键])) {
        throw new InvalidBody(`记忆处置必须覆盖每条候选，值只认 晋升 / 留账本 / 丢弃。缺失或非法：${c.键}（${c.类}「${c.标题}」）。`, { missing: [c.键], detail: { 候选清单 } });
      }
    }
    // 「丢弃」的机械含义 = 追加失效（不许改写只能追加——丢的是召回面，不是账本行）；
    // 「晋升」是 Lead 的蒸馏动作（知识要 Lead 落笔，机制不替他写），声明入账后走
    // memory_lifecycle / promote 执行。「留账本」= 不动。
    for (const c of 经历候选) {
      if (处置[c.id] === '丢弃') {
        await this.memory.invalidate(c.id, { subject: spec.subject, 原因: `结账记忆处置：丢弃（节点 ${id}）` });
      }
    }
    const 归档 = await this.memory.archiveAnswers({ 项目: spec.项目, 任务: id, subject: spec.subject });
    try {
      const { 节点 } = await this.#append(spec.项目, { kind: 'settled', id, 状态: '已结账', 归档条数: 归档.归档条数, 记忆处置: 处置 }, spec.subject, '结账', null, this.#transitionGuard(id, 'settle'));
      return 节点;
    } catch (error) {
      // #append 已确认事件落线时，补偿“未落线”会留下反向事实和不可执行的重试指引。
      if (error instanceof Fault && error.code === 'AUDIT_APPEND_FAILED_AFTER_EVENT') throw error;
      // #14（设计评审 2026-10-15）· 补偿审计：作答已归档、终态事件未落线。这不是回滚
      // （归档先行是有意设计，见上），是把失败窗口从静默变成响亮——重试 settle 可收敛。
      try {
        await this.audit.append({
          动作: '结账未落线',
          主体: spec.subject,
          对象: { id, kind: '任务' },
          依据: '#14 · 归档先行、事件未落线的补偿留痕（设计评审 2026-10-15）',
          结果: `作答已归档（${归档.归档条数} 条），结账事件未落线：${error instanceof Error ? error.message : String(error)}`,
          项目: spec.项目,
          告警: true,
          详情: { 节点: id, 归档条数: 归档.归档条数, 失败原因: error instanceof Error ? error.message : String(error), 收敛路径: '作答已归档、事件未落线，重试 settle 可收敛（archiveAnswers 幂等：已归档条目不再重复归档）' },
        });
      } catch (补偿失败) {
        // 连补偿审计都写不进去（审计账本本身坏了）：console 是这里最后的出口（§3.6 不吞声），
        // 原始错误照抛——绝不能用补偿失败覆盖掉真因。
        console.warn(`[dsh-mind] settle(${id})：结账未落线的补偿审计也失败了（${补偿失败 instanceof Error ? 补偿失败.message : String(补偿失败)}）——人工核对任务图与审计账本。`);
      }
      throw error;
    }
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
   * 锁内状态机复检的通用形态（2026-10-13 审查 P1-6）：节点必须存在，且当前（锁内最新）
   * 状态仍在 op 的允许清单里。锁外那次照做（快速失败 + 可读理由），锁内这次才是权威。
   * @param {object|null} node @param {string} id @param {keyof TRANSITIONS} op
   */
  #transitionGuard(id, op) {
    return (nodeInLock) => {
      if (!nodeInLock) throw new InvalidBody(`没有这个任务节点：${id}（在锁内折叠视图中不存在）`);
      this.#requireTransition(nodeInLock, op);
    };
  }

  /**
   * 状态机复检 + 冲突排除（§3.4 提审分离 + v2 冲突排除）的**锁内合闸**（2026-10-14 审查 P1-3）。
   *
   * 修前 review 的「交卷人不得复核自己」只在锁外判：
   * 并发 submit 可以在锁外过闸之后、落笔之前把答案交进来，交卷人就此当上本节点的
   * 复核者——与已修的 P1-6（状态机锁内复检）同族的漏网面。锁外那次照留（快速失败 +
   * 可读理由），锁内这次才是权威。v2（2026-10-18）起锁内同样复检负责人排除。
   *
   * @param {string} id @param {keyof TRANSITIONS} op @param {string|string[]} 复核者id 复核者（可传多个：归属复核者 + 操作者）
   */
  #提审分离Guard(id, op, 复核者id) {
    const ids = (Array.isArray(复核者id) ? 复核者id : [复核者id]).filter(Boolean).map(String);
    const 状态闸 = this.#transitionGuard(id, op);
    return (nodeInLock) => {
      状态闸(nodeInLock);
      // P1-02（锁内复检）：打回关代后没有新交卷 ⇒ 复核不得改变结论（并发下也一样）。
      if (op === 'review' && nodeInLock.状态 === '已打回' && (nodeInLock.独立答案 ?? []).length === 0) {
        throw new Denied('任务图 · 返工未交卷不得复核（P1-02，锁内复检）', `节点 ${id} 已打回且当前代没有独立答案：先返工交卷再复核。`, {
          requireAuthority: 'Lead',
          howToChange: '先 task_start 返工、task_submit 交新卷，再 task_review。',
        });
      }
      const 撞人 = ids.find((谁) => (nodeInLock.独立答案 ?? []).some((a) => String(a.成员) === 谁));
      if (撞人) {
        throw new Denied('任务图 · 交卷人不得复核自己的卷（§3.4 提审分离，锁内复检）', `复核者/操作者 ${撞人} 在本节点的独立答案里（锁内最新折叠视图）：交卷人复核自己的卷 = 给自己发合格证。`, {
          howToChange: '由未参与交卷的主体执行复核；交卷人有异议走返工环路（review 不过 → task_start 重做）。',
        });
      }
      if (op === 'review') {
        const 撞负责人 = ids.find((谁) => (nodeInLock.负责人 ?? []).includes(谁));
        if (撞负责人) {
          throw new Denied('任务图 · 负责人不得复核自己的任务（v2 冲突排除，锁内复检）', `复核者 ${撞负责人} 是节点 ${id} 的负责人（锁内最新折叠视图）：执行者复核自己的任务 = 自己验收自己。`, {
            howToChange: '由 Lead 用 member_spawn 起一位与本节点无关的复核员实例复核。',
          });
        }
      }
    };
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
      node = { id: row.id, 状态: '待派发', 打回次数: 0, 产出物引用: [], 复核经过: [], 代: 1, 答案历史: [] };
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
      // 改派负责人（task-机制缺口-10th0）：名单整体替换，历史逐次留痕（谁改的、何时）。
      // 只在 待派发/已派发 态发生（写入面状态机守着），fold 不必再判——投影如实折事件流。
      case 'reassigned':
        node.负责人 = row.负责人;
        node.改派记录 = [...(node.改派记录 ?? []), { 负责人: row.负责人, 由: row.by?.id ?? null, 于: row.at }];
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
          // 结论层随行落账（2026-10-14 审查 P1-1）：缺它，零分歧判据退化全文逐字比对。
          结论层: row.结论层 ?? null,
          反例面: row.反例面 ?? [],
          // v2 条目15/16：知识候选随交卷折回——结账时的记忆处置按它列「交卷候选」。
          知识候选: row.知识候选 ?? [],
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
      // 复核提名（G1 · 2026-10-14；v2 2026-10-18 起该机制移除，本分支只为折历史账本保留）。
      // 节点挂起等主权者任命。待决前的状态记下来，
      // resolvePending（case resolved）靠它把节点放回原状态——与 pending 事件同款。
      case 'review_nominated':
        node.待决前的状态 = node.状态;
        node.状态 = row.状态 ?? '待决';
        node.待决原因 = row.待决原因;
        node.待决类型 = row.待决类型 ?? '复核提名';
        node.复核提名记录 = [...(node.复核提名记录 ?? []), { 候选: row.候选, 提名原因: row.提名原因 ?? '', 提名人: row.by?.id ?? null, 于: row.at }];
        break;
      // 池内派单（2026-10-14 · 池化排班；v2 2026-10-18 起该机制移除，本分支为历史账本保留）。
      case 'review_assigned':
        node.复核指派 = { 候选: row.候选, 指派原因: row.指派原因 ?? '', 排班: row.排班 ?? '池内', 由: row.by?.id ?? null, 于: row.at };
        node.复核指派记录 = [...(node.复核指派记录 ?? []), { ...node.复核指派 }];
        break;
      // 复核豁免（G4 · 2026-10-14；v2 起豁免凭部署设置「复核免审」开关，新事件不再带授权引用，
      // 旧事件上的授权引用照折——只增账本不回头改）。
      case 'review_exempted':
        node.复核豁免 = { ...(row.授权引用 ? { 授权引用: row.授权引用 } : {}), 豁免原因: row.豁免原因 ?? '', 由: row.by?.id ?? null, 于: row.at };
        node.复核豁免记录 = [...(node.复核豁免记录 ?? []), { ...node.复核豁免 }];
        break;
      case 'rejected':
        node.打回次数 = row.打回次数 ?? (node.打回次数 ?? 0) + 1;
        node.最近打回理由 = row.理由;
        if (node.状态 !== '未验') {
          node.状态 = '已打回';
          // R09（审查 2026-10-16 · attempt/epoch）：打回**关闭当前代**——旧答案整代归档、
          // 讨论段清空；历史事件全在账上（只增不洗），投影只认当前代。修前的两个病：
          // ①打回后 A 先重交，齐卷=「新A/旧B」混代（审查实证：混合答案实际进入已采纳）；
          // ②B 的新卷被「不许改卷」用**上一代残留的**讨论段拦死。未验不闭代（复核窗口
          // 未关，谈不上返工）。
          const 关代 = node.代 ?? 1;
          if ((node.独立答案 ?? []).length > 0 || node.讨论) {
            node.答案历史 = [...(node.答案历史 ?? []), { 代: 关代, 独立答案: node.独立答案 ?? [], 讨论: node.讨论 ?? null, 于: row.at }];
          }
          node.代 = 关代 + 1;
          node.独立答案 = [];
          node.讨论 = null;
        }
        break;
      case 'pending':
        node.待决前的状态 = node.状态;
        node.状态 = '待决';
        node.待决原因 = row.待决原因;
        node.待决类型 = row.待决类型;
        break;
      case 'resolved':
        // 缺状态的旧数据兜底取「待决前的状态」（2026-10-14 审查 P3）：修前恒兜「已交卷」，
        // 执行中挂的待决被错误恢复成已交卷。pending/review_nominated 事件都会记
        // 待决前的状态；连它也没有（更老的账）才退回已交卷。
        node.状态 = row.状态 ?? node.待决前的状态 ?? '已交卷';
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
        // v2 条目16：记忆处置声明随结账事件折回节点——读面可见「结账时逐条判了什么」。
        if (row.记忆处置) node.记忆处置 = row.记忆处置;
        break;
      // ── W2 会审讨论段（2026-10-09）：讨论是节点的**子状态**，不动节点主状态
      //    （已交卷保持——讨论中仍可 review，软约束不许变成死锁）。
      case 'debate_opened':
        node.讨论 = {
          状态: '讨论中',
          轮次: 1,
          轮次上限: row.轮次上限,
          参与者: row.参与者 ?? [],
          // ⑮ 强制反对者（2026-10-10）：空串 = 当时没有可用候选（宁缺毋滥），
          // 与「根本没指定过」在旧数据上同形——旧事件没有这两个键 ⇒ 兜底成 ''。
          反对者: row.反对者 ?? '',
          反对者依据: row.反对者依据 ?? '',
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
