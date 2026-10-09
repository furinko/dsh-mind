/**
 * 记忆服务（§7「知道什么」）。
 *
 * 三条设计原则决定了这里的每个形状：
 *  1. **写入必带「谁记的 + 怎么知道的」** —— 所以 `来源` 是必填结构，缺了在**写入时**就拒。
 *  2. **不许改写，只能追加** —— 失效 / 冷 / 被推翻全部是**追加一条状态记录**，
 *     原条目那行字节不动。唯一的例外是物理删除，且只对敏感数据或主权者明确要求开放。
 *  3. **能力不在记忆服务里** —— 它在与记忆服务并列的能力库中。这里没有 `能力` 这一类。
 *
 * 四类的归属（§7 表）：知识 = 岗位 + 项目双标签（跨项目/本项目）；经历 = 组织账本（只增）；
 * 偏好 = 部署（永不外流）；作答 = 实例（私有区内部，任务结束归档）。
 */
import { appendLines, exists, listDirs, readJsonl, readTextOrNull, atomicWrite, withLock } from './kernel/fsx.js';
import { InvalidBody, Denied, Fault } from './kernel/errors.js';
import { objectId } from './kernel/ids.js';
import { buildIndex, formatMiss, search } from './retrieval.js';
import { DIR, MEMORY_KINDS } from './paths.js';

/** 归档后可读的角色（§7 表）。 */
const ANSWER_READERS = ['主权者', 'Lead', '复核者'];

/** 记录档位：条目行 vs 状态行。用「有没有 `指向`」区分，避免再加一个字段。 */
const isStateRow = (row) => typeof row?.指向 === 'string' && typeof row?.追加 === 'string';

/**
 * 契约C（主权者裁决 2026-10-09）·披露机械检查的**出厂默认清单**。
 *
 * 晋升跨项目知识（`promoteCrossProject`）会把一条知识扩散到产生它的项目之外，
 * 唯一闸此前是 Lead 肉眼；这张清单把「肉眼」换成「机械模式 + 显式豁免」。
 * 私有 `部署.json` 的 `披露敏感模式` 键（`[{名, 正则}]`）**整体覆盖**这份默认清单——
 * 形状与正则合法性在 `policy.js` 的加载期校验，非法正则 ⇒ 引擎不健康（fail-closed），
 * 不许静默跳过（§3.6）。
 *
 * 匹配统一大小写不敏感（`password` 也要拦住 `PASSWORD` / `Token`）。
 */
export const DEFAULT_DISCLOSURE_PATTERNS = [
  { 名: 'Windows 绝对路径/盘符', 正则: '[A-Za-z]:\\\\' },
  { 名: 'UNC 路径', 正则: '\\\\\\\\' },
  { 名: '环境变量引用', 正则: '%[A-Za-z_][A-Za-z0-9_]*%' },
  { 名: 'email', 正则: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}' },
  { 名: '凭据词', 正则: 'password|secret|token|凭据|密码|密钥' },
];

