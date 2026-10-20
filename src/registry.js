/**
 * 角色注册表（§7「有哪些岗位、谁能干什么、谁在岗」）。
 *
 * §14.2 在目录上给它标了 ⚠️：**它是索引，不是真源**。
 * 真源永远是两处——`集体L3-成员角色卡/` 的岗位卡，与 `身份档案/identity.json` 的实例记录。
 * 所以 `sync()` 永远是「从真源重算」，任何一处索引损坏都能被一次重算修好。
 *
 * 三条必须保证：
 *  1. **封存 ≠ 删除** —— 封存只把状态改成「封存」，卡留在盘上。
 *  2. **随时能答「这身份能碰什么」** —— `canTouch()` 把卡的分段与策略引擎的判定拼成一张表。
 *  3. **实例权限只来自岗位** —— `assign()` 拒绝一个不存在的岗位。
 */
import { listDirs, listFiles, readJsonOrNull, readJsonl, readTextOrNull, atomicWrite, exists, withLock } from './kernel/fsx.js';
import { readInstanceSnapshot } from './instance-snapshot.js';
import {
  CARD_SEGMENTS as SEGMENTS,
  cardDigest,
  deriveCardFaces,
  readVerifiedCardSnapshot,
} from './card-credential.js';
import { Denied, InvalidBody } from './kernel/errors.js';
import { digest } from './kernel/text.js';
import { effectiveDocument, parseDocument } from './tags.js';
import { section } from './capability.js';
import { assertPathSegment, DIR } from './paths.js';
import { ACTIONS, identityStatus, subjectKindForRole, subjectRank } from './policy.js';
import { MECHANISM_SUBJECT } from './mechanism.js';
import { evaluateSovereignPresence } from './kernel/time.js';

/**
 * 双区的**覆盖优先级**，唯一一份。
 *
 * 顺序即语义：先扫到的赢 ⇒ 自治（私有）覆盖出厂。`get()` 的短路顺序、`list()` 的合并顺序、
 * `#scanCards()` 的扫描顺序都读它——这三处以前各写各的数组字面量，
 * 正是「同一条读取链上两种语义」的成因（`get()` 私有优先、`list()` 两区并列）。
 * 规则只写一份，就不存在「改了一处忘了另一处」。
 */
const ZONES = [
  ['自治', '私有'],
  ['出厂', '出厂'],
];

/**
 * 主权者交互的来源白名单（设计评审 #7 · 2026-10-15）：`markInteraction` 只认这几个入口。
 * 名单是封闭的——新增调用方必须在这里显式登记，否则 fail-closed 被拒。
 *  - 「宿主事件」：内核的 user/message 挂钩（components/kernel/lib/index.js 挂主权者交互）；
 *  - 「presence命令」：/mind sovereign_interaction（命令面专属，模型没有这只手）；
 *  - 「部署引导」：org.bootstrap() 在身份档案缺失时落的第一次交互（主权者「启动了这个部署」）。
 *  - 「人侧入口」（v2 条目14/17 · 2026-10-18 补修F）：主权者本人从已认证的人侧通道
 *    （同源设置页 / 人侧命令）做出的有效交互——改设置、逐请求批准/拒绝/撤销。
 *    只有 Owner 适配器（`src/intervention.js` 的人侧函数）会用它；模型面不可达。
 */
const 交互来源白名单 = ['宿主事件', 'presence命令', '部署引导', '人侧入口'];

/**
 * 岗位 + 实例 → 策略判定用的主体（岗位决定主体种类）。
 *
 * 这是**身份档案 → 主体**这一层的唯一映射落点：`canTouch()` 与 `debate.open()` 的候选池
 * 预检都读它（同一件事不许有两个口径）。种类映射本身住在 `src/policy.js` 的
 * `subjectKindForRole()`（v2 条目8/20：不越授与不自授也在问同一件事，映射只能有一份）；
 * 这里只补本层需要的那两件事：`roleId` 取岗位名、以及**不做**宿主侧兜底
 * （没有「根会话」「实例缺省成 unknown / lead」那些约定——身份档案里查不到的实例就是
 * 查不到，交给判定层按最严处理（§12.2），不许在这里被回填成一个更高的身份）。
 *
 * @param {string|undefined} 岗位
 * @param {string} 实例
 * @returns {{id: string, kind: string, roleId: string}}
 */
export function subjectForRole(岗位, 实例) {
  const kind = subjectKindForRole(岗位);
  if (kind === '成员') return { id: 实例, kind, roleId: 岗位 || '未登记' };
  return { id: 实例, kind, roleId: 岗位 };
}

export class RoleRegistry {
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
   * 从真源重算索引。真源 = 岗位卡（两区）+ 身份档案 + （生命周期投影）任务事件流。
   *
   * 生命周期字段（v2 条目10）的分工，写清楚免得读的人以为有两份真源：
   *  - **创建于 / 绑定时 / 封存于**：身份档案真写（assign / seal 那一刻落）；
   *  - **交卷于**：任务事件流（`submitted` 行 + 其 `by.id`）现算——交卷这个事实的权威
   *    本来就是任务图，再抄一份到身份档案就是两份会漂的账；
   *  - **最近活跃于**：审计链现算，由装配点（`org.bootstrap()`）用既有的
   *    `计实例活动` 传进来（同一份口径，不在这里再写一遍）。
   * 都只进**索引**，不改身份档案。
   *
   * @param {{ 活动?: Record<string, {最近活动于: string|null, 活动条数: number}> }} [spec]
   * @returns {Promise<{ 岗位: number, 实例: number, 更新于: string }>}
   */
  async sync(spec = {}) {
    const 岗位 = await this.#scanCards();
    const identity = await this.#identity();
    const 投影 = await this.#任务生命周期(new Set(Object.keys(identity.members ?? {})));
    const 活动 = spec.活动 ?? null;
    const 实例 = {};
    for (const [id, member] of Object.entries(identity.members ?? {})) {
      const 生 = member?.生命周期 ?? {};
      // v2（条目11 真接线，2026-10-18 修正）：绑定优先取 **`bound` 事件**（`task_bind` /
      // member_spawn 落的真实实例绑定，带岗位与项目）；`created`/`reassigned` 的负责人只作
      // **历史回落**，而且只认登记过的实例 id——负责人里的岗位名不是实例键，不能拿来当绑定。
      const 绑定 = 投影.绑定.get(id) ?? [];
      const 历史 = 投影.历史绑定.get(id) ?? [];
      const 交卷 = 投影.交卷.get(id) ?? [];
      const 真绑定 = 绑定.at(-1) ?? null;
      const 历史绑定 = 历史.at(-1) ?? null;
      实例[id] = {
        ...member,
        生命周期: {
          创建于: 生.创建于 ?? member?.登记于 ?? null,
          // 身份档案里 assign 时显式给过节点 ⇒ 那是真实事实（保留）；否则用事件流投影。
          绑定时: 生.绑定时 ?? 真绑定?.于 ?? 历史绑定?.于 ?? null,
          绑定节点: 生.绑定节点 ?? 真绑定?.节点 ?? 历史绑定?.节点 ?? null,
          // 绑定发生在**哪个项目**：项目墙 / 审计读域要按真实绑定项目读，不能落成 null。
          绑定项目: 真绑定?.项目 ?? 历史绑定?.项目 ?? null,
          绑定岗位: 真绑定?.岗位 ?? 历史绑定?.岗位 ?? null,
          交卷于: 交卷.at(-1)?.于 ?? null,
          最近活跃于: 活动?.[id]?.最近活动于 ?? null,
          封存于: member?.status === '封存' ? (生.封存于 ?? member?.封存于 ?? null) : null,
        },
      };
    }
    const index = {
      更新于: this.clock.iso(),
      岗位,
      实例,
      卡版本: Object.fromEntries(Object.entries(实例).map(([id, m]) => [id, m?.卡版本?.摘要 ?? null])),
      封存: Object.values(identity.members).filter((m) => m.status === '封存').map((m) => m.id),
      拒绝名单: identity.denylist.map((d) => d.id),
    };
    await atomicWrite(this.layout.registryFile(), `${JSON.stringify(index, null, 2)}\n`);
    return { 岗位: 岗位.length, 实例: Object.keys(identity.members).length, 更新于: index.更新于 };
  }

