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

/**
 * 失联判定：自最后一次交互起，超过主权者自设的响应期限未响应。
 *
 * @param {{ lastInteraction: string|number|null, responseDeadlineHours: number, now?: Date|string|number }} input
 * @returns {{ lost: boolean, since: string|null, deadline: string|null, hours: number }}
 *   `lastInteraction` 为空时按「从未交互」处理 —— 那是失联，不是在线（§12.2 不许「查不到 = 放行」）。
 */
export function evaluateSovereignPresence(input) {
  const now = input.now === undefined ? Date.now() : new Date(input.now).getTime();
  const hours = Number(input.responseDeadlineHours);
  const deadlineMs = (Number.isFinite(hours) && hours > 0 ? hours : 72) * 3600_000;
  if (input.lastInteraction === null || input.lastInteraction === undefined) {
    return { lost: true, since: null, deadline: null, hours: 0 };
  }
  const since = new Date(input.lastInteraction).getTime();
  const deadline = since + deadlineMs;
  return {
    lost: now > deadline,
    since: toIso(since),
    deadline: toIso(deadline),
    hours: Math.floor((now - since) / 3600_000),
  };
}
