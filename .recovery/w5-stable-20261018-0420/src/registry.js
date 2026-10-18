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
import { Denied, InvalidBody } from './kernel/errors.js';
import { digest } from './kernel/text.js';
import { effectiveDocument, parseDocument } from './tags.js';
import { section } from './capability.js';
import { assertPathSegment, DIR } from './paths.js';
import { ACTIONS, identityStatus, subjectKindForRole, subjectRank } from './policy.js';
import { MECHANISM_SUBJECT } from './mechanism.js';
import { evaluateSovereignPresence } from './kernel/time.js';

/** 卡上的四段，顺序即个体域的层级（§14：个体域才有 L0~L3）。 */
const SEGMENTS = ['个体L0', '个体L1', '个体L2', '个体L3'];

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
 * 主权者交互的来源白名单（设计评审 #7 · 2026-10-15）：`markInteraction` 只认这三个入口。
 * 名单是封闭的——新增调用方必须在这里显式登记，否则 fail-closed 被拒。
 *  - 「宿主事件」：内核的 user/message 挂钩（components/kernel/lib/index.js 挂主权者交互）；
 *  - 「presence命令」：/mind sovereign_interaction（命令面专属，模型没有这只手）；
 *  - 「部署引导」：org.bootstrap() 在身份档案缺失时落的第一次交互（主权者「启动了这个部署」）。
 */
