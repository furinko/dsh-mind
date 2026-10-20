/** Local observation facts. No method here changes policy, approvals or membership. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { Denied, InvalidBody } from './kernel/errors.js';

const context = new AsyncLocalStorage();
export const MONITOR_REASONS = Object.freeze(['授权缺口', '规则缺陷疑似', '材料不足', '环境故障', '调用不合法', '主动放弃', '其他', '未知']);
const EVENTS = new Set(['监控开始', '监控阻塞', '监控证据', '监控结束', '监控跟进', '监控反馈']);
export const withObservation = (observer, attempt, work) => context.run({ observer, attempt }, work);

/** Called before the existing audit append; never changes that append's outcome. */
export function observeAudit(entry) {
  const active = context.getStore();
  if (!active || !['策略拒绝', '动作拦截', '介入请求'].includes(entry.动作)) return;
  if (active.attempt?.action === 'policy_check') return; // A returned diagnostic verdict is not an execution block.
  active.observer.block(active.attempt, {
    ruleId: `${entry.动作 === '策略拒绝' ? 'policy.decision' : entry.动作 === '介入请求' ? 'policy.intervention' : 'action.precondition'}:${digest(entry.依据 ?? '').slice(0, 16)}`,
    ruleVersion: active.observer.ruleVersion(), source: entry.动作,
    requestId: entry.详情?.请求id ?? entry.对象?.请求id ?? null,
  });
}

function digest(value) { return createHash('sha256').update(String(value)).digest('hex'); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
}
export function executionTarget(exec) {
  // Only a digest is retained, never file content, commands or arguments. Approval references are not the target.
  const args = exec?.arguments ?? {};
  const targetArgs = exec?.name === 'mind' && args && typeof args === 'object' ? Object.fromEntries(Object.entries(args).filter(([key]) => key !== '审批引用')) : args;
  return digest(JSON.stringify({ tool: exec?.name ?? 'unknown', args: canonical(targetArgs) }));
}
function required(value, name, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new InvalidBody(`${name} 必须是非空文本（最多 ${max} 字符）`);
  return value.trim();
}
const actorId = actor => String(actor?.id ?? 'unknown');
const safeCode = code => typeof code === 'string' && /^[A-Z0-9_.:-]{1,100}$/i.test(code) ? code : null;

