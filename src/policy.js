/**
 * 策略引擎（§7「唯一判定点」、§4 三档门槛与三权、§12 约束清单）。
 *
 * 四条不可让步的性质：
 *  1. **不能被绕过** —— 对象存储、记忆服务、任务图、消息总线全部经由 `check()` 才落盘。
 *  2. **fail-closed** —— 规则加载失败、主体未知、动作未知、无匹配规则，一律拒绝。
 *     §12.2 特别点名：「身份被停用/删除时，权限判定必须有确定答案（不许查不到 = 放行）」。
 *  3. **拒绝带可执行理由** —— 「哪条规则 + 改它要什么授权」，由 `Denied` 承载。
 *  4. **判定只读标签不读路径** —— 决策只看 `authority / kind / domain / zone / 编制`，
 *     不因为某个对象「放在自己家门口」就放行。
 *
 * 规则的三层来源，从强到弱：
 *  第一层 · 宪章不变式（硬编码，任何法律都改不动）—— 直接来自 §3「永不」与 §12 约束清单
 *  第二层 · 法律件里的机器可读授权块（`权限矩阵.md` 中的 ```policy 块）
 *  第三层 · 出厂默认值（介入度 / 响应期限 / 工具总范围）
 *  兜底   · 无匹配 ⇒ 拒绝
 */
import { stat } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { readTextOrNull, stripBom } from './kernel/fsx.js';
import { digest } from './kernel/text.js';
import { Denied, Fault, NeedsApproval } from './kernel/errors.js';
import { resolveResponseDeadline, evaluateSovereignPresence, BUILTIN_RESPONSE_DEADLINE_HOURS } from './kernel/time.js';
import { RULE_FILES, COUNCIL_THREAD_PREFIX, 线程等价键 } from './paths.js';
import { parseDocument, effectiveDocument, extractPolicyBlock } from './tags.js';
// v2 条目8：机制动作的**封闭清单**（系统主体的唯一权限面）。单源住 src/mechanism.js，
// 判定与"谁能拼系统主体"两件事都读它——不在本文件另抄一份清单。
import { MECHANISM_SUBJECT, MECHANISM_NAMES, mechanismAllows } from './mechanism.js';
// 条目10 补修J（2026-10-18 独立审计）：写前凭证闸要验**钉住卡的真实内容**（重算摘要 +
// 派生面重算），不能只认一个摘要字符串；读取/校验面只有 card-credential 一处。
import { readVerifiedCardSnapshot } from './card-credential.js';
// v2 条目14/17（2026-10-18 补修F）：主权者逐请求放行的**唯一读取点**。放行上下文只由
// 重放路径 `以放行上下文` 包住那一次调用（AsyncLocalStorage）；匹配按**步骤计划**
// （底层 动作+目标 kind/id）逐条消费，宏动作名不参与——本文件只读、不写。
import { 本次放行匹配, 本次放行可匹配 } from './intervention.js';
// 保留既有公开导出；解析实现只在tags.js，避免合并与求值各维护一份口径。
export { extractPolicyBlock } from './tags.js';

/** 动作的封闭清单。表外的动作 = 未知动作 = 拒绝（fail-closed）。 */
export const ACTIONS = [
  'read',
  'write',
  'create',
  'delete',
  'publish',
  'dispatch',
  'review',
  // settle（W3 批3·2026-10-09）：结账——环路最后一步，仅 Lead（见 #invariants 的守卫）。
  'settle',
  'approve',
  'seal',
  'revoke',
  'propose',
  'draft',
  'rollback',
  'forceUpdate',
  'experiment',
];

/** 主体种类的封闭清单（§2 主体表）。 */
// v2（口述收敛 2026-10-18 条目1/5）：复核者退出主体清单——复核员是普通岗位卡，
// 其约束由 #preGrantBoundary 按岗位名（roleId）判，不再占一个主体类。
export const SUBJECT_KINDS = ['主权者', '出厂作者', 'Lead', '成员', '系统'];

/**
 * 岗位名 → 主体种类（**唯一映射**，v2 条目8/20）。
 *
 * 为什么单源：不越授 / 不自授都问「这个岗位会造就什么主体」，
 * 注册表模块的 `subjectForRole` 与 `canTouch` 也在问同一件事。
 * 判据抄在哪个入口里，就只有那个入口受保护——所以映射只留这一处，registry 反过来 import 它。
 *
 * 封闭：只有三个名字映射到非成员种类；其余（含「复核员」与一切成员岗）⇒ 成员。
 * 表外的名字不会「升级」，因为本函数不给它们留猜的余地。
 *
 * @param {unknown} 岗位
 * @returns {'Lead'|'主权者'|'出厂作者'|'成员'}
 */
export function subjectKindForRole(岗位) {
  if (岗位 === 'Lead') return 'Lead';
  if (岗位 === '主权者') return '主权者';
  if (岗位 === '出厂作者') return '出厂作者';
  return '成员';
}

/**
 * 职权级（只用于「是不是同一级或更高」这一问，**不是**权限面比较）。
 *
 * 权限面的实际包含关系要有**真凭证**才判得出（本组织的缺口如实记在 `#不越授` 的注释里），
 * 这里只回答一个结构事实：成员 < Lead < {主权者, 出厂作者}。主权者与出厂作者不同域
 * （治理 / 出厂件），但在「不得由 Lead 造出来」这一点上同级——所以给同一个级。
 * 系统不属于任何岗位能造就的种类，单独给最高级（永远不会被当作被派主体）。
 */
const 职权级 = (kind) => ({ 成员: 1, Lead: 2, 主权者: 3, 出厂作者: 3, 系统: 4 })[kind] ?? 0;

/**
 * 职权级的外部读数（registry 算「不自授」的扩张集合时要用同一把尺）。
 * 只暴露这一问，不暴露判定本体——扩张集合的**比较**仍只有 registry 一处。
 * @param {string} kind
 * @returns {number}
 */
export function subjectRank(kind) {
  return 职权级(kind);
}

/** 介入度四档（§4），只影响自治档。 */
export const INTERVENTION = ['放权', '预审', '审批'];

/**
 * 运行态默认值键的**封闭清单**（白名单）：出厂件可以写任意给人看的文档键
 * （`说明` 之类），但只有这些键会进运行态。
 *
 * 为什么必须是白名单而不是黑名单：`说明` 被整份并入后会随 `/mind status` 与工作台
 * 序列化出去 —— 读的人分不清「这是文档」还是「这是一条生效的设置」；
 * 而黑名单永远漏一个（写个 `备注` / `note` / 中文的新叫法就绕过去了）。
 */
const RUNTIME_DEFAULT_KEYS = ['介入度', '失联限制', '响应期限小时', '工具总范围', '安全类', '披露敏感模式', '会审讨论', '岗位闲置天数', '复核免审'];

/**
 * 会审讨论段的预算默认值（W2 规格 2026-10-09）。
 * 私有 `部署.json` 的 `会审讨论` 键**部分覆盖**（缺的键用这里的默认），加载期校验：
 * 坏值（非对象 / 键非 ≥1 整数）⇒ 响亮抛错 ⇒ 引擎不健康（fail-closed，§3.6）。
 */
export const DEFAULT_DEBATE_BUDGET = { 轮次上限: 2, 人数上限: 8, 每轮消息上限: 24, 每人每轮字符上限: 4000 };

/**
 * 岗位闲置判定的天数阈值（派活闭环 · 2026-10-15 主权者拍板：14 天）。
 * 私有 `部署.json` 的 `岗位闲置天数` 键覆盖；**0 = 不判闲置**（只报原始读数：
 * 在岗实例数 / 最近派发于，由读者自己下结论）。加载期校验 ≥0 整数，坏值 fail-closed。
 */
export const DEFAULT_ROLE_IDLE_DAYS = 14;

const ALWAYS_INVARIANTS = '宪章 不可违背原则（§3 永不 + §12 约束清单）';

/**
 * 引擎实例。
 */
export class PolicyEngine {
  /** @type {Promise<boolean>|null} in-flight reload 的共享 Promise（并发合并为一次全量加载）。 */
  #inFlightReload = null;

  /**
   * 受控父判的重入闸（v2 条目20 · 不越授，2026-10-18）。
   *
   * 为什么是**实例私有字段**而不是 `context` 里的一个键：父判是「成员不得超出委派者权限面」
   * 的闸，若闸的开合由调用方传进来的 context 决定，模型侧任何能构造 context 的路径都能
   * 一次传参把闸关掉（上一版我用 `context.面求值` 旁路真实身份，就是这么错的）。
   * 私有字段只看「本次判定是否已经在父判里」，与入参无关 ⇒ 模型关不掉。
   */
  #父判中 = false;

  /**
   * R05（审查 2026-10-16）：在飞重载期间又有 reload() 进来时置位，在飞轮结束再补读一轮——
   * 修前的「共享 Promise 即完成」会把期间的档案写入吞进旧快照（丢 dirty）。
   * @type {boolean}
   */
  #reloadDirty = false;

  /**
   * 所有授权读取共享的依赖集合；缺席或失败的路径同样登记，避免坏配置修好后无法自动恢复。
   * 热路径沿已发布清单只做stat，不重复枚举rulePath。
   * @type {Set<string>}
   */
  #签到路径 = new Set();
  #loadingAuthBytes = new Map();
  #publishedAuthBytes = null;

