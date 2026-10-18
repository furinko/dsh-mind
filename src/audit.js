/**
 * 审计日志（§7「只增的事实记录」、§7「审计记录分级」、§9 接口契约）。
 *
 * 三条不可让步的性质，本文件按顺序实现：
 *  1. **写入无条件** —— 记录动作本身不问策略引擎。问它就会产生「拒绝导致的拒绝」，
 *     而那正好是 §3.6「安全闸静默失败」的入口。
 *  2. **只增** —— 主权者也不能改，只能追加更正。物理上靠 `.jsonl` + 链哈希保证：
 *     改任何一条，它之后的所有链哈希都对不上。
 *  3. **归档 takes precedence over 状态** —— §7 明确「不承担回滚、不做状态」，
 *     所以这里没有任何 `update`/`delete` 方法，将来也不加。
 */
import { appendLines, atomicWrite, ensureDirPath, listFiles, readJsonl, readJsonlHealth, readJsonOrNull, withLock, serializeByKey } from './kernel/fsx.js';
import { chainHash } from './kernel/text.js';
import { monthKey } from './kernel/time.js';
import { Denied, InvalidBody } from './kernel/errors.js';
import { DIR } from './paths.js';

/** §7 审计记录分级：全记 / 记汇总 / 不逐次记。 */
export const GRADE = { 全记: '全记', 记汇总: '记汇总', 不逐次记: '不逐次记' };

/**
 * 审计尾默认条数（设计评审 #17 · 2026-10-15 单源）：动作面（workbench / audit_tail /
 * org.workbench）的默认尾长。修前三处各写一个字面量 20/40/20——「默认给几条」这件同一件事
 * 有三种出处，改一处忘两处只是时间问题。**值不许顺手改**：20 是动作面审计尾的既有节奏。
 */
export const 审计尾默认条数 = 20;

/**
 * 看板包的审计尾条数（同上单源）：同源路由面（routes.js 看板包 / 内核装配）给浏览器看板
 * 固定喂的尾长，比动作面宽（看板要画「最近发生了什么」，20 条不够铺开）。
 * 修前是 routes.js 与 kernel/lib/index.js 里各写一个 40。**值保持 40**——改小会打破看板节奏。
 */
export const 看板审计尾条数 = 40;

/**
 * 动作 → 记录档位。这张表是「分级」的唯一判据。
 * 依据 §7 表格：策略拒绝、工具调用失败、状态变更、不可逆操作全记；
 * 成员成功的工具调用记汇总；普通只读调用不逐次记。
 */
const ACTION_GRADE = {
  策略拒绝: GRADE.全记,
  工具调用失败: GRADE.全记,
  状态变更: GRADE.全记,
  不可逆操作: GRADE.全记,
  自动回滚: GRADE.全记,
  // 探针巡检（全绿常态）也全记：权限矩阵主体表「机制内置，无条件入账」——表内有名，不静默走表外 fallback。
  探针巡检: GRADE.全记,
  探针异常: GRADE.全记,
  零分歧异常: GRADE.全记,
  失联: GRADE.全记,
  升级挂起: GRADE.全记,
  强制更新: GRADE.全记,
  账本清空: GRADE.全记,
  工具调用成功: GRADE.记汇总,
  只读调用: GRADE.不逐次记,
  // 契约B（主权者裁决 2026-10-09）·只读面收窄：memory.query / bus.read / capability.resolve
  // 三个只读服务开始过 policy.check，放行条目按「一次调用一条」入账——
  // 绝不逐条结果入账（查询命中 50 条 ≠ 50 条审计）。档位必须是「记汇总」：
  // 表外 fallback 是全记，漏登记会把每次查询都当全记事件记账。
  只读服务调用: GRADE.记汇总,
  // 契约C（主权者裁决 2026-10-09）·披露机械检查：Lead 显式豁免敏感命中放行晋升——
  // 这是「内容越过安全闸」的明确决定，与不可逆操作同级，全记。
  披露豁免: GRADE.全记,
  // 骑手①（契约C 补强 2026-10-09）：披露命中被拒也入账——「有人试过扩散敏感内容
  // 被拦」是安全信号。按裁决记汇总（一条：主体 + 命中模式名，不抄原文）。
  披露拦截: GRADE.记汇总,
  // 骑手②（契约C 补强 2026-10-09）：部署.json 披露敏感模式=[] 是主权者显式关闭——
  // 合法但不许静默，告警档全记一条（引擎加载/重载时的状态迁移触发）。
  披露机械检查已显式关闭: GRADE.全记,
  // W2 会审讨论段（2026-10-09）：开讨论/换轮/收敛各一条（记汇总）——发言（debate_say）
  // 不在此列：它走 bus.send 的既有审计路径（规格明定）。
  讨论开启: GRADE.记汇总,
  讨论换轮: GRADE.记汇总,
  讨论收敛: GRADE.记汇总,
  // W3 批3（2026-10-09）·结账（task_settle）：环路最后一步——把节点收进终态**并**归档
  // 该项目的作答（归档后成员不可读、默认检索面不再返回）。它同时改状态与改可见面，
  // 且是「这件事收尾了」的显式拍板 ⇒ 全记（与状态变更/不可逆操作同级，不是汇总档）。
  结账: GRADE.全记,
  // 缺口2a（主权者裁决 2026-10-12）·更正声明：把「单点 hash 不符、骨架完好」的已确认瑕疵
  // 从恒红转为「已确认瑕疵」。它能改变安全类探针的读数 ⇒ 与不可逆操作同级：全记 + 告警。
  更正声明: GRADE.全记,
  // 缺口1A（主权者批准 2026-10-12）·身份未登记拦截：未登记主体敲门也留痕
  // （只记主体 id + 动作名，不记入参）。「有人试图以未登记身份行动」是安全信号，全记。
  身份未登记拦截: GRADE.全记,
  // 主体创建（task-机制缺口-10th0 · 裁决① · 2026-10-13）：「起成员」在本组织原先无留痕入口——
  // spawn 在宿主侧、审计在组织侧，891jd 已判宿主侧挂钩归属错。本条以「首次登记即创建入账」
  // 为锚（与 8dt59 同款防泄密口径：只记实例 id 与动作名）。创建一个新主体是最该留痕的动作，全记。
  主体创建: GRADE.全记,
  // 缺口1B（2026-10-12 评审）·动作拦截：动作层/服务层自长闸（会审闸、状态机、披露检查、
  // 身份门①②……）的 Denied 全记——策略引擎的拒绝另有「策略拒绝」，两边不双记
  // （引擎抛出的 Denied 带 已入账 标记，动作层跳过）。
  动作拦截: GRADE.全记,
  // 设置变更（设计评审 P3-b · 2026-10-15 显式入表）：presence 命令改部署设置的动作名。
  // 修前不在表内、靠表外 fallback 落全记——结果对，机制靠默认值：fallback 是「没登记」
  // 的兜底，不是「登记过」的判据（与只读服务调用那条的教训同源：漏登记会让档位漂移无告警）。
  设置变更: GRADE.全记,
  // 主权者交互（设计评审 #7 · 2026-10-15）：失联→在线迁移那一刻的入账动作。
  // 触发频率低（只在迁移那一次），且是「失联保险解除」这一安全相关事实——全记，
  // 显式入表不靠 fallback。
  主权者交互: GRADE.全记,
};

