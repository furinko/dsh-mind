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
import { readTextOrNull } from './kernel/fsx.js';
import { digest } from './kernel/text.js';
import { Denied, Fault, NeedsApproval } from './kernel/errors.js';
import { resolveResponseDeadline, evaluateSovereignPresence, BUILTIN_RESPONSE_DEADLINE_HOURS } from './kernel/time.js';
import { RULE_FILES } from './paths.js';
import { parseDocument } from './tags.js';

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
export const SUBJECT_KINDS = ['主权者', '出厂作者', 'Lead', '成员', '复核者', '系统'];

/** 介入度四档（§4），只影响自治档。 */
export const INTERVENTION = ['零参与', '事后抽检', '变更预审', '逐条审批'];

/**
 * 运行态默认值键的**封闭清单**（白名单）：出厂件可以写任意给人看的文档键
 * （`说明` 之类），但只有这些键会进运行态。
 *
 * 为什么必须是白名单而不是黑名单：`说明` 被整份并入后会随 `/mind status` 与工作台
 * 序列化出去 —— 读的人分不清「这是文档」还是「这是一条生效的设置」；
 * 而黑名单永远漏一个（写个 `备注` / `note` / 中文的新叫法就绕过去了）。
 */
const RUNTIME_DEFAULT_KEYS = ['介入度', '失联限制', '响应期限小时', '工具总范围', '安全类', '披露敏感模式', '会审讨论'];

/**
 * 会审讨论段的预算默认值（W2 规格 2026-10-09）。
 * 私有 `部署.json` 的 `会审讨论` 键**部分覆盖**（缺的键用这里的默认），加载期校验：
 * 坏值（非对象 / 键非 ≥1 整数）⇒ 响亮抛错 ⇒ 引擎不健康（fail-closed，§3.6）。
 */
export const DEFAULT_DEBATE_BUDGET = { 轮次上限: 2, 人数上限: 8, 每轮消息上限: 24, 每人每轮字符上限: 4000 };

const ALWAYS_INVARIANTS = '宪章 不可违背原则（§3 永不 + §12 约束清单）';

/**
 * 引擎实例。
 */