export class ObservabilityService {
  constructor({ audit, clock, logger = console, registry, tasks, policy }) {
    Object.assign(this, { audit, clock, logger, registry, tasks, policy });
    this.runId = randomUUID(); this.executions = new WeakMap(); this.tokens = new Map();
    this.pendingRetries = new Map(); this.pending = new Set(); this.failedWrites = 0; this.captureErrors = 0;
    this.coverage = { nativeTools: 'not-wired', semanticMind: 'not-wired', startup: 'not-covered' };
    this.startedAt = clock.iso();
  }
  setCoverage(value) { Object.assign(this.coverage, value); }
  ruleVersion() {
    const state = this.policy?.describe?.();
    return state?.digests ? digest(JSON.stringify({ digests: state.digests, defaults: state.defaults })) : null;
  }
  captureError() { this.captureErrors++; }
  /** Include the extracted legacy writer in draining, preserving its own error logging contract. */
  track(promise) {
    const settled = Promise.resolve(promise).then(() => undefined, () => undefined).finally(() => this.pending.delete(settled));
    this.pending.add(settled); return promise;
  }
  health() {
    return { 状态: this.failedWrites || this.captureErrors ? 'degraded' : this.coverage.nativeTools === 'enabled' ? 'observed' : 'partial',
      覆盖: { ...this.coverage }, 待落账: this.pending.size, 写入失败: this.failedWrites, 采集异常: this.captureErrors,
      版本口径: '策略摘要仅包含已加载策略文档与 defaults；工具范围闸另含当次范围配置摘要；均不代表完整执行代码版本。缺失为 null。',
      当前进程起于: this.startedAt, 崩溃窗口: '同步闸先拒绝，异步审计尚未落盘时进程退出可能漏记；漏记数量未知',
      分母: '已落账的真实执行；不代表其他插件、启动期、历史调用或宿主全部拦截' };
  }
  begin(exec, { subject, project, phase = 'unknown' }) {
    if (!exec || typeof exec !== 'object') return null;
    let attempt = this.executions.get(exec);
    if (attempt) return attempt;
    attempt = { id: `at-${randomUUID()}`, runId: this.runId, subject: { id: actorId(subject), kind: subject?.kind ?? 'unknown' },
      project: typeof project === 'string' ? project : null, tool: String(exec.name ?? 'unknown'),
      action: exec.name === 'mind' ? String(exec.arguments?.action ?? '') : null,
      task: null, taskSource: 'unknown',
      requestedTask: (() => { const hint = exec.arguments?.节点 ?? exec.arguments?.任务 ?? (String(exec.arguments?.action ?? '').startsWith('task_') ? exec.arguments?.id : null); return typeof hint === 'string' ? hint.slice(0, 160) : null; })(),
      callId: typeof exec.callId === 'string' ? exec.callId.slice(0, 160) : null,
      rootCallId: typeof exec.rootCallId === 'string' ? exec.rootCallId.slice(0, 160) : null,
      parentAttemptId: this.tokens.get(exec.parent)?.id ?? null,
      target: executionTarget(exec), start: this.clock.iso(), startPhase: phase, mono: performance.now(), blocked: false, ended: false, semanticError: null };
    this.executions.set(exec, attempt);
    if (typeof exec.token === 'symbol') this.tokens.set(exec.token, attempt);
    const key = this.retryKey(attempt);
    const retry = this.pendingRetries.get(key);
    if (retry && attempt.action !== 'policy_check') { attempt.retryOf = retry.blockId; this.pendingRetries.delete(key); }
    this.write('监控开始', attempt, { callId: attempt.callId, rootCallId: attempt.rootCallId, parentAttemptId: attempt.parentAttemptId, retryOf: attempt.retryOf ?? null });
    return attempt;
  }
  retryKey(attempt) { return `${actorId(attempt.subject)}\0${attempt.project}\0${attempt.target}`; }
  block(attempt, { ruleId, ruleVersion = this.ruleVersion(), versionScope = 'loaded-policy-documents-and-defaults', source = 'mind_guard', requestId = null } = {}) {
    if (!attempt || attempt.ended || attempt.blocked) return;
    attempt.blocked = true;
    this.write('监控阻塞', attempt, { ruleId: ruleId ?? 'unknown', ruleVersion: ruleVersion === null ? null : /^[a-f0-9]{64}$/.test(ruleVersion) ? ruleVersion : digest(ruleVersion), versionScope, source, requestId });
  }
  semanticFailure(attempt, error) {
    if (!attempt) return;
    attempt.semanticError = safeCode(error?.code) ?? 'MIND_ACTION_FAILED';
    if (error.detail?.请求id) this.write('监控证据', attempt, { requestId: error.detail.请求id });
    if (['DENIED', 'NEEDS_APPROVAL'].includes(error?.code)) this.block(attempt, {
      ruleId: error.code === 'NEEDS_APPROVAL' ? 'policy.intervention' : 'action.precondition',
      ruleVersion: this.ruleVersion(), source: 'mind_action', requestId: error.detail?.请求id ?? null,
    });
  }
  finish(attempt, result) {
    if (!attempt || attempt.ended) return;
    attempt.ended = true;
    const success = result?.isError !== true && !attempt.semanticError && !attempt.blocked;
    this.write('监控结束', attempt, { outcome: success ? 'success' : attempt.blocked ? 'blocked' : 'failure',
      code: attempt.semanticError ?? safeCode(result?.error?.code) ?? safeCode(result?.error?.info?.code),
      executionMs: ['unknown', 'result'].includes(attempt.startPhase) ? null : Math.max(0, performance.now() - attempt.mono), retryOf: attempt.retryOf ?? null });
    // Completed token entries are no longer needed for authority; cap diagnostic parent lookups.
    if (this.tokens.size > 4096) this.tokens.delete(this.tokens.keys().next().value);
  }
  write(action, attempt, extra) {
    const detail = { version: 1, eventId: `${attempt.id}:${action}`, attemptId: attempt.id, runId: attempt.runId,
      tool: attempt.tool, action: attempt.action, task: null, taskSource: 'unknown', requestedTask: attempt.requestedTask,
      target: attempt.target, start: attempt.start, startPhase: attempt.startPhase, ...extra };
    const pending = this.audit.append({ 动作: action, 主体: attempt.subject, 项目: attempt.project,
      对象: { id: attempt.id, kind: '观测执行' }, 结果: action, 详情: detail })
      .catch(() => { this.failedWrites += 1; this.logger.warn?.('[dsh-mind] 监控事实落账失败，覆盖已标记未知；不会改变原工具判定。'); })
      .finally(() => this.pending.delete(pending));
    this.pending.add(pending);
  }
  async flush() { while (this.pending.size) await Promise.all([...this.pending]); }
  async facts(project) {
    await this.flush();
    return (await this.audit.readVerified(project ? { project } : {})).filter(row => EVENTS.has(row.动作));
  }
  async query({ subject, project, session = null, limit = 50, offset = 0 } = {}) {
    const rows = await this.facts(project);
    const projected = projectObservations(rows);
    const member = subject?.kind === '成员';
    let own = projected.filter(a => (!session || a.subject === session) && (!member || a.subject === actorId(subject)));
    if (member) {
      const identity = await this.registry.identity();
      if (identity.members?.[subject.id]?.status !== '在岗') own = [];
      // No project/task ownership is inferred from a role name. Own pre-binding failures keep only a safe summary.
      const memberRecord = identity.members?.[subject.id];
      const visible = new Set((await this.tasks.list({ 项目: project })).filter(node => (node.绑定 ?? []).some(b => b.实例 === subject.id && b.岗位 === memberRecord?.岗位)).map(n => n.id));
      own = own.map(a => a.requestedTask && !visible.has(a.requestedTask) ? { ...a, requestedTask: null } : a);
    }
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new InvalidBody('监控 limit 只允许 1–100，监控偏移须为非负整数');
    const blocks = own.filter(a => a.block).reverse(), rules = aggregateObservations(own);
    return { 版本: 1, 项目: project ?? null, 健康: this.health(), 范围: member ? '当前项目本人执行安全摘要' : session ? '指定会话已落账执行' : '当前项目全部已落账观测',
      尝试总数: own.length, 阻塞总数: blocks.length, 规则总数: rules.length, 规则截断: rules.length > 100, 规则汇总: rules.slice(0, 100),
      分页: { offset, limit, 返回: Math.min(limit, Math.max(0, blocks.length - offset)), 下一偏移: offset + limit < blocks.length ? offset + limit : null },
      阻塞: blocks.slice(offset, offset + limit).map(({ target, ...safe }) => ({ ...safe, feedbackTotal: safe.feedback.length, followupsTotal: safe.followups.length,
        feedback: safe.feedback.slice(-10), followups: safe.followups.slice(-10) })),
      未分类失败: own.filter(a => a.end?.outcome === 'failure').length,
      未结束: own.filter(a => !a.end).length, 误拦截率: null,
      耗时口径: 'executionMs 是同进程单调钟的观测段，不是工具体纯耗时；仅收到结果时开始时刻未知，耗时 null。recoveryMs 是阻塞到已关联真实成功的墙钟间隔，不是人工劳动时间。缺结束/时钟倒退为 null。' };
  }
  async blockFor({ subject, project, blockId, session, human = false }) {
    const rows = projectObservations(await this.facts(project));
    const block = rows.find(a => a.id === blockId && a.block);
    if (!block || (project && block.project !== project) || (session && block.subject !== session) || (!human && block.subject !== actorId(subject))) {
      throw new Denied('monitor.scope', '该阻塞不在本人/当前项目可见域。');
    }
    return block;
  }
  async followup({ subject, project, blockId, disposition, reason, reference }) {
    const block = await this.blockFor({ subject, project, blockId });
    if (!['retry', 'abandon'].includes(disposition)) throw new InvalidBody('disposition 只允许 retry 或 abandon');
    if (['recovered', 'abandoned'].includes(block.state)) throw new InvalidBody('该阻塞已结束；不能覆盖原记录');
    if (block.action === 'policy_check') throw new InvalidBody('诊断判定不是可重试恢复的真实阻塞');
    const why = required(reason, '理由'); const ref = required(reference, '来源引用', 500);
    const receipt = await this.audit.append({ 动作: '监控跟进', 主体: subject, 项目: project, 对象: { id: block.id, kind: '观测执行' },
      详情: { version: 1, eventId: randomUUID(), blockId: block.id, disposition, reason: why, reference: ref, source: 'model_claim' } });
    if (disposition === 'retry') this.pendingRetries.set(this.retryKey({ subject, project, target: block.target }), { blockId: block.id });
    else for (const [key, retry] of this.pendingRetries) if (retry.blockId === block.id) this.pendingRetries.delete(key);
    return { blockId: block.id, disposition, 审计: receipt, 说明: disposition === 'retry' ? '仅关联本进程下一次相同主体/项目/入参摘要的真实执行；重启后须重新登记。未重试不算恢复。' : '已记录主动放弃，不改变权限。' };
  }
  async feedback({ subject, project, blockId, reason, reference, category = '未知', verdict = 'unknown', human = false, session = null }) {
    const block = await this.blockFor({ subject, project, blockId, session, human });
    if (!MONITOR_REASONS.includes(category)) throw new InvalidBody('未知原因分类');
    if (!['unknown', 'false_positive', 'correct_block'].includes(verdict) || (!human && verdict !== 'unknown')) throw new InvalidBody('模型只能提供原因声明，不能确认误拦截');
    const feedbackId = randomUUID();
    const receipt = await this.audit.append({ 动作: '监控反馈', 主体: human ? { id: '主权者', kind: '主权者' } : subject,
      项目: block.project, 对象: { id: block.id, kind: '观测执行' }, 详情: { version: 1, eventId: feedbackId, blockId: block.id,
        category, verdict, reason: required(reason, '理由'), reference: required(reference, '来源引用', 500), source: human ? 'human_confirmation' : 'model_claim' } });
    return { blockId: block.id, feedbackId, source: human ? 'human_confirmation' : 'model_claim', 审计: receipt, 说明: '仅追加反馈，权限与审批未改变。' };
  }
}

