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
import { appendLines, atomicWrite, ensureDirPath, listFiles, readJsonl, readJsonOrNull, withLock, serializeByKey } from './kernel/fsx.js';
import { chainHash } from './kernel/text.js';
import { monthKey } from './kernel/time.js';

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
      const hash = chainHash(prev, { ...record, hash: undefined });
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
    const out = [];
    for (const month of months) {
      out.push(...(await readJsonl(this.layout.auditLog(month))));
    }
    let rows = out;
    if (query.grade) rows = rows.filter((r) => r.档位 === query.grade);
    if (query.project) rows = rows.filter((r) => r.项目 === query.project);
    if (query.subject) rows = rows.filter((r) => String(r.主体?.id ?? r.主体) === query.subject);
    if (query.since) rows = rows.filter((r) => r.时间 >= query.since);
    rows.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.时间).localeCompare(String(b.时间)));
    return query.limit ? rows.slice(-query.limit) : rows;
  }

  /**
   * 链自检：逐月验证 prev 指针与本节哈希。这是「审计被篡改」这一安全类的检测手段。
   * @returns {Promise<{ ok: boolean, months: number, entries: number, broken: object[] }>}
   */
  async verify() {
    const months = await this.months();
    const broken = [];
    let entries = 0;
    for (const month of months) {
      const rows = await readJsonl(this.layout.auditLog(month));
      let prev = null;
      for (const row of rows) {
        entries++;
        const expected = chainHash(prev, { ...row, hash: undefined });
        if (row.prev !== prev || row.hash !== expected) {
          broken.push({ month, seq: row.seq ?? null, expected, actual: row.hash ?? null });
        }
        prev = row.hash ?? null;
      }
    }
    return { ok: broken.length === 0, months: months.length, entries, broken };
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
      id: String(actor.id),
      kind: String(actor.kind ?? '未知'),
      ...(actor.roleId ? { roleId: String(actor.roleId) } : {}),
      ...(actor.generation !== undefined ? { generation: Number(actor.generation) } : {}),
    };
  }
  return { id: String(actor ?? 'unknown'), kind: '未知' };
}
