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
import { listFiles, readJsonOrNull, readTextOrNull, atomicWrite, withLock } from './kernel/fsx.js';
import { Denied, InvalidBody } from './kernel/errors.js';
import { digest } from './kernel/text.js';
import { parseDocument } from './tags.js';
import { section } from './capability.js';
import { assertPathSegment } from './paths.js';
import { ACTIONS, identityStatus } from './policy.js';
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
 * 预检都读它（同一件事不许有两个口径）。与 `org.subjectFor()` 的岗位分支逐字同口径
 * （复核员→复核者、Lead→Lead、其余→成员）；差别只在**不做**宿主侧的兜底 ——
 * 这里没有「根会话」「实例缺省成 unknown / lead」那些约定：身份档案里查不到的实例
 * 就是查不到，交给判定层按最严处理（§12.2），不许在这里被回填成一个更高的身份。
 *
 * @param {string|undefined} 岗位
 * @param {string} 实例
 * @returns {{id: string, kind: string, roleId: string}}
 */
export function subjectForRole(岗位, 实例) {
  if (岗位 === '复核员') return { id: 实例, kind: '复核者', roleId: '复核员' };
  if (岗位 === 'Lead') return { id: 实例, kind: 'Lead', roleId: 'Lead' };
  if (岗位) return { id: 实例, kind: '成员', roleId: 岗位 };
  return { id: 实例, kind: '成员', roleId: '未登记' };
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
   * 从真源重算索引。真源 = 岗位卡（两区）+ 身份档案。
   * @returns {Promise<{ 岗位: number, 实例: number, 更新于: string }>}
   */
  async sync() {
    const 岗位 = await this.#scanCards();
    const identity = await this.#identity();
    const index = {
      更新于: this.clock.iso(),
      岗位,
      实例: identity.members,
      封存: Object.values(identity.members).filter((m) => m.status === '封存').map((m) => m.id),
      拒绝名单: identity.denylist.map((d) => d.id),
    };
    await atomicWrite(this.layout.registryFile(), `${JSON.stringify(index, null, 2)}\n`);
    return { 岗位: 岗位.length, 实例: Object.keys(identity.members).length, 更新于: index.更新于 };
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
    return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 取一个岗位卡。
   * @param {{ id: string }} spec
   * @returns {Promise<{ id: string, 来源: string, meta: object, 段: Record<string, string>, 能力引用: string[], 经验引用: string[], 正文: string }|null>}
   */
  async get(spec) {
    const id = assertPathSegment(spec.id, '岗位卡id');
    // ZONES 的顺序即覆盖优先级（自治在前 ⇒ 私有优先短路）。与 list() 同源，
    // 所以「读」与「列」不可能再给出两份答案——包括命中的是哪一区、来源标签叫什么。
    for (const [zone, label] of ZONES) {
      const dir = this.layout.roleCardDir(zone);
      const path = `${dir}/${id}.md`;
      const text = await readTextOrNull(path);
      if (text === null) continue;
      const parsed = parseDocument(text);
      // 解析错误响亮抛（2026-10-14 审查 P2-3）：与 #scanZone / 规则件同口径，
      // 修前 errors 静默丢弃——读得出一张坏卡 = 身份档案带病运行。
      if (parsed.errors?.length) {
        throw new Denied(
          '角色注册表 · 岗位卡无法解析（fail-closed）',
          `岗位卡文件「${zone}区/${id}.md」解析失败：${parsed.errors.join('；')}。`,
          { howToChange: `修好 ${id}.md 的 front matter（${parsed.errors[0]}）后重试。` },
        );
      }
      return {
        id: parsed.meta.id ?? spec.id,
        来源: label,
        meta: parsed.meta,
        段: Object.fromEntries(SEGMENTS.map((s) => [s, section(parsed.body, s)])),
        能力引用: refs(section(parsed.body, '个体L2')),
        经验引用: refs(section(parsed.body, '个体L3')),
        正文: parsed.body,
      };
    }
    return null;
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
    const card = await this.get({ id: 岗位 });
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
   * 与下面这张状态表（现存实例的分派判定）；**在锁外**的是复核员任命的授权引用校验
   * （`audit.授权依据存在` 要扫任务图事件流，IO 量级大，搬进锁 = 身份档案锁被长 IO 扩占）
   * 与 `policy.check`（引擎判定自己另有读锁纪律）。锁外两道的剩余窗口如实标注：它们通过
   * 之后、写入之前，**授权依据节点被删**或**策略规则被热改**会让本次登记带着过期的检查结果
   * 落盘——前者由授权引用原样进链接受复核兜底，后者由写后 `policy.reload()` 使后续判定
   * 立即回到新规则。岗位卡那道修前也有同款窗口（check 与写入之间卡被删 ⇒ 不存在的岗位
   * 进档案），现已搬入锁内关门。
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
   *   `授权引用`：目标岗位＝复核员时必填（主权者授权依据，原样进链接受复核）。
   */
  async assign(spec) {
    // 复核员任命特判（task-机制缺口-10th0 · 裁决② · 2026-10-13）：岗位锁只保证「在岗后」
    // 不能写，不约束「谁能把我放进复核员岗」——任命权与岗位锁是两件事（独立复核 4yuxq 定案）。
    // 与 audit_correct 的授权闸同族：空授权 = 默认拒绝，授权依据原样进链接受复核。
    // 【锁外·设计评审 #12】授权存在性校验要扫任务图事件流（重 IO），搬进身份档案锁会把
    // 锁扩占成长 IO 临界区——留在锁外，剩余窗口见方法头注释的如实标注。
    const 授权引用 = typeof spec.授权引用 === 'string' ? spec.授权引用.trim() : '';
    if (spec.岗位 === '复核员' && !授权引用) {
      throw new Denied(
        '角色注册表 · 复核员任命须主权者授权（§7）',
        `把实例 ${spec.实例} 登记到「复核员」是任命独立复核者：这一步必须携带主权者授权依据（授权引用 = 决议 / 任务节点 id），空授权 = 默认拒绝。`,
        {
          requireAuthority: '主权者',
          howToChange: '由主权者授权后，把授权依据 id 作为「授权引用」传入 registry_assign（它会原样进链接受复核）。',
        },
      );
    }
    // 授权引用存在性校验（2026-10-14 审查 P2-2）：与 audit_correct 同一把尺
    // （audit.授权依据存在 是唯一实现）——修前只验非空，任意字符串都能当授权。
    // 【锁外·设计评审 #12】同上：重 IO 留锁外，窗口与兜底见方法头注释。
    if (spec.岗位 === '复核员' && !(await this.audit.授权依据存在(授权引用))) {
      throw new Denied(
        '角色注册表 · 复核员任命的授权引用必须真实存在',
        `授权引用「${授权引用}」在任务图事件流里找不到：复核员任命是独立复核线的入口，授权依据必须指向真实的决议/任务节点（fail-closed，与 audit_correct 同口径）。`,
        {
          requireAuthority: '主权者',
          howToChange: '把主权者授权所依据的决议/任务节点 id 原样传入（review_nominate 挂的待决节点 id 就是现成依据）。',
        },
      );
    }
    // 【锁外·设计评审 #12】引擎判定不占身份档案锁（policy 自己有读锁纪律），留在锁外。
    await this.policy.check({
      subject: spec.subject,
      action: 'create',
      target: { id: spec.实例, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: null },
      context: {},
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
      if (现存?.status === '封存' && 现存.岗位 === spec.岗位) {
        throw new Denied('角色注册表 · 封存实例不得靠 assign 复活（§7）', `实例 ${spec.实例} 已封存在「${现存.岗位}」：assign 到**同一个岗位**会把它静默写回在岗，并把代数重置成 ${spec.代 ?? 1}（停岗决定被一次「补登记」撤销）。`, {
          requireAuthority: 'Lead',
          howToChange: '复岗走 registry_restore（显式的还原路径，有自己的留痕与闸）；要换到别的岗位则 assign 到那个新岗位（那正是 seal → assign 的换岗路）。',
        });
      }
      if (现存 && 现存.status === '在岗' && 现存.岗位 === spec.岗位) {
        幂等现状 = 现存;
        return current; // 原样返回 ⇒ #mutateIdentity 不写盘、不重载、不记审计
      }
      // 在岗换岗位 ⇒ 拒（W3 批3·2026-10-09）：此前 assign 会直接覆盖岗位并把 `代` 重置成
      // `spec.代 ?? 1` —— 一次「换个岗」就把「第 N 代」抹成「第 1 代」，两代之间的断点在账上消失。
      // 换岗是一次身份变更，必须留下停岗这一步（与封存那条同款：先停、再登）。
      if (现存 && 现存.status === '在岗' && 现存.岗位 !== spec.岗位) {
        throw new Denied('角色注册表 · 在岗实例换岗位要先停岗（§7）', `实例 ${spec.实例} 正在「${现存.岗位}」在岗：assign 直接改岗位会把它写进「${spec.岗位}」并重置代数（第 ${现存.代 ?? 1} 代 → 第 ${spec.代 ?? 1} 代），换岗这件事在账上就没了断点。`, {
          requireAuthority: 'Lead',
          howToChange: `先 registry_seal 停掉「${现存.岗位}」岗，再 assign 到「${spec.岗位}」——停岗那一步就是换岗的留痕。`,
        });
      }
      return { ...current, members: { ...current.members, [spec.实例]: { id: spec.实例, 岗位: spec.岗位, 代: spec.代 ?? 1, status: '在岗', 登记于: this.clock.iso() } } };
    });
    if (幂等现状) {
      return { 实例: spec.实例, 岗位: 幂等现状.岗位, 代: 幂等现状.代 ?? 1, 状态: '在岗', 幂等: true, 说明: '该实例已在同一岗位在岗：没有写盘、没有重置代数、没有新增留痕。' };
    }
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.实例, kind: '身份' },
      依据: '角色注册表：实例权限只来自岗位',
      结果: `登记到岗位 ${spec.岗位}（第 ${spec.代 ?? 1} 代）`,
      详情: { 实例数: Object.keys(updated.members).length },
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
      context: {},
    });
    const updated = await this.#mutateIdentity((current) => {
      const member = current.members[spec.实例];
      if (!member) throw new InvalidBody(`身份档案里没有 ${spec.实例}`);
      return { ...current, members: { ...current.members, [spec.实例]: { ...member, status: '封存', 封存于: this.clock.iso(), 理由: spec.理由 } } };
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
      return { ...current, members: { ...current.members, [spec.实例]: { ...member, status: '在岗', 封存于: null, 理由: null } } };
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

/** @param {string} text */
function refs(text) {
  return String(text)
    .split(/[\n,，、;；]+/)
    .map((s) => s.replace(/^[-*•\d.\s`]+/, '').replace(/`/g, '').trim())
    .filter((s) => s && !s.startsWith('#'));
}
