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
import { stat } from 'node:fs/promises';
import { InvalidBody, Denied, Fault } from './kernel/errors.js';
import { objectId } from './kernel/ids.js';
import { buildIndex, formatMiss, search } from './retrieval.js';
import { DIR, MEMORY_KINDS } from './paths.js';

/** 归档后可读的角色（§7 表）。 */
const ANSWER_READERS = ['主权者', 'Lead', '复核者'];

/**
 * remember 内部通道记号（2026-10-13 审查 P1-11）：`派生自` / `同锁追加` 只许 overturn
 * 这一内部调用路径携带（以本模块的 Symbol 键标记）。JSON 入参不可能长出 Symbol 键，
 * 工具面/命令面/路由面拼的参数天然过不了这道检查。
 */
const 内部通道 = Symbol('dsh-mind-memory-internal');

/** 披露正则编译缓存（#disclosureHits 用，按正则源键控，带上限防长胖）。 */
const 披露正则缓存 = new Map();

/** 检索索引缓存条数上限（每种过滤口径一份够了；超了丢最早）。 */
const 索引缓存上限 = 8;

/** 记录档位：条目行 vs 状态行。用「有没有 `指向`」区分，避免再加一个字段。 */
const isStateRow = (row) => typeof row?.指向 === 'string' && typeof row?.追加 === 'string';

/**
 * 「已被否」粘性判据（**唯一源**，2026-10-12 评审收口）：`query` 的默认召回面与
 * `promoteCrossProject` 的晋升闸共用同一条——召回面否掉的东西，晋升面不许放行。
 *
 * 判据是**粘的**：只要追加过 invalid / 推翻，就永久出局，之后的「降权」不许把它复活。
 * 只看最后一个 `状态` 会漏：`fold` 是按 `追于` 覆盖的，而 `追于` 是**秒级**——
 * 同一秒里「先失效、后降权」会让最终状态变成 `已降权`，于是被判错过的条目又回到召回面。
 * 方向也一致：降权的意思是「冷」，不是「错」（§7「冷 ⇒ 追加降权状态，不删」），
 * 而「错」是事实判断，不该被后来的优先级判断撤销。
 *
 * 契约A（§C8）：「隔离 / 待删除」与已失效同为粘性——源对象被物理删除后，
 * 血缘波及的下游不许再以「有效知识」的面目出现在默认召回里。
 */