export function projectObservations(rows) {
  const attempts = new Map(), seen = new Set(), followups = [], feedback = [];
  for (const row of rows) {
    const d = row.详情 ?? {}; if (d.version !== 1 || !d.eventId || seen.has(d.eventId)) continue;
    seen.add(d.eventId);
    if (row.动作 === '监控跟进') { followups.push({ ...d, at: row.时间 }); continue; }
    if (row.动作 === '监控反馈') { feedback.push({ ...d, at: row.时间 }); continue; }
    if (!d.attemptId) continue;
    const a = attempts.get(d.attemptId) ?? { id: d.attemptId, subject: actorId(row.主体), project: row.项目, tool: d.tool,
      action: d.action, task: null, taskSource: 'unknown', requestedTask: d.requestedTask ?? null, startPhase: d.startPhase ?? 'unknown',
      target: d.target, start: d.start, runId: d.runId, state: 'unknown', feedback: [], followups: [] };
    if (row.动作 === '监控开始') Object.assign(a, { callId: d.callId, rootCallId: d.rootCallId, parentAttemptId: d.parentAttemptId, retryOf: d.retryOf });
    if (row.动作 === '监控阻塞') { a.block = { at: row.时间, ruleId: d.ruleId, ruleVersion: d.ruleVersion, versionScope: d.versionScope, source: d.source, requestId: d.requestId }; a.state = 'unresolved'; }
    if (row.动作 === '监控证据' && a.block) a.block.requestId = d.requestId ?? a.block.requestId;
    if (row.动作 === '监控结束') { a.end = { at: row.时间, outcome: d.outcome, code: d.code, executionMs: d.executionMs }; a.retryOf = d.retryOf ?? a.retryOf; }
    attempts.set(a.id, a);
  }
  for (const f of followups) { const a = attempts.get(f.blockId); if (a?.block) { a.followups.push(f); if (f.disposition === 'abandon') a.state = 'abandoned'; } }
  for (const f of feedback) attempts.get(f.blockId)?.feedback.push(f);
  for (const retry of attempts.values()) {
    const a = attempts.get(retry.retryOf);
    if (!a?.block || a.state === 'abandoned' || retry.action === 'policy_check' || a.subject !== retry.subject || a.project !== retry.project || a.target !== retry.target) continue;
    if (retry.end?.outcome === 'success' && !a.recovery) {
      const interval = Date.parse(retry.end.at) - Date.parse(a.block.at);
      a.state = 'recovered'; a.recovery = { attemptId: retry.id, at: retry.end.at, recoveryMs: interval >= 0 ? interval : null, clock: 'wall' };
    }
  }
  return [...attempts.values()].map(({ target, ...a }) => ({ ...a, target }));
}