export class MemoryService {
  /** id 用的严格递增时刻（只在内存里；见 `#nextStamp`）。 */
  #lastStamp;

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
   * 记一条。写入时校验正文结构与来源；不合规拒写，不做事后修补。
   *
   * @param {{ subject: object, 类: string, 内容: string, 来源: string|{谁?: string, 怎么知道: string}, 项目?: string, 岗位?: string, 标签?: string[], 标题?: string, 轮?: string, 任务?: object }} input
   * @returns {Promise<{ id: string, 类: string, 归属: string, 账本: string, 项目: string|null, 岗位: string|null }>}
   */
  async remember(input) {
    const kind = input.类;
    if (!MEMORY_KINDS.includes(kind)) {
      throw new InvalidBody(`记忆只有四类：${MEMORY_KINDS.join(' / ')}；收到「${kind}」。能力不在记忆服务里。`, {
        detail: { 收到: kind, 允许: MEMORY_KINDS },
      });
    }
    const 来源 = normalizeSource(input.来源, input.subject);
    if (!来源.谁 || !来源.怎么知道) {
      throw new InvalidBody('记忆写入必须带「谁记的 + 怎么知道的」。', {
        missing: [!来源.谁 ? '来源.谁' : null, !来源.怎么知道 ? '来源.怎么知道' : null].filter(Boolean),
      });
    }
    const text = String(input.内容 ?? '').trim();
    if (!text) throw new InvalidBody('记忆内容为空：空条目会污染检索面。');

    const 项目 = input.项目 ?? null;
    if (kind === '知识' && !项目) {
      throw new InvalidBody('知识必须恒打项目标签：它产生于某个项目。');
    }
    if (kind === '作答' && !项目) {
      throw new InvalidBody('作答必须有项目归属：它是某个项目里的一次作答。');
    }

    const scope = kind === '经历' || kind === '偏好' ? DIR.跨项目 : 项目;
    const target = memoryTarget(kind, scope, 项目);
    await this.policy.check({
      subject: input.subject,
      action: 'create',
      target,
      context: { task: input.任务 ?? null, 类: kind },
    });

    // id 的种子**不许含正文**。id 会进每一条审计记录的 `对象.id`，而审计只增、
    // 连主权者也只能追加更正 ⇒ 正文一旦折进 id，物理删除就永远删不干净
    // （评审稿 §A8/§C8：删除凭据应是随机对象 ID，不保留原文，也不保留可枚举的敏感标题）。
    // 所以种子只用「类 + 主体 + 时刻」；人可读的标题另存 `标题` 字段——
    // 它是账本里的一行，`purge` 能连带抹掉，而 id 里的东西抹不掉。
    const id = objectId(kind, `${kind}/${input.subject?.id ?? 'unknown'}`, { at: this.#nextStamp() });
    const row = {
      id,
      类: kind,
      标题: input.标题 ?? text.slice(0, 40),
      内容: text,
      来源,
      归属: scope,
      项目,
      // 知识：项目标签恒打；岗位标签默认不打（由 Lead 判定「这条跨项目可复用」后追加）。
      岗位: kind === '知识' ? null : (input.岗位 ?? null),
      标签: input.标签 ?? [],
      状态: '有效',
      记于: this.clock.iso(),
      轮: input.轮 ?? null,
    };
    await appendLines(this.layout.memoryLog(scope, kind), [row]);
    await this.audit.append({
      动作: '状态变更',
      主体: input.subject,
      对象: { id, kind: '知识' === kind ? '知识' : kind },
      依据: '记忆服务：写入必带谁记的 + 怎么知道的',
      结果: `记入${scope}`,
      项目,
      详情: { 类: kind, 来源: 来源.怎么知道 },
    });
    return { id, 类: kind, 归属: scope, 账本: this.layout.memoryLog(scope, kind), 项目, 岗位: row.岗位 };
  }

  /**
   * 由 Lead 判定「这条跨项目可复用」后追加岗位标签（默认不打，不是漏打）。
   * 追加本身也是一条状态记录，因此可追溯是谁判断的。
   *
   * 契约C（主权者裁决 2026-10-09）·披露机械检查：晋升会把这条知识扩散到产生它的
   * 项目之外，此前唯一闸是 Lead 肉眼；现在**先过机械敏感模式**（标题+内容+标签），
   * 命中即拒（Denied 指向豁免面），只有 Lead 的**显式豁免**能放行——豁免与命中模式
   * 一起进审计（`披露豁免`，全记）。清单：出厂默认 `DEFAULT_DISCLOSURE_PATTERNS`，
   * 私有 `部署.json` 的 `披露敏感模式` 整体覆盖（非法正则在策略引擎加载期已响亮抛错）。
   *
   * @param {string} id
   * @param {{ subject: object, 岗位: string, 理由: string, 披露豁免?: boolean }} spec
   * @returns {Promise<{ id: string, 岗位: string }>}
   */
  async promoteCrossProject(id, spec) {
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    if (entry.类 !== '知识') throw new InvalidBody('只有知识可以打岗位标签；经历/偏好/作答不跨项目。');
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: memoryTarget('知识', DIR.跨项目, entry.项目),
      context: { id },
    });

    // ── 契约C 披露机械检查：标题 + 内容 + 标签 三个面一起过 ──────────────────
    // 顺序在 policy.check 之后：先由唯一判定点确认「这个主体有权晋升」，
    // 再由这道内容闸拦「这段文本值不值得扩散」。命中拒绝不入豁免审计——
    // 豁免审计只记「真的越过这道闸」的决定（与 purge 域内闸的先例同口径）。
    const 命中 = this.#disclosureHits(entry);
    let 豁免留痕 = null;
    if (命中.length > 0) {
      const 命中模式 = 命中.map((h) => h.名);
      if (spec.披露豁免 === true && spec.subject?.kind !== 'Lead') {
        throw new Denied(
          '法律 披露豁免仅 Lead（契约C 2026-10-09）',
          `披露豁免是 Lead 专属参数：${spec.subject?.kind ?? '未知'} 不得使用。命中模式：${命中模式.join('、')}。`,
          {
            requireAuthority: 'Lead',
            howToChange: '由 Lead 核实该条知识确属可披露后，以 Lead 身份带 披露豁免=true 执行晋升。',
            detail: { 命中模式 },
          },
        );
      }
      if (spec.披露豁免 !== true) {
        throw new Denied(
          '法律 知识晋升披露机械检查（契约C 2026-10-09）',
          `该条知识的标题/内容/标签命中敏感模式：${命中模式.join('、')}。跨项目晋升会把这条知识扩散到产生它的项目之外。`,
          {
            requireAuthority: 'Lead',
            howToChange: '两条路：① 先改写条目去掉敏感内容（或让产生它的项目继续私有持有）再晋升；② Lead 核实确属可披露后带 披露豁免=true 重试——豁免与命中模式会一起进审计。',
            detail: { 命中模式 },
          },
        );
      }
      // Lead 显式豁免：放行，但「越过披露闸」这件事必须与命中模式一起留痕。
      // 审计只记模式名，不抄命中片段——把敏感原文再抄进账本等于二次披露。
      // 留痕挂在局部变量上（不用实例字段：并发晋升两个条目会互相覆盖）。
      豁免留痕 = { 命中模式 };
    }

    // 双份留痕：本项目那份保留原样，跨项目那份追一条同 id 的条目，
    // 这样「它产生于本项目」与「它对本岗位可复用」两个事实都在。
    await appendLines(this.layout.memoryLog(DIR.跨项目, '知识'), [
      {
        ...entry,
        归属: DIR.跨项目,
        岗位: spec.岗位,
        追加: undefined,
        记于: entry.记于,
        跨项目判定: { 由: spec.subject?.id ?? 'unknown', 理由: spec.理由, 于: this.clock.iso() },
      },
    ]);
    if (豁免留痕) {
      await this.audit.append({
        动作: '披露豁免',
        主体: spec.subject,
        对象: { id, kind: '知识' },
        依据: '契约C（2026-10-09）：Lead 显式豁免披露机械检查，放行跨项目晋升',
        结果: `豁免放行（命中 ${豁免留痕.命中模式.join('、')}）`,
        项目: entry.项目,
        详情: { 命中模式: 豁免留痕.命中模式, 岗位: spec.岗位, 理由: spec.理由 },
      });
    }
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id, kind: '知识' },
      依据: '知识标签写入规则：岗位标签默认不打，Lead 判定可复用后追加',
      结果: `追加岗位标签 ${spec.岗位}`,
      项目: entry.项目,
      详情: { 理由: spec.理由 },
    });
    return { id, 岗位: spec.岗位 };
  }

  /**
   * 检索。默认把归档后的作答排除在检索面之外；`显式: true` 才把它拉回来（§7）。
   * 默认还按「当前有效视图」召回：已失效 / 被推翻的条目留在 `条目` 里供追溯，但不进 `命中`；
   * 要看它们就带 `含失效: true`。
   *
   * 契约B（主权者裁决 2026-10-09）·只读面收窄：查询也过唯一判定点。
   * `subject` 缺失或未知 ⇒ 引擎按「未知主体」拒绝（fail-closed），这里**不另设默认主体**——
   * 读者可见性（归档作答）仍由 `读者` 承担，判定（能不能查）由 `subject` 承担。
   * 放行条目按「一次调用一条」入账（档位「记汇总」），不随命中条数膨胀。
   *
   * @param {{ subject: object, 类?: string[], 项目?: string, 岗位?: string, 文本?: string, 显式?: boolean, 含失效?: boolean, 读者?: object, limit?: number, 条数上限?: number }} query
   *   `limit` 管 `命中` 条数；`条数上限` 管 `条目` 回传条数（默认 50，超出截断并标注）。
   * @returns {Promise<{ 命中: object[], 口径: object, 条目: object[], 说明?: string }>}
   */
  async query(query = {}) {
    await this.policy.check({
      subject: query.subject,
      action: 'read',
      target: { id: `记忆/检索/${query.项目 ?? '全部项目'}`, kind: '记忆', authority: '自治', zone: '私有', domain: '集体', project: query.项目 ?? null },
      context: { 类: query.类 ?? null },
    });
    // 一次调用一条（档位由 ACTION_GRADE 的「只读服务调用=记汇总」定）：
    // 查询命中 50 条 ≠ 50 条审计。拒绝路径不入这条账——引擎的「策略拒绝」已全记。
    await this.audit.append({
      动作: '只读服务调用',
      主体: query.subject,
      对象: { id: `记忆/检索/${query.项目 ?? '全部项目'}`, kind: '记忆' },
      依据: '契约B（2026-10-09）只读面收窄：检索也过唯一判定点',
      结果: '放行',
      项目: query.项目 ?? null,
      详情: { 服务: 'memory.query', 类: query.类 ?? null, 带查询词: Boolean(query.文本) },
    });
    const wanted = query.类 ?? MEMORY_KINDS;
    const rows = [];
    for (const kind of wanted) {
      if (!MEMORY_KINDS.includes(kind)) continue;
      for (const scope of await this.#scopesFor(kind, query.项目)) {
        rows.push(...(await readJsonl(this.layout.memoryLog(scope, kind))));
      }
    }
    const entries = fold(rows).filter((entry) => entry.状态 !== '物理删除');
    const visible = [];
    for (const entry of entries) {
      if (entry.类 === '作答' && entry.归档 === true && query.显式 !== true) continue;
      if (entry.类 === '作答' && entry.归档 === true && query.读者) {
        if (!ANSWER_READERS.includes(query.读者.kind)) continue;
      }
      if (query.项目 && entry.类 === '知识' && entry.项目 && entry.项目 !== query.项目 && entry.归属 !== DIR.跨项目) continue;
      if (query.岗位 && entry.岗位 && entry.岗位 !== query.岗位) continue;
      visible.push(entry);
    }

    // 「当前有效视图」：失效与被推翻的条目**不进召回**，但**仍留在 `条目` 里**供追溯——
    // 调用方要看到「这条存在过、已经被否掉」，而不是让它悄悄消失（§7 追加状态的本意）。
    // 要看它们就显式带 `含失效: true`（历史 / 调查口径）。
    //
    // 判据是**粘的**：只要追加过 invalid / 推翻，就不再进当前召回，之后的「降权」不许把它复活。
    // 只看最后一个 `状态` 会漏：`fold` 是按 `追于` 覆盖的，而 `追于` 是**秒级**——
    // 同一秒里「先失效、后降权」会让最终状态变成 `已降权`，于是被判错过的条目又回到召回面。
    // 方向也一致：降权的意思是「冷」，不是「错」（§7「冷 ⇒ 追加降权状态，不删」），
    // 而「错」是事实判断，不该被后来的优先级判断撤销。
    const 已被否 = (entry) =>
      entry.状态 === '已失效' ||
      entry.状态 === '被推翻' ||
      (entry.历史 ?? []).some((s) => s.追加 === 'invalid' || s.追加 === '推翻');
    const 撤回 = visible.filter(已被否);
    const 可召回 = query.含失效 === true ? visible : visible.filter((entry) => !已被否(entry));

    // `排除失效` 只报**实际被排除**的条数：带 `含失效: true` 时一条都没排除，
    // 那里还写个 1 就是一句假读数（这个组织里假读数比没读数更贵）。
    // 「一共有几条失效」另用 `失效条目数` 报，两个问题分开答。
    const 口径数 = {
      文档数: visible.length,
      可召回数: 可召回.length,
      失效条目数: 撤回.length,
      排除失效: query.含失效 === true ? 0 : 撤回.length,
    };

    // `条目` 的回传预算：全量 visible 可能把整个账本塞进一次回复
    // （空 query 分支曾无条件回传全部），于是默认只回最新的 N 条并如实标注。
    // 命中（`命中`）与口径（`口径`）不受影响：预算只管 `条目` 这一栏。
    const 条数上限 = Number.isFinite(query.条数上限) && query.条数上限 > 0 ? Math.floor(query.条数上限) : 50;
    const 条目截断 = visible.length > 条数上限;
    const 条目 = 条目截断 ? visible.slice(-条数上限) : visible;
    const 条目口径 = { 条目截断, 条目总数: visible.length, 条数上限 };

    if (!query.文本) {
      return {
        命中: [],
        条目,
        条目截断,
        条目总数: visible.length,
        条数上限,
        口径: { 搜索面: '记忆服务', 查询词: '', 范围: wanted.join('/'), ...口径数, 命中数: 0, ...条目口径 },
        ...(条目截断 ? { 说明: `条目 共 ${visible.length} 条，超出上限 ${条数上限}，只回传最新 ${条数上限} 条；带 条数上限 可调。` } : {}),
        ...(query.显式 === true ? { 说明: '已显式包含归档作答。' } : {}),
      };
    }
    const index = buildIndex(可召回.map((entry) => ({ id: entry.id, 正文: entry.内容, 标签: [entry.类, entry.岗位 ?? ''], 来源: entry.归属 })));
    const result = search(index, query.文本, { limit: query.limit ?? 10, 范围: `${wanted.join('/')}@${query.项目 ?? '全部项目'}` });
    result.口径 = { ...result.口径, ...口径数 };
    if (result.命中.length === 0) result.说明 = formatMiss(result.口径);
    if (撤回.length > 0 && query.含失效 !== true) {
      // 「0 命中」与「有材料但被当前有效视图挡住」是两件事，不许折成同一句话。
      result.说明 = [result.说明, `另有 ${撤回.length} 条已失效/被推翻的条目按「当前有效视图」未进召回；要看它们请带 含失效: true。`]
        .filter(Boolean)
        .join(' ');
    }
    result.条目 = 条目;
    result.条目截断 = 条目截断;
    result.条目总数 = visible.length;
    result.条数上限 = 条数上限;
    result.口径 = { ...result.口径, ...条目口径 };
    if (条目截断) {
      result.说明 = [result.说明, `条目 共 ${visible.length} 条，超出上限 ${条数上限}，只回传最新 ${条数上限} 条；带 条数上限 可调。`]
        .filter(Boolean)
        .join(' ');
    }
    return result;
  }

  /**
   * 失效：追加 `invalid` 状态，不改原条目（§7「错误 / 过期」）。
   * @param {string} id
   * @param {{ subject: object, 原因: string }} spec
   */
  async invalidate(id, spec) {
    return this.#appendState(id, 'invalid', spec);
  }

  /**
   * 冷：追加降权状态，不删（§7「冷」）。
   * @param {string} id
   * @param {{ subject: object, 原因: string }} spec
   */
  async demote(id, spec) {
    return this.#appendState(id, '降权', spec);
  }

  /**
   * 被推翻：追加状态并追加新条目，双份留痕（§7「被推翻」）。
   * @param {string} id
   * @param {{ subject: object, 新条目: string, 理由: string }} spec
   */
  async overturn(id, spec) {
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    const created = await this.remember({
      subject: spec.subject,
      类: entry.类,
      内容: spec.新条目,
      来源: { 谁: spec.subject?.id, 怎么知道: `推翻 ${id}：${spec.理由}` },
      项目: entry.项目,
      岗位: entry.岗位 ?? undefined,
    });
    await this.#appendState(id, '推翻', spec, { 新条目: created.id });
    return { id, 状态: '被推翻', 新条目: created.id };
  }

  /**
   * 物理删除：仅限敏感数据、或主权者明确要求。
   *
   * 这是全库唯一允许**真的**从账本里抹掉内容的动作，所以它必须：
   * ① 只在两种理由下开放——敏感数据要**显式声明**（`敏感: true`），不靠理由文本里捞关键字
   *   （关键字闸会被「这段不敏感」这种措辞误开，而声明是会进审计的明确动作）；
   * ② 抹掉内容后仍然在审计里留一条不可逆操作记录
   * （记录 id 与理由，不记录内容本身——否则等于没删）；③ **扫遍出现过该 id 的每一本账**
   * （晋升过的知识同时住在项目账与跨项目账上，只删一本等于没删）。
   *
   * 闸的动作为什么是 'write' 而不是 'delete'：'delete' 是主权者专属（宪章 §3.2），
   * 而敏感数据清除是不能排队等主权者的安全动作；'write' 闸把失联冻结、介入度、
   * 复核者只读这些边界接进来，「仅限敏感数据 / 主权者明确要求」由上面的域内闸收口。
   *
   * @param {string} id
   * @param {{ subject: object, 理由: string, 敏感?: boolean }} spec
   * @returns {Promise<{ id: string, 已删除: true, 依据: string }>}
   */
  async purge(id, spec) {
    if (typeof spec.理由 !== 'string' || !spec.理由.trim()) {
      throw new InvalidBody('物理删除必须带理由：它要进那条不可逆操作记录。', { missing: ['理由'] });
    }
    const 敏感 = spec.敏感 === true;
    const 主权者要求 = spec.subject?.kind === '主权者';
    if (!敏感 && !主权者要求) {
      throw new Denied('法律 记忆处置表（物理删除只限敏感数据 / 主权者明确要求）', '物理删除会破坏「不许改写只能追加」这条唯一原则，只有敏感数据或主权者明确要求才允许。', {
        requireAuthority: '主权者',
        howToChange: '改用 invalidate() 追加失效状态；那才是错误/过期条目的常规处置。确属敏感数据时显式声明 敏感: true，声明会进审计。',
      });
    }
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: memoryTarget(entry.类, entry.归属, entry.项目),
      context: { id, 状态: '物理删除' },
    });

    // 同一个 id 可以同时躺在两本账上：知识晋升会把它复制进「跨项目」，
    // 而原条目仍留在产生它的那个项目账里（§7「双份留痕」）。
    // 所以物理删除必须扫**所有**出现过它的账本——只删 `归属` 那一本，
    // 另一本会留下全文副本，而审计却写着「内容已抹掉」：那是一句假话。
    // 漏删的那本正是「原文禁读、副本仍可读」的空窗（评审稿 §C8 明令禁止）。
    const 覆盖 = [];
    for (const scope of [DIR.跨项目, ...(await this.#projectScopes())]) {
      const file = this.layout.memoryLog(scope, entry.类);
      if (await exists(file)) 覆盖.push({ scope, file });
    }
    for (const { file } of 覆盖) {
      await withLock(`${file}.lock`, async () => {
        const text = (await readTextOrNull(file)) ?? '';
        const kept = text
          .split('\n')
          .filter((line) => line.trim())
          .filter((line) => {
            try {
              return JSON.parse(line).id !== id;
            } catch {
              return true;
            }
          });
        await atomicWrite(file, kept.length ? `${kept.join('\n')}\n` : '');
      });
    }
    await this.audit.append({
      动作: '不可逆操作',
      主体: spec.subject,
      对象: { id, kind: entry.类 },
      依据: 敏感 ? '记忆处置表：敏感数据' : '记忆处置表：主权者明确要求',
      结果: `物理删除（内容已抹掉；覆盖 ${覆盖.length} 本账：${覆盖.map((x) => x.scope).join(' / ')}）`,
      项目: entry.项目,
      详情: { 理由: spec.理由, 类: entry.类, 清理覆盖: 覆盖.map((x) => x.file) },
    });
    return { id, 已删除: true, 依据: spec.理由, 清理覆盖: 覆盖.map((x) => x.scope) };
  }

  /**
   * 作答归档：任务结束时调用；归档后成员的读权限关闭，自动检索也不再默认返回。
   * @param {{ 项目: string, 任务?: string, subject: object }} spec
   * @returns {Promise<{ 归档条数: number, 账本: string }>}
   */
  async archiveAnswers(spec) {
    const file = this.layout.memoryLog(spec.项目, '作答');
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: memoryTarget('作答', spec.项目, spec.项目),
      context: { id: spec.任务 ?? null, 状态: '归档' },
    });
    const rows = await readJsonl(file);
    const open = rows.filter((row) => !isStateRow(row));
    if (open.length === 0) return { 归档条数: 0, 账本: file };
    await appendLines(file, open.map((row) => ({ id: objectId('账目', row.id, { at: this.clock.ms() }), 指向: row.id, 追加: '归档', 追于: this.clock.iso(), 依据: spec.任务 ?? '任务结束', 主体: spec.subject })));
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.任务 ?? spec.项目, kind: '任务' },
      依据: '作答归档后的可读性表（§7）',
      结果: `归档 ${open.length} 条作答：成员不可读，默认检索面不再返回`,
      项目: spec.项目,
    });
    return { 归档条数: open.length, 账本: file };
  }

  /**
   * 归档后的可读性矩阵（§7 表）。
   * @param {string} id
   * @param {{ 读者: object }} spec
   * @returns {Promise<{ 可读: boolean, 原因: string }>}
   */
  async readableBy(id, spec) {
    const entry = await this.#folded(id);
    if (!entry) return { 可读: false, 原因: '没有这条记忆' };
    if (entry.类 !== '作答' || entry.归档 !== true) return { 可读: true, 原因: '未归档条目对所有在编主体可读' };
    if (ANSWER_READERS.includes(spec.读者?.kind)) return { 可读: true, 原因: `${spec.读者.kind} 在归档后仍可读（会审分歧清单必须对复核者可见）` };
    return { 可读: false, 原因: `${spec.读者?.kind ?? '未知主体'} 不可读归档作答；自动检索也不进默认面` };
  }

  /**
   * 记忆规模：供工作台与探针使用。
   * @param {{ 项目?: string }} [query]
   */
  async stats(query = {}) {
    /** @type {Record<string, number>} */
    const 计数 = {};
    for (const kind of MEMORY_KINDS) {
      let n = 0;
      for (const scope of await this.#scopesFor(kind, query.项目)) {
        n += fold(await readJsonl(this.layout.memoryLog(scope, kind))).filter((e) => e.状态 !== '物理删除').length;
      }
      计数[kind] = n;
    }
    return { 计数, 合计: Object.values(计数).reduce((a, b) => a + b, 0) };
  }

  /**
   * 记忆规模与近段异动：给 status / 工作台的「验账读数」。
   *
   * 为什么要有它：人不翻账本，但要能一眼确认「记账在正常发生」。
   * 数字必须真实：同 id 的晋升副本与项目原件折成一条计（不双计数），
   * 物理删除的不计；晋升按带 `跨项目判定` 的行数（那是晋升动作本身的留痕）。
   *
   * @param {{ 项目?: string, 天?: number }} [query]
   * @returns {Promise<{窗口天: number, 起点: string, 存量合计: number, 新增合计: number, 按类: Record<string, number>, 晋升: number}>}
   */
  async activity(query = {}) {
    const 天 = Number.isFinite(query.天) && query.天 > 0 ? query.天 : 7;
    const 起点 = new Date(this.clock.ms() - 天 * 86_400_000).toISOString();
    const 按类 = {};
    let 存量合计 = 0;
    let 新增合计 = 0;
    let 晋升 = 0;
    for (const kind of MEMORY_KINDS) {
      按类[kind] = 0;
      const rows = [];
      for (const scope of await this.#scopesFor(kind, query.项目)) {
        const scopeRows = await readJsonl(this.layout.memoryLog(scope, kind));
        rows.push(...scopeRows);
        if (kind === '知识') {
          晋升 += scopeRows.filter((r) => r.跨项目判定 && String(r.跨项目判定.于) >= 起点).length;
        }
      }
      // 跨账本 fold 一次：同 id 的晋升副本与原件是一条记忆，不许双计数（假读数比没读数贵）。
      for (const entry of fold(rows)) {
        if (entry.状态 === '物理删除') continue;
        存量合计 += 1;
        按类[kind] += 1;
        if (String(entry.记于) >= 起点) 新增合计 += 1;
      }
    }
    return { 窗口天: 天, 起点, 存量合计, 新增合计, 按类, 晋升 };
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /**
   * 契约C 披露机械检查本体：对 标题+内容+标签 三个面跑敏感模式。
   *
   * @param {object} entry 折叠后的记忆条目
   * @returns {Array<{名: string}>} 命中的模式（只带名，不带命中片段——片段正是敏感本体）
   */
  #disclosureHits(entry) {
    const 面数 = [entry?.标题, entry?.内容, ...(Array.isArray(entry?.标签) ? entry.标签 : [])].filter((s) => typeof s === 'string').join('\n');
    const 清单 = this.policy.state.defaults?.披露敏感模式 ?? DEFAULT_DISCLOSURE_PATTERNS;
    const 命中 = [];
    for (const { 名, 正则 } of 清单) {
      // 加载期已校验可编译；这里仍兜住编译/执行异常——机械检查自己炸了不许静默放行。
      let re;
      try {
        re = new RegExp(正则, 'i');
      } catch {
        throw new Fault('DISCLOSURE_PATTERN_BROKEN', `披露敏感模式[${名}] 在执行期无法编译：${正则}。按 fail-closed 拒绝本次晋升；请修好部署.json 后重载。`, { detail: { 名 } });
      }
      if (re.test(面数)) 命中.push({ 名 });
    }
    return 命中;
  }

  /**
   * 严格递增的时刻，只给 id 用。
   *
   * 为什么需要它：id 的种子去掉了正文，只剩「类 + 主体 + 时刻」。
   * 若同一毫秒内、同一主体写两条，哈希输入完全相同 ⇒ **撞 id**，
   * 而 `fold()` 是按 id 归并的，撞 id 会让两条记忆静默合成一条。
   * 所以这里保证「后一次调用拿到的时刻严格大于前一次」。
   */
  #nextStamp() {
    const now = this.clock.ms();
    this.#lastStamp = this.#lastStamp !== undefined && now <= this.#lastStamp ? this.#lastStamp + 1 : now;
    return this.#lastStamp;
  }

  /** @param {string} kind @param {string|undefined} 项目 */
  async #scopesFor(kind, 项目) {
    const scopes = [DIR.跨项目];
    if (kind === '知识' || kind === '作答') {
      const all = await this.#projectScopes();
      for (const scope of all) {
        if (!项目 || scope === 项目) scopes.push(scope);
      }
    }
    return [...new Set(scopes)];
  }

  /** 记忆服务目录下出现过的项目键（目录名即项目键，§14.4-5）。 */
  async #projectScopes() {
    const names = await listDirs(this.layout.memoryDir(DIR.跨项目), { up: true });
    return names.filter((n) => n !== DIR.跨项目);
  }

  /** @param {string} id */
  async #folded(id) {
    for (const kind of MEMORY_KINDS) {
      for (const scope of [DIR.跨项目, ...(await this.#projectScopes())]) {
        const rows = await readJsonl(this.layout.memoryLog(scope, kind));
        const hit = fold(rows).find((entry) => entry.id === id);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * @param {string} id
   * @param {string} 状态
   * @param {{ subject: object, 原因: string }} spec
   * @param {object} [extra]
   */
  async #appendState(id, 状态, spec, extra = {}) {
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: memoryTarget(entry.类, entry.归属, entry.项目),
      context: { id, 状态 },
    });
    await appendLines(this.layout.memoryLog(entry.归属, entry.类), [
      { id: objectId('账目', `${id}:${状态}`, { at: this.clock.ms() }), 指向: id, 追加: 状态, 追于: this.clock.iso(), 依据: spec.原因, 主体: spec.subject, ...extra },
    ]);
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id, kind: entry.类 },
      依据: '记忆处置表：不许改写，只能追加',
      结果: `追加状态 ${状态}`,
      项目: entry.项目,
      详情: { 原因: spec.原因 },
    });
    return { id, 状态, 指向: id };
  }
}