export function 是否已被否(entry) {
  return (
    entry.状态 === '已失效' ||
    entry.状态 === '被推翻' ||
    entry.状态 === '已隔离' ||
    entry.状态 === '待删除' ||
    (entry.历史 ?? []).some((s) => ['invalid', '推翻', '隔离', '待删除'].includes(s.追加))
  );
}

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

  /** 账本读缓存（2026-10-13 第三批性能收口）：文件 → {签名, rows}。真源仍是文件，签名一变即重读。 */
  #rowsCache = new Map();
  /** 本进程写计数（写后即使 mtime/size 撞车也重读）。 */
  #writeCount = new Map();
  /**
   * 检索索引缓存（2026-10-13 第四批性能收口）：键 = 账本签名 + 过滤口径，
   * 值 = {index}。为什么必须缓存：`buildIndex` 要对每条候选文档分词，
   * 5000 行账本实测 **351 ms/次查询**（普通读面只要 16 ms）——每次带词检索都重建是白付。
   */
  #indexCache = new Map();
  /** 血缘索引缓存（同上）：`buildLineageIndex` 每次重建实测约 203 ms。 */
  #lineageCache = new Map();

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
   * 某账本文件的签名（mtime+size+本进程写计数）。缓存与索引都拿它当失效依据。
   * @param {string} file
   * @returns {Promise<string>}
   */
  async #签名(file) {
    try {
      const st = await stat(file);
      return `${st.mtimeMs}:${st.size}:${this.#writeCount.get(file) ?? 0}`;
    } catch {
      return `absent:${this.#writeCount.get(file) ?? 0}`;
    }
  }

  /**
   * 一组账本的合成签名（顺序无关：先按路径排序再拼）。
   * @param {string[]} files
   * @returns {Promise<string>}
   */
  async #签名们(files) {
    const 排序 = [...files].sort();
    const 部分 = [];
    for (const file of 排序) 部分.push(`${file}#${await this.#签名(file)}`);
    return 部分.join('|');
  }

  /**
   * 账本行（带读缓存）：签名 = 盘上 mtime+size + 本进程对该文件的写次数。
   * 供读面（query/stats/血缘/folded）复用——修前每个读面各自全量读+解析所有账本，
   * 检索一次查询要扫「类 × 范围」遍。
   * @param {string} file
   * @returns {Promise<object[]>}
   */
  async #rows(file) {
    const 签名 = await this.#签名(file);
    const hit = this.#rowsCache.get(file);
    if (hit?.签名 === 签名) return hit.rows;
    const rows = await readJsonl(file);
    this.#rowsCache.set(file, { 签名, rows });
    return rows;
  }

  /** 记一次本进程写入：让该文件的缓存签名失效。 */
  #bump(file) {
    this.#writeCount.set(file, (this.#writeCount.get(file) ?? 0) + 1);
  }

  /**
   * 记一条。写入时校验正文结构与来源；不合规拒写，不做事后修补。
   *
   * 契约A（评审稿 §C2，2026-10-09）·完整血缘：
   *  - `来源引用: string[]`——这条记忆的证据/来源对象 id 列表。写入时**存在性校验
   *    fail-closed**：know-/exp-/pref-/answ- 前缀必须在账本 fold 得到、task- 前缀必须
   *    在任务图事件流里出现过、artifact- 前缀本批不校验（INTERFACES 写明），
   *    其余前缀无法校验 ⇒ 按悬空引用拒写。
   *  - `派生自: string|null`——推翻替换链（新条目记被推翻者的 id）。这是 **overturn 的
   *    内部参数**：调用方不传，也不从工具面透传——血缘是「谁推翻谁」的事实，不是自报项。
   *
   * @param {{ subject: object, 类: string, 内容: string, 来源: string|{谁?: string, 怎么知道: string}, 项目?: string, 岗位?: string, 标签?: string[], 标题?: string, 轮?: string, 任务?: object, 来源引用?: string|string[], 派生自?: string }} input
   * @returns {Promise<{ id: string, 类: string, 归属: string, 账本: string, 项目: string|null, 岗位: string|null }>}
   */
  async remember(input) {
    const kind = input.类;
    // 内部通道封口（2026-10-13 审查 P1-11）：`派生自`（推翻替换链）与 `同锁追加`（账本伴随行）
    // 是 overturn 的内部参数——修前 remember 签名照收、零校验，任何调用方传 `派生自` 即可
    // 伪造「谁推翻谁」的血缘事实，传 `同锁追加` 函数可向账本追加任意构造行。
    // 现在凭模块内 Symbol 记号放行 overturn 自己，其余一律响亮拒。
    if ((input.派生自 !== undefined || input.同锁追加 !== undefined) && input[内部通道] !== true) {
      throw new InvalidBody('派生自 / 同锁追加 是记忆服务的内部通道（推翻替换链与伴随落账），不接受外部传入：血缘是「谁推翻谁」的事实，不是自报项。', {
        detail: { 收到的内部键: [input.派生自 !== undefined ? '派生自' : null, input.同锁追加 !== undefined ? '同锁追加' : null].filter(Boolean) },
      });
    }
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

    // 契约A：来源引用在写入前校验存在性——悬空引用当场拒，不留给检索面去猜。
    const 来源引用 = normalizeRefs(input.来源引用);
    if (来源引用.length > 0) await this.#verifyRefs(来源引用);

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
    // 时刻与 id 都挪进锁内算（W3 批1）：锁外算好在多实例同毫秒下会撞 id，两条记忆静默合一。
    const file = this.layout.memoryLog(scope, kind);
    const row = await this.#appendEntry(file, {
      kind,
      seed: `${kind}/${input.subject?.id ?? 'unknown'}`,
      build: (id) => ({
        id,
        类: kind,
        标题: input.标题 ?? text.slice(0, 40),
        内容: text,
        来源,
        // 契约A 血缘字段：旧行没有这两个键照常 fold（向后兼容——normalizeRefs 折 []、
        // 派生自 折 null），新行写明空值也写键，读的人不用猜「缺键是不是丢了」。
        来源引用,
        派生自: typeof input.派生自 === 'string' && input.派生自 ? input.派生自 : null,
        归属: scope,
        项目,
        // 知识：项目标签恒打；岗位标签默认不打（由 Lead 判定「这条跨项目可复用」后追加）。
        岗位: kind === '知识' ? null : (input.岗位 ?? null),
        标签: input.标签 ?? [],
        状态: '有效',
        记于: this.clock.iso(),
        轮: input.轮 ?? null,
      }),
      同锁追加: input.同锁追加, // 内部通道（overturn 双行同锁）；外部调用方不传
    });
    await this.audit.append({
      动作: '状态变更',
      主体: input.subject,
      对象: { id: row.id, kind: '知识' === kind ? '知识' : kind },
      依据: '记忆服务：写入必带谁记的 + 怎么知道的',
      结果: `记入${scope}`,
      项目,
      详情: { 类: kind, 来源: 来源.怎么知道 },
    });
    return { id: row.id, 类: kind, 归属: scope, 账本: file, 项目, 岗位: row.岗位 };
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
    // 被否的知识不许扩散（2026-10-12 评审 P1-7）：修前这里只看「存在 + 类=知识」，
    // 一条已失效/被推翻的知识照样晋升到跨项目面——召回面否掉的东西从侧门出去了。
    // 判据与 query 的默认召回面同源（是否已被否 · 唯一源），口径不许分叉。
    if (是否已被否(entry)) {
      throw new Denied(
        '记忆处置表 · 被否的知识不许晋升（§7：扩散错误知识比不扩散更糟）',
        `条目 ${id} 当前状态「${entry.状态}」且有过否决性追加：已失效/被推翻/被隔离的知识不许打岗位标签扩散到跨项目面。`,
        { howToChange: '若原条目判错了：推翻它、以正确内容另记一条，再晋升新条目；不许给被否条目翻案式晋升。' },
      );
    }
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: memoryTarget('知识', DIR.跨项目, entry.项目),
      context: { id },
    });

    // ── 契约C 披露机械检查：标题 + 内容 + 标签 三个面一起过 ──────────────────
    // 顺序在 policy.check 之后：先由唯一判定点确认「这个主体有权晋升」，
    // 再由这道内容闸拦「这段文本值不值得扩散」。命中拒绝记「披露拦截」审计
    // （骑手① 2026-10-09：拦截企图是安全信号）；豁免放行另记「披露豁免」。
    const 命中 = this.#disclosureHits(entry);
    let 豁免留痕 = null;
    if (命中.length > 0) {
      const 命中模式 = 命中.map((h) => h.名);
      if (spec.披露豁免 === true && spec.subject?.kind !== 'Lead') {
        // 骑手①（契约C 补强 2026-10-09）：披露拦截也入账——「有人试过扩散敏感内容
        // 被拦」是安全信号，不入账的话复核者永远看不到这次企图。只记模式名，不抄原文。
        await this.audit.append({
          动作: '披露拦截',
          主体: spec.subject,
          对象: { id, kind: '知识' },
          依据: '契约C 补强：豁免越权使用（披露豁免仅 Lead）',
          结果: '拒绝',
          项目: entry.项目,
          详情: { 命中模式, 拒绝类型: '豁免越权' },
        });
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
        // 骑手①：同上——命中被拒入账（主体 + 命中模式名，不抄敏感原文）。
        await this.audit.append({
          动作: '披露拦截',
          主体: spec.subject,
          对象: { id, kind: '知识' },
          依据: '契约C 补强：披露机械检查命中，未带豁免',
          结果: '拒绝',
          项目: entry.项目,
          详情: { 命中模式, 拒绝类型: '命中未豁免' },
        });
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
    // fold 派生键不许回落账本（2026-10-12 评审 P1-7）：`历史 / 状态 / 账本出现于` 是 fold 的
    // 读时投影——写进去，跨项目账上就嵌了一份**陈旧的**状态史，mergeEntryRows 会拿它盖真实
    // 累积历史（本项目后续追加的 状态行 不在那份快照里）。
    const { 历史: _派生历史, 状态: _派生状态, 账本出现于: _派生出现于, ...条目原件 } = entry;
    await this.#appendLedger(this.layout.memoryLog(DIR.跨项目, '知识'), [
      {
        ...条目原件,
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
    /** @type {string[]} 本次口径读过的账本（合成签名用；索引缓存按它失效）。 */
    const 账本文件 = [];
    for (const kind of wanted) {
      if (!MEMORY_KINDS.includes(kind)) continue;
      for (const scope of await this.#scopesFor(kind, query.项目)) {
        const file = this.layout.memoryLog(scope, kind);
        账本文件.push(file);
        rows.push(...(await this.#rows(file)));
      }
    }
    const entries = fold(rows).filter((entry) => entry.状态 !== '物理删除');
    const visible = [];
    for (const entry of entries) {
      // 归档作答的可读性矩阵（§7 · 2026-10-13 审查 P1-9 修复）：默认不召回；显式要看时
      // 还必须自报读者身份且在可读名单内——此前第二个 if 依赖 `query.读者` 存在才检查，
      // 「显式:true 但不传读者」会让整道检查静默跳过（fail-open）。
      if (entry.类 === '作答' && entry.归档 === true) {
        if (query.显式 !== true) continue;
        if (!query.读者 || !ANSWER_READERS.includes(query.读者.kind)) continue;
      }
      if (query.项目 && entry.类 === '知识' && entry.项目 && entry.项目 !== query.项目 && entry.归属 !== DIR.跨项目) continue;
      if (query.岗位 && entry.岗位 && entry.岗位 !== query.岗位) continue;
      visible.push(entry);
    }

    // 「当前有效视图」：失效与被推翻的条目**不进召回**，但**仍留在 `条目` 里**供追溯——
    // 调用方要看到「这条存在过、已经被否掉」，而不是让它悄悄消失（§7 追加状态的本意）。
    // 要看它们就显式带 `含失效: true`（历史 / 调查口径）。
    // 判据实现只有一处：`是否已被否`（模块级，晋升闸与它共用同一条粘性判据）。
    const 撤回 = visible.filter(是否已被否);
    const 可召回 = query.含失效 === true ? visible : visible.filter((entry) => !是否已被否(entry));

    // `排除失效` 只报**实际被排除**的条数：带 `含失效: true` 时一条都没排除，
    // 那里还写个 1 就是一句假读数（这个组织里假读数比没读数更贵）。
    // 「一共有几条失效」另用 `失效条目数` 报，两个问题分开答。
    // 契约A：`隔离条目数` 单独报——「被血缘阻断波及」与「自身被判错」是两族原因，
    // 读账的人要能区分「这条被隔离是因为它的源被物理删除了」。
    const 被隔离 = (entry) =>
      entry.状态 === '已隔离' || entry.状态 === '待删除' || (entry.历史 ?? []).some((s) => s.追加 === '隔离' || s.追加 === '待删除');
    const 口径数 = {
      // `条目数` = 账本侧可见条数（含被当前有效视图挡住的失效/隔离条目）；
      // **不要叫 `文档数`**（W3 批2·2026-10-09）：检索面的 `文档数` 是 search 实算的
      // 候选数（= 可召回数），此前这里用同名键把它盖掉，于是 `formatMiss` 报出的
      // 「候选文档数」虚高——读的人以为检索扫了 55 条，实际只扫了 40 条。
      // 两个数答的是两个问题（账本里有多少 / 检索扫了多少），分开报，谁也不覆盖谁。
      条目数: visible.length,
      可召回数: 可召回.length,
      失效条目数: 撤回.filter((e) => !被隔离(e)).length,
      隔离条目数: 撤回.filter(被隔离).length,
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
      // 无文本面也要给「被当前有效视图挡住」的读数与拉回办法——只在检索分支说，
      // 全量浏览的人就会以为「不存在」，而其实是被隔离/失效挡住了（同一句两处用）。
      const 视图说明 = 撤回.length > 0 && query.含失效 !== true
        ? `另有 ${撤回.length} 条已失效/被推翻/待删除/已隔离的条目按「当前有效视图」未进召回${口径数.隔离条目数 > 0 ? `（其中 ${口径数.隔离条目数} 条因源对象物理删除被血缘隔离）` : ''}；要看它们请带 含失效: true。`
        : '';
      const 说明 = [
        ...(条目截断 ? [`条目 共 ${visible.length} 条，超出上限 ${条数上限}，只回传最新 ${条数上限} 条；带 条数上限 可调。`] : []),
        ...(视图说明 ? [视图说明] : []),
        ...(query.显式 === true ? ['已显式包含归档作答。'] : []),
      ].join(' ');
      return {
        命中: [],
        条目,
        条目截断,
        条目总数: visible.length,
        条数上限,
        口径: { 搜索面: '记忆服务', 查询词: '', 范围: wanted.join('/'), ...口径数, 命中数: 0, ...条目口径 },
        ...(说明 ? { 说明 } : {}),
      };
    }
    // 索引缓存（2026-10-13 第四批）：键 = 账本合成签名 + 过滤口径。索引只取决于
    // 「哪些文档进入检索面」，与查询词无关 ⇒ 同一口径下反复检索（看板展开、连续问）
    // 只建一次。5000 行实测：每次重建 351 ms → 命中后只剩一次 search。
    const 索引键 = `${await this.#签名们(账本文件)}|${JSON.stringify([wanted, query.项目 ?? null, query.岗位 ?? null, query.含失效 === true, query.显式 === true, query.读者?.kind ?? null])}`;
    let index = this.#indexCache.get(索引键);
    if (!index) {
      index = buildIndex(可召回.map((entry) => ({ id: entry.id, 正文: entry.内容, 标签: [entry.类, entry.岗位 ?? ''], 来源: entry.归属 })));
      if (this.#indexCache.size >= 索引缓存上限) this.#indexCache.delete(this.#indexCache.keys().next().value);
      this.#indexCache.set(索引键, index);
    }
    const result = search(index, query.文本, { limit: query.limit ?? 10, 范围: `${wanted.join('/')}@${query.项目 ?? '全部项目'}` });
    // 合并顺序与键名都守着「两个数分开报」：检索面的 `文档数`（候选文档数）保留 search 的实算值，
    // 账本侧的可见条数走 `条目数`——同名覆盖会让 `formatMiss` 的「候选文档数」虚高（W3 批2）。
    result.口径 = { ...result.口径, ...口径数 };
    if (result.命中.length === 0) result.说明 = formatMiss(result.口径);
    if (撤回.length > 0 && query.含失效 !== true) {
      // 「0 命中」与「有材料但被当前有效视图挡住」是两件事，不许折成同一句话。
      // 隔离条目单独点名拉回办法（契约A）：被隔离的条目要看也是带 含失效: true。
      const 隔离数 = 口径数.隔离条目数;
      result.说明 = [result.说明, `另有 ${撤回.length} 条已失效/被推翻/待删除/已隔离的条目按「当前有效视图」未进召回${隔离数 > 0 ? `（其中 ${隔离数} 条因源对象物理删除被血缘隔离）` : ''}；要看它们请带 含失效: true。`]
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
   * 契约A · 血缘查询（只读）：这条记忆的上下游（引用关系 + 推翻替换链）。
   *
   * 契约B 同款读面收窄：`subject` 必带过 `policy.check`（action 'read'），
   * 放行记一条「只读服务调用」审计（档位=记汇总，一次调用一条）。
   * 索引是**纯投影**（不变式 #4：可重建、不另立真源）——每次从账本行现算，
   * 传递闭包深度上限 3（`lineageClosure`），环安全（visited 集）。
   *
   * @param {{ subject: object, id: string }} spec
   * @returns {Promise<{ id: string, 上游: Array<{id: string, 深: number, 关系: '引用'|'派生'}>, 下游: Array<{id: string, 深: number, 关系: '引用'|'派生'}>, 深度读数: object }>}
   */
  async lineage(spec) {
    await this.policy.check({
      subject: spec.subject,
      action: 'read',
      target: { id: `记忆/血缘/${spec.id}`, kind: '记忆', authority: '自治', zone: '私有', domain: '集体', project: null },
      context: {},
    });
    await this.audit.append({
      动作: '只读服务调用',
      主体: spec.subject,
      对象: { id: `记忆/血缘/${spec.id}`, kind: '记忆' },
      依据: '契约A（2026-10-09）血缘查询：读面也过唯一判定点',
      结果: '放行',
      详情: { 服务: 'memory.lineage', id: spec.id },
    });
    const entry = await this.#folded(spec.id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${spec.id}`);
    const index = await this.#lineageIndex();
    const closure = lineageClosure(index, spec.id);
    // 「已不存在」标注（2026-10-13 第四批）：物理删除会抹掉源的**条目行**，但下游那行仍写着
    // 「我引用过它」——血缘是历史事实，边照旧列出；可读的人必须看得出这一头已经不在盘上了，
    // 否则一份指向已删除对象的血缘读数就是假读数（§3.6）。
    const 标注 = (list) => list.map((item) => (index.ids.includes(item.id) ? item : { ...item, 已不存在: true }));
    return { id: spec.id, ...closure, 上游: 标注(closure.上游 ?? []), 下游: 标注(closure.下游 ?? []) };
  }

  /**
   * 失效：追加 `invalid` 状态，不改原条目（§7「错误 / 过期」）。
   * @param {string} id
   * @param {{ subject: object, 原因: string, 任务?: object }} spec
   *   `任务`：任务上下文（成员任务内处置自己条目时由动作层从任务图取真节点透传）。
   */
  async invalidate(id, spec) {
    return this.#appendState(id, 'invalid', spec);
  }
  /**
   * 冷：追加降权状态，不删（§7「冷」）。
   * @param {string} id
   * @param {{ subject: object, 原因: string, 任务?: object }} spec
   */
  async demote(id, spec) {
    return this.#appendState(id, '降权', spec);
  }

  /**
   * 被推翻：追加状态并追加新条目，双份留痕（§7「被推翻」）。
   *
   * 契约A：新条目自动写 `派生自 = 被推翻者 id`——推翻替换链由机制记录，
   * 调用方不传（血缘是「谁推翻谁」的事实，不是自报项）。
   *
   * @param {string} id
   * @param {{ subject: object, 新条目: string, 理由: string, 任务?: object }} spec
   */
  async overturn(id, spec) {
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    // 推翻 = 「新条目 + 旧条目状态行」**双行同锁落账**（2026-10-12 评审 P3）：
    // 修前两步分开落，第二步（状态行）失败会留下「替代品在、原条目没标推翻」的
    // 撕裂窗口——旧知识继续被召回，替代它的人却已经入账。
    // write 闸先行（拒了就连新条目都不许落）；remember 的 create 闸照旧在里面。
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: memoryTarget(entry.类, entry.归属, entry.项目),
      context: { id, 状态: '推翻', task: spec.任务 ?? null },
    });
    const created = await this.remember({
      subject: spec.subject,
      类: entry.类,
      内容: spec.新条目,
      来源: { 谁: spec.subject?.id, 怎么知道: `推翻 ${id}：${spec.理由}` },
      项目: entry.项目,
      岗位: entry.岗位 ?? undefined,
      来源引用: entry.来源引用 ?? [],
      派生自: id,
      // 推翻是「追加新条目 + 旧条目入账」双动作：新条目那次 remember 也过策略引擎，
      // 任务上下文必须跟着透传，否则成员任务内推翻会死在内部那次写入上（半动作）。
      任务: spec.任务 ?? null,
      [内部通道]: true,
      同锁追加: (row) => [{
        id: objectId('账目', `${id}:推翻`, { at: this.clock.ms() }),
        指向: id, 追加: '推翻', 追于: this.clock.iso(),
        依据: spec.理由 ?? spec.原因, 主体: spec.subject, 新条目: row.id,
      }],
    });
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id, kind: entry.类 },
      依据: '记忆处置表：不许改写，只能追加',
      结果: '追加状态 推翻',
      项目: entry.项目,
      详情: { 原因: spec.理由 ?? spec.原因, 新条目: created.id },
    });
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
   * 契约A（评审稿 §C8）·阻断语义——purge 三步化，承诺范围升格为「含下游隔离」：
   *  ① 追加 `待删除` 状态行入账；按血缘算**下游闭包**（引用它的 + 派生自它的，传递
   *     ≤3 层、环安全），逐条追加「隔离」状态行（依据写「源对象物理删除·血缘阻断」）；
   *  ② 物理抹源条目（沿用多账本扫描——状态行 id 是 ledger- 前缀，不会被抹）；
   *  ③ 不可逆操作审计记 清理覆盖 + 下游隔离清单；返回值加 `下游隔离`。
   *  隔离 ≠ 删除：下游条目那行字节不动，只是退出默认召回（粘性），`含失效: true` 可拉回。
   *  旧行（无血缘字段）下游闭包为空 ⇒ 行为与旧版完全一致（不回归）。
   *
   * 闸的动作为什么是 'write' 而不是 'delete'：'delete' 是主权者专属（宪章 §3.2），
   * 而敏感数据清除是不能排队等主权者的安全动作；'write' 闸把失联冻结、介入度、
   * 复核者只读这些边界接进来，「仅限敏感数据 / 主权者明确要求」由上面的域内闸收口。
   *
   * @param {string} id
   * @param {{ subject: object, 理由: string, 敏感?: boolean }} spec
   * @returns {Promise<{ id: string, 已删除: true, 依据: string, 清理覆盖: string[], 下游隔离: string[] }>}
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

    // ── ① 血缘阻断：先算下游闭包（此刻源条目还在账上，索引完整），再逐条隔离 ──────
    const 下游 = await this.#downstreamClosure(id);
    const 隔离行 = [];
    for (const child of 下游) {
      const childEntry = await this.#folded(child.id);
      // 闭包算出时在、写时已不在的（并发被删）跳过——它的账本留痕由那次删除自己负责。
      if (!childEntry) continue;
      隔离行.push({
        账本: this.layout.memoryLog(childEntry.归属, childEntry.类),
        行: {
          id: objectId('账目', `${child.id}:隔离`, { at: this.clock.ms() }),
          指向: child.id,
          追加: '隔离',
          追于: this.clock.iso(),
          依据: '源对象物理删除·血缘阻断',
          主体: spec.subject,
        },
      });
    }
    // 源对象自身的「待删除」状态行：物理抹除只抹 条目行（按 id 过滤），状态行留在账上
    // 作为「这里发生过一次物理删除」的只增留痕。
    await this.#appendLedger(this.layout.memoryLog(entry.归属, entry.类), [
      { id: objectId('账目', `${id}:待删除`, { at: this.clock.ms() }), 指向: id, 追加: '待删除', 追于: this.clock.iso(), 依据: spec.理由, 主体: spec.subject },
    ]);
    // 同账本的隔离行合并成一次追加；跨账本逐本追加（#appendLedger 带锁，与下面的重写同一把）。
    const 按账本 = new Map();
    for (const { 账本, 行 } of 隔离行) 按账本.set(账本, [...(按账本.get(账本) ?? []), 行]);
    for (const [账本, 行s] of 按账本) await this.#appendLedger(账本, 行s);
    const 隔离ids = 隔离行.map((x) => x.行.指向);

    // ── ② 物理抹源条目 ─────────────────────────────────────────────────────────
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
        this.#bump(file); // 物理抹除也是写：读缓存失效（第三批）
      });
    }

    // ── ②′ 迟到者补隔离（2026-10-13 审查 P1-13）──────────────────────────────
    // 闭包算完后、抹除前落账的并发 remember 可能引用了本源——它们不在第一批隔离清单里。
    // 「待删除」状态行先于抹除入账 + #verifyRefs 的写侧封口挡住了**之后**的新引用，
    // 但封口生效前已在途/已落账的那几条仍要兜住：抹除后再算一次闭包（血缘索引按
    // 引用字符串建边，源行已抹不影响迟到者的边），把不在第一批清单里的补隔离。
    const 迟到 = (await this.#downstreamClosure(id)).filter((x) => !隔离ids.includes(x.id));
    if (迟到.length > 0) {
      const 迟到行 = [];
      for (const child of 迟到) {
        const childEntry = await this.#folded(child.id);
        if (!childEntry) continue;
        迟到行.push({
          账本: this.layout.memoryLog(childEntry.归属, childEntry.类),
          行: {
            id: objectId('账目', `${child.id}:隔离`, { at: this.clock.ms() }),
            指向: child.id,
            追加: '隔离',
            追于: this.clock.iso(),
            依据: '源对象物理删除·血缘阻断（迟到补扫）',
            主体: spec.subject,
          },
        });
      }
      const 迟到按账本 = new Map();
      for (const { 账本, 行 } of 迟到行) 迟到按账本.set(账本, [...(迟到按账本.get(账本) ?? []), 行]);
      for (const [账本, 行s] of 迟到按账本) await this.#appendLedger(账本, 行s);
      隔离行.push(...迟到行);
    }
    const 全部隔离ids = 隔离行.map((x) => x.行.指向);

    // ── ③ 不可逆操作审计：清理覆盖 + 下游隔离清单 ───────────────────────────────
    await this.audit.append({
      动作: '不可逆操作',
      主体: spec.subject,
      对象: { id, kind: entry.类 },
      依据: 敏感 ? '记忆处置表：敏感数据' : '记忆处置表：主权者明确要求',
      结果: `物理删除（内容已抹掉；覆盖 ${覆盖.length} 本账：${覆盖.map((x) => x.scope).join(' / ')}；下游隔离 ${全部隔离ids.length} 条）`,
      项目: entry.项目,
      详情: { 理由: spec.理由, 类: entry.类, 清理覆盖: 覆盖.map((x) => x.file), 下游隔离: 全部隔离ids },
    });
    return { id, 已删除: true, 依据: spec.理由, 清理覆盖: 覆盖.map((x) => x.scope), 下游隔离: 全部隔离ids };
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
    // 读与追加在**同一把锁内**（设计债⑦：修前锁外读、`#appendLedger` 锁内写——中间窗口里
    // 并发的交卷/结账不会被归档，漏的那条永远没人补）；候选集从 `fold` 出的**当前视图**滤
    // 「未归档」，而不是从原始行滤「不是状态行」（2026-10-12 评审 P1-6：修前 `!isStateRow`
    // 选中的是**全部历史条目行**——已归档的条目行照旧在账上 ⇒ 每次结账都给全体老条目
    // 再追加一轮归档行，账本无限长胖、审计读数「归档 N 条」次次虚高）。
    const 归档行 = await withLock(`${file}.lock`, async () => {
      // 锁内重读真源（fresh）：归档候选集必须建立在锁内看到的行上。
      const rows = await readJsonl(file);
      const open = fold(rows).filter((entry) => entry.归档 !== true);
      if (open.length === 0) return [];
      const lines = open.map((row) => ({ id: objectId('账目', row.id, { at: this.clock.ms() }), 指向: row.id, 追加: '归档', 追于: this.clock.iso(), 依据: spec.任务 ?? '任务结束', 主体: spec.subject }));
      await appendLines(file, lines);
      this.#bump(file); // 读缓存失效（第三批）
      return lines;
    });
    if (归档行.length === 0) return { 归档条数: 0, 账本: file };
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id: spec.任务 ?? spec.项目, kind: '任务' },
      依据: '作答归档后的可读性表（§7）',
      结果: `归档 ${归档行.length} 条作答：成员不可读，默认检索面不再返回`,
      项目: spec.项目,
    });
    return { 归档条数: 归档行.length, 账本: file };
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
   *
   * 计数按**跨账本合并**的 fold 算（W3 批2·2026-10-09，照 `activity()` 的先例）：
   * 晋升过的知识在项目账与跨项目账上各有一行同 id 的条目（§7 双份留痕），
   * 按账分开 fold 会把它数两遍——「存量 100」里有 20 条是同一条记忆的两个副本。
   * 假读数比没读数贵，所以合并一次再数。
   *
   * @param {{ 项目?: string }} [query]
   */
  async stats(query = {}) {
    /** @type {Record<string, number>} */
    const 计数 = {};
    // 坏行可见（2026-10-13 裁决第二批·裁决4）：记忆账本无哈希链，撕裂/手改的坏行此前被
    // readJsonl 静默跳过。最底线=不静默：计数走带体检的读取器，坏行进读数（§3.6）。
    let 坏行 = 0;
    const { readJsonlHealth } = await import('./kernel/fsx.js');
    for (const kind of MEMORY_KINDS) {
      const rows = [];
      for (const scope of await this.#scopesFor(kind, query.项目)) {
        const health = await readJsonlHealth(this.layout.memoryLog(scope, kind));
        rows.push(...health.rows);
        坏行 += health.坏行;
      }
      计数[kind] = fold(rows).filter((e) => e.状态 !== '物理删除').length;
    }
    return { 计数, 合计: Object.values(计数).reduce((a, b) => a + b, 0), ...(坏行 > 0 ? { 坏行, 坏行告警: '账本里有解析失败的行（崩溃撕裂或手改）：坏行不进计数，但必须可见' } : {}) };
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
        const scopeRows = await this.#rows(this.layout.memoryLog(scope, kind));
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
    // 输入面长度上限（2026-10-13 审查 P1-14）：正则执行时间随输入长度放大，
    // 把被检面截到 20k 字符——超长知识先用前 20k 过机械检查（敏感信息极少只藏在两万字之后）。
    const 原面 = [entry?.标题, entry?.内容, ...(Array.isArray(entry?.标签) ? entry.标签 : [])].filter((s) => typeof s === 'string').join('\n');
    const 面数 = 原面.length > 20_000 ? `${原面.slice(0, 20_000)}\n[披露检查：输入已截断，原长 ${原面.length}]` : 原面;
    const 清单 = this.policy.state.defaults?.披露敏感模式 ?? DEFAULT_DISCLOSURE_PATTERNS;
    const 命中 = [];
    for (const { 名, 正则 } of 清单) {
      // 编译缓存（2026-10-13 审查 P1-14）：修前每次晋升对每个模式 new RegExp 一次；
      // 按正则源缓存实例（清单整体覆盖时失效键一起换）。
      let re = 披露正则缓存.get(正则);
      if (re === undefined) {
        try {
          re = new RegExp(正则, 'i');
        } catch {
          throw new Fault('DISCLOSURE_PATTERN_BROKEN', `披露敏感模式[${名}] 在执行期无法编译：${正则}。按 fail-closed 拒绝本次晋升；请修好部署.json 后重载。`, { detail: { 名 } });
        }
        if (披露正则缓存.size > 256) 披露正则缓存.clear();
        披露正则缓存.set(正则, re);
      }
      if (re.test(面数)) 命中.push({ 名 });
    }
    return 命中;
  }

  /**
   * 契约A · 来源引用存在性校验（fail-closed）。
   *
   * 每个前缀的校验面（INTERFACES §2.14 写明）：
   *  - know-/exp-/pref-/answ-：记忆账本 fold 得到；
   *  - task-：任务图事件流里出现过该节点 id；
   *  - artifact-：**本批不校验**（产物库尚无独立账本可查，写了「已校验」就是谎）；
   *  - 其余前缀：无法校验 ⇒ 拒——不能验证的引用等于悬空引用。
   * @param {string[]} refs
   */
  async #verifyRefs(refs) {
    // 一次折叠建 id→条目 索引（2026-10-13 第三批性能收口）：修前对每个引用调一次 #folded，
    // 每次都要扫全部账本 × 全部类 ⇒ O(引用数 × 全库行数)。带引用的写入（remember）在
    // 账本上万行时会明显劣化。这里折叠一遍，引用逐个查表。
    const 条目表 = await this.#foldAll();
    for (const ref of refs) {
      if (ref.startsWith('artifact-')) continue;
      if (ref.startsWith('task-')) {
        if (!(await this.#taskExists(ref))) {
          throw new InvalidBody(`悬空引用：任务图里没有 ${ref}。引用必须指向真实存在的对象（fail-closed）。`, { detail: { 引用: ref, 校验面: '任务图' } });
        }
        continue;
      }
      if (/^(know|exp|pref|answ)-/.test(ref)) {
        const target = 条目表.get(ref);
        if (!target) {
          throw new InvalidBody(`悬空引用：账本里折不到 ${ref}。引用必须指向真实存在的记忆（fail-closed）。`, { detail: { 引用: ref, 校验面: '记忆账本' } });
        }
        // 已被物理删除的源不许再被引用（2026-10-13 审查 P1-13 的写侧封口）：
        // purge 的「待删除」状态粘在账上——闭包算完之后才来的 remember 若还能引用它，
        // 新下游就永远逃过隔离。这里在写入前把这条口子关死。
        if (target.状态 === '待删除' || target.状态 === '物理删除') {
          throw new InvalidBody(`悬空引用：${ref} 已被物理删除（状态 ${target.状态}）。不许往已删除的对象上挂新血缘——那会逃过下游隔离（契约A §C8）。`, { detail: { 引用: ref, 状态: target.状态 } });
        }
        continue;
      }
      throw new InvalidBody(
        `无法校验的引用：${ref}。可校验前缀：know-/exp-/pref-/answ-（记忆账本）、task-（任务图）、artifact-（本批不校验）。`,
        { detail: { 引用: ref } },
      );
    }
  }

  /**
   * 任务节点是否在任务图事件流里出现过（跨全部项目——引用不该被项目墙挡住）。
   * @param {string} taskId
   * @returns {Promise<boolean>}
   */
  async #taskExists(taskId) {
    const { listFiles } = await import('./kernel/fsx.js');
    const root = this.layout.private(DIR.基础设施, DIR.任务图);
    for (const rel of await listFiles(root, { recursive: true, filter: (n) => n.endsWith('tasks.jsonl') })) {
      const rows = await readJsonl(`${root}/${rel}`);
      if (rows.some((row) => row?.id === taskId)) return true;
    }
    return false;
  }

  /**
   * 扫全部记忆账本行，构建血缘索引（纯投影，不落盘——不变式 #4：可重建、不另立真源）。
   * 带签名缓存（2026-10-13 第四批）：`buildLineageIndex` 对全库建边，5000 行实测约 203 ms，
   * 而它是 `lineage` 读面与 purge 闭包的共同入口——每次重建是白付。写路径 bump ⇒ 签名变 ⇒ 重算。
   */
  async #lineageIndex() {
    const files = [];
    for (const kind of MEMORY_KINDS) {
      for (const scope of [DIR.跨项目, ...(await this.#projectScopes())]) {
        files.push(this.layout.memoryLog(scope, kind));
      }
    }
    const 键 = await this.#签名们(files);
    const hit = this.#lineageCache.get(键);
    if (hit) return hit;
    const rows = [];
    for (const file of files) rows.push(...(await this.#rows(file)));
    const index = buildLineageIndex(rows);
    // 只留最近一份：血缘索引随账本整体变化，留旧键没有意义。
    this.#lineageCache.clear();
    this.#lineageCache.set(键, index);
    return index;
  }

  /**
   * 下游闭包（purge 阻断用）：引用它的 + 派生自它的，传递 ≤3 层、环安全。
   * @param {string} id
   * @returns {Promise<Array<{id: string, 深: number, 关系: string}>>}
   */
  async #downstreamClosure(id) {
    return lineageClosure(await this.#lineageIndex(), id).下游;
  }

  /**
   * 严格递增的时刻，只给 id 用。
   *
   * 为什么需要它：id 的种子去掉了正文，只剩「类 + 主体 + 时刻」。
   * 若同一毫秒内、同一主体写两条，哈希输入完全相同 ⇒ **撞 id**，
   * 而 `fold()` 是按 id 归并的，撞 id 会让两条记忆静默合成一条。
   * 所以这里保证「后一次调用拿到的时刻严格大于前一次」。
   *
   * 它只管**本实例内**（`#lastStamp` 是实例字段）：多实例/多进程同毫秒仍会算出同一个
   * 时刻，兜底在 `#appendEntry`——锁内读账本查重，撞了就再 bump 一次重算。
   */
  #nextStamp() {
    const now = this.clock.ms();
    this.#lastStamp = this.#lastStamp !== undefined && now <= this.#lastStamp ? this.#lastStamp + 1 : now;
    return this.#lastStamp;
  }

  /**
   * 账本追加的**唯一入口**（W3 批1·2026-10-09）：所有 `appendLines` 都从 `${file}.lock` 里过。
   *
   * 为什么必须统一：`purge` 的物理抹是「读全文 → 滤掉目标 id → 整文件重写」，
   * 它自己上了锁；而写入面（remember / 状态行 / 隔离行 / 归档行）此前是裸 `appendLines`。
   * 一边加锁一边不加锁，锁就等于不存在：抹除的读-改-写窗口里插进来的追加行，
   * 会被整文件重写**静默盖掉**——「内容已抹掉」的审计与「那条新记忆不见了」同时为真。
   * 锁路径与 `purge` 的 `${file}.lock` 逐字相同（先例：`bus.send` 的线程锁）。
   *
   * @param {string} file 账本文件
   * @param {Array<object|string>} lines
   * @returns {Promise<Array<object|string>>} 实际落线的行
   */
  async #appendLedger(file, lines) {
    const list = Array.isArray(lines) ? lines : [lines];
    if (list.length === 0) return list;
    await withLock(`${file}.lock`, async () => {
      await appendLines(file, list);
    });
    this.#bump(file); // 读缓存失效（第三批）：写后即使 mtime/size 撞车也重读
    return list;
  }

  /**
   * 条目行追加：**在同一把账本锁内**读现有行、算 id、查重、追加（W3 批1·2026-10-09）。
   *
   * 为什么查重必须在锁内：`#nextStamp` 的严格递增只是本实例的保证，
   * 两个实例（同进程两个组件 / 两个进程）同毫秒、同主体、同类会算出**同一个 id**，
   * 而 `fold()` 按 id 归并 ⇒ 两条记忆静默合成一条，谁都看不出来少了一条。
   * 锁内读到「这个 id 已在账上」就 bump 时刻重算，直到算出一个新 id——不静默、不合并。
   *
   * @param {string} file 账本文件
   * @param {{ kind: string, seed: string, build: (id: string) => object, 同锁追加?: (row: object) => object[] }} spec
   *   `同锁追加`（2026-10-12 评审 P3）：与新条目**同一把锁、同一次 appendLines** 落账的
   *   伴随行（如 overturn 的「推翻」状态行）——双行同窗口，不留「新条目在、状态行没落上」
   *   的撕裂态。
   * @returns {Promise<object>} 实际落线的行
   */
  async #appendEntry(file, spec) {
    return withLock(`${file}.lock`, async () => {
      // 锁内必须重读真源（fresh）：id 查重建立在锁内看到的行上，缓存可能落后于别的进程。
      const rows = await readJsonl(file);
      const 已用 = new Set(rows.map((row) => row?.id).filter((id) => typeof id === 'string'));
      let id = objectId(spec.kind, spec.seed, { at: this.#nextStamp() });
      while (已用.has(id)) id = objectId(spec.kind, spec.seed, { at: this.#nextStamp() });
      const row = spec.build(id);
      const 伴随 = typeof spec.同锁追加 === 'function' ? spec.同锁追加(row) : [];
      await appendLines(file, [row, ...伴随]);
      this.#bump(file); // 读缓存失效（第三批）
      return row;
    });
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
        const rows = await this.#rows(this.layout.memoryLog(scope, kind));
        const hit = fold(rows).find((entry) => entry.id === id);
        if (hit) return hit;
      }
    }
    return null;
  }

  /**
   * 全部账本折叠成 id→条目 表（2026-10-13 第三批性能收口）：跨账本合并的**单次**折叠，
   * 供 #verifyRefs 一次建表多次查（修前每个引用各扫全库一遍）。
   * 注意这是「合并视图」：晋升副本与项目原件折成一条——与 `query`/`stats` 的口径一致。
   * @returns {Promise<Map<string, object>>}
   */
  async #foldAll() {
    const rows = [];
    for (const kind of MEMORY_KINDS) {
      for (const scope of await this.#scopesFor(kind, undefined)) {
        rows.push(...(await this.#rows(this.layout.memoryLog(scope, kind))));
      }
    }
    return new Map(fold(rows).map((entry) => [entry.id, entry]));
  }

  /**
   * @param {string} id
   * @param {string} 状态
   * @param {{ subject: object, 原因?: string, 任务?: object }} spec
   * @param {object} [extra]
   */
  async #appendState(id, 状态, spec, extra = {}) {
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    await this.policy.check({
      subject: spec.subject,
      action: 'write',
      target: memoryTarget(entry.类, entry.归属, entry.项目),
      context: { id, 状态, task: spec.任务 ?? null },
    });
    await this.#appendLedger(this.layout.memoryLog(entry.归属, entry.类), [
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
    // 契约A 两态（评审稿 §C8 阻断语义）：「隔离」＝源对象被物理删除、血缘阻断波及本条；
    // 「待删除」＝本条正是被物理删除的源（状态行留在账上，条目行已被抹）。
    // 两者都退出默认召回（判据粘性同 已失效）。
    else if (state.追加 === '隔离') entry.状态 = '已隔离';
    else if (state.追加 === '待删除') entry.状态 = '待删除';
  }
  return [...entries.values()];
}

/**
 * 同 id 的两份条目行合成一份（E1）。带岗位标签的那份（晋升副本）优先，
 * 它缺的键从另一份补——两份正文本来就该一致，差异只在 归属/岗位/跨项目判定。
 * 契约A：来源引用 / 派生自 随 spread 自然继承（晋升副本的血缘与原件是同一份事实）。
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
 * 契约A · 把 来源引用 入参折成 string[]（接受单个串或数组；旧行无此字段折 []）。
 * @param {string|string[]|null|undefined} value
 * @returns {string[]}
 */
function normalizeRefs(value) {
  if (value === null || value === undefined) return [];
  const list = Array.isArray(value) ? value : [value];
  return list.map((v) => String(v).trim()).filter(Boolean);
}

/**
 * 契约A · 血缘索引（纯函数，不变式 #4：可重建、不另立真源）。
 *
 * 扫账本行（经 `fold` 折成当前视图后）出双向关系：
 *  - `引用`: id → 它的 来源引用 列表（上游边，指向被引对象）；
 *  - `被引用`: id → 引用它的条目列表（下游边）；
 *  - `派生自`: id → 它推翻替换的对象（上游边）；
 *  - `派生下家`: id → 派生自它的条目（下游边）。
 * 只建索引不做闭包——闭包遍历在 `lineageClosure`，两者分开是为了让「建图」
 * 这一纯投影可独立测试（环安全/深度上限是遍历的职责，不是建图的）。
 *
 * @param {object[]} rows 账本原始行（条目行 + 状态行混排）
 * @returns {{ 引用: Map<string,string[]>, 被引用: Map<string,string[]>, 派生自: Map<string,string|null>, 派生下家: Map<string,string[]>, ids: string[] }}
 */
export function buildLineageIndex(rows) {
  /** @type {Map<string, string[]>} */
  const 引用 = new Map();
  /** @type {Map<string, string[]>} */
  const 被引用 = new Map();
  /** @type {Map<string, string|null>} */
  const 派生自 = new Map();
  /** @type {Map<string, string[]>} */
  const 派生下家 = new Map();
  for (const entry of fold(rows)) {
    const refs = Array.isArray(entry.来源引用) ? entry.来源引用.filter((r) => typeof r === 'string' && r) : [];
    引用.set(entry.id, refs);
    for (const ref of refs) 被引用.set(ref, [...(被引用.get(ref) ?? []), entry.id]);
    const parent = typeof entry.派生自 === 'string' && entry.派生自 ? entry.派生自 : null;
    派生自.set(entry.id, parent);
    if (parent) 派生下家.set(parent, [...(派生下家.get(parent) ?? []), entry.id]);
  }
  return { 引用, 被引用, 派生自, 派生下家, ids: [...引用.keys()] };
}

/** 血缘闭包的传递深度上限（契约A）：过深的链在此截断并在深度读数里如实标注。 */
export const LINEAGE_MAX_DEPTH = 3;

/**
 * 契约A · 从 `start` 出发的双向闭包（BFS，最短深度；visited 集环安全）。
 *
 * 上游边 ＝ 它引用的（来源引用）＋ 它派生自的；下游边 ＝ 引用它的 ＋ 派生自它的。
 * `深度读数` 如实报两侧最深层与是否截断——「图还有更多没走」不许伪装成「图就这么大」。
 *
 * @param {ReturnType<typeof buildLineageIndex>} index
 * @param {string} start
 * @param {{ maxDepth?: number }} [options]
 * @returns {{ 上游: Array<{id: string, 深: number, 关系: '引用'|'派生'}>, 下游: Array<{id: string, 深: number, 关系: '引用'|'派生'}>, 深度读数: { 深度上限: number, 上游最深层: number, 下游最深层: number, 上游截断: boolean, 下游截断: boolean, 走过节点数: number } }}
 */
export function lineageClosure(index, start, options = {}) {
  const maxDepth = Number.isFinite(options.maxDepth) && options.maxDepth > 0 ? Math.floor(options.maxDepth) : LINEAGE_MAX_DEPTH;
  /** @param {string} id @returns {Array<[string, '引用'|'派生']>} */
  const 上游邻居 = (id) => [
    ...(index.引用.get(id) ?? []).map((x) => /** @type {['引用']} */ ([x, '引用'])),
    ...(index.派生自.get(id) ? [[index.派生自.get(id), '派生']] : []),
  ];
  /** @param {string} id @returns {Array<[string, '引用'|'派生']>} */
  const 下游邻居 = (id) => [
    ...(index.被引用.get(id) ?? []).map((x) => ([x, '引用'])),
    ...(index.派生下家.get(id) ?? []).map((x) => ([x, '派生'])),
  ];
  /**
   * @param {(id: string) => Array<[string, '引用'|'派生']>} neighborsOf
   * @returns {{ nodes: Array<{id: string, 深: number, 关系: '引用'|'派生'}>, 截断: boolean }}
   */
  const walk = (neighborsOf) => {
    const visited = new Set([start]);
    const nodes = [];
    let frontier = [start];
    let 截断 = false;
    for (let depth = 1; depth <= maxDepth; depth += 1) {
      const next = [];
      for (const cur of frontier) {
        for (const [nbr, 关系] of neighborsOf(cur)) {
          // 环安全：进过的不重进——环形账本在这里退化为「已见过的边不重复走」。
          if (visited.has(nbr)) continue;
          visited.add(nbr);
          nodes.push({ id: nbr, 深: depth, 关系 });
          next.push(nbr);
        }
      }
      if (next.length === 0) break;
      if (depth === maxDepth) {
        // 最后一层还有没访问过的邻居 ⇒ 图比深度上限大，如实报截断。
        截断 = next.some((cur) => neighborsOf(cur).some(([nbr]) => !visited.has(nbr)));
      }
      frontier = next;
    }
    return { nodes, 截断 };
  };
  const 上游 = walk(上游邻居);
  const 下游 = walk(下游邻居);
  return {
    上游: 上游.nodes,
    下游: 下游.nodes,
    深度读数: {
      深度上限: maxDepth,
      上游最深层: 上游.nodes.reduce((m, n) => Math.max(m, n.深), 0),
      下游最深层: 下游.nodes.reduce((m, n) => Math.max(m, n.深), 0),
      上游截断: 上游.截断,
      下游截断: 下游.截断,
      走过节点数: 上游.nodes.length + 下游.nodes.length,
    },
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