export function aggregateObservations(attempts) {
  const rules = new Map();
  for (const a of attempts.filter(a => a.block)) {
    const key = `${a.block.ruleId}\0${a.block.ruleVersion}`;
    const rule = rules.get(key) ?? { ruleId: a.block.ruleId, ruleVersion: a.block.ruleVersion, blocked: 0, recovered: 0, abandoned: 0, unresolved: 0,
      humanFalsePositive: 0, humanCorrectBlock: 0, unconfirmed: 0, modelClaims: 0, reasonCounts: { model_claim: {}, human_confirmation: {} }, recoverySamples: 0, recoveryTotalMs: 0, recoveryUnknown: 0 };
    rule.blocked++; rule[a.state === 'recovered' ? 'recovered' : a.state === 'abandoned' ? 'abandoned' : 'unresolved']++;
    const human = a.feedback.filter(f => f.source === 'human_confirmation').at(-1);
    if (human?.verdict === 'false_positive') rule.humanFalsePositive++;
    else if (human?.verdict === 'correct_block') rule.humanCorrectBlock++; else rule.unconfirmed++;
    rule.modelClaims += a.feedback.filter(f => f.source === 'model_claim').length;
    for (const source of ['model_claim', 'human_confirmation']) {
      const category = a.feedback.filter(f => f.source === source).at(-1)?.category ?? '未知';
      rule.reasonCounts[source][category] = (rule.reasonCounts[source][category] ?? 0) + 1;
    }
    if (typeof a.recovery?.recoveryMs === 'number') { rule.recoverySamples++; rule.recoveryTotalMs += a.recovery.recoveryMs; }
    else rule.recoveryUnknown++;
    rules.set(key, rule);
  }
  return [...rules.values()].map(({ recoveryTotalMs, ...r }) => ({ ...r, averageRecoveryMs: r.recoverySamples ? recoveryTotalMs / r.recoverySamples : null, falsePositiveRate: null }));
}
