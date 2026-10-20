/** 宿主 pre 可等待预占；单调同步 guard 只认同一 exec 的私有凭据。 */
import { randomUUID } from 'node:crypto';
import { canonical, digest } from '../../../src/kernel/text.js';
import { memberFileBudgetScope } from '../../../src/goal-budget-scope.js';

export function createGoalBudgetHooks({ org, projectOf, cwdOf, logger = console, observe = true }) {
  const entries = new WeakMap();
  const pending = new Set();
  let failedWrites = 0;
  let preAttached = false;
  let resultAttached = false;
  const scopeOf = exec => memberFileBudgetScope(exec, { org, projectOf, cwdOf });
  const errorText = error => {
    const receipt = error.outcome?.已确认阶段?.find(stage => stage.预算目标 && stage.执行键);
    return `[dsh-mind] 预算准入拒绝：${error.rule ?? error.code ?? '预算事实不可判'}：${error.message ?? '请核对当前预算与权限。'}`
      + (receipt ? ` 已确认预算目标 ${receipt.预算目标}，执行键 ${receipt.执行键}；请用 budget_query 核对，不盲重试。` : '');
  };
  const observeBlock = (exec, scope) => {
    if (!observe) return;
    try {
      const attempt = org.observability?.begin(exec, { subject: scope.subject, project: scope.project, phase: 'pre-execute' });
      org.observability?.block(attempt, { ruleId: 'kernel.goal-budget', ruleVersion: api.versionOf(exec), versionScope: 'goal-budget-config', source: 'native_budget_pre' });
    } catch { /* 采集不改变准入结论。 */ }
  };
  const track = promise => {
    const job = Promise.resolve(promise).catch(() => { failedWrites++; logger.warn?.('[dsh-mind] 预算结果未完整收尾；按真源核对已提交占用，不自动返还额度。'); }).finally(() => pending.delete(job));
    pending.add(job); return job;
  };
  const api = {
    async preExecute(exec, next = () => Promise.resolve({ kind: 'allow' })) {
      const decision = await next(); // 原拒绝与抛错透传；不得为观测或预算截断正常瀑布。
      if (decision?.kind === 'deny') return decision;
      if (!['allow', 'ask'].includes(decision?.kind)) return decision;
      let scope;
      try { scope = scopeOf(exec); }
      catch { return decision; } // 原权限/真源错误交给单调同步闸，不能抢走其既有阻塞事实。
      if (!scope) return decision;
      try {
        if (typeof exec.token !== 'symbol') { observeBlock(exec, scope); return { kind: 'deny', reason: '[dsh-mind] 预算缺少宿主真实执行 token，不能准入。' }; }
        let entry = entries.get(exec);
        if (entry?.closed) return { kind: 'deny', reason: '[dsh-mind] 预算执行已收尾，不能复用旧 exec 凭据再次执行。' };
        if (!entry) {
          entry = { scope, agent: exec.agent, token: exec.token, closed: false, tool: exec.name, key: randomUUID(), receipt: null, error: null };
          entries.set(exec, entry);
          entry.promise = org.budgets.reserve({ subject: scope.subject, 项目: scope.project, 目标: scope.goal, 执行键: entry.key,
            工具: exec.name, 类别: 'member_file', 指纹: scope.fingerprint }).then(receipt => { entry.receipt = receipt; return receipt; });
        }
        const receipt = await entry.promise;
        if (entry.closed || entry.agent !== exec.agent || entry.token !== exec.token || entry.scope.fingerprint !== scope.fingerprint || receipt.可放行 !== true) {
          return { kind: 'deny', reason: '[dsh-mind] 预算准入事实已变化或只有旧占用回执；请新建真实调用，不重用旧凭据。' };
        }
        return decision;
      } catch (error) {
        const entry = entries.get(exec); if (entry) entry.error = errorText(error);
        if (!['DENIED', 'INVALID_BODY', 'NEEDS_APPROVAL'].includes(error.code)) failedWrites++;
        observeBlock(exec, scope);
        return { kind: 'deny', reason: errorText(error) };
      }
    },
    guard(exec) {
      try {
        const scope = scopeOf(exec);
        const entry = entries.get(exec);
        if (!scope) {
          if (entry) return '[dsh-mind] 预算准入后的执行范围或身份已变化，旧凭据不可迁移。';
          return undefined;
        }
        if (!entry || entry.closed || entry.error || entry.receipt?.可放行 !== true || entry.agent !== exec.agent || entry.token !== exec.token || entry.scope.fingerprint !== scope.fingerprint) {
          return entry?.error ?? '[dsh-mind] 预算缺少同一真实执行的有效预占凭据；额度不足、跳过 pre 或当前归属变化均不能直接进入工具体。';
        }
        return undefined;
      } catch (error) { return errorText(error); }
    },
    versionOf(exec) {
      try {
        const scope = scopeOf(exec);
        if (!scope) return null;
        const budget = org.budgets.getBudgetSync(scope.goal, { 项目: scope.project });
        return digest(canonical({ 目标: scope.goal, 配置: budget.配置, 预算修订: budget.预算修订 }));
      } catch { return null; }
    },
    finish(exec, result) {
      const entry = entries.get(exec);
      if (!entry || entry.closed) return;
      entry.closed = true;
      // result 是只读通知，立即闭合内存凭据；异步持久收尾失败不返还预占。
      if (entry.receipt?.可放行 !== true) return;
      track(org.budgets.settle({ 项目: entry.scope.project, 目标: entry.scope.goal, 执行键: entry.key, 结果: result?.isError === true ? 'error' : 'success' }));
    },
    attach(ctx) {
      const disposers = [];
      try { disposers.push(ctx.on('tools/pre-execute', api.preExecute)); preAttached = true; }
      catch { logger.warn?.('[dsh-mind] 预算预占钩子未接线；受管文件调用将因无凭据被同步闸拒绝。'); }
      try { disposers.push(ctx.on('tools/result', api.finish)); resultAttached = true; }
      catch { logger.warn?.('[dsh-mind] 预算结果钩子未接线；占用将保持未决。'); }
      return () => { for (const dispose of disposers) dispose?.(); };
    },
    async flush() { while (pending.size) await Promise.all([...pending]); },
    health() { return { preAttached, resultAttached, failedWrites, token: null, 费用: null }; },
  };
  return api;
}
