/**
 * 心智内核的错误类型。
 *
 * 为什么单独一个类：设计 §7 要求策略引擎「拒绝必须带可执行理由（哪条规则 + 改它要什么授权）」，
 * 而 §12 要求闸不许 fail-open。把「拒绝」与「故障」区分成两种可编程的错误，
 * 才能保证上层的 catch 不会把「判不了」误当成「放行」。
 */

/** 拒绝：判定完成，结论是不许。reason 必须可执行。 */
export class Denied extends Error {
  /**
   * @param {string} rule 触发本次拒绝的规则标识（法律条款 / 内置约束）
   * @param {string} reason 人能读的理由
   * @param {{ requireAuthority?: string, howToChange?: string, detail?: object }} [options]
   *   requireAuthority：改这条要什么授权；howToChange：具体怎么改。
   */
  constructor(rule, reason, options = {}) {
    super(reason);
    this.name = 'Denied';
    this.code = 'DENIED';
    this.rule = rule;
    this.requireAuthority = options.requireAuthority ?? '自治';
    this.howToChange = options.howToChange ?? '';
    this.detail = options.detail ?? {};
  }

  /** 结构化理由：策略引擎对外的唯一拒绝形状（§9 接口契约）。 */
  toDecision() {
    return {
      verdict: 'deny',
      rule: this.rule,
      reason: this.message,
      requireAuthority: this.requireAuthority,
      howToChange: this.howToChange,
      detail: this.detail,
    };
  }
}

/** 故障不表示操作未提交。授权判定保守拒绝；执行回执另行保留已发生的事实。 */
export class Fault extends Error {
  /**
   * @param {string} code 稳定的故障码（如 POLICY_LOAD_FAILED）
   * @param {string} message 人读的信息
   * @param {{ detail?: object, cause?: unknown, howToChange?: string, outcome?: object }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'Fault';
    this.code = code;
    this.detail = options.detail ?? {};
    if (options.howToChange) this.howToChange = String(options.howToChange);
    // Explicit, small receipts only. A raw detail may contain another task's content or host errors.
    if (options.outcome) this.outcome = normalizeOutcome(options.outcome);
  }

  /** 故障对外的形状与拒绝同构，但带 alarm 标记，让 §3.6「安全闸静默失败」不可能发生。 */
  toDecision() {
    return {
      verdict: 'deny',
      rule: `fault:${this.code}`,
      reason: this.outcome ? `执行未完整收尾：${this.message}` : `安全闸故障，按 fail-closed 拒绝：${this.message}`,
      requireAuthority: '宪章',
      howToChange: this.outcome?.恢复指引 ?? this.howToChange ?? '先诊断故障并核对操作是否已经提交，再按具体恢复指引处理；结果未知时不要盲重试。',
      alarm: true,
      detail: this.detail,
      ...(this.outcome ? { outcome: this.outcome } : {}),
    };
  }
}

/** 需确认：判定完成，结论是「要更高授权点头」。 */
export class NeedsApproval extends Error {
  /**
   * @param {string} rule
   * @param {string} reason
   * @param {{ requireAuthority?: string, howToChange?: string, detail?: object }} [options]
   */
  constructor(rule, reason, options = {}) {
    super(reason);
    this.name = 'NeedsApproval';
    this.code = 'NEEDS_APPROVAL';
    this.rule = rule;
    this.requireAuthority = options.requireAuthority ?? '法律';
    this.howToChange = options.howToChange ?? '';
    this.detail = options.detail ?? {};
  }

  toDecision() {
    return {
      verdict: 'confirm',
      rule: this.rule,
      reason: this.message,
      requireAuthority: this.requireAuthority,
      howToChange: this.howToChange,
      detail: this.detail,
    };
  }
}

/** 写入侧结构校验失败（§11：正文结构是写入侧义务）。 */
export class InvalidBody extends Error {
  /**
   * @param {string} reason
   * @param {{ missing?: string[], detail?: object }} [options]
   */
  constructor(reason, options = {}) {
    super(reason);
    this.name = 'InvalidBody';
    this.code = 'INVALID_BODY';
    this.missing = options.missing ?? [];
    this.detail = options.detail ?? {};
  }
}

