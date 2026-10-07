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

/** 故障：判定没能完成。fail-closed —— 上层必须当成拒绝处理，且必须响亮告警。 */
export class Fault extends Error {
  /**
   * @param {string} code 稳定的故障码（如 POLICY_LOAD_FAILED）
   * @param {string} message 人读的信息
   * @param {{ detail?: object, cause?: unknown }} [options]
   */
  constructor(code, message, options = {}) {
    super(message, { cause: options.cause });
    this.name = 'Fault';
    this.code = code;
    this.detail = options.detail ?? {};
  }

  /** 故障对外的形状与拒绝同构，但带 alarm 标记，让 §3.6「安全闸静默失败」不可能发生。 */
  toDecision() {
    return {
      verdict: 'deny',
      rule: `fault:${this.code}`,
      reason: `安全闸故障，按 fail-closed 拒绝：${this.message}`,
      requireAuthority: '宪章',
      howToChange: '修复故障后重试；故障期间的拒绝记录已入账，可申诉。',
      alarm: true,
      detail: this.detail,
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
    return { 结果: '安全闸故障（fail-closed）', 故障码: error.code, 理由: error.message };
  }
  return { 结果: '错误', 理由: error instanceof Error ? error.message : String(error) };
}