  /**
   * 任务事件流 → 实例生命周期投影（绑定 / 交卷）。
   *
   * 为什么现算而不是另存：任务图是「谁在什么节点上、谁交了卷」的唯一真源（append-only
   * 事件流 + fold）。把这两件事再抄进身份档案 = 两份账，一定会漂。
   *
   * 两条来源**分开放**（2026-10-18 修正：修前只读 created/reassigned 的负责人，把岗位名
   * 当成实例键，且完全不消费 `bound` ⇒ `assign 不带节点 → task_bind` 这条真实路径在索引里
   * 永远是 null）：
   *  - **绑定** = `bound` 事件（`task_bind` / `member_spawn` 落的实例绑定）。这是唯一真绑定，
   *    带**实例、岗位、项目、时刻**；
   *  - **历史绑定** = `created`/`reassigned` 的负责人，只作回落，且**只认登记过的实例 id**——
   *    负责人里的岗位名不是实例键（旧账里负责人常常就是岗位名）。
   *
   * @param {Set<string>} 已知实例 身份档案里的实例 id 集合（判「这个负责人是不是实例」）
   * @returns {Promise<{绑定: Map<string, Array<{节点: string, 岗位: string|null, 项目: string, 于: string}>>, 历史绑定: Map<string, Array<{节点: string, 岗位: null, 项目: string, 于: string}>>, 交卷: Map<string, Array<{节点: string, 于: string}>>}>}
   */
  async #任务生命周期(已知实例 = new Set()) {
    const 绑定 = new Map();
    const 历史绑定 = new Map();
    const 交卷 = new Map();
    const 根 = this.layout.private(DIR.基础设施, DIR.任务图);
    const 项目们 = new Set(await listDirs(根));
    for (const 项目 of 项目们) {
      if (!项目) continue;
      let 行 = [];
      try {
        行 = await readJsonl(this.layout.taskLog(项目));
      } catch {
        continue; // 该项目没有任务账本（正常形态，不是错误）
      }
      for (const row of 行) {
        const 节点 = row?.id;
        if (!节点) continue;
        if (row.kind === 'bound') {
          const 实例 = String(row.绑定?.实例 ?? '').trim();
          if (!实例) continue;
          const 项 = 绑定.get(实例) ?? [];
          项.push({ 节点: String(节点), 岗位: row.绑定?.岗位 ?? null, 项目: String(项目), 于: String(row.绑定?.于 ?? row.at ?? '') });
          绑定.set(实例, 项);
          continue;
        }
        if (row.kind === 'created' || row.kind === 'reassigned') {
          for (const 负责人 of row.负责人 ?? []) {
            if (typeof 负责人 !== 'string') continue;
            // 历史回落：负责人可能是岗位名（旧账常态），只有登记过的实例 id 才算「绑了实例」。
            if (!已知实例.has(负责人)) continue;
            const 项 = 历史绑定.get(负责人) ?? [];
            项.push({ 节点: String(节点), 岗位: null, 项目: String(项目), 于: String(row.at ?? '') });
            历史绑定.set(负责人, 项);
          }
        }
        if (row.kind === 'submitted' && row.by?.id) {
          const 项 = 交卷.get(String(row.by.id)) ?? [];
          项.push({ 节点: String(节点), 于: String(row.at ?? '') });
          交卷.set(String(row.by.id), 项);
        }
      }
    }
    return { 绑定, 历史绑定, 交卷 };
  }

  /**
   * 岗位清单。索引缺失时**自动重算**，不让调用方拿到空表。
   *
   * **一个 id 一行，取私有版（同名时）——与 `get()` 同一个口径。**
   *
   * 为什么必须与 `get()` 同口径（W3 批4·2026-10-12）：改动前 `get()` 是私有优先短路
   * （`for (const zone of ['自治','出厂'])` 命中即 return），而 `list()` 直接把
   * `#scanCards()` 吐出来——两区都 push、无去重、无覆盖。于是同一条读取链上并存两种语义：
   * `registry_list` 报 2 个「插件工程」，`registry_can`（走 `get()`）却只认 1 个。
   * 谁也没写错，错的是**同一件事有两个口径**。
   *
   * 但**去重不许把「存在同名」这件事吞掉**（那等于把一处需要人拍板的双区分歧，
   * 变成一次静默的覆盖）：所以每一行都带 `同名: string[]`，如实列出这张卡所在的区，
   * **生效来源排在首位**（同名时是 `['私有','出厂']`，不同名时是 `['私有']` 或 `['出厂']`）——
   * 读的人一眼看得出「它生效的是哪份、另外还有哪份」，不必再对照 `来源` 才能猜。
   * 判据是「列得出一行，且看得出它在两区都有」，不是「看起来只有一份」。
   *
   * @returns {Promise<Array<{ id: string, 来源: string, 同名: string[], 摘要: string, 段: string[], 能力引用: string[], digest: string }>>}
   */
  async list() {
    /** @type {Map<string, object>} */
    const byId = new Map();
    // ZONES 的顺序即优先级：先到的赢（自治先扫），与 get() 同序同源。
    for (const [zone, label] of ZONES) {
      for (const row of await this.#scanZone(zone, label)) {
        const 已有 = byId.get(row.id);
        if (已有) {
          // 冲突：把**后到的**区如实记进去（先到的那区在创建时就已入列）。
          已有.同名.push(label);
          continue;
        }
        // 先到的那个区就是生效来源，所以它自己也要进 `同名`——
        // 只在后面 push「输的那一方」的话，行上只剩 `['出厂']`，看起来像是出厂版生效。
        byId.set(row.id, { ...row, 来源: label, 同名: [label] });
      }
    }
    // 判据②只要求「看得出这个 id 在两区都有」，不要求冲突时的来源顺序稳定；
    // 但读数要可复现（同一盘同一答案），所以按 ZONES 的优先级序而非扫描次序收敛。
    const 序 = new Map(ZONES.map(([, l], i) => [l, i]));
    for (const row of byId.values()) row.同名.sort((a, b) => 序.get(a) - 序.get(b));
    // R18（审查 2026-10-16）：来源标签与 get() **同一条口径**——两区都有时生效文档是
    // 段级合并的产物（私有同名段覆盖、未出现段继承出厂），不再谎称「整份来自私有」。
    // 这条也是本文件既有的自我约束：`list()` 与 `get()` 必须给同一条答案。
    for (const row of byId.values()) {
      if (row.同名.length > 1) row.来源 = `合并（${row.同名.join('+')}）`;
    }
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 取一个岗位卡。
   * @param {{ id: string }} spec
   * @returns {Promise<{ id: string, 来源: string, meta: object, 段: Record<string, string>, 能力引用: string[], 经验引用: string[], 正文: string }|null>}
   */
  async get(spec) {
    const id = assertPathSegment(spec.id, '岗位卡id');
    // R18（审查 2026-10-16）：**两侧都读、段级合并**（effectiveDocument 单源）——修前
    // 自治区命中就短路，出厂那份里未被私有碰过的段（个体L1 规则等）在生效面上消失。
    // 与规则件、对象读取同一口径：私有同名段覆盖出厂、未出现段继承出厂。
    const 自治文本 = await readTextOrNull(`${this.layout.roleCardDir('自治')}/${id}.md`);
    const 出厂文本 = await readTextOrNull(`${this.layout.roleCardDir('出厂')}/${id}.md`);
    if (自治文本 === null && 出厂文本 === null) return null;
    const parsed = effectiveDocument(出厂文本, 自治文本, { defaultAuthority: '自治', 出厂标为: '出厂', 私有标为: '自治' });
    // 解析错误响亮抛（2026-10-14 审查 P2-3）：与 #scanZone / 规则件同口径，
    // 修前 errors 静默丢弃——读得出一张坏卡 = 身份档案带病运行。
    if (parsed.errors?.length) {
      const 区 = 自治文本 !== null ? '自治' : '出厂';
      throw new Denied(
        '角色注册表 · 岗位卡无法解析（fail-closed）',
        `岗位卡文件「${区}区/${id}.md」解析失败：${parsed.errors.join('；')}。`,
        { howToChange: `修好 ${id}.md 的 front matter（${parsed.errors[0]}）后重试。` },
      );
    }
    const 来源 = 自治文本 !== null && 出厂文本 !== null ? `合并（${ZONES[0][1]}+${ZONES[1][1]}）` : (自治文本 !== null ? ZONES[0][1] : ZONES[1][1]);
    // 派生面只由正文算一次（card-credential 单源）：快照校验读的就是同一份派生，
    // 否则「读卡时怎么拆段」与「验快照时怎么拆段」会各写一份而漂移。
    const 派生 = deriveCardFaces(parsed.body);
    return {
      id: parsed.meta.id ?? spec.id,
      来源,
      meta: parsed.meta,
      段: 派生.段,
      能力引用: 派生.能力引用,
      经验引用: 派生.经验引用,
      正文: parsed.body,
    };
  }

  /**
   * 「这身份能碰什么」。
   *
   * 答案由两半拼成：岗位卡声明的段（身份/规则/能力/经验），与策略引擎对每个动作的实判。
   * 任何一半缺失都不给「大概能吧」这种答案。
   *
   * 补修J 续（2026-10-18 Lead 抽读）：**在册实例只看出生版**。修前 `cardOf` 未就绪时
   * 直接 `await get(档案岗位)` 拿现行卡顶上 ⇒ 卡文件一坏（或未钉 / 封存），当前的新规程
   * 就被当成旧实例的能力 / 经验输出。现在：在册实例钉住卡不可用 ⇒ 明确 `就绪:false` +
   * 原因，能力 / 经验一律不给（权限判定原本就只按岗位名走策略引擎，不读卡正文）；
   * 只有**无实例记录的按岗位预览**才读现行卡，并用 `预览:true` 与实例诊断分开。
   * 诊断读不抛：钉版 / 现行卡读取失败折成可读原因，接口照常返回。
   *
   * @param {{ id: string, 项目?: string }} spec
   * @returns {Promise<object>}
   */
  async canTouch(spec) {
    const identity = await this.#identity();
    const member = identity.members[spec.id];
    const 状态 = identityStatus(this.policy, spec.id);
    const 岗位 = member?.岗位 ?? spec.id;
    const 算权限 = async (卡id) => {
      const subject = subjectForRole(岗位, spec.id);
      const 权限 = [];
      for (const action of ACTIONS) {
        const decision = await this.policy.decide({
          subject,
          action,
          target: { id: 卡id, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: spec.项目 ?? null },
          context: {},
        });
        权限.push({ action, verdict: decision.verdict, rule: decision.rule });
      }
      return 权限;
    };
    if (member) {
      // 条目10：在册实例的「能碰什么」读**它出生的那一版卡**，不读现行卡——
      // 否则改一次卡文件，运行中实例的规则 / 能力面就静默换脸（钉版就成了纯血缘）。
      let 钉卡 = null;
      try {
        钉卡 = await this.cardOf(spec.id);
      } catch (error) {
        钉卡 = { 就绪: false, 原因: `钉版读数失败：${error instanceof Error ? error.message : String(error)}` };
      }
      if (钉卡?.就绪 !== true) {
        const 权限 = await 算权限(钉卡?.卡版本?.岗位 ?? 岗位);
        return {
          身份: spec.id,
          在岗: 状态.status === '在岗',
          状态: 状态.status,
          岗位,
          就绪: false,
          原因: `实例 ${spec.id} 的钉住卡不可用：${钉卡?.原因 ?? '没有可判读数'}。在册实例只看出生版——不把现行卡的新规程当成它的能力 / 经验；写前闸同样 fail-closed。`,
          权限,
          能力: [],
          经验: [],
          锁定的段: ['个体L0'],
          说明: '实例诊断（只读不抛）：钉住卡坏了不影响这个结论的读出，但能力 / 经验一律不给。',
        };
      }
      const 权限 = await 算权限(钉卡.岗位 ?? 岗位);
      return {
        身份: spec.id,
        在岗: 状态.status === '在岗',
        状态: 状态.status,
        岗位,
        就绪: true,
        权限,
        能力: 钉卡.能力引用 ?? [],
        经验: 钉卡.经验引用 ?? [],
        锁定的段: ['个体L0'],
        说明: '个体L0（身份核心）锁定，不可就地改写；个体L2 只存能力引用，不内嵌正文。',
      };
    }
    // 没有实例记录：**按岗位预览**现行卡。这是「该岗位现在的卡」的预览，不构成任何
    // 在册实例的出生版，也不是就绪凭证——用 `预览:true` 与上面的实例诊断分开。
    let card = null;
    let 读卡原因 = null;
    try {
      card = await this.get({ id: 岗位 });
    } catch (error) {
      读卡原因 = error instanceof Error ? error.message : String(error);
    }
    if (!card) {
      return {
        身份: spec.id,
        在岗: false,
        预览: true,
        原因: 读卡原因
          ? `按岗位「${岗位}」预览现行卡读不到：${读卡原因}`
          : (状态.known ? `身份 ${spec.id} 的岗位「${岗位}」没有岗位卡：权限来源唯一确定（§12.3），查不到就不放行。` : 状态.reason),
        权限: [],
        能力: [],
        经验: [],
        锁定的段: ['个体L0'],
      };
    }
    const 权限 = await 算权限(card.id);
    return {
      身份: spec.id,
      在岗: 状态.status === '在岗',
      状态: 状态.status,
      岗位,
      预览: true,
      权限,
      能力: card.能力引用,
      经验: card.经验引用,
      锁定的段: ['个体L0'],
      说明: '按岗位预览现行卡（无实例记录）：不是任何在册实例的出生版，也不构成就绪凭证；在册实例请用实例 id 读。',
    };
  }

  /**
   * 登记一个实例。岗位必须存在——实例权限只来自岗位。
   *
   * 守卫的实际落点（设计评审 #12 · 2026-10-15 如实改写——修前注释自称「三条守卫都在锁内」，
   * 实际岗位卡读取在锁外）：**在锁内**的是岗位卡存在性复检（`#mutateIdentity` 回调第一件事）
   * 与下面这张状态表（现存实例的分派判定）；**在锁外**的是 `policy.check`
   * （引擎判定自己另有读锁纪律）。锁外这道的剩余窗口如实标注：它通过之后、写入之前，
   * **策略规则被热改**会让本次登记带着过期的检查结果落盘——由写后 `policy.reload()`
   * 使后续判定立即回到新规则兜底。岗位卡那道修前也有同款窗口（check 与写入之间卡被删
   * ⇒ 不存在的岗位进档案），现已搬入锁内关门。
   * （v2 · 2026-10-18：复核员任命的授权引用校验已随复核者降级移除，锁外只剩 policy.check。）
   *
   * 这张表就是「assign 能做什么」的全部：
   *  | 实例现状 | 目标岗位 | 结果 |
   *  |---|---|---|
   *  | 没登记 | 任意（岗位卡存在） | 登记（在岗，第 `代` 代） |
   *  | 在岗 | 同岗位 | **幂等**：返回现状，不写盘、不重置代数、不记审计 |
   *  | 在岗 | 不同岗位 | **拒**：换岗要先停岗（否则一次 assign 就把第 N 代抹成第 1 代） |
   *  | 封存 | 同岗位 | **拒**：那是「静默复活」，还原走 `restore` |
   *  | 封存 | 不同岗位 | 允许：这就是**换岗的正路**（`seal` → `assign` 到新岗位） |
   *
   * 为什么封存那一行要分岗位（W3 批3·2026-10-09，两条裁决的接缝）：批2 定的规则是
   * 「封存实例不许靠 assign 复活」（指 restore），批3 定的规则是「在岗换岗位 ⇒ 拒，先 seal 再 assign」。
   * 两条都按字面执行的话，换岗会**无路可走**（seal 之后 assign 被拒、restore 之后 assign 又被拒）。
   * 所以封存那一格按目标岗位分流：同岗位 = 复活（拒，指 restore）；不同岗位 = 换岗（放行，
   * 且 `代` 由调用方显式给、留一条「登记到岗位 X」的审计）。
   *
   * @param {{ subject: object, 岗位: string, 实例: string, 代?: number, 授权引用?: string, 节点?: string, 会审?: {id: string, 项目: string, 资料?: string[]} }} spec
   *   `授权引用`：可选（v2 起复核员岗与成员同规则，不再必填）；给了就原样进链接受复核。
   *   `会审`（v2 条目18/20 · 补修I）：独立会审的临时参与实例绑定。只允许 **Lead/主权者** 给
   *   **普通成员岗**（复核员除外）落绑定；`来源会话` 强制取登记主体 id（不接受自报），
   *   身份记录落 `会审绑定 {会审, 项目, 来源会话, 资料}`。会审不占任务节点，故本参数与 `节点` 互斥。
   */
  async assign(spec) {
    // P1-13（全面审查 2026-10-17）：实例是身份真源的键，不能是 undefined/空串——修前省略
    // 实例会落 members["undefined"]（历史已发生过一次，org.js:417 的异常键统计就是它）。
    // 入口 fail-closed：空实例/空岗位一律拒，且先归一再去重、写 policy.target/档案/审计。
    const 实例 = String(spec.实例 ?? '').trim();
    const 岗位 = String(spec.岗位 ?? '').trim();
    if (!实例) {
      throw new InvalidBody('registry_assign 需要「实例」：省略实例会把一个不存在的键写进身份真源（历史坏键 members["undefined"] 即此）。', { missing: ['实例'] });
    }
    if (!岗位) {
      throw new InvalidBody('registry_assign 需要「岗位」：实例权限只来自岗位，空岗位不能被登记。', { missing: ['岗位'] });
    }
    spec = { ...spec, 实例, 岗位 };
    // 会审绑定（补修I）：先归一/校验，任何不合法都在写盘前拒（fail-closed）。
    const 会审绑定 = this.#会审绑定事实(spec);
    // v2（口述收敛 2026-10-18 条目20）：**不越授 / 不自授的判定在策略引擎不变式里**
    // （`#invariants` 先于授权块求值 ⇒ 权限矩阵里的 allow 翻不过来）。
    // 本方法只负责把不变式需要的**事实**备齐，不在这层再写一份同名判据：
    //  · `target.岗位` —— 不越授据此解析被派主体是什么种类；缺席即拒（不猜范围）。
    //  · `context.扩张集合` —— 只在「主体写自己的身份记录」时需要（不自授）。
    //    用下面 `扩张集合()` 算：空集 = 同权限的幂等登记，放行。
    // 修前这里那两段岗位名黑名单已删：它只挡得住「冒充 Lead / 主权者 / 出厂作者」三种写法，
    // 且挡在幂等分支**之前**——同岗位的重复登记会被误拒（判据明令禁止的形态）。
    const 授权引用 = typeof spec.授权引用 === 'string' ? spec.授权引用.trim() : '';
    const 自我登记 = 实例 === String(spec.subject?.id ?? '');
    const 扩张 = 自我登记 ? await this.扩张集合({ 实例, 岗位 }) : null;
    // v2（条目20 · 受控父判，2026-10-18）：把**委派者**钉在实例绑定上——策略引擎在成员每次
    // 写动作时用同一 action/target/context 对委派者做一次父判。这里只备事实，不判权。
    // 卡版本取委派者自己钉住的那一版（条目10），于是「父判依据的是父出生时的那张卡」可核。
    // 机制出生（系统）不算委派：那是宿主起会话，不是人派人。
    // **自己登记自己不算委派**（自我登记归「不自授」判），否则会给自己钉一个自指的父。
    const 委派者 = 自我登记 ? null : await this.#委派者事实(spec.subject);
    // 【锁外·设计评审 #12】引擎判定不占身份档案锁（policy 自己有读锁纪律），留在锁外。
    await this.policy.check({
      subject: spec.subject,
      action: 'create',
      target: { id: 实例, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: null, 岗位 },
      // 实例登记 ≠ 改岗位卡：预审档的高风险清单只罩「卡文档」的写/新建（v2 条目24）。
      context: { 身份操作: '实例', ...(扩张 ? { 扩张集合: 扩张 } : {}) },
    });
    /** @type {object|null} */
    let 幂等现状 = null;
    /** 本次是否发生了「迁移补登」（历史实例补卡版本 / 补委派归属）；补登要单独入账。 */
    /** @type {{类型: string[], 由: string|null, 于: string, 卡版本: string|null, 委派者: object|null}|null} */
    let 补登项 = null;
    /** 首次登记 = 这个实例第一次进身份档案（「创建」在账上的锚点，见方法头注释）。 */
    let 首登 = false;
    const updated = await this.#mutateIdentity(async (current) => {
      // 岗位卡存在性【锁内复检·设计评审 #12 · 2026-10-15】：修前在锁外预读（assign 一进来
      // 就 `this.get`）——check 与写入之间岗位卡被删/改名的话，一个「不存在的岗位」会被登记
      // 进档案（实例权限只来自岗位就成了空话）。搬进锁内：读的是持锁时刻的盘上事实，
      // 「卡在校验后被删」的窗口随锁关闭。幂等路径同样先过这道（与修前顺序一致：
      // 卡不存在就先拒，不进分派表）。
      const card = await this.get({ id: spec.岗位 });
      if (!card) {
        throw new Denied('角色注册表 · 实例权限只来自岗位（§7）', `岗位「${spec.岗位}」不存在：不能给一个不存在的岗位发实例权限。`, {
          requireAuthority: 'Lead',
          howToChange: '先在 集体L3-成员角色卡/ 建岗位卡，再派实例。',
        });
      }
      const 现存 = current.members[spec.实例];
      首登 = !现存;
      // 会审绑定（v2 条目18/20 · 补修I）：实例只绑一场会审与真实来源会话。已绑定的实例
      // 不许被普通登记静默改绑/解除——那会把「谁在咨询」洗掉，也会让退役归属失去判据。
      const 现有会审 = 现存?.会审绑定?.会审 ?? null;
      if (会审绑定) {
        if (现存 && !(现存.status === '在岗' && 现存.岗位 === spec.岗位)) {
          throw new Denied('角色注册表 · 会审参与实例只登记一次', `实例 ${spec.实例} 已存在（状态 ${现存.status ?? '缺失'}、岗位 ${现存.岗位 ?? '缺失'}）：会审绑定只随首次登记落下，封存/换岗实例不得再绑会审。`, {
            requireAuthority: 'Lead',
            howToChange: '会审参与实例是一次性的：需要重来就由 Lead 发起新会审、创建新实例；封存实例要换岗走 registry_restore + assign 的非会审路径。',
          });
        }
        if (现有会审 && 现有会审 !== 会审绑定.会审) {
          throw new Denied('角色注册表 · 会审绑定不可静默改绑', `实例 ${spec.实例} 已绑定会审 ${现有会审}，本次要绑 ${会审绑定.会审}：一次登记只能属于一场会审。`, {
            requireAuthority: 'Lead',
            howToChange: '由 Lead 另起会审参与实例；不要用同一实例跨场复用（独立作答会被污染，退役归属也无法判定）。',
          });
        }
        if (现存 && !现有会审) {
          throw new InvalidBody(`实例 ${spec.实例} 已在册但未绑定会审：不静默补绑（补绑等于给既有实例追加一个它出生时没有的身份面）。`, {
            missing: ['会审绑定'],
            howToChange: '由 Lead 发起会审时创建新实例；或先 registry_seal 该实例再按新身份重建。',
          });
        }
      } else if (现有会审) {
        throw new Denied('角色注册表 · 会审绑定不可静默解除', `实例 ${spec.实例} 的会审绑定（${现有会审}）只能随会审收敛封存保留，普通 assign 不得把它清掉。`, {
          requireAuthority: 'Lead',
          howToChange: '会审结束走 CouncilService 的退役（seal）；记录保留，不删绑定。',
        });
      }
      // 条目10：钉住**生效卡**的内容寻址快照（锁内、用刚读到的 card，不二次读盘）。
      const 钉 = this.#钉卡版本(card);
      // 卡内声明岗位必须与登记岗位一致（补修J）：`get()` 按文件名读卡、却以 front matter 的
      // `meta.id` 当卡的岗位，于是 `x.md` 自称 `id: y` 时能把 y 的规则面钉给 x 的实例。
      // 这里在写快照之前拒，不能等到读面再靠「钉.岗位 ≠ 档案岗位」兜。
      if (钉.岗位 !== spec.岗位) {
        throw new Denied('角色注册表 · 卡内声明岗位与登记岗位不符（fail-closed）', `岗位「${spec.岗位}」的卡文件在 front matter 里自称 id=${钉.岗位 ?? '缺失'}：卡内声明岗位与登记岗位必须是同一个值，否则一个实例可以借另一张卡的规则面。`, {
          requireAuthority: 'Lead',
          howToChange: `把 ${spec.岗位}.md 的 front matter id 改成与文件名一致后重试。`,
        });
      }
      await this.#写卡快照(card, 钉);
      if (现存?.status === '封存' && 现存.岗位 === spec.岗位) {
        throw new Denied('角色注册表 · 封存实例不得靠 assign 复活（§7）', `实例 ${spec.实例} 已封存在「${现存.岗位}」：assign 到**同一个岗位**会把它静默写回在岗，并把代数重置成 ${spec.代 ?? 1}（停岗决定被一次「补登记」撤销）。`, {
          requireAuthority: 'Lead',
          howToChange: '复岗走 registry_restore（显式的还原路径，有自己的留痕与闸）；要换到别的岗位则 assign 到那个新岗位（那正是 seal → assign 的换岗路）。',
        });
      }
      if (现存 && 现存.status === '在岗' && 现存.岗位 === spec.岗位) {
        幂等现状 = 现存;
        // 历史实例（本轮之前落的账）没有卡版本 / 没有委派者记录：由 Lead 显式来一次
        // **迁移补登**（2026-10-18 裁决）：只补缺的那一位、只记「补登类型/操作者/当前时点」，
        // **不动 创建于 / 登记于**（不伪称出生历史）；补登本身不授予任何现权（写前闸另判）。
        const 缺 = [];
        if (!现存.卡版本?.摘要) 缺.push('卡版本');
        if (!现存.委派者?.id) 缺.push('委派归属');
        const 补充 = {
          ...(缺.includes('卡版本') ? { 卡版本: 钉 } : {}),
          ...(缺.includes('委派归属') ? { 委派者 } : {}),
        };
        if (缺.length > 0 && Object.keys(补充).length > 0) {
          补登项 = {
            类型: 缺,
            由: spec.subject?.id ?? null,
            于: this.clock.iso(),
            卡版本: 补充.卡版本?.摘要 ?? null,
            委派者: 补充.委派者 ?? null,
          };
          return {
            ...current,
            members: {
              ...current.members,
              [spec.实例]: { ...现存, ...补充, 补登: [...(现存.补登 ?? []), 补登项] },
            },
          };
        }
        return current; // 原样返回 ⇒ #mutateIdentity 不写盘、不重载、不记审计
      }
      // 在岗换岗位 ⇒ 拒（W3 批3·2026-10-09）：此前 assign 会直接覆盖岗位并把 `代` 重置成
      // `spec.代 ?? 1` —— 一次「换个岗」就把「第 N 代」抹成「第 1 代」，两代之间的断点消失。
      // 换岗是一次身份变更，必须留下停岗这一步（与封存那条同款：先停、再登）。
      if (现存 && 现存.status === '在岗' && 现存.岗位 !== spec.岗位) {
        throw new Denied('角色注册表 · 在岗实例换岗位要先停岗（§7）', `实例 ${spec.实例} 正在「${现存.岗位}」在岗：assign 直接改岗位会把它写进「${spec.岗位}」并重置代数（第 ${现存.代 ?? 1} 代 → 第 ${spec.代 ?? 1} 代），换岗这件事在账上就没了断点。`, {
          requireAuthority: 'Lead',
          howToChange: `先 registry_seal 停掉「${现存.岗位}」岗，再 assign 到「${spec.岗位}」——停岗那一步就是换岗的留痕。`,
        });
      }
      const 于 = this.clock.iso();
      // 生命周期（条目10）：**创建于**只在首登时落，后续重登不覆盖（它是「这个主体第一次
      // 在账上出现」的锚，见下方「主体创建入账」同款口径）；绑定由调用方显式给节点时落，
      // 活跃 / 交卷由 `sync()` 从审计链与任务事件流投影（不在这里造假时点）。
      const 生命周期 = {
        ...(现存?.生命周期 ?? {}),
        创建于: 现存?.生命周期?.创建于 ?? 于,
        封存于: null,
        ...(spec.节点 ? { 绑定时: 于, 绑定节点: String(spec.节点) } : {}),
        // 会审绑定与任务绑定互斥（会审不占任务图）：只落「哪一场 + 何时」两个事实。
        ...(会审绑定 ? { 绑定时: 于, 绑定会审: 会审绑定.会审 } : {}),
      };
      return {
        ...current,
        members: {
          ...current.members,
          [spec.实例]: {
            ...(现存 ?? {}),
            id: spec.实例,
            岗位: spec.岗位,
            代: spec.代 ?? 1,
            status: '在岗',
            登记于: 于,
            卡版本: 钉,
            生命周期,
            // 会审参与实例的天然载体（v2 条目18/20 · 补修I）：绑定写在实例记录上，
            // 不立统一授权对象；guard/策略/退役都读这一份，来源会话不由模型自报。
            ...(会审绑定 ? { 会审绑定 } : {}),
            // 受控父判的依据（条目20）：谁派的活、它当时是什么主体、凭哪一版卡。
            // 历史实例没有这一位 ⇒ 策略引擎不做父判（明确残余，不猜）。
            ...(委派者 ? { 委派者 } : {}),
            // 代次（条目12）：实例出生在哪一个宿主进程代次里。后面判孤儿只认这个事实，
            // 不靠「某次 Org.open 没看到它」猜死。
            // **pid 随实例一起记**（2026-10-18 收尾修正）：boot.代次记录只留最近 8 代，
            // 只存代次 uuid 的话，隔几代之后旧实例就永远「无 pid 记录 ⇒ 未判定」。
            // 把出生那一刻的 pid 钉在实例上，判孤儿就不再依赖「记录还没被截断」。
            ...(spec.代次 ? { 代次: { 代: spec.代次.代, pid: spec.代次.pid ?? null } } : {}),
          },
        },
      };
    });
    if (幂等现状) {
      if (补登项) {
        // 迁移补登单独入账（**不是**「主体创建」）：账上要说清「这不是出生事实，是补记」，
        // 补的哪一位、谁补的、什么时候补的。
        await this.audit.append({
          动作: '迁移补登',
          主体: spec.subject,
          对象: { id: spec.实例, kind: '身份' },
          依据: 'v2 条目10/20：历史实例的版本 / 委派凭证由 Lead 显式补登；历史只读，前向写约束',
          结果: `补登 ${补登项.类型.join('、')}`,
          详情: { 类型: 补登项.类型, 卡版本: 补登项.卡版本, 委派者: 补登项.委派者?.id ?? null, 时点: 补登项.于, 定性: '补记当前凭证，不是出生历史' },
        });
      }
      return {
        实例: spec.实例,
        岗位: 幂等现状.岗位,
        代: 幂等现状.代 ?? 1,
        状态: '在岗',
        幂等: true,
        卡版本: updated.members[spec.实例]?.卡版本?.摘要 ?? 幂等现状.卡版本?.摘要 ?? null,
        ...(补登项 ? { 补登: 补登项 } : {}),
        说明: 补登项
          ? '该实例已在同一岗位在岗：本次只做迁移补登（补缺的卡版本 / 委派归属），没有重置代数、没有改出生时间。'
          : '该实例已在同一岗位在岗：没有写盘、没有重置代数、没有新增留痕。',
      };
    }
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.实例, kind: '身份' },
      依据: '角色注册表：实例权限只来自岗位',
      结果: `登记到岗位 ${spec.岗位}（第 ${spec.代 ?? 1} 代）`,
      // 审计带卡版本（条目10）：账上要能回答「它当时凭的是哪一版岗位卡」。
      详情: { 实例数: Object.keys(updated.members).length, 卡版本: updated.members[spec.实例]?.卡版本?.摘要 ?? null, 卡声明版本: updated.members[spec.实例]?.卡版本?.声明版本 ?? null, 会审: updated.members[spec.实例]?.会审绑定?.会审 ?? null },
    });
    // 主体创建入账（task-机制缺口-10th0 · 裁决① · 2026-10-13）：spawn 发生在宿主侧（Agent Teams），
    // 组织侧看不见——891jd 决策备忘录已判「宿主侧挂钩归属错」（选项 C），本条走裁决给的
    // 退路：**首次登记即创建入账**，把「这个主体是什么时候第一次在账上出现」钉进审计链。
    // 防泄密口径与 8dt59 同源：只记实例 id 与动作名，详情为空，不抄任何入参内容。
    // 残余盲区（如实标注）：被创建但**从未登记、也从未敲过门**的主体，账上仍不可见——
    // 敲过门的由「身份未登记拦截」入账（8dt59），报告面（registry_list）会把两者对出来。
    if (首登) {
      await this.audit.append({
        动作: '主体创建',
        主体: spec.subject,
        对象: { id: spec.实例, kind: '身份' },
        依据: '角色注册表：首次登记即创建入账（spawn 在宿主侧，账上以首登为锚）',
        结果: '已入账',
        详情: 授权引用 ? { 授权引用 } : {},
      });
    }
    return { 实例: spec.实例, 岗位: spec.岗位, 代: spec.代 ?? 1, 状态: '在岗' };
  }

  /**
   * 封存：停岗但不删卡（§7「封存 ≠ 删除」）。
   * @param {{ subject: object, 实例: string, 理由: string }} spec
   */
  async seal(spec) {
    await this.policy.check({
      subject: spec.subject,
      action: 'seal',
      target: { id: spec.实例, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: null },
      // 机制动作（条目8/12）：孤儿回收走同一条 seal 路径（单源），由调用方声明机制名；
      // 人 / Lead 的停岗不带它，系统写若不带则被策略引擎拒。
      context: spec.机制动作 ? { 机制动作: spec.机制动作 } : {},
    });
    const updated = await this.#mutateIdentity((current) => {
      const member = current.members[spec.实例];
      if (!member) throw new InvalidBody(`身份档案里没有 ${spec.实例}`);
      const 于 = this.clock.iso();
      return {
        ...current,
        members: {
          ...current.members,
          [spec.实例]: {
            ...member,
            status: '封存',
            封存于: 于,
            理由: spec.理由,
            生命周期: { ...(member.生命周期 ?? {}), 封存于: 于 },
          },
        },
      };
    });
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.实例, kind: '身份' },
      依据: '角色注册表：封存 ≠ 删除',
      结果: '封存（岗位卡仍在盘上）',
      详情: { 理由: spec.理由 },
    });
    return { 实例: spec.实例, 状态: '封存', 岗位卡仍在: Boolean(await this.get({ id: updated.members[spec.实例]?.岗位 })) };
  }

  /**
   * 恢复封存（主权者任何一次交互即解除失联之外的还原路径）。
   * @param {{ subject: object, 实例: string }} spec
   */
  async restore(spec) {
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: { id: spec.实例, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: null },
      context: {},
    });
    await this.#mutateIdentity((current) => {
      const member = current.members[spec.实例];
      if (!member) throw new InvalidBody(`身份档案里没有 ${spec.实例}`);
      return {
        ...current,
        members: {
          ...current.members,
          [spec.实例]: { ...member, status: '在岗', 封存于: null, 理由: null, 生命周期: { ...(member.生命周期 ?? {}), 封存于: null } },
        },
      };
    });
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.实例, kind: '身份' },
      依据: '角色注册表：恢复在岗',
      结果: '在岗',
    });
    return { 实例: spec.实例, 状态: '在岗' };
  }

  /**
   * 撤回 = 写拒绝名单，不删卡（§4 三权）。
   * @param {{ subject: object, 对象id: string, 理由: string }} spec
   */
  async revoke(spec) {
    await this.policy.check({
      subject: spec.subject,
      action: 'revoke',
      target: { id: spec.对象id, kind: '身份', authority: '法律', zone: '私有', domain: '个体', project: null },
      context: {},
    });
    const updated = await this.#mutateIdentity((current) => ({
      ...current,
      denylist: [...current.denylist.filter((d) => d.id !== spec.对象id), { id: spec.对象id, 理由: spec.理由, 撤于: this.clock.iso(), 由: spec.subject?.id ?? null }],
    }));
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.对象id, kind: '拒绝名单' },
      依据: '§4 三权：撤回 = 写拒绝名单，不删卡',
      结果: '已撤回（对象仍然存在）',
      详情: { 理由: spec.理由, 名单长度: updated.denylist.length },
    });
    const card = await this.get({ id: spec.对象id });
    return { 对象id: spec.对象id, 已撤回: true, 卡仍存在: card !== null, 名单长度: updated.denylist.length };
  }

  /** @returns {Promise<Array<{id: string, 理由: string, 撤于: string}>>} */
  async denylist() {
    return (await this.#identity()).denylist;
  }

  /**
   * 记录主权者的一次交互。失联判定以它为起点（§4）。
   *
   * 来源闸（设计评审 #7 · 2026-10-15）：修前无闸无痕——任何持有 Org 引用的代码路径都能
   * 重置失联时钟，解冻完全依赖调用方纪律。现在 `来源` 必填且只认白名单（fail-closed：
   * 缺席/名单外 ⇒ InvalidBody 响亮拒），并在 `sovereign` 上与 `lastInteraction` 并列落
   * `交互来源`（**不动 `lastInteraction` 的形状**——policy/time 的失联判定在读它，
   * `evaluateSovereignPresence` 只认那一个键）。
   *
   * 入账口径（防刷屏）：**只在「失联→在线」迁移那一刻**落一条「主权者交互」审计
   * （详情注明来源与解除时刻）；常规心跳（每次 user/message 都走到这里）不逐条入账
   * ——与 §7「普通调用不逐次记」纪律一致。迁移判定放在 `#mutateIdentity` 的**锁内**、
   * 写之前：读的是刚从盘上拿到的 `current.sovereign.lastInteraction`（引擎快照可能落后于
   * 手改的档案），期限用 `presence()` 已解析的生效值（与 /mind status 同一把尺）——
   * 两个合法调用方各自在调用前后判定会在并发交互下双记，单源 + 锁内正好一次。
   * 白名单多一个「部署引导」：`org.bootstrap()` 在身份档案缺失时以「主权者启动了这个部署」
   * 落第一次交互（org.js:130，任务清单外的第三个合法调用方——不加会砸掉全部新部署引导）。
   *
   * @param {{ 来源: '宿主事件'|'presence命令'|'部署引导', 于?: string }} [spec]
   */
  async markInteraction(spec = {}) {
    if (!交互来源白名单.includes(spec.来源)) {
      throw new InvalidBody(
        `主权者交互必须声明来源（fail-closed）：只认 ${交互来源白名单.map((s) => `「${s}」`).join('、')}，收到 ${JSON.stringify(spec.来源 ?? null)}。失联时钟的解冻不能依赖调用方纪律（设计评审 #7 · 2026-10-15）。`,
        { missing: ['来源'], detail: { 合法来源: 交互来源白名单 } },
      );
    }
    const 读数 = this.policy.presence(); // 永不抛；已关闭/在线都如实
    let 迁移 = false;
    const updated = await this.#mutateIdentity((current) => {
      迁移 = 读数.失联限制 !== false && !读数.已关闭 && evaluateSovereignPresence({
        lastInteraction: current.sovereign?.lastInteraction ?? null,
        responseDeadlineHours: 读数.生效响应期限小时,
        now: this.clock.now(),
      }).lost;
      return {
        ...current,
        sovereign: { ...current.sovereign, lastInteraction: spec.于 ?? this.clock.iso(), 交互来源: spec.来源 },
      };
    });
    if (迁移) {
      await this.audit.append({
        动作: '主权者交互',
        主体: { id: 'sovereign', kind: '主权者' },
        对象: { id: 'sovereign', kind: '失联' },
        依据: '§4 失联：主权者任何一次交互即解除——只在失联→在线迁移那一刻入账，常规心跳不逐条记',
        结果: '失联解除（在线）',
        详情: { 来源: spec.来源, 解除时刻: updated.sovereign.lastInteraction },
      });
    }
    return { lastInteraction: updated.sovereign.lastInteraction, 交互来源: spec.来源 };
  }

  /** @returns {Promise<object>} 身份档案原文 */
  async identity() {
    return this.#identity();
  }

  /**
   * **同步只读**的实例凭证快照（唯一规范化口径，供宿主同步 `tools.guard` 用）。
   *
   * 为什么要有它：官方 guard 是**同步**的（`exec.arguments` 在官方源码 3259-64 取证），
   * 而 `registry.identity()` 是异步的。若让 guard 自己 `readFileSync + 裸 JSON.parse`，
   * 判据就抄了第二份（两份一定会漂），且坏档案的形态各家自己解释。这里给一份**规范化后**
   * 的读数，guard 只管按 `岗位/就绪/委派者` 做闭名单判断。
   *
   * 三条硬约束：
   *  ① **永不抛**：读不到 / 解析失败 / 形状不对 ⇒ `ok:false` + 可读原因（判据能"判失败"）；
   *  ② **绝不拿空表放行**：`ok:false` 时 `成员` 必为空且调用方必须 fail-closed；只有
   *     「未引导」（档案不存在 / 没有 members 键）才 `ok:true, 未引导:true, 成员:{}`——
   *     那是全新部署的合法初态，不是坏档；
   *  ③ **口径与写前闸一致**：`就绪 = 在岗 && 卡版本摘要 && 卡快照内容校验通过 &&
   *     (成员岗还要 委派者 id)`；Lead / 主权者 / 出厂作者不要求委派者（天然凭证，不泛化系统豁免）。
   *     卡面校验与 `cardOf` / `policy` 写前闸共用 card-credential 的唯一校验面（补修J：
   *     摘要字符串不是凭证，必须由正文重算并重派生段与能力引用）。
   *
   * @returns {{ok: boolean, 原因?: string, 未引导?: boolean, 成员: Record<string, {id: string, 岗位: string|null, 状态: string|null, 卡版本摘要: string|null, 委派者id: string|null, 就绪: boolean, 未就绪原因?: string}>}}
   */
  snapshotSync() {
    return readInstanceSnapshot(this.layout.identityFile());
  }

  // ── 实例模型：钉卡版本 / 生命周期 / 孤儿回收（v2 条目9/10/12） ────────────────

  /**
   * 会审绑定事实（v2 条目18/20 · 补修I 的实例侧唯一归一/预检点）。
   *
   * 为什么放在 registry 而不是 council 服务里再判一次：绑定最终落身份档案，写口的判据
   * 必须与档案形状同处；会审服务只负责编排「建 → 绑 → 发」，不复制身份规则。三条硬边界：
   *  - 只有 Lead / 主权者能创建会审参与实例（成员不得自授）；
   *  - 岗位必须是普通成员岗，**复核员除外**——复核员「只读数、不改、不提案」是本职硬约束，
   *    会审作答是一次写；不为齐卷给复核岗开口子；
   *  - `来源会话` 强制取登记主体 id（真实 exec 会话事实），不接受调用方/模型自报。
   *
   * @param {object} spec `assign` 的入参（已归一 实例/岗位）
   * @returns {{会审: string, 项目: string, 来源会话: string, 资料: string[]}|null}
   */
  #会审绑定事实(spec) {
    if (spec.会审 === undefined || spec.会审 === null) return null;
    if (spec.节点) {
      throw new InvalidBody('会审参与实例不得同时绑定任务节点：会审已退出任务图（v2 条目18），实例只绑独立会审与来源会话。', { missing: [] });
    }
    const 岗位 = String(spec.岗位 ?? '');
    if (subjectKindForRole(岗位) !== '成员' || 岗位 === '复核员') {
      throw new Denied('角色注册表 · 会审参与实例只能是普通成员岗', `岗位「${岗位}」不能作为会审参与实例：角色种类为 ${subjectKindForRole(岗位)}${岗位 === '复核员' ? '（复核员的只读/不提案是本职硬约束）' : ''}。`, {
        requireAuthority: 'Lead',
        howToChange: 岗位 === '复核员'
          ? '复核意见走真正的复核任务：Lead 建复核任务 + 显式复核对象，再 member_spawn 复核员实例；不要为齐卷给复核岗开口子。'
          : '会审参与实例只用普通成员岗（插件工程 / 文档整理 / 记忆整理…）；Lead/主权者不由此入口创建。',
      });
    }
    if (!['Lead', '主权者'].includes(spec.subject?.kind)) {
      throw new Denied('角色注册表 · 只有 Lead/主权者可创建会审参与实例', `${spec.subject?.kind ?? '未知'} 不得创建会审参与实例：会审是 Lead 的会话级咨询工具，实例创建属于派活面。`, {
        requireAuthority: 'Lead',
        howToChange: '由 Lead（根会话）发起会审，或由主权者直接执行。',
      });
    }
    const 源 = spec.会审;
    if (typeof 源 !== 'object' || Array.isArray(源)) {
      throw new InvalidBody('会审绑定必须是对象 {id, 项目, 资料?}。', { missing: ['会审'] });
    }
    const id = String(源.id ?? '').trim();
    const 项目 = String(源.项目 ?? '').trim();
    const 来源会话 = String(spec.subject?.id ?? '').trim();
    if (!id) throw new InvalidBody('会审绑定缺 id：不知道绑哪一场会审，退役归属就无从判定。', { missing: ['会审.id'] });
    if (!项目) throw new InvalidBody('会审绑定缺 项目：会审账本按项目隔离，跨项目找不到这场会审。', { missing: ['会审.项目'] });
    if (!来源会话) throw new InvalidBody('会审绑定缺来源会话：来源会话只能取真实登记主体 id。', { missing: ['subject.id'] });
    const 资料 = [...new Set((Array.isArray(源.资料) ? 源.资料 : []).map((x) => String(x ?? '').trim()).filter(Boolean))];
    return { 会审: id, 项目, 来源会话, 资料 };
  }

  /**
   * 委派者事实（v2 条目20 · 受控父判的唯一来源）。
   *
   * 记 `{id, kind, 卡版本}`：id/kind 决定父判用哪个主体判；卡版本是委派者**出生时钉住**的
   * 那一版（条目10），于是「父判凭的是哪一版规则」也可核。
   *
   * 机制出生（系统）不算委派——那是宿主起会话，不是人/组织派人；返回 null。
   *
   * @param {object} subject 登记时的主体
   * @returns {Promise<{id: string, kind: string, 卡版本: string|null}|null>}
   */
  async #委派者事实(subject) {
    const id = String(subject?.id ?? '').trim();
    const kind = String(subject?.kind ?? '').trim();
    if (!id || !kind || kind === '系统') return null;
    const 钉 = await this.cardOf(id);
    return { id, kind, 卡版本: 钉?.卡版本?.摘要 ?? null };
  }

  /**
   * 取某实例**钉住的岗位卡**（条目10 的唯一解析面）。
   *
   * 为什么不是「读现行卡」：条目10 的用途是让运行中实例的规则 / 能力面**不随卡文件改动
   * 静默变化**——只在实例上存一个摘要只能事后对账，钉不住任何东西。所以这里读的是
   * assign / 出生时按内容哈希落下的**快照**（`身份档案/卡快照/<摘要>.json`），
   * 同摘要必同内容、写一次永不覆盖。
   *
   * 返回里同时给 `现行摘要`：卡改了以后，读的人要能看出「钉的是旧版、盘中是新版」，
   * 但**不会**因此改用新版（那正是「规则半途变脸」）。历史实例没有钉版 ⇒ 返回
   * `{ 未钉: true, ... }`，由调用方显式说明，不拿现行卡冒充已钉。
   *
   * 补修J（2026-10-18 独立审计）：返回的 `段`/`能力引用` **只来自通过真实内容校验的正文**
   * （岗位对齐 + 重算摘要 + 派生面重派生）。校验不过 ⇒ `就绪:false` + 原因、段/能力为 null，
   * 不再把快照里的派生字段原样透出。
   *
   * @param {string} 实例
   * @returns {Promise<{岗位: string, 卡版本: object, 段: object, 能力引用: string[], 经验引用: string[], 未钉?: boolean, 就绪?: boolean, 原因?: string, 现行摘要?: string|null, 现行摘要原因?: string} | null>}
   */
  async cardOf(实例) {
    const member = (await this.#identity()).members[实例];
    if (!member) return null;
    const 钉 = member.卡版本;
    const 岗位 = 钉?.岗位 ?? member.岗位 ?? null;
    const status = member.status ?? null;
    // 现行卡只是「钉的是旧版、盘里是新版」的对照读数，不是规则面的权威：它坏了
    // （解析失败 / 读不到）不能把已钉实例的读面带炸，更不能拿它顶替钉住版。
    let 现行摘要 = null;
    let 现行摘要原因 = null;
    try {
      现行摘要 = await this.#现行摘要(member.岗位);
    } catch (error) {
      现行摘要原因 = `现行卡读不到：${error instanceof Error ? error.message : String(error)}`;
    }
    const 对照读数 = { 现行摘要, ...(现行摘要原因 ? { 现行摘要原因 } : {}) };
    // 2026-10-18 合同收紧（W5 审计 + Lead 裁决）：**不可用 ≠ 已就绪**。
    // 修前返回 `段: {}, 能力引用: []` —— 读的人（canTouch / 入口快照校验）会把「空」当成
    // 「这个实例什么都没有」，即用空壳伪成功。现在四种不可用一律 `就绪:false` + 明确原因，
    // 由调用方 fail-closed（写）或显式报未就绪（读），字段：岗位/status/未钉/就绪/原因。
    if (status !== '在岗') {
      return { 岗位, status, 卡版本: 钉?.摘要 ? 钉 : null, 段: null, 能力引用: null, 经验引用: null, 未钉: !钉?.摘要, 就绪: false, 原因: `实例状态为 ${status ?? '状态缺失'}（不是「在岗」）：卡的规则面不可用`, ...对照读数 };
    }
    if (!钉?.摘要) {
      // 未钉（本轮之前登记的实例）：如实说「未钉」，不静默回落到现行卡。
      return { 岗位, status, 卡版本: null, 段: null, 能力引用: null, 经验引用: null, 未钉: true, 就绪: false, 原因: '未钉卡版本：没有可解析的规则面（读现行卡会随口令漂移，不做）', ...对照读数 };
    }
    // 补修J（2026-10-18 独立审计）：**摘要字符串不是凭证**。修前这里 readJson 完就把
    // 快照里的段 / 能力引用原样返回——旧摘要配新规程、正文被改、派生字段被偷换都看不出来。
    // 现在归一到 card-credential 的唯一校验面：岗位对齐 + 重算摘要 + 派生面重算。
    const 档案岗位 = member.岗位 ?? null;
    // 旧 schema 的钉版元记录可能没有 `岗位` 这个辅助字段：那就以**权威登记岗位**为准，
    // 快照自己声明的岗位仍要与之对齐（validator 里查）。不默认它一定存在，也不为补字段改档案。
    if (typeof 钉.岗位 === 'string' && 钉.岗位 && 钉.岗位 !== 档案岗位) {
      return {
        岗位,
        status,
        卡版本: 钉,
        段: null,
        能力引用: null,
        经验引用: null,
        未钉: false,
        就绪: false,
        原因: `钉住的卡岗位「${钉.岗位 ?? '缺失'}」与档案登记岗位「${档案岗位 ?? '缺失'}」不符：不拿另一张卡当规则面（换岗走 seal → assign）`,
        ...对照读数,
      };
    }
    const 读 = readVerifiedCardSnapshot(this.layout.cardSnapshot(钉.摘要), { 钉, 期望岗位: 档案岗位 });
    if (!读.ok) {
      return {
        岗位,
        status,
        卡版本: 钉,
        段: null,
        能力引用: null,
        经验引用: null,
        未钉: false,
        就绪: false,
        原因: `卡快照内容校验失败：${读.原因}（坏证据不默用，不能伪成功）`,
        ...对照读数,
      };
    }
    return {
      岗位,
      status,
      卡版本: 钉,
      段: 读.段,
      能力引用: 读.能力引用,
      经验引用: 读.经验引用,
      未钉: false,
      就绪: true,
      ...对照读数,
    };
  }

  /**
   * 「不自授」的扩张集合（条目20 的唯一比较实现）。
   *
   * 判的是**扩张**而不是「不许登记自己」：同权限的幂等登记必须放行（修前按名字的黑名单
   * 把它误拒了）。比较面就取现有真凭证：
   *  - **主体种类**：换到更高的种类 = 扩权（成员 → Lead 级）；
   *  - **能力引用**：新增一项 = 工作面变大（同为成员岗也可能扩：插件工程 → 记忆整理
   *    会拿到 memory-write / audit-append）；
   *  - **卡版本**：岗位没变但卡改了 ⇒ 新规则面，列为扩张项（由不自授拒，不许自己换代）；
   *  - **首登**：档案里没有这条记录 ⇒ 任何岗位都是新权，列表非空。
   *
   * ⚠️ 工具面**不在这里**：本组织的工具总范围是进程级配置（宿主 guard 对任何主体同一份），
   * 没有「按岗位细分工具集」的真凭证——所以工具面不参与比较，也不假装参与了。
   * 这一格如实记为缺口（工具面扩张只能来自调用方多传参数，那在 member_spawn 侧响亮拒）。
   *
   * @param {{实例: string, 岗位: string}} spec
   * @returns {Promise<string[]>} 空数组 = 无扩张（幂等 / 同权登记）
   */
  async 扩张集合(spec) {
    const { members } = await this.#identity();
    const 现存 = members[spec.实例] ?? null;
    const 扩张 = [];
    if (!现存) {
      扩张.push(`首登岗位 ${spec.岗位}`);
      return 扩张;
    }
    const 现岗位 = 现存.岗位 ?? null;
    const 现种类 = subjectKindForRole(现岗位);
    const 新种类 = subjectKindForRole(spec.岗位);
    if (subjectRank(新种类) !== subjectRank(现种类)) {
      扩张.push(`主体种类 ${现种类} → ${新种类}`);
    }
    const [现卡, 新卡] = await Promise.all([
      现岗位 ? this.get({ id: 现岗位 }) : null,
      this.get({ id: spec.岗位 }),
    ]);
    const 现有引用 = new Set(现卡?.能力引用 ?? []);
    for (const 引用 of (新卡?.能力引用 ?? [])) {
      if (!现有引用.has(引用)) 扩张.push(`能力引用 + ${引用}`);
    }
    const 现摘要 = 现存.卡版本?.摘要 ?? null;
    if (新卡) {
      const 新摘要 = this.#钉卡版本(新卡).摘要;
      // 历史实例**未钉**时不算扩张：钉版只是把「它此刻本来就在按这份卡跑」记下来
      // （未钉实例的读面本来回落到现行卡），不改变任何权限面。已钉的换版本才算。
      if (现摘要 && 现摘要 !== 新摘要) {
        扩张.push(`卡版本 ${现摘要.slice(0, 8)} → ${新摘要.slice(0, 8)}`);
      }
    }
    return 扩张;
  }

  /**
   * Lead 实例随主会话出生（条目9/10：**Lead 也钉卡版本**）。
   *
   * 谁调用：工具 / 命令面的主体解析之后（`lib/actions.js` 的 runAction 单点）。
   * 为什么主体仍是「系统」：出生登记是**机制动作**（宿主起了这个会话，不是 Lead 给自己
   * 发了一张卡），它必须能在任何主体第一次行动之前完成；机制名 `实例出生` 在封闭清单里。
   *
   * 已有身份不重生、不换岗、不复岗。唯有旧运行绑定可由宿主真实根会话核验后续接；
   * 身份状态、钉卡与生命周期不变，运行绑定单独经策略并记审计。
   *
   * @param {{实例: string, 代次?: {代: string, pid?: number}, 宿主会话?: object}} spec
   * @returns {Promise<{已登记: boolean, 就绪: boolean, 新建?: boolean, 岗位?: string|null, 卡版本?: string|null, 状态?: string|null, 原因?: string}>}
   *
   * **合同（2026-10-18 与 Lead/A 成员对齐，勿改形状）**：
   *   已登记 = 身份档案里有这条实例记录（有过登记事实）；
   *   就绪   = 可立即可用于自治写（在岗 + 档案岗位就是 Lead + 钉版摘要非空 + 快照真实内容
   *            校验通过；补修J：只看摘要字符串不算就绪）；
   *   卡版本 = 钉住的卡版本摘要或 null；
   *   原因   = 不就绪时的可读理由（就绪时不出现）。
   * 入口（A 成员）的放行条件（**严格等于**，2026-10-18 校正）：`已登记 === true && 就绪 === true && 卡版本非空`。
   * 「就绪 !== false」不是本合同——unknown / 缺字段一律按未就绪处理，不给默认放行。
   * 出生路径**不复活封存、不补钉、不把「记录在但不可用」说成幂等成功**。
   */
  async ensureLeadInstance(spec) {
    const 实例 = String(spec.实例 ?? '').trim();
    if (!实例) return { 已登记: false, 就绪: false, 岗位: null, 卡版本: null, 原因: '没有会话 id：给不出「哪一个 Lead 实例」，不猜。' };
    const 身份 = await this.#identity();
    const 现存 = 身份.members[实例];
    if (身份.denylist.some((d) => d.id === 实例 || d.id === 'Lead')) {
      return { 已登记: Boolean(现存), 就绪: false, 卡版本: null, 原因: '实例或 Lead 岗位已撤权：宿主续接不恢复撤权身份。' };
    }
    if (现存) {
      // 2026-10-18 W5 审计收口：已有记录**不等于就绪**。三条都如实报「未就绪」，
      // 不自动复活（封存是停岗决定）、不自动补钉（那是写前快照校验的职责）、
      // 也不把「记录在但不可用」说成幂等成功——假绿比报错更坏。
      const 卡版本 = 现存.卡版本?.摘要 ?? null;
      // 补修J（2026-10-18 独立审计）：**出生路径只认 Lead 卡**。修前只看「在岗 + 有摘要
      // + JSON 能读」，根会话若背着一张成员卡（档案岗位是成员岗/复核员）照样报就绪，
      // 于是 kind=Lead 的根会话拿到成员卡当规则面、还能据此写与注入规程。
      // 这里只报「未就绪 + 诊断原因」：不自动换岗、不换现行卡——换岗是 seal → assign 的正路。
      if (现存.岗位 !== 'Lead') {
        return {
          已登记: true,
          就绪: false,
          岗位: 现存.岗位 ?? null,
          卡版本,
          状态: 现存.status ?? null,
          原因: `实例 ${实例} 的档案岗位是「${现存.岗位 ?? '缺失'}」（不是 Lead）：Lead 出生路径只认 Lead 卡，不借成员卡当 Lead；换岗走 seal → assign，只读诊断保留。`,
        };
      }
      if (现存.status !== '在岗') {
        return {
          已登记: true,
          就绪: false,
          岗位: 现存.岗位 ?? null,
          卡版本,
          状态: 现存.status ?? null,
          原因: `实例 ${实例} 已存在但状态为 ${现存.status ?? '状态缺失'}：出生路径不复活它（复岗走 registry_restore，显式且留痕）。`,
        };
      }
      if (!卡版本) {
        return {
          已登记: true,
          就绪: false,
          岗位: 现存.岗位 ?? null,
          卡版本: null,
          状态: 现存.status ?? null,
          原因: `实例 ${实例} 已存在但未钉卡版本：出生路径不补钉（会变成假幂等成功）；由写前快照校验补齐后再写。`,
        };
      }
      // 有记录、在岗、有摘要，但快照读不到 ⇒ 仍然不就绪（不拿空壳冒充）。
      const 读 = await this.cardOf(实例);
      if (读?.就绪 !== true) {
        return { 已登记: true, 就绪: false, 岗位: 现存.岗位 ?? null, 卡版本, 状态: 现存.status ?? null, 原因: 读?.原因 ?? '卡快照不可用' };
      }
      const 旧代 = typeof 现存.代次 === 'string' ? 现存.代次 : 现存.代次?.代;
      if (现存.运行绑定?.状态 === '失效' || (旧代 && spec.代次?.代 && 旧代 !== spec.代次.代)) {
        const 旧pid = typeof 现存.代次 === 'object' ? 现存.代次?.pid : 身份.boot?.代次记录?.[旧代]?.pid;
        if (现存.运行绑定?.状态 !== '失效' && (旧pid == null || (旧pid !== spec.代次?.pid && 进程存活(旧pid)))) {
          return { 已登记: true, 就绪: false, 卡版本, 原因: '旧运行仍存活或缺失可靠代次事实：不抢占绑定。' };
        }
        const 会话 = spec.宿主会话;
        const header = 会话?.header;
        // 此参数只由宿主入口传递，绝不从工具 args / subject.kind 或实例字符串取证。
        if (会话?.id !== 实例 || !header || (header.id != null && header.id !== 实例)
          || header.origin === 'subagent' || (header.delegationDepth != null && header.delegationDepth !== 0)) {
          return { 已登记: true, 就绪: false, 卡版本, 原因: '旧运行绑定不可用：缺少匹配的宿主真实根会话事实，不自动续接。' };
        }
        await this.#leadBinding({ 实例, 状态: '有效', 代次: spec.代次, 旧记录: 现存 });
      }
      return { 已登记: true, 就绪: true, 新建: false, 岗位: 现存.岗位 ?? null, 卡版本, 状态: 现存.status ?? null };
    }
    const card = await this.get({ id: 'Lead' });
    if (!card) return { 已登记: false, 就绪: false, 岗位: 'Lead', 卡版本: null, 原因: '没有 Lead 岗位卡（集体L3-成员角色卡/Lead.md）：钉不了版，先建卡。' };
    // 卡内声明岗位必须就是 Lead（补修J）：`Lead.md` 若在 front matter 里自称别的 id，
    // 钉下来的是另一张卡的规则面——「Lead 出生钉 Lead 卡」就不能只是一句口头约定。
    if (card.id !== 'Lead') {
      throw new Denied('角色注册表 · 卡内声明岗位与登记岗位不符（fail-closed）', `Lead 出生要用 Lead 卡，但「Lead.md」的 front matter 自称 id=${card.id ?? '缺失'}：不能把别的岗位卡钉成 Lead 的规则面。`, {
        requireAuthority: 'Lead',
        howToChange: '把 Lead.md 的 front matter id 改回 Lead 后重试（或由主权者修复出厂卡）。',
      });
    }
    const 钉 = this.#钉卡版本(card);
    await this.#写卡快照(card, 钉);
    await this.policy.check({
      subject: { ...MECHANISM_SUBJECT },
      action: 'create',
      target: { id: 实例, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: null, 岗位: 'Lead' },
      context: { 身份操作: '实例', 机制动作: '实例出生' },
    });
    const 于 = this.clock.iso();
    await this.#mutateIdentity((current) => {
      if (current.members[实例]) return current; // 锁内复检：并发出生只留第一条
      return {
        ...current,
        members: {
          ...current.members,
          [实例]: {
            id: 实例,
            岗位: 'Lead',
            代: 1,
            status: '在岗',
            登记于: 于,
            卡版本: 钉,
            生命周期: { 创建于: 于, 封存于: null },
            // 与 assign 同口径：出生代次 + 出生时的 pid 一起钉在实例上（不依赖 8 代截断）。
            ...(spec.代次 ? { 代次: { 代: spec.代次.代, pid: spec.代次.pid ?? null } } : {}),
          },
        },
      };
    });
    const 后 = (await this.#identity()).members[实例];
    await this.audit.append({
      动作: '主体创建',
      主体: { ...MECHANISM_SUBJECT },
      对象: { id: 实例, kind: '身份' },
      依据: 'v2 条目9/10：Lead 实例随主会话出生，出生时钉当时的卡版本（机制动作，主体=系统）',
      结果: `Lead 实例出生（第 ${后?.代 ?? 1} 代）`,
      详情: { 岗位: 'Lead', 卡版本: 钉.摘要, 卡声明版本: 钉.声明版本, 机制动作: '实例出生' },
    });
    return { 已登记: true, 就绪: true, 新建: true, 岗位: 'Lead', 卡版本: 钉.摘要, 状态: '在岗' };
  }

  /** 运行绑定独立于身份生命周期。锁内复核，封存/撤权/换岗竞态一律不恢复。 */
  async #leadBinding({ 实例, 状态, 代次, 旧记录 }) {
    await this.policy.check({
      subject: { ...MECHANISM_SUBJECT }, action: 'write',
      target: { id: 实例, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: null },
      context: { 身份操作: '实例', 机制动作: 'Lead运行绑定' },
    });
    let 已改 = false;
    await this.#mutateIdentity(async (current) => {
      const m = current.members[实例];
      if (m?.status !== '在岗' || m.岗位 !== 'Lead'
        || current.denylist.some((d) => d.id === 实例 || d.id === 'Lead')
        || m.卡版本?.摘要 !== 旧记录.卡版本?.摘要) {
        throw new InvalidBody('Lead 运行绑定核验冲突：身份已封存、撤权、换岗或绑定已变更；不自动恢复。');
      }
      if (状态 === '有效' && (!代次?.代 || 代次.代 !== current.boot?.代 || 代次.pid !== current.boot?.pid)) {
        throw new InvalidBody('Lead 续接仅允许绑定已登记的本进程代次。');
      }
      if (m.运行绑定?.状态 === 状态 && (状态 === '失效' || m.代次?.代 === 代次.代)) return current;
      if (JSON.stringify(m.代次) !== JSON.stringify(旧记录.代次)
        || JSON.stringify(m.运行绑定) !== JSON.stringify(旧记录.运行绑定)) {
        throw new InvalidBody('Lead 运行绑定已变更：拒绝覆盖并发续接。');
      }
      const 卡面 = await this.cardOf(实例);
      if (状态 === '有效' && 卡面?.就绪 !== true) throw new InvalidBody('Lead 钉卡快照不可用：不续接。');
      // 审计先行：失败不能留下无账绑定；不改卡版本、身份代数、生命周期或任务。
      await this.audit.append({
        动作: '机制维护', 主体: { ...MECHANISM_SUBJECT }, 对象: { id: 实例, kind: '身份' },
        依据: '宿主进程绑定与 Lead 身份分离；真实根会话和档案岗位核验后续接',
        结果: `拟写入Lead运行绑定${状态}`, 详情: { 机制动作: 'Lead运行绑定', 阶段: '写入意图', 旧代次: m.代次, 新代次: 状态 === '有效' ? 代次 : null, 卡版本: m.卡版本?.摘要 },
      });
      已改 = true;
      return { ...current, members: { ...current.members, [实例]: {
        ...m, ...(状态 === '有效' ? { 代次: { 代: 代次.代, pid: 代次.pid } } : {}),
        运行绑定: { 状态, 于: this.clock.iso() },
      } } };
    });
    if (已改) await this.audit.append({
      动作: '机制维护', 主体: { ...MECHANISM_SUBJECT }, 对象: { id: 实例, kind: '身份' },
      依据: 'Lead 运行绑定原子写入完成（不改身份生命周期）',
      结果: `Lead运行绑定${状态}`,
      详情: { 机制动作: 'Lead运行绑定', 阶段: '写入完成', 旧代次: 旧记录.代次, 新代次: 状态 === '有效' ? 代次 : null, 卡版本: 旧记录.卡版本?.摘要 },
    });
    return 已改;
  }

  /**
   * 登记本进程代次（条目12 的事实源之一）。
   *
   * 为什么**不走策略判定**：这一步发生在 `Org.bootstrap()` 里，早于任何主体会动作的时机；
   * 而失联冻结会拒自治写 ⇒ 若走判定，主权者失联超过期限的部署**重启就起不来**
   * （冻结把引导也冻住）。它也不改变任何人的权限面（只记「这个进程是哪一代」），
   * 所以按引导级记账处理：**入审计**（主体=系统），不进出权判定。
   *
   * `代次记录` 只留最近 8 代：它是判孤儿的依据，不是历史账（历史在审计里）。
   *
   * @param {{代: string, pid: number, 于: string}} 代次
   */
  async recordBoot(代次) {
    if (!代次?.代) throw new InvalidBody('recordBoot 需要进程代次（{代, pid, 于}）。');
    await this.#mutateIdentity((current) => {
      const 记录 = { ...(current.boot?.代次记录 ?? {}), [代次.代]: { pid: 代次.pid ?? null, 于: 代次.于 ?? this.clock.iso() } };
      // 只留最近 8 代（插入序 = 代次先后）。
      const 键 = Object.keys(记录);
      for (const 旧 of 键.slice(0, Math.max(0, 键.length - 8))) delete 记录[旧];
      return { ...current, boot: { 代: 代次.代, pid: 代次.pid ?? null, 于: 代次.于 ?? this.clock.iso(), 代次记录: 记录 } };
    });
    // 入审计（主体=系统）：进程换代是判孤儿的依据，事后要能回答「哪一代、哪个 pid」。
    // 只记 pid 与代次，不记任何内容（防泄密口径同「主体创建」）。
    await this.audit.append({
      动作: '机制维护',
      主体: { ...MECHANISM_SUBJECT },
      对象: { id: '实例代次', kind: '账目' },
      依据: 'v2 条目12：孤儿回收依据「可靠进程代次」——每进程一代，别的代次是否还活查 pid',
      结果: `本进程代次 ${代次.代.slice(0, 8)}（pid ${代次.pid ?? '未知'}）已登记`,
      详情: { pid: 代次.pid ?? null },
    });
  }

  /**
   * 孤儿回收：进程已死只证明旧执行绑定失效，不证明持久根会话已消亡。
   * Lead 保持身份在岗、仅失效运行绑定，等待宿主核验续接；临时成员仍走封存。
   *
   * 判据只用**可观测事实**，三条：
   *  ① 同代次 ⇒ 活（就在本进程里）。多 Lead 会话共享同一个 Org（同一进程同一代）
   *     ⇒ 邻居会话的实例一律不会被封（「某 Lead 首次动作就把别人全封了」不会发生）。
   *  ② 异代次 ⇒ 查它那一代的 `pid` 是否还活（`process.kill(pid, 0)`，OS 事实）：
   *     还活 ⇒ **未判定**（另一个宿主进程可能正在跑，宁可漏收也不错杀）；
   *     已死 ⇒ Lead 绑定失效 / 临时成员封存（两者都走策略，无自动复岗）。
   *  ③ 没有代次记录（本轮之前登记的历史实例）⇒ **未判定**，响亮入账，不猜死。
   *
   * 另外两条硬边界：
   *  - **绝不碰任务图**：回收只改身份档案。未完成交卷的节点不会因为「负责人被回收」
   *    而前进成任何成功态——节点状态只由任务图自己的状态机推进。
   *  - pid 复用会让「那一代的 pid 恰好被新进程占用」⇒ 判活不判死（安全方向，会漏收）。
   *
   * 失联冻结：封存是自治写，走 `seal()` 的同一条判定链 ⇒ 冻结期**不执行**，
   * 结果里如实写「未执行（失联冻结）」，不另开系统豁免（条目13）。
   *
   * @param {{代次: {代: string}, 存活探测?: (pid: number) => boolean}} spec
   * @returns {Promise<{封存: string[], 未判定: Array<{实例: string, 原因: string}>, 未执行?: string}>}
   */
  async orphanSweep(spec) {
    const 代 = spec?.代次?.代 ? String(spec.代次.代) : null;
    if (!代) throw new InvalidBody('orphanSweep 需要本进程代次（缺失无法判活，也不猜死）。');
    const 探测 = typeof spec.存活探测 === 'function' ? spec.存活探测 : 进程存活;
    const { members, boot } = { ...(await this.#identity()), ...(await this.#bootOf()) };
    const 代次记录 = boot?.代次记录 ?? {};
    const 封存 = [];
    const 绑定失效 = [];
    const 未判定 = [];
    const 结果 = { 于: this.clock.iso(), 本代: 代, 封存, 绑定失效, 未判定 };
    for (const [实例, member] of Object.entries(members ?? {})) {
      if (member?.status !== '在岗') continue;
      // 代次两种形状都认：`{代, pid}`（2026-10-18 起，pid 随实例记）与裸字符串 `代`（旧账，
      // 只能回落到 boot.代次记录里查 pid——那条路 8 代之后必然断，故本批起改为随实例记）。
      const 代次事实 = member?.代次 ?? null;
      const 它代 = typeof 代次事实 === 'string' ? 代次事实 : (代次事实?.代 ?? null);
      if (!它代) { 未判定.push({ 实例, 原因: '无代次记录（本轮之前登记的历史实例）：没有存活事实，不猜死。' }); continue; }
      if (它代 === 代) continue; // 同代 ⇒ 活（本进程内）
      const pid = (typeof 代次事实 === 'object' ? 代次事实?.pid : null) ?? 代次记录?.[它代]?.pid ?? null;
      if (pid == null) { 未判定.push({ 实例, 原因: `代次 ${它代} 没有 pid 记录：拿不到存活事实。` }); continue; }
      if (探测(pid)) { 未判定.push({ 实例, 原因: `代次 ${它代} 的进程 pid=${pid} 仍存活（另一宿主可能在跑）：判不了死。` }); continue; }
      try {
        if (member.岗位 === 'Lead') {
          await this.#leadBinding({ 实例, 状态: '失效', 旧记录: member });
          绑定失效.push(实例);
          continue;
        }
        await this.seal({ subject: { ...MECHANISM_SUBJECT }, 实例, 理由: `孤儿回收：代次 ${它代} 的进程 pid=${pid} 已不存在（v2 条目12）`, 机制动作: '孤儿回收' });
        封存.push(实例);
      } catch (error) {
        // 封存被策略挡下（最典型：失联冻结）⇒ 如实报「未执行」，不吞成半成品。
        结果.未执行 = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    // 落盘读数（工作台 / registry_list 读它；审计侧另有每条封存的独立留痕）。
    await atomicWrite(this.layout.private(DIR.身份档案, '孤儿回收.json'), `${JSON.stringify(结果, null, 2)}\n`);
    return 结果;
  }

  /**
   * 最近一次孤儿回收的落盘读数（`registry_list` / 状态读数用）。
   * @returns {Promise<object|null>}
   */
  async orphanReport() {
    return readJsonOrNull(this.layout.private(DIR.身份档案, '孤儿回收.json'));
  }

  /**
   * 钉卡版本：把「生效文档」折成可比较的版本三元组。
   * 摘要 = digest(声明版本 + 生效正文) —— 任何正文 / 声明版本变化都换新摘要（内容寻址）。
   * @param {{id: string, meta: object, 正文: string, 来源: string, 能力引用?: string[], 段?: object}} card
   */
  #钉卡版本(card) {
    const 声明版本 = Number(card?.meta?.version ?? 1);
    const 生效版本 = Number.isFinite(声明版本) ? 声明版本 : 1;
    return {
      岗位: card?.id ?? null,
      声明版本: 生效版本,
      摘要: cardDigest(生效版本, card?.正文),
      生效来源: card?.来源 ?? null,
    };
  }

  /**
   * 把钉住的卡落成不可变快照（内容寻址 ⇒ 同摘要同内容）。
   *
   * 修前「文件存在就跳过」是条目10 的第二个缺口：坏文件永远不会被验，也永远修不掉。
   * 现在两条路都验真实内容：
   *  - **已存在** ⇒ 读出来校验（岗位 / 声明版本 / 重算摘要 / 派生段与能力引用）；
   *    校验不过就**拒，不覆写**——覆写会毁掉诊断与追责证据，坏证据也不能被默用。
   *  - **新写** ⇒ 写后立刻重读自证：这一位必须能被同一把尺验回，否则不算钉上。
   *
   * @param {object} card 钉版所用的那张卡（与 `钉` 必须来自同一次读取，避免 TOCTOU）
   * @param {{岗位: string, 声明版本: number, 摘要: string, 生效来源: string|null}} 钉
   */
  async #写卡快照(card, 钉) {
    // 正文是卡的权威：拿不到正文字符串就不是一张可钉的卡（缺正文 = 规则面无从重建）。
    // 必须在落盘前拒，不能先写一个空壳快照再靠读面兜——那会留下不可用的内容寻址文件。
    if (typeof card?.正文 !== 'string') {
      throw new Denied('角色注册表 · 钉版需要真实卡（fail-closed）', `岗位「${钉.岗位}」的卡对象没有正文字符串：钉版与快照必须以真实正文为权威，不能钉一个空壳。`, {
        requireAuthority: 'Lead',
        howToChange: '确认岗位卡能正常解析出正文（front matter 之后的 markdown）；坏卡先修好再登记。',
      });
    }
    const 核对 = this.#钉卡版本(card);
    if (核对.摘要 !== 钉.摘要 || 核对.岗位 !== 钉.岗位 || 核对.声明版本 !== 钉.声明版本) {
      throw new Denied('角色注册表 · 钉版与卡内容不一致（fail-closed）', `钉版摘要 ${钉.摘要.slice(0, 12)}… 与刚读到的卡 ${核对.摘要.slice(0, 12)}… 不一致：钉版瞬间卡被改，不能把一个已不存在的版本落成快照。`, {
        requireAuthority: 'Lead',
        howToChange: '重试一次（读卡与钉版必须来自同一次读取）。',
      });
    }
    const file = this.layout.cardSnapshot(钉.摘要);
    if (await exists(file)) {
      const 读 = readVerifiedCardSnapshot(file, { 钉, 期望岗位: 钉.岗位 });
      if (!读.ok) {
        throw new Denied('角色注册表 · 卡快照内容校验失败（不覆写证据）', `内容寻址文件「卡快照/${钉.摘要.slice(0, 12)}….json」已存在但校验不过：${读.原因}。坏证据不默用也不覆写（覆写会毁掉诊断与追责依据）。`, {
          requireAuthority: 'Lead',
          howToChange: '保留现场并人工核查该快照文件；确需重建时先把它移走（留档），再重试登记。',
        });
      }
      return 钉;
    }
    const 派生 = deriveCardFaces(card.正文);
    await atomicWrite(file, `${JSON.stringify({
      岗位: card.id,
      声明版本: 钉.声明版本,
      摘要: 钉.摘要,
      生效来源: card.来源,
      段: 派生.段,
      能力引用: 派生.能力引用,
      正文: card.正文,
    }, null, 2)}\n`);
    const 自证 = readVerifiedCardSnapshot(file, { 钉, 期望岗位: card.id });
    if (!自证.ok) {
      throw new Denied('角色注册表 · 卡快照写入后自证失败', `刚写入的快照「卡快照/${钉.摘要.slice(0, 12)}….json」校验不过：${自证.原因}。这一位不能当作已钉版使用。`, {
        requireAuthority: 'Lead',
        howToChange: '检查私有区磁盘写入是否被截断 / 改编码；保留现场并人工核查。',
      });
    }
    return 钉;
  }

  /** 岗位卡**现行**摘要（与钉住版本对照用；卡不在盘上给 null）。 */
  async #现行摘要(岗位) {
    if (!岗位) return null;
    const card = await this.get({ id: 岗位 });
    return card ? this.#钉卡版本(card).摘要 : null;
  }

  /** 身份档案里的 boot 段（代次记录），与 members 一起读同一份真源。 */
  async #bootOf() {
    const current = await readJsonOrNull(this.layout.identityFile());
    return { boot: current?.boot ?? null };
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /**
   * 扫一个区的岗位卡。**单区**，不排序、不去重——去重与排序是 `list()` 的事。
   *
   * 拆出来是为了让「两区各扫一遍」这件事只有一个落点：`list()` 与 `sync()` 共用它，
   * 而 `list()` 的合并顺序与 `get()` 的短路顺序是同一个常量（`ZONES`）。
   *
   * @param {'自治'|'出厂'} zone
   * @param {string} label
   */
  async #scanZone(zone, label) {
    const out = [];
    const dir = this.layout.roleCardDir(zone);
    for (const rel of await listFiles(dir, { recursive: false, filter: (n) => n.endsWith('.md') })) {
      const id = rel.replace(/\.md$/, '');
      const text = await readTextOrNull(`${dir}/${rel}`);
      if (text === null) continue;
      const parsed = parseDocument(text);
      // 解析错误响亮抛（2026-10-14 审查 P2-3）：与规则件（policy.js #loadRules）同口径——
      // 修前 errors 被静默丢弃，一张坏卡照样注册/发卡，§3.6「装不齐就是 fail-closed」
      // 在身份面破例。
      if (parsed.errors?.length) {
        throw new Denied(
          '角色注册表 · 岗位卡无法解析（fail-closed）',
          `岗位卡文件「${zone}区/${rel}」解析失败：${parsed.errors.join('；')}。坏卡照样入库 = 身份档案带病运行，按 fail-closed 拒绝。`,
          { howToChange: `修好 ${rel} 的 front matter（${parsed.errors[0]}）后重试。` },
        );
      }
      // meta.id 与文件名一致性（2026-10-13 裁决第二批 M6）：文件 `x.md` 在 front matter 里
      // 自称 `id: Lead` ⇒ 索引以「Lead」岗出现而 `get('Lead')` 按文件名读不到它——「列得出的
      // 岗位」与「取得到的岗位」是两个世界，卡文件可冒名。fail-closed：不一致即响亮拒。
      if (parsed.meta.id && parsed.meta.id !== id) {
        throw new Denied(
          '角色注册表 · 岗位卡 id 与文件名不一致（fail-closed）',
          `岗位卡文件「${zone}区/${rel}」的 front matter 自称 id=${parsed.meta.id}，与文件名「${id}」不一致：卡文件可借此冒名岗位（列表按 meta.id、读取按文件名，两个世界）。`,
          { howToChange: `把文件名与 front matter 的 id 统一成同一个值（改 ${rel} 或改它声明的 id），修好后同步/读取即恢复。` },
        );
      }
      const 派生 = deriveCardFaces(parsed.body);
      out.push({
        id: parsed.meta.id ?? id,
        来源: label,
        摘要: String(parsed.meta.摘要 ?? section(parsed.body, parsed.meta.id ?? id) ?? '').split('\n')[0]?.trim().slice(0, 80) ?? '',
        段: SEGMENTS.filter((s) => 派生.段[s]),
        能力引用: 派生.能力引用,
        digest: digest(text),
      });
    }
    return out;
  }

  /**
   * 扫描两区岗位卡（**并列**，含同名）。
   *
   * 仅供 `sync()` 写索引用：索引是一份「盘上有什么」的台账，同名两行在那里是**如实记录**，
   * 不是错。给外面看的口径在 `list()`（一个 id 一行 + `同名` 字段）。
   *
   * @returns {Promise<Array<object>>}
   */
  async #scanCards() {
    const out = [];
    for (const [zone, label] of ZONES) out.push(...(await this.#scanZone(zone, label)));
    return out.sort((a, b) => a.id.localeCompare(b.id));
  }

  /** @returns {Promise<{members: Record<string, object>, sovereign: object, denylist: object[]}>} */
  async #identity() {
    const current = await readJsonOrNull(this.layout.identityFile());
    return {
      members: current?.members ?? {},
      sovereign: current?.sovereign ?? { lastInteraction: null },
      denylist: current?.denylist ?? [],
      ...(current?.boot ? { boot: current.boot } : {}),
    };
  }

  /**
   * @param {(current: object) => object|Promise<object>} apply
   * 写完身份档案后立即 `policy.reload()`：判定读的是加载时的快照，
   * 不重载的话「封存实例照常全权 / 失联冻得住解不开」都会发生（B2）。
   *
   * **apply 原样返回 current ⇒ 不写盘、不重载**（W3 批2·2026-10-09）：这是「幂等操作」
   * 的落点——重复登记不该产生一次无变化的原子写，更不该让判定快照无谓重载。
   * 其余调用方都返回新对象，行为不变。
   *
   * apply 允许是**异步**的（设计评审 #12 · 2026-10-15）：assign 把岗位卡读取搬进了锁内
   * （`this.get` 是 IO），回调里 await 不改变「原样返回 current ⇒ 不写盘」的语义——
   * `await` 一个非 Promise 值原样透传，既有同步回调全部照旧。
   */
  async #mutateIdentity(apply) {
    const file = this.layout.identityFile();
    let result;
    let 已写 = false;
    await withLock(this.layout.identityLock(), async () => {
      const current = await this.#identity();
      result = await apply(current);
      if (result !== current) {
        await atomicWrite(file, `${JSON.stringify(result, null, 2)}\n`);
        已写 = true;
      }
    });
    if (已写) await this.policy.reload();
    return result;
  }
}

/**
 * 进程是否存活（孤儿回收的 OS 事实源）。
 *
 * `process.kill(pid, 0)` 不发信号、只做存在性检查：
 *  - 抛 `ESRCH` ⇒ 进程已不存在（判死）；
 *  - 抛 `EPERM` ⇒ 进程存在但无权限发信号（**判活**：存在性已经回答了）；
 *  - 不抛 ⇒ 存在。
 * 其余异常一律按「判不了」返回 false ⇒ 调用方走「未判定」，不猜死。
 *
 * @param {number} pid
 * @returns {boolean}
 */
function 进程存活(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}
