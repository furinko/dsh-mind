/**
 * Governed creation and Team interruption use nested official Host tool calls.
 * Only the kernel holds this bridge. No token/lease is accepted from tool JSON.
 * Install around() in tools/execute; allows() relaxes only Mind's routing guard.
 */
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { canonical } from './kernel/text.js';
import { Fault, InvalidBody } from './kernel/errors.js';

const fail = message => new Fault('HOST_CREATION_UNAVAILABLE', message);
const names = Object.freeze({ team: 'spawn_teammate', subagent: 'subagent' });

/** contextOf re-reads actual live Agent, connection, project and deployment policy.
 * The maintenance lane is chosen by the kernel, never accepted from tool JSON.
 * tools is the actual scoped Host registry, not a list of visible schemas. */
export function createHostCreationBridge({ tools, contextOf }) {
  const outers = new Map(), calls = new Map(), dispatches = new AsyncLocalStorage();
  const batchApi = typeof tools?.selectExecutor === 'function';
  // Never construct or pick another executor to bypass missing/unloaded/PTC-only selections.
  const executorOf = outer => batchApi ? tools.selectExecutor(outer.agent) : null;
  const definitionOf = (name, outer) => batchApi
    ? tools.executable(name, outer.agent, outer.toolSet) : tools.get(name, outer.agent);
  let closed = false;
  const requireOuter = (exec, maintenance = false) => {
    const fail = message => new Fault(maintenance ? 'HOST_MAINTENANCE_UNAVAILABLE' : 'HOST_CREATION_UNAVAILABLE', message);
    if (closed || !exec || outers.get(exec.token) !== exec || exec.name !== 'mind') throw fail('缺少本次仍在执行的真实 Mind 工具上下文；不能直调受管服务或伪造父执行。');
    if (typeof exec.token !== 'symbol' || !(exec.signal instanceof AbortSignal) || !exec.agent) throw fail('宿主工具执行凭据不完整，未签发受管调用。');
    exec.signal.throwIfAborted();
    if (typeof tools?.execute !== 'function' || typeof tools?.get !== 'function' || typeof contextOf !== 'function') throw fail('宿主完整工具执行管线或当前身份判据不可用。');
    const state = contextOf(exec, { maintenance });
    if (typeof state?.project !== 'string' || !state.project || !Number.isSafeInteger(state.revision) || state.revision < 0 || typeof state.fingerprint !== 'string' || !state.fingerprint) throw fail('宿主调用作用域或当前配置版本不可判。');
    return canonical(state);
  };
  const matching = exec => {
    const call = calls.get(exec?.callId);
    // The batch API has no parent/root input. Private async provenance associates
    // one SDK-minted inner token with this still-live outer, not a public callId alone.
    if (!call || dispatches.getStore() !== call || call.parent !== exec.parent || call.outer.agent !== exec.agent || call.name !== exec.name || call.rootCallId !== exec.rootCallId) return null;
    if (batchApi && (exec.toolSet !== call.outer.toolSet || executorOf(call.outer) !== call.executor)) return null;
    if (call.token !== null && call.token !== exec.token) return null;
    if (typeof exec.token !== 'symbol' || canonical(exec.arguments) !== call.arguments) return null;
    if (call.controller.signal.aborted || requireOuter(call.outer, call.maintenance) !== call.context || definitionOf(call.name, call.outer) !== call.definition) return null;
    call.token ??= exec.token;
    return call;
  };
  return Object.freeze({
    async around(exec, next) {
      if (exec?.name === 'mind') {
        if (closed) throw fail('Mind工具桥已卸载。');
        if (typeof exec.token !== 'symbol') return next();
        if (outers.has(exec.token)) throw fail('宿主Mind执行凭据重复。');
        outers.set(exec.token, exec);
        try { return await next(); }
        finally {
          outers.delete(exec.token);
          for (const call of calls.values()) if (call.outer === exec) call.controller.abort();
        }
      }
      const pending = calls.get(exec?.callId);
      if (!pending) return next();
      const call = matching(exec);
      if (!call || call.entered) throw fail('受管调用已过期、改变或重复；没有继续执行宿主工具。');
      // Recheck after Host approval waits, immediately before the official body.
      await call.beforeDispatch();
      if (matching(exec) !== call) throw fail('异步核对期间作用域变化，拒绝旧调用。');
      call.entered = true;
      // Official bodies may wait for route resolution before entering creation.
      // Cancel their existing signal when our live plan becomes invalid. This
      // observes waits; it is NOT an atomic Host creation-commit contract.
      let checking = false, finished = false;
      const check = async () => {
        if (finished || checking || call.controller.signal.aborted) return;
        checking = true;
        try {
          if (matching(exec) !== call) throw fail('官方工具等待期间当前准入已变化。');
          await call.whilePending?.();
          if (matching(exec) !== call) throw fail('等待复判期间当前准入已变化。');
        } catch (error) { if (!finished) call.controller.abort(error); }
        finally { checking = false; }
      };
      const timer = !call.maintenance ? setInterval(check, 25) : null;
      try {
        const result = await next();
        call.dispatchedValue = result?.isError === false ? canonical(result.value) : null;
        return result;
      } finally { finished = true; if (timer) clearInterval(timer); }
    },
    allows(exec) {
      try { return matching(exec) !== null; }
      catch { return false; }
    },
    /** Bind a server-held, single-purpose capability to the live Mind call. */
    forExecution(outer, maintenance = false) {
      // This lane can invoke only interrupt_agent, never creation or arbitrary tools.
      const noun = maintenance ? '中断' : '创建', prefix = maintenance ? 'HOST_MAINTENANCE' : 'HOST_CREATION';
      const unavailable = message => new Fault(`${prefix}_UNAVAILABLE`, message);
      const toolOf = mode => maintenance ? (mode === 'team' ? 'interrupt_agent' : null) : names[mode];
      const prepare = ({ mode, name, description, standby, modelRoute, beforeDispatch, whilePending, target }) => {
        const context = requireOuter(outer, maintenance), toolName = toolOf(mode);
        if (!toolName || typeof beforeDispatch !== 'function') throw unavailable(`${noun}方式或本次归属复判未接线。`);
        const definition = definitionOf(toolName, outer);
        if (!definition) throw unavailable(`当前宿主未提供可执行的 ${toolName}；不会改用底层服务或另一种成员。`);
        if (maintenance) {
          if (typeof target !== 'string' || !target.trim()) throw new InvalidBody('中断目标必须是真实名册中的精确名称。');
        } else {
          if (typeof standby !== 'string' || !standby.trim() || typeof description !== 'string' || !description.trim()) throw new InvalidBody('创建提示和描述必须是非空字符串。');
          if (mode === 'team' && modelRoute) throw new InvalidBody('Team官方入口不支持本次模型路由，不静默丢弃。');
        }
        const args = maintenance ? { target } : mode === 'team' ? { name, description, prompt: standby, context: 'fresh' }
          : { description, prompt: standby, ...(modelRoute ? { provider: modelRoute.provider, model: modelRoute.model,
            ...(modelRoute.reasoningEffort ? { reasoning_effort: modelRoute.reasoningEffort } : {}) } : {}) };
        const callId = `mind-${maintenance ? 'stop' : 'create'}-${randomUUID()}`, controller = new AbortController();
        const executor = executorOf(outer);
        const call = { outer, maintenance, context, definition, executor, name: toolName, arguments: canonical(args),
          parent: batchApi ? undefined : outer.token, rootCallId: batchApi ? callId : outer.rootCallId ?? outer.callId,
          controller, beforeDispatch, whilePending, token: null, entered: false };
        let used = false;
        return Object.freeze({ tool: toolName, callId, async execute() {
          if (used) throw unavailable(`本次${noun}句柄已经执行过，不能再次调用宿主。`);
          used = true;
          if (requireOuter(outer, maintenance) !== context || definitionOf(toolName, outer) !== definition) throw unavailable(`准备后${noun}作用域已变化，不能执行旧句柄。`);
          calls.set(callId, call);
          try {
            if (executorOf(outer) !== executor) throw unavailable(`准备后的宿主执行器已变化，不执行旧${noun}句柄。`);
            const signal = AbortSignal.any([outer.signal, controller.signal]);
            const raw = await dispatches.run(call, () => tools.execute(batchApi
              ? { calls: [{ id: callId, name: toolName, arguments: JSON.stringify(args) }], agent: outer.agent, signal,
                  ...(outer.toolSet !== undefined ? { toolSet: outer.toolSet } : {}) }
              : { callId, rootCallId: call.rootCallId, parent: call.parent, agent: outer.agent, name: toolName, arguments: args, signal }));
            const result = batchApi ? (Array.isArray(raw?.results) && raw.results.length === 1 && raw.results[0]?.callId === callId ? raw.results[0].result : undefined) : raw;
            if (result?.isError !== false || !call.entered) {
              throw new Fault(`${prefix}_${call.entered ? 'RESULT_UNKNOWN' : 'DENIED'}`,
                call.entered ? `宿主${noun}工具已进入执行，但未返回可靠成功结果；${maintenance ? '不能盲目重试' : '不能重复创建'}。` : `宿主${noun}工具未获准进入执行；请核对宿主拒绝或审批条件。`,
                { detail: { 工具: toolName, 调用id: callId, ...(maintenance ? {} : { 原因: String(result?.error?.message ?? '宿主结果形状未知').slice(0, 1000) }) },
                  outcome: { 提交状态: call.entered ? '未知' : '未提交', 可重试: false, 恢复指引: `保留原${noun}意图，按宿主调用id、直属目录及组织记录核对；不自动重试或伪造回执。`, 已确认阶段: [] } });
            }
            if (call.dispatchedValue === null || canonical(result.value) !== call.dispatchedValue) throw new Fault(`${prefix}_RESULT_UNKNOWN`, `宿主最终结果与${noun}执行回执不一致，不沿被替换的回执继续操作。`, {
              detail: { 工具: toolName, 调用id: callId }, outcome: { 提交状态: '未知', 可重试: false,
                恢复指引: '核对宿主原调用和直属目录；后处理结果不证明本次副作用或归属，不自动重试。', 已确认阶段: [] },
            });
            let current = false;
            try { current = requireOuter(outer, maintenance) === context && definitionOf(toolName, outer) === definition && executorOf(outer) === executor; } catch { /* revoked after dispatch */ }
            if (!current) throw new Fault(`${prefix}_RESULT_UNKNOWN`, `宿主${noun}调用进入执行后作用域变化；${maintenance ? '不能假称未发生' : '不能假称未创建'}，也不沿旧计划继续操作。`, {
              detail: { 工具: toolName, 调用id: callId }, outcome: { 提交状态: '未知', 可重试: false,
                恢复指引: `核对本次宿主调用及直属目录；撤回不保证已进入宿主的${noun}被回滚。`, 已确认阶段: [] },
            });
            return Object.freeze({ tool: toolName, callId, value: result.value });
          } finally { calls.delete(callId); }
        } });
      };
      return Object.freeze({
        available(mode) {
          try { requireOuter(outer, maintenance); executorOf(outer); return Boolean(toolOf(mode) && definitionOf(toolOf(mode), outer)); }
          catch { return false; }
        },
        prepare,
        async create(spec) { return prepare(spec).execute(); },
      });
    },
    close() {
      closed = true;
      for (const call of calls.values()) call.controller.abort();
      outers.clear();
    },
  });
}
