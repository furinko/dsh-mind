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

/** 卡上的四段，顺序即个体域的层级（§14：个体域才有 L0~L3）。 */
const SEGMENTS = ['个体L0', '个体L1', '个体L2', '个体L3'];

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
   * @returns {Promise<Array<{ id: string, 来源: string, 摘要: string, 段: string[], 能力引用: string[] }>>}
   */
  async list() {
    return this.#scanCards();
  }

  /**
   * 取一个岗位卡。
   * @param {{ id: string }} spec
   * @returns {Promise<{ id: string, 来源: string, meta: object, 段: Record<string, string>, 能力引用: string[], 经验引用: string[], 正文: string }|null>}
   */
  async get(spec) {
    const id = assertPathSegment(spec.id, '岗位卡id');
    for (const zone of ['自治', '出厂']) {
      const dir = this.layout.roleCardDir(zone);
      const path = `${dir}/${id}.md`;
      const text = await readTextOrNull(path);
      if (text === null) continue;
      const parsed = parseDocument(text);
      return {
        id: parsed.meta.id ?? spec.id,
        来源: zone === '自治' ? '私有' : '出厂',
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
   * 三条守卫，都在**锁内**判（锁外预读会与并发 assign 打架）。这张表就是「assign 能做什么」的全部：
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
   * @param {{ subject: object, 岗位: string, 实例: string, 代?: number }} spec
   */
  async assign(spec) {
    const card = await this.get({ id: spec.岗位 });
    if (!card) {
      throw new Denied('角色注册表 · 实例权限只来自岗位（§7）', `岗位「${spec.岗位}」不存在：不能给一个不存在的岗位发实例权限。`, {
        requireAuthority: 'Lead',
        howToChange: '先在 集体L3-成员角色卡/ 建岗位卡，再派实例。',
      });
    }
    await this.policy.check({
      subject: spec.subject,
      action: 'create',
      target: { id: spec.实例, kind: '身份', authority: '自治', zone: '私有', domain: '个体', project: null },
      context: {},
    });
    /** @type {object|null} */
    let 幂等现状 = null;
    const updated = await this.#mutateIdentity((current) => {
      const 现存 = current.members[spec.实例];
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
   * @param {{ 于?: string }} [spec]
   */
  async markInteraction(spec = {}) {
    const updated = await this.#mutateIdentity((current) => ({
      ...current,
      sovereign: { ...current.sovereign, lastInteraction: spec.于 ?? this.clock.iso() },
    }));
    return { lastInteraction: updated.sovereign.lastInteraction };
  }

  /** @returns {Promise<object>} 身份档案原文 */
  async identity() {
    return this.#identity();
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /** 扫描两区岗位卡。 */
  async #scanCards() {
    const out = [];
    for (const [zone, label] of [['自治', '私有'], ['出厂', '出厂']]) {
      const dir = this.layout.roleCardDir(zone);
      for (const rel of await listFiles(dir, { recursive: false, filter: (n) => n.endsWith('.md') })) {
        const id = rel.replace(/\.md$/, '');
        const text = await readTextOrNull(`${dir}/${rel}`);
        if (text === null) continue;
        const parsed = parseDocument(text);
        out.push({
          id: parsed.meta.id ?? id,
          来源: label,
          摘要: String(parsed.meta.摘要 ?? section(parsed.body, parsed.meta.id ?? id) ?? '').split('\n')[0]?.trim().slice(0, 80) ?? '',
          段: SEGMENTS.filter((s) => section(parsed.body, s)),
          能力引用: refs(section(parsed.body, '个体L2')),
          digest: digest(text),
        });
      }
    }
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
   * @param {(current: object) => object} apply
   * 写完身份档案后立即 `policy.reload()`：判定读的是加载时的快照，
   * 不重载的话「封存实例照常全权 / 失联冻得住解不开」都会发生（B2）。
   *
   * **apply 原样返回 current ⇒ 不写盘、不重载**（W3 批2·2026-10-09）：这是「幂等操作」
   * 的落点——重复登记不该产生一次无变化的原子写，更不该让判定快照无谓重载。
   * 其余调用方都返回新对象，行为不变。
   */
  async #mutateIdentity(apply) {
    const file = this.layout.identityFile();
    let result;
    let 已写 = false;
    await withLock(this.layout.identityLock(), async () => {
      const current = await this.#identity();
      result = apply(current);
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
