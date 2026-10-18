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
import { 复核对象引用 } from './review-scope.js';

/** （v2 · 条目18：MULTI_MODES 删除——多人只剩并行分担，模式字段不再存在。） */

/** 复核三态（§8）。「未验 ≠ 通过」，且不计打回。 */
export const REVIEW_VERDICTS = ['过', '不过', '未验'];

/**
 * 复核票的可引用前缀（补修K · 2026-10-18）：票 = `rv-<reviewed 事件 seq>`。
 * seq 由 `#append` 分配（同一项目账本内单调递增），于是票**可稳定引用**且不需要新立对象。
 */
export const 复核票前缀 = 'rv-';

/** 免审依据的可引用前缀：`ex-<review_exempted 事件 seq>`（免审不引复核票，引豁免事实）。 */
export const 免审票前缀 = 'ex-';

/**
 * 采纳依据的**封闭清单**（补修K 字段合同 · 新增依据 = 改设计，不是加个字符串）。
 * 三个新路径由 `accept()` 写；「历史复核即采纳」只由 fold 折**旧账**得出，不新写。
 */
export const 采纳依据集 = Object.freeze(['复核结论', '复核免审', '历史确认', '历史复核即采纳']);

/**
 * 「已被合法采纳」的**唯一判定**（补修K 字段合同，供后续消费者复用——别再只看状态字符串）。
 *
 * 为什么必须单独成一个函数：`状态 === '已采纳'` 会把旧账里「成员复核即采纳、没有 Lead
 * 承接」的节点也读成已采纳。依赖校验、结账、面板与后续批次的晋升面都必须走这一个判据，
 * 否则同一条事实在三处得出三种结论（本次缺口的同型错误就是各处各读状态字符串）。
 *
 * 字段合同（`node.采纳`）：
 *  - `依据` ∈ `采纳依据集`（见上）；
 *  - `票`：复核结论 / 历史确认 / 历史复核即采纳 ⇒ `rv-<reviewed 事件 seq>`；复核免审 ⇒ null；
 *  - `豁免`：复核免审 ⇒ `ex-<review_exempted 事件 seq>`；其余 null；
 *  - `由`：**真实**采纳人主体 id（旧账里是当时的执行者，绝不伪造成 Lead）；
 *  - `于` / `代`：采纳时间与节点代；
 *  - `需Lead确认: true`：旧账「复核即采纳」且当时执行者不是 Lead/主权者 —— 前向不得作
 *    新依赖依据、不得结账；Lead `task_accept`（不带票）补一条确认后消失。
 *
 * @param {object|null} node 任务节点投影
 * @returns {boolean}
 */
export function 已被合法采纳(node) {
  if (!node || node.需Lead确认 === true) return false;
  if (node.状态 !== '已采纳' && node.状态 !== '已结账') return false;
  return Boolean(node.采纳 && 采纳依据集.includes(node.采纳.依据));
}

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
  // accept（补修K · 2026-10-18 · 主权者条目4「采纳权在 Lead」）：采纳是 Lead 的**独立一步**，
  // 复核结论只是可引用票。主要从「已交卷」出发；「未验」也留一格——复核先判未验、补材料后
  // 再核出「过」时，当前代最后结论已是过，票不该因为状态停在未验而变成死胡同。
  // 「已采纳」只留一条路——旧账「复核即采纳」且当时执行者不是 Lead/主权者的节点，由 Lead
  // 补一条显式确认（不删旧行、不伪造旧签名）。
  accept: ['已交卷', '未验', '已采纳'],
  // reassign（task-机制缺口-10th0 · 裁决③ · 2026-10-13）：改派负责人。
  // 只许在「待派发 / 已派发」改——执行中改派会让「谁在干活」与已交的作业归属脱钩，
  // 交卷后改派会洗掉「谁交的卷」。负责人实例消亡 ⇒ 只能重建节点的死路由此打通。
  reassign: ['待派发', '已派发'],
  // exemptReview：复核豁免登记。豁免是**标记**不是状态转移，
  // 任何非终态可挂（与 attach 同格）——待决中的提名也可就地豁免（裁决 = 不复核）。
  exemptReview: ['待派发', '已派发', '执行中', '已交卷', '未验', '已打回', '待决'],
  // bind（v2 口述收敛 2026-10-18 条目11）：把**实例**绑到节点。负责人仍是岗位名 / 派活对象，
  // 实例单独记在 `绑定` 里——修前 member_spawn 用 reassign 把负责人覆盖成实例 id，等于把
  // 「这一岗」换成「这一人」，一岗多实例与换人重跑都无法表达。绑在排兵阶段（待派发 / 已派发）。
  bind: ['待派发', '已派发'],
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
  const 名单 = 负责人实例名单(node);
  const 已交 = (node?.独立答案 ?? []).map((a) => a.成员);
  return Boolean(node) && node.状态 === '已交卷' && 名单.length > 0 && 名单.every((r) => 已交.includes(r));
}

/**
 * 节点的「负责人实例名单」——**唯一源**（v2 条目11，2026-10-18 补修）。
 *
 * 负责人保留**岗位名**（「这一岗」），真执行者在 `绑定`（实例）。于是判「谁在干」
 * 必须按已绑实例；历史节点没有 `绑定` 才退回负责人名单（旧账只读不迁移，口径不变）。
 *
 * 三个消费者必须共用这一把尺（各写一份就会漂，漂了就是一侧放行一侧拒）：
 *  - `全员已交`：齐卷按已绑实例逐人核对；
 *  - `review` 冲突排除（锁外 + 锁内）：**已绑执行者**——哪怕他还没亲自交卷——
 *    同样不得复核本节点；
 *  - 外层 scope / 父判等按「执行者是谁」判的地方（导入本函数，不要另拍一份）。
 *
 * @param {object|null|undefined} node 任务节点投影
 * @returns {string[]} 实例 id 名单（无绑定 ⇒ 退回负责人名单）
 */
export function 负责人实例名单(node) {
  if (!node) return [];
  const 绑定 = node.绑定 ?? [];
  if (绑定.length > 0) return 绑定.map((b) => String(b?.实例 ?? '')).filter(Boolean);
  return (node.负责人 ?? []).map((x) => String(x ?? '')).filter(Boolean);
}

/**
 * 会审已退出任务图：读面不得继续输出写闸恒拒的历史节点操作。
 * @param {object|null|undefined} node 任务图折叠节点
 * @returns {boolean} 是否受旧会审整体只读合同保护
 */