export class AuditLog {
  /**
   * @param {{ layout: import('./paths.js').Layout, clock: import('./kernel/time.js').Clock, onAlarm?: (info: object) => void }} spec
   */
  constructor(spec) {
    this.layout = spec.layout;
    this.clock = spec.clock;
    this.onAlarm = spec.onAlarm ?? (() => {});
    /** 内存里的链尾缓存，避免每次追加都扫全月账本；重启后由 anchor 文件重建。 */
    this._chain = new Map();
  }

  /**
   * @param {string} action
   * @returns {string} 记录档位
   */
  gradeOf(action) {
    return ACTION_GRADE[action] ?? GRADE.全记;
  }

  /**
   * 追加一条事实。
   *
   * @param {{ 动作: string, 主体: string|object, 对象?: string|object, 依据?: string, 结果?: string, 详情?: object,
   *          项目?: string, 轮?: string, 档位?: string, 告警?: boolean }} entry
   * @returns {Promise<{ seq: number, hash: string, 时间: string, 月: string }>}
   */
  async append(entry) {
    const at = this.clock.iso();
    const month = monthKey(at);
    const file = this.layout.auditLog(month);
    // 「读尾→算 seq→追加→写 anchor」必须整体在锁内（E3）：
    // 并发追加会算出同 seq 同 prev 的两行 ⇒ 链 fork，verify() 把正常并发误判成篡改。
    // fsx.js 头注释自称「读-改-写一律走 withLock」，审计此前恰好没走。
    return serializeByKey(`${file}`, () =>
      withLock(`${file}.lock`, async () => {
      // 锁内必须重读真源（fresh）：内存链尾缓存只被「自己的追加」更新，
      // 别的写者在锁外推进过的账，缓存看不见 ⇒ 同 seq 同 prev 的 fork 行。
      const prev = await this.#chainTail(month, { fresh: true });
      const record = {
        seq: this.#nextSeq(month),
        时间: at,
        主体: normalizeActor(entry.主体),
        动作: entry.动作,
        对象: typeof entry.对象 === 'object' && entry.对象 !== null ? entry.对象 : { id: entry.对象 ?? null },
        依据: entry.依据 ?? '',
        结果: entry.结果 ?? '记',
        档位: entry.档位 ?? this.gradeOf(entry.动作),
        项目: entry.项目 ?? null,
        轮: entry.轮 ?? null,
        告警: entry.告警 === true,
        详情: entry.详情 ?? {},
        prev,
      };
      // 检查点守卫（第13代复核反例1 · 2026-10-16；第14代打回修正口径）：清单检查点超前于
      // 本行 seq ⇒ 该月账本疑似被删后重建（「删月复活口」）——拒写；检查点落后（正常写窗）
      // 不拦。清单缺失（null）⇒ 守卫跳过（旧部署首写/清单被删后的兜底登记在
      // #ensureMonthRegistered 重建事实）；清单损坏 ⇒ #readMonthManifest 抛出穿透
      // （fail-closed，与登记侧同口径——第14代分歧2：不吞、不静默重建）。
      const 清单 = await this.#readMonthManifest();
      const 检查点 = 清单?.checkpoints?.[month];
      if (检查点 && Number(检查点.seq) >= record.seq) {
        throw new InvalidBody(
          `审计链 ${month} 的月份清单检查点（seq=${检查点.seq}）超前于本次写入（seq=${record.seq}）：该月账本疑似被删除后重建。拒绝续写——重建的分片会掩盖删除事实（第13代复核反例1）；人工核对该月分片、锚与清单后处置。`,
          { detail: { month, 检查点, 本行seq: record.seq } },
        );
      }
      // hash 的输入必须先过 JSON 往返归一（2026-10-12 评审 P2-1）：落盘走 JSON.stringify
      // （丢 undefined 值、NaN→null……），而 verify 复算的是「从盘上解析回来」的对象。
      // 写侧不归一，任何含 undefined 的字段都会自己打断自己的链（2026-10#37 就是这么来的）。
      // 注意 hash 键要在归一**之后**补回 undefined：验侧是 `{...row, hash: undefined}`
      // （canonical 把 undefined 算成 null），两边形状必须逐键一致——归一时直接丢键就会
      // 全盘见红（校准实测）。
      const hash = chainHash(prev, { ...JSON.parse(JSON.stringify(record)), hash: undefined });
      const stored = { ...record, hash };
      await appendLines(file, [stored]);
      this._chain.set(month, { seq: record.seq, hash });
      await this.#writeAnchor(month, { seq: record.seq, hash, at });
      // R13/R14（审查 2026-10-16 · 月份清单）：每月首写登记「应当存在的分片」。verify 按
      // 清单∪日志∪锚核对——无活动月不再被日历连续性误判（R13），整月账本+锚同删也因
      // 清单在案而必红（R14 的加强面）。清单只由本方法（机制）写入，业务记录填不了它。
      // 检查点（第13代复核反例1 · 2026-10-16）：清单同时记每月末 {seq,hash}——append 前
      // 检查点超前于实际尾 ⇒ 该月账本疑似被删，拒写（「删月复活口」在写入面关闭）；
      // verify 侧另有「检查点回卷」红兜住直写文件的旁路。
      await this.#ensureMonthRegistered(month, { seq: record.seq, hash });
      if (stored.告警) this.onAlarm({ month, ...stored });
      return { seq: record.seq, hash, 时间: at, 月: month };
      }),
    );
  }

