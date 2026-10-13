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
      if (stored.告警) this.onAlarm({ month, ...stored });
      return { seq: record.seq, hash, 时间: at, 月: month };
      }),
    );
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
    if (!(await this.#授权存在(授权引用))) {
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

  /** 授权引用是否指向任务图里真实出现过的节点（跨全部项目，与 memory.#taskExists 同口径）。 */
  async #授权存在(id) {
    const { listFiles } = await import('./kernel/fsx.js');
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
      if (!末行完整) {
        broken.push({ month, seq: rows[rows.length - 1]?.seq ?? null, 类型: '尾部撕裂（末行无换行）', expected: null, actual: null });
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
    // 月份缺口（2026-10-13 审查 P1-7b）：删掉整月 账本+锚 后该月从 months() 枚举中消失，
    // verify 对剩余月份照常全绿。月份清单按日历连续性核对：中间缺一个月 ⇒ 响亮见红。
    // 如实交代剩余面（不吞）：**最早**月份之前与**最新**月份之后的截断没有链外检查点，
    // 本条查不出（需要跨月滚动的链外留痕，记入设计债）。
    const 升序 = [...months].sort();
    for (let i = 1; i < 升序.length; i++) {
      const [y1, m1] = 升序[i - 1].split('-').map(Number);
      const [y2, m2] = 升序[i].split('-').map(Number);
      const 期望下月 = m1 === 12 ? `${y1 + 1}-01` : `${y1}-${String(m1 + 1).padStart(2, '0')}`;
      if (y2 !== Number(期望下月.split('-')[0]) || m2 !== Number(期望下月.split('-')[1])) {
        broken.push({ month: 升序[i], seq: null, 类型: '月份缺口', expected: 期望下月, actual: 升序[i], 说明: `${升序[i - 1]} 与 ${升序[i]} 之间缺月：整月账本+锚被删的形状` });
      }
    }
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
    if (anchor?.hash) {
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
 * @returns {{ id: string, kind: string, roleId?: string, generation?: number }}
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
    };
  }
  return { id: String(actor ?? 'unknown'), kind: '未知' };
}
