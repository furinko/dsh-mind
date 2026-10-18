/**
 * 时间与「失联」判定（§4 失联）。
 *
 * 为什么把时钟抽出来：§12.4 要求「重启后所有判定必须能重建（不依赖内存）」，
 * 而失联判定依赖「最后一次交互」这个时间戳。时间必须来自可注入的源，
 * 否则测试无法把「超过响应期限」这件事变成确定性事实。
 */

/** 统一的时间来源。测试用 freeze() 把它变成确定值。 */
export class Clock {
  /** @param {() => Date} [source] */
  constructor(source) {
    this._source = source ?? (() => new Date());
  }

  /** @returns {Date} 当前时刻 */
  now() {
    return this._source();
  }

  /** ISO-8601 秒级（对象元数据 `updated` / 审计 `时间` 的规范形状）。 */
  iso() {
    return toIso(this.now());
  }

  /** @returns {number} 毫秒时间戳 */
  ms() {
    return this.now().getTime();
  }
}

/**
 * @param {Date|string|number} value
 * @returns {string} ISO-8601（UTC，秒）
 */
export function toIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

/**
 * 审计日志按月分片用的分片键（§14.3：审计日志按月，不按项目分）。
 * @param {Date|string} value
 * @returns {string} `YYYY-MM`
 */