const 交互来源白名单 = ['宿主事件', 'presence命令', '部署引导'];

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
    const 投影 = await this.#任务生命周期();
    const 活动 = spec.活动 ?? null;
    const 实例 = {};
    for (const [id, member] of Object.entries(identity.members ?? {})) {
      const 生 = member?.生命周期 ?? {};
      const 绑定 = 投影.绑定.get(id) ?? [];
      const 交卷 = 投影.交卷.get(id) ?? [];
      实例[id] = {
        ...member,
        生命周期: {
          创建于: 生.创建于 ?? member?.登记于 ?? null,
          绑定时: 生.绑定时 ?? 绑定.at(-1)?.于 ?? null,
          绑定节点: 生.绑定节点 ?? 绑定.at(-1)?.节点 ?? null,
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
   * @returns {Promise<{绑定: Map<string, Array<{节点: string, 于: string}>>, 交卷: Map<string, Array<{节点: string, 于: string}>>}>}
   */
  async #任务生命周期() {
    const 绑定 = new Map();
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
        if (row.kind === 'created' || row.kind === 'reassigned') {
          for (const 负责人 of row.负责人 ?? []) {
            if (typeof 负责人 !== 'string') continue;
            const 项 = 绑定.get(负责人) ?? [];
            项.push({ 节点: String(节点), 于: String(row.at ?? '') });
            绑定.set(负责人, 项);
          }
        }
        if (row.kind === 'submitted' && row.by?.id) {
          const 项 = 交卷.get(String(row.by.id)) ?? [];
          项.push({ 节点: String(节点), 于: String(row.at ?? '') });
          交卷.set(String(row.by.id), 项);
        }
      }
    }
    return { 绑定, 交卷 };
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
    return {
      id: parsed.meta.id ?? spec.id,
      来源,
      meta: parsed.meta,
      段: Object.fromEntries(SEGMENTS.map((s) => [s, section(parsed.body, s)])),
      能力引用: refs(section(parsed.body, '个体L2')),
      经验引用: refs(section(parsed.body, '个体L3')),
      正文: parsed.body,
    };
  }

  /**
   * 「这身份能碰什么」。
   *
   * 答案由两半拼成：岗位卡声明的段（身份/规则/能力/经验），
   * 与策略引擎对每个动作的实判。任何一半缺失都不给「大概能吧」这种答案。
   *
   * @param {{ id: string, 项目?: string }} spec
   * @returns {Promise<object>}
   */
  async canTouch(spec) {
    const identity = await this.#identity();
    const member = identity.members[spec.id];
    const 状态 = identityStatus(this.policy, spec.id);
    const 岗位 = member?.岗位 ?? spec.id;
    // 条目10：在册实例的「能碰什么」读**它出生的那一版卡**，不读现行卡——
    // 否则改一次卡文件，运行中实例的规则 / 能力面就静默换脸（钉版就成了纯血缘）。
    const 钉卡 = member ? await this.cardOf(spec.id) : null;
    const card = 钉卡 && !钉卡.未钉
      ? { id: 钉卡.岗位 ?? 岗位, 段: 钉卡.段, 能力引用: 钉卡.能力引用, 经验引用: [], meta: { version: 钉卡.卡版本?.声明版本 ?? 1 }, 来源: 钉卡.卡版本?.生效来源 ?? null }
      : await this.get({ id: 岗位 });
    if (!card) {
      return {
        身份: spec.id,
        在岗: false,
        原因: 状态.known ? `身份 ${spec.id} 的岗位「${岗位}」没有岗位卡：权限来源唯一确定（§12.3），查不到就不放行。` : 状态.reason,
        权限: [],
        能力: [],
        经验: [],
        锁定的段: ['个体L0'],
      };
    }
    const subject = subjectForRole(岗位, spec.id);
    const 权限 = [];
    for (const action of ACTIONS) {
      const decision = await this.policy.decide({
        subject,
        action,
        target: { id: card.id, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: spec.项目 ?? null },
        context: {},
      });
      权限.push({ action, verdict: decision.verdict, rule: decision.rule });
    }
    return {
      身份: spec.id,
      在岗: 状态.status === '在岗',
      状态: 状态.status,
      岗位,
      权限,
      能力: card.能力引用,
      经验: card.经验引用,
      锁定的段: ['个体L0'],
      说明: '个体L0（身份核心）锁定，不可就地改写；个体L2 只存能力引用，不内嵌正文。',
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
   * @param {{ subject: object, 岗位: string, 实例: string, 代?: number, 授权引用?: string }} spec
   *   `授权引用`：可选（v2 起复核员岗与成员同规则，不再必填）；给了就原样进链接受复核。
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
      // 条目10：钉住**生效卡**的内容寻址快照（锁内、用刚读到的 card，不二次读盘）。
      const 钉 = this.#钉卡版本(card);
      await this.#写卡快照(钉);
      if (现存?.status === '封存' && 现存.岗位 === spec.岗位) {
        throw new Denied('角色注册表 · 封存实例不得靠 assign 复活（§7）', `实例 ${spec.实例} 已封存在「${现存.岗位}」：assign 到**同一个岗位**会把它静默写回在岗，并把代数重置成 ${spec.代 ?? 1}（停岗决定被一次「补登记」撤销）。`, {
          requireAuthority: 'Lead',
          howToChange: '复岗走 registry_restore（显式的还原路径，有自己的留痕与闸）；要换到别的岗位则 assign 到那个新岗位（那正是 seal → assign 的换岗路）。',
        });
      }
      if (现存 && 现存.status === '在岗' && 现存.岗位 === spec.岗位) {
        幂等现状 = 现存;
        // 历史实例（本轮之前落的账）没有卡版本：在这里**补钉一次**，否则它的规则面永远
        // 「未钉」= 跟着卡文件变。补钉只记当时那一刻的卡，不改变任何权限。
        if (!现存.卡版本?.摘要) {
          return { ...current, members: { ...current.members, [spec.实例]: { ...现存, 卡版本: 钉 } } };
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
      return {
        实例: spec.实例,
        岗位: 幂等现状.岗位,
        代: 幂等现状.代 ?? 1,
        状态: '在岗',
        幂等: true,
        卡版本: 幂等现状.卡版本?.摘要 ?? null,
        说明: '该实例已在同一岗位在岗：没有写盘、没有重置代数、没有新增留痕。',
      };
    }
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.实例, kind: '身份' },
      依据: '角色注册表：实例权限只来自岗位',
      结果: `登记到岗位 ${spec.岗位}（第 ${spec.代 ?? 1} 代）`,
      // 审计带卡版本（条目10）：账上要能回答「它当时凭的是哪一版岗位卡」。
      详情: { 实例数: Object.keys(updated.members).length, 卡版本: updated.members[spec.实例]?.卡版本?.摘要 ?? null, 卡声明版本: updated.members[spec.实例]?.卡版本?.声明版本 ?? null },
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

  // ── 实例模型：钉卡版本 / 生命周期 / 孤儿回收（v2 条目9/10/12） ────────────────

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
   * @param {string} 实例
   * @returns {Promise<{岗位: string, 卡版本: object, 段: object, 能力引用: string[], 未钉?: boolean, 现行摘要?: string|null} | null>}
   */
  async cardOf(实例) {
    const member = (await this.#identity()).members[实例];
    if (!member) return null;
    const 钉 = member.卡版本;
    if (!钉?.摘要) {
      // 未钉（本轮之前登记的实例）：如实说「未钉」，不静默回落到现行卡。
      return { 岗位: member.岗位 ?? null, 卡版本: null, 段: {}, 能力引用: [], 未钉: true, 现行摘要: await this.#现行摘要(member.岗位) };
    }
    const 快照 = await readJsonOrNull(this.layout.cardSnapshot(钉.摘要));
    return {
      岗位: 钉.岗位 ?? member.岗位 ?? null,
      卡版本: 钉,
      段: 快照?.段 ?? {},
      能力引用: 快照?.能力引用 ?? [],
      未钉: false,
      现行摘要: await this.#现行摘要(member.岗位),
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
   * 幂等：已有记录（任何岗位）一律不动——一个实例只能有一个出生记录，
   * 换岗 / 复岗走 seal → assign 正路，不由出生路径改写。
   *
   * @param {{实例: string, 代次?: {代: string}}} spec
   * @returns {Promise<{已登记: boolean, 新建?: boolean, 岗位?: string, 卡版本?: string|null, 原因?: string}>}
   */
  async ensureLeadInstance(spec) {
    const 实例 = String(spec.实例 ?? '').trim();
    if (!实例) return { 已登记: false, 原因: '没有会话 id：给不出「哪一个 Lead 实例」，不猜。' };
    const 现存 = (await this.#identity()).members[实例];
    if (现存) return { 已登记: true, 新建: false, 岗位: 现存.岗位 ?? null, 卡版本: 现存.卡版本?.摘要 ?? null };
    const card = await this.get({ id: 'Lead' });
    if (!card) return { 已登记: false, 原因: '没有 Lead 岗位卡（集体L3-成员角色卡/Lead.md）：钉不了版，先建卡。' };
    const 钉 = this.#钉卡版本(card);
    await this.#写卡快照(钉);
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
    return { 已登记: true, 新建: true, 岗位: 'Lead', 卡版本: 钉.摘要 };
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
   * 孤儿回收（条目12）：崩溃 / 重启后把**判得死**的在岗实例标封存。
   *
   * 判据只用**可观测事实**，三条：
   *  ① 同代次 ⇒ 活（就在本进程里）。多 Lead 会话共享同一个 Org（同一进程同一代）
   *     ⇒ 邻居会话的实例一律不会被封（「某 Lead 首次动作就把别人全封了」不会发生）。
   *  ② 异代次 ⇒ 查它那一代的 `pid` 是否还活（`process.kill(pid, 0)`，OS 事实）：
   *     还活 ⇒ **未判定**（另一个宿主进程可能正在跑，宁可漏收也不错杀）；
   *     已死 ⇒ 孤儿 ⇒ 封存。
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
    const 未判定 = [];
    const 结果 = { 于: this.clock.iso(), 本代: 代, 封存, 未判定 };
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
    return {
      岗位: card?.id ?? null,
      声明版本: Number.isFinite(声明版本) ? 声明版本 : 1,
      摘要: digest(`v${声明版本}\u0000${card?.正文 ?? ''}`),
      生效来源: card?.来源 ?? null,
    };
  }

  /** 把钉住的卡落成不可变快照（内容寻址 ⇒ 同摘要同内容，存在即跳过，竞态无害）。 */
  async #写卡快照(钉) {
    const card = await this.get({ id: 钉.岗位 });
    if (!card) throw new Denied('角色注册表 · 钉版时岗位卡已消失', `岗位「${钉.岗位}」在钉版瞬间读不到：不能钉一个读不到的卡。`, {
      requireAuthority: 'Lead',
      howToChange: '重建岗位卡后重试。',
    });
    const file = this.layout.cardSnapshot(钉.摘要);
    if (await exists(file)) return 钉;
    await atomicWrite(file, `${JSON.stringify({
      岗位: card.id,
      声明版本: 钉.声明版本,
      摘要: 钉.摘要,
      生效来源: card.来源,
      段: card.段,
      能力引用: card.能力引用,
      正文: card.正文,
    }, null, 2)}\n`);
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
      out.push({
        id: parsed.meta.id ?? id,
        来源: label,
        摘要: String(parsed.meta.摘要 ?? section(parsed.body, parsed.meta.id ?? id) ?? '').split('\n')[0]?.trim().slice(0, 80) ?? '',
        段: SEGMENTS.filter((s) => section(parsed.body, s)),
        能力引用: refs(section(parsed.body, '个体L2')),
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

/** @param {string} text */
function refs(text) {  return String(text)
    .split(/[\n,，、;；]+/)
    .map((s) => s.replace(/^[-*•\d.\s`]+/, '').replace(/`/g, '').trim())
    .filter((s) => s && !s.startsWith('#'));
}