  /**
   * 月份清单登记（R13/R14 + 第13代复核反例1 检查点 · 第14代打回修正）：读-改-写整个在
   * 调用方的锁内（append 的临界区）。清单缺失（旧部署首用/被删）时以现存的日志月∪锚月
   * 做底，并为已存在的月**从实际尾播种检查点**——兜底不以「无尾」为前提（第14代分歧1：
   * 唯一调用点恒带尾，`&& !尾` 使播种分支静态不可达，旧月既无检查点也无登记，R14 对旧月
   * 相对基线回退）。清单损坏（坏 JSON/形状不合规）⇒ 响亮拒写（第14代分歧2：修前坏 JSON
   * 硬拒而坏形状被静默重建洗红——两种坏态不对称；统一 fail-closed，防「清单损坏」红被洗）。
   * 检查点语义：落后于实际尾＝正常写窗（崩溃可致）；超前于实际尾＝该月账本疑似被删。
   * @param {string} month
   * @param {{ seq: number, hash: string }} [尾] 本次刚落线的行（作为该月新检查点）
   */
  async #ensureMonthRegistered(month, 尾) {
    const file = this.layout.auditMonthManifest();
    /** @type {{ months: string[], checkpoints: Record<string, {seq:number,hash:string}> }} */
    let doc = null;
    try {
      doc = await this.#readMonthManifest();
    } catch (error) {
      // 清单损坏（坏 JSON/形状不合规）：写入面 fail-closed——拒写并把清单指向说清。
      // 不许静默重建：重建=用「今天的盘上事实」覆盖「清单曾记录的事实」，verify 的
      // 「清单损坏」红会被洗掉（第14代反例 P3）。人工核对后修复或删除清单再继续。
      throw new InvalidBody(
        `月份清单损坏，写入面 fail-closed：${error instanceof Error ? error.message : String(error)}。拒绝本次追加——损坏的清单不许被静默重建（那会洗掉 verify 的「清单损坏」红）；人工核对审计目录后修复或删除清单文件，再重试。`,
        { detail: { file, month } },
      );
    }
    if (doc === null) doc = { months: [], checkpoints: {} };
    if (!doc.months.includes(month) || 尾) {
      if (doc.months.length === 0) {
        // 兜底（清单缺失＝旧部署首用或被删）：以盘上已存在的分片做底（只登记事实，
        // 不发明月份），并从各月实际尾播种检查点——**不论本次是否带尾**（第14代分歧1）：
        // 首启即播种，此后旧月被删＋直写重建即成「回卷」、被删即「分片缺失」。
        const 锚月 = await this.#anchorMonths();
        const 已存 = [...new Set([...await this.months(), ...锚月])].sort();
        const 播种 = {};
        for (const m of 已存) {
          const rows = await readJsonl(this.layout.auditLog(m));
          const last = rows[rows.length - 1];
          if (last?.seq && last?.hash) 播种[m] = { seq: last.seq, hash: last.hash };
        }
        doc.months = [...new Set([...已存, month])].sort();
        doc.checkpoints = { ...播种, ...doc.checkpoints };
      } else if (!doc.months.includes(month)) {
        doc.months = [...new Set([...doc.months, month])].sort();
      }
      if (尾) doc.checkpoints[month] = { seq: 尾.seq, hash: 尾.hash };
      await atomicWrite(file, `${JSON.stringify({ months: doc.months, checkpoints: doc.checkpoints }, null, 2)}\n`);
    }
  }

  /**
   * 读月份清单（verify / append 守卫 / 登记共用）。返回 null = 清单缺失；
   * throw = 清单损坏（坏 JSON / 形状不合规——两类都包装成带「清单损坏」指向的文案，
   * 第14代打回：修前坏 JSON 抛 readJsonOrNull 原文（不含清单指向），调用方与断言都认不出）。
   * @returns {Promise<{ months: string[], checkpoints: Record<string, {seq:number,hash:string}> } | null>}
   */
  async #readMonthManifest() {
    const file = this.layout.auditMonthManifest();
    let parsed;
    try {
      parsed = await readJsonOrNull(file);
    } catch (error) {
      throw new Error(`月份清单损坏（JSON 解析失败）：${error instanceof Error ? error.message : String(error)}（${file}）`);
    }
    if (parsed === null) return null;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.months)) {
      throw new Error(`月份清单形状不合规（缺 months 数组）：${file}`);
    }
    return { months: parsed.months.filter((m) => typeof m === 'string'), checkpoints: parsed.checkpoints && typeof parsed.checkpoints === 'object' ? parsed.checkpoints : {} };
  }

  /** 锚文件出现的月份（R14：孤立锚＝锚在而日志不在——从日志枚举里看不见的那部分）。 */
  async #anchorMonths() {
    // P1-08（全面审查 2026-10-17）：修前枚举 `audit-YYYY-MM.anchor.json`，而
    // Layout.auditAnchor 实际写 `.anchor-YYYY-MM.json`（前导点、词序不同）——锚月集恒空，
    // 「只有锚、没有日志」的月份在 verify 里假绿。现行命名 + 旧命名都认；写入仍只有
    // Layout.auditAnchor 一处，避免再出现第三个名字。
    const 现行 = /^\.anchor-(\d{4}-\d{2})\.json$/;
    const 旧 = /^audit-(\d{4}-\d{2})\.anchor\.json$/;
    const files = await listFiles(this.layout.auditDir(), { recursive: false, filter: (n) => 现行.test(n) || 旧.test(n) });
    return [...new Set(files.map((f) => (现行.exec(f) ?? 旧.exec(f))?.[1]).filter(Boolean))];
  }

  /**
   * 读取账本。审计日志是「唯一出口」，所以读取也必须能按档位、项目、轮过滤，
   * 否则工作台与复核者都得自己扫全量。
   * @param {{ months?: string[], grade?: string, project?: string, subject?: string, since?: string, limit?: number }} [query]
   * @returns {Promise<object[]>}
   */
  async read(query = {}) {
    const months = query.months ?? (await this.months());
    // 排序键是 **(月, seq)**（W3 批2·2026-10-09）：`seq` 是**逐月**从 1 开始的，
    // 拿它当全局键会把两个月交错成一团（1 月的第 7 条排在 2 月的第 2 条后面，
    // 而 2 月那条第 2 条其实更晚）。所以按月分组的结构先留住，再逐月按 seq 排。
    const 组 = [];
    for (const month of months) {
      for (const row of await readJsonl(this.layout.auditLog(month))) 组.push({ month, row });
    }
    let 条目 = 组;
    if (query.grade) 条目 = 条目.filter((x) => x.row.档位 === query.grade);
    if (query.project) 条目 = 条目.filter((x) => x.row.项目 === query.project);
    if (query.subject) 条目 = 条目.filter((x) => String(x.row.主体?.id ?? x.row.主体) === query.subject);
    if (query.since) 条目 = 条目.filter((x) => x.row.时间 >= query.since);
    条目.sort(
      (a, b) =>
        a.month.localeCompare(b.month) ||
        (a.row.seq ?? 0) - (b.row.seq ?? 0) ||
        String(a.row.时间).localeCompare(String(b.row.时间)),
    );
    const rows = 条目.map((x) => x.row);
    return query.limit ? rows.slice(-query.limit) : rows;
  }

  /**
   * 更正声明（缺口2a · 主权者裁决 2026-10-12 采用「追加更正」方案）。
   *
   * 宪章「只增不可改」禁止改原行，于是「单点 hash 不符、骨架完好」的已确认瑕疵
   * （如 2026-10#37：写入路径把 `对象.id:null` 的键丢掉后才落盘，hash 却是带 id 算的）
   * 只能靠**追加一条声明**闭环——声明自身是普通链节：进链、受骨架约束，
   * 伪造/篡改它照样在 verify() 见红，篡改面不扩大。
   *
   * 闸控（默认拒绝三道闸，全部在写入面——「审计写入无条件问策略引擎」是铁律，
   * 所以「谁能写更正声明」只能由这个唯一入口自己守）：
   *  ① `授权引用` 必填：主权者授权依据（决议 / 任务节点 id），空 ⇒ Denied；
   *  ② `理由` 必填：这处瑕疵为什么确认无误，空 ⇒ Denied；
   *  ③ 目标必须是**真实存在的瑕疵**：行在、prev 骨架完好、复算 hash ≠ 实存 hash——
   *     对健康的行写声明 = 伪造瑕疵，对骨架断裂的行写声明 = 声明救不了它，都响亮拒。
   * 载荷里的 实存hash / 复算hash 由本方法从账本**现算**（调用方不传——传了就有人能写垃圾载荷）。
   *
   * @param {{ 主体: string|object, 目标: string, 理由: string, 授权引用: string }} spec
   *   `目标` 形如 `month#seq`（如 `2026-10#37`）。
   * @returns {Promise<{ seq: number, hash: string, 时间: string, 月: string }>}
   */
  async appendCorrection(spec) {
    const 授权引用 = typeof spec.授权引用 === 'string' ? spec.授权引用.trim() : '';
    if (!授权引用) {
      throw new Denied('审计链 · 更正声明须主权者授权', '更正声明必须带「授权引用」（主权者授权依据，如决议 / 任务节点 id）：空授权 = 默认拒绝。', {
        requireAuthority: '主权者',
        howToChange: '由主权者授权后，把授权依据的 id 作为「授权引用」传入（它会原样进链接受复核）。',
      });
    }
    const 理由 = typeof spec.理由 === 'string' ? spec.理由.trim() : '';
    if (!理由) {
      throw new Denied('审计链 · 更正声明须带理由', '更正声明必须带「理由」：这处瑕疵为什么确认无误——理由要进链接受复核，空理由 = 默认拒绝。', {
        requireAuthority: '主权者',
        howToChange: '把瑕疵成因的核查结论作为「理由」传入（如「写入路径丢键缺陷，内容经核对无误」）。',
      });
    }
    const m = /^(\d{4}-\d{2})#(\d+)$/.exec(String(spec.目标 ?? '').trim());
    if (!m) throw new InvalidBody('更正声明的「目标」须形如 month#seq（如 2026-10#37）。', { missing: ['目标'] });
    const [, month, seqText] = m;
    const seq = Number(seqText);
    const rows = await readJsonl(this.layout.auditLog(month));
    const idx = rows.findIndex((r) => r.seq === seq);
    if (idx < 0) throw new InvalidBody(`更正声明的目标行不存在：${month}#${seq}（本月账本 ${rows.length} 行）。`, { detail: { 目标: spec.目标, 行数: rows.length } });
    const row = rows[idx];
    const prevHash = idx === 0 ? null : (rows[idx - 1].hash ?? null);
    const 复算hash = chainHash(prevHash, { ...row, hash: undefined });
    if (row.prev !== prevHash) {
      throw new Denied('审计链 · 更正声明救不了骨架断裂', `目标 ${month}#${seq} 的 prev 指针与上一节对不上（骨架断裂）：更正声明只覆盖「单点 hash 不符、骨架完好」的瑕疵，骨架断裂按篡改处置。`, {
        requireAuthority: '主权者',
        howToChange: '骨架断裂没有闭环入口——升级主权者核查篡改面。',
      });
    }
    if (row.hash === 复算hash) {
      throw new Denied('审计链 · 更正声明只认真实瑕疵', `目标 ${month}#${seq} 自检通过（复算 hash 与实存一致）：对健康的行写更正声明 = 伪造瑕疵，拒。`, {
        requireAuthority: '主权者',
        howToChange: '先用 audit_verify 拿到真实的断裂点（month#seq），再对它写声明。',
      });
    }
    // 授权引用存在性校验（2026-10-13 裁决第二批 · P2-18）：对齐 memory 来源引用的
    // fail-closed 口径——空字符串之外的「任意字符串」不能当授权：授权依据必须是任务图里
    // 真实出现过的节点 id（决议/任务都落任务图），悬空授权 = 漂白哈希差异的口子，拒。
    if (!(await this.授权依据存在(授权引用))) {
      throw new Denied(
        '审计链 · 授权引用必须真实存在',
        `授权引用「${授权引用}」在任务图事件流里找不到：更正声明是把哈希差异转「已确认瑕疵」的闭环入口，授权依据必须指向真实的决议/任务节点（fail-closed，与记忆来源引用同口径）。`,
        {
          requireAuthority: '主权者',
          howToChange: '把主权者授权所依据的决议/任务节点 id 原样传入（它进链接受复核）。',
        },
      );
    }
    return this.append({
      动作: '更正声明',
      主体: spec.主体,
      对象: { id: `${month}#${seq}`, kind: '审计' },
      依据: 授权引用,
      结果: `已确认瑕疵 ${month}#${seq}（实存 hash 与复算不符，骨架完好，内容经核对）`,
      告警: true,
      详情: { 目标: `${month}#${seq}`, 实存hash: row.hash ?? null, 复算hash, 理由, 授权引用 },
    });
  }

  /**
   * 授权引用是否指向任务图里真实出现过的节点（跨全部项目，与 memory.#taskExists 同口径）。
   *
   * 语义边界（2026-10-14 审查 P2-7，如实标注）：这里验的是**存在性**，不是「主权者亲签」——
   * 主权者在本体系里不直接跑会话，授权artifact 就是 Lead 落进任务图的决议/任务节点，
   * 其效力来自那条链本身接受复核，而不是创建者字段。「存在 ≠ 授权」的残余风险由
   * 更正声明/任命两道入口的复核面兜底（声明与任命都告警入账，复核者可见）。
   *
   * 公共方法（原 #授权存在，2026-10-14 提为公共）：registry.assign 的复核员任命特判
   * 用同一把尺——授权引用的存在性校验只有这一份实现，不许两处各写。
   * @param {string} id
   */
  async 授权依据存在(id) {
    // listFiles 顶部已静态导入（2026-10-14 审查 P3：修前这里又动态 import 一次，冗余）。
    const root = this.layout.private(DIR.基础设施, DIR.任务图);
    for (const rel of await listFiles(root, { recursive: true, filter: (n) => n.endsWith('tasks.jsonl') })) {
      const rows = await readJsonl(`${root}/${rel}`);
      if (rows.some((row) => row?.id === id)) return true;
    }
    return false;
  }

  /**
   * 链自检：逐月验证 prev 指针与本节哈希，并把**月尾**与 anchor 对照。
   * 这是「审计被篡改」这一安全类的检测手段。
   *
   * 为什么必须读 anchor（W3 批2·2026-10-09）：只验链内自洽的话，**砍掉尾部若干行**
   * 之后剩下的还是一根自洽的链（每一行的 prev/hash 都对得上它前面的那行）——
   * 删掉「最后一次写入」是审计里最值得做的事（那一条正是不想被看见的那条），
   * 而它恰好是自检唯一查不出的形状。`#writeAnchor` 每次追加都落一份「写到哪儿了」，
   * 那是链外的独立留痕：月尾 hash/seq 与 anchor 不一致 ⇒ 尾部被动过 ⇒ 进 broken。
   * 边界（如实说明，不吞）：写入进程若恰好死在 `appendLines` 与 `#writeAnchor` 之间，
   * 这一档也会亮——它报的是同一件事「尾部那几行没有链外留痕覆盖」，方向是响亮而非静默。
   *
   * 更正声明（缺口2a · 2026-10-12）：`动作:'更正声明'` 的链节能把**一处**「单点 hash 不符、
   * prev 骨架完好」的断裂转为「已确认瑕疵」（不计 broken，单独列入 `已确认瑕疵`），条件全部
   * 满足才算数——目标行在、prev 对得上、声明的 `实存hash` 与账本实存一致、`复算hash` 与
   * 现场复算一致。任何未被真实瑕疵消费的声明（伪造 / 错配 / 目标本无瑕疵）都按
   * 「更正声明无效」计入 broken ⇒ **声明与账本对不上 ⇒ 仍红**。声明自身是普通链节：
   * 篡改它的内容会让它自己的 hash 对不上 ⇒ 照样见红，篡改面零扩大。
   *
   * 声明表是**跨月全局**的（2026-10-12 评审 P1-9）：`appendCorrection` 永远写进**当前月**
   * 分片，而目标行在旧月——按月收集会让跨月轮转后的声明永远够不着目标（静默失效，
   * 安全类机制里最糟的形状）。声明在哪个分片不重要，键是 `目标月#seq`。
   *
   * @returns {Promise<{ ok: boolean, months: number, entries: number, broken: object[], 已确认瑕疵: object[] }>}
   */
  async verify() {
    const months = await this.months();
    const broken = [];
    const 已确认瑕疵 = [];
    let entries = 0;
    // R14（审查 2026-10-16 · 孤立锚/分片缺失）：期望月集 = 日志月 ∪ 锚月 ∪ 清单月。
    // 修前 verify 只从日志文件枚举月份——整月日志被删而锚还在时，该月从检查面**整个消失**
    // （审查实证：删唯一月的日志、锚保留 ⇒ ok=true、months=0 假绿）。并集里「在案而无日志」
    // 的月份必红且点名来源；R13（无活动月）：日历连续性检查已被清单口径取代——
    // 月份是否「应当存在」由机制登记说了算，不再由日历说了算。
    const 锚月集 = new Set(await this.#anchorMonths());
    // 清单自保护（第13代复核反例2 · 2026-10-16）：清单缺失且盘上有日志月∪锚月 ⇒ 红
    // 「清单缺失」（只删清单以前无告警，且清单+整月同删会让修前的整月假绿复活）；
    // 清单坏 JSON/形状不合规 ⇒ 红「清单损坏」。无分片也无清单 ⇒ 绿（全新部署形态）。
    let 清单月集 = new Set();
    let 检查点表 = {};
    let 清单态 = '缺席';
    try {
      const 清单 = await this.#readMonthManifest();
      if (清单) {
        清单态 = '在案';
        清单月集 = new Set(清单.months.filter((m) => typeof m === 'string'));
        检查点表 = 清单.checkpoints ?? {};
      }
    } catch (error) {
      清单态 = '损坏';
      broken.push({ month: null, seq: null, 类型: '清单损坏', expected: '可解析的 {months,checkpoints}', actual: String(error instanceof Error ? error.message : error), 说明: '月份清单是「应当存在的分片」的真源（R13/R14）——它坏了等于清单口径整个失明，必须见红（第13代复核反例2）' });
    }
    if (清单态 === '缺席' && (months.length > 0 || 锚月集.size > 0)) {
      broken.push({ month: null, seq: null, 类型: '清单缺失', expected: '月份清单在案（有分片/锚的部署）', actual: '月份清单.json 不存在', 说明: '只删清单即可让「清单+整月同删」的假绿复活（第13代复核反例2）；部署上出现过审计写入的，清单缺席本身即异常' });
    }
    const 在案 = new Set([...months, ...锚月集, ...清单月集]);
    for (const month of 在案) {
      if (months.includes(month)) continue;
      const 来源 = 锚月集.has(month) && 清单月集.has(month) ? '锚+清单' : (锚月集.has(month) ? '锚' : '清单');
      broken.push({ month, seq: null, 类型: '分片缺失', expected: '该月在案（' + 来源 + '）', actual: '日志分片不存在', 说明: '整月账本被删（锚/月份清单仍记录它曾存在）——孤立锚/缺失分片必须见红（R14）' });
    }
    // 第一遍：全月份收集更正声明（跨月全局表，见 JSDoc）。声明必定**晚于**目标行入账
    // （追加闭环），边走边收会让「目标行在前、声明在后」的常态永远收不到。
    const 声明表 = new Map(); // 'YYYY-MM#seq' -> row[]
    const 每月rows = new Map();
    for (const month of months) {
      // 撕裂行可见（2026-10-13 审查 P1-7）：读取走带体检的版本——坏行数与「尾部没有换行」
      // 都是 broken 项。修前 verify 复用会跳行的读取器，崩溃撕裂的半行被两边一起静默跳过。
      const { rows, 坏行, 末行完整 } = await readJsonlHealth(this.layout.auditLog(month));
      每月rows.set(month, rows);
      if (坏行 > 0) {
        broken.push({ month, seq: null, 类型: '撕裂行', expected: null, actual: null, 坏行数: 坏行 });
      }
      // 尾部撕裂并入「撕裂行」报（2026-10-14 审查 P3）：修前同一条尾部撕裂报两次
      // （撕裂行 + 尾部撕裂各一条），broken 计数虚高、读的人以为两处伤。
      // 「末行无换行」本身就是坏行（readJsonlHealth 的 坏行 已含它），这里只在
      // 撕裂行条目的说明里点出尾部撕裂，不再单列。
      if (!末行完整 && 坏行 === 0) {
        // 兜底：末行不完整但坏行计数为 0 的形状理论上不该出现（体检器口径），仍响亮报。
        broken.push({ month, seq: rows[rows.length - 1]?.seq ?? null, 类型: '尾部撕裂（末行无换行）', expected: null, actual: null });
      } else if (!末行完整) {
        broken[broken.length - 1].说明 = '其中包含尾部撕裂（末行无换行）——通常是写入进程被杀的断面。';
      }
      for (const row of rows) {
        if (row.动作 !== '更正声明') continue;
        const m = /^(\d{4}-\d{2})#(\d+)$/.exec(String(row.详情?.目标 ?? ''));
        if (!m) continue;
        const key = `${m[1]}#${Number(m[2])}`;
        if (!声明表.has(key)) 声明表.set(key, []);
        声明表.get(key).push(row);
      }
    }
    const 已消费 = new Set();
    for (const month of months) {
      const rows = 每月rows.get(month);
      let prev = null;
      for (const row of rows) {
        entries++;
        const expected = chainHash(prev, { ...row, hash: undefined });
        if (row.prev !== prev || row.hash !== expected) {
          // 只有「prev 骨架完好」的单点 hash 瑕疵才可被声明覆盖；骨架断裂不许被声明洗白。
          const 声明 =
            row.prev === prev
              ? (声明表.get(`${month}#${row.seq}`) ?? []).find((s) => s.详情?.实存hash === (row.hash ?? null) && s.详情?.复算hash === expected)
              : null;
          if (声明) {
            已消费.add(声明);
            已确认瑕疵.push({ month, seq: row.seq ?? null, 类型: '已确认瑕疵', 实存hash: row.hash ?? null, 复算hash: expected, 声明seq: 声明.seq ?? null });
          } else {
            broken.push({ month, seq: row.seq ?? null, 类型: '链断裂', expected, actual: row.hash ?? null });
          }
        }
        prev = row.hash ?? null;
      }
      // 尾部截断：anchor 是「这一片最后写到哪」的链外留痕。
      // 锚损坏（JSON 解析失败）不许伪装成「没锚」：单独一类 broken（2026-10-12 评审 P3，
      // readJsonOrNull 现在对坏文件响亮抛）。
      let anchor = null;
      try {
        anchor = await readJsonOrNull(this.layout.auditAnchor(month));
      } catch {
        broken.push({ month, seq: rows[rows.length - 1]?.seq ?? null, 类型: '锚损坏', expected: null, actual: null });
        continue;
      }
      if (anchor?.hash) {
        const tail = rows[rows.length - 1] ?? null;
        if (!tail || tail.hash !== anchor.hash || (tail.seq ?? null) !== (anchor.seq ?? null)) {
          broken.push({
            month,
            seq: tail?.seq ?? null,
            类型: '尾部截断',
            expected: anchor.hash,
            actual: tail?.hash ?? null,
            锚定: { seq: anchor.seq ?? null, hash: anchor.hash, at: anchor.at ?? null },
          });
        }
      } else if (rows.length > 0) {
        // 有账却无锚：锚文件被删同样让「尾部截断」无法被发现，按最严报出来（§12.2 查不到 = 最严）。
        broken.push({ month, seq: rows[rows.length - 1]?.seq ?? null, 类型: '锚缺失', expected: null, actual: rows[rows.length - 1]?.hash ?? null });
      }
    }
    // 检查点回卷（第13代复核反例1 · 2026-10-16）：清单检查点超前于实际尾（或同 seq 而
    // hash 不符）⇒ 该月账本被删后重建/被改写——append 侧守卫拦得住机制面，直写文件的
    // 旁路由这里兜住。检查点落后（正常写窗：append 临界区内清单更新晚于账本落线）不误报。
    for (const [月, 点] of Object.entries(检查点表)) {
      if (!点 || typeof 点 !== 'object' || !(Number(点.seq) > 0)) continue;
      const rows = 每月rows.get(月);
      if (rows === undefined) continue; // 分片缺失已由上方并集检查报红，不重复报。
      const 尾行 = rows[rows.length - 1] ?? null;
      const 回卷 = !尾行 || (尾行.seq ?? 0) < Number(点.seq);
      const 同seq不同hash = 尾行 && 尾行.seq === Number(点.seq) && 尾行.hash !== 点.hash;
      if (回卷 || 同seq不同hash) {
        broken.push({ month: 月, seq: 尾行?.seq ?? null, 类型: '检查点回卷', expected: `≥seq ${点.seq}（hash ${String(点.hash).slice(0, 8)}…）`, actual: 尾行 ? `seq ${尾行.seq}（hash ${String(尾行.hash ?? '').slice(0, 8)}…）` : '账本无行', 说明: '月份清单检查点超前于实际尾：该月账本疑似被删除后重建（或被截短改写）——重建的分片会掩盖删除事实（第13代复核反例1）' });
      }
    }
    // R13（审查 2026-10-16）：修前的「日历连续性」月份缺口检查在此——它把「无活动月」
    // 误判成「整月被删」（审查实证：仅 1 月、3 月各一条记录，2 月无任何活动 ⇒ verify 报
    // 2 月缺口）。已由上方的清单口径取代：月份是否应当存在，由机制登记（月份清单）说了算；
    // 真被删的月由「分片缺失」（清单/锚在案而无日志）捕获，且**不需要**造假业务记录来消警。
    // 残余面（如实交代）：清单启用前的旧月份若账本+锚同删，无链外凭据可查——与修前
    // 「最早月之前/最新月之后」的残余同款，记入设计债。
    // 未被任何真实瑕疵消费的声明 = 声明与账本对不上（伪造 / 错配 / 目标本无瑕疵）⇒ 仍红。
    // 归属记到**声明自己所在的月份**（它是哪个月入的账，就在哪个月见红）。
    for (const [key, list] of 声明表) {
      for (const s of list) {
        if (!已消费.has(s)) {
          broken.push({ month: monthKey(s.时间), seq: s.seq ?? null, 类型: '更正声明无效', 目标: key, expected: s.详情?.实存hash ?? null, actual: s.hash ?? null });
        }
      }
    }
    return { ok: broken.length === 0, months: months.length, entries, broken, 已确认瑕疵 };
  }

  /**
   * 已存在的月份分片（新→旧）。
   * @returns {Promise<string[]>}
   */
  async months() {
    const files = await listFiles(this.layout.auditDir(), { recursive: false, filter: (n) => /^audit-\d{4}-\d{2}\.jsonl$/.test(n) });
    return files.map((f) => f.replace(/^audit-/, '').replace(/\.jsonl$/, '')).sort().reverse();
  }

  /**
   * 账本清空（队列可以被清空，但**记录**不可逆）。
   * 行为：把被清掉的项**写进账本**，而不是让它们消失。
   * @param {{ 主体: string, 队列: string, 清掉的项: Array<object>, 依据: string }} spec
   */
  async clearQueue(spec) {
    return this.append({
      动作: '账本清空',
      主体: spec.主体,
      对象: { id: spec.队列, kind: '队列' },
      依据: spec.依据,
      结果: `清掉 ${spec.清掉的项.length} 项（已转入本记录，未消失）`,
      详情: { 清掉的项: spec.清掉的项 },
    });
  }

  /**
   * @param {string} month
   * @param {{ fresh?: boolean }} [options] `fresh: true` 跳过内存缓存直接读盘——
   * 追加临界区里必须用它：缓存只反映「自己写过的尾巴」，多写者场景下信缓存就 fork。
   */
  async #chainTail(month, options = {}) {
    if (!options.fresh) {
      const cached = this._chain.get(month);
      if (cached) return cached.hash;
    }
    // 锚损坏 = 链外留痕不可信 ⇒ 追加不许继续（fail-closed）：让它以 InvalidBody 抛出去，
    // 不许 fallthrough 到「读整片取尾行」——坏锚 + 好尾行会把断链接成「看起来正常」。
    const anchor = await readJsonOrNull(this.layout.auditAnchor(month));
    // R15（审查 2026-10-16 · 锚-尾恢复协议）：修前有锚即信——「追加已落账、锚未提交」的
    // 崩溃断面重启后续写会从锚的 seq 重算，制造 [1,2,2] 重复序号并断链（审查实证
    // repro-storage #3）。协议三分支：
    //  ① 锚落后（实际尾 seq > 锚 seq）⇒ 明确恢复：锚重写为实际尾、续写从实际尾继续；
    //  ② 锚超前/同 seq 而 hash 不符 ⇒ 不接受任意尾部（截断/篡改与崩溃在此分流）⇒ 响亮拒；
    //  ③ 一致 ⇒ 原样。恢复只认「向前」，攻击者截短重造的尾部永远落在 ②。
    if (anchor?.hash) {
      const rows = await readJsonl(this.layout.auditLog(month));
      const last = rows[rows.length - 1] ?? null;
      // 归零断面（第13代复核反例3 · 2026-10-16）：锚在（seq>0）而日志无行 ⇒ 该月账本
      // 被删/清空。锚只写在日志之后，此形态**没有合法崩溃成因**——修前静默按锚续写
      // （新行成为该月唯一一行），现响亮拒；verify 侧该形状由「尾部截断」红（回归钉住）。
      if (!last) {
        throw new InvalidBody(
          `审计链 ${month}：锚(seq=${anchor.seq ?? null}) 在案而账本无行——日志疑似被删/清零（锚只能写在日志之后，此形态无合法崩溃断面）。不接受按锚静默续写（第13代复核反例3）；人工核对该月分片与锚后处置。`,
          { detail: { month, 锚: { seq: anchor.seq ?? null, hash: anchor.hash }, 实际行数: 0 } },
        );
      }
      if ((last.seq ?? 0) > (anchor.seq ?? 0)) {
        await this.#writeAnchor(month, { seq: last.seq, hash: last.hash, at: last.时间 ?? anchor.at ?? null, 恢复: '锚落后于账本尾——按崩溃断面重写（R15）' });
        const tail = { seq: last.seq, hash: last.hash };
        this._chain.set(month, tail);
        return tail.hash;
      }
      if (last && ((last.seq ?? 0) < (anchor.seq ?? 0) || last.hash !== anchor.hash)) {
        throw new InvalidBody(
          `审计链 ${month}：锚(seq=${anchor.seq ?? null}) 与实际尾(seq=${last.seq ?? null}, hash=${String(last.hash).slice(0, 8)}…)不一致——疑似截断或篡改。不接受该尾部续写（R15 恢复协议只认「锚落后」的崩溃断面）；人工核对该月分片与锚后处置。`,
          { detail: { month, 锚: { seq: anchor.seq ?? null, hash: anchor.hash }, 实际尾: { seq: last.seq ?? null, hash: last.hash ?? null } } },
        );
      }
      this._chain.set(month, anchor);
      return anchor.hash;
    }
    const rows = await readJsonl(this.layout.auditLog(month));
    const last = rows[rows.length - 1];
    const tail = { seq: last?.seq ?? 0, hash: last?.hash ?? null };
    this._chain.set(month, tail);
    return tail.hash;
  }

  /** @param {string} month */
  #nextSeq(month) {
    return (this._chain.get(month)?.seq ?? 0) + 1;
  }

  /** @param {string} month @param {object} anchor */
  async #writeAnchor(month, anchor) {
    const file = this.layout.auditAnchor(month);
    await ensureDirPath(this.layout.auditDir());
    await atomicWrite(file, `${JSON.stringify(anchor)}\n`);
  }
}