export class PolicyEngine {
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
  }

  /** 热更新入口：宿主在文件变更时调用；失败不改变「不健康」这个事实。 */
  async reload() {
    try {
      const { rules, digests } = await this.#loadRules();
      const { defaults, defaults来源, 忽略的默认值键 } = await this.#loadDefaults();
      const identity = await this.#loadIdentity();
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
    this.identityMtimeMs = await mtimeMsOrNull(this.layout.identityFile());
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
    // 身份档案新鲜度（审查 B2 半边）：把「写完档案要 reload」从**纪律级**（靠 registry
    // 写完自觉调用）升级为**机制级**——任何绕过 registry 的写入（手改 JSON、外部工具）
    // 也必须在下一次判定前生效，否则封存/撤回的成员继续拿到旧快照的权限。
    // 热路径只花**一次 stat**（不重读不解析）；档案缺失 = 沿用 #loadIdentity 的兜底语义
    // （「没有任何登记在案的身份」，不是抛错），mtime 记 null，null == null 视为无变化。
    const mtime = await mtimeMsOrNull(this.layout.identityFile());
    if (mtime !== this.identityMtimeMs) {
      await this.reload();
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
          详情: { action: input.action, reason: verdict.reason, requireAuthority: verdict.requireAuthority },
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
    throw new Denied(decision.rule, decision.reason, {
      requireAuthority: decision.requireAuthority,
      howToChange: decision.howToChange,
      detail: decision.detail,
    });
  }

  /**
   * 主体能否在任务内行动（§2「任务内全权，任务外无」）。
   * @param {object} subject
   * @param {object|null} task
   * @returns {{ ok: boolean, reason?: string }}
   */
  scopeOf(subject, task) {
    if (subject?.kind !== '成员') return { ok: true };
    if (!task) return { ok: false, reason: '成员在任务外无权限：没有关联任务节点' };
    // 负责人可能是**一个人**，也可能是**一岗多人的一组**（§10）。
    // 拿字符串去比数组会永远不相等，于是多负责人任务上谁也干不了活 —— 这里统一折成名单。
    const 名单 = normalizeList(task.负责人);
    if (名单.length === 0) return { ok: true };
    const 我 = [subject.id, subject.roleId].filter(Boolean);
    if (!我.some((id) => 名单.includes(id))) {
      return { ok: false, reason: `该任务节点负责人是 ${名单.join('、')}，不是 ${subject.id}` };
    }
    return { ok: true };
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
    const level = this.state.defaults?.介入度 ?? '零参与';
    return INTERVENTION.includes(level) ? level : '零参与';
  }

  // ── 判定本体 ────────────────────────────────────────────────────────────────

  /** @param {{ subject: object, action: string, target: object, context?: object }} input */
  #evaluate(input) {
    const subject = normalizeSubject(input.subject);
    const target = input.target ?? {};
    const action = input.action;
    const context = input.context ?? {};
    const authority = target.authority ?? '自治';

    if (!SUBJECT_KINDS.includes(subject.kind)) {
      return deny('宪章 主体定义（§2）', `未知主体种类：${String(subject.kind)}。查不到身份不等于放行（§12.2）。`, {
        requireAuthority: '宪章',
        howToChange: '由主权者在身份档案中登记该主体，或改用已登记的身份。',
      });
    }
    // 身份档案接入判定（§12.2：身份停用/删除时判定必须有确定答案）。
    // 只查 成员/复核者：它们的权来自注册表里的**实例**，封存即失权；
    // 主权者/出厂作者/系统/Lead 是结构性身份，不挂在实例账上。
    if (subject.kind === '成员' || subject.kind === '复核者') {
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

    const invariant = this.#invariants(subject, action, target, context);
    if (invariant) return invariant;

    const write = action !== 'read';
    if (write && this.#isDenied(subject, target)) {
      return deny(
        '法律 撤回 = 写拒绝名单，不删卡（§4 三权）',
        `对象 ${target.id} 在拒绝名单上：主权者已撤回该对象，新的写入一律不许。`,
        { requireAuthority: '主权者', howToChange: '由主权者从拒绝名单移除该 id，卡本身没有被删除。' },
      );
    }

    if (write && authority === '自治' && this.presence().lost) {
      return deny('宪章 失联（§4）', `主权者已失联，所有自治变更冻结；服务与记忆照常，安全类强更不受影响。`, {
        requireAuthority: '主权者',
        howToChange: '主权者任一次交互即解除失联。',
      });
    }

    // 顺序很重要：不变式 → 法律件的显式授权块 → 内置的三档默认。
    // 内置档位是**出厂默认文本**，主权者改过的 权限矩阵.md 是同一部法律的现行版本，
    // 所以它必须先于默认生效；而宪章不变式在它之前，任何法律都翻不动。
    const grant = this.#grantRule(subject, action, authority, target);
    if (grant) return grant;

    const tierRule = this.#tierRule(subject, action, target, authority, context);
    if (tierRule) return tierRule;

    const scoped = this.scopeOf(subject, context.task ?? null);
    if (!scoped.ok && action !== 'read') {
      return deny('法律 权限矩阵 · 任务内全权，任务外无（§2）', scoped.reason, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 把该成员派到对应任务节点，或改由该节点负责人执行。',
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
   * 第一层：宪章不变式。任何法律都改不动，因为它们是「组织给自己发合格证」这类
   * 结构性失效的唯一防线。
   */
  #invariants(subject, action, target, context) {
    const write = action !== 'read';
    const authority = target.authority ?? '自治';

    if (action === 'approve' && context.proposerId && String(context.proposerId) === String(subject.id)) {
      return deny('宪章 §3.4 组织给自己发合格证', '提案者不得自批：本次提案人与批准人是同一个主体。', {
        requireAuthority: '宪章',
        howToChange: '换一个未参与提案的主体批准（复核者或主权者）。',
      });
    }
    // §3.5「成员自扩权 / 再起成员」的准确边界：禁的是**给自己或别人扩权**，
    // 不是「成员不许产生任何对象」——成员把自己的作答与知识记下来是本职。 
    const 建卡或扩权 = action === 'create' && ['身份', '规则'].includes(target.kind);
    if (subject.kind === '成员' && (建卡或扩权 || ['dispatch', 'propose', 'approve'].includes(action))) {
      return deny('宪章 §3.5 成员自扩权 / 再起成员', `成员不得执行 ${action}：建卡、派活与提案都属于 Lead。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead 执行该动作；成员只能在自己的任务节点内干活并留下作答与知识。',
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

  /** 第二层：三档门槛（立宪 / 立法 / 自治），唯一分界线是「你定的 > 组织定的」。 */
  #tierRule(subject, action, target, authority, context) {
    if (subject.kind === '复核者') {
      // §2「只读数，不改，不参与提案」的准确边界：**不许改被验对象**。
      // 它属于法律档而不是宪章不变式 —— 复核者卡的「身份 + 权限 + 判据」段本就是法律，
      // 主权者改 权限矩阵.md 时应当能改到它；宪章不变式（不自批、不删除）在更前面拦着。
      //
      // §8 同时要求复核者输出三态结论 —— 结论是只增证据，不是对被验对象的改动，
      // 所以 review 与 read 放行，experiment 只在沙箱区放行，其余写动作一律拒绝。
      if (action === 'experiment') {
        if (target.sandbox !== true) {
          return deny('§2 复核者需要落盘的实验走沙箱区', '复核者的落盘实验必须落在沙箱区：单独授权、不进持久状态、任务结束即清。', {
            requireAuthority: '主权者',
            howToChange: '把实验放进沙箱区（target.sandbox = true），或改由成员在任务内执行。',
          });
        }
      } else if (!['read', 'review'].includes(action)) {
        return deny('法律 复核者只读数，不改，不参与提案（§2）', `复核者不得执行写动作 ${action}：它不改被验对象，也不派活、不提案。`, {
          requireAuthority: '主权者',
          howToChange: '复核结论经 review 落账（只增证据）；需要改动由 Lead 按结论执行。',
        });
      }
    }
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
      if (subject.kind === '成员') {
        // 「任务外无」管的是**权**，不是**读**：成员读自己岗位的知识与能力是干活的前提。
        const scoped = this.scopeOf(subject, context.task ?? target.task ?? null);
        if (!scoped.ok && action !== 'read') return deny('法律 权限矩阵 · 自治档（任务外无）', scoped.reason, {
          requireAuthority: 'Lead',
          howToChange: '由 Lead 派发任务节点后再执行。',
        });
      }
      const level = this.intervention();
      if (level === '变更预审') {
        return confirm('法律 介入度 · 变更预审（§4）', `本部署介入度为「变更预审」：自治变更需主权者预审。`, {
          requireAuthority: '主权者',
          howToChange: '由主权者预审后放行，或把介入度调回「零参与 / 事后抽检」。',
        });
      }
      if (level === '逐条审批') {
        return confirm('法律 介入度 · 逐条审批（§4）', '本部署介入度为「逐条审批」：每条自治变更都要主权者点头。', {
          requireAuthority: '主权者',
          howToChange: '由主权者逐条批准。',
        });
      }
      return allow(
        level === '事后抽检' ? '法律 介入度 · 事后抽检（§4）' : '法律 介入度 · 零参与（§4）',
        level === '事后抽检' ? '自治变更放行，事后抽检，留痕必须完整。' : '自治档由组织自决，主权者默认不参与。',
      );
    }
    return null;
  }

  /** 第三层：法律件里的机器可读授权块。 */
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
      let found = null;
      // 私有区覆盖出厂区（§5 叠加层）：先看私有，命中即生效，出厂那份仍留作基线。
      for (const zone of ['私有', '出厂']) {
        const path = this.layout.rulePath(spec.id, zone);
        if (!path) continue;
        const text = await readTextOrNull(path);
        if (text === null) continue;
        const parsed = parseDocument(text, { defaultAuthority: spec.authority });
        if (parsed.errors.length) {
          throw new Error(`规则件 ${spec.id}（${zone}）无法解析：${parsed.errors.join('；')}`);
        }
        found = { id: spec.id, authority: spec.authority, zone, text, digest: digest(text), path };
        break;
      }
      if (!found) {
        // 宪章缺失 = 没有判据来源 = fail-closed（§7 加载失败 fail-closed）。
        throw new Error(`规则件缺失：${spec.id}（私有区与出厂区都没有）`);
      }
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
    const merged = { 介入度: '零参与', 失联限制: true, 响应期限小时: BUILTIN_RESPONSE_DEADLINE_HOURS, 工具总范围: '全部', 安全类: [], 会审讨论: { ...DEFAULT_DEBATE_BUDGET } };
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
      const text = await readTextOrNull(file);
      if (text === null) return; // 缺失 ⇒ 保留上一层（全新部署合理）
      let parsed;
      try {
        parsed = JSON.parse(text);
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
    const probeText = await readTextOrNull(this.layout.probeDeclaration());
    if (probeText !== null) {
      let 声明;
      try {
        声明 = JSON.parse(probeText);
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

    // W2（2026-10-09）·会审讨论预算：部署.json 的 `会审讨论` 是**部分覆盖**（缺键用默认），
    // 加载期校验 + 规范化成全键对象——消费方（src/debate.js）拿到的永远是四键齐全的有效值。
    // 坏值响亮抛错（§3.6）：静默退回默认等于把主权者写下的收紧/放宽无视掉。
    validateDebateBudget(merged.会审讨论, 来源.会审讨论);
    merged.会审讨论 = { ...DEFAULT_DEBATE_BUDGET, ...(merged.会审讨论 ?? {}) };

    return { defaults: merged, defaults来源: 来源, 忽略的默认值键: [...忽略键].sort() };
  }

  async #loadIdentity() {
    const text = await readTextOrNull(this.layout.identityFile());
    if (text === null) {
      // 身份档案缺失不是「无限制」，而是「没有任何登记在案的身份」——
      // 除主权者外一律拒绝，见 #evaluate 的 fail-closed 兜底。
      return { members: {}, sovereign: { lastInteraction: null }, denylist: [] };
    }
    try {
      const parsed = JSON.parse(text);
      return {
        members: parsed.members ?? {},
        sovereign: parsed.sovereign ?? { lastInteraction: null },
        denylist: parsed.denylist ?? [],
      };
    } catch (error) {
      throw new Error(`身份档案无法解析：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #loadEstablishment() {
    const path = this.layout.establishmentPath('私有');
    const factoryPath = this.layout.establishmentPath('出厂');
    const text = (await readTextOrNull(path)) ?? (await readTextOrNull(factoryPath));
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
/** @param {string} rule @param {string} reason @param {{requireAuthority?:string, howToChange?:string}} [options] */
function confirm(rule, reason, options = {}) {
  return { verdict: 'confirm', rule, reason, requireAuthority: options.requireAuthority ?? '主权者', howToChange: options.howToChange ?? '' };
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
 * 从正文中取出 ```policy 块并解析成授权表。
 *
 * 坏块**折进 `解析错误[]`，不再 `continue` 掉**（W3 批3·2026-10-09）：静默跳过它的后果是
 * 「整部法律的授权块被丢，而引擎照样报 healthy」——判定随后按三档默认走，谁也看不出
 * 法律件里的授权面已经空了。调用方（`collectGrants` / `#loadEstablishment`）拿到非空
 * `解析错误` 就抛错 ⇒ `reload()` 的 catch 落 `state.error` ⇒ describe/健康面见红 +
 * 全部写动作 fail-closed（与 `validateDebateBudget` 同一层，不另开上报通道）。
 *
 * @param {string} body
 * @returns {{ grants?: object[], roles?: string[], mode?: string, 解析错误: string[] }|null}
 */
export function extractPolicyBlock(body) {
  const blocks = [...String(body).matchAll(/```policy\r?\n([\s\S]*?)```/g)];
  if (blocks.length === 0) return null;
  const merged = {};
  /** @type {string[]} */
  const 解析错误 = [];
  blocks.forEach(([, raw], index) => {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      解析错误.push(`\`\`\`policy 块 #${index + 1} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      解析错误.push(`\`\`\`policy 块 #${index + 1} 必须是 JSON 对象，收到 ${Array.isArray(parsed) ? '数组' : typeof parsed}`);
      return;
    }
    for (const key of Object.keys(parsed)) {
      if (Array.isArray(parsed[key])) merged[key] = [...(merged[key] ?? []), ...parsed[key]];
      else merged[key] = parsed[key];
    }
  });
  merged.解析错误 = 解析错误;
  return merged;
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
  }
}

/** 把各法律件里的 grants 摊平并编上序号（拒绝理由要能指回条款）。 */
function collectGrants(rules) {
  const out = [];
  for (const rule of rules) {
    const parsed = parseDocument(rule.text, { defaultAuthority: rule.authority });
    const block = extractPolicyBlock(parsed.body);
    // 坏授权块 ⇒ 响亮抛错（W3 批3）：跳过它等于「整部法律的授权块被丢，引擎还报 healthy」。
    if (block?.解析错误?.length) {
      throw new Error(`规则件 ${rule.id}（${rule.zone}区）的 \`\`\`policy 授权块无法解析：${block.解析错误.join('；')}。修好该文件后重载即恢复（当前按引擎不健康处理：全部写动作被拒）。`);
    }
    if (!block?.grants) continue;
    block.grants.forEach((grant, index) => {
      out.push({
        ...grant,
        verdict: grant.verdict ?? 'allow',
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
  if (member.status && member.status !== '在岗') {
    return { known: true, status: member.status, reason: `身份 ${id} 当前状态为 ${member.status}，按最严处理。` };
  }
  return { known: true, status: '在岗', reason: '' };
}