/**
 * 把 append-only 行折成当前视图。
 * @param {object[]} rows
 * @returns {Array<object & {状态: string, 归档?: boolean, 历史: object[]}>}
 */
export function fold(rows) {
  /** @type {Map<string, object>} */
  const entries = new Map();
  /** @type {object[]} */
  const states = [];
  for (const row of rows) {
    if (isStateRow(row)) states.push(row);
    else if (row.id) {
      const prev = entries.get(row.id);
      // 同 id 的条目行显式合并（E1）：晋升会在跨项目账里追一条同 id 副本，
      // 直接 set 会让后读的项目账原件覆盖掉晋升副本 ⇒ 岗位标签在默认视图里静默丢失。
      entries.set(row.id, prev ? mergeEntryRows(prev, row) : { ...row, 状态: row.状态 ?? '有效', 历史: [] });
    }
  }
  for (const state of states.sort((a, b) => String(a.追于).localeCompare(String(b.追于)))) {
    const entry = entries.get(state.指向);
    if (!entry) continue;
    entry.历史 = [...entry.历史, state];
    if (state.追加 === 'invalid') entry.状态 = '已失效';
    else if (state.追加 === '降权') entry.状态 = '已降权';
    else if (state.追加 === '推翻') entry.状态 = '被推翻';
    else if (state.追加 === '归档') entry.归档 = true;
    else if (state.追加 === '物理删除') entry.状态 = '物理删除';
  }
  return [...entries.values()];
}