/**
 * 主体规范化：审计记录的 `主体` 必须是一等对象，不许退化成裸字符串。
 * @param {string|object} actor
 * @returns {{ id: string, kind: string, roleId?: string, generation?: number, 卡版本?: string }}
 */
function normalizeActor(actor) {
  if (actor && typeof actor === 'object') {
    return {
      // 主体 id 缺席 ⇒ 记 '未知' 而不是 String(undefined)='undefined'（2026-10-13 第三批收口）：
      // 伪主体 'undefined' 会被检索/过滤面当成一个真实存在的 id，分不清「未知主体」与「名叫
      // undefined 的主体」。kind 缺席同理。
      id: actor.id === undefined || actor.id === null || actor.id === '' ? '未知' : String(actor.id),
      kind: String(actor.kind ?? '未知'),
      ...(actor.roleId ? { roleId: String(actor.roleId) } : {}),
      ...(actor.generation !== undefined ? { generation: Number(actor.generation) } : {}),
      // v2 口述收敛 2026-10-18 条目10：实例钉住的**卡版本摘要**随主体进账。
      // 为什么在审计层统一补：账要能回答「它当时凭的是哪一版岗位卡」，而这一位属于
      // **主体形状**、不属于任何单个动作——每个 service 各记一遍必然漏。
      // 只有调用方在主体上带了它才落（runAction 单点补，见 src/subject.js 的 钉版主体）。
      ...(actor.卡版本 ? { 卡版本: String(actor.卡版本) } : {}),
    };
  }
  return { id: String(actor ?? 'unknown'), kind: '未知' };
}
