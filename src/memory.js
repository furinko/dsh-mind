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
import { appendLines, exists, listDirs, readJsonl, readJsonlHealth, readTextOrNull, atomicWrite, withLock } from './kernel/fsx.js';
import { readTaskLedger, parseTaskLedger } from './task-ledger.js';
import { stat } from 'node:fs/promises';
import { InvalidBody, Denied, Fault } from './kernel/errors.js';
import { objectId } from './kernel/ids.js';
import { digest, canonical } from './kernel/text.js';
import { buildIndex, formatMiss, search } from './retrieval.js';
import { memoryResponseOptions, memoryResponsePage, finalizeMemoryResponse } from './memory-response.js';
import { normalizeKnowledgeContext, knowledgeReviewStatus, knowledgeReviewProjection, KNOWLEDGE_CONTEXT_LIST_FIELDS } from './knowledge-applicability.js';
import { normalizeFeedbackReference, resolveKnowledgeFeedback, validateFeedbackDispositionObservation } from './knowledge-feedback.js';
import { DIR, MEMORY_KINDS } from './paths.js';
import { 记忆条目在读域, 取复核读域 } from './review-scope.js';
// 「已被合法采纳」的唯一判据住在任务图（补修K 字段合同），晋升面直接复用、不另抄状态判断。
// 任务图的 fold 是纯函数、tasks.js 不反向依赖记忆服务 ⇒ 无环；import 真加载（不是形状桩）。
import { fold as foldTaskEvents, 已被合法采纳 } from './tasks.js';

/** 归档后可读的角色（§7 表）。 */
// v2（2026-10-18）：复核者退出主体类，复核员岗实例按 roleId 放行（两处消费点各自判）。
const ANSWER_READERS = ['主权者', 'Lead'];

/** 检索和来源观察共用基本可见性；岗位只是可选过滤，不额外授予或声称岗位隔离。 */
function memoryEntryVisible(entry, query) {
  if (entry.状态 === '物理删除') return false;
  if (entry.类 === '作答' && entry.归档 === true) {
    if (query.显式 !== true) return false;
    if (!query.读者 || !(ANSWER_READERS.includes(query.读者.kind) || query.读者.roleId === '复核员')) return false;
  }
  if (query.项目 && entry.类 === '知识' && entry.项目 && entry.项目 !== query.项目 && entry.归属 !== DIR.跨项目) return false;
  return !(query.岗位 && entry.岗位 && entry.岗位 !== query.岗位);
}

/**
 * remember 内部通道记号（2026-10-13 审查 P1-11）：`派生自` / `同锁追加` 只许 overturn
 * 这一内部调用路径携带（以本模块的 Symbol 键标记）。JSON 入参不可能长出 Symbol 键，
 * 工具面/命令面/路由面拼的参数天然过不了这道检查。
 */