/**
 * 同 id 的两份条目行合成一份（E1）。带岗位标签的那份（晋升副本）优先，
 * 它缺的键从另一份补——两份正文本来就该一致，差异只在 归属/岗位/跨项目判定。
 * @param {object} a @param {object} b
 */
function mergeEntryRows(a, b) {
  const [win, lose] = b.岗位 && !a.岗位 ? [b, a] : [a, b];
  return {
    ...lose,
    ...Object.fromEntries(Object.entries(win).filter(([, v]) => v !== undefined && v !== null)),
    账本出现于: [...new Set([...(a.账本出现于 ?? []), ...(b.账本出现于 ?? []), a.归属, b.归属])].filter(Boolean),
  };
}

/**
 * @param {string|object} source
 * @param {object} subject
 * @returns {{谁: string, 怎么知道: string}}
 */
function normalizeSource(source, subject) {
  if (source && typeof source === 'object') {
    return { 谁: String(source.谁 ?? subject?.id ?? ''), 怎么知道: String(source.怎么知道 ?? '') };
  }
  return { 谁: String(subject?.id ?? ''), 怎么知道: String(source ?? '') };
}

/**
 * @param {string} 类
 * @param {string} scope
 * @param {string|null} 项目
 */
function memoryTarget(类, scope, 项目) {
  return {
    id: `记忆/${scope}/${类}`,
    kind: 类,
    authority: '自治',
    zone: '私有',
    domain: '集体',
    project: 项目,
  };
}