/**
 * 把任意错误压成一句可执行的答复。
 *
 * 放在错误类型旁边，而不是各个调用点：§9 要求「拒绝必须带可执行理由」，
 * 而这件事对内核组件与安全类组件完全相同——两处各写一遍迟早会漂。
 *
 * @param {unknown} error
 * @returns {{ 结果: string, [key: string]: any }}
 */
export function describeFailure(error) {
  if (error instanceof Denied) {
    return { 结果: '拒绝', 规则: error.rule, 理由: error.message, 要什么授权: error.requireAuthority, 怎么改: error.howToChange };
  }
  if (error instanceof NeedsApproval) {
    return { 结果: '需确认', 规则: error.rule, 理由: error.message, 要什么授权: error.requireAuthority, 怎么改: error.howToChange };
  }
  if (error instanceof InvalidBody) {
    return { 结果: '结构不合规', 理由: error.message, 缺什么: error.missing };
  }
  if (error instanceof Fault) {
    return { 结果: error.outcome ? '执行未完整收尾' : '安全闸故障（fail-closed）', 故障码: error.code, 理由: error.message,
      ...(error.outcome ? { ...error.outcome, 怎么改: error.outcome.恢复指引 } : error.howToChange ? { 怎么改: error.howToChange } : {}),
    };
  }
  return { 结果: '错误', 理由: 脱路径(error instanceof Error ? error.message : String(error)) };
}

/** Submission facts are evidence, not permission to retry. Missing facts stay unknown. */
function normalizeOutcome(value) {
  const states = ['未提交', '部分提交', '已提交', '未知'];
  const keys = ['阶段', '项目', '动作', '对象id', '任务', '前序任务', '实例', '会审', '线程', '条目id', '请求id', '事件id', '事件序号', '事件', '消息id', '操作id', '执行键', '预算目标', '已请求', '已接收', '已停止', '已封存', '当前驻留已释放'];
  const receipts = (Array.isArray(value.已确认阶段) ? value.已确认阶段 : []).slice(0, 32).map(row => Object.freeze(Object.fromEntries(
    keys.filter(key => row && Object.hasOwn(row, key) && ['string', 'number', 'boolean'].includes(typeof row[key]))
      .map(key => [key, typeof row[key] === 'string' ? row[key].slice(0, 512) : row[key]]),
  )));
  return Object.freeze({
    提交状态: states.includes(value.提交状态) ? value.提交状态 : '未知',
    可重试: typeof value.可重试 === 'boolean' ? value.可重试 : null,
    恢复指引: typeof value.恢复指引 === 'string' && value.恢复指引.trim() ? value.恢复指引.slice(0, 2000) : '先查询当前事实；结果未知时不要重复执行。',
    已确认阶段: Object.freeze(receipts),
  });
}

/**
 * 兜底分支的文案**脱内部绝对路径**（2026-10-12 评审 P3）：`ENOENT C:\Users\xxx\...`
 * 这种系统错误原文会把部署目录结构泄给拿到答复的人。路径折成 `<路径:文件名>`——
 * 排障要的是「哪个文件」，不是「你家目录长什么样」。
 * 上面四个类型分支（Denied/NeedsApproval/InvalidBody/Fault）的文案是机制自己写的、
 * 面向操作者（InvalidBody 会**有意**带上出问题的文件路径——那是给排障的人看的）；
 * 要脱的是**系统原始错误**（ENOENT/EACCES……）里不受控的那部分，所以只脱兜底分支。
 * @param {string} text
 */
function 脱路径(text) {
  return String(text)
    .replace(/[A-Za-z]:\\[^\s"'，。；：]+/g, (m) => `<路径:${m.split(/[\\/]/).pop()}>`)
    .replace(/(^|[\s"'(（])\/[^\s"'，。；：]+/g, (_m, 前缀) => `${前缀}<路径:${_m.trim().split('/').pop()}>`);
}