const 内部通道 = Symbol('dsh-mind-memory-internal');
const 反馈提交点 = Symbol('dsh-mind-feedback-commit-guard');

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
  #feedbackPlans = new WeakMap();
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
   * @param {{ layout: import('./paths.js').Layout, policy: import('./policy.js').PolicyEngine, audit: import('./audit.js').AuditLog, clock: import('./kernel/time.js').Clock, registry?: object, tasks?: object }} spec
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.policy = spec.policy;
    this.audit = spec.audit;
    this.clock = spec.clock;
    this.registry = spec.registry ?? null;
    this.tasks = spec.tasks ?? null;
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
   * 账本行 + 体检读数（带读缓存）：签名 = 盘上 mtime+size + 本进程对该文件的写次数。
   * `#rows` 的底层实现——缓存条目在 rows 之外**同时保留每文件的坏行计数**
   * （P3-a · 设计评审 2026-10-15）：stats 的「坏行可见」裁决（2026-10-13 第二批 P2-5：
   * stats 要报坏行数、坏行>0 告警）不许因为走缓存而丢——坏行数与 rows 同源同失效。
   * @param {string} file
   * @returns {Promise<{签名: string, rows: object[], 坏行: number}>}
   */
  async #rowsHealth(file) {
    const 签名 = await this.#签名(file);
    const hit = this.#rowsCache.get(file);
    if (hit?.签名 === 签名) return hit;
    // 坏行要出声（2026-10-14 审查 P2）：修前走 readJsonl 静默跳坏行——记忆召回的
    // 坏行没有审计链自检兜底（那是审计链的机制），「召回少了几条」会静默发生。
    // 读面不中断（坏行不等于整本账作废），但必须留告警痕迹（stats 面同口径报得出）。
    const health = await readJsonlHealth(file);
    if (health.坏行 > 0) {
      console.warn(`[dsh-mind] 记忆账本 ${file} 有 ${health.坏行} 行解析失败（已跳过，不中断读面）；可用 mind status 的账本体检复核。`);
    }
    const entry = { 签名, rows: health.rows, 坏行: health.坏行 };
    this.#rowsCache.set(file, entry);
    return entry;
  }

  /**
   * 账本行（带读缓存）：`#rowsHealth` 的 rows 投影，既有调用方（query/血缘/folded）不变。
   * @param {string} file
   * @returns {Promise<object[]>}
   */
  async #rows(file) {
    return (await this.#rowsHealth(file)).rows;
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
    const 知识说明 = normalizeKnowledgeContext(input.知识说明);
    if (知识说明 !== undefined && kind !== '知识') throw new InvalidBody('知识说明仅属于知识类，不能附在经历、偏好或作答上。');
    input = { ...input, ...(知识说明 === undefined ? {} : { 知识说明 }) };
    // 内部通道封口（2026-10-13 审查 P1-11）：`派生自`（推翻替换链）与 `同锁追加`（账本伴随行）
    // 是 overturn 的内部参数——修前 remember 签名照收、零校验，任何调用方传 `派生自` 即可
    // 伪造「谁推翻谁」的血缘事实，传 `同锁追加` 函数可向账本追加任意构造行。
    // 现在凭模块内 Symbol 记号放行 overturn 自己，其余一律响亮拒。
    if ((input.派生自 !== undefined || input.同锁追加 !== undefined || input.幂等键 !== undefined) && input[内部通道] !== true) {
      throw new InvalidBody('派生自 / 同锁追加 / 幂等键 是记忆服务的内部通道（推翻替换链、伴随落账与受限晋升去重），不接受外部传入：血缘与「这次晋升是否已产过」都是机制事实，不是自报项。', {
        detail: { 收到的内部键: [input.派生自 !== undefined ? '派生自' : null, input.同锁追加 !== undefined ? '同锁追加' : null, input.幂等键 !== undefined ? '幂等键' : null].filter(Boolean) },
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
    const 通用 = 项目 === '通用';
    if (kind === '知识' && !项目) {
      throw new InvalidBody('知识必须恒打项目标签：它产生于某个项目。项目无关的知识显式传 项目=「通用」（v2 条目22 的通用命名空间）。');
    }
    if (kind === '作答' && !项目) {
      throw new InvalidBody('作答必须有项目归属：它是某个项目里的一次作答。');
    }

    // 契约A：来源引用在写入前校验存在性——悬空引用当场拒，不留给检索面去猜。
    const 来源引用 = normalizeRefs(input.来源引用);
    if (来源引用.length > 0) await this.#verifyRefs(来源引用);

    // v2 条目22：「通用」命名空间 = 项目无关知识的合法住所，落在跨项目账（与经历/偏好
    // 同一本账），省掉晋升仪式、不省检查——写入闸与知识同款：披露机械检查照跑、入审计。
    const scope = kind === '经历' || kind === '偏好' || 通用 ? DIR.跨项目 : 项目;
    const target = memoryTarget(kind, scope, 通用 ? '通用' : 项目);
    // 顺序有意（v2 条目15/16 · 补修E）：先让策略引擎按岗位名说结构性边界——复核员岗
    // 「只读数，不改」必须先于服务层「成员不得写知识」说话，拒绝理由才归到正确的规则上；
    // 走完这一道，服务层再拦「成员直写知识」（记忆整理也只能走 promoteFromAdopted）。
    await this.policy.check({
      subject: input.subject,
      action: 'create',
      target,
      // 介入度写入身份（v2 条目14/17 · 补修F）：同一账本目标的多次真实写（如一次结账的
      // 多条知识晋升）必须靠稳定标签区分；幂等键天然唯一，且同一次业务写的锁外/锁内
      // 复判会用同一个键。没有幂等键的普通写入不需要标签（各自有独立的目标语义）。
      context: { task: input.任务 ?? null, 类: kind, ...(input.幂等键 ? { 介入写: `知识:${input.幂等键}` } : {}) },
    });
    // v2（口述收敛 2026-10-18 条目15/16 · 补修E）：知识 = 晋升动作。
    // 成员实例**没有**直写知识的通道——受限晋升的唯一入口是 promoteFromAdopted
    // （已采纳来源 + 双标签 + 真实绑定执行中任务，见那里）；这里再拦一次绕道直写，
    // 保证「服务层直调」也过同一道闸（复核员已在上面的策略闸被拒，不靠这里的豁免）。
    if (kind === '知识' && input.subject?.kind === '成员' && input[内部通道] !== true) {
      throw new Denied('v2 · 知识是晋升动作（条目15）', '成员实例不得直接写「知识」类记忆：普通成员只提交知识候选；记忆整理岗也只能按「已采纳来源」执行受限晋升（promoteFromAdopted），不能自由落笔。', {
        requireAuthority: 'Lead',
        howToChange: '普通成员：把内容写成本任务的「经历」并在交卷附知识候选，由 Lead 在结账的记忆处置里逐条判。记忆整理岗：走受限晋升（来源=同项目已采纳任务），见 promoteFromAdopted。',
      });
    }
    if (通用) {
      // 通用直写 = 生下来就在跨项目面：披露闸与跨项目晋升同一把尺（同一私有方法）。
      // 写入被拒时条目尚无 id，审计对象用占位名（拒的是企图，条目没出生）。
      await this.#披露闸({ id: '知识/通用（写入前）', 项目: '通用', 标题: input.标题 ?? text.slice(0, 40), 内容: text, 标签: input.标签 ?? [], ...(知识说明 === undefined ? {} : { 知识说明 }) }, { subject: input.subject, 披露豁免: input.披露豁免 }, '通用直写');
    }

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
        // v2 条目22：跨项目写（Lead 写别的项目/通用）的「合理」落在依据上——事后可判。
        依据: typeof input.依据 === 'string' && input.依据.trim() ? input.依据.trim() : null,
        归属: scope,
        项目,
        // v2 条目15：知识 = 岗位 + 项目双标签——岗位在写入时就能打（受限晋升必填，
        // 让适用岗位真的可召回）；旧口径「默认不打、晋升时追加」只对跨项目晋升副本生效。
        岗位: input.岗位 ?? null,
        // v2 条目16（补修E）：受限晋升的幂等键随条目留痕，重试时据此认回同一条产物。
        ...(typeof input.幂等键 === 'string' && input.幂等键 ? { 幂等键: input.幂等键 } : {}),
        标签: input.标签 ?? [],
        ...(知识说明 === undefined ? {} : { 知识说明 }),
        状态: '有效',
        记于: this.clock.iso(),
        轮: input.轮 ?? null,
      }),
      同锁追加: input.同锁追加, // 内部通道（overturn 双行同锁）；外部调用方不传
      // v2 条目16（补修E）：权限晋升的幂等闸——同一幂等键只产一条知识；业务参数
      // （岗位/内容/标题）变了则拒，不许拿旧产物冒充本次内容。
      ...(typeof input.幂等键 === 'string' && input.幂等键 ? { 幂等键: input.幂等键, 幂等比对: { 岗位: input.岗位 ?? null, 内容: text, 标题: input.标题 ?? text.slice(0, 40), 知识说明 } } : {}),
      // R10（审查 2026-10-16 · 提交点 fence）：带引用的写在最终落线点复验引用——锁外
      // 那次校验与本次提交之间完成的 purge（状态行已入账、源行已抹）在这里必被 fold
      // 视图看见：悬空/待删除引用 ⇒ 本条不落线。审查实证的并发窗口就此关闭。
      ...(来源引用.length > 0 || input[反馈提交点] ? { 提交点检查: async () => { if (来源引用.length > 0) await this.#verifyRefs(来源引用); if (input[反馈提交点]) await input[反馈提交点](); } } : {}),
    });
    await this.audit.append({
      动作: '状态变更',
      主体: input.subject,
      对象: { id: row.id, kind: '知识' === kind ? '知识' : kind },
      依据: '记忆服务：写入必带谁记的 + 怎么知道的',
      结果: row.幂等命中 ? '幂等命中（未重复落行）' : `记入${scope}`,
      项目: 通用 ? '通用' : 项目,
      详情: { 类: kind, 来源: 来源.怎么知道, ...(input.依据 ? { 依据: input.依据 } : {}), ...(input.幂等键 ? { 幂等键: input.幂等键 } : {}) },
    });
    return { id: row.id, 类: kind, 归属: scope, 账本: file, 项目, 岗位: row.岗位, ...(row.幂等命中 ? { 幂等命中: true } : {}) };
  }

  /**
   * 契约C 披露机械检查闸（单源）：跨项目晋升（promoteCrossProject）与「通用」直写
   * （remember 的 项目=「通用」，v2 条目22）共用同一套语义——
   * 命中敏感模式 / 超长未全检 ⇒ Denied + 「披露拦截」入账（只记模式名，不抄原文）；
   * 披露豁免是 Lead 专属参数（越权使用同样拦并入账）；Lead 显式豁免 ⇒ 放行但留痕。
   * R11（审查 2026-10-16）：截断即 fail-closed——未检查的尾部不得视为通过。
   *
   * @param {{ id: string, 项目: string|null, 标题?: string, 内容?: string, 标签?: string[] }} entry 被检对象（写入前场景给占位 id）
   * @param {{ subject: object, 披露豁免?: boolean }} spec
   * @param {string} 场景 文案锚（如 '跨项目晋升' / '通用直写'）
   * @returns {Promise<{命中模式: string[], 已截断: boolean}|null>} 豁免放行时的留痕；未触发豁免为 null
   */
  async #披露闸(entry, spec, 场景) {
    const { 命中, 已截断 } = this.#disclosureHits(entry);
    if (命中.length === 0 && !已截断) return null;
    const 命中模式 = 命中.map((h) => h.名);
    if (spec.披露豁免 === true && spec.subject?.kind !== 'Lead') {
      // 骑手①（契约C 补强 2026-10-09）：披露拦截也入账——「有人试过扩散敏感内容
      // 被拦」是安全信号，不入账的话复核者永远看不到这次企图。只记模式名，不抄原文。
      await this.audit.append({
        动作: '披露拦截',
        主体: spec.subject,
        对象: { id: entry.id, kind: '知识' },
        依据: '契约C 补强：豁免越权使用（披露豁免仅 Lead）',
        结果: '拒绝',
        项目: entry.项目,
        详情: { 命中模式, 已截断, 拒绝类型: '豁免越权', 场景 },
      });
      throw new Denied(
        '法律 披露豁免仅 Lead（契约C 2026-10-09）',
        `披露豁免是 Lead 专属参数：${spec.subject?.kind ?? '未知'} 不得使用。命中模式：${命中模式.join('、')}${已截断 ? '；且输入超长未全检' : ''}。`,
        {
          requireAuthority: 'Lead',
          howToChange: '由 Lead 核实该条知识确属可披露后，以 Lead 身份带 披露豁免=true 执行。',
          detail: { 命中模式, 已截断 },
        },
      );
    }
    if (spec.披露豁免 !== true && 已截断) {
      await this.audit.append({
        动作: '披露拦截',
        主体: spec.subject,
        对象: { id: entry.id, kind: '知识' },
        依据: '契约C：超长输入未全检（fail-closed）',
        结果: '拒绝',
        项目: entry.项目,
        详情: { 拒绝类型: '超长未全检', 检查上限: 20_000, 场景 },
      });
      throw new Denied(
        '法律 知识披露机械检查 · 超长输入未全检（fail-closed）',
        `该条知识的被检面超过机械检查上限（20,000 字符）：检查只覆盖前缀，而扩散复制全文——未检查的尾部不得视为通过。`,
        {
          requireAuthority: 'Lead',
          howToChange: '两条路：① 改写/拆分条目到上限内再试；② Lead 通读全文核实确属可披露后带 披露豁免=true 重试（豁免与「超长」事实一起进审计）。',
          detail: { 检查上限: 20_000 },
        },
      );
    }
    if (spec.披露豁免 !== true && 命中.length > 0) {
      // 骑手①：同上——命中被拒入账（主体 + 命中模式名，不抄敏感原文）。
      await this.audit.append({
        动作: '披露拦截',
        主体: spec.subject,
        对象: { id: entry.id, kind: '知识' },
        依据: '契约C 补强：披露机械检查命中，未带豁免',
        结果: '拒绝',
        项目: entry.项目,
        详情: { 命中模式, 拒绝类型: '命中未豁免', 场景 },
      });
      throw new Denied(
        '法律 知识披露机械检查（契约C 2026-10-09）',
        `该条知识的标题/内容/标签命中敏感模式：${命中模式.join('、')}。${场景}会把这条知识扩散到产生它的项目之外。`,
        {
          requireAuthority: 'Lead',
          howToChange: '两条路：① 先改写条目去掉敏感内容（或让产生它的项目继续私有持有）再试；② Lead 核实确属可披露后带 披露豁免=true 重试——豁免与命中模式会一起进审计。',
          detail: { 命中模式 },
        },
      );
    }
    // Lead 显式豁免：放行，但「越过披露闸」这件事必须与命中模式一起留痕（调用方入账）。
    return { 命中模式, 已截断 };
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
   * 闸本体在 #披露闸（跨项目晋升与「通用」直写共用）。
   *
   * @param {string} id
   * @param {{ subject: object, 岗位: string, 理由: string, 披露豁免?: boolean }} spec
   * @returns {Promise<{ id: string, 岗位: string }>}
   */
  async promoteCrossProject(id, spec) {
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    if (entry.类 !== '知识') throw new InvalidBody('只有知识可以打岗位标签；经历/偏好/作答不跨项目。');
    if (Object.hasOwn(entry, '知识说明') && normalizeKnowledgeContext(entry.知识说明) === undefined) throw new InvalidBody('已存知识说明不可判，不能当作未设说明扩散。');
    // P2（全面审查 2026-10-17）：岗位标签是跨项目知识的「对谁可复用」边界，不能为空。
    // 修前动作层/schema 都允许省略岗位 ⇒ 副本无标签，其他项目默认召回直接命中。
    const 岗位 = typeof spec.岗位 === 'string' ? spec.岗位.trim() : '';
    if (!岗位) {
      throw new InvalidBody('跨项目晋升必须带「岗位」：没有岗位标签的知识会扩散到所有项目的默认召回面。', { missing: ['岗位'] });
    }
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

    // 幂等闸（2026-10-14 审查 P1-8）：同 id 只能晋升一次。修前二次晋升（换岗位）照样
    // 往跨项目账追一条副本行，而 mergeEntryRows 在两行都带岗位时保留先读到的那份——
    // 第二次晋升静默无效，审计却照记「追加岗位标签 B」：审计与账本脱节 = 假留痕。
    // v2 条目15（补修E）：项目内知识生下来就可能带岗位双标签，所以判据不能再看
    // `entry.岗位`（那会把所有新知识误判成「已晋升」），改看跨项目账上是否已有同 id 副本。
    const 跨项目副本 = (await this.#rows(this.layout.memoryLog(DIR.跨项目, '知识')))
      .some((row) => row?.id === id && !isStateRow(row));
    if (跨项目副本) {
      throw new Denied(
        '记忆处置表 · 不许重复晋升（幂等闸）',
        `条目 ${id} 在跨项目账上已有副本：同一条知识只能晋升到跨项目面一次。重复晋升会在账上落一条永远不生效的副本行，而审计照记——账本与审计脱节。`,
        { howToChange: '要换岗位标签：先推翻/失效跨项目副本再以新条目晋升；要扩散的是内容本身，就新开一条带正确岗位的条目。' },
      );
    }

    // ── 契约C 披露机械检查：标题 + 内容 + 标签 三个面一起过 ──────────────────
    // 顺序在 policy.check 之后：先由唯一判定点确认「这个主体有权晋升」，
    // 再由这道内容闸拦「这段文本值不值得扩散」。闸本体抽为 #披露闸（单源：
    // 跨项目晋升与「通用」直写共用同一套命中/截断/豁免语义）。
    const 豁免留痕 = await this.#披露闸(entry, spec, '跨项目晋升');

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
        岗位,
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
        结果: `豁免放行（${豁免留痕.已截断 ? '超长未全检' : ''}${豁免留痕.命中模式.length ? `命中 ${豁免留痕.命中模式.join('、')}` : '无命中'}）`,
        项目: entry.项目,
        详情: { 命中模式: 豁免留痕.命中模式, 已截断: 豁免留痕.已截断, 岗位, 理由: spec.理由 },
      });
    }
    await this.audit.append({
      动作: '状态变更',
      主体: spec.subject,
      对象: { id, kind: '知识' },
      依据: '知识标签写入规则：Lead 判定跨项目可复用后追加岗位标签（v2 条目15：项目内知识也可在晋升时带岗位标签）',
      结果: `追加岗位标签 ${岗位}`,
      项目: entry.项目,
      详情: { 理由: spec.理由 },
    });
    return { id, 岗位 };
  }

  /**
   * 受限晋升（v2 口述收敛 2026-10-18 条目15/16 · 补修E）：把「已采纳来源」蒸馏成真实知识条目。
   *
   * 为什么要有这个方法：`task_settle` 的「晋升」处置此前只把字符串记进结账事件——账上写着
   * 晋升、知识库里却没有产物（假结账）。现在结账的每一条「晋升」、以及记忆整理岗的受限晋升，
   * 都走这一个写入口：**真实落条目 + 可回溯来源引用 + 审计**。
   *
   * 五道条件（缺一即拒，全部在落笔之前判）：
   *  ① 主体：Lead / 主权者 / **真实登记在岗的**记忆整理岗实例（自报 roleId 不算——查身份档案）；
   *  ② 来源：`晋升.来源任务` 必须真实存在且「已被合法采纳」（唯一判据复用 tasks.js，
   *     不在这里另抄状态字符串判断）；
   *  ③ 同项目：来源任务项目 = 本次执行项目；知识存储项目 =「通用」时是**公共命名空间**，
   *     不是另一个真实项目（执行项目与存储命名空间分开表达，不给成员跨项目开侧门）；
   *  ④ 双标签：岗位（适用岗位）+ 项目；岗位为空的知识会扩散到所有岗位的召回面；
   *  ⑤ 成员路径：必须带「执行任务」= 绑着本实例、处于「执行中」的自身任务（任务内全权）。
   *
   * 幂等（v2 条目16）：幂等键 = `来源项目|来源任务|候选键`。跨项目账/通用账会聚多个项目，
   * 光靠任务 id + 候选键会串成果，所以来源项目必须进键。同键重试返回旧条目、不重复产知识；
   * 但业务参数（岗位/内容/标题）变了就拒——旧产物不许冒充本次内容。
   *
   * @param {{ subject: object, 项目: string, 岗位: string, 内容: string, 标题?: string, 来源?: string|object,
   *           来源引用?: string|string[], 依据?: string, 标签?: string[], 任务?: object|null,
   *           晋升: { 来源任务: string, 候选键: string, 执行任务?: string } }} spec
   * @returns {Promise<{ id: string, 项目: string, 岗位: string, 来源任务: string, 幂等键: string, 幂等命中: boolean }>}
   */
  async promoteFromAdopted(spec = {}) {
    const 知识说明 = normalizeKnowledgeContext(spec.知识说明);
    spec = { ...spec, ...(知识说明 === undefined ? {} : { 知识说明 }) };
    const subject = spec.subject;
    const 项目 = String(spec.项目 ?? '').trim();
    const 岗位 = typeof spec.岗位 === 'string' ? spec.岗位.trim() : '';
    const 内容 = String(spec.内容 ?? '').trim();
    const 晋升 = spec.晋升 ?? {};
    const 来源任务 = String(晋升.来源任务 ?? '').trim();
    const 候选键 = String(晋升.候选键 ?? '').trim();
    const 执行任务 = String(晋升.执行任务 ?? '').trim();

    if (!['Lead', '主权者', '成员'].includes(subject?.kind)) {
      throw new Denied('v2 条目15 · 受限晋升只给 Lead / 主权者 / 记忆整理岗', `${subject?.kind ?? '未知'} 不能晋升知识：未验收的产出不进组织知识。`, {
        requireAuthority: 'Lead',
        howToChange: '普通成员只提交知识候选；由 Lead 在结账记忆处置里晋升，或由真实登记的记忆整理岗按已采纳来源蒸馏。',
      });
    }
    if (subject.kind === '成员') {
      const 档案 = this.#档案成员(subject.id);
      if (!档案 || 档案.status !== '在岗' || 档案.岗位 !== '记忆整理') {
        throw new Denied('v2 条目15 · 受限晋升仅限真实登记的记忆整理岗', `实例 ${subject.id} 的档案${档案 ? `岗位为「${档案.岗位 ?? '缺失'}」、状态「${档案.status ?? '缺失'}」` : '里没有登记'}：记忆整理是普通成员岗，但自报岗位不算——晋升权只给真实登记的记忆整理实例。`, {
          requireAuthority: 'Lead',
          howToChange: '普通成员只提交知识候选；由 Lead 在执行结账时晋升，或由 Lead 派一个记忆整理岗实例走受限晋升。',
          detail: { 实例: subject.id, 档案岗位: 档案?.岗位 ?? null, 状态: 档案?.status ?? null },
        });
      }
    }
    if (!项目) throw new InvalidBody('受限晋升必须指明存储项目 / 命名空间（知识双标签之一）。', { missing: ['项目'] });
    if (!岗位) throw new InvalidBody('受限晋升必须带「适用岗位」（知识双标签之二）：没有岗位标签的知识会扩散到所有岗位的默认召回面。', { missing: ['岗位'] });
    if (!内容) throw new InvalidBody('受限晋升内容为空：空知识会污染检索面。');
    if (!来源任务) throw new InvalidBody('受限晋升必须指明「来源任务」：知识来自哪一个已采纳的任务节点。', { missing: ['来源任务'] });
    if (!候选键) throw new InvalidBody('受限晋升必须带「候选键」：它进幂等键，重试时据此认回同一条产物。', { missing: ['候选键'] });

    // 源任务：存在性 + 合法采纳（唯一判据住 tasks.js）。
    const 源处 = await this.#findTask(来源任务);
    if (!源处) {
      throw new InvalidBody(`悬空来源任务：任务图里没有 ${来源任务}（晋升的来源必须是真实存在的任务节点，fail-closed）。`, { detail: { 来源任务 } });
    }
    if (!已被合法采纳(源处.节点)) {
      throw new Denied('v2 条目15/16 · 源任务未被合法采纳，不得晋升', `任务 ${来源任务} 当前状态「${源处.节点.状态 ?? '未知'}」（采纳依据：${源处.节点.采纳?.依据 ?? '无'}，需Lead确认：${源处.节点.需Lead确认 === true ? '是' : '否'}）：未验收的产出不进组织知识。`, {
        requireAuthority: 'Lead',
        howToChange: '先走完复核 → Lead 采纳（task_accept 引用真票）；或等 Lead 确认旧账采纳后再晋升。',
        detail: { 来源任务, 状态: 源处.节点.状态 ?? null, 采纳: 源处.节点.采纳 ?? null, 需Lead确认: 源处.节点.需Lead确认 === true },
      });
    }

    // 项目边界：成员只在「自己的执行项目」里晋升；存储命名空间可以显式是「通用」，
    // 但来源任务仍必须在执行项目内——通用是公共命名空间，不是跨项目侧门。
    let 执行项目 = 源处.项目;
    if (subject.kind === '成员') {
      if (!执行任务) {
        throw new Denied('记忆整理岗受限晋升必须声明「任务」（你被绑定的执行中任务）', '记忆整理是成员岗：晋升必须在自己的任务内（任务内全权、任务外无），且该任务必须绑着你这个实例。', {
          requireAuthority: 'Lead',
          howToChange: '在入参里带「任务」= 你名下已派发且处于执行中的节点 id。',
        });
      }
      const 执行处 = await this.#findTask(执行任务);
      if (!执行处) throw new InvalidBody(`「任务」指的任务节点不存在：${执行任务}。`, { detail: { 任务: 执行任务 } });
      const 绑定 = (执行处.节点.绑定 ?? []).some((b) => String(b?.实例 ?? '') === String(subject.id));
      if (!绑定) {
        throw new Denied('记忆整理岗受限晋升 · 任务没绑定本实例', `任务 ${执行任务} 的绑定里没有实例 ${subject.id}：真实绑定是「任务内全权」的凭据（负责人写的岗位名不算）。`, {
          requireAuthority: 'Lead',
          howToChange: '由 Lead 先把这个实例 bind 到该节点（task_bind 实例=你），再晋升。',
          detail: { 任务: 执行任务, 绑定: 执行处.节点.绑定 ?? [] },
        });
      }
      if (String(执行处.节点.状态) !== '执行中') {
        throw new Denied('记忆整理岗受限晋升 · 任务不在执行中', `任务 ${执行任务} 当前状态为「${执行处.节点.状态 ?? '未知'}」：记忆整理只在执行中的自身任务里晋升（任务授权随收口终止）。`, {
          requireAuthority: 'Lead',
          howToChange: '在任务执行中完成晋升；已交卷/已采纳/已结账的任务不能再充当晋升凭据。',
          detail: { 任务: 执行任务, 状态: 执行处.节点.状态 ?? null },
        });
      }
      执行项目 = 执行处.项目;
    }
    if (String(源处.项目) !== String(执行项目)) {
      throw new Denied('v2 条目15/16 · 晋升来源必须与执行项目同项目', `来源任务 ${来源任务} 属于项目「${源处.项目}」，而本次晋升发生在项目「${执行项目}」：成员实例禁止跨项目；Lead 要跨项目扩散请在目标项目显式执行（走 memory_lifecycle op=promote + 披露检查）。`, {
        requireAuthority: 'Lead',
        howToChange: '在来源任务所在项目里执行晋升；跨项目扩散走 memory_lifecycle op=promote（Lead + 披露检查）。',
        detail: { 来源任务项目: 源处.项目, 执行项目 },
      });
    }
    if (项目 !== '通用' && String(项目) !== String(源处.项目)) {
      throw new InvalidBody(`知识存储项目「${项目}」与来源项目「${源处.项目}」不一致：项目内知识只能落在产生它的项目；项目无关的公共知识显式写命名空间「通用」。`, { detail: { 项目, 来源项目: 源处.项目 } });
    }

    const 标题 = typeof spec.标题 === 'string' && spec.标题.trim() ? spec.标题.trim() : 内容.slice(0, 40);
    const 来源引用 = normalizeRefs(spec.来源引用);
    // 幂等键带来源项目：跨项目账 / 通用账会聚多个项目，光靠任务 id + 候选键会串成果。
    const 幂等键 = `${源处.项目}|${来源任务}|${候选键}`;
    const row = await this.remember({
      subject,
      类: '知识',
      内容,
      标题,
      来源: spec.来源 ?? { 谁: subject?.id, 怎么知道: `已采纳来源：任务 ${来源任务}（候选 ${候选键}）` },
      项目,
      岗位,
      依据: spec.依据,
      标签: spec.标签,
      ...(知识说明 === undefined ? {} : { 知识说明 }),
      来源引用,
      // 策略引擎的任务上下文：成员路径必须带（任务内全权）；Lead 路径带结算节点也无害。
      任务: spec.任务 ?? null,
      幂等键,
      [内部通道]: true,
    });
    await this.audit.append({
      动作: '知识晋升',
      主体: subject,
      // 对象记来源任务（不是知识 id）：审计读域按「同项目 + 对象命中复核对象」裁剪，
      // 对象写任务才让正牌复核实例看得见这次晋升；知识 id 在详情里。
      对象: { id: 来源任务, kind: '任务' },
      依据: 'v2 条目15/16：已采纳来源蒸馏晋升（源任务必须合法采纳；披露 / 审计同款）',
      结果: row.幂等命中 ? '幂等命中（未重复产知识）' : '晋升',
      项目: 源处.项目,
      详情: { 知识: row.id, 存储项目: 项目, 岗位, 候选键, 来源任务, 来源项目: 源处.项目, 来源引用, 幂等命中: row.幂等命中 === true },
    });
    return { id: row.id, 归属: row.归属, 项目, 岗位, 来源任务, 幂等键, 幂等命中: row.幂等命中 === true };
  }

  /**
   * 内部来源观察：完整原文先过当前读域再取哈希，不经过摘要/分页，也不追加审计。
   * 只证明捕获时读到一个有效版本；与交卷、purge没有跨账本原子事务。
   * 来源不确定统一未核验，不返回原因、正文或路径，不阻塞合法交卷。
   */
  async readKnowledgeEvidence({ subject, 项目, ids } = {}) {
    if (!Array.isArray(ids) || ids.length > 16 || ids.some(id => typeof id !== 'string' || !id.trim() || id.length > 256)) throw new InvalidBody('知识来源观察每次只接受至多16个精确id。');
    const requested = [...new Set(ids)];
    const unknown = () => new Map(requested.map(id => [id, { 状态: '来源未核验' }]));
    if (!requested.length) return unknown();
    try {
      const now = new Date(this.clock.now());
      if (typeof 项目 !== 'string' || !项目.trim() || !subject?.id || !['成员', 'Lead', '主权者'].includes(subject.kind)) return unknown();
      if (!this.policy?.refreshIfStale || !this.policy?.decideCurrentSync) return unknown();
      await this.policy.refreshIfStale();
      let actor = { ...subject };
      if (actor.kind !== '主权者') {
        if (!this.registry?.identity || !this.registry?.cardOf) return unknown();
        const member = (await this.registry.identity()).members?.[actor.id];
        if (member?.status !== '在岗' || (await this.registry.cardOf(actor.id))?.就绪 !== true) return unknown();
        if ((actor.kind === 'Lead' && member.岗位 !== 'Lead') || (actor.kind === '成员' && member.岗位 === 'Lead') || (actor.roleId !== undefined && actor.roleId !== member.岗位)) return unknown();
        actor = { ...actor, roleId: member.岗位 };
      }
      const permission = { subject: actor, action: 'read', target: { id: `记忆/检索/${项目}`, kind: '记忆', authority: '自治', zone: '私有', domain: '集体', project: 项目 }, context: { 类: '知识' } };
      if (this.policy.decideCurrentSync(permission)?.verdict !== 'allow') return unknown();
      const 域 = await 取复核读域({ tasks: this.tasks, 项目, subject: actor });
      const sources = [];
      const rows = [];
      for (const scope of await this.#scopesFor('知识', 项目)) {
        const file = this.layout.memoryLog(scope, '知识');
        const text = await readTextOrNull(file);
        sources.push({ file, text });
        if (text === null || text === '') continue;
        if (!text.endsWith('\n')) return unknown();
        for (const line of text.split('\n')) {
          if (!line.trim()) continue;
          const row = JSON.parse(line.replace(/^\uFEFF/, ''));
          if (!row || typeof row !== 'object' || Array.isArray(row) || typeof row.id !== 'string' || !row.id.trim()) return unknown();
          if (isStateRow(row)) {
            if (!['invalid', '降权', '推翻', '归档', '物理删除', '隔离', '待删除'].includes(row.追加) || typeof row.追于 !== 'string') return unknown();
          } else if (row.类 !== '知识' || typeof row.内容 !== 'string' || Object.hasOwn(row, '指向') || Object.hasOwn(row, '追加')) return unknown();
          rows.push(row);
        }
      }
      const result = unknown();
      for (const entry of fold(rows)) {
        if (!result.has(entry.id) || entry.类 !== '知识' || !memoryEntryVisible(entry, { 项目, 读者: actor }) || !记忆条目在读域(entry, 域) || 是否已被否(entry) || ['待复验', '说明不可判'].includes(knowledgeReviewStatus(entry, now))) continue;
        const metadata = Object.fromEntries(['id', '类', '标题', '来源', '来源引用', '派生自', '归属', '项目', '岗位', '标签', '状态', '历史', '记于'].map(key => [key, entry[key] ?? null]));
        if (Object.hasOwn(entry, '知识说明')) metadata.知识说明 = structuredClone(entry.知识说明);
        result.set(entry.id, { 状态: '可核来源版本', 内容哈希: digest(entry.内容), 元数据哈希: digest(canonical(metadata)), 捕获于: this.clock.iso() });
      }
      // 读取期间变化立即降为未知；之后的变化由查询重新裁剪，不宣称跨账本原子性。
      for (const source of sources) if (await readTextOrNull(source.file) !== source.text) return unknown();
      if (this.policy.decideCurrentSync(permission)?.verdict !== 'allow') return unknown();
      return result;
    } catch { return unknown(); }
  }

  /**
   * 检索。默认把归档后的作答排除在检索面之外；`显式: true` 才把它拉回来（§7）。
   * 默认按「当前有效视图」召回与浏览，失效正文须明确 `含失效: true` 才返回。
   * 有查询词只返回命中条目；id 详情复用同一过滤面，不另开跨项目或归档读口。
   *
   * 契约B（主权者裁决 2026-10-09）·只读面收窄：查询也过唯一判定点。
   * `subject` 缺失或未知 ⇒ 引擎按「未知主体」拒绝（fail-closed），这里**不另设默认主体**——
   * 读者可见性（归档作答）仍由 `读者` 承担，判定（能不能查）由 `subject` 承担。
   * 放行条目按「一次调用一条」入账（档位「记汇总」），不随命中条数膨胀。
   *
   * @param {{ subject: object, 类?: string[], 项目?: string, 岗位?: string, 文本?: string, id?: string, 显式?: boolean, 含失效?: boolean, 读者?: object, 读域?: object, limit?: number, 条数上限?: number, 返回模式?: string, 内容预算?: number, 偏移?: number, 正文偏移?: number, 数据版本?: string }} query
   *   `limit` / `条数上限` 最多100条；总内容预算含全部回传条目与命中元数据。
   *   工具默认摘要，内部服务保留默认全文；id+全文通过 `正文偏移` 续读长正文。
   *   `读域` 是 `review-scope.复核读域()` 的产物：复核员岗只召回「同一项目 + 来源引用与
   *   读域有交集」的条目（不是 role 全量、不凭会话 cwd 跨库猜）；其它主体传 null/省略。
   * @returns {Promise<{ 命中: object[], 口径: object, 条目: object[], 说明?: string }>}
   */
  async query(query = {}) {
    const now = new Date(this.clock.now());
    const 响应配置 = memoryResponseOptions(query);
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
    // 类 参数归一（设计评审 F1 · 2026-10-15）：工具 schema 的 `类` 是**单选字符串**（enum），
    // 服务面另允许数组（内部编排一次查多类）。修前这里原样透传 ⇒ 字符串被当数组迭代，
    // `wanted.join('/')` 直接 TypeError——schema 合法参数打崩动作。归一只在这一处做
    // （服务层防御）：字符串包成数组、数组原样、缺席用 MEMORY_KINDS（动作层不用改）。
    const wanted = [...new Set(typeof query.类 === 'string' ? [query.类] : (Array.isArray(query.类) ? query.类 : MEMORY_KINDS))].filter((kind) => MEMORY_KINDS.includes(kind));
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
      if (!memoryEntryVisible(entry, query)) continue;
      visible.push(knowledgeReviewProjection(entry, now));
    }

    // v2（条目4/6 补修 · 复核读域）：复核员岗的检索面按「已绑定复核任务 → 显式复核对象」
    // 的**结构化血缘**限定（同项目 + 来源引用命中读域），不是 role 全量，也不凭会话 cwd
    // 去别的项目账本里猜。装在 visible 之后、召回之前：口径与命中数都基于裁剪后的可见集，
    // 读数不说谎；被裁掉的条数单独报，不静默。
    let 读域排除 = 0;
    if (query.读域?.限定 === true) {
      const 保留 = visible.filter((entry) => 记忆条目在读域(entry, query.读域));
      读域排除 = visible.length - 保留.length;
      visible.length = 0;
      visible.push(...保留);
    }
    const 读域说明 = query.读域?.限定 === true
      ? `检索面按复核读域限定（${query.读域.说明}）：本任务读域之外的条目${读域排除 > 0 ? `另有 ${读域排除} 条被排除` : '为 0 条'}。`
      : '';

    // 当前建议不夹带失效正文；历史仍留原账，明确含失效时才进入同一权限过滤后的读面。
    // 判据实现只有一处：`是否已被否`（模块级，晋升闸与它共用同一条粘性判据）。
    const 撤回 = visible.filter(是否已被否);
    const 状态可召回 = query.含失效 === true ? visible : visible.filter((entry) => !是否已被否(entry));
    const 需复验 = (entry) => ['待复验', '说明不可判'].includes(entry.复验状态);
    const 可召回 = query.含待复验 === true ? 状态可召回 : 状态可召回.filter((entry) => !需复验(entry));
    // 页码不对正在变化的账本承诺无漏重；变化即要求重启，不能拼接两个不同事实快照。
    const 复验指纹 = visible.map((entry) => [entry.id, entry.复验状态 ?? null]);
    const 数据版本 = digest(JSON.stringify({ 类: wanted, 项目: query.项目 ?? null, 岗位: query.岗位 ?? null, 文本: query.文本 ?? '', id: query.id ?? null, 含待复验: query.含待复验 === true, 复验指纹, 条目: 可召回 }));
    if (query.数据版本 && query.数据版本 !== 数据版本) {
      throw new InvalidBody('记忆数据或查询口径已变化，不能继续旧分页；请清除 数据版本，并从偏移0/正文偏移0重新读取。', { detail: { 原因: 'MEMORY_QUERY_SNAPSHOT_CHANGED' } });
    }

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
      待复验条目数: visible.filter((entry) => entry.复验状态 === '待复验').length,
      说明不可判数: visible.filter((entry) => entry.复验状态 === '说明不可判').length,
      排除待复验: query.含待复验 === true ? 0 : 状态可召回.filter((entry) => entry.复验状态 === '待复验').length,
      排除说明不可判: query.含待复验 === true ? 0 : 状态可召回.filter((entry) => entry.复验状态 === '说明不可判').length,
      // v2 条目4/6：复核读域裁掉多少条（只报数，条目与敏感内容不进读数）。
      ...(query.读域?.限定 === true ? { 复核读域排除: 读域排除 } : {}),
    };

    const 视图说明 = 撤回.length > 0 && query.含失效 !== true
      ? `另有 ${撤回.length} 条已失效/被推翻/待删除/已隔离的条目按「当前有效视图」未进召回${口径数.隔离条目数 > 0 ? `（其中 ${口径数.隔离条目数} 条因源对象物理删除被血缘隔离）` : ''}；要看它们请带 含失效: true。`
      : '';
    const 复验说明 = wanted.includes('知识') ? '复验期限仅为作者声明；到期不代表已失效，未设期限不等于永远有效。待复验或说明不可判知识默认不推荐；含待复验=true仅放宽本筛选，仍须满足失效、项目和复核读域。' : '';
    const 说明们 = [读域说明, 视图说明, 复验说明, query.显式 === true ? '已显式包含可读归档作答。' : ''].filter(Boolean);
    const 装配 = (entries, hits, total, 口径, detail = false, fromEnd = false) => {
      const page = memoryResponsePage({ entries, hits, total, options: 响应配置, detail, fromEnd });
      if (page.条目截断) 说明们.push(`条目 共 ${total} 条，本页回传 ${page.条目.length} 条；按 下一偏移 继续读取。`);
      if (page.内容截断) 说明们.push('内容达到预算；元数据缩减与正文截断已标明，可用 id + 返回模式=全文 读取正文，按 下一正文偏移 续读。');
      return finalizeMemoryResponse({
        ...page,
        数据版本,
        口径: { ...口径, ...口径数, 条目总数: total, 条目截断: page.条目截断, 条数上限: page.条数上限, 回传命中数: page.命中.length, 回传条目数: page.条目.length },
        ...(说明们.length ? { 说明: 说明们.join(' ') } : {}),
      });
    };
    if (query.id) {
      const 详情 = 可召回.filter((entry) => entry.id === query.id);
      return 装配(详情, [], 详情.length, { 搜索面: '记忆服务/id', 查询词: '', 范围: wanted.join('/'), 文档数: 可召回.length, 命中数: 详情.length }, true);
    }
    if (!query.文本?.trim()) {
      // 历史浏览保持账本尾部方向；偏移从尾部计，单页内部仍按原账本序。
      const end = Math.max(0, 可召回.length - 响应配置.偏移);
      const start = Math.max(0, end - 响应配置.条数上限);
      const entries = 可召回.slice(start, end);
      说明们.push(`浏览从账本尾部偏移 ${响应配置.偏移} 条，本页最多 ${响应配置.条数上限} 条（按账本顺序，非按记于时间排序）；实际回传另受内容预算约束。`);
      return 装配(entries, [], 可召回.length, { 搜索面: '记忆服务', 查询词: '', 范围: wanted.join('/'), 文档数: 可召回.length, 命中数: 0 }, false, true);
    }
    // 索引缓存（2026-10-13 第四批）：键 = 账本合成签名 + 过滤口径。索引只取决于
    // 「哪些文档进入检索面」，与查询词无关 ⇒ 同一口径下反复检索（看板展开、连续问）
    // 只建一次。5000 行实测：每次重建 351 ms → 命中后只剩一次 search。
    // 索引缓存键必须带**读域指纹**：复核员与普通成员即便 读者.kind 相同，可见集也不同；
    // 漏掉这一维会让先到的读者把索引借给后到的读者（遮罩被缓存旁路）。
    const 读域指纹 = query.读域?.限定 === true ? `复核:${[...query.读域.集合].sort().join(',')}` : '无';
    const 索引键 = `${await this.#签名们(账本文件)}|${JSON.stringify([wanted, query.项目 ?? null, query.岗位 ?? null, query.含失效 === true, query.含待复验 === true, query.显式 === true, query.读者?.kind ?? null, 读域指纹, 复验指纹, 可召回.map((entry) => entry.id)])}`;
    let index = this.#indexCache.get(索引键);
    if (!index) {
      // 用户标签进检索索引（2026-10-14 审查 P2-19）：修前 标签 只塞 [类, 岗位]——
      // 写入时收的 标签（用户打的检索词）不进索引，按标签搜永远搜不到（静默落空）。
      index = buildIndex(可召回.map((entry) => ({
        id: entry.id,
        正文: entry.内容,
        标签: [entry.类, entry.岗位 ?? '', ...(Array.isArray(entry.标签) ? entry.标签 : [])],
        来源: entry.归属,
      })));
      if (this.#indexCache.size >= 索引缓存上限) this.#indexCache.delete(this.#indexCache.keys().next().value);
      this.#indexCache.set(索引键, index);
    }
    // 排名在服务内部算全，回传只取有限一页；不能用回传limit改变总命中读数。
    const result = search(index, query.文本, { limit: 可召回.length, 范围: `${wanted.join('/')}@${query.项目 ?? '全部项目'}` });
    const hits = result.命中.slice(响应配置.偏移, 响应配置.偏移 + Math.min(响应配置.limit, 响应配置.条数上限));
    const byId = new Map(可召回.map((entry) => [entry.id, entry]));
    if (result.口径.命中数 === 0) 说明们.unshift(formatMiss(result.口径));
    return 装配(hits.map((hit) => byId.get(hit.id)), hits, result.口径.命中数, result.口径);
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
    return this.#appendState(id, 'invalid', spec, {}, 'invalidate');
  }
  /**
   * 冷：追加降权状态，不删（§7「冷」）。
   * @param {string} id
   * @param {{ subject: object, 原因: string, 任务?: object }} spec
   */
  async demote(id, spec) {
    return this.#appendState(id, '降权', spec, {}, 'demote');
  }

  /** 只读领域准备；预览仅带见证摘要，不把任务声明正文复制到审批或处置账本。 */
  async prepareFeedbackReference(id, spec) {
    const args = feedbackArgs(id, spec, spec?.op);
    if (args.反馈引用 === undefined) throw new InvalidBody('反馈关联准备必须带反馈引用；旧处置不需要伪造空关联计划。');
    const witness = await this.#feedbackWitness(id, args);
    const state = args.op === 'invalidate' ? 'invalid' : args.op === 'demote' ? '降权' : '推翻';
    const target = memoryTarget('知识', witness.entry.归属, witness.entry.项目);
    const writeContext = feedbackWriteContext(id, state, args);
    if (typeof this.policy?.decide !== 'function') throw new Fault('KNOWLEDGE_FEEDBACK_POLICY_UNAVAILABLE', '缺少完整的知识处置预判引擎。');
    const decision = await this.policy.decide({ subject: args.subject, action: 'write', target, context: writeContext });
    if (!['allow', 'confirm'].includes(decision?.verdict)) throw feedbackDenied('知识反馈 · 处置写不可准入', decision);
    const preview = { 知识id: id, 操作: args.op, 反馈见证: witness.proof.指纹, 知识见证: witness.sourceDigest };
    const steps = [{ 动作: 'write', 目标: target, ...(args.op !== 'overturn' ? { 写: `记忆:${state}:${id}` } : {}), 上下文: writeContext, 说明: '按真实负面采用声明处置知识', 预览: preview }];
    if (args.op === 'overturn') steps.push({ 动作: 'create', 目标: memoryTarget('知识', witness.entry.项目 === '通用' ? DIR.跨项目 : witness.entry.项目, witness.entry.项目), 上下文: { task: args.任务 ?? null, 类: '知识' }, 说明: '追加替代知识（不继承旧适用说明）', 预览: { ...preview, 新条目摘要: digest(String(args.新条目 ?? '').trim()), 知识说明摘要: digest(canonical(args.知识说明)) } });
    const execution = Object.freeze({ 版本: 1, 动作: 'memory_lifecycle', 知识id: id, 操作: args.op, 指纹: witness.proof.指纹 });
    this.#feedbackPlans.set(execution, { id, argsDigest: feedbackInputDigest(id, args), sourceDigest: witness.sourceDigest, proof: witness.proof });
    return deepFreezeFeedback({ 指纹: witness.proof.指纹, 步骤: steps, 执行计划: execution });
  }

  /** 仅内部有界观察；未知、删除、不可读与坏源保持同形，不暗示未处理。 */
  async readFeedbackDispositions({ subject, 项目, items } = {}) {
    if (!feedbackId(项目) || !Array.isArray(items) || items.length > 16 || items.some((item) => !feedbackExact(item, ['知识id', '反馈指纹']) || !feedbackId(item.知识id) || !feedbackHash(item.反馈指纹))) throw new InvalidBody('反馈处置观察每次只接受同项目至多16个精确知识id与服务器指纹。');
    const args = { subject: structuredClone(subject), 项目, items: structuredClone(items) };
    const unknown = () => new Map(args.items.map((item) => [item.反馈指纹, feedbackUnknown()]));
    try {
      await this.#feedbackActor(args.subject);
      this.#feedbackRead(args.subject, { id: `记忆/检索/${项目}`, kind: '记忆', authority: '自治', zone: '私有', domain: '集体', project: 项目 }, { 类: '知识' });
      const snapshot = await this.#feedbackKnowledgeSnapshot(项目);
      const result = unknown();
      for (const item of args.items) {
        const entry = snapshot.entries.find((candidate) => candidate.id === item.知识id);
        if (!entry || !memoryEntryVisible(entry, { 项目, 读者: args.subject }) || ['物理删除', '待删除'].includes(entry.状态)) continue;
        try { this.#feedbackRead(args.subject, memoryTarget('知识', entry.归属, entry.项目), { id: entry.id, 类: '知识' }); } catch { continue; }
        const matches = snapshot.rows.filter((row) => row.指向 === item.知识id && ['invalid', '降权', '推翻'].includes(row.追加) && row.反馈关联?.版本 === 1 && row.反馈关联.指纹 === item.反馈指纹)
          .map((row, scan) => ({ row, scan })).sort((a, b) => Date.parse(a.row.追于) - Date.parse(b.row.追于) || a.scan - b.scan);
        const receipts = [];
        for (const { row } of matches.slice(-5)) {
          const receipt = { 动作: row.追加 === 'invalid' ? '失效' : row.追加 === '降权' ? '降权' : '替代', 记录摘要: digest(canonical(row)), 处置于: row.追于, 主体: row.主体.id };
          if (row.追加 === '推翻' && feedbackId(row.新条目)) {
            const replacement = snapshot.entries.find((candidate) => candidate.id === row.新条目);
            if (replacement && memoryEntryVisible(replacement, { 项目, 读者: args.subject }) && !['物理删除', '待删除'].includes(replacement.状态)) {
              try { this.#feedbackRead(args.subject, memoryTarget('知识', replacement.归属, replacement.项目), { id: replacement.id, 类: '知识' }); receipt.替代知识 = replacement.id; } catch { /* 替代id独立读域不许由旧关联授予。 */ }
            }
          }
          receipts.push(receipt);
        }
        result.set(item.反馈指纹, validateFeedbackDispositionObservation({ 状态: '可核对', 记录: receipts, 总数: matches.length, 截断: matches.length > receipts.length }));
      }
      await this.#feedbackActor(args.subject);
      this.#feedbackRead(args.subject, { id: `记忆/检索/${项目}`, kind: '记忆', authority: '自治', zone: '私有', domain: '集体', project: 项目 }, { 类: '知识' });
      await this.#feedbackSnapshotUnchanged(snapshot);
      return result;
    } catch { return unknown(); }
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
    const 知识说明 = normalizeKnowledgeContext(spec.知识说明);
    spec = { ...spec, ...(知识说明 === undefined ? {} : { 知识说明 }) };
    const feedback = await this.#feedbackExecution(id, spec, 'overturn');
    if (feedback) spec = feedback.args;
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    if (知识说明 !== undefined && entry.类 !== '知识') throw new InvalidBody('知识说明仅属于知识类，不能给非知识替代条目追加。');
    // 推翻 = 「新条目 + 旧条目状态行」**双行同锁落账**（2026-10-12 评审 P3）：
    // 修前两步分开落，第二步（状态行）失败会留下「替代品在、原条目没标推翻」的
    // 撕裂窗口——旧知识继续被召回，替代它的人却已经入账。
    // write 闸先行（拒了就连新条目都不许落）；remember 的 create 闸照旧在里面。
    const writePermission = {
      subject: spec.subject,
      action: 'write',
      target: memoryTarget(entry.类, entry.归属, entry.项目),
      context: { id, 状态: '推翻', task: spec.任务 ?? null },
    };
    await this.policy.check(writePermission);
    const created = await this.remember({
      subject: spec.subject,
      类: entry.类,
      内容: spec.新条目,
      来源: { 谁: spec.subject?.id, 怎么知道: `推翻 ${id}：${spec.理由}` },
      项目: entry.项目,
      岗位: entry.岗位 ?? undefined,
      来源引用: entry.来源引用 ?? [],
      ...(知识说明 === undefined ? {} : { 知识说明 }),
      派生自: id,
      // 推翻是「追加新条目 + 旧条目入账」双动作：新条目那次 remember 也过策略引擎，
      // 任务上下文必须跟着透传，否则成员任务内推翻会死在内部那次写入上（半动作）。
      任务: spec.任务 ?? null,
      [内部通道]: true,
      ...(feedback ? { [反馈提交点]: async () => { await this.policy.check(writePermission); await this.#verifyFeedbackExecution(id, feedback.args, feedback.plan); } } : {}),
      同锁追加: (row) => [{
        id: objectId('账目', `${id}:推翻`, { at: this.clock.ms() }),
        指向: id, 追加: '推翻', 追于: this.clock.iso(),
        依据: spec.理由 ?? spec.原因, 主体: spec.subject, 新条目: row.id,
        ...(feedback ? { 反馈关联: feedback.proof } : {}),
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

    // P1-01（全面审查 2026-10-17）：物理删除是「不可逆 + 无重试路」的动作，审计必须
    // **意图先行**。修前先抹内容、最后才写「不可逆操作」——抹除后审计失败 ⇒ 内容已永久
    // 消失、账上 0 行、重试报「没有这条记忆」。现在先把覆盖账本算出来（只读），
    // 再落一条「不可逆操作意图」；意图落不下去就不动盘。
    const 覆盖 = [];
    for (const scope of [DIR.跨项目, ...(await this.#projectScopes())]) {
      const file = this.layout.memoryLog(scope, entry.类);
      if (await exists(file)) 覆盖.push({ scope, file });
    }

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
    // 意图先行：清理覆盖与初始下游闭包先入账。后续任一步失败，账上至少能回答
    // 「谁在什么时候、以什么理由、准备抹哪些账、会波及哪些下游」；完成行在末尾。
    await this.audit.append({
      动作: '不可逆操作意图',
      主体: spec.subject,
      对象: { id, kind: entry.类 },
      依据: 敏感 ? '记忆处置表：敏感数据' : '记忆处置表：主权者明确要求',
      结果: `意图：物理删除 ${id}（覆盖 ${覆盖.length} 本账；初始下游隔离 ${下游.length} 条）`,
      项目: entry.项目,
      详情: { 理由: spec.理由, 类: entry.类, 清理覆盖: 覆盖.map((x) => x.file), 下游隔离: 下游.map((x) => x.id) },
    });
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
      // 一次结账只归档一次；标签把「同一任务的重试」与「另一任务的归档」区分开。
      context: { id: spec.任务 ?? null, 状态: '归档', 介入写: `记忆:归档:${spec.任务 ?? spec.项目}` },
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
    if (ANSWER_READERS.includes(spec.读者?.kind) || spec.读者?.roleId === '复核员') return { 可读: true, 原因: `${spec.读者.kind}${spec.读者.roleId === '复核员' ? '/复核员' : ''} 在归档后仍可读（会审分歧清单必须对复核员可见）` };
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
    // readJsonl 静默跳过。最底线=不静默：坏行进读数（§3.6）。
    // P3-a（设计评审 2026-10-15）：修前 stats 对每个文件全量 `readJsonlHealth` 重读——
    // 绕开 `#rows` 行缓存，activity/检索都命中缓存时它还在扫全库。现改走 `#rowsHealth`
    // （缓存命中 ⇒ 零全量重读，只剩签名校验的每文件一次 stat，与 #rows 同口径），
    // 坏行计数随缓存条目同源携带——「坏行可见」的裁决不因走缓存而丢。
    let 坏行 = 0;
    for (const kind of MEMORY_KINDS) {
      const rows = [];
      for (const scope of await this.#scopesFor(kind, query.项目)) {
        const health = await this.#rowsHealth(this.layout.memoryLog(scope, kind));
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

  /**
   * 结账候选（v2 口述收敛 2026-10-18 条目16）：本任务挂账的「经历」条目清单——
   * task_settle 把它列给 Lead 逐条判（晋升/留账本/丢弃）。只读投影，不入账
   * （与 activity 同口径：结账是轮询前的取数，入账会灌爆审计链）。
   * 口径：归属项目的、来源引用里挂着本任务节点的、当前仍「有效」的经历条目。
   * v2 补修E：带上 内容/岗位 ——「晋升」要真的蒸馏成知识条目，结账面需要正文与适用岗位；
   * 拒绝详情里的候选清单只挑 键/类/标题（不把正文灌进错误响应）。
   * @param {{ 项目: string, 任务: string }} query
   * @returns {Promise<Array<{ id: string, 标题: string, 类: string, 内容: string, 岗位: string|null }>>}
   */
  async settleCandidates(query) {
    const rows = await this.#rows(this.layout.memoryLog(DIR.跨项目, '经历'));
    return fold(rows)
      .filter((entry) => entry.项目 === query.项目
        && entry.状态 === '有效'
        && (entry.来源引用 ?? []).includes(query.任务))
      .map((entry) => ({ id: entry.id, 标题: entry.标题, 类: entry.类, 内容: entry.内容 ?? '', 岗位: entry.岗位 ?? null }));
  }

  // ── 内部 ────────────────────────────────────────────────────────────────────

  /**
   * 契约C 披露机械检查本体：对 标题+内容+标签 三个面跑敏感模式。
   *
   * @param {object} entry 折叠后的记忆条目
   * @returns {{ 命中: Array<{名: string}>, 已截断: boolean }} 命中的模式（只带名，不带命中
   *   片段——片段正是敏感本体）；已截断＝被检面超过上限、尾部未过检查（R11：调用方必须
   *   对截断 fail-closed，不得把「前缀干净」当「全文干净」）。
   */
  #disclosureHits(entry) {
    // 输入面长度上限（2026-10-13 审查 P1-14）：正则执行时间随输入长度放大，
    // 把被检面截到 20k 字符——超长输入用前 20k 过机械检查（正则复杂度边界）。
    // R11（2026-10-16）：截断事实随返回值上交，由晋升闸 fail-closed——不再默默放行尾部。
    const 说明面 = KNOWLEDGE_CONTEXT_LIST_FIELDS.flatMap((key) => Array.isArray(entry?.知识说明?.[key]) ? entry.知识说明[key] : []);
    const 原面 = [entry?.标题, entry?.内容, ...(Array.isArray(entry?.标签) ? entry.标签 : []), ...说明面].filter((s) => typeof s === 'string').join('\n');
    const 已截断 = 原面.length > 20_000;
    const 面数 = 已截断 ? `${原面.slice(0, 20_000)}\n[披露检查：输入已截断，原长 ${原面.length}]` : 原面;
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
    return { 命中, 已截断 };
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
    return Boolean(await this.#findTask(taskId));
  }

  /**
   * 按 id 找任务节点**并带它所在的项目**（跨全部项目查）。晋升面要判「来源与执行同项目」，
   * 只回答「存在与否」不够；折叠复用任务图自己的 fold（单一真源，不在这里另写事件语义）。
   * @param {string} id
   * @returns {Promise<{ 项目: string, 节点: object }|null>}
   */
  async #findTask(id) {
    const 目标 = String(id ?? '');
    if (!目标) return null;
    const root = this.layout.private(DIR.基础设施, DIR.任务图);
    for (const 项目 of await listDirs(root)) {
      const rows = await readTaskLedger(this.layout.taskLog(项目));
      const 节点 = foldTaskEvents(rows).get(目标);
      if (节点) return { 项目, 节点 };
    }
    return null;
  }

  /**
   * 身份档案里的成员记录（晋升权判据的权威源：自报 roleId 不算真实岗位）。
   * @param {string} id
   * @returns {{岗位?: string, status?: string}|null}
   */
  #档案成员(id) {
    return this.policy.state?.identity?.members?.[String(id ?? '')] ?? null;
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
  async #appendLedger(file, lines, guard = undefined) {
    const list = Array.isArray(lines) ? lines : [lines];
    if (list.length === 0) return list;
    await withLock(`${file}.lock`, async () => {
      if (guard) await guard();
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
   * R10（审查 2026-10-16 · 提交点原子检查 tombstone）：`提交点检查` 在**锁内、落线前**
   * 执行——引用校验（remember 的 #verifyRefs 在锁外）与提交之间，purge 可能完整走完
   * （状态行入账→物理抹除→闭包隔离），修前这条在途写会带着悬空引用落账、默认检索可
   * 召回（审查实证 repro-state #7-8：purge 返回隔离=[]，随后落账的子条目仍有效）。
   * 复验读的是 fold 视图（不取锁），在本锁内执行无重入风险。
   *
   * @param {string} file 账本文件
   * @param {{ kind: string, seed: string, build: (id: string) => object, 同锁追加?: (row: object) => object[], 提交点检查?: () => Promise<void>, 幂等键?: string, 幂等比对?: object }} spec
   *   `同锁追加`（2026-10-12 评审 P3）：与新条目**同一把锁、同一次 appendLines** 落账的
   *   伴随行（如 overturn 的「推翻」状态行）——双行同窗口，不留「新条目在、状态行没落上」
   *   的撕裂态。`提交点检查`（R10）：锁内落线前的最终一道校验，拒绝则本条不落线。
   *   `幂等键`（v2 条目16 · 补修E）：锁内按它查同账本既有条目——命中即返回旧行（重试
   *   不重复产知识）；同时核对 `幂等比对` 的业务参数，参数变了就拒（旧产物不能冒充本次
   *   内容）。查重与落线在同一把锁内，多实例并发重试也只产一条。
   * @returns {Promise<object>} 实际落线的行
   */
  async #appendEntry(file, spec) {
    return withLock(`${file}.lock`, async () => {
      // 锁内必须重读真源（fresh）：id 查重建立在锁内看到的行上，缓存可能落后于别的进程。
      const rows = await readJsonl(file);
      if (typeof spec.幂等键 === 'string' && spec.幂等键) {
        const 既有 = rows.find((row) => row?.幂等键 === spec.幂等键 && typeof row?.id === 'string' && !isStateRow(row));
        if (既有) {
          const 不符 = Object.entries(spec.幂等比对 ?? {}).filter(([键, 值]) => 键 === '知识说明' ? canonical(Object.hasOwn(既有, 键) ? normalizeKnowledgeContext(既有[键]) : undefined) !== canonical(值) : String(既有[键] ?? '') !== String(值 ?? ''));
          if (不符.length > 0) {
            throw new Denied(
              'v2 条目16 · 晋升幂等键已存在但业务参数不同',
              `幂等键「${spec.幂等键}」已产出过知识 ${既有.id}，但本次的 ${不符.map(([键]) => 键).join('、')} 与账上那条不一致：不能拿旧知识冒充本次内容，也不能在同一幂等键下落第二条。`,
              {
                howToChange: '若本次内容确已不同：先推翻旧条目（overturn）再以新内容晋升；若只是笔误：按账上已有参数重试（幂等命中不会重复产知识）。',
                detail: { 幂等键: spec.幂等键, 既有: 既有.id, 不符的键: 不符.map(([键]) => 键) },
              },
            );
          }
          return { ...既有, 幂等命中: true };
        }
      }
      const 已用 = new Set(rows.map((row) => row?.id).filter((id) => typeof id === 'string'));
      let id = objectId(spec.kind, spec.seed, { at: this.#nextStamp() });
      while (已用.has(id)) id = objectId(spec.kind, spec.seed, { at: this.#nextStamp() });
      const row = spec.build(id);
      const 伴随 = typeof spec.同锁追加 === 'function' ? spec.同锁追加(row) : [];
      if (typeof spec.提交点检查 === 'function') await spec.提交点检查();
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
  async #appendState(id, 状态, spec, extra = {}, op = undefined) {
    const feedback = await this.#feedbackExecution(id, spec, op);
    if (feedback) spec = feedback.args;
    const entry = await this.#folded(id);
    if (!entry) throw new InvalidBody(`没有这条记忆：${id}`);
    const permission = {
      subject: spec.subject,
      action: 'write',
      target: memoryTarget(entry.类, entry.归属, entry.项目),
      // 同一账本目标的多次状态写（一次结账里丢弃多条经历）靠条目 id 区分写入身份。
      context: { id, 状态, task: spec.任务 ?? null, 介入写: `记忆:${状态}:${id}` },
    };
    await this.policy.check(permission);
    await this.#appendLedger(this.layout.memoryLog(entry.归属, entry.类), [
      { id: objectId('账目', `${id}:${状态}`, { at: this.clock.ms() }), 指向: id, 追加: 状态, 追于: this.clock.iso(), 依据: spec.原因, 主体: spec.subject, ...extra, ...(feedback ? { 反馈关联: feedback.proof } : {}) },
    ], feedback ? async () => { await this.policy.check(permission); await this.#verifyFeedbackExecution(id, feedback.args, feedback.plan); } : undefined);
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

  async #feedbackExecution(id, spec, op) {
    const args = feedbackArgs(id, spec, op);
    if (args.反馈引用 === undefined) {
      if (spec.反馈执行计划 !== undefined) throw new InvalidBody('没有反馈引用不能携带反馈执行计划，不能借旧计划制造关联。');
      return null;
    }
    const plan = spec.反馈执行计划 ?? (await this.prepareFeedbackReference(id, args)).执行计划;
    const data = this.#feedbackPlans.get(plan);
    if (!data || data.id !== id || data.argsDigest !== feedbackInputDigest(id, args)) throw new InvalidBody('反馈执行计划不是本服务签发的同主体、同引用、同业务输入计划。');
    await this.#verifyFeedbackExecution(id, args, plan);
    return { args, plan, proof: structuredClone(data.proof) };
  }
  async #verifyFeedbackExecution(id, args, plan) {
    const data = this.#feedbackPlans.get(plan);
    if (!data || data.id !== id || data.argsDigest !== feedbackInputDigest(id, args)) throw new InvalidBody('反馈执行计划不匹配，不能用模型自报指纹或跨主体计划写关联。');
    const current = await this.#feedbackWitness(id, args);
    if (current.proof.指纹 !== data.proof.指纹 || current.sourceDigest !== data.sourceDigest) throw new Denied('知识反馈 · 准备见证已变化', '原交卷、采用条目或知识原文/状态已变化；旧准备不能生成幽灵关联，请重新核对。');
  }
  async #feedbackActor(subject) {
    if (!feedbackId(subject?.id) || !['Lead', '主权者'].includes(subject.kind)) throw new Denied('知识反馈 · 治理资格', '反馈关联只接受当前真实Lead或主权者，普通成员不能将采用声明变成处置权限。');
    if (!this.policy?.refreshIfStale || !this.policy?.decideCurrentSync) throw new Fault('KNOWLEDGE_FEEDBACK_POLICY_UNAVAILABLE', '缺少新鲜策略及当前读判定。');
    await this.policy.refreshIfStale();
    if (!this.policy.healthy) throw new Fault('KNOWLEDGE_FEEDBACK_POLICY_UNAVAILABLE', '当前策略不健康，不能核对或关联反馈。');
    if (subject.kind === 'Lead') {
      const member = (await this.registry?.identity?.())?.members?.[subject.id];
      if (member?.岗位 !== 'Lead' || member.status !== '在岗' || (subject.roleId !== undefined && subject.roleId !== 'Lead') || (await this.registry?.cardOf?.(subject.id))?.就绪 !== true) throw new Denied('知识反馈 · 当前Lead凭证', '主体不是在册、在岗且真实卡就绪的Lead。');
    }
  }
  #feedbackRead(subject, target, context = {}) {
    const decision = this.policy.decideCurrentSync({ subject, action: 'read', target, context });
    if (decision?.verdict !== 'allow') throw feedbackDenied('知识反馈 · 当前读域', decision);
  }
  async #feedbackWitness(id, args) {
    await this.#feedbackActor(args.subject);
    const taskFile = this.layout.taskLog(args.项目);
    const taskText = await readTextOrNull(taskFile);
    const taskRows = parseTaskLedger(taskText, taskFile);
    const node = foldTaskEvents(taskRows).get(args.反馈引用.任务);
    this.#feedbackRead(args.subject, { id: args.反馈引用.任务, kind: '任务', authority: '自治', zone: '私有', domain: '集体', project: args.项目 }, { task: node ?? null });
    const proof = resolveKnowledgeFeedback({ rows: taskRows, 项目: args.项目, ...args.反馈引用, 知识id: id });
    this.#feedbackRead(args.subject, { id: `记忆/检索/${args.项目}`, kind: '记忆', authority: '自治', zone: '私有', domain: '集体', project: args.项目 }, { 类: '知识' });
    const snapshot = await this.#feedbackKnowledgeSnapshot(args.项目);
    const entry = snapshot.entries.find((candidate) => candidate.id === id);
    if (!entry || !memoryEntryVisible(entry, { 项目: args.项目, 读者: args.subject }) || ['物理删除', '待删除'].includes(entry.状态)) throw new Denied('知识反馈 · 来源不可核对', '知识不存在、正在删除或不在当前项目读域，不能用旧反馈生成处置关联。');
    this.#feedbackRead(args.subject, memoryTarget('知识', entry.归属, entry.项目), { id, 类: '知识' });
    await this.#feedbackSnapshotUnchanged(snapshot);
    if (await readTextOrNull(taskFile) !== taskText) throw new Denied('知识反馈 · 读取期间见证变化', '任务原文读取期间发生变化，请重新准备，不能混用两个版本。');
    return { proof, entry, sourceDigest: digest(canonical(entry)) };
  }
  async #feedbackKnowledgeSnapshot(project) {
    const files = [];
    const rows = [];
    for (const scope of await this.#scopesFor('知识', project)) {
      const file = this.layout.memoryLog(scope, '知识'); const text = await readTextOrNull(file); files.push({ file, text });
      rows.push(...parseFeedbackKnowledgeRows(text));
    }
    return { files, rows, entries: fold(rows) };
  }
  async #feedbackSnapshotUnchanged(snapshot) { for (const { file, text } of snapshot.files) if (await readTextOrNull(file) !== text) throw new Denied('知识反馈 · 知识源读取期间变化', '知识原文在读取期间变化，不能将旧观察当作当前见证。'); }
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
  for (const raw of rows) {
    const row = stripFeedbackProof(raw);
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

function feedbackId(value) { return typeof value === 'string' && value.length > 0 && value.length <= 256 && value.trim() === value; }
function feedbackHash(value) { return typeof value === 'string' && /^[a-f0-9]{64}$/.test(value); }
function feedbackIso(value) { return typeof value === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z'); }
function feedbackExact(value, keys) { return value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
function feedbackUnknown() { return { 状态: '不可核对', 记录: [], 总数: null, 截断: null }; }
function feedbackDenied(rule, decision) { return new Denied(rule, decision?.reason ?? '当前权限或见证不可确认，不能扩大反馈关联读写域。', { requireAuthority: decision?.requireAuthority, howToChange: decision?.howToChange }); }
function feedbackArgs(id, spec, op) {
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) throw new InvalidBody('知识处置需要结构化参数。');
  const reference = normalizeFeedbackReference(spec.反馈引用);
  if (reference === undefined) return { ...spec, op, 反馈引用: undefined };
  if (!feedbackId(id) || !feedbackId(spec.项目) || !['invalidate', 'demote', 'overturn'].includes(op)) throw new InvalidBody('反馈关联只接受同项目明确知识id与invalidate/demote/overturn。');
  const context = normalizeKnowledgeContext(spec.知识说明);
  return { ...spec, subject: structuredClone(spec.subject), 任务: structuredClone(spec.任务 ?? null), op, 反馈引用: reference, ...(context === undefined ? {} : { 知识说明: context }) };
}
function feedbackInputDigest(id, args) { return digest(canonical({ 版本: 1, 知识id: id, 项目: args.项目, 主体: { id: args.subject?.id, kind: args.subject?.kind, roleId: args.subject?.roleId }, 操作: args.op, 反馈引用: args.反馈引用, 原因: args.原因 ?? args.理由 ?? null, 新条目: args.op === 'overturn' ? String(args.新条目 ?? '').trim() : null, 知识说明: args.op === 'overturn' ? args.知识说明 : undefined })); }
function feedbackWriteContext(id, state, args) { return { id, 状态: state, task: args.任务 ?? null, ...(args.op === 'overturn' ? {} : { 介入写: `记忆:${state}:${id}` }) }; }
function deepFreezeFeedback(value) { if (value && typeof value === 'object' && !Object.isFrozen(value)) { Object.values(value).forEach(deepFreezeFeedback); Object.freeze(value); } return value; }
function stripFeedbackProof(value) { if (Array.isArray(value)) return value.map(stripFeedbackProof); if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => key !== '反馈关联').map(([key, child]) => [key, stripFeedbackProof(child)])); return value; }
function parseFeedbackKnowledgeRows(text) {
  if (text === null || text === '') return [];
  if (!text.endsWith('\n')) throw new Fault('KNOWLEDGE_FEEDBACK_SOURCE_INVALID', '知识账本末尾撕裂，不能签反馈关联或报告未见处置。');
  const rows = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let row;
    try { row = JSON.parse(line.replace(/^\uFEFF/, '')); } catch (cause) { throw new Fault('KNOWLEDGE_FEEDBACK_SOURCE_INVALID', '知识账本有坏JSON，不能跳行核对反馈。', { cause }); }
    if (!row || typeof row !== 'object' || Array.isArray(row) || !feedbackId(row.id)) throw new Fault('KNOWLEDGE_FEEDBACK_SOURCE_INVALID', '知识账本行标识无效。');
    if (isStateRow(row)) {
      if (!['invalid', '降权', '推翻', '归档', '物理删除', '隔离', '待删除'].includes(row.追加) || !feedbackId(row.指向) || !feedbackIso(row.追于)) throw new Fault('KNOWLEDGE_FEEDBACK_SOURCE_INVALID', '知识账本有不可识别状态。');
      if (Object.hasOwn(row, '反馈关联') && (!['invalid', '降权', '推翻'].includes(row.追加) || !feedbackExact(row.反馈关联, ['版本', '指纹']) || row.反馈关联.版本 !== 1 || !feedbackHash(row.反馈关联.指纹) || !feedbackId(row.主体?.id) || !['Lead', '主权者'].includes(row.主体?.kind))) throw new Fault('KNOWLEDGE_FEEDBACK_SOURCE_INVALID', '知识状态的私有反馈关联结构不可核对。');
    } else if (row.类 !== '知识' || typeof row.内容 !== 'string' || Object.hasOwn(row, '指向') || Object.hasOwn(row, '追加') || Object.hasOwn(row, '反馈关联')) throw new Fault('KNOWLEDGE_FEEDBACK_SOURCE_INVALID', '知识账本有不可识别条目或伪造关联。');
    rows.push(row);
  }
  return rows;
}