  /**
   * @param {{ layout: import('./paths.js').Layout, clock: import('./kernel/time.js').Clock, audit?: { append: Function } }} spec
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.clock = spec.clock;
    this.audit = spec.audit ?? null;
    /** @type {{ ok: boolean, error: string|null, at: string|null, rules: object[], defaults: object, defaults来源: Record<string,string>, 忽略的默认值键: string[], identity: object, establishment: object, digests: Record<string,string> }} */
    this.state = {
      ok: false,
      error: '尚未加载',
      at: null,
      rules: [],
      defaults: {},
      defaults来源: {},
      忽略的默认值键: [],
      identity: { members: {}, sovereign: { lastInteraction: null }, denylist: [] },
      establishment: { roles: [], mode: '独立会审' },
      digests: {},
    };
    /** 已加载的授权块（法律件里那份），热更新时整体替换。 */
    this.grants = [];
    /**
     * 上次 reload 时「披露敏感模式」是否为显式空数组（骑手②的去重标志）。
     * 只在**状态迁移**时记告警（非空→空、首次加载即空）；同一状态反复 reload
     * 不刷账本——身份档案 mtime 一变就触发 reload，每次交互都记就成了告警洪水。
     * 「关闭」这件事必留痕，「持续关闭」不重复喊。
     */
    this.disclosureEmptyWarned = false;
    /**
     * 上次 reload 时身份档案的 mtimeMs（档案缺失记 null）。
     * 为什么放在实例上：decide 热路径要用它判断「档案在加载之后被谁改过」。
     */
    this.identityMtimeMs = null;
    /**
     * R04（审查 2026-10-16 · 生效闭环）：**全部授权依赖**的签名。
     * 修前新鲜度检查只盯身份档案 ⇒ 手改法律件/部署介入度后，判定仍按旧规则跑，直到
     * 某次身份写入「顺便重载」（报告实证：写逐条审批后当前策略仍按零参与 allow）。
     * 现在 decide 的热路径比对这个集合，任一依赖变动 ⇒ reload 后再判。
     * 形状 { 串, 路径 }：`路径` 供后续只 stat 已知清单（不再枚举 rulePath）。
     * @type {{ 串: string, 路径: string[] } | null}
     */
    this.authSig = null;
    /**
     * in-flight reload 去重（2026-10-13 第三批性能收口）：身份档案 mtime 一变（每次
     * assign/seal/markInteraction 都会变）之后的并发 decide 各自触发全量 reload——
     * 突发下是 N× 全量加载。进行中的 reload 共享同一个 Promise，后到者等结果不重跑。
     */
    this.#inFlightReload = null;
    this.#reloadDirty = false;
  }

  /** 热更新入口：宿主在文件变更时调用；失败不改变「不健康」这个事实。并发调用合并为一次。 */
  reload() {
    if (this.#inFlightReload) {
      // R05（审查 2026-10-16 · in-flight 合并不丢 dirty）：并发到达**且确有新变化**
      // （此刻授权依赖签名 ≠ 已发布快照的签名）⇒ 标脏，在飞轮结束再补读一轮——修前共享
      // Promise 就完事，期间落盘的写入被「已重载」假象吞掉。纯并发去重（文件没变，
      // 第三批的「rulePath 读取次数不随调用数翻倍」语义）不标脏、不补读。
      // R04 起比对**全部授权依赖**而非只有身份档案（同一份签名、同一把尺）。
      // 路径清单从**已发布签名**里取（它按 `路径=mtime` 存过一遍）——不走 rulePath 枚举，
      // 第三批「rulePath 读取次数不随调用数翻倍」的语义照旧成立。
      void this.#authSignature(this.authSig?.路径).then((sig) => {
        if (sig.串 !== this.authSig?.串) this.#reloadDirty = true;
      });
      return this.#inFlightReload;
    }
    this.#inFlightReload = (async () => {
      // 返回值保持 #reloadOnce 的语义（成功与否）：外层 do-while 是重读控制流，
      // 不能把「最后一次加载的结果」吞成 undefined——等待方（宿主热更钩子与测试）
      // 都在用这个布尔值。
      let ok;
      do {
        this.#reloadDirty = false;
        ok = await this.#reloadOnce();
      } while (this.#reloadDirty);
      return ok;
    })().finally(() => {
      this.#inFlightReload = null;
    });
    return this.#inFlightReload;
  }

  /**
   * R04（审查 2026-10-16 · 生效闭环；判据①的取数点）：授权依赖的**签名**。
   *
   * 依赖面＝这份引擎判定时真正读的那些文件：身份档案、每个规则件（私有/出厂两区路径）、
   * 出厂默认值（介入度 / 响应期限 / 安全类探针声明）、私有部署偏好、编制件（两区）。
   * 取 mtimeMs 拼成稳定串——热路径只做 stat，不重读不解析（与身份档案那道同款）。
   * 文件缺席记 '-'（缺席→出现 也是变化，反之亦然）。
   *
   * @param {string[]} [路径表] 调用方已知的路径清单（加载流程传它，省一次 rulePath 走查）；
   *   省略则自行枚举（decide 热路径用）。
   * @param {{ 身份mtime?: number|null }} [选项] 已知的身份档案时刻（加载流程传「与发布正文
   *   同一快照」的读后值——R05 的教训：不要在撕裂窗里改用新 stat）。
   * @returns {Promise<{串: string, 路径: string[]}>}
   */
  async #authSignature(路径表, 选项 = {}) {
    const 文件 = 路径表 ?? [...this.#签到路径];
    const 部分 = [];
    for (const p of 文件) 部分.push(`${p}=${(await mtimeMsOrNull(p)) ?? '-'}`);
    if (选项.身份mtime !== undefined) {
      // 发布快照时用「与正文同一快照」的身份 mtime 覆盖那一格（R05：撕裂窗里读到旧正文、
      // 却记下新 mtime = 撤回永久失效）。其余依赖照常现 stat。
      const 身份行 = `${this.layout.identityFile()}=${选项.身份mtime ?? '-'}`;
      const 位置 = 部分.findIndex((x) => x.startsWith(`${this.layout.identityFile()}=`));
      if (位置 >= 0) 部分[位置] = 身份行;
      else 部分.unshift(身份行);
    }
    return { 串: 部分.join('|'), 路径: 文件 };
  }

  /**
   * 授权依赖只在真正的读取入口登记；读失败或文件缺席仍保留路径，才能自动发现修复与出现。
   * @param {string} file 授权加载路径
   * @returns {Promise<string|null>} 与readTextOrNull相同，不另维护会漂移的候选清单。
   */
  async #readAuth(file) {
    this.#签到路径.add(file);
    const text = await readTextOrNull(file);
    this.#loadingAuthBytes.set(file, text);
    return text;
  }

  /**
   * R04：需要时才重载（签名比对）。内核定时器与 decide 热路径共用这一处判定——
   * 一处实现，两处调用（报告 §5.3「公共流程：一致的策略快照」）。
   *
   * @returns {Promise<{ changed: boolean, reloaded: boolean, ok: boolean }>}
   */
  async refreshIfStale() {
    const sig = await this.#authSignature(this.authSig?.路径);
    if (sig.串 === this.authSig?.串) return { changed: false, reloaded: false, ok: this.healthy };
    const ok = await this.reload();
    return { changed: true, reloaded: true, ok: Boolean(ok) };
  }

  async #reloadOnce() {
    this.#loadingAuthBytes = new Map();
    this.#publishedAuthBytes = null;
    // R05（审查 2026-10-16 · 读前/读后一致才发布）：修前 #loadIdentity（读正文）与
    // identityMtimeMs 的 stat 隔了整个加载流程——两步之间落盘的合法撤回会把【新 mtime】
    // 绑给【旧名单】，decide 的 mtime 快速路从此看不出差异，撤回持续失效到下一次身份写入
    // （审查实证：写入 member-a 拒绝名单后，动作入口照旧放行，直到显式 reload）。
    // 修法：stat → 读正文 → stat，两端一致才算同一快照；不一致有界重试。
    const identityFile = this.layout.identityFile();
    /** @type {object|null} */
    let identity = null;
    /** @type {number|null} */
    let identityMtime = null;
    try {
      let 一致 = false;
      for (let attempt = 0; attempt < 5 && !一致; attempt += 1) {
        const 读前 = await mtimeMsOrNull(identityFile);
        identity = await this.#loadIdentity();
        identityMtime = await mtimeMsOrNull(identityFile);
        一致 = 读前 === identityMtime;
      }
      if (!一致) {
        // 5 轮仍在撕裂 = 档案正被高频连续写。如实降级：发布最后一轮读到的正文，mtime 记
        // 读后值——撕裂期间的写入若改了 mtime，decide 的快速路下一跳就会看到差异再触发
        // reload。只 warn 不失败：把「正在被写」当「引擎坏」fail-closed，反而挡住写入方收尾。
        console.warn?.('[dsh-mind] 身份档案连续 5 轮读取都在变动：快照按最后一次读取发布，decide 的 mtime 快速路会兜住后续变化。');
      }
      const { rules, digests } = await this.#loadRules();
      const { defaults, defaults来源, 忽略的默认值键 } = await this.#loadDefaults();
      const establishment = await this.#loadEstablishment();
      this.grants = collectGrants(rules);
      this.state = {
        ok: true,
        error: null,
        at: this.clock.iso(),
        rules,
        defaults,
        defaults来源,
        忽略的默认值键,
        identity,
        establishment,
        digests,
      };
      // 骑手②（契约C 补强 2026-10-09）：部署.json 披露敏感模式=[] 是主权者**显式关闭**
      // 这道安全闸——合法，但绝不许静默：状态迁移进「空清单」时记一条告警档审计。
      // 留痕失败不让 reload 失败（账本故障另有探针盯着），但用 console 喊出来——
      // 「关闭了却没喊成」比「reload 失败」更接近 §3.6 说的静默失败。
      await this.#warnIfDisclosureDisabled(defaults, defaults来源);
      this.#publishedAuthBytes = new Map(this.#loadingAuthBytes);
    } catch (error) {
      // fail-closed：加载失败 ⇒ 引擎不健康，之后所有判定走 Fault（拒绝 + 告警）。
      this.state = {
        ...this.state,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
        at: this.clock.iso(),
      };
    }
    // 不论成败都记下「这次加载看到的档案时刻」：失败时也记，否则下一次 decide
    // 会看到「mtime 没变」而跳过重载——把一个可能已修复的引擎卡死在不健康状态。
    // R05：成功路径用快照的读后 mtime（与发布的正文同一快照）；失败路径现 stat——
    // 失败时正文没发布，不存在「新 mtime 绑旧正文」的撕裂，只需保证下次 decide 能再试。
    this.identityMtimeMs = identityMtime ?? await mtimeMsOrNull(this.layout.identityFile());
    // R04：发布快照的同时记下**全部授权依赖**的签名（decide 热路径与内核定时器共用它判新旧）。
    // 身份那一格用**与发布正文同一快照**的 mtime（R05：撕裂窗里读到旧正文却记新 mtime 会让
    // 撤回永久失效——本条不能把那个修复重新打穿）。
    this.authSig = await this.#authSignature(undefined, { 身份mtime: this.identityMtimeMs });
    return this.state.ok;
  }

  /**
   * 骑手②（契约C 补强 2026-10-09）：`披露敏感模式: []` 的响亮留痕。
   *
   * 空数组是主权者的**显式决定**（整体覆盖默认清单后一条模式都不剩），所以它合法；
   * 但「安全闸被关掉」这件事必须入账（告警档）——否则下一次复核时，谁也答不出
   * 「披露机械检查是什么时候、被谁关掉的」。去重口径见构造器里 `disclosureEmptyWarned`
   * 的注释：只在状态**迁移**时喊（非空→空、首次即空），持续关闭不重复喊。
   *
   * @param {object} defaults 本次加载合并后的默认值
   * @param {Record<string,string>} defaults来源 键的生效来源（'出厂' | '私有' | '内置兜底'）
   */
  async #warnIfDisclosureDisabled(defaults, defaults来源) {
    const 空清单 = Array.isArray(defaults.披露敏感模式) && defaults.披露敏感模式.length === 0;
    if (!空清单) {
      this.disclosureEmptyWarned = false; // 恢复非空 ⇒ 标志复位，下次再关会再喊。
      return;
    }
    if (this.disclosureEmptyWarned) return; // 持续关闭：不重复。
    this.disclosureEmptyWarned = true;
    try {
      await this.audit?.append?.({
        动作: '披露机械检查已显式关闭',
        告警: true,
        主体: { id: 'system', kind: '系统' },
        对象: { id: this.layout.deploymentPrefs(), kind: '设置文件' },
        依据: '契约C 补强（2026-10-09）：部署.json 披露敏感模式=[] 为主权者显式关闭——合法，但不许静默',
        结果: '已显式关闭（空清单，知识晋升披露机械检查不再拦截任何模式）',
        详情: { 生效来源: defaults来源.披露敏感模式 ?? '内置兜底' },
      });
    } catch (error) {
      // 账本坏了不该让引擎装死（fail-closed 会冻住全部写动作，包括把清单改回去的手）；
      // 但喊不出来也绝不吞声——console 是这里的最后出口。
      console.warn?.(`[dsh-mind] 披露敏感模式为空数组（显式关闭），且告警入账失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** @returns {boolean} */
  get healthy() {
    return this.state.ok === true;
  }

  /** 引擎自述：给工作台与探针用（探针要能发现「闸被关了」）。 */
  describe() {
    return {
      healthy: this.healthy,
      error: this.state.error,
      loadedAt: this.state.at,
      rules: this.state.rules.map((r) => ({ id: r.id, authority: r.authority, zone: r.zone, digest: r.digest })),
      defaults: this.state.defaults,
      // 「生效值来自哪一层」与「哪些文档键被剔掉了」都要能看见：这两个问题的答案
      // 以前只能靠读源码猜，而「改了不生效」正是这套设置最容易出的事故。
      defaults来源: this.state.defaults来源 ?? {},
      忽略的默认值键: this.state.忽略的默认值键 ?? [],
      grants: this.grants.length,
      digests: this.state.digests,
    };
  }

  /**
   * 判定。永不抛错，只返回结论——调用方要「拒绝即抛」就用 `check()`。
   *
   * @param {{ subject: object, action: string, target: object, context?: object }} input
   * @returns {Promise<{ verdict: 'allow'|'deny'|'confirm', rule: string, reason: string, requireAuthority: string, howToChange: string, detail?: object, authority?: string, alarm?: boolean }>}
   */
  async decide(input) {
    // 授权依赖新鲜度（R04 · 审查 2026-10-16；报告 P04「规则与部署偏好没有宣称的变更热更新」）：
    // 判定的依据是**一组文件**——身份档案、规则件（两区）、出厂默认值、私有部署偏好、编制件。
    // 修前这里只 stat 身份档案 ⇒ 手改法律件或部署介入度后判定仍按旧规则跑，直到某次身份
    // 写入「顺便重载」（报告实证：写逐条审批后当前策略仍按零参与 allow、显式 reload 才变）。
    // 现在比对全部依赖的签名（同样只做 stat，不重读不解析），任一变动即在本次判定前重载。
    // 引擎不健康时的行为不变：下面的 !healthy 分支照旧 fail-closed（拒绝 + 告警入账）。
    // P1-03（全面审查 2026-10-17）：refreshIfStale 自身抛错（坏 identity/规则件）时，
    // decide 的契约是「永不抛错，只返回结论」。修前它在 try 外 ⇒ 坏档让 decide 抛原始
    // 异常，故障告警不入账、state.ok 留旧值（探针假绿）。这里把刷新失败收敛成
    // fail-closed 的引擎不健康状态，下面的 !healthy 分支统一走 Fault + 告警入账。
    try {
      await this.refreshIfStale();
    } catch (error) {
      this.state = {
        ...this.state,
        ok: false,
        error: `授权依赖刷新失败：${error instanceof Error ? error.message : String(error)}`,
        at: this.clock.iso(),
      };
    }
    if (!this.healthy) {
      const fault = new Fault('POLICY_NOT_LOADED', `策略引擎不健康：${this.state.error ?? '未知原因'}`).toDecision();
      await this.#auditFault(input, fault);
      return fault;
    }
    try {
      const verdict = this.#evaluate(input);
      if (verdict.verdict !== 'allow') {
        await this.audit?.append?.({
          动作: '策略拒绝',
          主体: input.subject,
          对象: { id: input.target?.id ?? null, kind: input.target?.kind ?? '未知' },
          依据: verdict.rule,
          结果: verdict.verdict === 'confirm' ? '需确认' : '拒绝',
          详情: { action: input.action, reason: verdict.reason, requireAuthority: verdict.requireAuthority, ...(verdict.detail ?? {}) },
        });
      }
      return verdict;
    } catch (error) {
      const fault = new Fault('POLICY_EVALUATION_FAILED', `判定过程故障：${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
        detail: { action: input.action, target: input.target?.id ?? null },
      }).toDecision();
      await this.#auditFault(input, fault);
      return fault;
    }
  }

  /**
   * 宿主同步副作用闸：只在全部授权原文与已加载快照逐字一致时复用同一判定本体。
   * 任一文件变化、读取失败或重载未完成都拒绝，不能等5秒热更新期间借旧权限写文件。
   * 只读诊断仍走 mind；此方法不追加审计、不启动异步工作，也不消费逐请求放行。
   */
  decideCurrentSync(input) {
    const unavailable = (reason) => deny('策略引擎 · 同步文件资格不可确认', reason, {
      requireAuthority: 'Lead', howToChange: '通过 mind 的 status / policy_reload 诊断并完成重载，恢复合法配置后再试；禁止用 raw 文件通道修组织配置。',
    });
    if (!this.healthy || this.#inFlightReload || !this.#publishedAuthBytes) return unavailable(`策略引擎不健康或授权重载未完成：${this.state.error ?? '快照尚不可用'}。`);
    try {
      for (const [file, expected] of this.#publishedAuthBytes) {
        let current;
        try { current = readFileSync(file, 'utf8'); }
        catch (error) { if (error?.code !== 'ENOENT') throw error; current = null; }
        if (current !== expected) return unavailable('授权依赖原文已变化，旧内存权限立即失效；需先完成策略重载。');
      }
      if (this.会挂起(input)) return unavailable('现行介入度要求先经受控动作审批；通用文件工具不能借用组织动作的放行记录。');
      return this.#evaluate(input);
    } catch (error) { return unavailable(`同步策略核验失败：${error instanceof Error ? error.message : String(error)}`); }
  }

  /**
   * 故障路径的拒绝也要入账：Fault.toDecision 的 howToChange 承诺「故障期间的拒绝记录已入账」，
   * 不留痕这句就是假话（留痕是自治的门槛）。入账自身失败只能吞——decide 承诺永不抛，
   * 而账本坏了本来就会让审计链探针见红，那里才是它该响的地方。
   */
  async #auditFault(input, decision) {
    try {
      await this.audit?.append?.({
        动作: '策略拒绝',
        主体: input.subject,
        对象: { id: input.target?.id ?? null, kind: input.target?.kind ?? '未知' },
        依据: decision.rule,
        结果: '安全闸故障（fail-closed）',
        告警: true,
        详情: { action: input.action, reason: decision.reason },
      });
    } catch {
      // 见上方 JSDoc：decide 永不抛，故障入账失败不二次故障。
    }
  }

  /**
   * 判定 + 不通过就抛。写路径的唯一入口。
   * @param {{ subject: object, action: string, target: object, context?: object }} input
   * @returns {Promise<{ verdict: 'allow', rule: string, reason: string }>}
   */
  async check(input) {
    const decision = await this.decide(input);
    if (decision.verdict === 'allow') {
      return { verdict: 'allow', rule: decision.rule, reason: decision.reason };
    }
    if (decision.verdict === 'confirm') {
      throw new NeedsApproval(decision.rule, decision.reason, {
        requireAuthority: decision.requireAuthority,
        howToChange: decision.howToChange,
        detail: decision.detail,
      });
    }
    if (decision.alarm) {
      throw new Fault(String(decision.rule).replace(/^fault:/, ''), decision.reason, { detail: decision.detail });
    }
    const denied = new Denied(decision.rule, decision.reason, {
      requireAuthority: decision.requireAuthority,
      howToChange: decision.howToChange,
      detail: decision.detail,
    });
    // 这条拒绝在 decide() 里已记「策略拒绝」入账——动作层的拦截入账（缺口1B，
    // actions.js 记动作拦截）靠这个标记跳过，同一拒绝不双记。
    denied.已入账 = true;
    throw denied;
  }

  /**
   * 主体能否在任务内行动（§2「任务内全权，任务外无」）。
   * @param {object} subject
   * @param {object|null} task
   * @returns {{ ok: boolean, reason?: string }}
   */
  scopeOf(subject, task) {
    if (subject?.kind !== '成员') return { ok: true };
    if (!task) return { ok: false, reason: '成员在任务外无权限：本次调用未声明任务上下文（task 为空）' };
    // 负责人可能是**一个人**，也可能是**一岗多人的一组**（§10）。
    // 拿字符串去比数组会永远不相等，于是多负责人任务上谁也干不了活 —— 这里统一折成名单。
    const 名单 = normalizeList(task.负责人);
    // 空名单 ≠ 人人有份（2026-10-13 审查 P1-4）：负责人缺席是数据异常（解析失败 / 手工编辑 /
    // 旧数据），按 fail-closed 拒绝——「任务内全权」的安全门槛不许被一个空数组短路。
    if (名单.length === 0) {
      return { ok: false, reason: '该任务节点负责人名单为空（解析失败 / 手工编辑 / 旧数据）：为防越权，空名单按「无人有任务内全权」处理，由 Lead 先把负责人补齐' };
    }
    // 已有真实绑定时，「这一岗」不再代表该岗所有实例。否则旧执行者失效后，同岗新实例
    // 仍能 resolve / submit 旧节点，甚至以旧任务为凭据写记忆。绑定和当时凭证共同限定执行者；
    // 负责人 id、岗位名和自报 roleId 均不能绕过它。卡正文校验仍由统一写前凭证闸负责。
    if (task.绑定 != null && !Array.isArray(task.绑定)) {
      return { ok: false, reason: '任务实例绑定形状不可用：不能把坏绑定当成无绑定旧任务放行' };
    }
    const 绑定 = task.绑定 ?? [];
    if (绑定.length > 0) {
      const member = this.state.identity?.members?.[subject.id];
      const 宿主代次 = typeof member?.代次 === 'string' ? member.代次 : member?.代次?.代 ?? null;
      const 本人绑定 = 绑定.some((b) => {
        const pin = b?.凭证;
        return b?.实例 === subject.id && member?.status === '在岗' && b.岗位 === member.岗位
          && (名单.includes(b.实例) || 名单.includes(b.岗位))
          && pin?.版本 === 1 && pin.代 === (member.代 ?? 1)
          && typeof pin.卡版本摘要 === 'string' && Boolean(pin.卡版本摘要)
          && pin.卡版本摘要 === member.卡版本?.摘要 && pin.宿主代次 === 宿主代次;
      });
      if (!本人绑定) {
        return { ok: false, reason: `任务已有真实实例绑定，但 ${subject.id} 没有与当前负责人、在岗岗位及实例凭证一致的绑定：同岗、旧代次或旧卡不能继承任务写权` };
      }
    } else if (!名单.includes(subject.id)) {
      // 只有完全无绑定的旧任务保留按负责人 id / 档案岗位寻址的兼容路径。
      // 档案不在册 / 不在岗不产出岗位；自报 roleId 始终不参与匹配。
      const 岗位 = this.#档案岗位Of(subject.id);
      if (!(岗位 && 名单.includes(岗位))) {
        return { ok: false, reason: `该任务节点负责人是 ${名单.join('、')}，不是 ${subject.id}` };
      }
    }
    // ③ 任务授权寿命（R03 · 审查 2026-10-16）：「任务内全权」跟着任务生命周期走，不是
    //    「曾负责过」的永久凭据。审查实证：同一任务在【待派发】阶段即可充当写凭据；真实
    //    流转到【已采纳/已结账】终态后仍可。未派发 = 授权还没生效；终态 = 授权已随收口结束。
    //    已交卷/未验/待决不拦：复核窗口内成员对本节点的只增动作（如 task_pending 标待决）
    //    是 TRANSITIONS 明文的合法转换（tasks.js:46），拦它会打断既有环路——状态机的
    //    逐转换合法性由 #requireTransition 守，这里只管「授权是否已生效/已终止」两端。
    const 状态 = String(task.状态 ?? '');
    if (状态 === '待派发') {
      return { ok: false, reason: `该任务节点尚未派发（状态=待派发）：任务授权随派发生效，负责人名单不是预先生效的凭据；由 Lead task_dispatch 后再写` };
    }
    if (状态 === '已采纳' || 状态 === '已结账') {
      return { ok: false, reason: `该任务节点已是终态（状态=${状态}）：任务授权随收口终止，「曾负责过」不构成后续写凭据；需要继续产出由 Lead 另立节点` };
    }
    return { ok: true };
  }

  /**
   * 身份档案里的在岗岗位（scopeOf 的唯一解析面 · 缺口4 2026-10-12）。
   *
   * decide 入口已按 mtime 保档案新鲜（本文件 :222），这里只读内存态、不另起 IO——
   * 于是**不引入**策略引擎 → 注册表的模块依赖：档案真源是同一份
   * （registry 写 身份档案/identity.json，policy 读同一个文件），环依赖无从谈起。
   *
   * @param {string} id
   * @returns {string|null} 在册且在岗 ⇒ 岗位名；否则 null（不产出岗位 = scopeOf 照拒）
   */
  #档案岗位Of(id) {
    const member = this.state.identity?.members?.[id];
    if (!member || member.status !== '在岗') return null;
    return typeof member.岗位 === 'string' && member.岗位 ? member.岗位 : null;
  }

  /**
   * 当前是否处于失联（§4 失联：所有自治变更冻结）。
   *
   * 两个键都出自**同一份出厂件** `defaults/响应期限.json`（私有区 `部署.json` 可压过它）：
   *  `失联限制` ＝ 这个失联保险本身；`响应期限小时` ＝ 期限。
   * **`失联限制` 恒在**（开也返回 `true`、关返回 `false`）：它不是一个「只在关时才出现的标记」——
   *  读的人（设置页、工作台、夹具）先问的就是「开关现在什么状态」，键缺席只能被读成「未知」。
   *  开状态不给这个键曾经造成两个真缺陷：设置页把开关显示成「未知」；而写「开关=是」之后的
   *  **回读判据**（拿请求与回读逐字段比）读不出这个键，于是每一次「打开」都被报成
   *  「没写进去：回读与请求不一致」——写其实成功了。修法是**让读数把键给全**，
   *  不是把回读判据放宽成「读不出就不算不一致」（那等于把判据拆了）。
   * 开关关掉时如实报 `已关闭: true` —— **不许把「关了」伪装成「在线」**，
   * 否则读的人分不清「主权者一直在」和「这个机制被停掉了」。
   *
   * 只认**严格 `false`** 是 fail-safe：手改 JSON 写成字符串 `"false"` 这类含糊值时，
   * 失联保险保持**开着**（冻结照旧），不会因为写法含糊就把保护悄悄摘掉。
   *
   * 读数里带**来源**与**坏值标记**，因为「生效值来自哪一层」正是这两个设置最该有的透明度：
   *  - `响应期限小时来源` / `失联限制来源` ∈ '出厂' | '私有' | '内置兜底'（生效值是谁给的）；
   *  - `生效响应期限小时` ＝ 真正拿去判的期限（坏值已折成 72）；
   *  - `值不合法` ＋ `原值` ＋ `原值来源` ＋ `不合法说明` ＝ 你写的值无效，已退回 72 ——
   *    没有这几个字段时，「写了个坏值」和「一切正常」在读数上长得一模一样（§3.6 不许静默失败）。
   *
   * **本方法永不抛**：它是 `/mind status` 与工作台的必经之路，一抛就是整条读数链一起废
   * （而引擎还会报 healthy）。所以时间戳/期限算不出确定结论时，一律给**确定读数**：
   * 拿不准就退回内置兜底重算，再不成按最严判失联，并把原因写进 `判定说明`。
   *
   * @returns {{ 失联限制: boolean, lost: boolean, 已关闭?: boolean, hours: number|null, since: string|null, deadline: string|null, 生效响应期限小时: number, 响应期限小时来源: string, 失联限制来源: string, 值不合法: boolean, 原值?: unknown, 原值来源?: string, 不合法说明?: string, 判定说明?: string }}
   */
  presence() {
    const 来源 = this.state.defaults来源 ?? {};
    const 开关原值 = this.state.defaults?.失联限制;
    const 期限 = resolveResponseDeadline(this.state.defaults?.响应期限小时);
    const 读数 = {
      // 坏值的生效值来自内置兜底，所以来源如实报「内置兜底」（不是「私有」）——
      // 哪一层写了坏值，由 `原值来源` 交代。
      响应期限小时来源: 期限.不合法 ? '内置兜底' : (来源.响应期限小时 ?? '内置兜底'),
      失联限制来源: 来源.失联限制 ?? '内置兜底',
      生效响应期限小时: 期限.生效,
      值不合法: 期限.不合法,
      ...(期限.不合法
        ? {
            原值: 期限.原值,
            原值来源: 来源.响应期限小时 ?? '内置兜底',
            不合法说明: `响应期限小时 的原值 ${JSON.stringify(期限.原值)} 不合法（${期限.理由}），已退回内置兜底 ${期限.生效}。`,
          }
        : {}),
    };
    if (开关原值 === false) {
      return { 失联限制: false, lost: false, 已关闭: true, hours: 0, since: null, deadline: null, ...读数 };
    }
    const 时间输入 = {
      lastInteraction: this.state.identity?.sovereign?.lastInteraction ?? null,
      now: this.clock.now(),
    };
    let 判定;
    try {
      判定 = evaluateSovereignPresence({ ...时间输入, responseDeadlineHours: 期限.生效 });
    } catch (error) {
      // 保险丝（正常路径走不到这里：判据本体已经不抛）：拿不准就退回内置兜底 72 重算；
      // 再不成 ⇒ 按最严判失联并如实说明。**永不抛**是这一层的唯一职责。
      const 原因 = error instanceof Error ? error.message : String(error);
      try {
        判定 = {
          ...evaluateSovereignPresence({ ...时间输入, responseDeadlineHours: BUILTIN_RESPONSE_DEADLINE_HOURS }),
          判定说明: `失联判定首次失败（${原因}），已退回内置兜底 ${BUILTIN_RESPONSE_DEADLINE_HOURS} 小时重算。`,
        };
      } catch (再错) {
        判定 = {
          lost: true,
          since: null,
          deadline: null,
          hours: null,
          判定说明: `失联判定算不出来（${原因}；退回兜底后又失败：${再错 instanceof Error ? 再错.message : String(再错)}），按最严判失联（fail-safe，§12.2 查不到 = 最严）。`,
        };
      }
    }
    // `失联限制: true` 恒在（开状态也要给键）—— 见方法头注释里的两个真缺陷。
    return { 失联限制: true, ...判定, ...读数 };
  }

  /** @returns {string} 当前介入度档位 */
  intervention() {
    const level = this.state.defaults?.介入度 ?? '放权';
    return INTERVENTION.includes(level) ? level : '放权';
  }

  /**
   * 复核免审全局开关（v2 口述收敛 2026-10-18 条目5）：true ⇒ Lead/主权者可对节点
   * 登记复核豁免（review_exempt），false（默认）⇒ 豁免动作一律拒。
   * 加载期已校验布尔（坏值引擎不健康、写全拒），这里只读生效值。
   * @returns {boolean}
   */
  reviewExemptAllowed() {
    return this.state.defaults?.复核免审 === true;
  }

  /**
   * 预判：这一笔写在当前档位下会不会被介入度拦下（**只读、不落账、不消耗放行**）。
   *
   * 为什么动作层需要它：宏动作（member_spawn / 多候选 settle）有多个受管步骤、且 host
   * 创建子等副作用在中间。批准必须发生在**任何副作用之前**，所以动作层要在执行前把
   * 整份步骤计划摊出来、逐条问「会被拦吗」；有一步会拦 ⇒ 整单挂起等主权者批一份完整计划。
   * 判据与 `#preGrantBoundary` 同一份（预审只看写死的高风险清单，审批全拦，主权者不拦）。
   *
   * @param {{ subject: object, action: string, target: object, context?: object }} spec
   * @returns {boolean}
   */
  会挂起({ subject, action, target, context = {} }) {
    if (subject?.kind === '主权者') return false;
    if (String(action ?? '') === 'read') return false;
    if (target?.authority && target.authority !== '自治') return false;
    const level = this.intervention();
    if (level === '审批') return true;
    if (level === '预审') return this.#预审高风险(String(action), target, context);
    return false;
  }

  /**
   * 领域计划在宿主创建前检查同一条不越授不变式；只读、不落账、不消费审批步骤。
   * null 仅表示该不变式未拒绝，绝不代表写入已获许可；真实登记仍须完整 check。
   */
  delegationBoundary({ subject, action, target, context = {} }) {
    return this.#不越授(normalizeSubject(subject), String(action ?? ''), target ?? {}, context);
  }

  // ── 判定本体 ────────────────────────────────────────────────────────────────

  /** @param {{ subject: object, action: string, target: object, context?: object }} input */
  #evaluate(input) {
    const subject = normalizeSubject(input.subject);
    const target = input.target ?? {};
    const action = input.action;
    const context = input.context ?? {};
    // 缺标签按最严档判（2026-10-14 审查 P2-1，与 #invariants 同口径）：修前缺省落「自治」
    // （最松）——忘盖章的目标被静默放宽，与引擎 fail-closed 方向相反。生产调用方都显式
    // 盖章；没盖的一律按宪章档（写仅主权者可过），逼调用方补章而不是悄悄放行。
    const authority = target.authority ?? '宪章';

    if (!SUBJECT_KINDS.includes(subject.kind)) {
      return deny('宪章 主体定义（§2）', `未知主体种类：${String(subject.kind)}。查不到身份不等于放行（§12.2）。`, {
        requireAuthority: '宪章',
        howToChange: '由主权者在身份档案中登记该主体，或改用已登记的身份。',
      });
    }
    // 身份档案接入判定（§12.2：身份停用/删除时判定必须有确定答案）。
    // 只查成员：它的权来自注册表里的**实例**，封存即失权（复核员岗实例同样是成员
    // 主体 + roleId=复核员，也在此列）；主权者/出厂作者/系统/Lead 是结构性身份，
    // 不挂在实例账上。
    if (subject.kind === '成员') {
      const 状态 = identityStatus(this, subject.id);
      if (状态.status !== '在岗') {
        return deny('宪章 身份停用 = 最严（§12.2）', 状态.reason, {
          requireAuthority: '主权者',
          howToChange: `由 Lead 在角色注册表登记/恢复该实例（registry_assign / registry_restore），或改用在岗身份执行。当前状态：${状态.status}。`,
        });
      }
    }
    if (!ACTIONS.includes(action)) {
      return deny(ALWAYS_INVARIANTS, `未知动作：${String(action)}。策略引擎不做默认放行。`, {
        requireAuthority: '宪章',
        howToChange: `改用动作清单内的动作：${ACTIONS.join(' / ')}`,
      });
    }

    // v2 条目10/20 最终统一凭证闸（2026-10-18 裁决）：**Lead 与成员的所有新写**都要求
    // 相应凭证齐备——不是只自治档（身份版本凭证不能被某一档 grant 旁路），也不是只 Lead。
    // 三条边界：
    //  ① **所有写档**，但**只读一律保留**（诊断与恢复：status / workbench / audit_tail /
    //     task_criteria 在同样的坏状态下必须还能读出来，读域规则不变）；
    //  ② 写动作 fail-closed：没记录 / 非在岗 / 缺卡版本 / 成员缺委派归属 都拒，拒因精确；
    //  ③ 受控父判里的委派者走同一个闸（父凭证不齐 ⇒ 子也写不了）。
    // 历史实例：不判死（在岗事实照旧），但**只读**——「过去合法」不换「今后可写」。
    const 凭证闸 = this.#凭证闸(subject, action);
    if (凭证闸) return 凭证闸;

    const invariant = this.#invariants(subject, action, target, context);
    if (invariant) return invariant;

    // 会审参与实例的写面（v2 条目18/20 · 补修I 的绑定落到判定面）：真实登记在册、带
    // `会审绑定` 的成员只允许**本场**会审的作答/讨论受限写；其它业务写 / 派活 / 能力发布
    // 一律拒。位置刻意在**受控父判之前**：父判的「介入度 confirm」会先一步把业务写变成
    // 「挂起等批」，而绑定边界是确定拒绝——「全拒」不能被降级成「等人批」。
    // 三个事实都取身份档案（可信 registry），不由模型 context 自报：
    //  - 绑定的会审 id / 项目；
    //  - 本次 target 必须就是那场会审（id+项目），action 必须是 write；
    //  - `context.会审` 只能用来确认服务层正在处理**同一场**且名单里有本人（服务层折出的视图）。
    // 「预给参与者原任务权限不改」：这里只收紧，不动任何既有任务/岗位权限。
    if (subject.kind === '成员' && action !== 'read') {
      const 会审绑定 = this.state.identity?.members?.[subject.id]?.会审绑定 ?? null;
      if (会审绑定) {
        const 会审视图 = context?.会审 ?? null;
        const 本场事实 = typeof 会审绑定.会审 === 'string' && Boolean(会审绑定.会审)
          && String(target.project ?? '') === String(会审绑定.项目 ?? '')
          && String(会审视图?.id ?? '') === 会审绑定.会审
          && Array.isArray(会审视图?.参与者) && 会审视图.参与者.includes(subject.id);
        const 本场受限写 = 本场事实 && (
          (action === 'write' && target?.kind === '会审' && String(target.id ?? '') === 会审绑定.会审)
          || (action === 'create' && target?.kind === '消息' && authority === '只增'
            && context.会审消息 === true && 会审视图.状态 === '讨论中'
            && 线程等价键(String(context.会审线程 ?? '')) === 线程等价键(`${COUNCIL_THREAD_PREFIX}${会审绑定.会审}`))
        );
        if (!本场受限写) {
          return deny('会审参与实例 · 只允许本场作答/讨论的受限写（补修I）', `实例 ${subject.id} 带会审绑定（${会审绑定.会审}）：它的写面只有本场会审的作答/讨论；本次 ${action} 的目标 ${target?.kind ?? '?'}/${target?.id ?? '?'} 不在本场受限写内。`, {
            requireAuthority: 'Lead',
            howToChange: '会审参与实例不能做业务写 / 派活 / 能力发布；需要干活由 Lead 另起任务实例（member_spawn），会审结束后实例退役。',
            detail: { 会审绑定, 本次: { action, kind: target?.kind ?? null, id: target?.id ?? null, project: target?.project ?? null } },
          });
        }
      }
    }

    // v2 条目20 · 不越授（受控父判）：成员写动作必须在**委派者**的权限面之内。
    // 位置刻意放在不变式之后、拒名单/失联/边界/授权块之前：
    //  - 在不变式之后 ⇒ 结构性拒绝（如「成员不得建卡」）仍以它自己的拒因说话，不被父判抢走；
    //  - 在授权块之前 ⇒ 一条「只给成员」的 grant 不能把子实例抬到父都做不到的格子里。
    const 父判 = this.#受控父判(subject, action, target, context);
    if (父判) return 父判;

    const write = action !== 'read';
    if (write && this.#isDenied(subject, target)) {
      return deny(
        '法律 撤回 = 写拒绝名单，不删卡（§4 三权）',
        `对象 ${target.id} 在拒绝名单上：主权者已撤回该对象，新的写入一律不许。`,
        { requireAuthority: '主权者', howToChange: '由主权者从拒绝名单移除该 id，卡本身没有被删除。' },
      );
    }

    // 失联冻结（§4 · 2026-10-13 裁决第二批 P2-12 扩面）：自治变更冻结之外，Lead 对法律档
    // 规则件的 publish（升级裁决通道）同样冻结——主权者失联恰恰是 Lead 最不该单方面改规则
    // 的时段；通道的自我约束（「仅主权者授意」）由纪律级升为机制级。
    if (write && (authority === '自治' || (authority === '法律' && action === 'publish')) && this.presence().lost) {
      return deny('宪章 失联（§4）', `主权者已失联，所有自治变更冻结；服务与记忆照常，安全类强更不受影响。`, {
        requireAuthority: '主权者',
        howToChange: '主权者任一次交互即解除失联。',
      });
    }

    // P1-05（全面审查 2026-10-17）：复核者只读与介入度 confirm 属于结构性边界，必须先于
    // 授权块求值。修前 grant 分支在 #tierRule 之前 return，一条 allow grant 就能绕过
    // 「逐条审批」与「复核者不写」——而权限矩阵明写顺序相反。这里前移的是**边界**，
    // 不是三档默认：无匹配时仍由 #tierRule 兜底。
    const 边界 = this.#preGrantBoundary(subject, action, target, authority, write, context);
    if (边界) return 边界;

    // 顺序很重要：不变式 → 拒名单 → 失联 → 复核者只读/介入度边界（#preGrantBoundary）
    // → 法律件的显式授权块 → 其余三档默认。内置档位是**出厂默认文本**，主权者改过的
    // 权限矩阵.md 是同一部法律的现行版本，所以授权块先于其余默认生效；但复核者只读与
    // 介入度 confirm 是结构性边界，必须在授权块之前（否则一条 allow grant 就能绕过）。
    const grant = this.#grantRule(subject, action, authority, target);
    if (grant) {
      // 宪章档不许被授权块翻转（2026-10-13 审查 P1-3 收尾）：权限矩阵.md 自陈「本文不能
      // 覆盖宪章不变式」，而三档默认里宪章档的 deny 同样是结构性红线——主权者自己写的
      // 宽 grant 也不该给非主权者开「写宪章」的门（主权者本来就走三档 allow，不依赖 grant）。
      //deny/confirm 语义保留（收紧方向永远可以）。
      if (authority === '宪章' && grant.verdict === 'allow' && subject.kind !== '主权者') {
        // 落到三档默认（宪章档 deny）——与「本文不能覆盖宪章」的文档口径一字对齐。
      } else {
        // 任务边界不许被法律授权块绕过（2026-10-13 审查 P1-3）：宽 grant 可以放宽三档默认
        // （既有语义：如本部署允许复核者落结论草稿），但「成员任务内全权、任务外无」是
        // §2 的结构性边界——grant 放行的成员**写**动作仍要过任务上下文这一关。
        if (grant.verdict === 'allow' && subject.kind === '成员' && action !== 'read') {
          const scoped = this.scopeOf(subject, context.task ?? target.task ?? null);
          if (!scoped.ok) {
            return deny('法律 权限矩阵 · 任务内全权，任务外无（§2）', scoped.reason, {
              requireAuthority: 'Lead',
              howToChange: '在本次调用的入参里声明任务上下文（带上你名下任务节点的 id）；名下没有已派发/执行中的节点时，由 Lead 先派发。',
            });
          }
        }
        return grant;
      }
    }

    const tierRule = this.#tierRule(subject, action, target, authority, context);
    if (tierRule) return tierRule;

    const scoped = this.scopeOf(subject, context.task ?? null);
    if (!scoped.ok && action !== 'read') {
      return deny('法律 权限矩阵 · 任务内全权，任务外无（§2）', scoped.reason, {
        requireAuthority: 'Lead',
        howToChange: '在本次调用的入参里声明任务上下文（带上你名下任务节点的 id，如 memory_write / memory_lifecycle 传「任务」）；名下没有已派发/执行中的节点时，由 Lead 先派发。',
      });
    }

    return deny(
      '策略引擎 fail-closed（§7）',
      `没有匹配到允许规则：主体 ${subject.kind}/${subject.id} 对 ${target.kind ?? '未知'}(${target.id ?? '-'}) 执行 ${action}。`,
      {
        requireAuthority: '法律',
        howToChange: `在 权限矩阵.md 的 \`\`\`policy 块中为该组合登记 grant，或改由有授权的身份执行。`,
      },
    );
  }

  /**
   * 统一实例凭证闸（v2 条目10/20 · 2026-10-18 最终裁决）：**Lead 与成员的所有新写**都要
   * 相应凭证齐备。要求：
   *  - Lead：在册在岗 + 钉住的卡版本摘要；
   *  - 成员：在册在岗 + 钉住的卡版本摘要 + **委派归属**（`委派者.id`）。
   *
   * 三条边界（都是被否过的方案的替代）：
   *  ① **所有写档**，不按授权档开洞——身份版本凭证不能被某一档 grant 旁路；
   *     **只读一律保留**（诊断/恢复通道：status ∕ workbench ∕ audit_tail ∕ task_criteria，
   *     读域规则不变）；
   *  ② 历史实例：**不判死**（在岗事实照旧、孤儿回收仍走代次判据），但**只读**——
   *     「过去合法」不换「今后可写」；要恢复写权走 `registry.assign` 的**迁移补登**
   *     （补缺的卡版本 / 委派归属，保留出生与登记时间，审计单列）；
   *  ③ 受控父判里的委派者也走这一个闸（父凭证不齐 ⇒ 子也写不了）。
   *
   * @param {object} subject @param {string} action
   * @returns {object|null} 拒绝结论；通过 / 不适用 ⇒ null
   */
  #凭证闸(subject, action) {
    if (action === 'read') return null;
    if (subject.kind !== 'Lead' && subject.kind !== '成员') return null; // 主权者/出厂作者/系统走各自天然凭证
    const member = this.state.identity?.members?.[subject.id];
    const 谁 = subject.kind === 'Lead' ? 'Lead 实例' : '成员实例';
    if (!member) {
      return deny(`v2 条目10 · ${谁}写需在册记录（fail-closed）`, `${谁} ${subject.id} 不在身份档案里：版本与在岗事实都查不到 ⇒ 写一律拒。只读诊断（status / workbench / audit_tail）不受影响。`, {
        requireAuthority: '机制',
        howToChange: '由 Lead 走 registry.assign 登记（成员）；Lead 由宿主入口按真实会话事实出生登记。不接受自报登记。',
        detail: { 实例: subject.id, 种类: subject.kind },
      });
    }
    if (member.status !== '在岗') {
      return deny(`v2 条目10 · ${谁}不在岗（写 fail-closed）`, `${谁} ${subject.id} 当前状态为 ${member.status ?? '状态缺失'}：封存/停用的实例没有写权，复岗走 registry_restore（显式还原，有留痕），不由写路径自动复活。`, {
        requireAuthority: 'Lead',
        howToChange: '由主权者或 Lead 走 registry_restore 复岗后再写；只读诊断不受影响。',
        detail: { 实例: subject.id, 状态: member.status ?? null },
      });
    }
    const 绑定代 = typeof member.代次 === 'string' ? member.代次 : member.代次?.代;
    const 本代 = this.state.identity?.boot?.代;
    const 绑定pid = member.代次?.pid ?? this.state.identity?.boot?.代次记录?.[绑定代]?.pid;
    // 即使启动回收被策略拒绝，也不能让已知异进程的旧绑定继续授权写。
    // 历史缺代次仍不猜死；同进程 HMR 的旧 UUID 不等于进程已死。
    const 异进程旧绑定 = 绑定代 && 本代 && 绑定代 !== 本代 && 绑定pid != null && 绑定pid !== process.pid;
    if (subject.kind === 'Lead' && (异进程旧绑定 || (member.运行绑定 && (member.运行绑定.状态 !== '有效'
      || 绑定代 !== 本代)))) {
      return deny('Lead 运行绑定失效（写 fail-closed）', '旧运行绑定不能授权写操作；由宿主核验真实根会话与岗位后续接，不恢复封存或撤权身份。', {
        requireAuthority: '机制', howToChange: '通过真实宿主会话续接本代；只读诊断仍可用。',
      });
    }
    // 补修J（2026-10-18 独立审计 · 第一处缺口）：**卡类型必须与实例真实主体一致**。
    // 修前这一闸只看「在岗 + 有摘要」，于是一个 kind=Lead 的根会话只要档案里背着
    // 一张成员卡（插件工程 / 复核员…）照样过写前闸——成员卡的规则面被当成 Lead 的用。
    // 判据单源：岗位 → 主体种类的映射只有 subjectKindForRole 一处，与不越授 / 不自授同尺。
    // 受控父判里的委派者走同一个 #evaluate ⇒ 父已降岗（档案岗位变成成员岗）时，
    // 即便它当初以 Lead 身份记下 `委派者.kind`，也在这里被拒，不能借原 kind 当 Lead。
    const 岗位 = typeof member.岗位 === 'string' && member.岗位 ? member.岗位 : null;
    if (!岗位) {
      return deny(`v2 条目10 · ${谁}档案岗位缺失（写 fail-closed）`, `${谁} ${subject.id} 的档案记录没有岗位：实例权限只来自岗位，没有岗位就没有可核的卡类型与规则面，写一律拒。只读诊断不受影响。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 走 registry.assign 登记到真实岗位（补登/换岗走正路），再重试。',
        detail: { 实例: subject.id },
      });
    }
    const 岗位种类 = subjectKindForRole(岗位);
    if (岗位种类 !== subject.kind) {
      return deny(`v2 条目10 · ${谁}主体种类与档案岗位不符（写 fail-closed）`, `${谁} ${subject.id} 以「${subject.kind}」身份执行 ${action}，但档案登记岗位是「${岗位}」（该岗位对应「${岗位种类}」）：卡类型必须与实例真实主体一致——根会话拿成员卡不能当 Lead，成员实例也不能借 Lead 卡。只读诊断（status / workbench / audit_tail）不受影响。`, {
        requireAuthority: '机制',
        howToChange: 'Lead 实例由宿主入口按真实会话事实出生登记；成员岗位由 Lead 派活登记。岗位对不上走 seal → assign 换岗正路，不接受自报换卡。',
        detail: { 实例: subject.id, 档案岗位: 岗位, 声称种类: subject.kind, 岗位对应种类: 岗位种类 },
      });
    }
    if (!member.卡版本?.摘要) {
      return deny(`v2 条目10 · ${谁}未钉卡版本（写 fail-closed）`, `${谁} ${subject.id} 的记录上没有钉住的卡版本摘要：规则面无法回答「凭哪一版」，写一律拒。`, {
        requireAuthority: '机制',
        howToChange: '由 Lead 走 registry.assign 做迁移补登（补当前卡版本，保留出生/登记时间，审计单列）；不由写路径自动补钉假装成功。只读诊断不受影响。',
        detail: { 实例: subject.id, 缺: '卡版本' },
      });
    }
    if (subject.kind === '成员' && !member.委派者?.id) {
      return deny('v2 条目20 · 成员缺委派归属（写 fail-closed）', `成员实例 ${subject.id} 的记录上没有委派者：父判无从进行，写一律拒（历史遗留不是新写的永久豁免）。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 走 registry.assign 做迁移补登（补当前委派归属）；成员不得自补。只读诊断不受影响。',
        detail: { 实例: subject.id, 缺: '委派归属' },
      });
    }
    // 补修J（2026-10-18 独立审计 · 第二处缺口）：**摘要字符串 != 凭证**。修前这一闸
    // 只查 `member.卡版本.摘要` 非空——任意一个 sha256 形状的字符串都能当凭证，快照
    // 里的正文 / 派生段 / 能力引用从未被告闸核对过。现在按真实内容验：岗位对齐、
    // 由声明版本 + 正文重算摘要、段与能力引用由正文重派生。坏证据不默用（写拒），
    // 也不在这里修/覆写（那是证据，处置走人工 + registry.assign 重新钉版）。
    const 卡面 = readVerifiedCardSnapshot(this.layout.cardSnapshot(member.卡版本.摘要), { 钉: member.卡版本, 期望岗位: 岗位 });
    if (!卡面.ok) {
      return deny(`v2 条目10 · ${谁}钉住的卡快照校验失败（写 fail-closed）`, `${谁} ${subject.id} 钉住的卡版本 ${String(member.卡版本.摘要).slice(0, 12)}… 内容校验不过：${卡面.原因}。摘要字符串本身不构成凭证——正文、派生段与能力引用必须能被同一把尺验回；坏证据不默用。只读诊断不受影响。`, {
        requireAuthority: '机制',
        howToChange: '由 Lead 走 registry.assign 重新钉当前卡（内容寻址快照会写新摘要）；不要手改快照（那是证据）；确需重建时先移走坏文件留档。',
        detail: { 实例: subject.id, 卡版本: member.卡版本.摘要 },
      });
    }
    return null;
  }

  /**
   * 第一层：宪章不变式。任何法律都改不动，因为它们是「组织给自己发合格证」这类
   * 结构性失效的唯一防线。
   */
  #invariants(subject, action, target, context) {
    const write = action !== 'read';
    // 缺省取最严档（2026-10-14 审查 P2-1，与 #evaluate 同口径）：缺标签 ≠ 低授权。
    const authority = target.authority ?? '宪章';

    if (action === 'approve') {
      // 提案人必须可知（2026-10-13 审查 P1-2）：缺席不是「没有提案人」，而是「证据不足」——
      // 之前 `context.proposerId && ...` 把缺席当「跳过检查」，是 fail-open；按宪章口径倒向拒绝。
      if (!context.proposerId) {
        return deny('宪章 §3.4 提案人必须可知', 'approve 动作必须携带 proposerId（提案人）：查不到提案人就无法验证「提案者不得自批」，按最严处理。', {
          requireAuthority: '宪章',
          howToChange: '调用方拼装判定上下文时带上提案人 id（proposerId）。',
        });
      }
      if (String(context.proposerId) === String(subject.id)) {
        return deny('宪章 §3.4 组织给自己发合格证', '提案者不得自批：本次提案人与批准人是同一个主体。', {
          requireAuthority: '宪章',
          howToChange: '换一个未参与提案的主体批准（复核者或主权者）。',
        });
      }
    }
    // §3.5「成员自扩权 / 再起成员」的准确边界：禁的是**给自己或别人扩权**，
    // 不是「成员不许产生任何对象」——成员把自己的作答与知识记下来是本职。
    // v2（口述收敛 2026-10-18 条目15）：**成员实例任务内也不得改能力库 / 角色卡引用**——
    // 「任务内全权」管的是任务产物（作答 / 经历 / 产出物），不是组织的可复用能力面与身份面。
    // 修前 `能力` 不在名单里，capability_publish 一路透传租务内的成员就真发出去了
    // （「成员不得直接写知识」那条同源缺口）。知识晋升走记忆类（类=知识）不受本闸管辖。
    const 建卡或扩权 = (action === 'create' && ['身份', '规则', '能力'].includes(target.kind))
      || (['write', 'delete'].includes(action) && ['身份', '规则', '能力'].includes(target.kind));
    if (subject.kind === '成员' && (建卡或扩权 || ['dispatch', 'propose', 'approve'].includes(action))) {
      return deny('宪章 §3.5 成员自扩权 / 再起成员', `成员不得执行 ${action}（${target.kind ?? '未知'}）：建卡、改能力库 / 角色卡、派活与提案都属于 Lead（v2 条目15：任务内也不得改能力库与角色卡引用）。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 执行该动作；成员只能在自己的任务节点内干活并留下作答与知识——值得蒸馏的点写进交卷的「知识候选」，由结账时 Lead 逐条判。',
      });
    }
    // 结账是 Lead 的收尾权（W3 批3）：它把节点收进终态**并**归档作答（归档后成员读不到），
    // 是一次影响面外溢到记忆面的决定。成员/复核者/系统/出厂作者一律拒；
    // 主权者不拒（§4：主权者随时可介入自治档——把他自己的机制挡在外面是另一回事）。
    if (action === 'settle' && !['Lead', '主权者'].includes(subject.kind)) {
      return deny('法律 结账是 Lead 的收尾权（§8 环路最后一步）', `${subject.kind} 不得结账：结账会把节点收进终态，并把该项目的作答归档（归档后成员不可读）。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 执行 task_settle；若结论有问题，先走复核（review）再决定采纳或打回。',
      });
    }
    // ── v2 口述收敛 2026-10-18（条目8/20）：三条结构性不变式 ────────────────────
    // 位置刻意放在 `#invariants` 里：它先于 `#grantRule` 求值 ⇒ 权限矩阵.md 里写一条
    // allow 也翻不过它们（授权块只能收紧方向，不能给这三条开口子）。
    // 服务层不再各写一份同名判据（registry.assign 里那份岗位名黑名单已删——判据抄在
    // 哪个入口里，就只有那个入口受保护，且两份一定会漂）。
    const 机制 = this.#机制不变式(subject, action, target, context, authority, write);
    if (机制) return 机制;
    const 自授 = this.#不自授(subject, action, target, context);
    if (自授) return 自授;
    const 越授 = this.#不越授(subject, action, target, context);
    if (越授) return 越授;
    if (authority === '只增' && ['write', 'delete', 'publish'].includes(action)) {
      return deny('宪章 §7 只增（主权者也不能改，只能追加更正）', `对象 ${target.id} 是只增账目，${action} 不被允许。`, {
        requireAuthority: '宪章',
        howToChange: '改用「追加更正」：新写一条更正记录指向原条目。',
      });
    }
    if (target.segment === '身份核心' && write && subject.kind !== '出厂作者') {
      return deny('宪章 §5 身份核心锁定', '身份核心不可就地改写：身份若能被就地改写，身份连续性就断了。', {
        requireAuthority: '出厂作者',
        howToChange: '身份核心随产品更新；本部署只能改个体 L1/L2/L3 段。',
      });
    }
    if (target.zone === '旧数据') {
      if (subject.kind === '主权者') return allow('宪章 §13 旧数据读权限（主权者可读）', '主权者随时可读旧数据，但它不接入检索面。');
      if (subject.kind === 'Lead') {
        return confirm('宪章 §13 旧数据读权限（Lead 需单次授权）', 'Lead 读旧数据需要主权者单次授权。', {
          requireAuthority: '主权者',
          howToChange: '由主权者针对本次读取给出单次授权。',
        });
      }
      return deny('宪章 §13 旧数据读权限', `${subject.kind} 不可读旧数据。`, {
        requireAuthority: '主权者',
        howToChange: '旧数据原地只读、不接入检索面；确需内容请主权者导出。',
      });
    }
    // 升级裁决通道（主权者裁决 2026-10-08）：不开主权者身份通道，改允许 Lead
    // 对**法律档规则件**执行 publish（裁决/撤回遗留挂起项）。自我约束：Lead 仅在主权者
    // 授意时行使（裁决已入审计与记忆）。宪章档（安全类）与 delete 仍主权者专属。
    const 升级裁决通道 = subject.kind === 'Lead' && action === 'publish' && target.kind === '规则' && authority === '法律';
    if (['delete', 'publish'].includes(action) && subject.kind !== '主权者' && !升级裁决通道) {
      return deny('宪章 §3.2 未经主权者的删除 / 发布 / 批量覆盖', `${subject.kind} 不得执行 ${action}。`, {
        requireAuthority: '主权者',
        howToChange: '改为提交提案（propose），由主权者发布或删除。',
      });
    }
    if (action === 'rollback' && target.textVersion === true && subject.kind !== '主权者') {
      return deny('宪章 §4 只有主权者能回滚文本版本', '文本版本回滚是主权者专属动作。', {
        requireAuthority: '主权者',
        howToChange: '注意：回滚的是文本，不是世界；机制回滚是另一回事。',
      });
    }
    return null;
  }

  // ── v2 口述收敛 2026-10-18 不变式（条目8 / 条目20） ──────────────────────────

  /**
   * 条目8：**系统只做封闭清单内的机制动作**。
   *
   * 修前的事实：`#tierRule` 的自治档最后一行是 `return allow(...)`——落在那里的非成员主体
   * 一律放行，`kind:'系统'` 因此是一条万能写权限后门（谁能拼出这个主体，谁就有全权）。
   * 本条把它收窄成：系统写动作必须声明清单内的「机制动作」，且动作 / 授权档 / 目标类
   * 三元组与清单项逐项相等。清单住在 `src/mechanism.js`（唯一一份）。
   *
   * 三条边界如实写清：
   *  ① **只读写面**：只读投影（bus.summary 等）用系统主体，读不构成扩权，不收；
   *  ② **不豁免失联冻结与介入度审批**：本条只判「是不是机制动作」，之后 presence 闸与
   *     `#preGrantBoundary` 照常求值——机制维护不是「主权者不在也能改治理」的许可证；
   *  ③ **主体来源必须可信**：模型面只有 `agentSubject(exec)`（宿主会话事实）一条路，
   *     `args.role` / `args.实例` 自报在 runAction 入口即拒（见 lib/actions.js）。
   *     所以「清单封闭」+「入口唯一」合起来才成立；少一条就有穿闸口子（有回归钉着）。
   *
   * @param {object} subject @param {string} action @param {object} target @param {object} context
   * @param {string} authority @param {boolean} write
   */
  #机制不变式(subject, action, target, context, authority, write) {
    if (subject.kind !== '系统') return null;
    if (!write) return null;
    if (subject.id !== MECHANISM_SUBJECT.id) {
      return deny('v2 条目8 · 系统主体唯一形状', `系统主体的 id 必须是「${MECHANISM_SUBJECT.id}」（收到 ${subject.id}）：机制动作要在账上与任何实例 id 分得开，换一个 id 就是换一个万能身份。`, {
        requireAuthority: '宪章',
        howToChange: `机制代码用 src/mechanism.js 的 MECHANISM_SUBJECT / 机制主体() 构造系统主体，不要自拼 id。`,
      });
    }
    const 机制名 = context?.机制动作;
    if (!机制名) {
      return deny('v2 条目8 · 系统只做机制动作（封闭清单）', `系统主体发起写动作 ${action}（${authority} 档 / ${target.kind ?? '未知'}）却没有声明「机制动作」：系统不是任意写权限的后门，清单外的系统写一律拒。`, {
        requireAuthority: '宪章',
        howToChange: `由机制代码传 context.机制动作（清单：${MECHANISM_NAMES.join(' / ')}）；人 / 组织的写请改用真实主体执行。`,
      });
    }
    if (!mechanismAllows(机制名, action, authority, target.kind)) {
      return deny('v2 条目8 · 机制动作越出封闭清单', `机制「${机制名}」不覆盖 ${action} / ${authority} 档 / ${target.kind ?? '未知'}：清单项是固定的三元组，换动作、换档、换目标类都算开新权限。`, {
        requireAuthority: '宪章',
        howToChange: `用清单内的机制名与其固定三元组（见 src/mechanism.js）；确有新机制动作 ⇒ 由主权者扩清单并补回归。`,
      });
    }
    return null;
  }

  /**
   * 条目20：**不自授**——主体不得给自己扩权。
   *
   * 判的是**扩张集合**，不是「不许登记自己」（修前 registry 里那条按名字的黑名单既误拒
   * 幂等登记、又只挡得住冒充 Lead 这一种形态）。扩张集合由服务层用同一份比较实现算出
   * （`registry.扩张集合`），经 `context.扩张集合` 传进来：
   *  - `[]`（同权限 / 幂等登记）⇒ 放行，**不写盘也不记审计**（幂等路径本来就这样）；
   *  - 非空 ⇒ 拒，并把扩张项列给调用方；
   *  - **缺席 ⇒ 拒**（fail-closed）：无法证明「这不是扩权」时不许放行——
   *    「拿不到上游范围就放行」正是要堵的那条路。
   *
   * 为什么不在这里自己算：算扩张要读岗位卡（IO）与现职档案，而本方法是同步判定本体；
   * 硬算就得在这里复制一份 `canTouch` —— 两份判据一定漂。比较函数放注册表层（有真源），
   * 判定结构放这里（grant 翻不过来），两边各管一段。
   */
  #不自授(subject, action, target, context) {
    if (!['create', 'write'].includes(action)) return null;
    if (target.kind !== '身份') return null;
    if (String(target.id) !== String(subject.id)) return null;
    // 主权者写自己的档案不构成「扩权」（它已在最高处）；系统已被 #机制不变式 收口。
    if (['主权者', '系统'].includes(subject.kind)) return null;
    const 扩张 = context?.扩张集合;
    if (!Array.isArray(扩张)) {
      return deny('v2 条目20 · 不自授（扩张集合不可判）', `主体 ${subject.id} 正在写自己的身份记录（${action}），但本次调用没有携带「扩张集合」判定：拿不出「权限没有变大」的证据，就按扩权处理（fail-closed）。`, {
        requireAuthority: '宪章',
        howToChange: '由服务层（registry）用同一份扩张集合比较算出前后权限面差异放进 context.扩张集合；同权限的幂等登记得到空集，照样放行。',
      });
    }
    if (扩张.length > 0) {
      return deny('v2 条目20 · 不自授', `主体 ${subject.id} 给自己的身份记录带来 ${扩张.length} 项扩张：${扩张.slice(0, 5).join('、')}${扩张.length > 5 ? '…' : ''}。主体不得给自己扩权（宪章⑤的推广）。`, {
        requireAuthority: 'Lead',
        howToChange: '扩权由别人执行：岗位登记由 Lead（成员岗）或主权者发起；同权限的重复登记不受影响（幂等放行）。',
        detail: { 扩张集合: 扩张.slice(0, 20) },
      });
    }
    return null;
  }

  /**
   * 条目20：**不越授**——Lead 派活的写域 / 工具不得超出自身范围。
   *
   * ⚠️ **本方法的覆盖边界（如实登记，不写成「已完成」）**：
   *  ① **主体种类**（已落）：派活造出的主体不得与 Lead 同级或更高。这一格不需要枚举：
   *     岗位 → 主体种类是封闭映射（`subjectKindForRole`），种类里本就含「包含关系」。
   *  ② **组织对象写域子集**（**未落，缺口已报**）：本组织目前**没有**「目标类 × 授权档」任务写域凭证——
   *     任务节点只有描述 / 判据（自由文本）与负责人，`target` 上的 authority/kind 说的是
   *     **这次调用**的目标，不是「派出去的活可以在哪些格子里写」。没有真凭证就判不出子集，
   *     所以这里**不判**，也绝不拿两个自造模板冒充「全部写域」（那会把同种类不同岗位 /
   *     不同项目的差异一起丢掉，得到的是虚假通过）。最小字段方案已交 Lead 定：
   *     任务节点声明封闭的 `写域`（目标类 × 授权档）并在派发时随判据一起冻结，
   *     派活时逐项用同一次判定求 Lead 自身是否可行（一项一次判定，不枚举矩阵）。
   *  ③ **工具面**（机制性成立）：工具总范围是**进程级**配置（宿主 guard 对任何主体同一份），
   *     派活拿不到、也扩不了工具面；因此「给成员额外工具」只能来自调用方多传一个工具范围
   *     参数——那属于「拿不到上游工具范围却扩张」，member_spawn 侧直接响亮拒（见 lib/actions.js）。
   *
   * 通用文件工具边界已另由 tool-file-scope.js 实现：部署者给 Lead 可授根上限，任务派发
   * 冻结读写子集，宿主同步 guard 按真实绑定验证；文件根不替代这里的组织对象标签权限。
   * 结论：①③ 承重，② 是组织对象标签域的缺口。判据只落能承重的部分，剩下的报缺口等字段——这是本方法
   * 刻意不做的事，别在别处补一个看起来像的。
   */
  #不越授(subject, action, target, context) {
    if (subject.kind !== 'Lead') return null;
    const 排兵写 = action === 'write' && target.kind === '任务'
      && (context?.节点操作 === 'reassign' || (context?.节点操作 === 'bind' && context?.实例绑定 === true));
    if (!['create', 'dispatch'].includes(action) && !排兵写) return null;
    const 被派 = this.#被派主体(subject, action, target, context);
    if (!被派.ok) {
      return deny('v2 条目20 · 不越授（范围不可判）', 被派.reason, {
        requireAuthority: 'Lead',
        howToChange: '先让被派主体可判：登记实例（registry_assign）或按岗位名派给该岗在岗实例，再派活；拿不到上游范围时不放行。',
      });
    }
    const 同级或更高 = 被派.rows.filter((row) => row.自领 !== true && 职权级(row.kind) >= 职权级('Lead'));
    if (同级或更高.length > 0) {
      return deny('v2 条目20 · 不越授', `Lead 派活不得造出平级或更高的主体：${同级或更高.map((r) => `${r.名}（${r.kind}）`).join('、')} 不在 Lead 的范围之内（Lead 派活的写域不得包含 Lead / 主权者 / 出厂作者）。`, {
        requireAuthority: '主权者',
        howToChange: 'Lead 只派成员岗位卡（集体L3）；需要 Lead 级主体的实例由机制（系统）在会话出生时登记，主权者级由主权者本人执行。',
        detail: { 被派: 被派.rows.map((r) => ({ 名: r.名, kind: r.kind })) },
      });
    }
    // ② 写域子集：没有真凭证 ⇒ 不判（**不**用模拟面冒充）。调用方若显式声明了要扩张写域，
    // 那就是「拿不到上游范围却扩张」——按 fail-closed 拒，而不是放行。
    const 写域 = context?.写域 ?? null;
    if (写域 !== null) {
      return deny('v2 条目20 · 不越授（写域扩张无上游范围可核）', `本次调用声明了任务写域 ${JSON.stringify(写域)}，但本部署尚无「任务写域」字段可与之对照：拿不到上游范围就扩张 = 越授，按最严拒（不猜全集、不放行）。`, {
        requireAuthority: 'Lead',
        howToChange: '任务写域字段落地前，派活不要声明写域扩张；字段落地后按其封闭清单逐项核对。',
        detail: { 写域 },
      });
    }
    return null;
  }

  /**
   * 条目20 · 不越授的**受控父判**（2026-10-18 专批）。
   *
   * 一句话：**成员写动作必须在它的委派者权限面之内**——用同一次真实的 `action / target /
   * context`，只把主体换成委派者再判一次。
   *
   * 为什么是这个形状（三条都是被否过的方案的替代）：
   *  - 不枚举 ACTIONS × 四档 × 目标类，也不造「两格模拟模板」：那测的是我**猜**的权限矩阵，
   *    与真实判定会漂；
   *  - 不新增授权对象：委派者就记在实例绑定里（`registry.assign` 落 `委派者 {id, kind, 卡版本}`），
   *    天然载体已经够用；
   *  - 闸用**实例私有字段** `#父判中`，不由 `context` 开合 ⇒ 模型侧构造入参也关不掉。
   *
   * 三条语义：
   *  ① 父判 **deny** ⇒ 子也 deny（派活不能派自己没有的权）；
   *  ② 父判 **confirm** ⇒ 子也 confirm（**确认门槛必须传播**：子不能凭自己的 allow 绕过
   *     委派者那边需要的主权者放行）；
   *  ③ 只判一次、不递归：父判期间再次进入直接跳过 ⇒ 链长恒为 1，不会从子判里长出孙授权。
   *
   * 边界（如实）：
   *  - 只判**成员**、只判**写**动作；读面由作用域规则管（读不构成扩权）；
   *  - **历史实例没有 `委派者` 记录** ⇒ 不做父判（与「未钉卡版本」同类历史缺口，记为残余）；
   *  - 委派者查不到 / 不在岗：父判会按自己的规则给出确定答案（查不到 = 最严），不是「跳过」。
   */
  #受控父判(subject, action, target, context) {
    if (subject.kind !== '成员') return null;
    if (action === 'read') return null;
    if (this.#父判中) return null;
    const 委派者 = this.state.identity?.members?.[subject.id]?.委派者 ?? null;
    if (!委派者?.id) return null; // 历史实例：没有父记录 ⇒ 明确残余，不猜
    const 父 = {
      id: String(委派者.id),
      kind: String(委派者.kind ?? '未知'),
      ...(委派者.卡版本 ? { 卡版本: String(委派者.卡版本) } : {}),
    };
    this.#父判中 = true;
    let 结论;
    try {
      结论 = this.#evaluate({ subject: 父, action, target, context });
    } finally {
      this.#父判中 = false;
    }
    if (结论.verdict === 'deny') {
      return deny('v2 条目20 · 不越授（受控父判）', `委派者 ${父.id}（${父.kind}）在该动作 / 目标上没有这个权（${结论.rule}）：派活不能派自己都没有的权，子实例不得超出委派者的权限面。`, {
        requireAuthority: 结论.requireAuthority ?? 'Lead',
        howToChange: '让有该权的身份执行；或由主权者给委派者补授权后重试（授权只能加在委派者那一层，不能只给子实例）。',
        detail: { 委派者: 父.id, 父判规则: 结论.rule, 父判理由: 结论.reason },
      });
    }
    if (结论.verdict === 'confirm') {
      // 校准（2026-10-18 · Lead 真链反例）：父判的 confirm 可能只是「介入度」这一道。
      // 若本次子写对得上主权者已批准的计划步，就不再把**同一真实父**的重复确认传播下去
      // ——否则子请求的批准会被父的同一 confirm 卡死。父判只 peek、不消费（真正的子判定点
      // 才消费那一步）。父 deny / 故障 / 其它类 confirm 照旧传播；父卡失效会先落到 deny 路径。
      if (/^法律 介入度 · /.test(String(结论.rule ?? '')) && 本次放行可匹配(subject, action, target, context)) {
        return null;
      }
      return confirm('v2 条目20 · 不越授（父判确认门槛传播）', `该动作在委派者 ${父.id} 那里要先经主权者放行（${结论.rule}）：子实例不能凭自己的 allow 绕过这道确认门槛。`, {
        requireAuthority: 结论.requireAuthority ?? '主权者',
        howToChange: '先按委派者那条路径完成放行，再由子实例重试；或把本次动作改由委派者自己执行。',
        detail: { 委派者: 父.id, 父判规则: 结论.rule, 父判理由: 结论.reason },
      });
    }
    return null;
  }

  /**
   * 派活的**被派主体**解析：谁来接这份活、它是什么主体种类。
   *
   * 实例登记读声明岗位；派发、实例绑定与改派读任务图在账本锁内生成的真实候选节点。
   * 岗位名 Lead 不等于当前实例：只有该岗实际绑定全是本人且档案对齐才是自执行。
   * 绑定也逐项判，防止先自领派发再加绑或改派，把外派藏在负责人岗位名后面。
   * 其余形态不产出被派主体（例如写岗位卡文档：那是改卡，不是派活）。
   *
   * @returns {{ok: true, rows: Array<{kind: string, 名: string, 自领?: boolean}>} | {ok: false, reason: string}}
   */
  #被派主体(subject, action, target, context) {
    if (action === 'create') {
      if (target.kind !== '身份' || context?.身份操作 !== '实例') return { ok: true, rows: [] };
      // 给自己登记自己的记录不是「派活」，是「自己写自己」——那一格归 `#不自授` 判，
      // 不在这里按种类拦（否则「同权限的幂等登记放行」永远走不到）。
      if (String(target.id) === String(subject.id)) return { ok: true, rows: [] };
      const 岗位 = typeof target.岗位 === 'string' ? target.岗位.trim() : '';
      // 没声明岗位 = 没有「被派给谁」的声明可判（不是「范围未知」）。真实登记入口
      // `registry.assign` 强制要求岗位、空岗位直接抛，所以这条不构成绕道；
      // 这里放行是为了让 policy_check 之类的预检不被无关的缺席字段打成假红。
      if (!岗位) return { ok: true, rows: [] };
      return { ok: true, rows: [{ kind: subjectKindForRole(岗位), 名: `岗位 ${岗位}` }] };
    }
    const 负责人 = normalizeList(context?.task?.负责人 ?? target.负责人 ?? []);
    if (负责人.length === 0) return { ok: true, rows: [] };
    const 绑定 = context?.task?.绑定 ?? [];
    const Lead绑定 = 绑定.filter((b) => b?.岗位 === 'Lead');
    const 本人自领岗 = Lead绑定.length > 0 && Lead绑定.every((b) => b.实例 === subject.id)
      && this.#档案岗位Of(subject.id) === 'Lead';
    const rows = [];
    for (const id of 负责人) {
      if (id === String(subject.id) || (id === 'Lead' && 本人自领岗)) {
        rows.push({ kind: 'Lead', 名: `自领 ${id}`, 自领: true });
        continue;
      }
      const 岗位 = this.#岗位Of(id);
      // 查不到在岗岗位 ⇒ 这里不做范围判断（座次归任务图派发闸）；能查到就必须判。
      if (!岗位) continue;
      rows.push({ kind: subjectKindForRole(岗位), 名: `${id}@${岗位}` });
    }
    for (const b of 绑定) {
      const 档案岗位 = this.#档案岗位Of(b?.实例);
      // 旧绑定可能已封存或变岗；声明与现档任一指向高权都不能被低权那一边掩盖。
      for (const 岗位 of new Set([b?.岗位, 档案岗位].filter(Boolean))) {
        rows.push({ kind: subjectKindForRole(岗位), 名: `绑定 ${b?.实例}@${岗位}`,
          自领: b?.实例 === subject.id && b?.岗位 === 'Lead' && 档案岗位 === 'Lead' });
      }
    }
    return { ok: true, rows };
  }

  /** 实例 id 或岗位名 → 在岗岗位名（判据面 = 身份档案真源，与 scopeOf 同一份）。 */
  #岗位Of(id) {
    const 直 = this.#档案岗位Of(id);
    if (直) return 直;
    for (const member of Object.values(this.state.identity?.members ?? {})) {
      if (member?.status === '在岗' && member?.岗位 === id) return id;
    }
    return null;
  }

  /**
   * 授权块之前的结构性边界（P1-05 · 全面审查 2026-10-17；v2 复核者降级 2026-10-18）。
   *
   * 单一实现：复核员岗只读 / 实验沙箱、以及介入度对自治写的 confirm——这两条原在
   * `#tierRule` 里，但 tier 在 grant 之后 ⇒ allow grant 可绕过。现在前移到 grant 之前；
   * `#tierRule` 不再重复判它们（否则同一条边界有两份实现）。
   *
   * v2（口述收敛 2026-10-18 条目1）：复核员是普通岗位卡，不再是主体类——
   * 边界按**岗位名**（subject.roleId）判，与主体种类脱钩。
   */
  #preGrantBoundary(subject, action, target, authority, write, context) {
    if (subject.roleId === '复核员') {
      // v2 条目11（W7）：复核实例有**自己的复核任务节点**（绑在它名下），要能对自己的节点
      // 走受限生命周期（开工 → 交卷报告）。这不是按 role 全局豁免：判据是「这个节点绑定里
      // 有我这个实例」，没有绑定就一步也不放。被复核的业务节点负责人仍是执行者——
      // 复核实例不占那个位置（否则与冲突排除自相矛盾）。
      const 我绑的节点 = (context?.task?.绑定 ?? []).some((b) => String(b?.实例) === String(subject.id));
      // 判据读 `context.节点操作`（不是 action）：所有节点写都走同一个 action='write' 的判定点，
      // 「这次是开工还是交卷」由任务图的 #checkWrite 标注传进来——少了这一位，就只能按 role
      // 全局豁免（那是错的），等于把整类写动作一起放开。
      const 节点操作 = String(context?.节点操作 ?? '');
      const 受限生命周期 = 我绑的节点 && ['start', 'submit'].includes(节点操作);
      // 「只读数，不改，不参与提案」的准确边界：不许改被验对象；结论是只增证据。
      if (action === 'experiment') {
        if (target.sandbox !== true) {
          return deny('复核员岗 · 需要落盘的实验走沙箱区', '复核员的落盘实验必须落在沙箱区：单独授权、不进持久状态、任务结束即清。', {
            requireAuthority: '主权者',
            howToChange: '把实验放进沙箱区（target.sandbox = true），或改由成员在任务内执行。',
          });
        }
      } else if (!['read', 'review'].includes(action) && !受限生命周期) {
        return deny('复核员岗 · 只读数，不改，不参与提案（按岗位名判定）', `复核员不得执行写动作 ${action}：它不改被验对象，也不派活、不提案${我绑的节点 ? '' : '（本节点没有绑定该复核实例，受限生命周期也不放行）'}。`, {
          requireAuthority: '主权者',
          howToChange: '复核结论经 review 落账（只增证据）；需要改动由 Lead 按结论执行。',
        });
      }
    }
    // 会审参与实例的写面边界已前移到 #evaluate（受控父判之前）：业务写要"确定拒绝"，
    // 不能被父判的介入度 confirm 降级成"挂起等批"；这里是复核者只读与介入度边界。
    // 介入度只影响自治档（§4）：立宪/立法/否决/撤回不受影响；主权者不受影响。
    // v2（口述收敛 2026-10-18 条目14/17/24）：三档——放权=自治写直接落盘留痕；
    // 预审=高风险清单动作（写死，见 #预审高风险）挂起等主权者放行，低风险直落；
    // 审批=每条自治写都等放行。被拦的写不落地：decide() 把 confirm 记入审计
    // （策略拒绝 · 需确认 · detail.介入挂起），工作台「待你决定」从那里投影。
    if (write && authority === '自治' && subject.kind !== '主权者') {
      const level = this.intervention();
      const 会挂起 = level === '审批' || (level === '预审' && this.#预审高风险(action, target, context));
      if (会挂起) {
        // v2 条目14/17（2026-10-18 补修F）：主权者「逐请求」放行后，原申请者按**冻结请求**
        // 重放。这里只解除介入度这一道 confirm 门，而且必须对上**步骤计划里的某一步**
        // （底层的 动作+目标 kind；新建对象的步不认 id，既有对象认 id；每步按次数限量）。
        // 宏动作名（task_create / member_spawn / task_settle）从不参与匹配——它与底层策略
        // 动作名不同，拿宏名匹配会永远对不上、死循环。其余硬闸（不变式/拒名单/失联/
        // 复核员只读/父域/硬拒）在此之前已判完，审批不能绕过它们；放行上下文不进持久状态。
        const 放行匹配 = 本次放行匹配(subject, action, target, context);
        if (放行匹配) {
          return allow(
            '法律 介入度 · 已批准放行（§4/v2 条目14/17）',
            `本部署介入度为「${level}」：该自治写对上主权者已批准的步骤计划（请求 ${放行匹配.请求id} · 第 ${放行匹配.序} 步${放行匹配.说明 ? `：${放行匹配.说明}` : ''}）${放行匹配.重复 ? '（同一次业务写的重复检查，不再消耗）' : ''}，本次按冻结请求重放；其余硬闸照判。`,
          );
        }
        if (level === '预审') {
          return confirm('法律 介入度 · 预审（§4）', '本部署介入度为「预审」：高风险自治写（改岗位卡 / 发布能力 / 物理删除记忆 / 改设置）先停在「待你决定」，主权者放行后才落盘。', {
            requireAuthority: '主权者',
            howToChange: '放行 = 主权者本人处置该写；或把 部署.json 介入度改为「放权」后重试原动作。本次请求已挂起，工作台「待你决定」可见。',
            detail: { 介入挂起: true, 档位: '预审', 动作: action, 目标: 目标摘要(target) },
          });
        }
        return confirm('法律 介入度 · 审批（§4）', '本部署介入度为「审批」：每条自治写都先停在「待你决定」，主权者放行后才落盘。', {
          requireAuthority: '主权者',
          howToChange: '放行 = 主权者本人处置该写；或把 部署.json 介入度改为「放权 / 预审」后重试原动作。本次请求已挂起，工作台「待你决定」可见。',
          detail: { 介入挂起: true, 档位: '审批', 动作: action, 目标: 目标摘要(target) },
        });
      }
    }
    return null;
  }

  /**
   * 预审档「高风险」= 按动作类型写死的清单（v2 口述收敛 2026-10-18 条目24）：
   * 改岗位卡 / 发布能力 / 物理删除记忆 / 改设置。清单写死，好判好审；要扩清单 = 改设置（主权者动作）。
   * 身份档里「实例登记」（registry_assign 起实例）不算改卡——它是派活的常规一步，
   * 由服务层在 context.身份操作 里自证；写/新建**卡文档**（store.write）才算改岗位卡。
   */
  #预审高风险(action, target, context) {
    if (!target) return false;
    if (target.kind === '身份' && (action === 'write' || (action === 'create' && context?.身份操作 !== '实例'))) return true;
    if (target.kind === '能力' && (action === 'create' || action === 'write')) return true;
    if (target.kind === '记忆' && action === 'write' && context?.状态 === '物理删除') return true;
    if (target.kind === '设置' && (action === 'create' || action === 'write')) return true;
    return false;
  }

  /** 其余三档默认（立宪 / 立法 / 自治）：结构性边界与授权块之后才轮到它。 */
  #tierRule(subject, action, target, authority, context) {
    // 复核者只读边界已前移到 #preGrantBoundary（P1-05）：tier 不再重复判，
    // 否则同一条边界会有两份实现（且 grant 仍能抢先）。
    if (authority === '宪章') {
      if (subject.kind === '主权者') return allow('法律 权限矩阵 · 宪章档', '宪章由主权者主导并确定。');
      if (subject.kind === 'Lead' && action === 'draft') {
        return allow('法律 权限矩阵 · 宪章档（Lead 只协助起草）', 'Lead 可协助起草，修宪不可发起。');
      }
      return deny('法律 权限矩阵 · 宪章档（Lead 不许发起修宪）', `${subject.kind} 不得对宪章执行 ${action}。`, {
        requireAuthority: '主权者',
        howToChange: 'Lead 只能协助起草；立宪与修宪由主权者主导并确定。',
      });
    }
    if (authority === '法律') {
      if (subject.kind === '主权者') return allow('法律 权限矩阵 · 法律档', '法律由主权者确定。');
      if (subject.kind === 'Lead' && action === 'propose') {
        return allow('法律 权限矩阵 · 法律档（Lead 可提议修法）', 'Lead 可提议修法，确定权在主权者。');
      }
      if (subject.kind === 'Lead' && action === 'read') return allow('法律 权限矩阵 · 法律档', '法律可读。');
      if (subject.kind === 'Lead' && action === 'publish' && target.kind === '规则') {
        return allow(
          '法律 权限矩阵 · 法律档 · 升级裁决通道（主权者裁决 2026-10-08）',
          'Lead 可对规则件执行裁决类发布（upgrade_resolve / upgrade_withdraw）。自我约束：仅在主权者授意时行使。',
        );
      }
      return deny('法律 权限矩阵 · 法律档', `${subject.kind} 不得对法律执行 ${action}。`, {
        requireAuthority: '主权者',
        howToChange: 'Lead 提议（propose）后由主权者确定；法律默认文本与用户改动走叠加层合并。',
      });
    }
    if (authority === '只增') {
      // 只增档的语义就是「只能追加」：追加（create）与读取放行，
      // 改写 / 删除 / 发布由宪章不变式先一步拒绝（主权者也不例外）。
      if (action === 'create') return allow('法律 权限矩阵 · 只增档', '只增对象允许追加；改写与删除由宪章不变式拒绝。');
      if (action === 'read') return allow('法律 权限矩阵 · 只增档', '只增对象可读。');
      return deny('法律 权限矩阵 · 只增档', `只增对象不支持 ${action}：它只能被追加。`, {
        requireAuthority: '宪章',
        howToChange: '改用 create 追加一条更正记录，指向原条目。',
      });
    }
    if (authority === '自治') {
      if (subject.kind === '主权者') return allow('法律 权限矩阵 · 自治档', '主权者随时可介入自治档。');
      if (subject.kind === '成员' && subject.roleId !== '复核员') {
        // v2（条目18）：会审退出任务图后会审答案没有任务上下文可挂——会审参与者的
        // 作答/发言权按「在 context.会审.参与者 名单里」判（名单由 CouncilService 从
        // 自己的事件流折出来，不信自报）。不在名单 ⇒ 落到下面的「任务外无」照样拒。
        if (target.kind === '会审') {
          const 会审 = context.会审 ?? null;
          if (action !== 'read' && !(会审 && (会审.参与者 ?? []).includes(subject.id))) {
            return deny('法律 权限矩阵 · 自治档（会审名单外无）', `成员 ${subject.id} 不在会审 ${target.id ?? ''} 的参与者名单里：会审作答/发言只限被点名的参与者。`, {
              requireAuthority: 'Lead',
              howToChange: '会审参与者由 Lead 在发起时点名；要参与请 Lead 发起时把你列入参与者。',
            });
          }
          return allow('法律 权限矩阵 · 自治档（会审参与者）', '会审参与者在名单内：作答/发言放行（类型闸/预算闸在服务层）。');
        }
        // 「任务外无」管的是**权**，不是**读**：成员读自己岗位的知识与能力是干活的前提。
        // 复核员岗（roleId=复核员）跳过本闸：它的全部边界已由 #preGrantBoundary 按岗位名
        // 收紧为只读+review，且复核本就不挂在任务负责人名单上（scopeOf 会把它恒拒）。
        const scoped = this.scopeOf(subject, context.task ?? target.task ?? null);
        if (!scoped.ok && action !== 'read') return deny('法律 权限矩阵 · 自治档（任务外无）', scoped.reason, {
          requireAuthority: 'Lead',
          howToChange: '在本次调用的入参里声明任务上下文（带上你名下任务节点的 id，如 memory_write / memory_lifecycle 传「任务」）；名下没有已派发/执行中的节点时，由 Lead 先派发。',
        });
      }
      // 介入度 confirm 已前移到 #preGrantBoundary（P1-05）：走到这里的自治写只剩
      // 放权档（或预审档的低风险动作）——直落、留痕、事后可查可否决。
      return allow(
        '法律 介入度 · 放权（§4）',
        '自治档由组织自决，主权者默认不参与；留痕必须完整，事后可查可否决。',
      );
    }
    return null;
  }

  /** 授权块：在复核者/介入度边界之后、其余三档默认之前生效。 */
  #grantRule(subject, action, authority, target) {
    for (const grant of this.grants) {
      if (grant.subject !== subject.kind) continue;
      if (grant.action !== action) continue;
      if (grant.authority && grant.authority !== authority) continue;
      if (grant.kind && grant.kind !== target.kind) continue;
      if (grant.verdict === 'deny') {
        return deny(`法律 权限矩阵 grant#${grant.index}`, grant.reason ?? `法律显式禁止 ${subject.kind} 对 ${authority} 档执行 ${action}。`, {
          requireAuthority: grant.requireAuthority ?? '主权者',
          howToChange: '修改 权限矩阵.md 中对应的 grant。',
        });
      }
      if (grant.verdict === 'confirm') {
        return confirm(`法律 权限矩阵 grant#${grant.index}`, grant.reason ?? `法律要求该动作先获确认。`, {
          requireAuthority: grant.requireAuthority ?? '主权者',
          howToChange: '由相应授权人确认后重试。',
        });
      }
      return allow(`法律 权限矩阵 grant#${grant.index}`, grant.reason ?? '法律授权块显式允许。');
    }
    return null;
  }

  /** 撤回名单命中（只挡新写入，不删卡）。对象被撤回 ⇒ 挡；主体自身被撤回 ⇒ 也挡。 */
  #isDenied(subject, target) {
    if (subject.kind === '主权者') return false;
    const list = this.state.identity?.denylist ?? [];
    return list.some((entry) => entry.id === target.id || entry.id === subject.id);
  }

  // ── 加载 ────────────────────────────────────────────────────────────────────

  async #loadRules() {
    /** @type {Array<{id:string, authority:string, zone:string, text:string, digest:string, path:string}>} */
    const rules = [];
    const digests = {};
    for (const spec of RULE_FILES) {
      // R18（审查 2026-10-16）：**两侧都读、段级合并**。修前找到私有文件就 break——
      // 「私有叠加层、未改条款继承出厂」的解释与运行态不符（报告实证：私有只定制无关段
      // ⇒ 出厂限制条款消失、请求误 allow）。现在私有同名段覆盖出厂，未出现的段继承出厂；
      // 生效文档由 effectiveDocument 单源产出（与 upgrade.compare 的条款级口径同源）。
      const 私有路径 = this.layout.rulePath(spec.id, '私有');
      const 出厂路径 = this.layout.rulePath(spec.id, '出厂');
      const 私有文本 = 私有路径 ? await this.#readAuth(私有路径) : null;
      const 出厂文本 = 出厂路径 ? await this.#readAuth(出厂路径) : null;
      if (私有文本 === null && 出厂文本 === null) {
        // 宪章缺失 = 没有判据来源 = fail-closed（§7 加载失败 fail-closed）。
        throw new Error(`规则件缺失：${spec.id}（私有区与出厂区都没有）`);
      }
      const 生效 = effectiveDocument(出厂文本, 私有文本, { defaultAuthority: spec.authority, 出厂标为: '出厂', 私有标为: '私有' });
      if (生效.errors?.length) {
        throw new Error(`规则件 ${spec.id}（${生效.合并来源}）无法解析：${生效.errors.join('；')}`);
      }
      const found = {
        id: spec.id,
        authority: spec.authority,
        // zone 取实际来源层：只私有 ⇒ 私有；只出厂 ⇒ 出厂；两侧都有 ⇒ 合并（新档，用于
        // 描述里如实标注生效面，不再谎称「整份来自私有」）。
        zone: 私有文本 !== null && 出厂文本 !== null ? '合并' : (私有文本 !== null ? '私有' : '出厂'),
        text: 生效.body,
        digest: digest(生效.body),
        path: 私有文本 !== null ? 私有路径 : 出厂路径,
        parsed: 生效,
        生效来源: 生效.合并来源,
      };
      rules.push(found);
      digests[spec.id] = found.digest;
    }
    return { rules, digests };
  }

  /**
   * 默认值合并：**低 → 高**，同一区内后读的赢。
   *
   *  ① 内置兜底（下面 `merged` 的初值 —— 整块出厂区都丢了也还有一份能跑的默认；
   *     兜底值引用 `src/kernel/time.js` 的 `BUILTIN_RESPONSE_DEADLINE_HOURS`，**不在这里另写一份 72**）
   *  ② 出厂 `介入度.json`（只承载介入度）
   *  ③ 出厂 `响应期限.json`（`失联限制` / `响应期限小时` 的唯一出厂源）
   *  ④ 出厂 `安全类探针.json`（安全类探针声明）
   *  ⑤ 私有 `部署.json`（**最后覆盖**，全键统一 —— 主权者改的那份优先级最高，`安全类` 也不例外）
   *
   * **次序的事实核对（Batch 2.5 复核官逐行核过 HEAD）**：旧实现里探针声明是在第一次迭代
   * （`zone === '出厂'` 分支内）赋值的，私有 `部署.json` 的 `Object.assign` 发生在第二次迭代 ⇒
   * **旧代码里私有 `安全类` 本来就压得过出厂声明**，并非"压不过"。这次把次序写成
   * 「出厂三份 → 探针声明 → 私有」只是让合并序在代码里一眼可见，**行为面是 no-op**。
   * 而且运行态 `state.defaults.安全类` 这一格**当前没有任何消费者**
   * （`probes.js` 直接读出厂声明文件，不读运行态这一格）—— 别照着旧注释再"修"一遍。
   *
   * 层次序的另一半：出厂区内 `介入度.json` 在 `响应期限.json` 之前读，所以老部署若在
   * `介入度.json` 里留了一份 `响应期限小时`，**以 `响应期限.json` 为准** —— 这是有意的
   * （单源＝`响应期限.json`；见 `src/paths.js` 的 `DEFAULT_FILES` 注释与 test/presence.test.js ⑬）。
   *
   * 为什么把 `响应期限.json` 真读进来：以前它只是**看着像真源**的幽灵件
   * （出厂 README 写着「主权者可改它」，实际生效的是 `介入度.json` 里重复的一份
   * ＋ 这里的硬编码 72）—— 主权者照 README 改，静默无效。
   *
   * **坏 JSON 一律响亮抛错**（§3.6 不许静默失败）：退回内置默认会把「主权者的设置被无视了」
   * 伪装成「一切正常」。文件**缺失**才退回内置默认 —— 全新部署里它本来就不该有私有那份。
   * 抛错的后果由 `reload()` 兜住：引擎不健康 ⇒ 全部写动作 fail-closed 被拒。
   *
   * **纯文档键不进运行态**（白名单式）：出厂件里的 `说明` 只为给人看，一旦被整份
   * `Object.assign` 进来，它就会随 `/mind status` 与工作台序列化出去，看起来像一条能生效的设置。
   * 剔掉的键名记在 `忽略的默认值键` 里 —— 剔除也不许静默（否则键名写错的人会以为设置生效了）。
   *
   * @returns {Promise<{ defaults: object, defaults来源: Record<string,string>, 忽略的默认值键: string[] }>}
   */
  async #loadDefaults() {
    // 兜底 72 只写一份：引用 `src/kernel/time.js` 的常量（两处字面量迟早会漂）。
    const merged = { 介入度: '放权', 失联限制: true, 响应期限小时: BUILTIN_RESPONSE_DEADLINE_HOURS, 工具总范围: '全部', 安全类: [], 会审讨论: { ...DEFAULT_DEBATE_BUDGET }, 岗位闲置天数: DEFAULT_ROLE_IDLE_DAYS, 复核免审: false };
    /** 生效值来自哪一层（'出厂' | '私有' | '内置兜底'）—— 「改了不生效」要能一眼看出源。 */
    const 来源 = Object.fromEntries(Object.keys(merged).map((键) => [键, '内置兜底']));
    /** 被剔除的文档键（只留名字，不留正文：正文正是它不该进运行态的原因）。 */
    const 忽略键 = new Set();
    /**
     * @param {string} file
     * @param {string} 标注 出错时用的可读来源
     * @param {'出厂'|'私有'} 层 生效值来自哪一层
     */
    const 并入 = async (file, 标注, 层) => {
      const text = await this.#readAuth(file);
      if (text === null) return; // 缺失 ⇒ 保留上一层（全新部署合理）
      let parsed;
      try {
        // BOM 先剥（2026-10-15 事故裁决）：Windows 手碰过的部署/默认值文件常带 BOM，
        // 它是编码装饰不是内容；真坏的 JSON 仍在下一行响亮抛（fail-closed 不弱化）。
        parsed = JSON.parse(stripBom(text));
      } catch (error) {
        throw new Error(`${标注}无法解析：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error(`${标注}必须是一个 JSON 对象。`);
      }
      for (const [键, 值] of Object.entries(parsed)) {
        if (!RUNTIME_DEFAULT_KEYS.includes(键)) {
          忽略键.add(键);
          continue;
        }
        merged[键] = 值;
        来源[键] = 层;
      }
    };

    // 出厂区：介入度 与 响应期限 **各读各的**（单源），后读的 响应期限.json 赢。
    await 并入(this.layout.factoryDefault('介入度'), '出厂默认值 介入度.json', '出厂');
    await 并入(this.layout.factoryDefault('响应期限'), '出厂默认值 响应期限.json', '出厂');
    // 出厂安全类探针声明：文件里的键叫 `探针`，运行态叫 `安全类`（只改键名，不改行为）。
    const probeText = await this.#readAuth(this.layout.probeDeclaration());
    if (probeText !== null) {
      let 声明;
      try {
        声明 = JSON.parse(stripBom(probeText));
      } catch (error) {
        throw new Error(`出厂安全类探针声明无法解析：${error instanceof Error ? error.message : String(error)}`);
      }
      if (!声明 || typeof 声明 !== 'object' || Array.isArray(声明)) {
        throw new Error('出厂安全类探针声明必须是一个 JSON 对象。');
      }
      for (const 键 of Object.keys(声明)) if (键 !== '探针') 忽略键.add(键);
      merged.安全类 = 声明.探针 ?? [];
      来源.安全类 = '出厂';
    }
    // 私有区最后覆盖：主权者优先。**放在最后**，于是它压得过上面每一份（安全类也压得过）。
    await 并入(this.layout.deploymentPrefs(), '私有区 部署.json', '私有');

    // 契约C（主权者裁决 2026-10-09）·披露机械检查：部署.json 的 `披露敏感模式` 是
    // 知识晋升前敏感模式清单的**整体覆盖**（出厂默认清单在 src/memory.js）。
    // 在加载期校验形状与正则可编译性：非法 ⇒ 这里抛错 ⇒ reload 失败 ⇒ 引擎不健康 ⇒
    // 全部写动作 fail-closed（§3.6 不许静默失败——静默退回默认清单等于把主权者
    // 写下的收窄无视掉，静默跳过坏条目等于少拦一道，两头都比响亮拒绝更危险）。
    validateDisclosurePatterns(merged.披露敏感模式, 来源.披露敏感模式);

    // 介入度加载期校验（2026-10-13 审查 P2-1）：坏值不许静默回退「零参与」——那是最宽松档，
    // 与「失联限制只认严格 false」的 fail-safe 方向相反。坏值 ⇒ 响亮抛错 ⇒ 引擎不健康 ⇒ 写全拒。
    if (!INTERVENTION.includes(merged.介入度)) {
      throw new Error(`介入度档位非法：${JSON.stringify(merged.介入度)}（来源：${来源.介入度}）。只认 ${INTERVENTION.join(' / ')}。修好对应文件后重载即恢复。`);
    }

    // W2（2026-10-09）·会审讨论预算：部署.json 的 `会审讨论` 是**部分覆盖**（缺键用默认），
    // 加载期校验 + 规范化成全键对象——消费方（src/debate.js）拿到的永远是四键齐全的有效值。
    // 坏值响亮抛错（§3.6）：静默退回默认等于把主权者写下的收紧/放宽无视掉。
    validateDebateBudget(merged.会审讨论, 来源.会审讨论);
    merged.会审讨论 = { ...DEFAULT_DEBATE_BUDGET, ...(merged.会审讨论 ?? {}) };

    // 岗位闲置天数（派活闭环 · 2026-10-15 主权者拍板 14 天）：≥0 整数，0 = 只报原始读数不判闲置。
    // 坏值响亮抛错（与会审预算同款 §3.6 纪律）：静默退回默认等于把主权者写的阈值无视掉。
    if (!Number.isInteger(merged.岗位闲置天数) || merged.岗位闲置天数 < 0) {
      throw new Error(`岗位闲置天数 非法：${JSON.stringify(merged.岗位闲置天数)}（来源：${来源.岗位闲置天数}）。要 ≥0 的整数（天数；0 = 不判闲置）。修好对应文件后重载即恢复。`);
    }

    // 复核免审（v2 口述收敛 2026-10-18 条目5）：复核豁免从「逐案授权引用」改为
    // 部署级全局开关。只认布尔——坏值响亮抛错（与介入度同一把尺）：静默回退 false
    // 会把主权者写下的「开」无视掉，静默回退 true 更坏（整条复核线被悄悄关掉）。
    if (typeof merged.复核免审 !== 'boolean') {
      throw new Error(`复核免审 非法：${JSON.stringify(merged.复核免审)}（来源：${来源.复核免审}）。只认 true / false。修好对应文件后重载即恢复。`);
    }

    return { defaults: merged, defaults来源: 来源, 忽略的默认值键: [...忽略键].sort() };
  }

  async #loadIdentity() {
    const text = await this.#readAuth(this.layout.identityFile());
    if (text === null) {
      // 身份档案缺失不是「无限制」，而是「没有任何登记在案的身份」——
      // 除主权者外一律拒绝，见 #evaluate 的 fail-closed 兜底。
      return { members: {}, sovereign: { lastInteraction: null }, denylist: [] };
    }
    try {
      const parsed = JSON.parse(stripBom(text));
      return {
        members: parsed.members ?? {},
        sovereign: parsed.sovereign ?? { lastInteraction: null },
        denylist: parsed.denylist ?? [],
        ...(parsed.boot ? { boot: parsed.boot } : {}),
      };
    } catch (error) {
      throw new Error(`身份档案无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #loadEstablishment() {
    const path = this.layout.establishmentPath('私有');
    const factoryPath = this.layout.establishmentPath('出厂');
    const text = (await this.#readAuth(path)) ?? (await this.#readAuth(factoryPath));
    if (text === null) return { roles: [], mode: '独立会审' };
    const parsed = parseDocument(text, { defaultAuthority: '自治' });
    const block = extractPolicyBlock(parsed.body);
    // 编制件的坏块同样响亮（W3 批3）：编制决定「谁在册」，静默丢块＝在册名单悄悄变空。
    if (block?.解析错误?.length) {
      throw new Error(`编制件（${path} 或出厂那份）的 \`\`\`policy 块无法解析：${block.解析错误.join('；')}。修好该文件后重载即恢复。`);
    }
    return {
      roles: block?.roles ?? [],
      mode: block?.mode ?? '独立会审',
      digest: digest(text),
    };
  }
}

/** @param {string} rule @param {string} reason @param {{requireAuthority?:string, howToChange?:string, detail?:object}} [options] */
function deny(rule, reason, options = {}) {
  return { verdict: 'deny', rule, reason, requireAuthority: options.requireAuthority ?? '自治', howToChange: options.howToChange ?? '', detail: options.detail ?? {} };
}
/** @param {string} rule @param {string} reason */
function allow(rule, reason) {
  return { verdict: 'allow', rule, reason, requireAuthority: '无', howToChange: '' };
}
/** @param {string} rule @param {string} reason @param {{requireAuthority?:string, howToChange?:string, detail?:object}} [options] */
function confirm(rule, reason, options = {}) {
  return { verdict: 'confirm', rule, reason, requireAuthority: options.requireAuthority ?? '主权者', howToChange: options.howToChange ?? '', ...(options.detail ? { detail: options.detail } : {}) };
}

/**
 * 介入挂起时随 confirm 一起带出的目标位：动作层据此登记「介入请求」（谁是对象、哪一代）。
 * 只留判定用到的四个标签，不抄正文（请求体可能含跨项目敏感资料）。
 * @param {object|null|undefined} target
 * @returns {{id: string|null, kind: string|null, authority: string|null, zone: string|null}|null}
 */
function 目标摘要(target) {
  if (!target) return null;
  return {
    id: target.id ?? null,
    kind: target.kind ?? null,
    authority: target.authority ?? null,
    zone: target.zone ?? null,
  };
}

/**
 * 把「一个人 / 一组人 / 空」折成名单。任务图的负责人本来就是这个形状（§10 一岗多人）。
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
function normalizeList(value) {
  if (value === null || value === undefined) return [];
  return (Array.isArray(value) ? value : [value]).map((v) => String(v).trim()).filter(Boolean);
}

/**
 * 主体规范化。缺 id/kind 的主体不会被「当作系统」放行。
 * @param {string|object} subject
 * @returns {{ id: string, kind: string, roleId?: string, generation?: number }}
 */
export function normalizeSubject(subject) {
  if (subject && typeof subject === 'object') {
    return {
      id: String(subject.id ?? 'anonymous'),
      kind: String(subject.kind ?? '未知'),
      ...(subject.roleId ? { roleId: String(subject.roleId) } : {}),
      ...(subject.generation !== undefined ? { generation: Number(subject.generation) } : {}),
    };
  }
  return { id: String(subject ?? 'anonymous'), kind: '未知' };
}

/**
 * 身份档案的 mtimeMs；不存在（或 stat 不出）时返回 null（decide 承诺永不抛）。
 * 只做一次 stat，不读内容——新鲜度检查是判定热路径，重读解析就是把它变成 reload。
 * @param {string} file
 * @returns {Promise<number|null>}
 */
async function mtimeMsOrNull(file) {
  try {
    return (await stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * 校验部署.json 的 `会审讨论`（W2 会审讨论段，2026-10-09）。
 *
 * 形状：`{ 轮次上限?, 人数上限?, 每轮消息上限?, 每人每轮字符上限? }`——**部分覆盖**
 * （缺的键用 `DEFAULT_DEBATE_BUDGET` 的默认）。给的键必须是 ≥1 的整数；
 * 其余任何形状 ⇒ 抛错，后果由 `reload()` 兜住：引擎不健康 ⇒ 全部写动作 fail-closed。
 *
 * @param {unknown} value
 * @param {string} 来源 '出厂' | '私有' | '内置兜底'（仅用于报错指路）
 */
function validateDebateBudget(value, 来源) {
  if (value === undefined || value === null) return;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`部署.json 的 会审讨论 必须是对象 {轮次上限, 人数上限, 每轮消息上限, 每人每轮字符上限}（部分覆盖，缺键用默认），当前是 ${Array.isArray(value) ? '数组' : typeof value}（来源：${来源}）。`);
  }
  for (const 键 of Object.keys(DEFAULT_DEBATE_BUDGET)) {
    if (!(键 in value)) continue;
    const v = value[键];
    if (!Number.isInteger(v) || v < 1) {
      throw new Error(`部署.json 的 会审讨论.${键} 必须是 ≥1 的整数，收到 ${JSON.stringify(v)}。修好 部署.json 后重载即恢复。`);
    }
  }
}

/**
 * 校验部署.json 的 `披露敏感模式`（契约C，主权者裁决 2026-10-09）。
 *
 * 形状：`[{ 名: string, 正则: string }, ...]`，写明来源是因为坏值要能指回是哪一层写的。
 * 值为 undefined / null（没写）⇒ 合法，消费方（memory.promoteCrossProject）用出厂默认清单。
 * 其余任何形状（非数组 / 项非对象 / 名或正则缺失非串 / 正则编译不过）⇒ 抛错，
 * 后果由 `reload()` 兜住：引擎不健康 ⇒ 全部写动作 fail-closed。
 *
 * @param {unknown} value
 * @param {string} 来源 '出厂' | '私有' | '内置兜底'（仅用于报错指路）
 */
function validateDisclosurePatterns(value, 来源) {
  if (value === undefined || value === null) return;
  if (!Array.isArray(value)) {
    throw new Error(`部署.json 的 披露敏感模式 必须是数组（[{名, 正则}]，整体覆盖出厂默认清单），当前是 ${typeof value}（来源：${来源}）。`);
  }
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error(`部署.json 的 披露敏感模式 每一项必须是 {名, 正则} 对象，收到 ${JSON.stringify(item)}。`);
    }
    if (typeof item.名 !== 'string' || !item.名.trim()) {
      throw new Error(`部署.json 的 披露敏感模式 每一项的 名 必须是非空字符串（命中报读与豁免审计都要用它指认模式），收到 ${JSON.stringify(item.名)}。`);
    }
    if (typeof item.正则 !== 'string') {
      throw new Error(`披露敏感模式[${item.名}] 的 正则 必须是字符串，收到 ${typeof item.正则}。`);
    }
    try {
      new RegExp(item.正则, 'i');
    } catch (error) {
      throw new Error(`披露敏感模式[${item.名}] 的正则非法：${item.正则}（${error instanceof Error ? error.message : String(error)}）。修好 部署.json 里的这个条目后重载即恢复。`);
    }
    // 回溯安全行为检测（2026-10-13 审查 P1-14）：编译得过 ≠ 跑得动——`(a+)+$` 类灾难性
    // 回溯正则可在单次晋升的 re.test 上阻塞事件循环（全插件无超时）。加载期用对抗输入
    // 弹药库实测耗时：超预算 ⇒ 响亮抛错（fail-closed），不许带病上岗。
    const re = new RegExp(item.正则, 'i');
    for (const 弹药 of REDOS_PROBES) {
      const 起 = Date.now();
      re.test(弹药);
      if (Date.now() - 起 > 50) {
        throw new Error(`披露敏感模式[${item.名}] 的正则有灾难性回溯风险：${item.正则}（在长度 ${弹药.length} 的对抗输入上单次匹配超过 50ms）。请改写为无嵌套量词的形式（或收窄字符类）后重载。`);
      }
    }
  }
}

/**
 * 对抗输入弹药库（回溯安全检测用）：经典 ReDoS 形态的触发串——重复单字符、重复带空格、
 * 重复分段（交替量词）、近匹配不命中（回溯最贵的路径是「差一点就中」）。
 * @type {string[]}
 */
const REDOS_PROBES = Object.freeze([
  'a'.repeat(48),
  'a '.repeat(24).trimEnd(),
  'ab'.repeat(24),
  'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaab',
  'x.y.'.repeat(12) + 'x!',
  '['.repeat(24) + ']'.repeat(24),
]);

/** 把各法律件里的 grants 摊平并编上序号（拒绝理由要能指回条款）。 */
function collectGrants(rules) {
  const out = [];
  for (const rule of rules) {
    // 复用 #loadRules 的解析结果（2026-10-13 第三批性能收口）：修前对同一文本再 parseDocument
    // 一次——每次 reload 双倍解析，身份档案 mtime 一变（每次 assign/seal/markInteraction）就全量重付。
    const parsed = rule.parsed ?? parseDocument(rule.text, { defaultAuthority: rule.authority });
    const block = extractPolicyBlock(parsed.body);
    // 坏授权块 ⇒ 响亮抛错（W3 批3）：跳过它等于「整部法律的授权块被丢，引擎还报 healthy」。
    if (block?.解析错误?.length) {
      throw new Error(`规则件 ${rule.id}（${rule.zone}区）的 \`\`\`policy 授权块无法解析：${block.解析错误.join('；')}。修好该文件后重载即恢复（当前按引擎不健康处理：全部写动作被拒）。`);
    }
    if (!block?.grants) continue;
    block.grants.forEach((grant, index) => {
      // 形状与verdict已在共享解析器中校验，合并与求值不能各用一套合法性口径。
      const verdict = grant.verdict ?? 'allow';
      out.push({
        ...grant,
        verdict,
        source: `${rule.id}（${rule.zone}区）`,
        index: `${rule.id}#${index + 1}`,
      });
    });
  }
  return out;
}

/**
 * 主体是否在身份档案中登记且未停用（§12.2：身份被停用/删除时判定必须有确定答案）。
 * @param {PolicyEngine} engine
 * @param {string} id
 * @returns {{ known: boolean, status: string, reason: string }}
 */
export function identityStatus(engine, id) {
  const member = engine.state.identity?.members?.[id];
  if (!member) {
    return { known: false, status: '未登记', reason: `身份档案里没有 ${id}：查不到不等于放行，按最严处理。` };
  }
  // 缺 status 也按非在岗处理（设计评审 #15 · 2026-10-15）：修前 `member.status && member.status !== '在岗'`
  // 把「status 字段缺席」放行成在岗——手改档案删掉该字段就绕过停用判定；而 #档案岗位Of（:369）
  // 要求严格 ==='在岗'，同一条档案两种口径。与它对齐：「查不到 = 最严」。
  if (member.status !== '在岗') {
    const status = member.status ?? '状态缺失';
    return {
      known: true,
      status,
      reason: member.status
        ? `身份 ${id} 当前状态为 ${member.status}，按最严处理。`
        : `身份 ${id} 的档案行缺 status 字段（读到 ${status}）：缺状态不等于在岗，按最严处理。`,
    };
  }
  return { known: true, status: '在岗', reason: '' };
}