export function monthKey(value) {
  const d = value instanceof Date ? value : new Date(value);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** 内置兜底的响应期限（小时）：主权者没写、或写了个坏值时的生效值。 */
export const BUILTIN_RESPONSE_DEADLINE_HOURS = 72;

/**
 * 响应期限小时的**上界**（含 876000 小时 ≈ 100 年）。
 *
 * 为什么必须有上限（这不是「输入体检」的洁癖，是防止整条读数链全废）：
 * `evaluateSovereignPresence` 要算 `deadline = since + 小时 × 3600_000`，
 * 而 `Date` 能表示的最大时刻是 `8.64e15` ms —— 越界时 `toIso()` 抛 `RangeError`，
 * 于是 `presence()` 抛、`/mind status` 与工作台一起拿不到状态条，而引擎还报 `healthy`。
 * 越界阈值约 `2.4e9` 小时（`(8.64e15 − 现在)/3600e3`）：**一个「合法的大整数」足以把读数面整个打死**。
 *
 * 为什么取 100 年：语义上「期限 876000 小时」已经等于「永不判失联」（远超任何部署寿命），
 * 再大没有含义，而它距 `Date` 上界还有 4 个数量级的安全余量。
 *
 * 为什么常量住在这里而不是写在使用方：判据只该有一份（§12.3 同款纪律）——
 * 写前校验（`lib/actions.js` 的 `解析设置小时`）与运行时折算（`resolveResponseDeadline`）
 * 引用的是**同一个**上界；两处字面量迟早会漂，而漂的方向正好是「一处放行、一处炸」。
 */
export const MAX_RESPONSE_DEADLINE_HOURS = 876_000;

/**
 * `Date` 能表示的最大时刻（毫秒，±100,000,000 天）：`8.64e15`。
 *
 * 为什么把这个数写下来：`since + 期限×3600e3` 一旦越过它，`toIso()` 就抛 `RangeError`。
 * 上界只卡住了「期限」那一头，还剩下另一头 —— `lastInteraction` 本身是**合法**时刻但贴近这个上限
 * （`+275760-09-13T00:00:00.000Z` 正是不多不少的最大值），此时**加上任何正的小时数都会溢出**，
 * 于是 `presence()` 抛、`/mind status` 与工作台一起拿不到状态条，而引擎还报 `healthy`。
 */
const DATE_MAX_MS = 8.64e15;

/**
 * 解析主权者自设的「响应期限小时」。
 *
 * 坏值（`0` / `-5` / `"abc"` / `null` / **越界的大整数**）既**不能让保护失效**，也**不许静默**：
 *  - 保护方向 fail-safe：退回内置兜底 72（期限照判，失联保险照常工作）；
 *  - 读数方向响亮：把 `不合法` 与 `原值` 交回调用方，由它如实报进 `/mind status` 与工作台。
 * 两件事在这一个函数里定，是为了让「什么算合法」只有一个答案（§12.3 权限来源唯一确定的同款纪律：
 * 判据也只该有一份）。
 *
 * **上界是判据的一部分**（`MAX_RESPONSE_DEADLINE_HOURS`）：越界的值必须被判成「不合法」并退回 72，
 * 否则 `evaluateSovereignPresence` 算出的 deadline 会溢出 `Date` 上界，`toIso()` 抛错 ⇒ 读数面全废。
 *
 * @param {unknown} raw 文件里原样读到的值
 * @returns {{ 生效: number, 不合法: boolean, 原值: unknown, 理由: string }}
 *   `原值` 为 `undefined` 时折成 `null`（JSON 里没有 undefined，写进读数要能序列化）。
 */
export function resolveResponseDeadline(raw) {
  const hours = Number(raw);
  const 合法 = Number.isFinite(hours) && hours > 0 && hours <= MAX_RESPONSE_DEADLINE_HOURS;
  const 原值 = raw === undefined ? null : raw;
  return {
    生效: 合法 ? hours : BUILTIN_RESPONSE_DEADLINE_HOURS,
    不合法: !合法,
    原值,
    理由: 合法 ? '' : `需为 1 ~ ${MAX_RESPONSE_DEADLINE_HOURS} 之间的有限值（上限约 100 年），收到 ${JSON.stringify(原值)}`,
  };
}

/**
 * 失联判定：自最后一次交互起，超过主权者自设的响应期限未响应。
 *
 * @param {{ lastInteraction: string|number|null, responseDeadlineHours: number, now?: Date|string|number }} input
 * @returns {{ lost: boolean, since: string|null, deadline: string|null, hours: number|null, 判定说明?: string }}
 *   `lastInteraction` 为空**或解析不出一个有效时刻**时，一律按「从未交互」处理 ——
 *   那是失联，不是在线（§12.2 不许「查不到 = 放行」）。
 *   坏时间戳必须走这条路而不是让它一路算下去：`toIso(NaN)` 会抛 `RangeError`，
 *   而这一抛不是「读数难看」，是 `presence()` 抛 ⇒ `/mind status` 与工作台**一起拿不到状态条**
 *   （与越界的 `响应期限小时` 是同一个后果，所以两条判据都在这里堵）。
 *
 *   **本函数永不抛**（调用方 `presence()` 也永不抛 —— 它是读数链的必经之路）：
 *   时刻解析不出、或「合法时刻 + 期限」越过 `Date` 上界，都给**确定读数**：
 *   `lost` 按最严取 `true`，`deadline` 取 `null`（表示不出来），原因写进 `判定说明`。
 */
export function evaluateSovereignPresence(input) {
  const now = toMs(input.now === undefined ? Date.now() : input.now);
  // 坏值在这里就已经被折成合法值（同一份判据），调用方拿到的是「生效值」，不是原值。
  const hours = resolveResponseDeadline(input.responseDeadlineHours).生效;
  const deadlineMs = hours * 3600_000;
  if (input.lastInteraction === null || input.lastInteraction === undefined) {
    return { lost: true, since: null, deadline: null, hours: 0 };
  }
  const since = toMs(input.lastInteraction);
  if (!Number.isFinite(since)) {
    // 时刻解析不出来 ⇒ 按「从未交互」判失联（fail-safe），并如实给 null 而不是一个假时间。
    return { lost: true, since: null, deadline: null, hours: 0 };
  }
  const deadline = since + deadlineMs;
  if (!Number.isFinite(deadline) || deadline > DATE_MAX_MS || deadline < -DATE_MAX_MS) {
    // `since` 合法、但加上期限就溢出（贴近 `Date` 上界）⇒ **不抛**，给确定读数 + 真原因。
    // `deadline: null` 是「表示不出来」，不是「没有期限」；拿不准按最严判失联（§12.2 查不到 = 最严）。
    return {
      lost: true,
      since: toIso(since),
      deadline: null,
      hours: null,
      判定说明: `到期时刻超出可表示范围（lastInteraction=${toIso(since)} 加上期限 ${hours} 小时会越过 Date 上界 ${DATE_MAX_MS}ms），按最严判失联（fail-safe，§12.2 查不到 = 最严）。`,
    };
  }
  if (!Number.isFinite(now)) {
    // 「现在」解析不出来（input.now 是坏值）时，`now > deadline` 得 false ⇒ **判在线**，
    // 那是 fail-open：一个坏读数就能把失联保护整个关掉。与 lastInteraction 侧同一条先例
    // （§12.2 查不到 = 最严）：按最严判失联，并给出可查的原因（W3 批2·2026-10-09）。
    return {
      lost: true,
      since: toIso(since),
      deadline: toIso(deadline),
      hours: null,
      判定说明: `「当前时刻」解析不出（now=${显示坏值(input.now)}）：无法与到期时刻比较，按最严判失联（fail-safe，§12.2 查不到 = 最严）。`,
    };
  }
  return {
    lost: now > deadline,
    since: toIso(since),
    deadline: toIso(deadline),
    hours: Math.floor((now - since) / 3600_000),
  };
}

/**
 * 时刻 → 毫秒。解析不出来一律折成 `NaN`，**永不抛**：
 * `new Date(Symbol())` / `new Date(1n)` 会抛 TypeError，而本函数的调用方
 * （`presence()` → `/mind status` / 工作台）是读数链的必经之路——
 * 一个坏输入把读数面整个打死，比给出「未知」糟糕得多。
 * @param {unknown} value
 * @returns {number}
 */
function toMs(value) {
  try {
    return new Date(/** @type {any} */ (value)).getTime();
  } catch {
    return Number.NaN;
  }
}

/**
 * 把坏值显示成一行可读文本（诊断用，同样永不抛）。
 * @param {unknown} value
 * @returns {string}
 */
function 显示坏值(value) {
  try {
    const s = JSON.stringify(value);
    if (typeof s === 'string') return s;
  } catch {
    // 循环引用 / BigInt 之类：退回 String。
  }
  try {
    return String(value);
  } catch {
    return '(无法显示的值)';
  }
}