export function 是只读旧会审(node) {
  return node?.模式 === '独立会审';
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
   * @param {{ subject: object, 描述: string, 负责人: string|string[], 判据: string|string[], 依赖?: string[], 复核对象?: string|string[], 项目: string }} input
   *   `复核对象`（v2 条目6/18）：复核任务的**显式目标引用**（被验节点 id 列表）。
   *   刻意不复用 `依赖`——依赖是「先做谁」，复核对象是「验哪一单」，混用会因依赖须前置
   *   已采纳而让「被复核节点已交卷→复核任务才能派发」的死锁出现。
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
    const 复核对象 = [...new Set(normalizeList(input.复核对象))];

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
      // 空列表不落键：新节点不背「模式/复核对象空壳」，历史账本照原字节保留。
      ...(复核对象.length > 0 ? { 复核对象 } : {}),
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
          this.#assertReviewObjects(复核对象, id, fold(rows));
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
    const 复核对象 = 复核对象引用(node);
    const { 节点 } = await this.#append(
      spec.项目,
      // v2 条目6：派发时把复核对象**冻结一份快照**进事件流——派发后读域以事件流可判，
      // 事后补绑也照样留痕（bound 事件），历史账本不改。
      { kind: 'dispatched', id, 判据冻结: true, ...(复核对象.length > 0 ? { 复核对象 } : {}) },
      spec.subject,
      '状态变更',
      null,
      async (nodeInLock) => {
        // 自领判定依赖真实绑定，必须与落线共用账本锁，不能拿锁外旧绑定放行。
        if (!nodeInLock || nodeInLock.状态 !== '待派发') {
          throw new Denied('任务图 · 状态机', `节点 ${id} 在锁内已推进为 ${nodeInLock?.状态 ?? '不存在'}，不能重复派发。`, { howToChange: '只对「待派发」的节点派发。' });
        }
        await this.policy.check({
          subject: spec.subject,
          action: 'dispatch',
          target: { id, kind: '任务', authority: '自治', zone: '私有', project: spec.项目 },
          context: { task: nodeInLock },
        });
        await this.#assertOwnersSeated(nodeInLock.负责人, spec.subject, '派发');
      },
    );
    return 节点;
  }

  /** @param {string} id @param {{ subject: object, 项目: string }} spec */
  async start(id, spec) {
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'start');
    await this.#checkWrite(id, node, spec, 'start');
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
    let 旧负责人;
    const { 节点: after } = await this.#append(
      spec.项目,
      { kind: 'reassigned', id, 负责人 },
      spec.subject,
      '状态变更',
      null,
      async (nodeInLock) => {
        if (!['待派发', '已派发'].includes(nodeInLock?.状态)) {
          throw new Denied('任务图 · 状态机', `节点 ${id} 在锁内已推进为 ${nodeInLock?.状态}，不能执行 reassign（允许的状态：待派发 / 已派发）。`, {
            howToChange: '主干环路的次序是 受理→定判据→派发→执行→交卷→复核→采纳/打回；按当前状态选下一步动作。',
          });
        }
        await this.#checkWrite(id, { ...nodeInLock, 负责人 }, spec, 'reassign');
        await this.#assertOwnersSeated(负责人, spec.subject, '改派');
        旧负责人 = nodeInLock.负责人 ?? [];
      },
    );
    return { ...after, 改派: { 从: 旧负责人, 到: 负责人 } };
  }

  /**
   * 绑定（v2 口述收敛 2026-10-18 条目6/11）。
   *
   * 两件事共用这一个入口，因为两者都是「排兵阶段的事实登记」（都只许 Lead、都在
   * 待派发/已派发、都入事件流与审计）：
   *  - **绑定实例**：负责人 = 岗位名（「这一岗」），`绑定` = 实例（「此刻谁在干」）。
   *    `member_spawn` 起实例后绑它，**不改负责人**；判「全员已交」、任务内全权、
   *    复核冲突排除都按已绑实例算。
   *  - **补绑复核对象**：把复核任务的显式 `复核对象`（被验节点 id 列表）登记/补齐。
   *    给「历史任务没有结构化复核对象」留一条**受审计的显式正门**（W7 那条审计任务），
   *    绝不从任务书自由文本猜、绝不复用 `依赖`（见 create 的 JSDoc：依赖会有派发死锁）。
   *
   * @param {string} id
   * @param {{ subject: object, 项目: string, 实例?: string, 岗位?: string, 复核对象?: string|string[] }} spec
   */
  async bind(id, spec) {
    if (!['Lead', '主权者'].includes(spec.subject?.kind)) {
      throw new Denied('任务图 · 绑定仅 Lead', `绑定是排兵动作（把实例/复核对象登记到节点上）：${spec.subject?.kind ?? '未知'} 没有这只手。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 经 member_spawn（自动绑定实例）或显式绑定执行。',
      });
    }
    const 实例 = String(spec.实例 ?? '').trim();
    const 岗位 = String(spec.岗位 ?? '').trim();
    const 复核对象 = [...new Set(normalizeList(spec.复核对象))];
    if (Boolean(实例) !== Boolean(岗位)) {
      throw new InvalidBody('实例与岗位必须成对给出：实例的权只来自岗位，绑定不能只写一半。', { missing: [!实例 ? '实例' : '岗位'] });
    }
    if (!实例 && 复核对象.length === 0) {
      throw new InvalidBody('绑定需要「实例」+「岗位」，或「复核对象」：前者把实例绑到节点上，后者给复核任务补显式被验目标。', { missing: ['实例', '复核对象'] });
    }
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'bind');
    const 于 = this.clock.iso();
    const 绑定 = 实例 ? { 实例, 岗位, 于 } : null;
    const event = { kind: 'bound', id, ...(绑定 ? { 绑定 } : {}), ...(复核对象.length > 0 ? { 复核对象 } : {}) };
    const { 节点 } = await this.#append(
      spec.项目,
      event,
      spec.subject,
      '状态变更',
      null,
      async (nodeInLock, rows) => {
        if (!['待派发', '已派发'].includes(nodeInLock?.状态)) {
          throw new Denied('任务图 · 状态机', `节点 ${id} 在锁内已推进为 ${nodeInLock?.状态}，不能绑定（允许的状态：待派发 / 已派发）。`, {
            howToChange: '绑定要在排兵阶段：执行中起绑会把「谁在干」与已交的作业归属脱钩。',
          });
        }
        // 座次与候选绑定在同一把锁内核对，避免排队期间改派导致绑定跨岗。
        if (this.registry && 实例) {
          const identity = await this.registry.identity();
          const member = identity?.members?.[实例];
          if (!member || member.status !== '在岗') {
            throw new Denied('任务图 · 绑定实例必须在册在岗', `实例 ${实例} 在身份档案里${member ? `状态为 ${member.status}` : '没有登记'}：绑定只能指向真实在岗的实例。`, {
              requireAuthority: 'Lead',
              howToChange: '先 registry_assign 登记该实例（或经 member_spawn 起实例自动绑定），再绑定。',
              detail: { 实例 },
            });
          }
          if (member.岗位 !== 岗位) {
            throw new Denied('任务图 · 绑定岗位必须与档案一致', `实例 ${实例} 的档案岗位是「${member.岗位}」，本次绑定声明「${岗位}」：实例的权只来自档案里的岗位，绑定不许另说一个。`, {
              requireAuthority: 'Lead',
              howToChange: `按档案岗位绑定（岗位=${member.岗位}）；要换岗走 registry_seal → registry_assign。`,
              detail: { 实例, 档案岗位: member.岗位, 声明岗位: 岗位 },
            });
          }
          const 负责人 = nodeInLock.负责人 ?? [];
          if (负责人.length > 0 && !负责人.includes(实例) && !负责人.includes(岗位)) {
            throw new Denied('任务图 · 绑定岗位必须与节点负责人对得上', `节点 ${id} 的负责人是 ${负责人.join('、')}，与绑定的岗位「${岗位}」/实例 ${实例} 都不匹配：绑定是「这一岗此刻谁在干」，不能挂到别的岗上。`, {
              requireAuthority: 'Lead',
              howToChange: '先 task_reassign 把负责人改成本岗（或本次实例），再绑定。',
              detail: { 实例, 岗位, 负责人 },
            });
          }
        }
        this.#assertReviewObjects(复核对象, id, fold(rows));
        // 候选投影复用真实事件折叠，不由动作入参提供自领或绑定上下文。
        const 候选 = fold([...rows, event]).get(id);
        await this.#checkWrite(id, 候选, { ...spec, 实例 }, 'bind');
      },
    );
    return 节点;
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
    await this.#checkWrite(id, node, spec, 'submit');
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
   * 「未验」既不等于通过，也不计打回。署名恒为**实际执行者本人**（v2 补修：禁止代签，
   * 含 Lead；Lead 独立验收就签自己，不占别人的名）。
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
    const 主体id = String(spec.subject?.id ?? '');
    const 复核者id = String(spec.复核者 ?? 主体id);
    const 撞人 = (node.独立答案 ?? []).some((a) => String(a.成员) === 复核者id) ? 复核者id : null;
    if (撞人) {
      throw new Denied('任务图 · 交卷人不得复核自己的卷（§3.4 提审分离）', `复核者 ${撞人} 在本节点的独立答案里：交卷人复核自己的卷 = 给自己发合格证。`, {
        howToChange: '由未参与交卷的主体执行 task_review（复核员或 Lead/主权者）；交卷人有异议走返工环路（review 不过 → task_start 重做）。',
      });
    }
    // v2 条目2/11：执行者同样不得复核本任务——判据是**负责人实例名单**（绑定优先、
    // 历史负责人回落，单源 负责人实例名单）。哪怕这个已绑执行者还没有亲自交卷
    // （别人代交 / 一岗多人里只交了一部分），他依然参与了产出，独立性一样破。
    if (负责人实例名单(node).includes(复核者id)) {
      throw new Denied('任务图 · 负责人不得复核自己的任务（v2 冲突排除）', `复核者 ${复核者id} 是节点 ${id} 的负责人：执行者复核自己的任务 = 自己验收自己。`, {
        howToChange: '由 Lead 用 member_spawn 起一位与本节点无关的复核员实例复核；该实例用完即封存。',
      });
    }
    // 署名 = 实际操作者（v2 补修 · 真实署名）：任何主体都不能借 `复核者` 字段替别人署名
    // （含 Lead 代签）。修前「只在 署名≠主体 时判 + Lead 例外」既留下任意字符串署名，
    // 也留下「换成自己 id 就绕过」的假署名旁路——这里对**所有 kind** 一律判。
    // 放在冲突排除之后：负责人/交卷人撞名时给出更具体的那条拒绝（两条都硬拒）。
    if (复核者id !== 主体id) {
      throw new Denied('任务图 · 复核署名必须是实际操作者（v2 · 禁止代签）', `署名复核者 ${复核者id || '（空）'} 与执行主体 ${主体id || '（空）'} 不一致：复核结论的署名就是真正下单的那位，不许替别人署名（Lead 也不例外）。`, {
        requireAuthority: 'Lead',
        howToChange: '由复核者本人执行 task_review（复核者参数可省略，恒取真实主体）；Lead 要独立验收就自己签自己（不占别人的名）。',
        detail: { 复核者: 复核者id || null, 实测主体: 主体id || null },
      });
    }
    await this.policy.check({
      subject: spec.subject,
      action: 'review',
      target: { id, kind: '任务', authority: '自治', zone: '私有', project: spec.项目 },
      context: {},
    });
    // v2 条目2/6 · 真实署名：成员复核员必须是「真在册在岗复核岗 + 真绑定了一条把本节点
    // 列为复核对象的复核任务」；Lead/主权者独立验收不走这条（结构身份，冲突排除已判）。
    await this.#assertReviewerEvidence(id, 复核者id, spec.项目, spec.subject);
    // 补修K（2026-10-18 · 主权者条目4「采纳权在 Lead」）：复核**只出可引用结论**，不推进状态。
    // 修前「过」直接写 状态:已采纳 —— 复核者一句话替 Lead 完成了采纳，账上却没有采纳人/
    // 所引用票/同任务代（独立审计 A/W5 用真实状态证实的缺口）。现在「过」只留票、节点停在
    // 原状态（已交卷/未验），采纳必须走 `accept()`（Lead 显式、引用本票）。
    // 「不过」仍落 已打回（随后 reject 再写 rejected 并关闭当前代）；「未验」仍落 未验。
    const 状态 = spec.三态 === '不过' ? '已打回' : spec.三态 === '未验' ? '未验' : null;
    const 事件 = {
      kind: 'reviewed',
      id,
      三态: spec.三态,
      ...(状态 ? { 状态 } : {}),
      分歧清单: spec.分歧清单 ?? [],
      反例面: spec.反例面 ?? [],
      复核者: 复核者id,
      算通过: spec.三态 === '过',
      计打回: spec.三态 === '不过',
    };
    const { 节点: reviewed } = await this.#append(
      spec.项目,
      事件,
      spec.subject,
      '状态变更',
      // 代必须在**锁内**取：票要连同「本任务 · 当前代」校验，锁外读的代会与并发打回竞态。
      (nodeInLock) => ({ ...事件, 代: nodeInLock?.代 ?? 1 }),
      this.#提审分离Guard(id, 'review', 复核者id),
    );
    if (spec.三态 === '不过') await this.reject(id, { subject: spec.subject, 项目: spec.项目, 理由: `复核不过：${(spec.分歧清单 ?? []).join('；') || '未给分歧清单'}` });
    // 打回路径下 reject 又写了一条事件：返回它折出来的最新节点才是真读数。
    return spec.三态 === '不过' ? this.get(id, { 项目: spec.项目 }) : reviewed;
  }

  /**
   * 复核署名的**证据闸**（v2 口述收敛 2026-10-18 条目2/6/18 的补修）。
   *
   * 两条都要，缺一条就只是「账上有个名字」：
   *  ① **人真**：署名的复核者在身份档案里在岗，且岗位就是「复核员」（普通成员没有复核权）；
   *  ② **关联真**：存在一条**绑定着这个实例**的复核任务，且该任务的显式 `复核对象`
   *     含本次被复核节点。复核实例绑的是它自己的复核任务，不是被复核业务节点。
   *
   * 为什么关联载体必须是独立 `复核对象` 而不是 `依赖`：依赖的语义是「先做谁」，
   * 若拿它表达「验哪一单」，就必须等被复核节点先被采纳才能派复核任务——而采纳又
   * 等复核结论，闭环死锁。这条判据与 create 的 #assertReviewObjects 同源。
   *
   * Lead / 主权者不走这条：Lead 的独立验收权来自结构身份（卡里含 review-run），
   * 不能被「普通复核员岗」变成独占审查权；冲突排除仍在上方与锁内各判一次。
   *
   * @param {string} 被复核节点
   * @param {string} 复核者id
   * @param {string} 项目
   * @param {object} subject
   */
  async #assertReviewerEvidence(被复核节点, 复核者id, 项目, subject) {
    if (!subject || ['Lead', '主权者'].includes(subject.kind)) return;
    if (subject.kind !== '成员' || subject.roleId !== '复核员') {
      throw new Denied(
        '任务图 · 复核只属复核员岗 / Lead / 主权者（v2 条目1/2）',
        `${subject.id}（${subject.kind}${subject.roleId ? `/${subject.roleId}` : ''}）不是复核员岗：普通成员只有执行权，复核是独立于执行的那只眼，必须由复核员岗实例或 Lead/主权者执行。`,
        {
          requireAuthority: 'Lead',
          howToChange: '由 Lead 用 member_spawn 起一位「复核员」岗实例（附复核任务、把被复核节点列进复核对象）再复核。',
          detail: { 主体: subject.id, kind: subject.kind, roleId: subject.roleId ?? null },
        },
      );
    }
    // ① 人真：装配面 org.js 恒注入 registry；直接构造的夹具退位（与 bind 同口径）。
    if (this.registry) {
      const member = (await this.registry.identity())?.members?.[复核者id];
      if (!member || member.status !== '在岗') {
        throw new Denied(
          '任务图 · 复核署名必须是真实在册在岗复核实例（v2 条目2）',
          `署名复核者 ${复核者id} 在身份档案里${member ? `状态为 ${member.status}` : '没有登记'}：不接受把复核结论记到一个不存在或不在岗的实例上。`,
          {
            requireAuthority: 'Lead',
            howToChange: '先 registry_assign 登记该复核实例（或经 member_spawn 自动登记），再执行复核。',
            detail: { 复核者: 复核者id, 被复核节点 },
          },
        );
      }
      if (member.岗位 !== '复核员') {
        throw new Denied(
          '任务图 · 复核署名必须是复核员岗（v2 条目2）',
          `署名复核者 ${复核者id} 的档案岗位是「${member.岗位}」，不是「复核员」：普通岗位实例不得复核任务。`,
          {
            requireAuthority: 'Lead',
            howToChange: '由 Lead 起一位「复核员」岗实例复核；要换岗走 registry_seal → registry_assign。',
            detail: { 复核者: 复核者id, 档案岗位: member.岗位, 被复核节点 },
          },
        );
      }
    }
    // ② 关联真：复核任务 = 绑定含本实例、且显式复核对象含被复核节点的节点（不能是它自己）。
    const 关联 = (await this.list({ 项目 })).filter(
      (n) => String(n.id) !== String(被复核节点)
        && (n.绑定 ?? []).some((b) => String(b?.实例 ?? '') === 复核者id)
        && 复核对象引用(n).includes(String(被复核节点)),
    );
    if (关联.length === 0) {
      throw new Denied(
        '任务图 · 复核实例缺本任务关联（v2 条目6）',
        `复核者 ${复核者id} 没有被绑到任何「复核对象含 ${被复核节点}」的复核任务上：没有真实关联的署名，只是一串名字。复核对象是显式引用（不是依赖、不是任务书自由文本）。`,
        {
          requireAuthority: 'Lead',
          howToChange: `建一条复核任务（负责人=复核员，create 时带 复核对象=['${被复核节点}']），member_spawn 起复核实例后 task_bind 绑上去；历史任务可在待派发/已派发用 task_bind 只补 复核对象。`,
          detail: { 复核者: 复核者id, 被复核节点 },
        },
      );
    }
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
    const 事件 = { kind: 'review_exempted', id, 豁免原因: spec.原因 ?? '' };
    const { 节点 } = await this.#append(
      spec.项目,
      事件,
      spec.subject,
      '状态变更',
      // 免审依据也带代（补修K）：打回关代之后，旧豁免不再给新代当采纳依据。
      (nodeInLock) => ({ ...事件, 代: nodeInLock?.代 ?? 1 }),
      this.#transitionGuard(id, 'exemptReview'),
    );
    return 节点;
  }

  /**
   * 正式采纳（补修K · 2026-10-18 · 主权者条目4「采纳权在 Lead」+ 条目20「不立统一授权模型」）。
   *
   * 为什么要独立一步：修前 `review(过)` 直接把节点写成「已采纳」——复核结论一句话就完成
   * 采纳，账上没有任何「谁采纳、凭什么、引用了哪张票」。主权者原意是**采纳权在 Lead**：
   * 复核者给的是**可引用的结论**，Lead 才做采纳；Lead 可记录不同意，但不许改结论。
   *
   * 三条合法依据（其余一律拒，且**零写入**）：
   *  - `票`：本任务**当前代**最后一条 `reviewed(过)` 的 `rv-<seq>`，且票之后**没有再改
   *    被验成果**（新交卷 / 非读根的产出物挂载 —— 复核过的是旧成果，就不是这单的票）；
   *  - 免审：节点有本代 `review_exempted` 记录且部署设置「复核免审」开关当前为开；
   *  - 历史确认：**旧账**里「复核即采纳」但当时执行者不是 Lead/主权者的节点——补一条显式
   *    确认（不删旧行、不改旧签名；确认人就是这次真实执行的 Lead）。
   *
   * 边界：
   *  - 仅 Lead / 主权者（普通成员、复核岗都没有这只手）；
   *  - 不改票、不改冻结判据（事件里没有 三态/复核者/判据 字段；判据冻结闸再挡一次 判据）；
   *  - 并发安全：预判在锁外给可读理由，锁内按最新折叠视图**复判**三路同源，第二个并发
   *    采纳会被状态机挡住——不会重复落 accepted 事件。
   *
   * @param {string} id
   * @param {{ subject: object, 项目: string, 票?: string, 依据?: string }} spec
   * @returns {Promise<object>} 采纳后的节点投影（含 `采纳` 字段）
   */
  async accept(id, spec) {
    if (!['Lead', '主权者'].includes(spec.subject?.kind)) {
      throw new Denied('任务图 · 采纳仅 Lead（补修K · 条目4 采纳权在 Lead）', `采纳是 Lead 的动作：${spec.subject?.kind ?? '未知'} 没有这只手。复核结论只是可引用票，不代 Lead 采纳。`, {
        requireAuthority: 'Lead',
        howToChange: `由 Lead 执行 task_accept（id=${id} 票=<task_review 回执里的 rv-N>）；免审采纳与历史确认不带票。`,
      });
    }
    const node = await this.#require(id, spec.项目);
    // 终态只读（补修K）：已结账的旧账不复活——采纳/确认都不许把它写回环路。
    if (node.状态 === '已结账') {
      throw new Denied('任务图 · 状态机', `节点 ${id} 已是终态「已结账」：旧账不复活，不能采纳/确认。`, {
        howToChange: '已结账节点只能追加更正；需继续产出请另立节点。',
      });
    }
    const 票 = String(spec.票 ?? '').trim();
    // 票的形态必须可判（内部字段不能当指路）：task_review 回执与工作台都给出真票。
    if (票 && !/^rv-\d+$/.test(票)) {
      throw new InvalidBody(`采纳票格式不对（收到「${票}」）：票是任务账本里 reviewed 事件的可引用 id，形如 rv-12。`, { missing: ['票'] });
    }
    const 免审开 = this.policy?.reviewExemptAllowed?.() === true;
    let 依据;
    if (票) {
      // 未验也收：补材料后再核出「过」是合法路径，当前代最后结论已是过（票由 fold 派生，
      // 下面 待采纳.票 才是唯一判据；状态只是门面，不能让它把有效票变成死胡同）。
      if (!['已交卷', '未验'].includes(node.状态)) {
        throw new Denied('任务图 · 状态机', `节点 ${id} 当前状态为 ${node.状态}，不能采纳（引用票的采纳只对「已交卷/未验」）。`, {
          howToChange: '采纳只对交卷后待验收的节点：先复核出票；已采纳的节点不重复采纳。',
          detail: { 状态: node.状态, 票 },
        });
      }
      if (node.待采纳?.票 !== 票) {
        throw new Denied('任务图 · 采纳票不是本任务当前代的有效过票（补修K）', `票 ${票} 对节点 ${id} 不成立：当前有效票=${node.待采纳?.票 ?? '无'}（最近复核=${node.最近三态 ?? '无'}，代=${node.代 ?? 1}）。票之后有新交卷/新产出物挂载、或复核已被覆盖时，旧票作废。`, {
          requireAuthority: 'Lead',
          howToChange: '按当前有效票采纳（工作台「待采纳」给的 rv-N）；票已作废就重新复核出票。',
          detail: { 提交的票: 票, 当前有效票: node.待采纳?.票 ?? null, 最近三态: node.最近三态 ?? null, 代: node.代 ?? 1 },
        });
      }
      依据 = '复核结论';
    } else if (node.状态 === '已采纳' && node.需Lead确认 === true) {
      // 旧账「复核即采纳」但当时执行者不是 Lead/主权者：Lead 补显式确认（不改旧签名）。
      依据 = '历史确认';
    } else if (node.状态 === '已交卷' && node.复核豁免 && 免审开) {
      依据 = '复核免审';
    } else {
      throw new Denied('任务图 · 采纳缺合法依据（补修K · 条目4）', `节点 ${id} 没有可采纳的依据：过票=${node.待采纳?.票 ?? '无'}（状态=${node.状态}，最近复核=${node.最近三态 ?? '无'}），免审开关=${免审开 ? '开' : '关'}、豁免记录=${node.复核豁免 ? '有' : '无'}。没有「过」不得采纳，「未验」也不得采纳。`, {
        requireAuthority: 'Lead',
        howToChange: `先 task_review（三态=过）出真票，再 task_accept id=${id} 票=rv-N；免审路径要先 review_exempt 且部署「复核免审」为开；旧账节点走不带票的显式确认。`,
        detail: { 状态: node.状态, 待采纳票: node.待采纳?.票 ?? null, 最近三态: node.最近三态 ?? null, 复核豁免: node.复核豁免 ?? null, 免审开关: 免审开 },
      });
    }
    await this.#checkWrite(id, node, spec);
    const 事件 = {
      kind: 'accepted',
      id,
      状态: '已采纳',
      // 只引用，不重签：免审引豁免事件；复核结论/历史确认沿用真票（旧确认沿用旧行上的票）。
      票: 依据 === '复核免审' ? null : (票 || node.采纳?.票 || null),
      依据,
      豁免: 依据 === '复核免审' ? (node.复核豁免?.票 ?? null) : null,
      ...(typeof spec.依据 === 'string' && spec.依据.trim() ? { 采纳说明: spec.依据.trim() } : {}),
    };
    const { 节点 } = await this.#append(
      spec.项目,
      事件,
      spec.subject,
      '状态变更',
      (nodeInLock) => ({ ...事件, 代: nodeInLock?.代 ?? 1 }),
      (nodeInLock) => {
        // 锁内复判（并发：锁外过的票/豁免可能在拿号到落笔之间被新交卷、打回或开关关闭作废）
        if (!nodeInLock) throw new InvalidBody(`没有这个任务节点：${id}（在锁内折叠视图中不存在）`);
        if (依据 === '历史确认') {
          if (!(nodeInLock.状态 === '已采纳' && nodeInLock.需Lead确认 === true)) {
            throw new Denied('任务图 · 历史采纳确认已不适用（补修K）', `节点 ${id} 在锁内已不是「历史自动采纳待确认」（状态=${nodeInLock.状态}，需Lead确认=${nodeInLock.需Lead确认 === true}）。`, {
              howToChange: '按当前状态选下一步；已有 Lead 采纳/确认的节点不重复确认。',
            });
          }
          return;
        }
        if (!['已交卷', '未验'].includes(nodeInLock.状态)) {
          throw new Denied('任务图 · 状态机（锁内复判）', `节点 ${id} 在锁内已推进为 ${nodeInLock.状态}，不能采纳（允许的状态：已交卷/未验）。`, {
            howToChange: '采纳只对交卷后待验收的节点；并发采纳只有第一条生效。',
          });
        }
        if (依据 === '复核结论' && nodeInLock.待采纳?.票 !== 票) {
          throw new Denied('任务图 · 采纳票已失效（锁内复判 · 补修K）', `票 ${票} 在锁内已不是节点 ${id} 当前代的有效过票（当前有效票=${nodeInLock.待采纳?.票 ?? '无'}）：票之后有新交卷/新产出物挂载，或复核已被覆盖。`, {
            howToChange: '重新复核出票后再采纳；不要借旧票采纳新成果。',
            detail: { 提交的票: 票, 当前有效票: nodeInLock.待采纳?.票 ?? null },
          });
        }
        if (依据 === '复核免审') {
          const 豁免 = nodeInLock.复核豁免;
          if (!豁免 || (豁免.代 != null && 豁免.代 !== (nodeInLock.代 ?? 1))) {
            throw new Denied('任务图 · 免审依据已失效（锁内复判 · 补修K）', `节点 ${id} 在锁内已没有本代复核豁免记录（豁免代=${豁免?.代 ?? '无'}，节点代=${nodeInLock.代 ?? 1}）：打回关代后旧豁免不再给新代当采纳依据。`, {
              howToChange: '重新 review_exempt 登记本代豁免，再 task_accept。',
            });
          }
          if (this.policy?.reviewExemptAllowed?.() !== true) {
            throw new Denied('任务图 · 复核免审开关已关闭（锁内复判 · 补修K）', '部署设置「复核免审」在锁内读为关：免审依据只在这个全局开关为开时成立。', {
              requireAuthority: '主权者',
              howToChange: '由主权者在 部署.json 打开「复核免审」并 policy_reload 后重试。',
            });
          }
        }
      },
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
   * @param {{ subject: object, 项目: string, 产出物: string, 读根?: boolean }} spec
   *   `读根: true` = **Lead/主权者授予复核员的文件读根**（复核任务上的源码目录/产物文件）。
   *   与成员自报的交付产物分开记：只有 `复核读根` 会进复核员 guard 的授权读根，
   *   `产出物引用` 本身只是交付引用，不授予文件读权限（避免成员自授权）。
   */
  async attach(id, spec) {
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'attach');
    if (spec.读根 === true && !['Lead', '主权者'].includes(spec.subject?.kind)) {
      throw new Denied('任务图 · 复核读根仅 Lead / 主权者可授予', `复核读根会让复核员能直读该文件/目录：${spec.subject?.kind ?? '未知'} 不能给自己或别人扩文件读域。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 用 task_attach（读根=true）在复核任务上附源码目录/产物文件；成员交付物照常 attach，但不作为复核读根。',
        detail: { 节点: id, 主体: spec.subject?.id ?? null },
      });
    }
    await this.#checkWrite(id, node, spec);
    const { 节点 } = await this.#append(
      spec.项目,
      { kind: 'artifact', id, 产出物: spec.产出物, ...(spec.读根 === true ? { 复核读根: true } : {}) },
      spec.subject,
      '状态变更',
      null,
      this.#transitionGuard(id, 'attach'),
    );
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
   * @param {(nodeInLock: object|null, rows: object[]) => void|Promise<void>} [inLockGuard] **锁内状态机复检**
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
        if (inLockGuard) await inLockGuard(node, rows);
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
    // 补修K：「历史自动采纳」的节点没有 Lead 承接，不得自动充任新依赖依据——
    // 依赖是「先做谁」，把未经 Lead 确认的成品当既成事实，会让下游一路继承旧账的空白签名。
    const 待确认 = 依赖.filter((d) => 节点.get(d)?.需Lead确认 === true);
    if (待确认.length > 0) {
      throw new Denied('任务图 · 历史自动采纳未确认不得作新依赖（补修K）', `依赖指向的节点 ${待确认.join('、')} 是旧账「复核即采纳」、未经 Lead 确认：前向不得自动把它当既成事实。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 先 task_accept id=<该节点>（不带票）补显式确认，再建依赖；或另立节点承接。',
        detail: { 待确认 },
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
   * 复核对象校验（v2 条目6/18）：目标必须是本项目**真实存在**的节点，且不能指向自己。
   *
   * 与依赖校验分开（同一理由见 create 的 JSDoc）：复核对象是「验哪一单」的引用，
   * 不参与「先做谁」的派发次序；两者共用一个字段就会互相污染。
   *
   * @param {string[]} 复核对象
   * @param {string} 新节点id
   * @param {Map<string, object>} 节点 锁内 fold 出来的节点表
   */
  #assertReviewObjects(复核对象, 新节点id, 节点) {
    if (复核对象.length === 0) return;
    const 自指 = 复核对象.filter((id) => id === 新节点id);
    if (自指.length > 0) {
      throw new InvalidBody(`复核对象不能是节点自己：${自指.join('、')}——自己复核自己等于没有复核。`, { missing: 自指 });
    }
    const 缺 = 复核对象.filter((id) => !节点.has(id));
    if (缺.length > 0) {
      throw new InvalidBody(`复核对象指向的节点不存在：${缺.join('、')}。复核对象是「验哪一单」的事实，指向空气的引用会让复核读域与冲突排除都悬空。`, {
        missing: 缺,
        detail: { 项目节点数: 节点.size, 已知节点: [...节点.keys()].slice(0, 20) },
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
  /**
   * 结账**只读计划**（v2 条目16 的单源；2026-10-18 单源收口）。
   *
   * 为什么要有它：结账的「候选 = 挂账经历 + 交卷知识候选」「处置归一」「晋升/丢弃/归档意图」
   * 原来只活在 `settle()` 里；审批步骤计划若在别处复刻一份，迟早会漂（漂了就是「批了 A
   * 却写 B」或「计划没覆盖、放行后又被下一道门卡住」）。现在两处消费**同一个结果**：
   *  - `settle()` 用它执行真实写；
   *  `lib/approval-plan.js` 用它摊审批步骤（不另算候选/处置/内容）。
   *
   * **只读**：不 append 事件、不 append 审计、不过策略闸、不产生知识条目；抛错也都是
   * 判定类（状态机/采纳确认/处置非法/内容/岗位缺失），失败不留下半截副作用。
   *
   * @param {string} id
   * @param {{ 项目: string, 记忆处置?: object }} spec
   * @returns {Promise<{
   *   节点: object,
   *   处置: object,
   *   候选清单: Array<{键: string, 类: string, 标题: string}>,
   *   判: Record<string, {处置: string, 岗位?: string, 标题?: string, 内容?: string}>,
   *   晋升计划: Array<{候选: object, 内容: string, 岗位: string, 标题?: string, 幂等键: string}>,
   *   丢弃: string[],
   * }>}
   */
  async settlePlan(id, spec = {}) {
    if (!this.memory) {
      throw new Fault('SETTLE_NO_MEMORY', '结账要归档作答，但装配时没把记忆服务接进任务图（org.js 的接线问题，不是调用问题）。');
    }
    const node = await this.#require(id, spec.项目);
    // 采纳谓词与状态机都在计划里先判（只读）：审批计划因此也不会为一单根本不能结账的节点
    // 造出待批准请求；执行侧再判一次是同一把尺，不会漂。
    this.#requireTransition(node, 'settle');
    if (node.需Lead确认 === true) {
      throw new Denied('任务图 · 历史自动采纳未经 Lead 确认，不得结账（补修K）', `节点 ${id} 的「已采纳」来自旧账「复核即采纳」（当时执行者 ${node.采纳?.由 ?? '未知'}，非 Lead/主权者）：结账会把它洗成 Lead 收口。`, {
        requireAuthority: 'Lead',
        howToChange: `先 task_accept id=${id}（不带票）补一条显式确认，或重新走本代复核+采纳，再结账。`,
        detail: { 采纳: node.采纳 ?? null },
      });
    }
    // 候选 = 挂账经历 + 交卷附的知识候选；交卷候选带交卷人的档案岗位（晋升默认适用岗位
    // 从「来源绑定岗位」推导，绝不贴成恰好在干这件活的记忆整理岗）。
    const 经历候选 = await this.memory.settleCandidates({ 项目: spec.项目, 任务: id });
    const 档案 = this.registry ? await this.registry.identity() : { members: {} };
    const 交卷候选 = [];
    for (const a of node.独立答案 ?? []) {
      (a.知识候选 ?? []).forEach((文本, i) => 交卷候选.push({
        键: `候选/${a.成员}/${i}`,
        成员: a.成员,
        内容: 文本,
        岗位: 档案.members?.[a.成员]?.岗位 ?? null,
      }));
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
    const 判 = this.#normalizeDispositions(处置, 候选清单);

    // 「晋升」= 真实知识产物。内容/岗位缺一即拒（只读阶段），执行侧不再各判一份。
    const 晋升计划 = [];
    for (const c of 候选清单) {
      if (判[c.键].处置 !== '晋升') continue;
      const 源 = c.类 === '经历' ? 经历候选.find((x) => x.id === c.键) : 交卷候选.find((x) => x.键 === c.键);
      const 内容 = 判[c.键].内容 ?? 源?.内容;
      if (!内容 || !String(内容).trim()) {
        throw new InvalidBody(`候选 ${c.键}（${c.类}「${c.标题}」）判「晋升」，但没有可蒸馏的正文：在处置里带 内容。`, { detail: { 候选: c.键 } });
      }
      const 岗位 = 判[c.键].岗位 ?? 源?.岗位 ?? (await this.#适用岗位(node, 档案));
      if (!岗位) {
        throw new InvalidBody(`候选 ${c.键}（${c.类}「${c.标题}」）判「晋升」，但取不到适用岗位：知识必须带岗位标签（谁能召回它）。在处置里显式给 岗位，例如 {"处置":"晋升","岗位":"插件工程"}。`, { detail: { 候选: c.键 } });
      }
      // 幂等键与 `memory.promoteFromAdopted` 的定义**同一口径**（来源项目|来源任务|候选键）：
      // 审批步骤的写标签、执行侧的幂等认回都靠它，两处漂了会被入口级真链测试当场抓住。
      晋升计划.push({ 候选: c, 内容: String(内容).trim(), 岗位, 标题: 判[c.键].标题 ?? (c.类 === '经历' ? 源?.标题 : undefined), 幂等键: `${spec.项目}|${id}|${c.键}` });
    }
    const 丢弃 = 经历候选.filter((c) => 判[c.id]?.处置 === '丢弃').map((c) => c.id);
    return { 节点: node, 处置, 候选清单, 判, 晋升计划, 丢弃 };
  }

  async settle(id, spec) {
    const node = await this.#require(id, spec.项目);
    this.#requireTransition(node, 'settle');
    // 补修K：旧账「复核即采纳」但没有 Lead 承接的节点，不得借结账洗成 Lead 收口——
    // 先显式 task_accept 确认（确认事件由真实 Lead 落笔，不把旧签名改成 Lead）。
    if (node.需Lead确认 === true) {
      throw new Denied('任务图 · 历史自动采纳未经 Lead 确认，不得结账（补修K）', `节点 ${id} 的「已采纳」来自旧账「复核即采纳」（当时执行者 ${node.采纳?.由 ?? '未知'}，非 Lead/主权者）：结账会把它洗成 Lead 收口。`, {
        requireAuthority: 'Lead',
        howToChange: `先 task_accept id=${id}（不带票）补一条显式确认，或重新走本代复核+采纳，再结账。`,
        detail: { 采纳: node.采纳 ?? null },
      });
    }
    await this.policy.check({
      subject: spec.subject,
      action: 'settle',
      target: { id, kind: '任务', authority: '自治', zone: '私有', project: spec.项目 },
      context: { task: node },
    });
    // 候选 / 处置归一 / 晋升与丢弃意图：**唯一规范化处**（`settlePlan`），这里只执行它算出的写。
    const 计划 = await this.settlePlan(id, spec);

    // 落笔：受限晋升（真实知识条目，幂等键 = 来源项目|任务|候选键）。知识写成功、结账事件
    // 之后失败 ⇒ 重试会按幂等键认回同一条产物，不会重复产知识；写失败 ⇒ 直接抛，不结账。
    const 记忆晋升 = {};
    for (const 晋升 of 计划.晋升计划) {
      const 产物 = await this.memory.promoteFromAdopted({
        subject: spec.subject,
        项目: spec.项目,
        岗位: 晋升.岗位,
        内容: 晋升.内容,
        标题: 晋升.标题,
        来源: `结账晋升：任务 ${id} 的${晋升.候选.类}「${晋升.候选.标题}」`,
        来源引用: [id, ...(晋升.候选.类 === '经历' ? [晋升.候选.键] : [])],
        晋升: { 来源任务: id, 候选键: 晋升.候选.键 },
        任务: node,
      });
      记忆晋升[晋升.候选.键] = 产物.id;
    }

    // 「丢弃」的机械含义 = 追加失效（不许改写只能追加——丢的是召回面，不是账本行）；
    // 「留账本」= 不动。
    for (const 键 of 计划.丢弃) {
      await this.memory.invalidate(键, { subject: spec.subject, 原因: `结账记忆处置：丢弃（节点 ${id}）` });
    }
    const 归档 = await this.memory.archiveAnswers({ 项目: spec.项目, 任务: id, subject: spec.subject });
    try {
      const { 节点 } = await this.#append(spec.项目, { kind: 'settled', id, 状态: '已结账', 归档条数: 归档.归档条数, 记忆处置: 计划.处置, ...(Object.keys(记忆晋升).length > 0 ? { 记忆晋升 } : {}) }, spec.subject, '结账', null, this.#transitionGuard(id, 'settle'));
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

  /**
   * 记忆处置的**形状归一**（v2 条目16 · 补修E）：值是「晋升 / 留账本 / 丢弃」字符串，
   * 或 `{ 处置: '晋升', 岗位?, 标题?, 内容? }`——后者是 Lead 的蒸馏参数（可选覆盖）。
   * 三条硬口径：① 必须逐条覆盖本任务候选；② 出现候选清单外的键就拒（笔误不许让某条
   * 候选被静默漏判）；③ 只有「晋升」能带蒸馏参数，其余处置带参数 = 声明不诚实。
   * @param {object} 处置
   * @param {Array<{键: string, 类: string, 标题: string}>} 候选清单
   * @returns {Record<string, {处置: string, 岗位?: string, 标题?: string, 内容?: string}>}
   */
  #normalizeDispositions(处置, 候选清单) {
    const 键集 = new Set(候选清单.map((c) => c.键));
    const 未知 = Object.keys(处置).filter((键) => !键集.has(键));
    if (未知.length > 0) {
      throw new InvalidBody(`记忆处置里出现未知候选键：${未知.join('、')}——只判本任务列出的候选（防止键名笔误让某条候选被漏判）。`, {
        missing: 未知,
        detail: { 候选清单 },
      });
    }
    const 结果 = {};
    for (const c of 候选清单) {
      const 原值 = 处置[c.键];
      const 规范 = typeof 原值 === 'string'
        ? { 处置: 原值 }
        : (原值 && typeof 原值 === 'object' && !Array.isArray(原值) ? 原值 : null);
      if (!规范 || !['晋升', '留账本', '丢弃'].includes(规范.处置)) {
        throw new InvalidBody(`记忆处置必须覆盖每条候选，值只认 晋升 / 留账本 / 丢弃（或 {处置:'晋升',岗位?,标题?,内容?}）。缺失或非法：${c.键}（${c.类}「${c.标题}」）。`, {
          missing: [c.键],
          detail: { 候选清单 },
        });
      }
      if (规范.处置 !== '晋升') {
        const 多余 = Object.keys(规范).filter((键) => 键 !== '处置');
        if (多余.length > 0) {
          throw new InvalidBody(`候选 ${c.键}（${c.类}「${c.标题}」）的处置是「${规范.处置}」，不能带 ${多余.join('、')}：只有「晋升」才有蒸馏参数（岗位/标题/内容）。`, { detail: { 候选: c.键, 多余 } });
        }
        结果[c.键] = { 处置: 规范.处置 };
        continue;
      }
      const 允许 = ['处置', '岗位', '标题', '内容'];
      const 未知键 = Object.keys(规范).filter((键) => !允许.includes(键));
      if (未知键.length > 0) {
        throw new InvalidBody(`候选 ${c.键} 的晋升参数里有未知键：${未知键.join('、')}（只认 岗位 / 标题 / 内容）。`, { detail: { 候选: c.键, 未知键 } });
      }
      for (const 键 of ['岗位', '标题', '内容']) {
        if (规范[键] !== undefined && (typeof 规范[键] !== 'string' || !规范[键].trim())) {
          throw new InvalidBody(`候选 ${c.键} 的晋升参数「${键}」必须是非空字符串。`, { detail: { 候选: c.键, 键 } });
        }
      }
      结果[c.键] = {
        处置: '晋升',
        ...(规范.岗位 !== undefined ? { 岗位: 规范.岗位.trim() } : {}),
        ...(规范.标题 !== undefined ? { 标题: 规范.标题.trim() } : {}),
        ...(规范.内容 !== undefined ? { 内容: 规范.内容.trim() } : {}),
      };
    }
    return 结果;
  }

  /**
   * 候选的默认**适用岗位**（知识双标签之一）：来源绑定岗位优先——交卷人的档案岗位、
   * 经历条目自带岗位，最后才退回任务负责人里在册的岗位名。
   * 为什么不能贴执行者之外的岗（尤其记忆整理）：工程经验挂在记忆整理名下，会被错误岗位召回。
   * @param {object} node 任务节点
   * @param {{ members?: Record<string, object> }} 档案 身份档案
   * @returns {Promise<string|null>}
   */
  async #适用岗位(node, 档案) {
    for (const 名 of node?.负责人 ?? []) {
      const 值 = String(名 ?? '');
      if (!值) continue;
      const 实例岗位 = 档案?.members?.[值]?.岗位;
      if (typeof 实例岗位 === 'string' && 实例岗位) return 实例岗位;
      if (!this.registry) continue;
      try {
        // 负责人写岗位名（v2 条目11）：在册岗位卡存在即视为岗位，而不是实例。
        if (await this.registry.get({ id: 值 })) return 值;
      } catch {
        // 坏卡/非法 id 按「不是岗位」处理：默认值推导不该因为一张坏卡炸掉结账。
      }
    }
    return null;
  }

  /** @param {object} node @param {keyof TRANSITIONS} op */
  #requireTransition(node, op) {
    // 旧独立会审节点整体只读（v2 条目18 补修）：会审已退出任务图，旧节点的答案/讨论子态
    // 是历史证据。闸装在这里 = 所有写路径共用一处（start/submit/review/pending/attach/
    // reassign/bind/exempt/settle 都先过它），不在每个方法里各抄一份。
    if (是只读旧会审(node)) {
      throw new Denied(
        '旧独立会审 · 只读历史（v2 条目18）',
        `节点 ${node.id} 是历史独立会审节点：会审已退出任务图，旧节点的答案/讨论子态只读，不再接受任何写入（${op}）。`,
        {
          howToChange: '新会审走 council 服务（debate_open / debate_answer / debate_say）；旧账只读，不改不迁移。',
          detail: { 节点: node.id, 操作: op },
        },
      );
    }
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
        // 负责人/执行者排除走**同一份**实例名单（绑定优先，历史负责人回落）：锁内复检
        // 不许另用一份旧口径（负责人在 v2 里是岗位名，只剩 `负责人.includes(id)` 会漏掉
        // 「已绑执行者但尚未亲自交卷」这一格）。
        const 执行者名单 = 负责人实例名单(nodeInLock);
        const 撞负责人 = ids.find((谁) => 执行者名单.includes(谁));
        if (撞负责人) {
          throw new Denied('任务图 · 负责人不得复核自己的任务（v2 冲突排除，锁内复检）', `复核者 ${撞负责人} 是节点 ${id} 的负责人（锁内最新折叠视图）：执行者复核自己的任务 = 自己验收自己。`, {
            howToChange: '由 Lead 用 member_spawn 起一位与本节点无关的复核员实例复核。',
          });
        }
      }
    };
  }

  /**
   * 任务写闸（所有节点写动作共用的唯一判定点）。
   *
   * `节点操作` 进判定上下文：策略引擎要按**具体操作**判边界（v2 条目11：复核实例只在自己
   * 绑定的复核节点上可有受限生命周期「开工 → 交卷报告」，别的写一步不放）。少了这一位，
   * 引擎只能看到「write」，于是要么误放、要么误拒——两种都会让边界失真。
   *
   * @param {string} id @param {object} node @param {{ subject: object, 项目: string }} spec
   * @param {'start'|'submit'|'bind'|'reassign'|'other'} [操作]
   */
  async #checkWrite(id, node, spec, 操作 = 'other') {
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id, kind: '任务', authority: '自治', zone: '私有', project: spec.项目 },
      context: { task: node, 节点操作: 操作, ...(操作 === 'bind' && spec.实例 ? { 实例绑定: true } : {}) },
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
  // 补修K 的票/成果进度：**投影内部记账**，不落成节点字段。
  //  - 最后复核：本节点最后一条 reviewed 的票/三态/代/序；
  //  - 最近改成果序：最后一次「改变被验成果」的事件序（新交卷 / 非读根的产出物挂载）。
  //    票之后若有它，票就作废——复核过的是旧成果，不能拿来采纳新成果。
  // 读根授权与异议不是成果，不进这条线。
  const 记账 = new Map();
  for (const [索引, row] of rows.entries()) {
    if (!row?.id || !row?.kind) continue;
    // 票 = rv-<seq>（seq 由 #append 分配）；无 seq 的旧行按位置补，仍可稳定引用。
    const 序 = Number.isInteger(row.seq) ? row.seq : 索引 + 1;
    let node = nodes.get(row.id);
    if (!node) {
      node = { id: row.id, 状态: '待派发', 打回次数: 0, 产出物引用: [], 复核经过: [], 代: 1, 答案历史: [] };
      nodes.set(row.id, node);
    }
    const 进度 = 记账.get(row.id) ?? {};
    记账.set(row.id, 进度);
    switch (row.kind) {
      case 'created':
        Object.assign(node, {
          描述: row.描述,
          负责人: row.负责人,
          判据: row.判据,
          依赖: row.依赖 ?? [],
          // v2 条目18：「模式」字段已删——新事件不再带它，投影也不许造 `模式: null` 空壳；
          // 历史事件里有值才折出（旧数据原地只读）。
          ...(row.模式 != null ? { 模式: row.模式 } : {}),
          // v2 条目6：显式复核对象引用（被验节点 id 列表）。没有就不落键。
          ...(Array.isArray(row.复核对象) && row.复核对象.length > 0 ? { 复核对象: [...new Set(row.复核对象.map(String))] } : {}),
          状态: '待派发',
          创建于: row.at,
          创建者: row.by?.id ?? null,
        });
        break;
      case 'dispatched':
        node.状态 = '已派发';
        node.判据冻结 = true;
        node.派发于 = row.at;
        // 派发事件里的复核对象是**冻结快照**（v2 条目6）：派发那一刻验哪一单可回放；
        // 之后补绑走 bound 事件，历史不改。
        if (Array.isArray(row.复核对象)) node.复核对象 = [...new Set(row.复核对象.map(String))];
        break;
      // 改派负责人（task-机制缺口-10th0）：名单整体替换，历史逐次留痕（谁改的、何时）。
      // 只在 待派发/已派发 态发生（写入面状态机守着），fold 不必再判——投影如实折事件流。
      case 'reassigned':
        node.负责人 = row.负责人;
        node.改派记录 = [...(node.改派记录 ?? []), { 负责人: row.负责人, 由: row.by?.id ?? null, 于: row.at }];
        break;
      case 'bound':
        // v2 条目11：同一实例重绑 = 覆盖它自己那条（换人重跑不叠历史），别的实例不受影响。
        if (row.绑定) {
          node.绑定 = [...(node.绑定 ?? []).filter((b) => b.实例 !== row.绑定?.实例), row.绑定];
        }
        // v2 条目6：bound 也可以只补/覆盖复核对象（受审计的显式正门，W7 补授权路径）。
        if (Array.isArray(row.复核对象)) node.复核对象 = [...new Set(row.复核对象.map(String))];
        break;
      case 'started':
        node.状态 = row.状态 ?? '执行中';
        break;
      case 'submitted': {
        node.状态 = row.状态 ?? '已交卷';
        进度.最近改成果序 = 序;
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
      case 'reviewed': {
        // 补修K：复核只出**可引用票**（rv-<seq>），不再自己推进到「已采纳」。
        // 只有「不过 / 未验」带状态（打回关代 / 窗口未关）；「过」不写状态，节点停在原状态。
        if (typeof row.状态 === 'string') node.状态 = row.状态;
        node.最近三态 = row.三态;
        const 票 = `${复核票前缀}${序}`;
        node.复核经过 = [...(node.复核经过 ?? []), {
          票,
          三态: row.三态,
          分歧清单: row.分歧清单,
          反例面: row.反例面,
          复核者: row.复核者,
          // 代随票落账：票只对**同一代**有效；老事件没有代 ⇒ null（历史事实不补造）。
          代: row.代 ?? null,
          于: row.at,
        }];
        进度.最后复核 = { 票, 三态: row.三态, 代: row.代 ?? (node.代 ?? 1), 序, 复核者: row.复核者, 于: row.at };
        // 旧账兼容（补修K）：修前的 reviewed(过) 事件自己写了 `状态:已采纳` —— 当时「复核即采纳」。
        // 不洗旧行（只增账本），但把事实标清：
        //  - 当时执行者是 Lead/主权者 ⇒ 那是**当时真实 Lead 行为**，算已确认（尊重历史，不伪造）；
        //  - 是成员（普通成员/复核岗）⇒ 需 Lead 显式确认，前向依赖/结账都不许自动使用。
        if (row.状态 === '已采纳') {
          const 复核人类型 = String(row.by?.kind ?? '未知');
          const 需确认 = !['Lead', '主权者'].includes(复核人类型);
          node.采纳 = {
            依据: '历史复核即采纳',
            票,
            豁免: null,
            由: row.by?.id ?? row.复核者 ?? null,
            复核人类型,
            于: row.at ?? null,
            代: row.代 ?? null,
            ...(需确认 ? { 需Lead确认: true } : {}),
          };
          if (需确认) node.需Lead确认 = true;
        }
        break;
      }
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
        node.复核豁免 = { 票: `${免审票前缀}${序}`, ...(row.授权引用 ? { 授权引用: row.授权引用 } : {}), 豁免原因: row.豁免原因 ?? '', 代: row.代 ?? null, 由: row.by?.id ?? null, 于: row.at };
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
        // v2 条目6：Lead/主权者明确授予的**复核读根**（与成员交付产物分开记，防自授权）。
        if (row.复核读根 === true) node.复核读根 = [...new Set([...(node.复核读根 ?? []), row.产出物])];
        // 补修K：非读根的产出物挂载**改变了被验成果** ⇒ 让已出的票作废（与「票后新交卷」同罪）。
        // 读根只是给复核员开文件读面、不改成果；异议更不改成果——两者都不算新证据。
        else 进度.最近改成果序 = 序;
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
        // 补修E：晋升产出的真实知识 id 一并折回——「判了晋升」与「升成了什么」分开记，
        // 读面能顺着 id 查知识正文与血缘（不靠结账事件里的一句声明自证）。
        if (row.记忆晋升) node.记忆晋升 = row.记忆晋升;
        // 补修K：旧账已结账的节点，结账本来就是 Lead 的动作（真实主体在事件行里）——
        // 视为 Lead 已承接，不再标「需确认」；不改旧签名，只把承接事实记进 确认 字段。
        if (node.需Lead确认 === true) {
          node.采纳 = { ...node.采纳, 需Lead确认: false, 确认: { 方式: '结账', 由: row.by?.id ?? null, 于: row.at ?? null } };
          delete node.需Lead确认;
        }
        break;
      // 采纳（补修K）：Lead 的独立动作。事件只引用票/豁免，**不带** 三态/复核者/判据（不重签、不改票）。
      case 'accepted':
        node.状态 = row.状态 ?? '已采纳';
        node.采纳 = {
          依据: row.依据 ?? '复核结论',
          票: row.票 ?? null,
          豁免: row.豁免 ?? null,
          由: row.by?.id ?? null,
          于: row.at ?? null,
          代: row.代 ?? (node.代 ?? null),
          ...(row.采纳说明 ? { 说明: row.采纳说明 } : {}),
        };
        // Lead 显式采纳/确认即承接：旧账「待确认」标记到此结束。
        delete node.需Lead确认;
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
  // 补修K · 派生「已过待 Lead 采纳」：只有**当前代**最后一条复核是「过」、且票之后没有
  // 再改被验成果（新交卷 / 非读根挂载）时才成立。工作台据此给**真票命令**——复核结论不代采纳。
  // 未验也收：复核先判未验、补材料后再核出「过」时，状态停在未验不等于这张过票失效。
  for (const node of nodes.values()) {
    const 进度 = 记账.get(node.id) ?? {};
    const 最后 = 进度.最后复核;
    if (['已交卷', '未验'].includes(node.状态) && 最后 && 最后.三态 === '过' && 最后.代 === (node.代 ?? 1) && 最后.序 > (进度.最近改成果序 ?? 0)) {
      node.待采纳 = { 票: 最后.票, 复核者: 最后.复核者 ?? null, 于: 最后.于 ?? null, 代: 最后.代 };
    }
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
